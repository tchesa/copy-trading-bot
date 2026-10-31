import type { DatabaseSync, StatementSync } from "node:sqlite";
import { insertPoolStates, insertSwaps, setProgress } from "../db/db.js";
import { BudgetExceeded, type Helius } from "./helius.js";
import { poolStateFromTx } from "./parse/poolState.js";
import { parseTx } from "./parse/tx.js";
import { STABLES, WSOL } from "./programs.js";
import type { SolUsd } from "./solusd.js";

/**
 * Trades smaller than this (SOL) are not used as a price: fixed fees dominate their flows, so even the pool-side
 * price can be off by orders of magnitude (seen: 0.08 tokens for 0.0003 SOL, priced 1000× the market).
 */
export const MIN_PRICE_TRADE_SOL = 0.01;

/** A stored trade this close before an exit time is taken as the pool's state at that time (see priorState). */
export const PRIOR_TRUST_SECONDS = 600;

/** Number of recent trades whose median price is a mark. */
export const MARK_TRADES = 5;

export interface TapeRow {
  sig: string;
  wallet: string;
  blockTime: number;
  txIndex: number;
  side: "buy" | "sell";
  tokenAmount: number;
  /** SOL per token. */
  price: number;
  /** Price comes from the pool's own flows on a non-dust trade (≥ MIN_PRICE_TRADE_SOL). Otherwise (P2P/bundled
   * fills, an incomplete quote leg, or fee-dominated dust) it is not used as a fill, mark or path price. */
  poolPriced: boolean;
  /** SOL value of the trade (what the wallet paid or received). */
  sol: number;
  poolQuoteReserveSol: number | null;
}

export interface PoolState {
  blockTime: number;
  tokenReserve: number;
  /** Quote reserve in SOL. */
  quoteReserveSol: number | null;
}

interface RawRow {
  sig: string;
  wallet: string;
  block_time: number;
  tx_index: number;
  side: string;
  token_amount: number;
  quote_mint: string | null;
  quote_amount: number;
  pool_price: number | null;
  pool_quote_mint: string | null;
  pool_quote_reserve: number | null;
}

/** Convert a quote amount to SOL at time t. Non-SOL, non-stable quotes, and stable quotes with no SOL/USD price
 * stored for that time (before the backfill starts), return null. */
export function toSol(amount: number, mint: string | null, t: number, solUsd: SolUsd): number | null {
  if (mint === WSOL) return amount;
  if (mint && STABLES.has(mint)) {
    const p = solUsd.tryAt(t);
    return p === null ? null : amount / p;
  }
  return null;
}

export function rowPrice(r: RawRow, solUsd: SolUsd): number | null {
  if (r.pool_price !== null) {
    const p = toSol(r.pool_price, r.pool_quote_mint, r.block_time, solUsd);
    if (p !== null && p > 0) return p;
  }
  if (r.token_amount > 0) return toSol(r.quote_amount / r.token_amount, r.quote_mint, r.block_time, solUsd);
  return null;
}

/**
 * Point-in-time price and liquidity oracle backed by cached pages of a pool's (vault's) tx stream.
 * Pages are fetched on demand from Helius and stored, so repeated runs cost nothing.
 * Execution queries (`tradesFrom`, `priceAt`) read the tape at or after t: that is the fill a follower acting at t gets.
 */
export class Oracle {
  private readonly qCover: StatementSync;
  private readonly qTrades: StatementSync;
  private readonly qLastTrade: StatementSync;
  private readonly qStateBefore: StatementSync;
  private readonly qStateAfter: StatementSync;
  fetches = 0;
  budgetMisses = 0;
  /** Offline (no client): distinct pages a fetch would have been needed for, keyed by pool and minute (estimates). */
  readonly wouldFetch = new Set<string>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly helius: Helius | null,
    private readonly solUsd: SolUsd,
  ) {
    this.qCover = db.prepare(
      "SELECT MAX(to_ts) AS t FROM fetch_progress WHERE kind = 'page' AND key = ? AND from_ts <= ? AND to_ts >= ?",
    );
    this.qTrades = db.prepare(
      `SELECT sig, wallet, block_time, tx_index, side, token_amount, quote_mint, quote_amount, pool_price, pool_quote_mint, pool_quote_reserve
       FROM swaps WHERE pool = ? AND block_time >= ? AND block_time < ? AND side IN ('buy','sell') ORDER BY block_time, tx_index`,
    );
    this.qLastTrade = db.prepare(
      `SELECT sig, wallet, block_time, tx_index, side, token_amount, quote_mint, quote_amount, pool_price, pool_quote_mint, pool_quote_reserve
       FROM swaps WHERE pool = ? AND block_time < ? AND block_time >= ? AND side IN ('buy','sell') AND pool_price IS NOT NULL
       ORDER BY block_time DESC, tx_index DESC LIMIT 50`,
    );
    this.qStateBefore = db.prepare(
      "SELECT block_time, token_reserve, quote_mint, quote_reserve FROM pool_states WHERE pool = ? AND block_time <= ? ORDER BY block_time DESC LIMIT 1",
    );
    this.qStateAfter = db.prepare(
      "SELECT block_time, token_reserve, quote_mint, quote_reserve FROM pool_states WHERE pool = ? AND block_time >= ? ORDER BY block_time LIMIT 1",
    );
  }

  /** Latest time t' such that [t, t'] is fully covered by stored pages, or null. */
  coveredUntil(pool: string, t: number): number | null {
    const r = this.qCover.get(pool, t, t) as { t: number | null };
    return r.t ?? null;
  }

  /** Make sure the tape of `pool` is stored from t for at least `need` seconds (or until the pool goes quiet). */
  async ensure(pool: string, t: number, need: number): Promise<number | null> {
    let cov = this.coveredUntil(pool, t);
    let from = cov !== null ? cov : t;
    let token: string | null = null;
    for (let i = 0; i < 4 && (cov === null || cov < t + need); i++) {
      if (!this.helius) {
        this.wouldFetch.add(`f|${pool}|${Math.floor(from / 60)}`);
        return cov;
      }
      let page;
      try {
        page = await this.helius.txPage(pool, { from, limit: 100, ...(token ? { paginationToken: token } : {}) }, "page");
      } catch (e) {
        if (e instanceof BudgetExceeded) {
          this.budgetMisses++;
          return cov;
        }
        throw e;
      }
      this.fetches++;
      insertSwaps(this.db, page.txs.flatMap(parseTx));
      insertPoolStates(this.db, page.txs.map((x) => poolStateFromTx(x, pool)).filter((x) => x !== null));
      const times = page.txs.map((x) => x.blockTime ?? from);
      let to: number;
      if (page.txs.length < 100) to = Math.floor(Date.now() / 1000); // pool quiet until now
      else to = Math.max(...times) - 1; // the last second may be partial
      if (to >= from) {
        setProgress(this.db, "page", pool, cov !== null ? from : t, to, "done", page.txs.length);
        // merge: a page starting at the end of an earlier interval extends it
        if (cov !== null) setProgress(this.db, "page", pool, t, to, "done", 0);
        cov = to;
        from = to + 1;
        token = null;
      } else {
        token = page.next; // 100 txs inside one second: continue within it
        if (!token) break;
      }
    }
    return cov;
  }

  private convert(r: RawRow): TapeRow | null {
    const price = rowPrice(r, this.solUsd);
    const sol = toSol(r.quote_amount, r.quote_mint, r.block_time, this.solUsd);
    if (price === null || sol === null) return null;
    const qr = r.pool_quote_reserve === null ? null : toSol(r.pool_quote_reserve, r.pool_quote_mint, r.block_time, this.solUsd);
    return {
      sig: r.sig, wallet: r.wallet, blockTime: r.block_time, txIndex: r.tx_index, side: r.side as "buy" | "sell",
      tokenAmount: r.token_amount, price, sol, poolQuoteReserveSol: qr,
      poolPriced: r.pool_price !== null && sol >= MIN_PRICE_TRADE_SOL,
    };
  }

  /** Trades on the pool in [t, t + seconds), fetching the tape if needed. `complete` is false if coverage ran out. */
  async tradesFrom(pool: string, t: number, seconds: number): Promise<{ rows: TapeRow[]; complete: boolean }> {
    const cov = await this.ensure(pool, t, seconds);
    const end = t + seconds;
    const rows = (this.qTrades.all(pool, t, cov === null ? t : Math.min(end, cov + 1)) as unknown as RawRow[])
      .map((r) => this.convert(r))
      .filter((r): r is TapeRow => r !== null);
    return { rows, complete: cov !== null && cov >= end - 1 };
  }

  /** First trade at or after t within `maxWait` seconds: the fill a follower acting at t gets. */
  async priceAt(pool: string, t: number, maxWait = 3600): Promise<TapeRow | null> {
    let { rows } = await this.tradesFrom(pool, t, 60);
    if (!rows.some((r) => r.poolPriced)) ({ rows } = await this.tradesFrom(pool, t, maxWait));
    return rows.find((r) => r.poolPriced) ?? null;
  }

  /** Stored trades on the pool in (from, to] as a sparse path [t, price, reserveSol] (no fetch). */
  storedPath(pool: string, from: number, to: number): Array<[number, number, number | null]> {
    return (this.qTrades.all(pool, from + 1, to + 1) as unknown as RawRow[])
      .map((r) => this.convert(r))
      .filter((r): r is TapeRow => r !== null && r.poolPriced)
      .map((r) => [r.blockTime, r.price, r.poolQuoteReserveSol] as [number, number, number | null]);
  }

  /** Last known trade strictly before t within `lookback` seconds, priced at the median of the last MARK_TRADES
   * pool-priced trades, from stored data only (no fetch). */
  lastTradeBefore(pool: string, t: number, lookback: number): TapeRow | null {
    // Latest pool-priced, non-dust trades; the price is their median so that one odd fill (a launch-fee-inflated
    // trade, a bundled fill) cannot set a mark on its own.
    const got: TapeRow[] = [];
    for (const r of this.qLastTrade.all(pool, t, t - lookback) as unknown as RawRow[]) {
      const row = this.convert(r);
      if (row?.poolPriced) got.push(row);
      if (got.length === MARK_TRADES) break;
    }
    if (!got.length) return null;
    const ps = got.map((x) => x.price).sort((a, b) => a - b);
    const mid = ps.length % 2 ? ps[(ps.length - 1) / 2]! : (ps[ps.length / 2 - 1]! + ps[ps.length / 2]!) / 2;
    return { ...got[0]!, price: mid };
  }

  /** Mark price at t: last stored trade within 6h, otherwise the latest trade before t from a backward page. */
  async markAt(pool: string, t: number): Promise<TapeRow | null> {
    const local = this.lastTradeBefore(pool, t, 6 * 3600);
    if (local) return local;
    const key = `${pool}|${Math.floor(t / 3600)}`;
    if (this.helius && !this.markCache.has(key)) {
      this.markCache.add(key);
      try {
        const page = await this.helius.txPage(pool, { to: t, order: "desc", limit: 20 }, "mark");
        this.fetches++;
        insertSwaps(this.db, page.txs.flatMap(parseTx));
        insertPoolStates(this.db, page.txs.map((x) => poolStateFromTx(x, pool)).filter((x) => x !== null));
      } catch (e) {
        if (!(e instanceof BudgetExceeded)) throw e;
        this.budgetMisses++;
      }
    }
    return this.lastTradeBefore(pool, t, 365 * 86_400);
  }
  private readonly markCache = new Set<string>();

  /**
   * The pool's state just before t, for an exit nobody traded around: price of its last (non-dust, pool-priced)
   * trade and its quote reserve after that (a later LP withdrawal shows in pool_states). An AMM keeps quoting at
   * that state, so a copier can still sell there if liquidity remains.
   * Trusted only if the last trade is within PRIOR_TRUST_SECONDS of t, or the stored tape covers [last trade, t],
   * or a backward page ending at t was just fetched. Returns "unknown" otherwise, null if the pool never traded.
   */
  async priorState(pool: string, t: number): Promise<{ t: number; price: number; reserveSol: number | null } | null | "unknown"> {
    const latest = () => {
      for (const r of this.qLastTrade.all(pool, t, 0) as unknown as RawRow[]) {
        const row = this.convert(r);
        if (row?.poolPriced) return row;
      }
      return null;
    };
    let r = latest();
    const covered = (from: number) => {
      const c = this.coveredUntil(pool, from);
      return c !== null && c >= t - 1;
    };
    let trusted = r !== null && (t - r.blockTime <= PRIOR_TRUST_SECONDS || covered(r.blockTime));
    if (!trusted && !this.helius) this.wouldFetch.add(`p|${pool}|${Math.floor(t / 60)}`);
    if (!trusted && this.helius) {
      try {
        const page = await this.helius.txPage(pool, { to: t, order: "desc", limit: 20 }, "prior");
        this.fetches++;
        insertSwaps(this.db, page.txs.flatMap(parseTx));
        insertPoolStates(this.db, page.txs.map((x) => poolStateFromTx(x, pool)).filter((x) => x !== null));
        trusted = true;
        r = latest();
      } catch (e) {
        if (!(e instanceof BudgetExceeded)) throw e;
        this.budgetMisses++;
      }
    }
    if (!trusted) return r === null ? null : "unknown";
    if (r === null) return null;
    const st = this.qStateBefore.get(pool, t - 1) as { block_time: number; quote_mint: string | null; quote_reserve: number | null } | undefined;
    const stReserve = st && st.block_time >= r.blockTime && st.quote_reserve !== null ? toSol(st.quote_reserve, st.quote_mint, st.block_time, this.solUsd) : null;
    return { t: r.blockTime, price: r.price, reserveSol: stReserve ?? r.poolQuoteReserveSol };
  }

  /**
   * Trades on the pool in [t - seconds, t), from one backward page if not stored (100 txs at most: on a busy pool
   * the result covers less than `seconds`; `from` says where coverage starts).
   */
  async tradesBefore(pool: string, t: number, seconds: number): Promise<{ rows: TapeRow[]; from: number | null }> {
    const want = t - seconds;
    let from: number | null = null;
    const r = this.db.prepare(
      "SELECT MIN(from_ts) AS f FROM fetch_progress WHERE kind = 'page' AND key = ? AND from_ts <= ? AND to_ts >= ?",
    ).get(pool, t - 1, t - 1) as { f: number | null };
    if (r.f !== null) from = r.f;
    if ((from === null || from > want) && this.helius) {
      try {
        const page = await this.helius.txPage(pool, { to: t, order: "desc", limit: 100 }, "crowd");
        this.fetches++;
        insertSwaps(this.db, page.txs.flatMap(parseTx));
        insertPoolStates(this.db, page.txs.map((x) => poolStateFromTx(x, pool)).filter((x) => x !== null));
        // A short page is the pool's whole history before t; a full one covers from its oldest second (+1, may be partial).
        const oldest = Math.min(...page.txs.map((x) => x.blockTime ?? t));
        const f = page.txs.length < 100 ? 0 : oldest + 1;
        if (f <= t - 1) setProgress(this.db, "page", pool, f, t - 1, "done", page.txs.length);
        from = from === null ? f : Math.min(from, f);
      } catch (e) {
        if (!(e instanceof BudgetExceeded)) throw e;
        this.budgetMisses++;
      }
    } else if (from === null || from > want) this.wouldFetch.add(`b|${pool}|${Math.floor(t / 60)}`);
    if (from === null || from > t - 1) return { rows: [], from: null };
    const rows = (this.qTrades.all(pool, Math.max(want, from), t) as unknown as RawRow[])
      .map((x) => this.convert(x))
      .filter((x): x is TapeRow => x !== null);
    return { rows, from: Math.max(want, from) };
  }

  /** Pool reserves at t: the last stored state at or before t, else the first state after t on covered tape. */
  async stateAt(pool: string, t: number): Promise<PoolState | null> {
    await this.ensure(pool, t, 1);
    const conv = (r: { block_time: number; token_reserve: number; quote_mint: string | null; quote_reserve: number | null } | undefined) =>
      r
        ? {
            blockTime: r.block_time,
            tokenReserve: r.token_reserve,
            quoteReserveSol: r.quote_reserve === null ? null : toSol(r.quote_reserve, r.quote_mint, r.block_time, this.solUsd),
          }
        : null;
    const before = this.qStateBefore.get(pool, t) as Parameters<typeof conv>[0];
    if (before && t - before.block_time < 3600) return conv(before);
    return conv(this.qStateAfter.get(pool, t) as Parameters<typeof conv>[0]) ?? conv(before);
  }
}

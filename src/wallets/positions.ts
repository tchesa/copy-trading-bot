import { MIN_PRICE_TRADE_SOL } from "../data/oracle.js";
import type { Position, Trade } from "./types.js";

/** Holding at or below this fraction of the episode's peak counts as closed (dust left behind). */
const DUST = 0.01;

/** Mark for a still-open position: a price, or a price plus the pool's quote reserve (SOL) to bound the exit. */
export type Mark = number | { price: number; reserveSol: number | null } | null;
export type MarkFn = (mint: string, pool: string | null, t: number) => Mark;

/** Consecutive trades of one position on the same pool more than this far apart in price make it suspect. */
export const MAX_PRICE_JUMP = 1000;

/** The market price of a trade: the pool's (or the loader's validated) price, else the trade's own; null for dust. */
function tradePrice(tr: Trade): number | null {
  if (tr.sol < MIN_PRICE_TRADE_SOL) return null;
  if (tr.price !== null && tr.price > 0) return tr.price;
  return tr.tokens > 0 && tr.sol > 0 ? tr.sol / tr.tokens : null;
}

/**
 * Value of `tokens` at the mark: what selling them into the pool would return (constant product on the quote
 * reserve), not tokens × last price — a dust pool cannot pay out more than it holds.
 */
export function markValue(tokens: number, m: Mark): number {
  if (m === null) return 0;
  const { price, reserveSol } = typeof m === "number" ? { price: m, reserveSol: null } : m;
  const v = tokens * price;
  return reserveSol !== null && reserveSol > 0 ? v / (1 + v / reserveSol) : v;
}

interface Open {
  mint: string;
  pool: string | null;
  venue: Trade["venue"];
  openT: number;
  holding: number;
  peak: number;
  bought: number;
  cost: number;
  proceeds: number;
  /** SOL value of tokens transferred out, at the position's last traded price. */
  transferredOut: number;
  /** Own price (SOL per token) of the most recent buy/sell in this episode, and the pool of the most recent buy. */
  lastPrice: number | null;
  lastPool: string | null;
  tainted: boolean;
  suspect: boolean;
  /** Last pool price seen per pool in this episode (for the jump check). */
  pricesByPool: Map<string, number>;
  /** Opened before `from`: tracked so later trades in the mint are attributed to it, never returned. */
  pre: boolean;
  buys: Trade[];
  sells: Trade[];
  outs: Trade[];
}

/**
 * Rebuild positions from a wallet's trades. Only episodes that open (first buy from flat) inside [from, to)
 * are returned (R-I2); trades at or after `to` are never read. Partial sells and repeated buys accumulate into
 * one episode until the holding falls to dust. Transfers out exit at the last traded price; transfers in taint the episode.
 * Positions still open at `to` are marked with `mark(mint, pool, to)`.
 */
export function buildPositions(trades: Trade[], from: number, to: number, mark: MarkFn): Position[] {
  const open = new Map<string, Open>();
  const out: Position[] = [];
  const close = (o: Open, closeT: number | null, markSol: number) => {
    if (o.pre) return;
    const pnl = o.proceeds + o.transferredOut + markSol - o.cost;
    out.push({
      wallet: o.buys[0]!.wallet,
      mint: o.mint,
      pool: o.pool,
      markPool: o.lastPool ?? o.pool,
      venue: o.venue,
      openT: o.openT,
      closeT,
      costSol: o.cost,
      proceedsSol: o.proceeds,
      transferredOutSol: o.transferredOut,
      markSol,
      pnl,
      ret: o.cost > 0 ? pnl / o.cost : 0,
      holdSeconds: (closeT ?? to) - o.openT,
      tainted: o.tainted,
      suspect: o.suspect,
      entryLiquiditySol: o.buys[0]!.poolQuoteReserveSol,
      buys: o.buys,
      sells: o.sells,
      outs: o.outs,
    });
  };

  const checkJump = (o: Open, tr: Trade) => {
    if (!tr.pool || tr.price === null || !(tr.price > 0)) return;
    const prev = o.pricesByPool.get(tr.pool);
    if (prev !== undefined && Math.max(prev / tr.price, tr.price / prev) > MAX_PRICE_JUMP) o.suspect = true;
    o.pricesByPool.set(tr.pool, tr.price);
  };

  for (const tr of trades) {
    if (tr.t >= to) break;
    let o = open.get(tr.mint);
    if (tr.side === "buy") {
      if (!o) {
        o = {
          mint: tr.mint, pool: tr.pool, venue: tr.venue, openT: tr.t, holding: 0, peak: 0, bought: 0, cost: 0,
          proceeds: 0, transferredOut: 0, lastPrice: null, lastPool: null, tainted: false, suspect: false, pricesByPool: new Map(), pre: tr.t < from, buys: [], sells: [], outs: [],
        };
        open.set(tr.mint, o);
      }
      o.holding += tr.tokens;
      o.bought += tr.tokens;
      o.cost += tr.sol;
      o.peak = Math.max(o.peak, o.holding);
      o.buys.push(tr);
      checkJump(o, tr);
      if (!o.pool && tr.pool) o.pool = tr.pool;
      if (tr.pool) o.lastPool = tr.pool;
      o.lastPrice = tradePrice(tr) ?? o.lastPrice;
    } else if (!o) {
      continue; // sells/transfers of holdings we never saw bought
    } else if (tr.side === "sell") {
      const sold = Math.min(tr.tokens, o.holding);
      o.proceeds += tr.tokens > 0 ? tr.sol * (sold / tr.tokens) : 0;
      o.holding -= sold;
      o.sells.push(tr);
      checkJump(o, tr);
      o.lastPrice = tradePrice(tr) ?? o.lastPrice;
    } else if (tr.side === "out") {
      // A transfer out is an exit valued at the market when the tokens left: the mark at that time (median of recent
      // pool trades, bounded by liquidity), else the position's last validated trade price. Removing cost instead is arbitrary when buy prices differ: average cost lets cheap late buys dilute the
      // basis of earlier sells, and "remaining cost" removal also strips the sold tokens' cost.
      const moved = Math.min(tr.tokens, o.holding);
      const m = mark(o.mint, o.lastPool ?? o.pool, tr.t);
      o.transferredOut += m !== null ? markValue(moved, m) : moved * (o.lastPrice ?? (o.bought > 0 ? o.cost / o.bought : 0));
      o.outs.push(tr);
      o.holding -= moved;
    } else {
      o.holding += tr.tokens;
      o.peak = Math.max(o.peak, o.holding);
      o.tainted = true;
    }
    if (o.holding <= o.peak * DUST) {
      close(o, tr.t, 0);
      open.delete(tr.mint);
    }
  }
  for (const o of open.values()) {
    if (o.pre) continue;
    // Mark at the pool of the latest buy: tokens bought on a dust pool are not worth the price on another pool.
    close(o, null, markValue(o.holding, mark(o.mint, o.lastPool ?? o.pool, to)));
  }
  return out.sort((a, b) => a.openT - b.openT);
}

/**
 * Incremental weekly forward test. State lives in data/fomo/forward/weeks/<snapshot date>.json, one file per selecting
 * snapshot ("week"):
 *   1. resolve the snapshot's traders to wallets (cached by handle) and screen bots on the lookback week before it;
 *   2. once the next snapshot exists, replicate the wallets' buys in [takenAt, next takenAt) whose 48 h time stop has
 *      passed (closed); open buys wait for a later run. Buys go in a fixed-seed random order until the run's budget
 *      stops, so a budget-limited week is a uniform sample;
 *   3. once every buy of the week is closed and replicated, a random-wallet baseline on the same tokens and week.
 * Every decision (wallet status, buy replicated or not, baseline candidates) is frozen when made: re-running costs
 * ~0 credits and gives the same numbers.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BudgetExceeded } from "../data/helius.js";
import { pool as runPool, QuotaExhausted } from "../data/http.js";
import { ensureHistory, screenWallet } from "../data/walletHistory.js";
import { logger } from "../log.js";
import { DAY, type Ctx } from "../research/pipeline.js";
import { replicateBuy } from "../research/replicate.js";
import type { ReplRecord } from "../research/types.js";
import { defaultExclusions, exclusionReasons } from "../wallets/exclusions.js";
import { buildPositions } from "../wallets/positions.js";
import { FORWARD } from "./config.js";
import { loadWalletCache, pendingLookups, resolveTrader, saveWalletCache, WALLETS_FILE, type WalletCache } from "./match.js";
import { assertNoLookahead, isClosed, orderKey, weekBuys, type WeekBuy } from "./select.js";
import type { Snapshot } from "./snapshot.js";

const log = logger("forward");
export const FORWARD_DIR = join("data", "fomo", "forward");
const WEEKS_DIR = join(FORWARD_DIR, "weeks");

export interface WalletWeek {
  wallet: string;
  handles: string[];
  /** Best (lowest) Fomo rank among its handles. */
  rank: number;
  weak: boolean;
  source: "given" | "matched";
  votes: number;
  /** pending: bot screen not run yet; bot: > botTxPerWeek txs in the lookback week; capped: history over the cap
   * while scoring (excluded, logged). */
  status: "pending" | "ok" | "bot" | "capped";
}

export interface Decided {
  wallet: string;
  t: number;
  /** copied: record stored; none: no fill could be built (no pool price). */
  status: "copied" | "none";
}

export interface CopyPool {
  records: Record<string, ReplRecord>;
  decided: Record<string, Decided>;
  /** As of the last run that scored the week. incomplete: the run stopped before every wallet's buys were listed. */
  counts: { universe: number; open: number; pending: number; incomplete?: boolean };
}

export interface WeekState {
  version: number;
  week: string;
  T0: number;
  T1: number | null;
  resolvedHandles: string[];
  wallets: Record<string, WalletWeek>;
  unresolved: Array<{ handle: string; rank: number; reason: string }>;
  fomo: CopyPool;
  baseline: {
    candidates: string[] | null;
    wallets: Record<string, { status: "accepted" | "rejected"; reason?: string }>;
    pool: CopyPool;
  };
  updatedAt: string;
}

const emptyPool = (): CopyPool => ({ records: {}, decided: {}, counts: { universe: 0, open: 0, pending: 0 } });

export function weekFile(week: string, dir = WEEKS_DIR) {
  return join(dir, `${week}.json`);
}

export function loadWeek(week: string, dir = WEEKS_DIR): WeekState | null {
  const f = weekFile(week, dir);
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as WeekState) : null;
}

export function saveWeek(s: WeekState, dir = WEEKS_DIR): void {
  // Guard on every write: nothing stored for a week may predate its selecting snapshot.
  if (s.T1 !== null) {
    assertNoLookahead(Object.values(s.fomo.records), s.T0, s.T1, `week ${s.week}`);
    assertNoLookahead(Object.values(s.baseline.pool.records), s.T0, s.T1, `week ${s.week} baseline`);
  }
  mkdirSync(dir, { recursive: true });
  s.updatedAt = new Date().toISOString();
  writeFileSync(weekFile(s.week, dir), JSON.stringify(s));
}

export function loadWeeks(snaps: Snapshot[], dir = WEEKS_DIR): WeekState[] {
  return snaps.map((s) => loadWeek(s.date, dir)).filter((x): x is WeekState => x !== null);
}

/** A week is complete once every buy is closed and replicated (none open, none waiting on budget). */
export function weekComplete(s: WeekState, runT: number): boolean {
  return s.T1 !== null && isClosed(s.T1, runT) && s.fomo.counts.open === 0 && s.fomo.counts.pending === 0 && !s.fomo.counts.incomplete
    && Object.values(s.wallets).every((w) => w.status !== "pending");
}

/** Share of a week of history in [from, to) that is not stored for the wallet (0 = fully stored), for estimates. */
function missingWeeks(ctx: Ctx, wallet: string, from: number, to: number): number {
  const c = ctx.db.prepare("SELECT from_ts f, to_ts t, status FROM fetch_progress WHERE kind = 'wallet' AND key = ?").get(wallet) as
    | { f: number; t: number; status: string } | undefined;
  if (!c || c.status === "capped") return (to - from) / (7 * DAY);
  return (Math.max(0, c.f - from) + Math.max(0, to - c.t)) / (7 * DAY);
}

function coveredHistory(ctx: Ctx, wallet: string, from: number, to: number): boolean {
  return missingWeeks(ctx, wallet, from, to) === 0;
}

export interface Estimate {
  match: number;
  screen: number;
  history: number;
  tape: number;
  baseline: number;
  notes: string[];
}

export class ForwardRun {
  stopped: string | null = null;
  readonly est: Estimate = { match: 0, screen: 0, history: 0, tape: 0, baseline: 0, notes: [] };
  private readonly p;
  private cache: WalletCache;
  private readonly L = FORWARD.lookbackDays * DAY;

  constructor(
    private readonly ctx: Ctx,
    private readonly snaps: Snapshot[],
    /** Run time, rounded down to the hour: everything read is before it. */
    readonly runT: number,
    readonly mode: "pull" | "estimate",
    private readonly dir = WEEKS_DIR,
    private readonly walletsFile = WALLETS_FILE,
  ) {
    this.p = { ...ctx.p, delays: [...FORWARD.delays], maxHoldHours: FORWARD.maxHoldHours };
    this.cache = loadWalletCache(walletsFile);
  }

  private stop(why: string) {
    if (!this.stopped) {
      this.stopped = why;
      log.warn("stopping: credits for this run used up; the next run continues where this one stopped", { why });
    }
  }

  private budgetError(e: unknown): boolean {
    if (e instanceof BudgetExceeded || e instanceof QuotaExhausted) {
      this.stop((e as Error).message);
      return true;
    }
    return false;
  }

  async run(): Promise<WeekState[]> {
    const states: WeekState[] = [];
    for (let k = 0; k < this.snaps.length && !this.stopped; k++) states.push(await this.prepare(k));
    for (const st of states) {
      if (this.stopped) break;
      await this.score(st);
      if (!this.stopped) await this.baseline(st);
    }
    return states;
  }

  private save(st: WeekState) {
    if (this.mode === "pull") saveWeek(st, this.dir);
  }

  /** Step 1: wallets for the snapshot (resolution and bot screen are frozen per snapshot once made). */
  async prepare(k: number): Promise<WeekState> {
    const s = this.snaps[k]!;
    const st: WeekState = loadWeek(s.date, this.dir) ?? {
      version: FORWARD.version, week: s.date, T0: s.takenAt, T1: null, resolvedHandles: [], wallets: {}, unresolved: [],
      fomo: emptyPool(), baseline: { candidates: null, wallets: {}, pool: emptyPool() }, updatedAt: "",
    };
    if (st.T0 !== s.takenAt) throw new Error(`${s.file}: takenAt changed after the week was started (${st.T0} → ${s.takenAt}); restore it`);
    st.T1 = this.snaps[k + 1]?.takenAt ?? null;
    for (const x of [...s.traders].sort((a, b) => a.rank - b.rank)) {
      if (this.stopped || st.resolvedHandles.includes(x.handle)) continue;
      if (this.mode === "estimate") {
        this.est.match += pendingLookups({ ...s, traders: [x] }, this.cache) * FORWARD.est.matchCreditsPerTrade;
        // its bot screen (lookback week history) too, unless the wallet is known and that history is stored
        const known = x.wallet ?? this.cache[x.handle]?.wallet;
        this.est.screen += FORWARD.est.historyCreditsPerWalletWeek * (known ? missingWeeks(this.ctx, known, st.T0 - this.L, st.T0) : 1);
        continue;
      }
      let r;
      try {
        r = await resolveTrader(this.ctx.helius, s, x, this.cache);
      } catch (e) {
        if (this.budgetError(e)) break;
        throw e;
      }
      saveWalletCache(this.cache, this.walletsFile);
      if (!r.wallet) st.unresolved.push({ handle: x.handle, rank: x.rank, reason: r.tried ? "no on-chain swap matched its Fomo trades" : "no readable Solana trades" });
      else {
        const w = st.wallets[r.wallet];
        if (w) {
          w.handles.push(x.handle);
          w.rank = Math.min(w.rank, x.rank);
        } else st.wallets[r.wallet] = { wallet: r.wallet, handles: [x.handle], rank: x.rank, weak: r.weak, source: r.source as "given" | "matched", votes: r.votes, status: "pending" };
      }
      st.resolvedHandles.push(x.handle);
      this.save(st);
    }
    // Bot screen on the lookback week before the snapshot (no lookahead).
    for (const w of Object.values(st.wallets).filter((x) => x.status === "pending").sort((a, b) => a.rank - b.rank)) {
      if (this.stopped) break;
      if (this.mode === "estimate") {
        this.est.screen += FORWARD.est.historyCreditsPerWalletWeek * missingWeeks(this.ctx, w.wallet, st.T0 - this.L, st.T0);
        continue;
      }
      try {
        w.status = (await ensureHistory(this.ctx.db, this.ctx.helius!, w.wallet, st.T0 - this.L, st.T0, FORWARD.botTxPerWeek)) ? "ok" : "bot";
      } catch (e) {
        if (this.budgetError(e)) break;
        throw e;
      }
      if (w.status === "bot") log.info("bot skipped", { week: st.week, wallet: w.wallet, handles: w.handles });
      this.save(st);
    }
    return st;
  }

  private histEnd(st: WeekState): number {
    return Math.min(this.runT, st.T1! + FORWARD.maxHoldHours * 3600 + FORWARD.closeMarginSeconds);
  }

  /** Copyable buys of `wallet` in the week, from stored history. */
  private buysOf(st: WeekState, wallet: string): WeekBuy[] {
    const L0 = st.T0 - this.L;
    const end = this.histEnd(st);
    return weekBuys(buildPositions(this.ctx.loader.load(wallet, L0, end), L0, end, () => null), st.T0, st.T1!);
  }

  private async ensureWeekHistory(wallet: string, st: WeekState, cap: number): Promise<boolean | "estimate"> {
    const L0 = st.T0 - this.L;
    const end = this.histEnd(st);
    if (this.mode === "estimate") return coveredHistory(this.ctx, wallet, L0, end) ? true : "estimate";
    return ensureHistory(this.ctx.db, this.ctx.helius!, wallet, L0, end, cap);
  }

  /** Replicate `items` (in order) into `pool` until done or the budget stops; a record touched by a budget miss is discarded. */
  private async replicate(st: WeekState, items: WeekBuy[], cp: CopyPool, group: "ranked" | "random") {
    let n = 0;
    await runPool(items, this.ctx.concurrency, async ({ pos, buy }) => {
      if (this.stopped || cp.decided[buy.sig]) return;
      assertNoLookahead([buy], st.T0, st.T1!, `week ${st.week}`);
      const misses = this.ctx.oracle.budgetMisses;
      let rec: ReplRecord | null;
      try {
        rec = await replicateBuy(this.ctx.oracle, this.p, 0, group, {}, pos, buy, false);
      } catch (e) {
        if (this.budgetError(e)) return;
        throw e;
      }
      if (this.ctx.oracle.budgetMisses > misses) return this.stop("budget reached while reading the tape");
      if (this.stopped) return; // another task hit the budget meanwhile: its misses may be in this record's fills
      if (rec) cp.records[buy.sig] = rec;
      cp.decided[buy.sig] = { wallet: buy.wallet, t: buy.t, status: rec ? "copied" : "none" };
      if (++n % 25 === 0) this.save(st);
    });
    this.save(st);
  }

  /** Dry run: tape pages a sample of buys would need, extrapolated. */
  private async estimateTape(items: WeekBuy[]): Promise<number> {
    if (!items.length) return 0;
    const o = this.ctx.oracle;
    const sampled = items.slice(0, 25);
    const k0 = o.wouldFetch.size;
    for (const { pos, buy } of sampled) await replicateBuy(o, this.p, 0, "ranked", {}, pos, buy, false);
    return ((o.wouldFetch.size - k0) / sampled.length) * items.length * 10;
  }

  /** Step 2: the week's Fomo copies. */
  async score(st: WeekState) {
    if (st.T1 === null) return;
    const ok = Object.values(st.wallets).filter((w) => w.status === "ok").sort((a, b) => a.rank - b.rank);
    const span = Math.ceil((this.histEnd(st) - (st.T0 - this.L)) / (7 * DAY));
    const items: WeekBuy[] = [];
    let open = 0;
    let universe = 0;
    let listed = 0;
    for (const w of ok) {
      if (this.stopped) break;
      let have: boolean | "estimate";
      try {
        have = await this.ensureWeekHistory(w.wallet, st, FORWARD.botTxPerWeek * span);
      } catch (e) {
        if (this.budgetError(e)) break;
        throw e;
      }
      if (have === "estimate") {
        this.est.history += FORWARD.est.historyCreditsPerWalletWeek * missingWeeks(this.ctx, w.wallet, st.T0 - this.L, this.histEnd(st));
        const closedShare = Math.max(0, Math.min(1, (this.runT - FORWARD.maxHoldHours * 3600 - st.T0) / (st.T1 - st.T0)));
        this.est.tape += FORWARD.est.buysPerWalletWeek * ((st.T1 - st.T0) / (7 * DAY)) * closedShare * FORWARD.est.creditsPerBuy;
        continue;
      }
      if (!have) {
        w.status = "capped";
        log.warn("history over the cap while scoring: wallet excluded this week", { week: st.week, wallet: w.wallet, handles: w.handles });
        this.save(st);
        continue;
      }
      const buys = this.buysOf(st, w.wallet);
      listed++;
      universe += buys.length;
      for (const b of buys) {
        if (!isClosed(b.buy.t, this.runT)) open++;
        else if (!st.fomo.decided[b.buy.sig]) items.push(b);
      }
    }
    items.sort((a, b) => orderKey(st.week, a.buy.sig) - orderKey(st.week, b.buy.sig) || (a.buy.sig < b.buy.sig ? -1 : 1));
    if (this.mode === "estimate") {
      this.est.tape += await this.estimateTape(items);
      return;
    }
    if (!this.stopped) await this.replicate(st, items, st.fomo, "ranked");
    const pending = items.filter((b) => !st.fomo.decided[b.buy.sig]).length;
    const incomplete = listed < ok.filter((w) => w.status === "ok").length;
    st.fomo.counts = incomplete ? { ...st.fomo.counts, pending: Math.max(pending, st.fomo.counts.pending), incomplete } : { universe, open, pending };
    this.save(st);
    log.info("week scored", { week: st.week, universe, copied: Object.keys(st.fomo.records).length, open, pending, credits: this.ctx.helius?.creditsUsed });
  }

  /** Step 3: random wallets that bought the same tokens in the same week (after the week is complete). */
  async baseline(st: WeekState) {
    if (!weekComplete(st, this.runT)) return;
    const b = st.baseline;
    const L0 = st.T0 - this.L;
    if (this.mode === "estimate") {
      const left = FORWARD.baselineWallets - Object.values(b.wallets).filter((x) => x.status === "accepted").length;
      if (left > 0) this.est.baseline += left * 1.5 * (10 + 2 * FORWARD.est.historyCreditsPerWalletWeek * 0.3) + left * FORWARD.baselineBuysPerWallet * FORWARD.est.creditsPerBuy;
      return;
    }
    if (!b.candidates) {
      const mints = [...new Set(Object.values(st.fomo.records).map((r) => r.mint))].sort();
      const fomo = new Set(Object.keys(st.wallets));
      const q = this.ctx.db.prepare("SELECT DISTINCT wallet FROM swaps WHERE mint = ? AND block_time >= ? AND block_time < ? AND side = 'buy'");
      const set = new Set<string>();
      for (const m of mints) for (const r of q.all(m, st.T0, st.T1!) as Array<{ wallet: string }>) if (!fomo.has(r.wallet)) set.add(r.wallet);
      b.candidates = [...set].sort((x, y) => orderKey(`${st.week}|base`, x) - orderKey(`${st.week}|base`, y) || (x < y ? -1 : 1)).slice(0, FORWARD.baselineWallets * 10);
      this.save(st);
    }
    let accepted = Object.values(b.wallets).filter((x) => x.status === "accepted").length;
    for (const w of b.candidates) {
      if (this.stopped) break;
      const prior = b.wallets[w];
      if (prior?.status === "rejected") continue;
      if (!prior && accepted >= FORWARD.baselineWallets) break;
      try {
        if (!prior) {
          const sc = await screenWallet(this.ctx.db, this.ctx.helius!, w, L0, st.T1!, defaultExclusions.maxTradesPerDay);
          let reason: string | null = sc.hft ? "hft (signature screen)" : null;
          if (!reason && !(await ensureHistory(this.ctx.db, this.ctx.helius!, w, L0, this.histEnd(st), FORWARD.baselineMaxTx))) reason = "history over cap";
          if (!reason) {
            const trades = this.ctx.loader.load(w, L0, st.T0);
            const ex = exclusionReasons(trades, buildPositions(trades, L0, st.T0, () => null), L0, st.T0, defaultExclusions);
            if (ex.length) reason = `excluded in lookback week: ${ex.join(",")}`;
          }
          if (!reason && !this.buysOf(st, w).length) reason = "no copyable buys";
          b.wallets[w] = reason ? { status: "rejected", reason } : { status: "accepted" };
          this.save(st);
          if (reason) continue;
          accepted++;
        }
        const chosen = this.buysOf(st, w)
          .sort((x, y) => orderKey(st.week, x.buy.sig) - orderKey(st.week, y.buy.sig) || (x.buy.sig < y.buy.sig ? -1 : 1))
          .slice(0, FORWARD.baselineBuysPerWallet);
        await this.replicate(st, chosen, b.pool, "random");
      } catch (e) {
        if (this.budgetError(e)) break;
        throw e;
      }
    }
    b.pool.counts = { universe: Object.keys(b.pool.decided).length, open: 0, pending: 0 };
    this.save(st);
    log.info("baseline", { week: st.week, accepted, records: Object.keys(b.pool.records).length, credits: this.ctx.helius?.creditsUsed });
  }
}

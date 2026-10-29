/**
 * Copyability score C (copyability spec 4.1): replicate a sample of a wallet's formation-window buys with the Phase A
 * simulator at a 5 s entry, exits mirroring the leader's sells at the leader's own sell fills, 48 h time stop, Phase A
 * fees and rug model. C = top-1%-trimmed mean of the follower returns.
 */
import type { CostParams } from "../config/params.js";
import { simulateFollower, type FollowerResult } from "../research/follower.js";
import { fillAt, sellSchedule, type Tape } from "../research/replicate.js";
import type { Fill, ReplRecord } from "../research/types.js";
import { hashSeed, rng, sample } from "../util/rng.js";
import { mean, trimTop } from "../util/stats.js";
import { MIN_POSITION_COST_SOL } from "../wallets/metrics.js";
import type { Position, Trade } from "../wallets/types.js";
import { STAGE1 } from "./config.js";

export const trimmed = (xs: number[]) => mean(trimTop(xs, STAGE1.trim));

/** A lookahead read: ranking asked for tape at or after the formation end. */
export class LookaheadError extends Error {}

/** A tape that refuses any read reaching `end` or later (R-P2: ranking reads formation-window data only). */
export function fence<T extends Tape & { tradesBefore?: (pool: string, t: number, s: number) => Promise<unknown> }>(tape: T, end: number): T {
  const check = (t: number, what: string) => {
    if (t > end) throw new LookaheadError(`${what} reads tape up to ${t}, after formation end ${end}`);
  };
  return new Proxy(tape, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      if (typeof v !== "function") return v;
      if (!["tradesFrom", "stateAt", "priorState", "tradesBefore"].includes(String(prop))) return v.bind(target);
      return async (...args: unknown[]) => {
        const [, t, s] = args as [string, number, number];
        check(prop === "tradesFrom" ? t + s : t, String(prop));
        return v.apply(target, args);
      };
    },
  });
}

/** Latest buy time whose whole replication (hold + an hour to find a quiet-pool fill) stays inside the window. */
export const lastScorableBuy = (F1: number) => F1 - STAGE1.maxHoldHours * 3600 - 3600;

/**
 * Formation buys eligible for C and I: in positions opened in [F0, F1) that count for wallet metrics (not tainted or
 * suspect, cost ≥ MIN_POSITION_COST_SOL), with a pool price, early enough to finish inside the window, and not used
 * in any eval window for this wallet (R-P5). Seeded uniform sample per wallet-step.
 */
export function formationBuys(positions: Position[], F0: number, F1: number, step: number, wallet: string, exclude: Set<string>): Array<{ pos: Position; buy: Trade }> {
  const last = lastScorableBuy(F1);
  const all = positions
    .filter((p) => !p.tainted && !p.suspect && p.costSol >= MIN_POSITION_COST_SOL && p.openT >= F0)
    .flatMap((pos) => pos.buys.filter((b) => b.t >= F0 && b.t <= last && b.pool && b.price !== null && !exclude.has(b.sig)).map((buy) => ({ pos, buy })))
    .sort((a, b) => a.buy.t - b.buy.t || (a.buy.sig < b.buy.sig ? -1 : 1));
  return sample(all, STAGE1.formationBuys, rng(hashSeed("C", step, wallet)));
}

/** Exit fill at the leader's own sell (price and the reserve its tx left); rug if that liquidity is below the floor. */
export function leaderExitFill(s: ReplRecord["sells"][number], minExitLiquiditySol: number): Fill {
  const reserveSol = s.reserveSol ?? null;
  return { t: s.t, price: s.poolPrice ?? s.price, reserveSol, rug: reserveSol !== null && reserveSol < minExitLiquiditySol };
}

/**
 * Formation replication record: 5 s entry on the tape; exits at the leader's own sells (transfers out on the tape at
 * the transfer, since there is no leader price); time stop on the tape only if the leader still holds by then.
 * fills["0"] holds the leader's own entry so attribution and leader return work as in Phase A.
 */
export async function replicateFormationBuy(tape: Tape, step: number, pos: Position, buy: Trade, minExitLiquiditySol: number): Promise<ReplRecord | null> {
  if (!buy.pool || buy.price === null) return null;
  const pool = buy.pool;
  const timeStopT = buy.t + STAGE1.maxHoldHours * 3600;
  const sells = sellSchedule(pos, buy, timeStopT);
  const exits: Fill[] = [];
  for (const s of sells) {
    exits.push(s.kind === "out" ? await fillAt(tape, s.pool ?? pool, s.t, minExitLiquiditySol, true) : leaderExitFill(s, minExitLiquiditySol));
  }
  const fullyExited = sells.some((s) => s.frac >= 1);
  const lastPool = [...sells].reverse().find((s) => s.pool)?.pool ?? pool;
  const timeStop = fullyExited ? null : await fillAt(tape, lastPool, timeStopT, minExitLiquiditySol, true);
  const entry5 = await fillAt(tape, pool, buy.t + STAGE1.cDelay, minExitLiquiditySol, false);
  const leaderEntry: Fill = { t: buy.t, price: buy.price, reserveSol: buy.poolQuoteReserveSol, rug: false };
  return {
    step, wallet: buy.wallet, group: "ranked", ranks: {}, sig: buy.sig, t: buy.t, mint: buy.mint, pool, venue: buy.venue,
    leaderSol: buy.sol, leaderTokens: buy.tokens, leaderPoolPrice: buy.price, entryReserveSol: buy.poolQuoteReserveSol,
    buyers30: 0, sells, timeStopT,
    fills: { "0": { entry: leaderEntry, exits, timeStop }, [String(STAGE1.cDelay)]: { entry: entry5, exits, timeStop } },
    path: null,
  };
}

/**
 * The same C semantics on a Phase A (eval) record: its 5 s entry, exits at the leader's own sells (transfers out at
 * their delay-0 tape fill), its delay-0 time stop. Used for the eval-window C in the score-persistence check (G7).
 */
export function asLeaderExit(r: ReplRecord, minExitLiquiditySol: number): ReplRecord {
  const z = r.fills["0"]!;
  const exits = r.sells.map((s, i) => (s.kind === "out" ? z.exits[i]! : leaderExitFill(s, minExitLiquiditySol)));
  const d = String(STAGE1.cDelay);
  return { ...r, fills: { "0": { ...z, exits }, [d]: { entry: r.fills[d]!.entry, exits, timeStop: z.timeStop } } };
}

export function simulateC(r: ReplRecord, costs: CostParams): FollowerResult | null {
  const x = simulateFollower(r, { delay: STAGE1.cDelay, sizeSol: STAGE1.sizeSol, costs, maxHoldHours: STAGE1.maxHoldHours });
  return x.ok ? x : null;
}

/** C from replicated buys: null below minCBuys readable results. */
export function copyScore(results: Array<FollowerResult | null>): { C: number | null; n: number } {
  const rets = results.filter((x): x is FollowerResult => x !== null).map((x) => x.ret);
  return { C: rets.length >= STAGE1.minCBuys ? trimmed(rets) : null, n: rets.length };
}

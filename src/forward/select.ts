/** Pure selection rules for the forward test: which leader buys a week copies, in what order, and when. */
import { hashSeed } from "../util/rng.js";
import type { Position, Trade } from "../wallets/types.js";
import type { ReplRecord } from "../research/types.js";
import { FORWARD } from "./config.js";

export class LookaheadError extends Error {}

export interface WeekBuy {
  pos: Position;
  buy: Trade;
}

/**
 * Buys a copier following `wallet` from the snapshot at T0 would see before the next snapshot at T1: every buy in
 * [T0, T1) of at least minBuySol with a pool price, on positions that are neither tainted (tokens transferred in) nor
 * suspect (price jump). Positions may have opened before T0 (in the lookback week): adding to them is a new buy.
 */
export function weekBuys(positions: Position[], T0: number, T1: number): WeekBuy[] {
  const out: WeekBuy[] = [];
  for (const pos of positions) {
    if (pos.tainted || pos.suspect) continue;
    for (const buy of pos.buys) {
      if (buy.t < T0 || buy.t >= T1) continue;
      if (buy.sol < FORWARD.minBuySol || !buy.pool || buy.price === null) continue;
      out.push({ pos, buy });
    }
  }
  return out;
}

/** A buy can be replicated once its time stop (plus margin) is in the past at `runT`. */
export function isClosed(buyT: number, runT: number): boolean {
  return buyT + FORWARD.maxHoldHours * 3600 + FORWARD.closeMarginSeconds <= runT;
}

/** Fixed-seed random order key: a prefix of buys sorted by it is a uniform sample, and adding buys never reorders. */
export function orderKey(week: string, sig: string): number {
  return hashSeed(FORWARD.seed, week, sig);
}

/** The no-lookahead rule: nothing replicated for a week may predate the snapshot that selected its wallet. */
export function assertNoLookahead(records: Array<Pick<ReplRecord, "t" | "sig" | "wallet">>, T0: number, T1: number, what: string): void {
  for (const r of records) {
    if (r.t < T0) throw new LookaheadError(`${what}: buy ${r.sig} of ${r.wallet} at ${r.t} predates its selecting snapshot (${T0})`);
    if (r.t >= T1) throw new LookaheadError(`${what}: buy ${r.sig} of ${r.wallet} at ${r.t} is after the week's end (${T1})`);
  }
}

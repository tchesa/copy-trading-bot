import type { Oracle } from "../data/oracle.js";
import { median } from "../util/stats.js";
import { sample } from "../util/rng.js";
import type { Position } from "./types.js";

export interface Crowding {
  crowd5: number;
  crowd30: number;
  crowd60: number;
  sellIntoCrowd: number;
}

/** Distinct other wallets buying the pool in (t, t + w] seconds after a buy (same-second txs after it included). */
export function distinctBuyersAfter(
  rows: Array<{ wallet: string; blockTime: number; side: string; sig: string }>, wallet: string, sig: string, t: number, w: number,
): number {
  const s = new Set<string>();
  for (const r of rows) if (r.side === "buy" && r.wallet !== wallet && r.sig !== sig && r.blockTime >= t && r.blockTime <= t + w) s.add(r.wallet);
  return s.size;
}

/**
 * §4.4 crowding for one wallet from a sample of its buys and sells (formation window only; the tape read
 * after a formation buy is still before the formation end for all but the last minute, which is excluded).
 */
export async function measureCrowding(
  oracle: Oracle, wallet: string, positions: Position[], formationEnd: number, rand: () => number, maxBuys = 6, maxSells = 6,
): Promise<Crowding> {
  const buys = positions.flatMap((p) => p.buys.slice(0, 1)).filter((b) => b.pool && b.t + 60 < formationEnd);
  const sells = positions.flatMap((p) => p.sells).filter((s) => s.pool && s.t < formationEnd);
  const c5: number[] = [], c30: number[] = [], c60: number[] = [];
  for (const b of sample(buys, maxBuys, rand)) {
    const { rows } = await oracle.tradesFrom(b.pool!, b.t, 61);
    c5.push(distinctBuyersAfter(rows, wallet, b.sig, b.t, 5));
    c30.push(distinctBuyersAfter(rows, wallet, b.sig, b.t, 30));
    c60.push(distinctBuyersAfter(rows, wallet, b.sig, b.t, 60));
  }
  let elevated = 0, n = 0;
  for (const s of sample(sells, maxSells, rand)) {
    const { rows } = await oracle.tradesFrom(s.pool!, s.t - 60, 60);
    const buyers = new Set(rows.filter((r) => r.side === "buy" && r.wallet !== wallet && r.blockTime < s.t).map((r) => r.wallet));
    n++;
    if (buyers.size >= 3) elevated++;
  }
  return {
    crowd5: c5.length ? median(c5) : 0,
    crowd30: c30.length ? median(c30) : 0,
    crowd60: c60.length ? median(c60) : 0,
    sellIntoCrowd: n ? elevated / n : 0,
  };
}

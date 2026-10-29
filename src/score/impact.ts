/**
 * Market impact score I (copyability spec 4.2). Pure: tape rows in, numbers out. The leader's own transactions are
 * excluded from every follow-on measure (R-P4).
 */
import type { TapeRow } from "../data/oracle.js";
import { median, ranks } from "../util/stats.js";
import { STAGE1 } from "./config.js";

export interface BuyRef {
  sig: string;
  wallet: string;
  t: number;
  sol: number;
  /** Pool quote reserve (SOL) after the leader's buy (from its own tx). */
  reserveAfterSol: number | null;
}

/** Leader buy size ÷ pool quote reserve before the buy (reserve after minus what the buy paid in). */
export function impactOf(b: BuyRef): number | null {
  if (b.reserveAfterSol === null || !(b.sol > 0)) return null;
  const before = b.reserveAfterSol - b.sol;
  return before > 0 ? b.sol / before : null;
}

/** Split tape rows around the leader's tx: [before, after], without the leader's own rows. */
function around(rows: TapeRow[], b: BuyRef): [TapeRow[], TapeRow[]] {
  const i = rows.findIndex((r) => r.sig === b.sig);
  const others = (xs: TapeRow[]) => xs.filter((r) => r.wallet !== b.wallet);
  if (i >= 0) return [others(rows.slice(0, i)), others(rows.slice(i + 1))];
  return [others(rows.filter((r) => r.blockTime < b.t)), others(rows.filter((r) => r.blockTime > b.t))];
}

/**
 * log(price at t+30s ÷ price right after the buy) − log(price at t ÷ price at t−30s). `rows` must cover
 * [t − 30, t + 30] completely. No trades on a side means the price did not move there (that term is 0).
 */
export function followMoveOf(rows: TapeRow[], b: BuyRef, w = STAGE1.crowdWindow): number {
  const [pre, post] = around(rows, b);
  const pp = pre.filter((r) => r.poolPriced && r.blockTime >= b.t - w);
  const qp = post.filter((r) => r.poolPriced && r.blockTime <= b.t + w);
  const preDrift = pp.length >= 2 ? Math.log(pp[pp.length - 1]!.price / pp[0]!.price) : 0;
  const postDrift = qp.length >= 2 ? Math.log(qp[qp.length - 1]!.price / qp[0]!.price) : 0;
  return postDrift - preDrift;
}

/** Distinct buyers in (t, t+30s] − distinct buyers in [t−30s, t), leader excluded. */
export function followBuyersOf(rows: TapeRow[], b: BuyRef, w = STAGE1.crowdWindow): number {
  const [pre, post] = around(rows, b);
  const buyers = (xs: TapeRow[]) => new Set(xs.filter((r) => r.side === "buy").map((r) => r.wallet)).size;
  return buyers(post.filter((r) => r.blockTime <= b.t + w)) - buyers(pre.filter((r) => r.blockTime >= b.t - w));
}

/**
 * Was the leader's sell at `t` made into a crowd? Distinct buyers (leader excluded) in [t−30s, t) ≥ crowdMultiple ×
 * the baseline, the mean distinct buyers per 30 s bucket over [from, t−30s) (from = t − 1 h, or where the stored tape
 * starts on a busy pool), and ≥ crowdMinBuyers. `rows` = trades in [from, t). Null if under one baseline bucket.
 */
export function sellIntoCrowdOf(rows: TapeRow[], leader: string, t: number, from: number, w = STAGE1.crowdWindow): boolean | null {
  const nb = Math.floor((t - w - from) / w);
  if (nb < 1) return null;
  const buys = rows.filter((r) => r.side === "buy" && r.wallet !== leader);
  const cur = new Set(buys.filter((r) => r.blockTime >= t - w && r.blockTime < t).map((r) => r.wallet)).size;
  const start = t - w - nb * w;
  const buckets = new Map<number, Set<string>>();
  for (const r of buys) {
    if (r.blockTime < start || r.blockTime >= t - w) continue;
    const k = Math.floor((r.blockTime - start) / w);
    if (!buckets.has(k)) buckets.set(k, new Set());
    buckets.get(k)!.add(r.wallet);
  }
  const baseline = [...buckets.values()].reduce((a, s) => a + s.size, 0) / nb;
  return cur >= STAGE1.crowdMinBuyers && cur >= STAGE1.crowdMultiple * baseline;
}

export interface ImpactComponents {
  /** Medians over measurable formation buys. */
  impact: number | null;
  followMove: number | null;
  followBuyers: number | null;
  /** Share of readable sells made into a crowd. */
  sellIntoCrowd: number | null;
  /** Buys with all three buy-side components. */
  measurableBuys: number;
  readableSells: number;
}

export function walletComponents(buys: Array<{ impact: number | null; followMove: number | null; followBuyers: number | null }>, sells: Array<boolean | null>): ImpactComponents {
  const ok = buys.filter((b) => b.impact !== null && b.followMove !== null && b.followBuyers !== null);
  const med = (k: "impact" | "followMove" | "followBuyers") => (ok.length ? median(ok.map((b) => b[k]!)) : null);
  const rs = sells.filter((x): x is boolean => x !== null);
  return {
    impact: med("impact"), followMove: med("followMove"), followBuyers: med("followBuyers"),
    sellIntoCrowd: rs.length ? rs.filter(Boolean).length / rs.length : null,
    measurableBuys: ok.length, readableSells: rs.length,
  };
}

/**
 * I per wallet: each component as a percentile rank among the step's scored wallets (0 = least, 1 = most
 * market-moving; ties share the average rank), I = mean of the available percentiles. Wallets with fewer than
 * minIBuys measurable buys get no I. sellIntoCrowd is left out of a wallet's mean when it had no readable sell.
 */
export function impactScores(comps: Map<string, ImpactComponents>): Map<string, number> {
  const scored = [...comps].filter(([, c]) => c.measurableBuys >= STAGE1.minIBuys);
  const pctOf = (k: keyof Pick<ImpactComponents, "impact" | "followMove" | "followBuyers" | "sellIntoCrowd">) => {
    const have = scored.filter(([, c]) => c[k] !== null);
    const rk = ranks(have.map(([, c]) => c[k]!));
    const n = have.length;
    return new Map(have.map(([w], i) => [w, n > 1 ? (rk[i]! - 1) / (n - 1) : 0.5]));
  };
  const parts = (["impact", "followMove", "followBuyers", "sellIntoCrowd"] as const).map(pctOf);
  const out = new Map<string, number>();
  for (const [w] of scored) {
    const ps = parts.map((m) => m.get(w)).filter((x): x is number => x !== undefined);
    out.set(w, ps.reduce((a, b) => a + b, 0) / ps.length);
  }
  return out;
}

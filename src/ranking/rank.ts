import { ranks } from "../util/stats.js";
import type { WalletMetrics } from "../wallets/metrics.js";

export type RankingId = "S1" | "S2" | "S3" | "S4";
export const RANKINGS: RankingId[] = ["S1", "S2", "S3", "S4"];

export interface RankInput {
  /** All candidates with metrics (S1 uses these, unfiltered). */
  all: WalletMetrics[];
  /** Candidates passing exclusions and eligibility (S2-S4). */
  eligible: WalletMetrics[];
}

function by(ms: WalletMetrics[], score: (m: WalletMetrics) => number): WalletMetrics[] {
  return ms
    .map((m) => [m, score(m)] as const)
    .filter(([, s]) => Number.isFinite(s))
    .sort((a, b) => b[1] - a[1] || (a[0].wallet < b[0].wallet ? -1 : 1))
    .map(([m]) => m);
}

/** §4.5 ranking methods. Pure: output depends only on formation metrics. */
export function rank(id: RankingId, input: RankInput): WalletMetrics[] {
  switch (id) {
    case "S1":
      return by(input.all, (m) => m.pnl);
    case "S2":
      return by(input.eligible, (m) => m.roc);
    case "S3":
      // On-chain PnL/followers: return on capital divided by how many wallets pile in within 30s.
      return by(input.eligible, (m) => (m.roc > 0 ? m.roc / Math.max(1, m.crowd30 ?? 1) : m.roc));
    case "S4": {
      const el = input.eligible;
      const r1 = ranks(el.map((m) => m.medianRet));
      const r2 = ranks(el.map((m) => m.pctPositiveWeeks));
      const score = new Map(el.map((m, i) => [m.wallet, (r1[i]! + r2[i]!) / 2]));
      return by(el, (m) => score.get(m.wallet) ?? -Infinity);
    }
  }
}

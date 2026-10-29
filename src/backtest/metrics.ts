import { mean, median, std } from "../util/stats.js";
import type { SimTrade } from "./sim.js";

export interface Metrics {
  hours: number;
  totalReturn: number;
  apr: number;
  maxDrawdown: number;
  sharpe: number;
  sortino: number;
  trades: number;
  failedTxs: number;
  winRate: number;
  medianTradeRet: number;
  meanTradeRet: number;
  avgHoldHours: number;
  top5TradeShare: number;
  top5TokenShare: number;
  aprExTop5: number;
  rugRate: number;
  rugLossSol: number;
  captureRatio: number;
  pnlSol: number;
}

const HOURS_PER_YEAR = 8760;

/** Metrics from a normalized hourly equity curve (starting at 1) and the trades behind it (§8.2). */
export function computeMetrics(curve: Array<[number, number]>, trades: SimTrade[], initial: number): Metrics {
  const eq = curve.map(([, e]) => e);
  const hours = Math.max(1, curve.length - 1);
  const last = eq[eq.length - 1] ?? 1;
  const first = eq[0] ?? 1;
  const total = last / first - 1;
  const apr = last > 0 ? (last / first) ** (HOURS_PER_YEAR / hours) - 1 : -1;
  let hi = -Infinity, dd = 0;
  for (const e of eq) {
    hi = Math.max(hi, e);
    dd = Math.max(dd, hi > 0 ? 1 - e / hi : 0);
  }
  const rets: number[] = [];
  for (let i = 1; i < eq.length; i++) if (eq[i - 1]! > 0) rets.push(eq[i]! / eq[i - 1]! - 1);
  const sd = std(rets);
  const down = Math.sqrt(mean(rets.map((r) => Math.min(0, r) ** 2)) || 0);
  const ann = Math.sqrt(HOURS_PER_YEAR);
  const filled = trades.filter((t) => !t.failed);
  const pnl = filled.reduce((a, t) => a + t.pnlSol, 0) + trades.filter((t) => t.failed).reduce((a, t) => a + t.pnlSol, 0);
  const sortedPnl = filled.map((t) => t.pnlSol).sort((a, b) => b - a);
  const top5 = sortedPnl.slice(0, 5).reduce((a, b) => a + Math.max(0, b), 0);
  const byToken = new Map<string, number>();
  for (const t of filled) byToken.set(t.mint, (byToken.get(t.mint) ?? 0) + t.pnlSol);
  const top5Tok = [...byToken.values()].sort((a, b) => b - a).slice(0, 5).reduce((a, b) => a + Math.max(0, b), 0);
  const grossWin = filled.reduce((a, t) => a + Math.max(0, t.pnlSol), 0);
  const exTop5Final = last - top5 / initial;
  const aprExTop5 = exTop5Final > 0 ? (exTop5Final / first) ** (HOURS_PER_YEAR / hours) - 1 : -1;
  const rugs = filled.filter((t) => t.rug);
  const leaderMean = mean(filled.map((t) => t.leaderRet));
  return {
    hours,
    totalReturn: total,
    apr,
    maxDrawdown: dd,
    sharpe: sd > 0 ? (mean(rets) / sd) * ann : 0,
    sortino: down > 0 ? (mean(rets) / down) * ann : 0,
    trades: filled.length,
    failedTxs: trades.length - filled.length,
    winRate: filled.length ? filled.filter((t) => t.pnlSol > 0).length / filled.length : 0,
    medianTradeRet: filled.length ? median(filled.map((t) => t.ret)) : 0,
    meanTradeRet: filled.length ? mean(filled.map((t) => t.ret)) : 0,
    avgHoldHours: filled.length ? mean(filled.map((t) => (t.exitT - t.entryT) / 3600)) : 0,
    top5TradeShare: grossWin > 0 ? top5 / grossWin : 0,
    top5TokenShare: grossWin > 0 ? top5Tok / grossWin : 0,
    aprExTop5,
    rugRate: filled.length ? rugs.length / filled.length : 0,
    rugLossSol: rugs.reduce((a, t) => a + Math.min(0, t.pnlSol), 0),
    captureRatio: leaderMean ? mean(filled.map((t) => t.ret)) / leaderMean : NaN,
    pnlSol: pnl,
  };
}

export function emptyMetrics(): Metrics {
  return computeMetrics([[0, 1], [3600, 1]], [], 1);
}

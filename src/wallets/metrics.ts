import { mean, median } from "../util/stats.js";
import type { Position, Trade } from "./types.js";

export interface WalletMetrics {
  wallet: string;
  positions: number;
  closed: number;
  pnl: number;
  peakCapital: number;
  /** PnL ÷ peak capital deployed. */
  roc: number;
  winRate: number;
  medianRet: number;
  meanRet: number;
  /** Max drawdown of the realized equity curve, as a fraction of peak capital. */
  maxDrawdown: number;
  pctPositiveWeeks: number;
  medianHoldMinutes: number;
  medianEntryLiquiditySol: number;
  /** Largest single-position PnL as a share of total PnL (0 when total PnL ≤ 0). */
  maxPnlConcentration: number;
  lastActivity: number;
  tradesPerDay: number;
  /** Filled in by crowding.ts when measured. */
  crowd5?: number;
  crowd30?: number;
  crowd60?: number;
  sellIntoCrowd?: number;
}

const WEEK = 7 * 86_400;

/** Positions that cost less than this (SOL) are left out of wallet metrics: fixed fees and dust-pool prices
 * dominate them, and a few of them can give a 0.02-SOL wallet a 2000% ROC. */
export const MIN_POSITION_COST_SOL = 0.01;

export function walletMetrics(wallet: string, positions: Position[], trades: Trade[], from: number, to: number): WalletMetrics {
  const ps = positions.filter((p) => !p.tainted && !p.suspect && p.costSol >= MIN_POSITION_COST_SOL);
  const closed = ps.filter((p) => p.closeT !== null);
  const pnl = ps.reduce((a, p) => a + p.pnl, 0);

  // Peak capital: max concurrent cost basis of open positions.
  const ev: Array<[number, number]> = [];
  for (const p of ps) {
    ev.push([p.openT, p.costSol]);
    ev.push([p.closeT ?? to, -p.costSol]);
  }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0, peak = 0;
  for (const [, d] of ev) {
    cur += d;
    peak = Math.max(peak, cur);
  }

  // Realized equity curve by close time (open positions marked at the end).
  const eq = ps.map((p) => [p.closeT ?? to, p.pnl] as const).sort((a, b) => a[0] - b[0]);
  let e = 0, hi = 0, dd = 0;
  for (const [, x] of eq) {
    e += x;
    hi = Math.max(hi, e);
    dd = Math.max(dd, hi - e);
  }

  const weeks = new Map<number, number>();
  for (const [t, x] of eq) {
    const w = Math.floor((t - from) / WEEK);
    weeks.set(w, (weeks.get(w) ?? 0) + x);
  }
  const nWeeks = Math.max(1, Math.ceil((to - from) / WEEK));
  let posWeeks = 0;
  for (let w = 0; w < nWeeks; w++) if ((weeks.get(w) ?? 0) > 0) posWeeks++;

  const maxWin = Math.max(0, ...ps.map((p) => p.pnl));
  const swaps = trades.filter((t) => (t.side === "buy" || t.side === "sell") && t.t >= from && t.t < to);
  const liq = ps.map((p) => p.entryLiquiditySol).filter((x): x is number => x !== null);
  return {
    wallet,
    positions: ps.length,
    closed: closed.length,
    pnl,
    peakCapital: peak,
    roc: peak > 0 ? pnl / peak : 0,
    winRate: ps.length ? ps.filter((p) => p.pnl > 0).length / ps.length : 0,
    medianRet: ps.length ? median(ps.map((p) => p.ret)) : 0,
    meanRet: ps.length ? mean(ps.map((p) => p.ret)) : 0,
    maxDrawdown: peak > 0 ? dd / peak : 0,
    pctPositiveWeeks: posWeeks / nWeeks,
    medianHoldMinutes: closed.length ? median(closed.map((p) => p.holdSeconds / 60)) : 0,
    medianEntryLiquiditySol: liq.length ? median(liq) : 0,
    // Only meaningful for profitable wallets; losers are not excluded by it (that would bias the eligible pool).
    maxPnlConcentration: pnl > 0 ? maxWin / pnl : 0,
    lastActivity: swaps.length ? swaps[swaps.length - 1]!.t : 0,
    tradesPerDay: swaps.length / ((to - from) / 86_400),
  };
}

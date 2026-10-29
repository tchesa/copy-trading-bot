import type { CostParams } from "../config/params.js";
import type { MintInfo } from "../data/mints.js";
import { buyTokens, simulateFollower, type FollowerResult } from "../research/follower.js";
import type { ReplRecord } from "../research/types.js";
import { entrySkipReason, type SkipReason } from "../strategy/filters.js";
import type { StrategyParams } from "../strategy/params.js";
import { hashSeed, rng } from "../util/rng.js";

export interface SimTrade extends FollowerResult {
  sig: string;
  wallet: string;
  mint: string;
  sizeSol: number;
  failed: boolean;
}

export interface SimResult {
  /** Hourly [t, equity] (SOL). */
  curve: Array<[number, number]>;
  trades: SimTrade[];
  skipped: Record<SkipReason | "capacity" | "dup" | "breaker" | "tooSmall" | "noFill", number>;
  initial: number;
  final: number;
}

interface Open {
  t: SimTrade;
  rec: ReplRecord;
  tokens: number;
  entryT: number;
  exitT: number;
}

const H = 3600;

/**
 * Event-driven portfolio over candidate leader buys (already restricted to followed wallets).
 * Entries happen in time order at t + delay; each trade's exit and PnL come from simulateFollower, so execution,
 * costs and attribution are identical to Phase A. Equity for sizing marks open positions on the stored price path.
 */
export function simulatePortfolio(
  recs: ReplRecord[], mints: Map<string, MintInfo>, p: StrategyParams, costs: CostParams, from: number, to: number, initial = 100,
): SimResult {
  const skipped: SimResult["skipped"] = { leaderSize: 0, liquidity: 0, noMintData: 0, age: 0, authority: 0, transferFee: 0, capacity: 0, dup: 0, breaker: 0, tooSmall: 0, noFill: 0 };
  const cand = recs
    .filter((r) => r.t >= from && r.t < to && r.fills[String(p.delay)])
    .map((r) => ({ r, entryT: p.delay === 0 ? r.t : r.fills[String(p.delay)]!.entry.t }))
    .sort((a, b) => a.entryT - b.entryT || (a.r.sig < b.r.sig ? -1 : 1));
  let cash = initial;
  const open: Open[] = [];
  const trades: SimTrade[] = [];
  const curve: Array<[number, number]> = [];
  let dayStart = Math.floor(from / 86_400) * 86_400;
  let dayStartEq = initial;
  let nextHour = Math.floor(from / H) * H + H;

  const markOpen = (t: number) =>
    open.reduce((a, o) => {
      const path = o.rec.path;
      let px: number | null = null;
      if (path) for (const [pt, pp] of path) { if (pt > t) break; if (pt >= o.entryT) px = pp; }
      return a + (px !== null ? o.tokens * px : o.t.sizeSol);
    }, 0);
  const settle = (t: number) => {
    for (let i = open.length - 1; i >= 0; i--) {
      const o = open[i]!;
      if (o.exitT <= t) {
        cash += o.t.sizeSol + o.t.pnlSol;
        open.splice(i, 1);
      }
    }
  };
  const advance = (t: number) => {
    while (nextHour <= t) {
      settle(nextHour);
      curve.push([nextHour, cash + markOpen(nextHour)]);
      nextHour += H;
    }
    settle(t);
  };

  for (const { r, entryT } of cand) {
    advance(entryT);
    const eq = cash + markOpen(entryT);
    const day = Math.floor(entryT / 86_400) * 86_400;
    if (day !== dayStart) {
      dayStart = day;
      dayStartEq = eq;
    }
    if (eq < dayStartEq * (1 - p.maxDailyLossPct)) { skipped.breaker++; continue; }
    const reason = entrySkipReason(r, mints.get(r.mint) ?? null, p);
    if (reason) { skipped[reason]++; continue; }
    if (open.some((o) => o.rec.mint === r.mint)) { skipped.dup++; continue; }
    if (open.length >= p.maxPositions) { skipped.capacity++; continue; }
    const f = r.fills[String(p.delay)]!;
    const q = (p.delay === 0 ? r.entryReserveSol : f.entry.reserveSol) ?? r.entryReserveSol ?? 0;
    let size = p.fixedSol > 0 ? p.fixedSol : p.positionPct * eq;
    size = Math.min(size, p.maxPctOfLiquidity * q, cash);
    if (size < 0.01) { skipped.tooSmall++; continue; }
    const failed = rng(hashSeed("fail", r.sig, p.delay))() < costs.failRate;
    const res = simulateFollower(r, { delay: p.delay, sizeSol: size, costs, maxHoldHours: p.maxHoldHours, failed, ...(p.stopLossPct > 0 ? { stopLossPct: p.stopLossPct } : {}), ...(p.trailPct > 0 ? { trailPct: p.trailPct } : {}) });
    if (!res.ok && !failed) { skipped.noFill++; continue; }
    const t: SimTrade = { ...res, sig: r.sig, wallet: r.wallet, mint: r.mint, sizeSol: failed ? 0 : size, failed };
    trades.push(t);
    if (failed) { cash += res.pnlSol; continue; }
    cash -= size;
    const entryPrice = p.delay === 0 ? r.leaderPoolPrice : f.entry.price!;
    open.push({ t, rec: r, tokens: buyTokens(size, entryPrice, q, 0, true), entryT: res.entryT, exitT: res.exitT });
  }
  const end = Math.max(to, ...open.map((o) => o.exitT));
  advance(end);
  settle(Infinity);
  curve.push([end + 1, cash]);
  return { curve, trades, skipped, initial, final: cash };
}

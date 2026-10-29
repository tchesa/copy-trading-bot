import type { CostParams } from "../config/params.js";
import type { MintInfo } from "../data/mints.js";
import type { StepResult } from "../research/pipeline.js";
import type { ReplRecord } from "../research/types.js";
import type { RankingId } from "../ranking/rank.js";
import type { StrategyParams } from "../strategy/params.js";
import { hashSeed, rng, sample } from "../util/rng.js";
import { mean, std } from "../util/stats.js";
import { computeMetrics, type Metrics } from "./metrics.js";
import { simulatePortfolio, type SimTrade } from "./sim.js";

export const DAY = 86_400;

export type Grid<P> = { [K in keyof P]?: Array<P[K]> };

/** Cartesian product of grid values over a base, with an optional validity predicate. */
export function expandGrid<P extends object>(base: P, grid: Grid<P>, valid: (p: P) => boolean = () => true): P[] {
  let out: P[] = [{ ...base }];
  for (const [k, vals] of Object.entries(grid) as Array<[keyof P, unknown[]]>) {
    if (!vals?.length) continue;
    out = out.flatMap((p) => vals.map((v) => ({ ...p, [k]: v })));
  }
  return out.filter(valid);
}

/** Objective for choosing params on the train period: APR − 0.5·maxDD. */
export function score(m: Metrics, ddPenalty = 0.5): number {
  return m.trades === 0 ? -Infinity : m.apr - ddPenalty * m.maxDrawdown;
}

export type Selector = (s: StepResult, n: number) => string[];

export const byMethod = (id: RankingId): Selector => (s, n) => s.rankings[id].slice(0, n);
export const randomWallets = (seed: number): Selector => (s, n) => sample(s.randomPool.filter((w) => s.records.some((r) => r.wallet === w && r.path)), n, rng(hashSeed("B1wf", seed, s.step)));

/** Leader buys of the wallets a selector follows in each step's replication week (probed records only: stops need a path). */
export function followedRecords(steps: StepResult[], sel: Selector, n: number): ReplRecord[] {
  return steps.flatMap((s) => {
    const ws = new Set(sel(s, n));
    return s.records.filter((r) => ws.has(r.wallet) && r.path);
  });
}

export interface WindowResult<P> {
  step: number;
  testFrom: number;
  testTo: number;
  params: P;
  train: Metrics;
  test: Metrics;
  testCurve: Array<[number, number]>;
  trades: SimTrade[];
}

export interface CombinedOos {
  windows: number;
  apr: number;
  maxDrawdown: number;
  sharpe: number;
  sortino: number;
  windowStd: number;
  positiveWindowShare: number;
  metrics: Metrics;
}

export interface WalkForwardOptions {
  steps: StepResult[];
  mints: Map<string, MintInfo>;
  costs: CostParams;
  combos: StrategyParams[];
  selector: Selector;
  trainSteps: number;
  stepDays: number;
  /** Fixed params per test step (skip tuning), e.g. to replay the strategy's choices for a baseline. */
  fixed?: Map<number, StrategyParams>;
}

function runPeriod(o: WalkForwardOptions, p: StrategyParams, stepIdx: number[]): { m: Metrics; curve: Array<[number, number]>; trades: SimTrade[] } {
  const ss = stepIdx.map((i) => o.steps[i]!);
  const recs = followedRecords(ss, o.selector, p.followN);
  const from = ss[0]!.F1;
  const to = ss[ss.length - 1]!.F1 + o.stepDays * DAY;
  const r = simulatePortfolio(recs, o.mints, p, o.costs, from, to, 100);
  const curve = r.curve.map(([t, e]) => [t, e / r.initial] as [number, number]);
  return { m: computeMetrics([[from, 1], ...curve], r.trades, r.initial), curve, trades: r.trades };
}

/**
 * Walk-forward over weekly steps: for each test step, choose params on the preceding `trainSteps` weeks by
 * APR − 0.5·maxDD, then run them on the test week. Reported numbers chain test windows only.
 */
export function runWalkForward(o: WalkForwardOptions): { results: WindowResult<StrategyParams>[]; oos: CombinedOos } {
  const results: WindowResult<StrategyParams>[] = [];
  for (let i = o.trainSteps; i < o.steps.length; i++) {
    const trainIdx = Array.from({ length: o.trainSteps }, (_, k) => i - o.trainSteps + k);
    let best = o.fixed?.get(o.steps[i]!.step);
    let bestTrain: Metrics | null = null;
    if (!best) {
      let bestScore = -Infinity;
      for (const c of o.combos) {
        const { m } = runPeriod(o, c, trainIdx);
        const s = score(m);
        if (s > bestScore || !best) {
          bestScore = s;
          best = c;
          bestTrain = m;
        }
      }
    }
    bestTrain ??= runPeriod(o, best!, trainIdx).m;
    const test = runPeriod(o, best!, [i]);
    const s = o.steps[i]!;
    results.push({ step: s.step, testFrom: s.F1, testTo: s.F1 + o.stepDays * DAY, params: best!, train: bestTrain, test: test.m, testCurve: test.curve, trades: test.trades });
  }
  return { results, oos: combine(results) };
}

/** Chain normalized test curves into one OOS equity path. */
export function combine(results: WindowResult<StrategyParams>[]): CombinedOos {
  const curve: Array<[number, number]> = [];
  let level = 1;
  let tOff = 0;
  for (const r of results) {
    let lastT = 0;
    for (const [t, e] of r.testCurve) {
      lastT = t - r.testFrom;
      curve.push([tOff + lastT, level * e]);
    }
    level *= r.testCurve.length ? r.testCurve[r.testCurve.length - 1]![1] : 1;
    tOff += Math.max(lastT, 1);
  }
  const hourly: Array<[number, number]> = [[0, 1]];
  let i = 0;
  for (let t = 3600; t <= tOff; t += 3600) {
    while (i + 1 < curve.length && curve[i + 1]![0] <= t) i++;
    hourly.push([t, curve[i]?.[1] ?? 1]);
  }
  const trades = results.flatMap((r) => r.trades);
  const m = computeMetrics(hourly, trades, 100);
  const wr = results.map((r) => r.test.totalReturn);
  return {
    windows: results.length,
    apr: m.apr,
    maxDrawdown: m.maxDrawdown,
    sharpe: m.sharpe,
    sortino: m.sortino,
    windowStd: std(wr),
    positiveWindowShare: results.length ? wr.filter((x) => x > 0).length / results.length : 0,
    metrics: { ...m, medianTradeRet: m.medianTradeRet, meanTradeRet: mean(trades.filter((t) => !t.failed).map((t) => t.ret)) },
  };
}

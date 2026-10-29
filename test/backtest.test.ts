import { describe, expect, it } from "vitest";
import { defaultCosts } from "../src/config/params.js";
import { simulatePortfolio } from "../src/backtest/sim.js";
import { byMethod, expandGrid, runWalkForward } from "../src/backtest/walkforward.js";
import type { StepResult } from "../src/research/pipeline.js";
import { strategySchema } from "../src/strategy/params.js";
import { T0, record } from "./helpers.js";

const zero = { ...defaultCosts(), venueFeePct: { other: 0, pumpswap: 0 }, baseFeeSol: 0, priorityFeeSol: 0, contestedPriorityFeeSol: 0, jitoTipSol: 0, failRate: 0 };
const p = strategySchema.parse({ requireRevoked: false, maxTransferFeeBps: 10_000, minEntryLiquiditySol: 0, minLeaderBuySol: 0, positionPct: 0.1, maxPctOfLiquidity: 1 });
const W = 7 * 86_400;

function rec(i: number, t: number, mult: number) {
  const r = record({ sig: `s${i}`, mint: `M${i}`, t, path: [] });
  r.sells = [{ t: t + 3600, frac: 1, price: 0.001 * mult, poolPrice: 0.001 * mult }];
  r.timeStopT = t + 48 * 3600;
  r.fills["5"] = { entry: { t: t + 5, price: 0.001, reserveSol: 1e6, rug: false }, exits: [{ t: t + 3605, price: 0.001 * mult, reserveSol: 1e6, rug: false }], timeStop: { t: t + 48 * 3600, price: 0.001, reserveSol: 1e6, rug: false } };
  return r;
}

describe("portfolio sim", () => {
  it("sizes from equity, settles at exit, and respects max positions and one position per token", () => {
    const recs = [rec(1, T0, 2), rec(2, T0 + 10, 2), { ...rec(3, T0 + 20, 2), mint: "M1" }];
    const r = simulatePortfolio(recs, new Map(), { ...p, maxPositions: 1 }, zero, T0, T0 + W);
    expect(r.trades).toHaveLength(1);
    expect(r.skipped.capacity + r.skipped.dup).toBe(2);
    expect(r.final).toBeCloseTo(100 + 10 * 1, 1); // 10 SOL doubled, minus negligible impact
  });

  it("failed transactions pay the fee and get no fill", () => {
    const r = simulatePortfolio([rec(1, T0, 2)], new Map(), p, { ...zero, failRate: 1, baseFeeSol: 0.01 }, T0, T0 + W);
    expect(r.trades[0]!.failed).toBe(true);
    expect(r.final).toBeCloseTo(99.99, 6);
  });
});

describe("walk-forward", () => {
  it("chooses params on train weeks and chains test weeks only", () => {
    const steps: StepResult[] = Array.from({ length: 4 }, (_, s) => ({
      step: s, F0: T0 + s * W - 30 * 86_400, F1: T0 + s * W,
      rankings: { S1: ["W"], S2: ["W"], S3: ["W"], S4: ["W"] }, randomPool: ["W"], eligibleWallets: ["W"],
      records: [rec(s * 10, T0 + s * W + 100, s % 2 ? 1.5 : 1.2)],
    }) as unknown as StepResult);
    const combos = expandGrid(p, { followN: [1, 3] });
    expect(combos).toHaveLength(2);
    const { results, oos } = runWalkForward({ steps, mints: new Map(), costs: zero, combos, selector: byMethod("S2"), trainSteps: 2, stepDays: 7 });
    expect(results.map((r) => r.step)).toEqual([2, 3]);
    expect(oos.windows).toBe(2);
    expect(oos.positiveWindowShare).toBe(1);
    expect(oos.metrics.trades).toBe(2);
  });
});

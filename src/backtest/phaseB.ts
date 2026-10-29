import type { CostParams, StudyParams } from "../config/params.js";
import { loadMint, type MintInfo } from "../data/mints.js";
import type { DatabaseSync } from "node:sqlite";
import type { StepResult } from "../research/pipeline.js";
import type { RankingId } from "../ranking/rank.js";
import { strategySchema, type StrategyParams } from "../strategy/params.js";
import { byMethod, expandGrid, runWalkForward, type Grid, type Selector } from "./walkforward.js";

export const DEFAULT_GRID: Grid<StrategyParams> = {
  followN: [1, 3, 5],
  stopLossPct: [0, 0.5],
  trailPct: [0, 0.4],
  maxHoldHours: [12, 48],
  minEntryLiquiditySol: [20, 50],
  minTokenAgeMinutes: [0, 60],
  minLeaderBuySol: [0.1, 1],
};

export const QUICK_GRID: Grid<StrategyParams> = { followN: [1, 3, 5], stopLossPct: [0, 0.5], maxHoldHours: [12, 48] };

export async function loadMints(db: DatabaseSync, steps: StepResult[]): Promise<Map<string, MintInfo>> {
  const out = new Map<string, MintInfo>();
  for (const m of new Set(steps.flatMap((s) => s.records.map((r) => r.mint)))) {
    const info = await loadMint(db, null, m);
    if (info) out.set(m, info);
  }
  return out;
}

export function combosFor(base: Partial<StrategyParams>, grid: Grid<StrategyParams>, delay: number, maxHoldHours: number): StrategyParams[] {
  const b = strategySchema.parse({ ...base, delay });
  return expandGrid(b, grid, (p) => p.maxHoldHours <= maxHoldHours);
}

export interface PhaseBRun {
  method: RankingId;
  delay: number;
  wf: ReturnType<typeof runWalkForward>;
}

export function runMethod(
  steps: StepResult[], mints: Map<string, MintInfo>, costs: CostParams, sp: StudyParams, method: RankingId, delay: number,
  base: Partial<StrategyParams>, grid: Grid<StrategyParams>, trainSteps: number, selector: Selector = byMethod(method),
): PhaseBRun {
  const combos = combosFor(base, grid, delay, sp.maxHoldHours);
  const wf = runWalkForward({ steps, mints, costs, combos, selector, trainSteps, stepDays: sp.stepDays });
  return { method, delay, wf };
}

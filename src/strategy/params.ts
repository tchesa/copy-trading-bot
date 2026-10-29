import { z } from "zod";
import type { RankingId } from "../ranking/rank.js";

export const strategySchema = z.object({
  followN: z.number().int().positive().default(3),
  delay: z.number().nonnegative().default(5),
  /** 0 = off. */
  stopLossPct: z.number().min(0).max(1).default(0),
  /** 0 = off. */
  trailPct: z.number().min(0).max(1).default(0),
  maxHoldHours: z.number().positive().default(48),
  positionPct: z.number().positive().default(0.02),
  /** If > 0, a fixed SOL size instead of positionPct. */
  fixedSol: z.number().nonnegative().default(0),
  maxPctOfLiquidity: z.number().positive().default(0.01),
  maxPositions: z.number().int().positive().default(10),
  maxDailyLossPct: z.number().positive().default(0.1),
  minTokenAgeMinutes: z.number().nonnegative().default(0),
  minEntryLiquiditySol: z.number().nonnegative().default(20),
  requireRevoked: z.boolean().default(true),
  maxTransferFeeBps: z.number().nonnegative().default(0),
  minLeaderBuySol: z.number().nonnegative().default(0.1),
});
export type StrategyParams = z.infer<typeof strategySchema>;
export const defaultStrategy = (): StrategyParams => strategySchema.parse({});

export interface Selection {
  method: RankingId | "random";
  seed?: number;
}

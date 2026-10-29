import { z } from "zod";
import type { Venue } from "../data/programs.js";

/** Phase A study and data collection parameters. */
export const studySchema = z.object({
  formationDays: z.number().int().positive().default(30),
  evalDays: z.array(z.number().int().positive()).default([7, 14]),
  stepDays: z.number().int().positive().default(7),
  samplesPerVenueDay: z.number().int().positive().default(12),
  /** Estimated SOL volume over the formation window for a token to qualify (R-W1). */
  minTokenVolumeSol: z.number().nonnegative().default(500),
  minSampledTrades: z.number().int().positive().default(2),
  /** Wallets screened (10 credits each) and wallets whose history is fetched, per window (R-W2). */
  screenCap: z.number().int().positive().default(3000),
  candidateCap: z.number().int().positive().default(400),
  /** Wallets with at least this many txs in the formation window (from the 10-credit screen) are skipped: budget cap. */
  maxFormationTx: z.number().int().positive().default(1000),
  maxHistoryTx: z.number().int().positive().default(1000),
  delays: z.array(z.number().nonnegative()).default([0, 1, 5, 15, 30, 60, 300]),
  topN: z.number().int().positive().default(10),
  /** Top wallets per method that get price-path probes (Phase B candidates). */
  probeTopN: z.number().int().positive().default(5),
  /** Random eligible wallets replicated per step (B1 control pool). */
  randomPool: z.number().int().nonnegative().default(15),
  maxBuysRanked: z.number().int().positive().default(8),
  maxBuysRandom: z.number().int().positive().default(5),
  probeOffsets: z.array(z.number().positive()).default([3600, 4 * 3600, 12 * 3600]),
  followerSizeSol: z.number().positive().default(1),
  maxHoldHours: z.number().positive().default(48),
  minExitLiquiditySol: z.number().nonnegative().default(2),
  crowdBuys: z.number().int().nonnegative().default(6),
  crowdSells: z.number().int().nonnegative().default(6),
  seeds: z.number().int().positive().default(20),
});
export type StudyParams = z.infer<typeof studySchema>;
export const defaultStudy = (): StudyParams => studySchema.parse({});

/**
 * Execution costs. Venue fees are approximate all-in swap fees (verify per venue; several are dynamic).
 * Network: base + priority fee per tx, plus a Jito tip and higher priority on contested (hot) entries.
 */
export const costSchema = z.object({
  venueFeePct: z.record(z.string(), z.number()).default({
    pumpfun: 0.0125, pumpswap: 0.003, raydium_amm: 0.0025, raydium_cpmm: 0.0025, raydium_clmm: 0.0025,
    launchlab: 0.01, meteora_dlmm: 0.003, meteora_damm1: 0.0025, meteora_damm2: 0.0025, meteora_dbc: 0.01,
    orca: 0.003, other: 0.005,
  }),
  baseFeeSol: z.number().default(0.000005),
  priorityFeeSol: z.number().default(0.0001),
  contestedPriorityFeeSol: z.number().default(0.001),
  jitoTipSol: z.number().default(0.0005),
  /** Distinct buyers in the 30s after the leader's buy at or above which the entry is contested. */
  contestedBuyers30: z.number().default(5),
  /** Probability a tx fails: the fee is paid, no fill. */
  failRate: z.number().min(0).max(1).default(0.05),
});
export type CostParams = z.infer<typeof costSchema>;
export const defaultCosts = (): CostParams => costSchema.parse({});

export function venueFee(c: CostParams, v: Venue): number {
  return c.venueFeePct[v] ?? c.venueFeePct.other ?? 0.005;
}

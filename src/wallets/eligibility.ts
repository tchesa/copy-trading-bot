import { z } from "zod";
import type { WalletMetrics } from "./metrics.js";

export const eligibilitySchema = z.object({
  /** Spec start value is 40; 20 is used because only ~1.5% of budget-capped candidates reach 40 (see report). */
  minClosedPositions: z.number().int().nonnegative().default(20),
  activeLastDays: z.number().positive().default(7),
  maxPnlConcentration: z.number().positive().default(0.3),
  minMedianHoldMinutes: z.number().nonnegative().default(10),
  /** Median pool quote reserve (SOL) at the wallet's entries, so a follower can size in. */
  minEntryLiquiditySol: z.number().nonnegative().default(20),
});
export type EligibilityParams = z.infer<typeof eligibilitySchema>;
export const defaultEligibility = (): EligibilityParams => eligibilitySchema.parse({});

export type IneligibleReason = "closed" | "inactive" | "concentration" | "hold" | "liquidity";

/** §4.3 filters, formation-window data only. */
export function ineligibleReasons(m: WalletMetrics, formationEnd: number, p: EligibilityParams): IneligibleReason[] {
  const out: IneligibleReason[] = [];
  if (m.closed < p.minClosedPositions) out.push("closed");
  if (m.lastActivity < formationEnd - p.activeLastDays * 86_400) out.push("inactive");
  if (m.maxPnlConcentration > p.maxPnlConcentration) out.push("concentration");
  if (m.medianHoldMinutes < p.minMedianHoldMinutes) out.push("hold");
  if (m.medianEntryLiquiditySol < p.minEntryLiquiditySol) out.push("liquidity");
  return out;
}

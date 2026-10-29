import { tokenStateAt, type MintInfo } from "../data/mints.js";
import type { ReplRecord } from "../research/types.js";
import type { StrategyParams } from "./params.js";

export type SkipReason = "leaderSize" | "liquidity" | "noMintData" | "age" | "authority" | "transferFee";

/**
 * §6.1 entry filters. Every input is as of the leader's buy (before the follower acts at t + delay): the leader's
 * own size, the pool reserve right after the leader's tx, and token state replayed to that time (R-I3).
 */
export function entrySkipReason(r: ReplRecord, mint: MintInfo | null, p: StrategyParams): SkipReason | null {
  if (r.leaderSol < p.minLeaderBuySol) return "leaderSize";
  if ((r.entryReserveSol ?? 0) < p.minEntryLiquiditySol) return "liquidity";
  const needsMint = p.minTokenAgeMinutes > 0 || p.requireRevoked || p.maxTransferFeeBps < 10_000;
  if (!needsMint) return null;
  if (!mint) return "noMintData";
  const s = tokenStateAt(mint, r.t);
  if (p.minTokenAgeMinutes > 0 && (s.ageSeconds === null || s.ageSeconds < p.minTokenAgeMinutes * 60)) return "age";
  if (p.requireRevoked && (!s.mintRevoked || !s.freezeRevoked)) return "authority";
  if (s.transferFeeBps > p.maxTransferFeeBps) return "transferFee";
  return null;
}

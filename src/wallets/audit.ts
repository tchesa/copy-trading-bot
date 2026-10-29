import { logger } from "../log.js";
import type { Position, Trade } from "./types.js";

const log = logger("audit");

/** A single position returning more than this multiple of its cost is logged for inspection. */
export const MAX_PLAUSIBLE_RET = 100;

export interface PositionOutlier {
  phase: string;
  wallet: string;
  mint: string;
  pool: string | null;
  ret: number;
  costSol: number;
  proceedsSol: number;
  markSol: number;
  trades: Array<{
    sig: string; t: number; side: Trade["side"]; tokens: number; sol: number; price: number | null; repaired: boolean;
    raw: Trade["raw"];
  }>;
}

/** Log (and return) every position whose return exceeds MAX_PLAUSIBLE_RET, with mint and raw stored amounts. */
export function auditPositions(phase: string, positions: Position[]): PositionOutlier[] {
  const out: PositionOutlier[] = [];
  for (const p of positions) {
    if (p.tainted || !(p.ret > MAX_PLAUSIBLE_RET)) continue; // tainted positions are already excluded from metrics
    const o: PositionOutlier = {
      phase, wallet: p.wallet, mint: p.mint, pool: p.pool, ret: p.ret, costSol: p.costSol, proceedsSol: p.proceedsSol, markSol: p.markSol,
      trades: [...p.buys, ...p.sells].sort((a, b) => a.t - b.t).map((t) => ({
        sig: t.sig, t: t.t, side: t.side, tokens: t.tokens, sol: t.sol, price: t.price, repaired: !!t.quoteRepaired, raw: t.raw,
      })),
    };
    log.warn("implausible position return", {
      phase, wallet: p.wallet, mint: p.mint, ret: Math.round(p.ret), costSol: p.costSol, proceedsSol: p.proceedsSol, markSol: p.markSol,
      trades: o.trades.slice(0, 6).map((t) => `${t.side} ${t.tokens} tok ${t.sol} SOL (raw ${t.raw?.quoteAmount} ${t.raw?.quoteMint?.slice(0, 4)}, pool ${t.raw?.poolPrice})`),
    });
    out.push(o);
  }
  return out;
}

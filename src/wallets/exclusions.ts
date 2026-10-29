import type { Position, Trade } from "./types.js";

export type ExclusionReason = "mev" | "hft" | "arb" | "creator";

export interface ExclusionParams {
  maxTradesPerDay: number;
  /** Share of a wallet's swaps that sit in multi-swap txs or round-trip within 1 slot. */
  maxMevShare: number;
  /** Arb/MM: median hold below this many seconds with balanced two-way flow. */
  arbMaxMedianHoldSeconds: number;
}

export const defaultExclusions: ExclusionParams = { maxTradesPerDay: 200, maxMevShare: 0.2, arbMaxMedianHoldSeconds: 60 };

/** Reasons a wallet is not a human-style trader (§4.2). Reads only the trades passed in. */
export function exclusionReasons(trades: Trade[], positions: Position[], from: number, to: number, p: ExclusionParams): ExclusionReason[] {
  const out: ExclusionReason[] = [];
  const swaps = trades.filter((t) => (t.side === "buy" || t.side === "sell") && t.t >= from && t.t < to);
  if (swaps.length === 0) return out;

  // MEV/sandwich: multi-swap txs, or buy and sell of the same token in the same or adjacent slot.
  let mev = 0;
  const lastBuySlot = new Map<string, number>();
  for (const s of swaps) {
    let flag = s.txSwapCount > 1;
    if (s.side === "buy") lastBuySlot.set(s.mint, s.slot);
    else {
      const b = lastBuySlot.get(s.mint);
      if (b !== undefined && s.slot - b <= 1) flag = true;
    }
    if (flag) mev++;
  }
  if (mev / swaps.length > p.maxMevShare) out.push("mev");

  if (swaps.length / ((to - from) / 86_400) > p.maxTradesPerDay) out.push("hft");

  // Arbitrage / market making: tiny holds with balanced two-way SOL flow.
  const holds = positions.filter((x) => x.closeT !== null).map((x) => x.holdSeconds).sort((a, b) => a - b);
  const medHold = holds.length ? holds[Math.floor(holds.length / 2)]! : Infinity;
  const bought = swaps.filter((s) => s.side === "buy").reduce((a, s) => a + s.sol, 0);
  const sold = swaps.filter((s) => s.side === "sell").reduce((a, s) => a + s.sol, 0);
  const balanced = bought > 0 && Math.abs(bought - sold) / bought < 0.05;
  if (medHold < p.arbMaxMedianHoldSeconds && balanced) out.push("arb");

  if (swaps.some((s) => s.createsMint)) out.push("creator");
  return out;
}

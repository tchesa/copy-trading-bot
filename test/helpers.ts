import type { ReplRecord } from "../src/research/types.js";
import type { Trade } from "../src/wallets/types.js";

export const T0 = Date.UTC(2026, 3, 1) / 1000;
let n = 0;

export function trade(over: Partial<Trade> & Pick<Trade, "side" | "t">): Trade {
  n++;
  const tokens = over.tokens ?? 1000;
  const sol = over.sol ?? 1;
  // default market price = the trade's own price (0.001 for the default 1 SOL / 1000 tokens)
  const price = over.side === "in" || over.side === "out" ? null : sol > 0 && tokens > 0 ? sol / tokens : null;
  return {
    sig: `sig${n}`, slot: over.t, txIndex: 0, wallet: "W", mint: "M", tokens, sol, price, pool: "P", venue: "pumpswap",
    poolQuoteReserveSol: 100, feeSol: 0.00001, txSwapCount: 1, createsMint: false, ...over,
  };
}

/** A replication record with a flat tape at `price` unless overridden. */
export function record(over: Partial<ReplRecord> = {}): ReplRecord {
  const fill = (t: number, price: number | null, rug = false) => ({ t, price, reserveSol: 1000, rug });
  return {
    step: 0, wallet: "W", group: "ranked", ranks: { S2: 1 }, sig: "s", t: T0, mint: "M", pool: "P", venue: "pumpswap",
    leaderSol: 1, leaderTokens: 1000, leaderPoolPrice: 0.001, entryReserveSol: 1000, buyers30: 0,
    sells: [{ t: T0 + 3600, frac: 1, price: 0.002, poolPrice: 0.002 }],
    timeStopT: T0 + 48 * 3600,
    fills: {
      "0": { entry: fill(T0, 0.001), exits: [fill(T0 + 3600, 0.002)], timeStop: fill(T0 + 48 * 3600, 0.002) },
      "5": { entry: fill(T0 + 5, 0.0012), exits: [fill(T0 + 3605, 0.0019)], timeStop: fill(T0 + 48 * 3600, 0.002) },
    },
    path: null,
    ...over,
  };
}

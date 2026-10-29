import type { DatabaseSync } from "node:sqlite";
import { venueFee, type CostParams, type StudyParams } from "../config/params.js";
import type { Oracle } from "../data/oracle.js";
import type { Venue } from "../data/programs.js";
import type { SimTrade } from "../backtest/sim.js";
import { sellSol, buyTokens } from "../research/follower.js";
import { fillAt } from "../research/replicate.js";
import { hashSeed, rng } from "../util/rng.js";

export interface B2Trade {
  sig: string;
  mint: string | null;
  pnlSol: number;
  ret: number;
  rug: boolean;
}

/**
 * B2: same entry and exit times and sizes as the strategy's trades, but a random token from the discovery sample
 * traded within ±15 minutes of the entry, with entry liquidity within 0.5×–2× of the strategy's token.
 */
export async function runB2(
  db: DatabaseSync, oracle: Oracle, trades: Array<SimTrade & { entryReserveSol: number | null }>, seed: number, p: StudyParams, costs: CostParams,
): Promise<B2Trade[]> {
  const q = db.prepare(
    `SELECT s.mint, s.pool, s.venue, s.pool_quote_reserve q, s.pool_quote_mint qm FROM discovery d JOIN swaps s ON s.sig = d.sig AND s.wallet = d.wallet AND s.mint = d.mint
     WHERE d.block_time >= ? AND d.block_time < ? AND s.pool IS NOT NULL AND s.pool_quote_mint = 'So11111111111111111111111111111111111111112'`,
  );
  const out: B2Trade[] = [];
  for (const t of trades.filter((x) => !x.failed)) {
    const rand = rng(hashSeed("B2", seed, t.sig));
    const ref = t.entryReserveSol ?? 0;
    const cands = (q.all(t.entryT - 900, t.entryT + 900) as Array<{ mint: string; pool: string; venue: string; q: number | null }>)
      .filter((c) => c.mint !== t.mint && c.q !== null && c.q >= ref * 0.5 && c.q <= ref * 2);
    if (cands.length === 0) {
      out.push({ sig: t.sig, mint: null, pnlSol: 0, ret: 0, rug: false });
      continue;
    }
    const c = cands[Math.floor(rand() * cands.length)]!;
    const entry = await fillAt(oracle, c.pool, t.entryT, p.minExitLiquiditySol, false);
    const exit = await fillAt(oracle, c.pool, t.exitT, p.minExitLiquiditySol, true);
    const fee = venueFee(costs, c.venue as Venue);
    const net = 2 * (costs.baseFeeSol + costs.priorityFeeSol);
    if (entry.price === null) {
      out.push({ sig: t.sig, mint: c.mint, pnlSol: 0, ret: 0, rug: false });
      continue;
    }
    const tokens = buyTokens(t.sizeSol, entry.price, entry.reserveSol, fee, true);
    const proceeds = exit.rug || exit.price === null ? 0 : sellSol(tokens, exit.price, exit.reserveSol, fee, true);
    const pnl = proceeds - t.sizeSol - net;
    out.push({ sig: t.sig, mint: c.mint, pnlSol: pnl, ret: pnl / t.sizeSol, rug: exit.rug });
  }
  return out;
}

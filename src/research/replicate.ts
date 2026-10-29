import type { StudyParams } from "../config/params.js";
import type { Oracle, TapeRow } from "../data/oracle.js";
import { distinctBuyersAfter } from "../wallets/crowding.js";
import type { Position, Trade } from "../wallets/types.js";
import type { Fill, LeaderSell, ReplRecord } from "./types.js";
import type { RankingId } from "../ranking/rank.js";

/** Fill for an action at time t: first trade at or after t, liquidity at that point, rug checks (R-A6). */
export async function fillAt(oracle: Oracle, pool: string, t: number, minExitLiquiditySol: number, checkRug: boolean): Promise<Fill> {
  // One page usually covers the next 30s on a live pool; widen only if nothing traded (quiet or dead pool).
  let { rows, complete } = await oracle.tradesFrom(pool, t, 30);
  if (!rows.some((r) => r.poolPriced)) ({ rows, complete } = await oracle.tradesFrom(pool, t, 3600));
  // The fill is the first trade priced by the pool's own flows (a trader's own quote can be incomplete).
  const first: TapeRow | undefined = rows.find((r) => r.poolPriced);
  // No trade for an hour on a fully read tape is a dead pool; an unread tape is unknown.
  if (!first) return complete ? { t, price: null, reserveSol: null, rug: true } : { t, price: null, reserveSol: null, rug: false, missing: true };
  const state = await oracle.stateAt(pool, first.blockTime);
  const reserveSol = state?.quoteReserveSol ?? first.poolQuoteReserveSol;
  let rug = false;
  if (checkRug) {
    if (reserveSol !== null && reserveSol < minExitLiquiditySol) rug = true;
    const window = rows.slice(0, 100);
    if (window.length >= 5 && window.every((r) => r.side === "buy")) rug = true; // nobody can sell
  }
  return { t: first.blockTime, price: first.price, reserveSol, rug };
}

/**
 * Leader sell schedule after `buy` within the position: each sell as a fraction of the holding just before it.
 * Later buys in the same position add to the holding (so fractions stay proportional).
 */
export function sellSchedule(pos: Position, buy: Trade, until: number): LeaderSell[] {
  const events = [...pos.buys, ...pos.sells, ...(pos.outs ?? [])].sort((a, b) => a.t - b.t || a.txIndex - b.txIndex);
  let holding = 0;
  let peak = 0;
  const out: LeaderSell[] = [];
  let started = false;
  let lastPrice = buy.sol / buy.tokens;
  for (const e of events) {
    if (e.side !== "out" && e.tokens > 0 && e.sol > 0) lastPrice = e.sol / e.tokens;
    if (e === buy) started = true;
    if (e.side === "buy") {
      holding += e.tokens;
      peak = Math.max(peak, holding);
      continue;
    }
    const sold = Math.min(e.tokens, holding);
    const after = holding - sold;
    if (started && e.t <= until && holding > 0 && sold > 0) {
      // Selling down to dust counts as a full exit (matches position closing in positions.ts).
      const frac = after <= peak * 0.01 ? 1 : sold / holding;
      if (e.side === "out") out.push({ t: e.t, frac, price: lastPrice, poolPrice: null, kind: "out" });
      else out.push({ t: e.t, frac, price: e.sol / e.tokens, poolPrice: e.price });
    }
    holding = Math.max(0, after);
  }
  return out;
}

export async function replicateBuy(
  oracle: Oracle, p: StudyParams, step: number, group: "ranked" | "random", ranks: Partial<Record<RankingId, number>>,
  pos: Position, buy: Trade, probe: boolean,
): Promise<ReplRecord | null> {
  if (!buy.pool || buy.price === null) return null;
  const pool = buy.pool;
  const timeStopT = buy.t + p.maxHoldHours * 3600;
  const sells = sellSchedule(pos, buy, timeStopT);
  const { rows } = await oracle.tradesFrom(pool, buy.t, 61);
  const buyers30 = distinctBuyersAfter(rows, buy.wallet, buy.sig, buy.t, 30);

  const timeStop = await fillAt(oracle, pool, timeStopT, p.minExitLiquiditySol, true);
  const fills: ReplRecord["fills"] = {};
  for (const d of p.delays) {
    const entry = d === 0
      ? { t: buy.t, price: buy.price, reserveSol: buy.poolQuoteReserveSol, rug: false }
      : await fillAt(oracle, pool, buy.t + d, p.minExitLiquiditySol, false);
    const exits: Fill[] = [];
    for (const s of sells) exits.push(await fillAt(oracle, pool, s.t + d, p.minExitLiquiditySol, true));
    fills[String(d)] = { entry, exits, timeStop };
  }

  let path: ReplRecord["path"] = null;
  if (probe) {
    for (const off of p.probeOffsets) if (buy.t + off < timeStopT) await oracle.tradesFrom(pool, buy.t + off, 60);
    path = oracle.storedPath(pool, buy.t, timeStopT);
  }
  return {
    step, wallet: buy.wallet, group, ranks, sig: buy.sig, t: buy.t, mint: buy.mint, pool, venue: buy.venue,
    leaderSol: buy.sol, leaderTokens: buy.tokens, leaderPoolPrice: buy.price, entryReserveSol: buy.poolQuoteReserveSol,
    buyers30, sells, timeStopT, fills, path,
  };
}

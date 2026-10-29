import { venueFee, type CostParams } from "../config/params.js";
import type { Fill, ReplRecord } from "./types.js";

export interface FollowerOptions {
  delay: number;
  sizeSol: number;
  costs: CostParams;
  /** Phase B exits (fractions, e.g. 0.5 = -50%); undefined = mirror leader + time stop only. */
  stopLossPct?: number;
  trailPct?: number;
  /** Must be <= the record's horizon. */
  maxHoldHours?: number;
  /** Treat the entry tx as failed (fee paid, no fill). */
  failed?: boolean;
}

export interface FollowerResult {
  ok: boolean;
  entryT: number;
  exitT: number;
  /** Net return on sizeSol. */
  ret: number;
  pnlSol: number;
  rug: boolean;
  /** Attribution (sums to ret): leader alpha, delay cost, slippage, fees, rug losses. */
  alpha: number;
  delayCost: number;
  slippage: number;
  fees: number;
  rugLoss: number;
  leaderRet: number;
  contested: boolean;
  /** Excluded because part of the tape could not be read. */
  missing?: boolean;
}

/** Constant-product tokens out for spending `sol` (fee taken first) at mid `price` with quote reserve `Q`. */
export function buyTokens(sol: number, price: number, Q: number | null, fee: number, impact: boolean): number {
  const s = sol * (1 - fee);
  const imp = impact && Q && Q > 0 ? 1 + s / Q : 1;
  return s / (price * imp);
}

/** SOL out for selling `tokens` at mid `price` with quote reserve `Q`. */
export function sellSol(tokens: number, price: number, Q: number | null, fee: number, impact: boolean): number {
  const v = tokens * price;
  const imp = impact && Q && Q > 0 ? 1 + v / Q : 1;
  return (v / imp) * (1 - fee);
}

interface Leg {
  t: number;
  frac: number;
  fill: Fill;
  /** Leader's own price for this leg (zero-delay alpha). */
  leaderPrice: number | null;
}

/**
 * Simulate a follower of one leader buy. Entries and exits use the stored tape fills for the chosen delay;
 * delay 0 uses the leader's own pool prices (B5 upper bound).
 */
export function simulateFollower(r: ReplRecord, o: FollowerOptions): FollowerResult {
  const fee = venueFee(o.costs, r.venue);
  const contested = r.buyers30 >= o.costs.contestedBuyers30;
  const txCost = o.costs.baseFeeSol + (contested ? o.costs.contestedPriorityFeeSol + o.costs.jitoTipSol : o.costs.priorityFeeSol);
  const exitTxCost = o.costs.baseFeeSol + o.costs.priorityFeeSol;
  const f = r.fills[String(o.delay)];
  const leaderRet = leaderReturn(r);
  const fail = (entryT: number): FollowerResult => ({
    ok: false, entryT, exitT: entryT, ret: -txCost / o.sizeSol, pnlSol: -txCost, rug: false, alpha: 0, delayCost: 0, slippage: 0,
    fees: -txCost / o.sizeSol, rugLoss: 0, leaderRet, contested,
  });
  if (!f) throw new Error(`no fills for delay ${o.delay}`);
  const entryPrice = o.delay === 0 ? r.leaderPoolPrice : f.entry.price;
  const entryT = o.delay === 0 ? r.t : f.entry.t;
  if (o.failed) return fail(entryT);
  if (entryPrice === null || f.entry.rug && f.entry.price === null || (o.delay !== 0 && f.entry.missing)) {
    return { ...fail(entryT), ok: false, ret: 0, pnlSol: 0, fees: 0, missing: !!f.entry.missing };
  }
  const Qe = f.entry.reserveSol ?? r.entryReserveSol;

  // Exit legs: mirrored leader sells within the hold window, then the time stop.
  const horizon = r.t + (o.maxHoldHours ?? Infinity) * 3600;
  const legs: Leg[] = [];
  let remaining = 1;
  for (let i = 0; i < r.sells.length && remaining > 1e-9; i++) {
    const s = r.sells[i]!;
    if (s.t > horizon) break;
    // Delay 0 sells at the leader's own pool price; a transfer out has no leader price, so even at delay 0 the
    // copier exits on the tape (first trade at/after the transfer).
    const fill: Fill | undefined = o.delay === 0 && s.kind !== "out"
      ? { t: s.t, price: s.poolPrice ?? s.price, reserveSol: f.exits[i]?.reserveSol ?? null, rug: false }
      : f.exits[i];
    if (!fill) break;
    const frac = remaining * s.frac;
    const zero = s.kind === "out" ? r.fills["0"]?.exits[i] : undefined;
    legs.push({ t: fill.t, frac, fill, leaderPrice: s.kind === "out" ? (zero && !zero.rug ? zero.price : null) : s.poolPrice ?? s.price });
    remaining -= frac;
  }
  let stopT = Math.min(r.timeStopT, horizon);
  if (remaining > 1e-9) {
    let fill = f.timeStop;
    if (horizon < r.timeStopT && r.path) {
      // earlier time stop from the path
      const pt = r.path.find(([t]) => t >= horizon);
      fill = pt ? { t: pt[0], price: pt[1], reserveSol: pt[2], rug: false } : f.timeStop;
    }
    legs.push({ t: stopT, frac: remaining, fill: fill ?? { t: stopT, price: null, reserveSol: null, rug: true }, leaderPrice: fill?.price ?? null });
  }

  // Phase B stops: walk the sparse path; the first breach exits everything left at that point.
  if ((o.stopLossPct !== undefined || o.trailPct !== undefined) && r.path) {
    let peak = entryPrice;
    let left = 1;
    const kept: Leg[] = [];
    let li = 0;
    for (const [t, p, q] of r.path) {
      if (t <= entryT) continue;
      while (li < legs.length && legs[li]!.t <= t) {
        kept.push(legs[li]!);
        left -= legs[li]!.frac;
        li++;
      }
      if (left <= 1e-9 || t > stopT) break;
      peak = Math.max(peak, p);
      const sl = o.stopLossPct !== undefined && p <= entryPrice * (1 - o.stopLossPct);
      const tr = o.trailPct !== undefined && p <= peak * (1 - o.trailPct);
      if (sl || tr) {
        kept.push({ t, frac: left, fill: { t, price: p, reserveSol: q, rug: false }, leaderPrice: p });
        left = 0;
        li = legs.length;
        break;
      }
    }
    for (; li < legs.length; li++) kept.push(legs[li]!);
    legs.splice(0, legs.length, ...kept);
  }

  // An exit whose tape could not be read is unknown, not a rug: drop the trade rather than guess.
  if (legs.some((l) => l.fill.missing)) return { ...fail(entryT), ok: false, ret: 0, pnlSol: 0, fees: 0, missing: true };

  // Returns under progressively more realistic assumptions -> attribution.
  const tokensNoImpact = buyTokens(1, entryPrice, Qe, 0, false);
  const tokensImpact = buyTokens(o.sizeSol, entryPrice, Qe, 0, true) / o.sizeSol;
  const tokensFee = buyTokens(o.sizeSol, entryPrice, Qe, fee, true) / o.sizeSol;
  let alphaV = 0, delayV = 0, slipV = 0, feeV = 0, finalV = 0;
  let rug = false;
  const lp = r.leaderPoolPrice;
  for (const leg of legs) {
    const p = leg.fill.price ?? 0;
    const lpx = leg.leaderPrice ?? p;
    alphaV += leg.frac * (lpx / lp);
    delayV += leg.frac * tokensNoImpact * p;
    // A rugged leg's whole loss is rug loss: no exit impact against a drained reserve (that would book most of it
    // as "slippage"). The return is unchanged, since the leg pays nothing either way.
    const q = leg.fill.rug ? null : leg.fill.reserveSol;
    slipV += sellSol(leg.frac * tokensImpact * o.sizeSol, p, q, 0, true) / o.sizeSol;
    const v = sellSol(leg.frac * tokensFee * o.sizeSol, p, q, fee, true) / o.sizeSol;
    feeV += v;
    if (leg.fill.rug || leg.fill.price === null) rug = true;
    else finalV += v;
  }
  const net = (txCost + exitTxCost * legs.length) / o.sizeSol;
  const alpha = alphaV - 1;
  const rD = delayV - 1;
  const rS = slipV - 1;
  const rF = feeV - 1 - net;
  const ret = finalV - 1 - net;
  const exitT = legs.length ? legs[legs.length - 1]!.t : entryT;
  return {
    ok: true, entryT, exitT, ret, pnlSol: ret * o.sizeSol, rug,
    alpha, delayCost: rD - alpha, slippage: rS - rD, fees: rF - rS, rugLoss: ret - rF, leaderRet, contested,
  };
}

/** The leader's own realized return on this buy (fees included), remaining tokens valued at the time-stop price. */
export function leaderReturn(r: ReplRecord): number {
  let remaining = 1;
  let v = 0;
  const zero = r.fills["0"] ?? r.fills[Object.keys(r.fills)[0]!];
  for (let i = 0; i < r.sells.length; i++) {
    const s = r.sells[i]!;
    const frac = remaining * s.frac;
    if (s.kind === "out") {
      // transferred tokens are worth the tape price when they left (0 if the pool was dead or unreadable)
      const f = zero?.exits[i];
      if (f && !f.rug && f.price !== null) v += frac * r.leaderTokens * f.price;
    } else v += frac * r.leaderTokens * s.price;
    remaining -= frac;
  }
  const ts = zero?.timeStop;
  if (remaining > 1e-9 && ts && !ts.rug && ts.price !== null) v += remaining * r.leaderTokens * ts.price;
  return r.leaderSol > 0 ? v / r.leaderSol - 1 : 0;
}

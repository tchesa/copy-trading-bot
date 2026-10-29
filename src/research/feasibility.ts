/**
 * Copyability spec, Stage 0 (cached data, in-sample, can only stop the project): does the "profitable and copyable"
 * corner exist? One point per (wallet, step) with enough replicated buys: the leader's own return vs the cost of a
 * 5 s delay. Pure: takes the raw cached records (kept + dropped) and returns the tables and the stop decision.
 */
import { RANKINGS, type RankingId } from "../ranking/rank.js";
import { hashSeed, rng } from "../util/rng.js";
import { mean, median, quantile, trimTop } from "../util/stats.js";
import type { FollowerResult } from "./follower.js";
import { hasMissingTape } from "./loadSteps.js";
import type { ReplRecord } from "./types.js";

/** Fixed before running (spec 3.3–3.4). */
export const STAGE0 = { minBuys: 3, delay: 5, sizeSol: 0.1, maxDelayCost: -0.02, minWallets: 5, minWeeks: 3, trim: 0.01 } as const;

/**
 * Leader return from its own flows only (no tape): sells at its own price, transfers out and any remainder at its
 * last own trade price. Defined for kept and dropped buys alike.
 */
export function leaderOwnReturn(r: ReplRecord): number {
  let remaining = 1, v = 0, last = r.leaderSol / r.leaderTokens;
  for (const x of r.sells) {
    const frac = remaining * x.frac;
    if (x.kind !== "out") last = x.price;
    v += frac * r.leaderTokens * (x.kind === "out" ? last : x.price);
    remaining -= frac;
  }
  v += remaining * r.leaderTokens * last;
  return r.leaderSol > 0 ? v / r.leaderSol - 1 : NaN;
}

export const trimmedMean = (xs: number[]) => mean(trimTop(xs, STAGE0.trim));

export interface WalletWeek {
  step: number;
  wallet: string;
  /** Methods whose top N held this wallet that week; "random" if none (B1 pool only). */
  methods: string[];
  /** Replicated buys (readable tape, simulated at 0 s and 5 s). */
  n: number;
  /** All the wallet-week's buys, kept + dropped (leader return only). */
  nAll: number;
  leaderMedian: number;
  leaderTrimmed: number;
  delayCost5: number;
  copyMedian: number;
  copyTrimmed: number;
  /** Follower 5 s returns, kept for pooling. */
  rets5: number[];
  profitable: boolean;
  copyable: boolean;
}

export type Sim = (r: ReplRecord, delay: number) => FollowerResult | null;

export function walletWeeks(raw: ReplRecord[], sim: Sim, topN: number): WalletWeek[] {
  const groups = new Map<string, ReplRecord[]>();
  for (const r of raw) {
    const k = `${r.step}|${r.wallet}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  const out: WalletWeek[] = [];
  for (const recs of groups.values()) {
    const pairs = recs.filter((r) => !hasMissingTape(r)).flatMap((r) => {
      const a = sim(r, 0), b = sim(r, STAGE0.delay);
      return a && b ? [{ a, b }] : [];
    });
    if (pairs.length < STAGE0.minBuys) continue;
    const lead = recs.map(leaderOwnReturn).filter(Number.isFinite);
    const rets5 = pairs.map((x) => x.b.ret);
    const r0 = recs[0]!;
    const methods = RANKINGS.filter((id: RankingId) => (r0.ranks[id] ?? Infinity) <= topN);
    const w: WalletWeek = {
      step: r0.step, wallet: r0.wallet, methods: methods.length ? methods : ["random"], n: pairs.length, nAll: recs.length,
      leaderMedian: median(lead), leaderTrimmed: trimmedMean(lead),
      delayCost5: median(pairs.map((x) => x.b.ret - x.a.ret)),
      copyMedian: median(rets5), copyTrimmed: trimmedMean(rets5), rets5,
      profitable: false, copyable: false,
    };
    w.profitable = w.leaderTrimmed > 0;
    w.copyable = w.delayCost5 > STAGE0.maxDelayCost;
    out.push(w);
  }
  return out.sort((a, b) => a.step - b.step || (a.wallet < b.wallet ? -1 : 1));
}

/** Wallet-clustered bootstrap 95% interval (resample distinct wallets, keep all their trades across weeks). */
export function clusteredCI(ws: WalletWeek[], B: number, seed: string) {
  const byWallet = new Map<string, number[]>();
  for (const w of ws) byWallet.set(w.wallet, [...(byWallet.get(w.wallet) ?? []), ...w.rets5]);
  const clusters = [...byWallet.values()];
  if (!clusters.length) return { median: [NaN, NaN], trimmed: [NaN, NaN] };
  const rand = rng(hashSeed("stage0-boot", seed));
  const meds: number[] = [], trims: number[] = [];
  for (let b = 0; b < B; b++) {
    const xs: number[] = [];
    for (let i = 0; i < clusters.length; i++) xs.push(...clusters[Math.floor(rand() * clusters.length)]!);
    meds.push(median(xs));
    trims.push(trimmedMean(xs));
  }
  meds.sort((a, b) => a - b);
  trims.sort((a, b) => a - b);
  return { median: [quantile(meds, 0.025), quantile(meds, 0.975)], trimmed: [quantile(trims, 0.025), quantile(trims, 0.975)] };
}

export interface Stage0Decision {
  wallets: number;
  weeks: number;
  trades: number;
  copyMedian: number;
  copyTrimmed: number;
  ci: ReturnType<typeof clusteredCI>;
  /** Pooled 5 s mean −top 1% with each corner wallet left out (descriptive; not part of the rule). */
  leaveOneOut: Array<{ wallet: string; trades: number; trimmed: number }>;
  checks: Array<{ name: string; value: string; threshold: string; pass: boolean }>;
  proceed: boolean;
}

export function stage0Decision(ws: WalletWeek[], B: number): Stage0Decision {
  const corner = ws.filter((w) => w.profitable && w.copyable);
  const rets = corner.flatMap((w) => w.rets5);
  const wallets = new Set(corner.map((w) => w.wallet)).size;
  const weeks = new Set(corner.map((w) => w.step)).size;
  const copyTrimmed = rets.length ? trimmedMean(rets) : NaN;
  const checks = [
    { name: "Distinct wallets in the corner", value: String(wallets), threshold: `≥ ${STAGE0.minWallets}`, pass: wallets >= STAGE0.minWallets },
    { name: "Weeks covered", value: String(weeks), threshold: `≥ ${STAGE0.minWeeks}`, pass: weeks >= STAGE0.minWeeks },
    { name: "Pooled 5 s copy return, mean −top 1%", value: Number.isFinite(copyTrimmed) ? `${(copyTrimmed * 100).toFixed(1)}%` : "n/a", threshold: "> 0", pass: copyTrimmed > 0 },
  ];
  return {
    wallets, weeks, trades: rets.length, copyMedian: rets.length ? median(rets) : NaN, copyTrimmed,
    ci: clusteredCI(corner, B, "corner"), checks,
    leaveOneOut: [...new Set(corner.map((w) => w.wallet))].map((wallet) => {
      const xs = corner.filter((w) => w.wallet !== wallet).flatMap((w) => w.rets5);
      return { wallet, trades: corner.filter((w) => w.wallet === wallet).reduce((a, w) => a + w.n, 0), trimmed: xs.length ? trimmedMean(xs) : NaN };
    }).sort((a, b) => a.trimmed - b.trimmed), proceed: checks.every((c) => c.pass),
  };
}

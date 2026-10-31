/** Pure statistics for the forward report: summaries, clustered bootstraps, best-token removal, go/no-go. */
import { mean, median, trimTop } from "../util/stats.js";
import { hashSeed, rng } from "../util/rng.js";
import { FORWARD } from "./config.js";

/** One simulated copy of one leader buy (at one delay and size). */
export interface Copy {
  week: string;
  wallet: string;
  mint: string;
  sig: string;
  ret: number;
  pnlSol: number;
  rug: boolean;
  alpha: number;
  delayCost: number;
  slippage: number;
  fees: number;
  rugLoss: number;
  leaderRet: number;
}

export const trimmedMean = (xs: number[]) => (xs.length ? mean(trimTop(xs, FORWARD.trim)) : NaN);

export interface Summary {
  trades: number;
  wallets: number;
  tokens: number;
  median: number;
  mean: number;
  trimmed: number;
  hit: number;
  rug: number;
  pnlSol: number;
  leader: number;
  alpha: number;
  delayCost: number;
  slippage: number;
  fees: number;
  rugLoss: number;
}

export function summarize(c: Copy[]): Summary {
  const r = c.map((x) => x.ret);
  const m = (k: keyof Copy) => mean(c.map((x) => x[k] as number));
  return {
    trades: c.length, wallets: new Set(c.map((x) => x.wallet)).size, tokens: new Set(c.map((x) => x.mint)).size,
    median: median(r), mean: mean(r), trimmed: trimmedMean(r), hit: c.length ? r.filter((x) => x > 0).length / c.length : NaN,
    rug: c.length ? c.filter((x) => x.rug).length / c.length : NaN, pnlSol: c.reduce((a, x) => a + x.pnlSol, 0),
    leader: m("leaderRet"), alpha: m("alpha"), delayCost: m("delayCost"), slippage: m("slippage"), fees: m("fees"), rugLoss: m("rugLoss"),
  };
}

function groups(c: Copy[], key: (x: Copy) => string): Copy[][] {
  const g = new Map<string, Copy[]>();
  for (const x of c) {
    const k = key(x);
    if (!g.has(k)) g.set(k, []);
    g.get(k)!.push(x);
  }
  return [...g.keys()].sort().map((k) => g.get(k)!);
}

/** 90% interval of `stat` resampling whole clusters (wallets or tokens) with replacement. */
export function clusterBoot(c: Copy[], by: "wallet" | "mint", stat: (xs: number[]) => number = trimmedMean, B: number = FORWARD.boot, seed = "boot"): [number, number] {
  const gs = groups(c, (x) => x[by]);
  if (gs.length < 2) return [NaN, NaN];
  const rand = rng(hashSeed(seed, by, c.length));
  const out: number[] = [];
  for (let b = 0; b < B; b++) {
    const xs: number[] = [];
    for (let i = 0; i < gs.length; i++) for (const x of gs[Math.floor(rand() * gs.length)]!) xs.push(x.ret);
    out.push(stat(xs));
  }
  out.sort((a, b) => a - b);
  return [out[Math.floor(0.05 * B)]!, out[Math.floor(0.95 * B) - 1]!];
}

/** 90% interval of trimmed(a) − trimmed(b), resampling wallets within each group independently. */
export function diffBoot(a: Copy[], b: Copy[], B: number = FORWARD.boot): [number, number] {
  const ga = groups(a, (x) => x.wallet);
  const gb = groups(b, (x) => x.wallet);
  if (ga.length < 2 || gb.length < 2) return [NaN, NaN];
  const rand = rng(hashSeed("diff", a.length, b.length));
  const draw = (gs: Copy[][]) => {
    const xs: number[] = [];
    for (let i = 0; i < gs.length; i++) for (const x of gs[Math.floor(rand() * gs.length)]!) xs.push(x.ret);
    return trimmedMean(xs);
  };
  const out: number[] = [];
  for (let i = 0; i < B; i++) out.push(draw(ga) - draw(gb));
  out.sort((x, y) => x - y);
  return [out[Math.floor(0.05 * B)]!, out[Math.floor(0.95 * B) - 1]!];
}

/** The token whose copies add the most return in total, and the copies without ANY buy of it (all wallets). */
export function withoutBestToken(c: Copy[]): { mint: string | null; removed: number; rest: Copy[] } {
  const sum = new Map<string, number>();
  for (const x of c) sum.set(x.mint, (sum.get(x.mint) ?? 0) + x.ret);
  const best = [...sum].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
  if (!best) return { mint: null, removed: 0, rest: c };
  const rest = c.filter((x) => x.mint !== best[0]);
  return { mint: best[0], removed: c.length - rest.length, rest };
}

export interface Criterion {
  name: string;
  value: string;
  pass: boolean;
  /** Sample-size criterion: failing only this one is INCONCLUSIVE, not NO-GO. */
  sample?: boolean;
}

export interface Verdict {
  status: "PENDING" | "GO" | "NO-GO" | "INCONCLUSIVE";
  weeks: number;
  criteria: Criterion[];
}

const pc = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "n/a");

/**
 * Go / no-go on the headline variant (all snapshot wallets, 1 s, 0.1 SOL), over the first FORWARD.goWeeks complete
 * forward weeks. `weekly` holds each complete week's copies (oldest first); `baseline` the random wallets' copies over
 * the same weeks. Before goWeeks weeks the status is PENDING, with every criterion's current value.
 */
export function verdict(weekly: Copy[][], baseline: Copy[]): Verdict {
  const weeks = weekly.slice(0, FORWARD.goWeeks);
  const all = weeks.flat();
  const s = summarize(all);
  const wb = withoutBestToken(all);
  const tb = trimmedMean(wb.rest.map((x) => x.ret));
  const [lo] = clusterBoot(all, "wallet");
  const posWeeks = weeks.filter((w) => trimmedMean(w.map((x) => x.ret)) > 0).length;
  const base = trimmedMean(baseline.map((x) => x.ret));
  const [dlo] = diffBoot(all, baseline);
  const criteria: Criterion[] = [
    { name: `≥ ${FORWARD.minTrades} copied buys from ≥ ${FORWARD.minWallets} wallets`, value: `${s.trades} buys, ${s.wallets} wallets`, pass: s.trades >= FORWARD.minTrades && s.wallets >= FORWARD.minWallets, sample: true },
    { name: "median > 0 and trimmed mean > 0", value: `median ${pc(s.median)}, trimmed ${pc(s.trimmed)}`, pass: s.median > 0 && s.trimmed > 0 },
    { name: "trimmed mean > 0 without the best token", value: `${pc(tb)} (without ${wb.mint?.slice(0, 8) ?? "–"}…, ${wb.removed} buys)`, pass: tb > 0 },
    { name: "wallet-clustered 90% interval lower end > 0", value: pc(lo), pass: lo > 0 },
    { name: `positive trimmed mean in ≥ ${FORWARD.minPositiveWeeks} of ${FORWARD.goWeeks} weeks`, value: `${posWeeks} of ${weeks.length}`, pass: posWeeks >= FORWARD.minPositiveWeeks },
    { name: "beats random wallets (trimmed mean, 90% interval of the difference > 0)", value: `${pc(s.trimmed)} vs ${pc(base)}, difference lower end ${pc(dlo)}`, pass: dlo > 0 },
  ];
  if (weeks.length < FORWARD.goWeeks) return { status: "PENDING", weeks: weeks.length, criteria };
  const failed = criteria.filter((c) => !c.pass);
  const status = failed.length === 0 ? "GO" : failed.every((c) => c.sample) ? "INCONCLUSIVE" : "NO-GO";
  return { status, weeks: weeks.length, criteria };
}

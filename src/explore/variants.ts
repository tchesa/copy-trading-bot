/**
 * Selection rules over the exploratory universe (pure). A rule = filter thresholds + a ranking key + top N per step.
 * Fast path (grid search, permutation null): per wallet-step sum and count of follower returns capped at the pooled
 * p99. Exact path (reported rules): top-1%-trimmed mean, median, wallet-clustered bootstrap, attribution.
 */
import type { CostParams } from "../config/params.js";
import { simulateFollower, type FollowerResult } from "../research/follower.js";
import { hasMissingTape } from "../research/loadSteps.js";
import type { ReplRecord } from "../research/types.js";
import { hashSeed, rng, sample, shuffle } from "../util/rng.js";
import { mean, median, quantile, ranks, trimTop } from "../util/stats.js";
import { DAY } from "../research/pipeline.js";
import { MIN_POSITION_COST_SOL } from "../wallets/metrics.js";
import { EXPLORE } from "./config.js";
import type { UStep, UWallet } from "./universe.js";

export const trimmed = (xs: number[]) => mean(trimTop(xs, EXPLORE.trim));

export interface Key {
  id: string;
  label: string;
  get: (u: UWallet, step: StepData) => number | null;
}

export const KEYS: Key[] = [
  { id: "roc", label: "formation return on capital", get: (u) => u.m.roc },
  { id: "pnl", label: "formation PnL (SOL)", get: (u) => u.m.pnl },
  { id: "pnlPerPos", label: "PnL per position", get: (u) => (u.m.positions ? u.m.pnl / u.m.positions : null) },
  { id: "winRate", label: "win rate", get: (u) => u.m.winRate },
  { id: "medianRet", label: "median position return", get: (u) => u.m.medianRet },
  { id: "meanRet", label: "mean position return", get: (u) => u.m.meanRet },
  { id: "posWeeks", label: "% positive weeks", get: (u) => u.m.pctPositiveWeeks },
  { id: "trades", label: "most positions (activity)", get: (u) => u.m.positions },
  { id: "fewTrades", label: "fewest positions", get: (u) => -u.m.positions },
  { id: "lowDD", label: "lowest max drawdown", get: (u) => -u.m.maxDrawdown },
  { id: "hold", label: "longest median hold", get: (u) => u.m.medianHoldMinutes },
  { id: "C", label: "copyability C", get: (u) => u.score?.C ?? null },
  { id: "lowI", label: "lowest market impact I", get: (u) => (u.score?.I == null ? null : -u.score.I) },
  { id: "rocC", label: "ROC + C (mean percentile)", get: (u, s) => s.rocC.get(u.wallet) ?? null },
];

export interface Filter {
  minClosed: number;
  minLiq: number;
  maxI: number;
  minHold: number;
  minC: number;
  active: boolean;
  maxConc: number;
  minRoc: number;
  /** Peak capital deployed in the scoring month (SOL): drops dust wallets whose ROC is huge on tiny capital. */
  minPeak: number;
}

export const FILTER_GRID: { [K in keyof Filter]: Filter[K][] } = {
  minClosed: [5, 10, 20, 40],
  minLiq: [0, 20, 50],
  maxI: [Infinity, 0.5, 0.3],
  minHold: [0, 10],
  minC: [-Infinity, 0],
  active: [false, true],
  maxConc: [Infinity, 0.3],
  minRoc: [-Infinity, 0],
  minPeak: [0, 1, 5],
};

export const BASE_FILTER: Filter = { minClosed: 10, minLiq: 0, maxI: Infinity, minHold: 0, minC: -Infinity, active: false, maxConc: Infinity, minRoc: -Infinity, minPeak: 1 };

export function allFilters(): Filter[] {
  let out: Filter[] = [{} as Filter];
  for (const [k, vs] of Object.entries(FILTER_GRID) as Array<[keyof Filter, Array<number | boolean>]>) {
    out = out.flatMap((f) => vs.map((v) => ({ ...f, [k]: v })));
  }
  return out;
}

export function passes(u: UWallet, F1: number, f: Filter): boolean {
  const m = u.m, C = u.score?.C ?? null, I = u.score?.I ?? null;
  return m.closed >= f.minClosed && m.medianEntryLiquiditySol >= f.minLiq &&
    (f.maxI === Infinity || (I !== null && I <= f.maxI)) && m.medianHoldMinutes >= f.minHold &&
    (f.minC === -Infinity || (C !== null && C > f.minC)) && (!f.active || m.lastActivity >= F1 - 7 * DAY) &&
    (f.maxConc === Infinity || m.maxPnlConcentration <= f.maxConc) && (f.minRoc === -Infinity || m.roc > f.minRoc) &&
    m.peakCapital >= f.minPeak;
}

export const filterLabel = (f: Filter) => {
  const p: string[] = [`closed ≥ ${f.minClosed}`];
  if (f.minLiq) p.push(`entry liq ≥ ${f.minLiq}`);
  if (f.maxI !== Infinity) p.push(`I ≤ ${f.maxI}`);
  if (f.minHold) p.push(`hold ≥ ${f.minHold}m`);
  if (f.minC !== -Infinity) p.push(`C > ${f.minC}`);
  if (f.active) p.push("active last 7d");
  if (f.maxConc !== Infinity) p.push(`conc ≤ ${f.maxConc}`);
  if (f.minRoc !== -Infinity) p.push(`ROC > ${f.minRoc}`);
  if (f.minPeak) p.push(`peak capital ≥ ${f.minPeak} SOL`);
  return p.join(", ");
};

export type Sel = { rec: ReplRecord; res: FollowerResult };

/** One step's selectable wallets (universe, eval history covered, at least one eval buy) and their results. */
export interface StepData {
  step: number;
  F1: number;
  wallets: UWallet[];
  /** Readable records per wallet. */
  recs: Map<string, ReplRecord[]>;
  /** Simulated readable records per setting, per wallet. */
  sims: Map<string, Map<string, Sel[]>>;
  rocC: Map<string, number>;
}

export function prepare(steps: UStep[], costs: CostParams, maxHoldHours: number): StepData[] {
  return steps.map((s) => {
    const byW = new Map<string, ReplRecord[]>();
    const traded = new Set<string>();
    for (const r of s.records) {
      traded.add(r.wallet);
      // Dust leader buys are not copied (same floor as wallet metrics): a follower can skip them at trade time.
      if (hasMissingTape(r) || r.leaderSol < MIN_POSITION_COST_SOL) continue;
      byW.set(r.wallet, [...(byW.get(r.wallet) ?? []), r]);
    }
    const wallets = s.universe.map((x) => s.wallets[x]!).filter((u) => u.evalCovered && traded.has(u.wallet));
    const sims = new Map<string, Map<string, Sel[]>>();
    for (const st of EXPLORE.settings) {
      const m = new Map<string, Sel[]>();
      for (const u of wallets) {
        m.set(u.wallet, (byW.get(u.wallet) ?? []).flatMap((rec) => {
          const res = simulateFollower(rec, { delay: st.delay, sizeSol: st.size, costs, maxHoldHours });
          return res.ok ? [{ rec, res }] : [];
        }));
      }
      sims.set(st.name, m);
    }
    const both = wallets.filter((u) => u.score?.C != null);
    const rr = ranks(both.map((u) => u.m.roc)), rc = ranks(both.map((u) => u.score!.C!));
    const n = both.length;
    const rocC = new Map(both.map((u, i) => [u.wallet, n > 1 ? ((rr[i]! - 1) + (rc[i]! - 1)) / (2 * (n - 1)) : 0.5]));
    return { step: s.step, F1: s.F1, wallets, recs: byW, sims, rocC };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Fast grid

export interface Grid {
  filters: Filter[];
  steps: Array<{
    step: number;
    n: number;
    /** order[k] = wallet indices by key k, best first (null keys left out). */
    order: Int32Array[];
    /** mask[f][i] = filter f passes wallet i. */
    mask: Uint8Array[];
    sum: Float64Array;
    cnt: Int32Array;
  }>;
  cap: number;
}

export function buildGrid(data: StepData[], setting: string = EXPLORE.settings[0].name): Grid {
  const filters = allFilters();
  const all = data.flatMap((d) => [...d.sims.get(setting)!.values()].flat().map((x) => x.res.ret)).sort((a, b) => a - b);
  const cap = all.length ? quantile(all, 0.99) : Infinity;
  const steps = data.map((d) => {
    const n = d.wallets.length;
    const order = KEYS.map((k) => {
      const v = d.wallets.map((u) => k.get(u, d));
      const idx = [...Array(n).keys()].filter((i) => v[i] !== null && Number.isFinite(v[i]!));
      idx.sort((a, b) => v[b]! - v[a]! || (d.wallets[a]!.wallet < d.wallets[b]!.wallet ? -1 : 1));
      return Int32Array.from(idx);
    });
    const mask = filters.map((f) => Uint8Array.from(d.wallets.map((u) => (passes(u, d.F1, f) ? 1 : 0))));
    const sum = new Float64Array(n), cnt = new Int32Array(n);
    d.wallets.forEach((u, i) => {
      const xs = d.sims.get(setting)!.get(u.wallet)!;
      sum[i] = xs.reduce((a, x) => a + Math.min(x.res.ret, cap), 0);
      cnt[i] = xs.length;
    });
    return { step: d.step, n, order, mask, sum, cnt };
  });
  return { filters, steps, cap };
}

export interface GridScore {
  f: number;
  k: number;
  topN: number;
  mean: number;
  trades: number;
  wallets: number;
  minStepTrades: number;
}

/** Every rule's capped mean return on the given steps (indices into grid.steps). `perm` maps wallet → results row. */
export function scoreGrid(g: Grid, stepIdx: number[], perm?: Int32Array[]): GridScore[] {
  const T = EXPLORE.topNs, maxN = Math.max(...T);
  const out: GridScore[] = [];
  const acc = T.map(() => ({ s: 0, c: 0, w: 0, min: Infinity }));
  for (let f = 0; f < g.filters.length; f++) {
    for (let k = 0; k < KEYS.length; k++) {
      for (const a of acc) Object.assign(a, { s: 0, c: 0, w: 0, min: Infinity });
      for (const si of stepIdx) {
        const st = g.steps[si]!, ord = st.order[k]!, mask = st.mask[f]!, p = perm?.[si];
        let picked = 0, s = 0, c = 0, ti = 0;
        for (let j = 0; j < ord.length && picked < maxN; j++) {
          const i = ord[j]!;
          if (!mask[i]) continue;
          const r = p ? p[i]! : i;
          s += st.sum[r]!;
          c += st.cnt[r]!;
          picked++;
          while (ti < T.length && picked === T[ti]) {
            const a = acc[ti]!;
            a.s += s; a.c += c; a.w += picked; a.min = Math.min(a.min, c);
            ti++;
          }
        }
        // Fewer passing wallets than top N: the rule takes all of them.
        for (; ti < T.length; ti++) {
          const a = acc[ti]!;
          a.s += s; a.c += c; a.w += picked; a.min = Math.min(a.min, c);
        }
      }
      T.forEach((topN, ti) => {
        const a = acc[ti]!;
        out.push({ f, k, topN, mean: a.c ? a.s / a.c : NaN, trades: a.c, wallets: a.w, minStepTrades: a.min });
      });
    }
  }
  return out;
}

export const valid = (x: GridScore) => x.wallets >= EXPLORE.minWallets && x.minStepTrades >= EXPLORE.minTradesPerStep && Number.isFinite(x.mean);

/** Within-step shuffles of which wallet's results go with which wallet's features. */
export function permutations(g: Grid, n: number): Int32Array[][] {
  return Array.from({ length: n }, (_, p) => g.steps.map((st, si) => Int32Array.from(shuffle([...Array(st.n).keys()], rng(hashSeed("explore-perm", p, si))))));
}

// ---------------------------------------------------------------------------------------------------------------
// Exact evaluation

export interface Rule {
  filter: Filter;
  key: string;
  topN: number;
}

export const ruleLabel = (r: Rule) => `${KEYS.find((k) => k.id === r.key)!.label} · top ${r.topN} · ${filterLabel(r.filter)}`;

export function selectWallets(d: StepData, r: Rule): string[] {
  const key = KEYS.find((k) => k.id === r.key)!;
  return d.wallets
    .filter((u) => passes(u, d.F1, r.filter))
    .map((u) => ({ u, v: key.get(u, d) }))
    .filter((x) => x.v !== null && Number.isFinite(x.v))
    .sort((a, b) => b.v! - a.v! || (a.u.wallet < b.u.wallet ? -1 : 1))
    .slice(0, r.topN)
    .map((x) => x.u.wallet);
}

export function selsOf(data: StepData[], pick: (d: StepData) => string[], setting: string): Sel[] {
  return data.flatMap((d) => pick(d).flatMap((w) => d.sims.get(setting)!.get(w) ?? []));
}

/** Random top N among wallets passing the filter, per step (median over seeds of each statistic). */
export function randomPick(filter: Filter, topN: number, seed: number) {
  return (d: StepData) => sample(d.wallets.filter((u) => passes(u, d.F1, filter)).map((u) => u.wallet).sort(), topN, rng(hashSeed("explore-rand", seed, d.step)));
}

export function boot(xs: Sel[], seed: string) {
  const by = new Map<string, number[]>();
  for (const x of xs) {
    const k = `${x.rec.step}|${x.rec.wallet}`;
    by.set(k, [...(by.get(k) ?? []), x.res.ret]);
  }
  const cl = [...by.values()];
  if (!cl.length) return { lower: NaN, ci: [NaN, NaN] as [number, number] };
  const rand = rng(hashSeed("explore-boot", seed));
  const t: number[] = [];
  for (let b = 0; b < EXPLORE.boot; b++) {
    const r: number[] = [];
    for (let i = 0; i < cl.length; i++) r.push(...cl[Math.floor(rand() * cl.length)]!);
    t.push(trimmed(r));
  }
  t.sort((a, b) => a - b);
  return { lower: quantile(t, 0.05), ci: [quantile(t, 0.025), quantile(t, 0.975)] as [number, number] };
}

export function summarize(xs: Sel[], clean: (r: ReplRecord) => boolean) {
  const r = xs.map((x) => x.res.ret);
  const c = xs.filter((x) => clean(x.rec));
  const m = (k: "alpha" | "delayCost" | "slippage" | "fees" | "rugLoss" | "leaderRet") => (c.length ? mean(c.map((x) => x.res[k])) : NaN);
  return {
    trades: xs.length, wallets: new Set(xs.map((x) => `${x.rec.step}|${x.rec.wallet}`)).size,
    median: r.length ? median(r) : NaN, trimmed: r.length ? trimmed(r) : NaN, hit: r.length ? r.filter((v) => v > 0).length / r.length : NaN,
    rug: r.length ? xs.filter((x) => x.res.rug).length / r.length : NaN,
    alpha: m("alpha"), delayCost: m("delayCost"), slippage: m("slippage"), fees: m("fees"), rugLoss: m("rugLoss"),
  };
}

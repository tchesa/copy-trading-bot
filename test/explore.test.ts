import { describe, expect, it } from "vitest";
import { EXPLORE } from "../src/explore/config.js";
import { exploreSteps, type UWallet } from "../src/explore/universe.js";
import { allFilters, BASE_FILTER, buildGrid, FILTER_GRID, KEYS, scoreGrid, selectWallets, type Sel, type StepData } from "../src/explore/variants.js";
import type { WalletMetrics } from "../src/wallets/metrics.js";

const DAY = 86_400;

function wallet(i: number, over: Partial<WalletMetrics> = {}): UWallet {
  const m: WalletMetrics = {
    wallet: `w${String(i).padStart(3, "0")}`, positions: 10 + i, closed: 10 + i, pnl: i - 10, peakCapital: 10, roc: (i - 10) / 10, winRate: 0.5, medianRet: 0, meanRet: 0,
    maxDrawdown: 0.1 * (i % 5), pctPositiveWeeks: 0.5, medianHoldMinutes: 30, medianEntryLiquiditySol: 30, maxPnlConcentration: 0.2, lastActivity: 100 * DAY, tradesPerDay: 1, ...over,
  };
  return { wallet: m.wallet, m, excluded: [], ineligible: [], inUniverse: true, evalCovered: true, score: { C: i % 3 ? i / 100 : null, nC: 8, rets: [], sampled: 12, comps: {} as never, I: (i % 10) / 10, roc: m.roc } };
}

function stepData(step: number, n: number): StepData {
  const wallets = Array.from({ length: n }, (_, i) => wallet(i));
  const sims = new Map<string, Map<string, Sel[]>>();
  for (const st of EXPLORE.settings) {
    sims.set(st.name, new Map(wallets.map((u, i) => [u.wallet, Array.from({ length: 1 + (i % 4) }, (_, j) => ({ rec: { step, wallet: u.wallet } as never, res: { ret: (i - n / 2) / n + j / 100 } as never }))])));
  }
  return { step, F1: 101 * DAY, wallets, recs: new Map(), sims, rocC: new Map(wallets.map((u, i) => [u.wallet, i / n])) };
}

describe("explore windows", () => {
  it("monthly, non-overlapping: each step's scoring window is the previous step's simulation month", () => {
    const ws = exploreSteps(0);
    expect(ws).toHaveLength(6);
    for (const w of ws) expect(w.F1 - w.F0).toBe(EXPLORE.formationDays * DAY);
    for (let i = 1; i < ws.length; i++) expect(ws[i]!.F0).toBe(ws[i - 1]!.F1);
  });
});

describe("rule grid", () => {
  it("enumerates every filter combination", () => {
    const n = Object.values(FILTER_GRID).reduce((a, v) => a * v.length, 1);
    expect(allFilters()).toHaveLength(n);
  });

  it("the fast path selects the same wallets as the exact path", () => {
    const data = [stepData(0, 60), stepData(1, 45)];
    const g = buildGrid(data);
    const scores = scoreGrid(g, [0, 1]);
    for (const x of scores.filter((_, i) => i % 97 === 0)) {
      const rule = { filter: g.filters[x.f]!, key: KEYS[x.k]!.id, topN: x.topN };
      let s = 0, c = 0, w = 0;
      for (const d of data) {
        const pick = selectWallets(d, rule);
        w += pick.length;
        for (const p of pick) for (const r of d.sims.get(EXPLORE.settings[0].name)!.get(p)!) {
          s += Math.min(r.res.ret, g.cap);
          c++;
        }
      }
      expect(x.wallets).toBe(w);
      expect(x.trades).toBe(c);
      if (c) expect(x.mean).toBeCloseTo(s / c, 10);
    }
  });

  it("identity permutation leaves scores unchanged", () => {
    const data = [stepData(0, 30)];
    const g = buildGrid(data);
    const id = [Int32Array.from([...Array(30).keys()])];
    expect(scoreGrid(g, [0], id).map((x) => x.mean)).toEqual(scoreGrid(g, [0]).map((x) => x.mean));
  });

  it("ranks by the key, best first, within the filter", () => {
    const d = stepData(0, 30);
    expect(selectWallets(d, { filter: BASE_FILTER, key: "roc", topN: 3 })).toEqual(["w029", "w028", "w027"]);
    expect(selectWallets(d, { filter: { ...BASE_FILTER, maxI: 0.3 }, key: "roc", topN: 3 })).toEqual(["w023", "w022", "w021"]);
  });
});

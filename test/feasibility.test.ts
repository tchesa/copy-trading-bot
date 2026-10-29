import { describe, expect, it } from "vitest";
import { defaultCosts } from "../src/config/params.js";
import { leaderOwnReturn, stage0Decision, walletWeeks } from "../src/research/feasibility.js";
import { simulateFollower } from "../src/research/follower.js";
import type { ReplRecord } from "../src/research/types.js";
import { T0, record } from "./helpers.js";

const zero = { ...defaultCosts(), venueFeePct: { other: 0, pumpswap: 0 }, baseFeeSol: 0, priorityFeeSol: 0, contestedPriorityFeeSol: 0, jitoTipSol: 0 };
const sim = (r: ReplRecord, delay: number) => {
  const x = simulateFollower(r, { delay, sizeSol: 1e-9, costs: zero });
  return x.ok ? x : null;
};

describe("Stage 0 feasibility", () => {
  it("leader own return uses its sell price and the last own price for transfers out", () => {
    expect(leaderOwnReturn(record())).toBeCloseTo(1); // bought at 0.001, sold all at 0.002
    const r = record({ sells: [{ t: T0 + 10, frac: 0.5, price: 0.003, poolPrice: 0.003 }, { t: T0 + 20, frac: 1, price: 0, poolPrice: null, kind: "out" }] });
    expect(leaderOwnReturn(r)).toBeCloseTo(2); // half at 0.003, half transferred out valued at 0.003
  });

  it("groups by wallet-week, needs ≥ 3 replicated buys, and drops unreadable tape from the copy side only", () => {
    const recs = [0, 1, 2].map((i) => record({ sig: `a${i}`, wallet: "A" }));
    const missing = record({ sig: "a3", wallet: "A" });
    missing.fills["5"]!.entry = { ...missing.fills["5"]!.entry, missing: true };
    const ws = walletWeeks([...recs, missing, record({ sig: "b0", wallet: "B" })], sim, 10);
    expect(ws).toHaveLength(1);
    expect(ws[0]!.n).toBe(3);
    expect(ws[0]!.nAll).toBe(4);
    expect(ws[0]!.methods).toEqual(["S2"]);
    expect(ws[0]!.profitable).toBe(true);
    // helper tape: 0 s buys 0.001 → 0.002 (+100%), 5 s buys 0.0012 → 0.0019 (+58%): delay cost ≈ −42%, not copyable
    expect(ws[0]!.delayCost5).toBeCloseTo(0.0019 / 0.0012 - 2, 3);
    expect(ws[0]!.copyable).toBe(false);
  });

  it("stops when the corner has too few wallets", () => {
    const flat = (w: string, step: number) => [0, 1, 2].map((i) => {
      const r = record({ sig: `${w}${step}${i}`, wallet: w, step });
      r.fills["5"] = { entry: { t: T0 + 5, price: 0.001, reserveSol: 1000, rug: false }, exits: [{ t: T0 + 3605, price: 0.002, reserveSol: 1000, rug: false }], timeStop: { t: T0 + 48 * 3600, price: 0.002, reserveSol: 1000, rug: false } };
      return r;
    });
    const ws = walletWeeks([...flat("A", 0), ...flat("B", 1), ...flat("C", 2)], sim, 10);
    expect(ws.every((w) => w.profitable && w.copyable)).toBe(true);
    const d = stage0Decision(ws, 50);
    expect(d.wallets).toBe(3);
    expect(d.proceed).toBe(false);
    expect(d.checks.map((c) => c.pass)).toEqual([false, true, true]);
  });
});

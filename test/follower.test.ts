import { describe, expect, it } from "vitest";
import { defaultCosts } from "../src/config/params.js";
import { buyTokens, leaderReturn, sellSol, simulateFollower } from "../src/research/follower.js";
import { sellSchedule } from "../src/research/replicate.js";
import { buildPositions } from "../src/wallets/positions.js";
import { T0, record, trade } from "./helpers.js";

const zero = { ...defaultCosts(), venueFeePct: { other: 0, pumpswap: 0 }, baseFeeSol: 0, priorityFeeSol: 0, contestedPriorityFeeSol: 0, jitoTipSol: 0 };

describe("delay pricing and costs", () => {
  it("zero delay at zero cost and no impact earns the leader's pool-price return", () => {
    const r = simulateFollower(record(), { delay: 0, sizeSol: 1e-9, costs: zero });
    expect(r.ret).toBeCloseTo(1, 4); // 0.001 -> 0.002
    expect(r.alpha).toBeCloseTo(1, 4);
    expect(r.delayCost).toBeCloseTo(0, 4);
  });

  it("a delay fills at the first trade after t + delay, and the difference is delay cost", () => {
    const r = simulateFollower(record(), { delay: 5, sizeSol: 1e-9, costs: zero });
    expect(r.entryT).toBe(T0 + 5);
    expect(r.ret).toBeCloseTo(0.0019 / 0.0012 - 1, 4);
    expect(r.alpha + r.delayCost + r.slippage + r.fees + r.rugLoss).toBeCloseTo(r.ret, 9);
    expect(r.delayCost).toBeLessThan(0);
  });

  it("constant-product slippage grows with size relative to the pool", () => {
    const small = buyTokens(1, 0.001, 1000, 0, true);
    const big = buyTokens(100, 0.001, 1000, 0, true) / 100;
    expect(big).toBeLessThan(small);
    expect(small).toBeCloseTo(1000 / 1.001, 3);
    expect(sellSol(1000, 0.001, 1000, 0, true)).toBeCloseTo(1 / 1.001, 6);
  });

  it("fees and priority fees reduce the return and sum into the attribution", () => {
    const costs = defaultCosts();
    const r = simulateFollower(record(), { delay: 5, sizeSol: 1, costs });
    const z = simulateFollower(record(), { delay: 5, sizeSol: 1, costs: zero });
    expect(r.ret).toBeLessThan(z.ret);
    expect(r.alpha + r.delayCost + r.slippage + r.fees + r.rugLoss).toBeCloseTo(r.ret, 9);
  });

  it("mirrors partial leader sells proportionally", () => {
    const b = trade({ side: "buy", t: T0, tokens: 1000, sol: 1 });
    const s1 = trade({ side: "sell", t: T0 + 10, tokens: 250, sol: 0.5 });
    const s2 = trade({ side: "sell", t: T0 + 20, tokens: 750, sol: 3 });
    const pos = buildPositions([b, s1, s2], T0, T0 + 100, () => null)[0]!;
    const sch = sellSchedule(pos, pos.buys[0]!, T0 + 100);
    expect(sch.map((x) => x.frac)).toEqual([0.25, 1]);
  });

  it("a leader transfer out is mirrored as an exit, valued on the tape (even at delay 0)", () => {
    const b = trade({ side: "buy", t: T0, tokens: 1000, sol: 1 });
    const o = trade({ side: "out", t: T0 + 600, tokens: 1000, sol: 0 });
    const pos = buildPositions([b, o], T0, T0 + 100_000, () => null)[0]!;
    const sch = sellSchedule(pos, pos.buys[0]!, T0 + 48 * 3600);
    expect(sch).toEqual([{ t: T0 + 600, frac: 1, price: 0.001, poolPrice: null, kind: "out" }]);
    // tape at the transfer: 0.0015; at the 48h time stop the pool is dead (would be a rug if held)
    const tape = (t: number, price: number | null, rug = false) => ({ t, price, reserveSol: 1000, rug });
    const rec = record({
      sells: sch,
      fills: {
        "0": { entry: tape(T0, 0.001), exits: [tape(T0 + 601, 0.0015)], timeStop: tape(T0 + 48 * 3600, null, true) },
        "5": { entry: tape(T0 + 5, 0.001), exits: [tape(T0 + 606, 0.0015)], timeStop: tape(T0 + 48 * 3600, null, true) },
      },
    });
    for (const delay of [0, 5]) {
      const r = simulateFollower(rec, { delay, sizeSol: 1e-9, costs: zero });
      expect(r.rug).toBe(false);
      expect(r.ret).toBeCloseTo(0.5, 4);
    }
    expect(leaderReturn(rec)).toBeCloseTo(0.5, 4);
  });

  it("time stop exits what the leader still holds", () => {
    const rec = record({ sells: [], fills: { "5": { entry: { t: T0 + 5, price: 0.001, reserveSol: 1000, rug: false }, exits: [], timeStop: { t: T0 + 48 * 3600, price: 0.0005, reserveSol: 1000, rug: false } } } });
    const r = simulateFollower(rec, { delay: 5, sizeSol: 1e-9, costs: zero });
    expect(r.ret).toBeCloseTo(-0.5, 4);
    expect(r.exitT).toBe(T0 + 48 * 3600);
  });
});

describe("rug detection", () => {
  it("an exit flagged as rug (no liquidity, honeypot or dead) is -100%", () => {
    const rec = record();
    rec.fills["5"]!.exits[0] = { t: T0 + 3605, price: 0.002, reserveSol: 0.1, rug: true };
    const r = simulateFollower(rec, { delay: 5, sizeSol: 1, costs: zero });
    expect(r.rug).toBe(true);
    expect(r.ret).toBeCloseTo(-1, 6);
    expect(r.rugLoss).toBeLessThan(0);
  });

  it("an exit with no trade at all is -100%", () => {
    const rec = record();
    rec.fills["5"]!.exits[0] = { t: T0 + 3605, price: null, reserveSol: null, rug: true };
    expect(simulateFollower(rec, { delay: 5, sizeSol: 1, costs: zero }).ret).toBeCloseTo(-1, 6);
  });

  it("stops on the price path cut losses before a rug", () => {
    const rec = record({ path: [[T0 + 60, 0.0011, 1000], [T0 + 600, 0.0005, 1000], [T0 + 3605, 0.0019, 1000]] });
    rec.fills["5"]!.exits[0] = { t: T0 + 3605, price: null, reserveSol: null, rug: true };
    const r = simulateFollower(rec, { delay: 5, sizeSol: 1e-9, costs: zero, stopLossPct: 0.5 });
    expect(r.rug).toBe(false);
    expect(r.ret).toBeCloseTo(0.0005 / 0.0012 - 1, 4);
  });
});

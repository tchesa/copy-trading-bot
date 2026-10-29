import { describe, expect, it } from "vitest";
import { walletMetrics } from "../src/wallets/metrics.js";
import { buildPositions } from "../src/wallets/positions.js";
import { T0, trade } from "./helpers.js";

describe("position reconstruction", () => {
  it("multiple buys and partial sells form one position with average cost", () => {
    const ts = [
      trade({ side: "buy", t: T0, tokens: 1000, sol: 1 }),
      trade({ side: "buy", t: T0 + 60, tokens: 1000, sol: 2 }),
      trade({ side: "sell", t: T0 + 120, tokens: 500, sol: 1 }),
      trade({ side: "sell", t: T0 + 180, tokens: 1500, sol: 4 }),
    ];
    const [p, ...rest] = buildPositions(ts, T0, T0 + 86_400, () => null);
    expect(rest).toHaveLength(0);
    expect(p!.costSol).toBeCloseTo(3);
    expect(p!.proceedsSol).toBeCloseTo(5);
    expect(p!.pnl).toBeCloseTo(2);
    expect(p!.closeT).toBe(T0 + 180);
    expect(p!.buys).toHaveLength(2);
    expect(p!.sells).toHaveLength(2);
  });

  it("a position opened before the window absorbs its in-window top-ups and sells (not reported)", () => {
    const from = T0 + 3600;
    const ts = [
      trade({ side: "buy", t: T0, tokens: 1000, sol: 1 }), // formation-opened
      trade({ side: "buy", t: from + 10, tokens: 10, sol: 0.01 }), // small top-up inside the window
      trade({ side: "sell", t: from + 20, tokens: 1010, sol: 5 }), // sells the whole bag
      trade({ side: "buy", t: from + 30, tokens: 100, sol: 1, mint: "M2" }),
    ];
    const ps = buildPositions(ts, from, from + 86_400, () => null);
    expect(ps.map((p) => p.mint)).toEqual(["M2"]);
  });

  it("transfer out after a partial sell does not wipe the cost basis", () => {
    const ts = [
      trade({ side: "buy", t: T0, tokens: 1000, sol: 10 }),
      trade({ side: "sell", t: T0 + 10, tokens: 800, sol: 8 }),
      trade({ side: "out", t: T0 + 20, tokens: 200, sol: 0 }),
    ];
    const [p] = buildPositions(ts, T0, T0 + 100, () => null);
    expect(p!.costSol).toBeCloseTo(10); // the old code left ~0 here, so the return was astronomic
    expect(p!.ret).toBeCloseTo(0);
  });

  it("a cheap late buy transferred out does not turn earlier sells into profit", () => {
    // Real pattern: many buys/sells at ~0.003, then after a 600× crash a buy of 13k tokens for 0.076, all sent out.
    const ts = [
      trade({ side: "buy", t: T0, tokens: 100, sol: 0.3 }),
      trade({ side: "sell", t: T0 + 10, tokens: 60, sol: 0.18 }),
      trade({ side: "buy", t: T0 + 20, tokens: 13_000, sol: 0.076 }),
      trade({ side: "out", t: T0 + 30, tokens: 13_040, sol: 0 }),
    ];
    const [p] = buildPositions(ts, T0, T0 + 100, () => null);
    expect(p!.pnl).toBeCloseTo(0.18 + 13_040 * (0.076 / 13_000) - 0.376, 6); // ≈ −0.12, not a 100×+ gain
    expect(p!.ret).toBeLessThan(0);
  });

  it("dust trades do not set the price used to value a transfer out", () => {
    const ts = [
      trade({ side: "buy", t: T0, tokens: 1_000_000, sol: 3 }), // 3e-6
      trade({ side: "buy", t: T0 + 10, tokens: 0.08, sol: 0.0003 }), // fee-dominated dust: "price" 0.00375
      trade({ side: "out", t: T0 + 20, tokens: 1_000_000.08, sol: 0 }),
    ];
    const [p] = buildPositions(ts, T0, T0 + 100, () => null);
    expect(p!.transferredOutSol).toBeCloseTo(3, 3);
  });

  it("an open position is marked on the pool of its latest buy", () => {
    const ts = [
      trade({ side: "buy", t: T0, tokens: 100, sol: 0.001, pool: "REAL" }),
      trade({ side: "buy", t: T0 + 10, tokens: 1_000_000, sol: 0.0001, pool: "DUST" }),
    ];
    const marks: Record<string, number> = { REAL: 0.00001, DUST: 1e-10 };
    const [p] = buildPositions(ts, T0, T0 + 100, (_m, pool) => marks[pool!]!);
    expect(p!.markSol).toBeCloseTo(1_000_100 * 1e-10, 9);
  });

  it("an open position is marked at what the pool could pay out, not tokens × price", () => {
    const ts = [trade({ side: "buy", t: T0, tokens: 1_000_000, sol: 1 })];
    // last price says 100 SOL, but the pool only holds 10 SOL: selling into it returns 100 / (1 + 100/10) ≈ 9.09
    const [p] = buildPositions(ts, T0, T0 + 100, () => ({ price: 0.0001, reserveSol: 10 }));
    expect(p!.markSol).toBeCloseTo(100 / 11, 6);
  });

  it("a new buy after closing opens a new position", () => {
    const ts = [
      trade({ side: "buy", t: T0, tokens: 100, sol: 1 }),
      trade({ side: "sell", t: T0 + 10, tokens: 100, sol: 2 }),
      trade({ side: "buy", t: T0 + 20, tokens: 100, sol: 1 }),
    ];
    const ps = buildPositions(ts, T0, T0 + 1000, () => 0.005);
    expect(ps).toHaveLength(2);
    expect(ps[1]!.closeT).toBeNull();
    expect(ps[1]!.markSol).toBeCloseTo(0.5); // marked at window end
  });

  it("open positions are marked at the window end, unpriced as zero", () => {
    const ts = [trade({ side: "buy", t: T0, tokens: 100, sol: 1 })];
    expect(buildPositions(ts, T0, T0 + 100, () => null)[0]!.pnl).toBeCloseTo(-1);
    expect(buildPositions(ts, T0, T0 + 100, () => 0.02)[0]!.pnl).toBeCloseTo(1);
  });

  it("selling down to dust closes the position", () => {
    const ts = [trade({ side: "buy", t: T0, tokens: 1000, sol: 1 }), trade({ side: "sell", t: T0 + 5, tokens: 995, sol: 2 })];
    expect(buildPositions(ts, T0, T0 + 100, () => null)[0]!.closeT).toBe(T0 + 5);
  });

  it("transfers in taint the position; transfers out exit at the last traded price", () => {
    const tin = [trade({ side: "buy", t: T0, tokens: 100, sol: 1 }), trade({ side: "in", t: T0 + 1, tokens: 100, sol: 0 })];
    expect(buildPositions(tin, T0, T0 + 100, () => null)[0]!.tainted).toBe(true);
    const tout = [trade({ side: "buy", t: T0, tokens: 100, sol: 1 }), trade({ side: "out", t: T0 + 1, tokens: 50, sol: 0 }), trade({ side: "sell", t: T0 + 2, tokens: 50, sol: 1 })];
    const p = buildPositions(tout, T0, T0 + 100, () => null)[0]!;
    expect(p.costSol).toBeCloseTo(1);
    expect(p.transferredOutSol).toBeCloseTo(0.5); // 50 tokens at the buy price 0.01
    expect(p.pnl).toBeCloseTo(0.5);
  });

  it("positions opened before the window are ignored, as are trades after it", () => {
    const ts = [
      trade({ side: "buy", t: T0 - 10, tokens: 100, sol: 1 }),
      trade({ side: "sell", t: T0 + 10, tokens: 100, sol: 5 }),
      trade({ side: "buy", t: T0 + 20, tokens: 100, sol: 1 }),
      trade({ side: "sell", t: T0 + 2000, tokens: 100, sol: 9 }),
    ];
    const ps = buildPositions(ts, T0, T0 + 1000, () => null);
    expect(ps).toHaveLength(1);
    expect(ps[0]!.closeT).toBeNull();
    expect(ps[0]!.proceedsSol).toBe(0);
  });

  it("return on capital uses peak concurrent capital", () => {
    const ts = [
      trade({ side: "buy", t: T0, tokens: 100, sol: 1, mint: "A" }),
      trade({ side: "buy", t: T0 + 1, tokens: 100, sol: 1, mint: "B" }),
      trade({ side: "sell", t: T0 + 2, tokens: 100, sol: 2, mint: "A" }),
      trade({ side: "sell", t: T0 + 3, tokens: 100, sol: 1, mint: "B" }),
      trade({ side: "buy", t: T0 + 4, tokens: 100, sol: 1, mint: "C" }),
      trade({ side: "sell", t: T0 + 5, tokens: 100, sol: 1.5, mint: "C" }),
    ];
    const ps = buildPositions(ts, T0, T0 + 86_400, () => null);
    const m = walletMetrics("W", ps, ts, T0, T0 + 86_400);
    expect(m.pnl).toBeCloseTo(1.5);
    expect(m.peakCapital).toBeCloseTo(2);
    expect(m.roc).toBeCloseTo(0.75);
    expect(m.maxPnlConcentration).toBeCloseTo(1 / 1.5);
  });
});

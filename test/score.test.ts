import { describe, expect, it } from "vitest";
import { defaultCosts } from "../src/config/params.js";
import type { TapeRow } from "../src/data/oracle.js";
import { simulateFollower } from "../src/research/follower.js";
import { sellSchedule, type Tape } from "../src/research/replicate.js";
import { STAGE1 } from "../src/score/config.js";
import { LookaheadError, asLeaderExit, copyScore, fence, formationBuys, lastScorableBuy, replicateFormationBuy, simulateC } from "../src/score/copyability.js";
import { followBuyersOf, followMoveOf, impactOf, impactScores, sellIntoCrowdOf, walletComponents } from "../src/score/impact.js";
import { buildPositions } from "../src/wallets/positions.js";
import { T0, record, trade } from "./helpers.js";

let k = 0;
const row = (o: Partial<TapeRow> & Pick<TapeRow, "blockTime">): TapeRow => ({
  sig: `r${k++}`, wallet: `w${k}`, txIndex: 0, side: "buy", tokenAmount: 100, price: 0.001, poolPriced: true, sol: 0.1, poolQuoteReserveSol: 100, ...o,
});
const L = { sig: "LEAD", wallet: "LEADER", t: T0, sol: 1, reserveAfterSol: 51 };

describe("market impact components", () => {
  it("impact = buy ÷ quote reserve before the buy", () => {
    expect(impactOf(L)).toBeCloseTo(1 / 50);
    expect(impactOf({ ...L, reserveAfterSol: null })).toBeNull();
  });

  it("followBuyers counts distinct non-leader buyers after minus before", () => {
    const rows = [
      row({ blockTime: T0 - 20, wallet: "a" }),
      row({ blockTime: T0, sig: "LEAD", wallet: "LEADER" }),
      ...["b", "c", "c", "d"].map((w, i) => row({ blockTime: T0 + 2 + i, wallet: w })),
      row({ blockTime: T0 + 5, wallet: "LEADER" }), // leader's own follow-up buy: excluded
      row({ blockTime: T0 + 6, wallet: "e", side: "sell" }), // sellers do not count
      row({ blockTime: T0 + 40, wallet: "f" }), // outside 30 s
    ];
    expect(followBuyersOf(rows, L)).toBe(3 - 1);
  });

  it("followMove is post-buy drift minus pre-buy drift, leader excluded", () => {
    const rows = [
      row({ blockTime: T0 - 25, price: 1 }),
      row({ blockTime: T0 - 5, price: 1.1 }),
      row({ blockTime: T0, sig: "LEAD", wallet: "LEADER", price: 5 }),
      row({ blockTime: T0 + 1, price: 1.2 }),
      row({ blockTime: T0 + 2, wallet: "LEADER", price: 9 }),
      row({ blockTime: T0 + 29, price: 1.8 }),
    ];
    expect(followMoveOf(rows, L)).toBeCloseTo(Math.log(1.8 / 1.2) - Math.log(1.1 / 1));
    expect(followMoveOf([row({ blockTime: T0, sig: "LEAD", wallet: "LEADER" })], L)).toBe(0); // quiet pool: nothing moved
  });

  it("sellIntoCrowd: buyers in the last 30 s vs the hourly baseline per 30 s", () => {
    const t = T0 + 3600;
    const quiet = Array.from({ length: 118 }, (_, i) => row({ blockTime: T0 + i * 30 + 1, wallet: `q${i % 3}` })); // 1 buyer per 30 s
    const crowd = ["x", "y", "z"].map((w) => row({ blockTime: t - 10, wallet: w }));
    expect(sellIntoCrowdOf([...quiet, ...crowd], "LEADER", t, T0)).toBe(true);
    expect(sellIntoCrowdOf([...quiet, row({ blockTime: t - 10, wallet: "x" })], "LEADER", t, T0)).toBe(false);
    // the leader's own buys never make a crowd
    expect(sellIntoCrowdOf([...quiet, ...["x", "y", "z"].map(() => row({ blockTime: t - 10, wallet: "LEADER" }))], "LEADER", t, T0)).toBe(false);
    expect(sellIntoCrowdOf([], "LEADER", t, t - 40)).toBeNull(); // less than one baseline bucket
  });

  it("I = mean percentile of the components; too few measurable buys gets none", () => {
    const comp = (x: number, n: number = STAGE1.minIBuys) => ({ impact: x, followMove: x, followBuyers: x, sellIntoCrowd: x, measurableBuys: n, readableSells: 1 });
    const I = impactScores(new Map([["lo", comp(0)], ["mid", comp(1)], ["hi", comp(2)], ["few", comp(9, STAGE1.minIBuys - 1)]]));
    expect(I.get("lo")).toBe(0);
    expect(I.get("mid")).toBe(0.5);
    expect(I.get("hi")).toBe(1);
    expect(I.has("few")).toBe(false);
    const w = walletComponents([{ impact: 1, followMove: 0, followBuyers: 2 }, { impact: null, followMove: 1, followBuyers: 1 }], [true, false, null]);
    expect(w.measurableBuys).toBe(1);
    expect(w.sellIntoCrowd).toBe(0.5);
  });
});

/** In-memory tape: a flat market at 0.001 with a trade every 10 s. Records every read. */
function fakeTape(reads: number[]): Tape & { tradesBefore: (p: string, t: number, s: number) => Promise<{ rows: TapeRow[]; from: number | null }> } {
  const at = (t: number) => row({ blockTime: t, price: 0.002, poolQuoteReserveSol: 100 });
  return {
    async tradesFrom(_p: string, t: number, s: number) {
      reads.push(t + s);
      const rows: TapeRow[] = [];
      for (let x = Math.ceil(t / 10) * 10; x < t + s; x += 10) rows.push(at(x));
      return { rows, complete: true };
    },
    async priorState() {
      return null;
    },
    async stateAt(_p: string, t: number) {
      reads.push(t);
      return { blockTime: t, tokenReserve: 1e6, quoteReserveSol: 100 };
    },
    async tradesBefore(_p: string, t: number, s: number) {
      reads.push(t);
      return { rows: [], from: t - s };
    },
  } as never;
}

describe("copyability score C", () => {
  const costs = defaultCosts();
  const F0 = T0, F1 = T0 + 30 * 86_400;

  it("reuses the Phase A simulator: 5 s tape entry, exit at the leader's own sell", async () => {
    const ts = [trade({ side: "buy", t: F0 + 100, tokens: 1000, sol: 1, poolQuoteReserveSol: 100 }), trade({ side: "sell", t: F0 + 3700, tokens: 1000, sol: 3, poolQuoteReserveSol: 100 })];
    const [pos] = buildPositions(ts, F0, F1, () => null);
    const rec = (await replicateFormationBuy(fakeTape([]), 0, pos!, ts[0]!, 2))!;
    expect(rec.fills["5"]!.entry.price).toBe(0.002); // tape at t + 5
    expect(rec.fills["5"]!.exits[0]!.price).toBeCloseTo(0.003); // leader's own sell
    const x = simulateC(rec, costs)!;
    const direct = simulateFollower(rec, { delay: 5, sizeSol: STAGE1.sizeSol, costs, maxHoldHours: 48 });
    expect(x.ret).toBeCloseTo(direct.ret, 12);
    expect(x.ret).toBeGreaterThan(0.3); // bought at 0.002, sold at 0.003, minus costs
    // eval records get the same semantics
    const ev = record({ sells: sellSchedule(pos!, ts[0]!, ts[0]!.t + 48 * 3600) });
    expect(asLeaderExit(ev, 2).fills["5"]!.exits[0]!.price).toBeCloseTo(0.003);
  });

  it("C needs ≥ minCBuys readable buys and is the top-1%-trimmed mean", () => {
    const r = (ret: number) => ({ ret }) as never;
    expect(copyScore(Array.from({ length: STAGE1.minCBuys - 1 }, () => r(1))).C).toBeNull();
    expect(copyScore([...Array.from({ length: 8 }, () => r(0.1)), r(50), null]).C).toBeCloseTo(0.1);
  });

  it("lookahead: ranking never reads tape after formation end, and later trades change nothing", async () => {
    const buys = [10, 20, 29, 30].map((d) => trade({ side: "buy", t: F0 + d * 86_400 - 7200, tokens: 1000, sol: 1, mint: `M${d}`, sig: `b${d}` }));
    const later = [trade({ side: "sell", t: F1 + 3600, tokens: 1000, sol: 9, mint: "M10" })];
    const pick = (ts: typeof buys) => formationBuys(buildPositions(ts, F0, F1, () => null), F0, F1, 0, "W", new Set()).map((x) => x.buy.sig).sort();
    expect(pick(buys)).toEqual(["b10", "b20"]); // later buys cannot finish their 48 h hold before F1
    expect(pick([...buys, ...later])).toEqual(pick(buys));
    expect(formationBuys(buildPositions(buys, F0, F1, () => null), F0, F1, 0, "W", new Set(["b10"])).map((x) => x.buy.sig)).toEqual(["b20"]); // R-P5

    const reads: number[] = [];
    const tape = fence(fakeTape(reads), F1);
    for (const { pos, buy } of formationBuys(buildPositions(buys, F0, F1, () => null), F0, F1, 0, "W", new Set())) {
      await replicateFormationBuy(tape, 0, pos, buy, 2);
    }
    expect(Math.max(...reads)).toBeLessThanOrEqual(F1);
    expect(lastScorableBuy(F1) + 48 * 3600 + 3600).toBe(F1);
    await expect(tape.tradesFrom("P", F1 - 10, 30)).rejects.toThrow(LookaheadError);
    await expect(tape.tradesBefore("P", F1 + 1, 60)).rejects.toThrow(LookaheadError);
  });
});

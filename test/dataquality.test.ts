import { describe, expect, it } from "vitest";
import { insertSwaps, openDb } from "../src/db/db.js";
import type { SwapRow } from "../src/data/parse/types.js";
import { WSOL } from "../src/data/programs.js";
import { SolUsd } from "../src/data/solusd.js";
import { TradeLoader } from "../src/wallets/load.js";
import { walletMetrics } from "../src/wallets/metrics.js";
import { buildPositions } from "../src/wallets/positions.js";
import { T0, trade } from "./helpers.js";

const row = (over: Partial<SwapRow>): SwapRow => ({
  sig: `s${Math.random()}`, slot: 1, blockTime: T0, txIndex: 0, wallet: "W", mint: "M", side: "buy", tokenAmount: 1000,
  quoteMint: WSOL, quoteAmount: 1, poolPrice: 0.001, poolQuoteMint: WSOL, pool: "P", venue: "pumpswap",
  poolTokenReserve: 1e6, poolQuoteReserve: 100, feeLamports: 5000, txSwapCount: 1, signer: true, tokenProgram: "spl",
  createsMint: false, ...over,
});

describe("quote-leg repair is directional", () => {
  const db = openDb(":memory:");
  insertSwaps(db, [
    row({ sig: "missing", quoteAmount: 0.001 }), // buy paid 1000× less than the pool price: payment leg missing
    row({ sig: "tip", blockTime: T0 + 1, quoteAmount: 0.0011, tokenAmount: 0.1 }), // 0.0001 into the pool + 0.001 tip
    row({ sig: "refund", blockTime: T0 + 2, side: "sell", quoteAmount: 0.003, tokenAmount: 1 }), // sell + rent refund
  ]);
  const ts = new TradeLoader(db, new SolUsd(db)).load("W", T0, T0 + 10);
  const by = (s: string) => ts.find((t) => t.sig === s)!;

  it("revalues a buy missing part of its payment", () => {
    expect(by("missing").sol).toBeCloseTo(1);
    expect(by("missing").quoteRepaired).toBe(true);
  });
  it("keeps real extra cost on a buy (tips) but prices it at the pool", () => {
    expect(by("tip").sol).toBeCloseTo(0.0011);
    expect(by("tip").price).toBeCloseTo(0.001);
    expect(by("tip").quoteRepaired).toBe(false);
  });
  it("revalues a sell that received more than the pool paid", () => {
    expect(by("refund").sol).toBeCloseTo(0.001);
  });
});

describe("wallet metrics ignore untrustworthy positions", () => {
  it("drops positions under the minimum cost", () => {
    const ts = [
      trade({ side: "buy", t: T0, tokens: 100, sol: 0.0002, mint: "DUST" }),
      trade({ side: "sell", t: T0 + 10, tokens: 100, sol: 0.05, mint: "DUST" }),
      trade({ side: "buy", t: T0 + 20, tokens: 100, sol: 1, mint: "REAL" }),
      trade({ side: "sell", t: T0 + 30, tokens: 100, sol: 1.1, mint: "REAL" }),
    ];
    const m = walletMetrics("W", buildPositions(ts, T0, T0 + 100, () => null), ts, T0, T0 + 100);
    expect(m.positions).toBe(1);
    expect(m.roc).toBeCloseTo(0.1);
  });

  it("flags a > 1000× price jump between consecutive trades on one pool", () => {
    const ts = [
      trade({ side: "buy", t: T0, tokens: 17, sol: 0.1, price: 0.0059 }),
      trade({ side: "buy", t: T0 + 400, tokens: 17_000_000, sol: 0.1, price: 5.9e-12 }),
    ];
    const [p] = buildPositions(ts, T0, T0 + 1000, () => null);
    expect(p!.suspect).toBe(true);
    // a real 400× run-up between buy and sell is not flagged
    const ok = buildPositions([
      trade({ side: "buy", t: T0, tokens: 1e6, sol: 0.013, price: 1.3e-8 }),
      trade({ side: "sell", t: T0 + 3600, tokens: 1e6, sol: 5.2, price: 5.2e-6 }),
    ], T0, T0 + 7200, () => null)[0]!;
    expect(ok.suspect).toBe(false);
  });
});

describe("exit on a quiet pool", () => {
  it("sells at the state the last trade left (not a rug) when liquidity remains; rug when it was pulled", async () => {
    const { Oracle } = await import("../src/data/oracle.js");
    const { fillAt } = await import("../src/research/replicate.js");
    const { setProgress, insertPoolStates } = await import("../src/db/db.js");
    const db = openDb(":memory:");
    // leader's sell at T0 on pool P (reserve 50 SOL); nobody trades for days after T0 + 5
    insertSwaps(db, [row({ sig: "lead", side: "sell", blockTime: T0, poolPrice: 0.002, quoteAmount: 2, poolQuoteReserve: 50 })]);
    setProgress(db, "page", "P", T0 + 5, T0 + 10 * 86_400, "done", 0);
    const oracle = new Oracle(db, null, new SolUsd(db));
    const f = await fillAt(oracle, "P", T0 + 5, 2, true);
    expect(f.rug).toBe(false);
    expect(f.price).toBeCloseTo(0.002);
    expect(f.quiet).toBe(true);
    // liquidity withdrawn after the trade (vault state, no trade): rug
    insertPoolStates(db, [{ pool: "P", blockTime: T0 + 2, sig: "lp-out", mint: "M", tokenReserve: 1e6, quoteMint: WSOL, quoteReserve: 0.1 }]);
    expect((await fillAt(oracle, "P", T0 + 5, 2, true)).rug).toBe(true);
    // the last trade long before t with an unread gap: unknown, not a rug
    const g = await fillAt(oracle, "P", T0 + 5 + 86_400 * 11, 2, true);
    expect(g.rug).toBe(false);
  });
});

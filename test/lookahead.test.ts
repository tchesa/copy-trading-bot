import { describe, expect, it } from "vitest";
import { defaultStudy } from "../src/config/params.js";
import { tokenStateAt, type MintInfo } from "../src/data/mints.js";
import { Oracle } from "../src/data/oracle.js";
import type { SwapRow } from "../src/data/parse/types.js";
import { WSOL } from "../src/data/programs.js";
import { SolUsd } from "../src/data/solusd.js";
import { insertDiscovery, insertSwaps, openDb, setProgress } from "../src/db/db.js";
import { RANKINGS, rank } from "../src/ranking/rank.js";
import { discoverCandidates, type Ctx } from "../src/research/pipeline.js";
import { entrySkipReason } from "../src/strategy/filters.js";
import { defaultStrategy } from "../src/strategy/params.js";
import { defaultEligibility, ineligibleReasons } from "../src/wallets/eligibility.js";
import { defaultExclusions, exclusionReasons } from "../src/wallets/exclusions.js";
import { TradeLoader } from "../src/wallets/load.js";
import { walletMetrics } from "../src/wallets/metrics.js";
import { buildPositions } from "../src/wallets/positions.js";
import { T0, record, trade } from "./helpers.js";

const D = 86_400;
const F0 = T0;
const F1 = T0 + 30 * D;

/** Two histories identical before the decision time, wildly different after it. */
function histories() {
  const past = Array.from({ length: 60 }, (_, i) => [
    trade({ side: "buy", t: F0 + i * 40_000, slot: F0 + i * 40_000, mint: `M${i}`, sol: 1, wallet: "W" }),
    trade({ side: "sell", t: F0 + i * 40_000 + 3000, slot: F0 + i * 40_000 + 3000, mint: `M${i}`, sol: 1 + (i % 4) * 0.3, wallet: "W" }),
  ]).flat().filter((x) => x.t < F1);
  // an open position at F1, and futures where it either moons or dies
  const open = trade({ side: "buy", t: F1 - 100, slot: F1 - 100, mint: "OPEN", sol: 2, wallet: "W" });
  const moon = [...past, open, trade({ side: "sell", t: F1 + 10, mint: "OPEN", sol: 200, wallet: "W" }), trade({ side: "buy", t: F1 + 20, mint: "X", sol: 50, wallet: "W" })];
  const dies = [...past, open, trade({ side: "sell", t: F1 + 10, mint: "OPEN", sol: 0.001, wallet: "W" })];
  return { moon, dies };
}

function swapRow(over: Partial<SwapRow>): SwapRow {
  return {
    sig: Math.random().toString(36).slice(2), slot: 1, blockTime: F1, txIndex: 0, wallet: "A", mint: "M", side: "buy", tokenAmount: 1000,
    quoteMint: WSOL, quoteAmount: 1, poolPrice: 0.001, poolQuoteMint: WSOL, pool: "P", venue: "pumpswap", poolTokenReserve: 1e6,
    poolQuoteReserve: 100, feeLamports: 5000, txSwapCount: 1, signer: true, tokenProgram: "spl", createsMint: false, ...over,
  };
}

function db() {
  const d = openDb(":memory:");
  const st = d.prepare("INSERT INTO sol_usd VALUES (?, ?)");
  for (let h = Math.floor((F0 - 3 * D) / 3600) * 3600; h < F1 + 30 * D; h += 3600) st.run(h, 150);
  return d;
}

describe("no decision reads data after its timestamp", () => {
  it("formation metrics, exclusions, eligibility and rankings ignore everything at or after formation end", () => {
    const { moon, dies } = histories();
    const mark = () => 0.01;
    const a = buildPositions(moon, F0, F1, mark);
    const b = buildPositions(dies, F0, F1, mark);
    expect(a).toEqual(b);
    const ma = walletMetrics("W", a, moon, F0, F1);
    const mb = walletMetrics("W", b, dies, F0, F1);
    expect(ma).toEqual(mb);
    expect(exclusionReasons(moon, a, F0, F1, defaultExclusions)).toEqual(exclusionReasons(dies, b, F0, F1, defaultExclusions));
    expect(ineligibleReasons(ma, F1, defaultEligibility())).toEqual(ineligibleReasons(mb, F1, defaultEligibility()));
    for (const id of RANKINGS) expect(rank(id, { all: [ma], eligible: [ma] })).toEqual(rank(id, { all: [mb], eligible: [mb] }));
  });

  it("marks and last prices only read trades strictly before t", () => {
    for (const future of [0.5, 0.000001]) {
      const d = db();
      insertSwaps(d, [swapRow({ blockTime: F1 - 50, poolPrice: 0.002 }), swapRow({ blockTime: F1, poolPrice: future }), swapRow({ blockTime: F1 + 60, poolPrice: future })]);
      const o = new Oracle(d, null, new SolUsd(d));
      expect(o.lastTradeBefore("P", F1, 3600)?.price).toBe(0.002);
    }
  });

  it("the trade loader never returns trades at or after the window end", () => {
    const d = db();
    insertSwaps(d, [swapRow({ wallet: "W", blockTime: F1 - 1 }), swapRow({ wallet: "W", blockTime: F1 })]);
    const ts = new TradeLoader(d, new SolUsd(d)).load("W", F0, F1);
    expect(ts.every((t) => t.t < F1)).toBe(true);
    expect(ts).toHaveLength(1);
  });

  it("discovery only uses sampled swaps before formation end (no wallets found through later winners)", () => {
    const run = (withFuture: boolean) => {
      const d = db();
      const chunks = [{ t: F0, n: 100, first: F0, last: F0 + 10 }];
      for (let day = F0 - D; day < F1 + 10 * D; day += D) setProgress(d, "sample", "pumpswap", day, day + D, "done", 0, chunks);
      const rows = [swapRow({ wallet: "A", blockTime: F0 + 100, quoteAmount: 5 }), swapRow({ wallet: "A", blockTime: F0 + 200, quoteAmount: 5 }), swapRow({ wallet: "B", blockTime: F0 + 300, mint: "N", quoteAmount: 0.01 }), swapRow({ wallet: "B", blockTime: F0 + 400, mint: "N", quoteAmount: 0.01 })];
      if (withFuture) rows.push(...Array.from({ length: 50 }, (_, i) => swapRow({ wallet: `Z${i % 3}`, mint: "N", blockTime: F1 + i * 10, quoteAmount: 1000 })));
      insertDiscovery(d, rows, "pumpswap", F0);
      const ctx = { db: d, solUsd: new SolUsd(d), p: { ...defaultStudy(), minTokenVolumeSol: 1000 } } as unknown as Ctx;
      return discoverCandidates(ctx, F0, F1);
    };
    expect(run(true)).toEqual(run(false));
    expect(run(false).ordered).toEqual(["A"]);
    // B traded only a token below the volume floor
  });

  it("token state at t ignores later authority changes and today's state", () => {
    const m: MintInfo = {
      mint: "M", program: "spl", mintAuthority: null, freezeAuthority: null, transferFeeBps: 0, createdAt: F0, creator: "C",
      launchVenue: "raydium_cpmm", events: [{ t: F0, kind: "mint", value: "AUTH" }, { t: F0, kind: "freeze", value: "AUTH" }, { t: F1 + 100, kind: "mint", value: null }],
      scannedUntil: F0 + 1000,
    };
    const s = tokenStateAt(m, F1);
    expect(s.mintRevoked).toBe(false);
    expect(s.freezeRevoked).toBe(false); // revoked today, but no event before t: not trusted
    expect(tokenStateAt(m, F1 + 200).mintRevoked).toBe(true);
    expect(tokenStateAt({ ...m, launchVenue: "pumpfun" }, F0).mintRevoked).toBe(true);
  });

  it("entry filters ignore everything after the leader's buy", () => {
    const p = { ...defaultStrategy(), requireRevoked: false, minTokenAgeMinutes: 0 };
    const a = record();
    const b = record({ sells: [], path: [[a.t + 10, 1e-9, 0]], fills: { "5": { entry: { t: a.t + 5, price: 1, reserveSol: 0, rug: true }, exits: [], timeStop: null } } });
    expect(entrySkipReason(a, null, p)).toEqual(entrySkipReason(b, null, p));
  });
});

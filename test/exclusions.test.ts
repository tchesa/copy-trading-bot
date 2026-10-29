import { describe, expect, it } from "vitest";
import { defaultExclusions, exclusionReasons } from "../src/wallets/exclusions.js";
import { buildPositions } from "../src/wallets/positions.js";
import { T0, trade } from "./helpers.js";

const D = 86_400;
const run = (ts: ReturnType<typeof trade>[]) => exclusionReasons(ts, buildPositions(ts, T0, T0 + 30 * D, () => null), T0, T0 + 30 * D, defaultExclusions);

describe("exclusions", () => {
  it("flags sandwich bots (buy and sell in the same or adjacent slot)", () => {
    const ts = Array.from({ length: 20 }, (_, i) => [
      trade({ side: "buy", t: T0 + i * 1000, mint: `M${i}`, sol: 1 }),
      trade({ side: "sell", t: T0 + i * 1000 + 1, mint: `M${i}`, sol: 1.01 }),
    ]).flat();
    expect(run(ts)).toContain("mev");
  });

  it("flags multi-swap txs as MEV", () => {
    const ts = Array.from({ length: 10 }, (_, i) => trade({ side: "buy", t: T0 + i * 5000, mint: `M${i}`, txSwapCount: 3 }));
    expect(run(ts)).toContain("mev");
  });

  it("flags high-frequency wallets", () => {
    const ts = Array.from({ length: 30 * 250 }, (_, i) => trade({ side: i % 2 ? "sell" : "buy", t: T0 + i * 300, mint: `M${Math.floor(i / 2)}`, slot: T0 + i * 300 }));
    expect(run(ts)).toContain("hft");
  });

  it("flags arbitrage/market making: tiny holds, balanced flow", () => {
    const ts = Array.from({ length: 40 }, (_, i) => [
      trade({ side: "buy", t: T0 + i * 3000, slot: T0 + i * 3000, mint: `M${i}`, sol: 1 }),
      trade({ side: "sell", t: T0 + i * 3000 + 20, slot: T0 + i * 3000 + 20, mint: `M${i}`, sol: 1.001 }),
    ]).flat();
    expect(run(ts)).toContain("arb");
  });

  it("tags token creators", () => {
    expect(run([trade({ side: "buy", t: T0, createsMint: true })])).toContain("creator");
  });

  it("leaves a human-style trader alone", () => {
    const ts = Array.from({ length: 40 }, (_, i) => [
      trade({ side: "buy", t: T0 + i * 20_000, slot: T0 + i * 20_000, mint: `M${i}`, sol: 1 }),
      trade({ side: "sell", t: T0 + i * 20_000 + 3600, slot: T0 + i * 20_000 + 3600, mint: `M${i}`, sol: i % 3 ? 1.5 : 0.4 }),
    ]).flat();
    expect(run(ts)).toEqual([]);
  });
});

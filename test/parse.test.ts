import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { poolStateFromTx } from "../src/data/parse/poolState.js";
import { parseTx } from "../src/data/parse/tx.js";
import type { RawTx } from "../src/data/parse/types.js";
import { WSOL } from "../src/data/programs.js";
import { isOnCurve } from "../src/util/curve.js";

const fx = JSON.parse(readFileSync("test/fixtures/venues.json", "utf8")) as Record<string, RawTx>;
const expected = JSON.parse(readFileSync("test/fixtures/venues.expected.json", "utf8")) as Record<string, Record<string, unknown>>;

/** Independent check: a wallet's raw token delta in a mint, straight from pre/post balances. */
function rawTokenDelta(tx: RawTx, owner: string, mint: string): number {
  const amt = (b: { uiTokenAmount: { amount: string; decimals: number } }) => Number(b.uiTokenAmount.amount) / 10 ** b.uiTokenAmount.decimals;
  let d = 0;
  for (const b of tx.meta!.postTokenBalances ?? []) if (b.owner === owner && b.mint === mint) d += amt(b);
  for (const b of tx.meta!.preTokenBalances ?? []) if (b.owner === owner && b.mint === mint) d -= amt(b);
  return d;
}

describe("swap parsing per venue (recorded mainnet txs)", () => {
  for (const [venue, tx] of Object.entries(fx)) {
    it(`${venue}: tags venue, matches raw balance deltas, pool price agrees with trade price`, () => {
      const rows = parseTx(tx);
      const exp = expected[venue]!;
      const r = rows.find((x) => x.wallet === exp.wallet && x.mint === exp.mint)!;
      expect(r).toBeDefined();
      expect(r.venue).toBe(venue);
      expect(isOnCurve(r.wallet)).toBe(true);
      const vault = (tx.meta!.postTokenBalances ?? []).find((b) => tx.transaction.message.accountKeys[b.accountIndex]!.pubkey === r.pool);
      expect(vault?.owner && isOnCurve(vault.owner)).toBeFalsy(); // the pool's vault is owned by a program address
      const raw = rawTokenDelta(tx, r.wallet, r.mint);
      expect(r.tokenAmount).toBeCloseTo(Math.abs(raw), 6);
      expect(r.side === "buy").toBe(raw > 0);
      if (r.quoteMint === WSOL && r.poolPrice !== null) {
        const tradePx = r.quoteAmount / r.tokenAmount;
        // the trader's price includes venue fees, tips and bot fees, so it can only be modestly worse than the pool's
        expect(Math.abs(Math.log(tradePx / r.poolPrice))).toBeLessThan(0.15);
      }
      expect({ side: r.side, tokenAmount: r.tokenAmount, quoteAmount: r.quoteAmount, poolPrice: r.poolPrice, pool: r.pool }).toEqual({
        side: exp.side, tokenAmount: exp.tokenAmount, quoteAmount: exp.quoteAmount, poolPrice: exp.poolPrice, pool: exp.pool,
      });
    });
  }

  it("pool state reads the vault's post balance", () => {
    const tx = fx.pumpswap!;
    const r = parseTx(tx).find((x) => x.pool)!;
    const s = poolStateFromTx(tx, r.pool!)!;
    expect(s.tokenReserve).toBeCloseTo(r.poolTokenReserve!, 6);
    expect(s.quoteReserve).toBeCloseTo(r.poolQuoteReserve!, 6);
  });

  it("failed txs produce no swaps", () => {
    const tx = structuredClone(fx.pumpswap!);
    tx.meta!.err = { InstructionError: [0, "Custom"] };
    expect(parseTx(tx)).toEqual([]);
  });

  it("a plain wallet-to-wallet transfer is not a swap", () => {
    const tx = structuredClone(fx.pumpswap!);
    const r = parseTx(tx).find((x) => x.pool)!;
    // zero out all SOL movement: the token move remains, but no quote leg
    tx.meta!.postBalances = tx.meta!.preBalances.slice();
    tx.meta!.fee = 0;
    for (const b of tx.meta!.postTokenBalances ?? []) {
      if (b.mint === WSOL) {
        const pre = tx.meta!.preTokenBalances!.find((p) => p.accountIndex === b.accountIndex);
        if (pre) b.uiTokenAmount = { ...pre.uiTokenAmount };
      }
    }
    const rows = parseTx(tx).filter((x) => x.wallet === r.wallet && x.mint === r.mint);
    expect(rows.every((x) => x.side === "in" || x.side === "out")).toBe(true);
  });
});

describe("quote leg paid in a stablecoin routed through SOL", () => {
  // Real tx: wallet pays 300 USDT, routed USDT -> SOL (Raydium) -> token (PumpSwap); its own SOL moves only by rent dust.
  const tx = JSON.parse(readFileSync("test/fixtures/stable-routed.json", "utf8")) as RawTx;
  const wallet = "FVnRiHQdmgZTkvEToHSLXm23ocbHERyphvdQmofDQWmE";
  const mint = "FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump";

  it("records the 300 USDT leg, not the SOL dust", () => {
    const r = parseTx(tx).find((x) => x.wallet === wallet && x.mint === mint)!;
    expect(r.side).toBe("buy");
    expect(r.quoteMint).toBe("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
    expect(r.quoteAmount).toBeCloseTo(300, 6);
    expect(r.tokenAmount).toBeCloseTo(50229.446042, 6);
    // pool price is in SOL; 300 USDT ≈ 4.34 SOL at the time → own price ≈ pool price
    expect(r.poolPrice! * r.tokenAmount).toBeCloseTo(4.34, 1);
  });
});

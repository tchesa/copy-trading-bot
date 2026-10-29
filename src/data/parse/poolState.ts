import type { PoolStateRow } from "../../db/db.js";
import { PUMP_VIRTUAL_SOL, PUMP_VIRTUAL_TOKENS, QUOTE_MINTS, WSOL } from "../programs.js";
import { detectVenue } from "./tx.js";
import type { RawTx } from "./types.js";

/**
 * Reserves of `pool` (a token vault address) after `tx`, whatever the tx did (swap, add/remove liquidity, migration).
 * Quote side: the same owner's quote-mint account in the tx, or its lamports for native-SOL bonding curves.
 */
export function poolStateFromTx(tx: RawTx, pool: string): PoolStateRow | null {
  const meta = tx.meta;
  if (!meta || meta.err || tx.blockTime == null) return null;
  const keys = tx.transaction.message.accountKeys;
  const idx = keys.findIndex((k) => k.pubkey === pool);
  if (idx < 0) return null;
  const post = (meta.postTokenBalances ?? []).find((b) => b.accountIndex === idx);
  const pre = (meta.preTokenBalances ?? []).find((b) => b.accountIndex === idx);
  const vault = post ?? pre;
  if (!vault) return null;
  const tokenReserve = post ? Number(post.uiTokenAmount.amount) / 10 ** post.uiTokenAmount.decimals : 0;
  const owner = vault.owner;
  let quoteMint: string | null = null;
  let quoteReserve: number | null = null;
  const q = (meta.postTokenBalances ?? []).find((b) => b.owner === owner && QUOTE_MINTS.has(b.mint) && b.accountIndex !== idx);
  let native = false;
  if (q) {
    quoteMint = q.mint;
    quoteReserve = Number(q.uiTokenAmount.amount) / 10 ** q.uiTokenAmount.decimals;
  } else if (owner) {
    const oi = keys.findIndex((k) => k.pubkey === owner);
    if (oi >= 0) {
      quoteMint = WSOL;
      quoteReserve = meta.postBalances[oi]! / 1e9;
      native = true;
    }
  }
  let tr = tokenReserve;
  if (native && detectVenue(tx) === "pumpfun" && quoteReserve !== null) {
    tr += PUMP_VIRTUAL_TOKENS;
    quoteReserve += PUMP_VIRTUAL_SOL;
  }
  return {
    pool,
    blockTime: tx.blockTime,
    sig: tx.transaction.signatures[0]!,
    mint: vault.mint,
    tokenReserve: tr,
    quoteMint,
    quoteReserve,
  };
}

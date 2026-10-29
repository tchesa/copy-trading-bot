import {
  PROGRAM_TO_VENUE,
  PUMP_VIRTUAL_SOL,
  PUMP_VIRTUAL_TOKENS,
  QUOTE_MINTS,
  STABLES,
  TOKEN_2022,
  WSOL,
  type Venue,
} from "../programs.js";
import { isOnCurve } from "../../util/curve.js";
import type { RawTokenBalance, RawTx, Side, SwapRow } from "./types.js";

const LAMPORTS = 1e9;
/** SOL moves smaller than this (after adding back the network fee) are treated as no quote leg. */
const MIN_SOL_LEG = 0.000_05;
const EPS = 1e-12;
/** Only used to pick between a SOL and a stablecoin quote leg in the same tx. */
const ROUGH_SOL_USD = 150;

interface TokAcc {
  address: string;
  owner: string;
  mint: string;
  pre: number;
  post: number;
  program: "spl" | "2022";
}

function ui(b: RawTokenBalance): number {
  return Number(b.uiTokenAmount.amount) / 10 ** b.uiTokenAmount.decimals;
}

/** Programs invoked by the tx (outer and inner instructions). */
function programs(tx: RawTx): Set<string> {
  const s = new Set<string>();
  for (const ix of tx.transaction.message.instructions) s.add(ix.programId);
  for (const inner of tx.meta?.innerInstructions ?? []) for (const ix of inner.instructions) s.add(ix.programId);
  return s;
}

/** Mints initialized by this tx (token creation). */
export function createdMints(tx: RawTx): Set<string> {
  const out = new Set<string>();
  const ixs = [...tx.transaction.message.instructions, ...(tx.meta?.innerInstructions ?? []).flatMap((x) => x.instructions)];
  for (const ix of ixs) {
    const p = ix.parsed as { type?: string; info?: { mint?: string } } | undefined;
    if (p && typeof p === "object" && (p.type === "initializeMint" || p.type === "initializeMint2") && p.info?.mint) out.add(p.info.mint);
  }
  return out;
}

export function detectVenue(tx: RawTx): Venue {
  const found = new Set<Venue>();
  for (const p of programs(tx)) {
    const v = PROGRAM_TO_VENUE.get(p);
    if (v) found.add(v);
  }
  return found.size === 1 ? [...found][0]! : "other";
}

/**
 * Venue-agnostic swap extraction from balance deltas.
 *
 * Every account is attributed to an owner (token accounts to their `owner`, other accounts to themselves),
 * and SOL deltas are summed per owner from lamports, so wrapped SOL and token-account rent net out.
 * Traders are on-curve owners whose holding of a non-quote mint changed; the pool is the off-curve owner
 * with the opposite change in that mint.
 */
export function parseTx(tx: RawTx): SwapRow[] {
  const meta = tx.meta;
  if (!meta || meta.err || tx.blockTime == null) return [];
  const keys = tx.transaction.message.accountKeys;
  const sig = tx.transaction.signatures[0]!;

  const tokAcc = new Map<number, TokAcc>();
  const add = (b: RawTokenBalance, which: "pre" | "post") => {
    let a = tokAcc.get(b.accountIndex);
    if (!a) {
      a = {
        address: keys[b.accountIndex]!.pubkey,
        owner: b.owner ?? keys[b.accountIndex]!.pubkey,
        mint: b.mint,
        pre: 0,
        post: 0,
        program: b.programId === TOKEN_2022 ? "2022" : "spl",
      };
      tokAcc.set(b.accountIndex, a);
    }
    a[which] = ui(b);
  };
  for (const b of meta.preTokenBalances ?? []) add(b, "pre");
  for (const b of meta.postTokenBalances ?? []) add(b, "post");

  const sol = new Map<string, number>(); // owner -> SOL delta
  const postLamports = new Map<string, number>(); // key -> post lamports
  for (let i = 0; i < keys.length; i++) {
    const owner = tokAcc.get(i)?.owner ?? keys[i]!.pubkey;
    const d = (meta.postBalances[i]! - meta.preBalances[i]!) / LAMPORTS;
    sol.set(owner, (sol.get(owner) ?? 0) + d);
    postLamports.set(keys[i]!.pubkey, meta.postBalances[i]!);
  }
  const feePayer = keys[0]!.pubkey;
  sol.set(feePayer, (sol.get(feePayer) ?? 0) + meta.fee / LAMPORTS);

  // owner -> mint -> delta; plus post holdings for reserves
  const tok = new Map<string, Map<string, number>>();
  const held = new Map<string, number>(); // `${owner}|${mint}` -> post amount
  const programOf = new Map<string, "spl" | "2022">();
  for (const a of tokAcc.values()) {
    programOf.set(a.mint, a.program);
    const k = `${a.owner}|${a.mint}`;
    held.set(k, (held.get(k) ?? 0) + a.post);
    if (a.mint === WSOL) continue; // already in lamports
    let m = tok.get(a.owner);
    if (!m) tok.set(a.owner, (m = new Map()));
    m.set(a.mint, (m.get(a.mint) ?? 0) + a.post - a.pre);
  }

  const venue = detectVenue(tx);
  const created = createdMints(tx);
  const signers = new Set(keys.filter((k) => k.signer).map((k) => k.pubkey));
  const rows: SwapRow[] = [];

  for (const [owner, mints] of tok) {
    if (!isOnCurve(owner)) continue;
    const tokenMoves = [...mints].filter(([mint, d]) => !QUOTE_MINTS.has(mint) && Math.abs(d) > EPS);
    if (tokenMoves.length === 0) continue;
    const solD = sol.get(owner) ?? 0;
    const stable = [...mints].find(([mint, d]) => STABLES.has(mint) && Math.abs(d) > EPS);

    for (const [mint, d] of tokenMoves) {
      let side: Side = d > 0 ? "in" : "out";
      let quoteMint: string | null = null;
      let quoteAmount = 0;
      // Priced only when exactly one token moved and a quote leg moved the other way.
      if (tokenMoves.length === 1) {
        const solLeg = Math.abs(solD) >= MIN_SOL_LEG && Math.sign(solD) === -Math.sign(d);
        const stableLeg = !!stable && Math.sign(stable[1]) === -Math.sign(d);
        // Paid in a stablecoin routed through SOL: the wallet's SOL moves only by dust/rent. Take the leg worth more
        // (rough SOL price; the loader re-checks every leg against the pool price).
        if (solLeg && stableLeg && Math.abs(stable![1]) > Math.abs(solD) * ROUGH_SOL_USD) {
          quoteMint = stable![0];
          quoteAmount = Math.abs(stable![1]);
        } else if (solLeg) {
          quoteMint = WSOL;
          quoteAmount = Math.abs(solD);
        } else if (stable && Math.sign(stable[1]) === -Math.sign(d)) {
          quoteMint = stable[0];
          quoteAmount = Math.abs(stable[1]);
        }
        if (quoteMint) side = d > 0 ? "buy" : "sell";
      }

      // Pool: the off-curve token account (vault) with the largest opposite move in this mint.
      // Vault addresses are unique per pool even when many pools share one authority.
      let vault: TokAcc | null = null;
      for (const a of tokAcc.values()) {
        if (a.mint !== mint || isOnCurve(a.owner)) continue;
        const pd = a.post - a.pre;
        if (Math.sign(pd) === -Math.sign(d) && (!vault || Math.abs(pd) > Math.abs(vault.post - vault.pre))) vault = a;
      }
      const pool = vault?.address ?? null;
      let poolPrice: number | null = null;
      let poolQuoteMint: string | null = null;
      let poolTokenReserve: number | null = null;
      let poolQuoteReserve: number | null = null;
      // Trust the pool's flows only if it absorbed most of the trader's tokens (not a P2P/bundled fill).
      if (vault && Math.abs(vault.post - vault.pre) >= 0.5 * Math.abs(d)) {
        const poolD = vault.post - vault.pre;
        // Quote vault: same owner, quote mint, moving the other way. Native-SOL curves hold lamports on the owner.
        let qv: TokAcc | null = null;
        for (const a of tokAcc.values()) {
          if (a.owner !== vault.owner || !QUOTE_MINTS.has(a.mint)) continue;
          const qd = a.post - a.pre;
          if (Math.sign(qd) === -Math.sign(poolD) && (!qv || Math.abs(qd) > Math.abs(qv.post - qv.pre))) qv = a;
        }
        if (qv) {
          const qd = Math.abs(qv.post - qv.pre);
          if (qd >= (qv.mint === WSOL ? MIN_SOL_LEG : 0.01)) {
            poolQuoteMint = qv.mint;
            poolPrice = qd / Math.abs(poolD);
            poolQuoteReserve = qv.post;
          }
        } else {
          const lam = (sol.get(vault.owner) ?? 0);
          if (Math.sign(lam) === -Math.sign(poolD) && Math.abs(lam) >= MIN_SOL_LEG) {
            poolQuoteMint = WSOL;
            poolPrice = Math.abs(lam) / Math.abs(poolD);
            poolQuoteReserve = (postLamports.get(vault.owner) ?? 0) / LAMPORTS;
          }
        }
        if (poolQuoteMint) {
          poolTokenReserve = vault.post;
          if (venue === "pumpfun" && poolQuoteMint === WSOL && !qv) {
            poolTokenReserve += PUMP_VIRTUAL_TOKENS;
            poolQuoteReserve = (poolQuoteReserve ?? 0) + PUMP_VIRTUAL_SOL;
          }
        }
      }

      rows.push({
        sig,
        slot: tx.slot,
        blockTime: tx.blockTime,
        txIndex: tx.transactionIndex ?? 0,
        wallet: owner,
        mint,
        side,
        tokenAmount: Math.abs(d),
        quoteMint,
        quoteAmount,
        poolPrice,
        poolQuoteMint,
        pool,
        venue,
        poolTokenReserve,
        poolQuoteReserve,
        feeLamports: owner === feePayer ? meta.fee : 0,
        txSwapCount: 0,
        signer: signers.has(owner),
        tokenProgram: programOf.get(mint) ?? "spl",
        createsMint: created.has(mint),
      });
    }
  }
  const priced = rows.filter((r) => r.side === "buy" || r.side === "sell").length;
  for (const r of rows) r.txSwapCount = priced;
  return rows;
}

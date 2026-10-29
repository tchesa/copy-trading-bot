import type { DatabaseSync } from "node:sqlite";
import { BudgetExceeded, type Helius } from "./helius.js";
import { LAUNCHPADS, TOKEN_2022, type Venue } from "./programs.js";
import { detectVenue } from "./parse/tx.js";
import type { RawTx } from "./parse/types.js";

interface AuthEvent {
  t: number;
  kind: "mint" | "freeze";
  value: string | null;
}

export interface MintInfo {
  mint: string;
  program: "spl" | "2022";
  mintAuthority: string | null;
  freezeAuthority: string | null;
  transferFeeBps: number;
  createdAt: number | null;
  creator: string | null;
  launchVenue: Venue | null;
  events: AuthEvent[];
  /** Last block time scanned in the mint's early history. */
  scannedUntil: number | null;
}

export interface TokenStateAt {
  ageSeconds: number | null;
  mintRevoked: boolean;
  freezeRevoked: boolean;
  transferFeeBps: number;
  creator: string | null;
}

type ParsedIx = { programId?: string; parsed?: { type?: string; info?: Record<string, unknown> } };

function allIxs(tx: RawTx): ParsedIx[] {
  const outer = tx.transaction.message.instructions as ParsedIx[];
  const inner = (tx.meta?.innerInstructions ?? []).flatMap((x) => x.instructions as ParsedIx[]);
  return [...outer, ...inner];
}

/** Authority events for `mint` from parsed initializeMint / setAuthority instructions. */
export function authorityEvents(tx: RawTx, mint: string): AuthEvent[] {
  const out: AuthEvent[] = [];
  const t = tx.blockTime ?? 0;
  for (const ix of allIxs(tx)) {
    const p = ix.parsed;
    if (!p?.type || !p.info) continue;
    const info = p.info;
    if ((p.type === "initializeMint" || p.type === "initializeMint2") && info.mint === mint) {
      out.push({ t, kind: "mint", value: (info.mintAuthority as string) ?? null });
      out.push({ t, kind: "freeze", value: (info.freezeAuthority as string) ?? null });
    } else if (p.type === "setAuthority" && (info.mint === mint || info.account === mint)) {
      const kind = info.authorityType === "freezeAccount" ? "freeze" : info.authorityType === "mintTokens" ? "mint" : null;
      if (kind) out.push({ t, kind, value: (info.newAuthority as string) ?? null });
    }
  }
  return out;
}

export async function loadMint(db: DatabaseSync, helius: Helius | null, mint: string): Promise<MintInfo | null> {
  const row = db.prepare("SELECT * FROM mints WHERE mint = ?").get(mint) as Record<string, unknown> | undefined;
  if (row) {
    const ev = JSON.parse((row.authority_events as string) ?? "{}") as { events?: AuthEvent[]; scannedUntil?: number; launchVenue?: Venue };
    return {
      mint,
      program: row.program as "spl" | "2022",
      mintAuthority: row.mint_authority as string | null,
      freezeAuthority: row.freeze_authority as string | null,
      transferFeeBps: Number(row.transfer_fee_bps),
      createdAt: row.created_at as number | null,
      creator: row.creator as string | null,
      launchVenue: ev.launchVenue ?? null,
      events: ev.events ?? [],
      scannedUntil: ev.scannedUntil ?? null,
    };
  }
  if (!helius) return null;
  try {
    const acc = (await helius.accountInfo(mint, "mint")) as
      | { owner: string; data: { parsed?: { info?: Record<string, unknown> } } }
      | null;
    const info = acc?.data?.parsed?.info ?? {};
    let fee = 0;
    for (const e of (info.extensions as Array<{ extension: string; state: Record<string, { transferFeeBasisPoints?: number }> }>) ?? []) {
      if (e.extension === "transferFeeConfig")
        fee = Math.max(e.state.newerTransferFee?.transferFeeBasisPoints ?? 0, e.state.olderTransferFee?.transferFeeBasisPoints ?? 0);
    }
    const { txs } = await helius.txPage(mint, { order: "asc", limit: 100 }, "mint");
    const first = txs[0];
    const events = txs.flatMap((x) => authorityEvents(x, mint));
    const m: MintInfo = {
      mint,
      program: acc?.owner === TOKEN_2022 ? "2022" : "spl",
      mintAuthority: (info.mintAuthority as string) ?? null,
      freezeAuthority: (info.freezeAuthority as string) ?? null,
      transferFeeBps: fee,
      createdAt: first?.blockTime ?? null,
      creator: first?.transaction.message.accountKeys[0]?.pubkey ?? null,
      launchVenue: first ? detectVenue(first) : null,
      events,
      scannedUntil: txs.length ? (txs[txs.length - 1]!.blockTime ?? null) : null,
    };
    db.prepare("INSERT OR REPLACE INTO mints VALUES (?,?,?,?,?,?,?,?,?,?)").run(
      mint, m.program, (info.decimals as number) ?? null, m.mintAuthority, m.freezeAuthority, fee, m.createdAt, m.creator,
      JSON.stringify({ events, scannedUntil: m.scannedUntil, launchVenue: m.launchVenue }), Math.floor(Date.now() / 1000),
    );
    return m;
  } catch (e) {
    if (e instanceof BudgetExceeded) return null;
    throw e;
  }
}

/**
 * Token state as of time t (R-I3). Authority status is replayed from events up to t. Without an event, the
 * authority counts as not revoked (today's state would be lookahead), except for launchpad tokens, which are
 * created revoked. Transfer fee is the current config (Token-2022 fee changes are rare; noted as a caveat).
 */
export function tokenStateAt(m: MintInfo, t: number): TokenStateAt {
  const launch = m.launchVenue !== null && LAUNCHPADS.has(m.launchVenue);
  const statusAt = (kind: "mint" | "freeze", current: string | null): boolean => {
    if (launch) return true;
    let known: string | null | undefined;
    for (const e of m.events) if (e.kind === kind && e.t <= t) known = e.value;
    if (known !== undefined) return known === null;
    // No event seen: today's state can't be used (lookahead), so treat as not revoked.
    void current;
    return false;
  };
  return {
    ageSeconds: m.createdAt === null ? null : t - m.createdAt,
    mintRevoked: statusAt("mint", m.mintAuthority),
    freezeRevoked: statusAt("freeze", m.freezeAuthority),
    transferFeeBps: m.transferFeeBps,
    creator: m.creator,
  };
}

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SwapRow } from "../data/parse/types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS swaps (
  sig TEXT NOT NULL,
  wallet TEXT NOT NULL,
  mint TEXT NOT NULL,
  slot INTEGER NOT NULL,
  block_time INTEGER NOT NULL,       -- unix seconds
  tx_index INTEGER NOT NULL,
  side TEXT NOT NULL,                -- buy | sell | in | out
  token_amount REAL NOT NULL,
  quote_mint TEXT,
  quote_amount REAL NOT NULL,
  pool_price REAL,
  pool_quote_mint TEXT,
  pool TEXT,                         -- token vault address of the pool
  venue TEXT NOT NULL,
  pool_token_reserve REAL,
  pool_quote_reserve REAL,
  fee_lamports INTEGER NOT NULL,
  tx_swap_count INTEGER NOT NULL,
  signer INTEGER NOT NULL,
  token_program TEXT NOT NULL,
  creates_mint INTEGER NOT NULL,
  PRIMARY KEY (sig, wallet, mint)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS swaps_wallet_time ON swaps (wallet, block_time);
CREATE INDEX IF NOT EXISTS swaps_pool_time ON swaps (pool, block_time);
CREATE INDEX IF NOT EXISTS swaps_mint_time ON swaps (mint, block_time);
CREATE INDEX IF NOT EXISTS swaps_time ON swaps (block_time);

-- Discovery sample only (R-W1): swaps seen in time-uniform random samples of venue programs.
CREATE TABLE IF NOT EXISTS discovery (
  sig TEXT NOT NULL,
  wallet TEXT NOT NULL,
  mint TEXT NOT NULL,
  block_time INTEGER NOT NULL,
  side TEXT NOT NULL,
  quote_mint TEXT,
  quote_amount REAL NOT NULL,
  venue TEXT NOT NULL,
  sample_venue TEXT NOT NULL,        -- program sampled (for volume scaling)
  sample_day INTEGER NOT NULL,
  PRIMARY KEY (sig, wallet, mint)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS discovery_time ON discovery (block_time);

-- Which ranges of which addresses have been fetched (resumable backfill).
CREATE TABLE IF NOT EXISTS fetch_progress (
  kind TEXT NOT NULL,                -- sample | wallet | page | sigcount | mint
  key TEXT NOT NULL,                 -- venue, wallet, pool or mint
  from_ts INTEGER NOT NULL,
  to_ts INTEGER NOT NULL,
  status TEXT NOT NULL,              -- done | capped | missing
  rows INTEGER NOT NULL,
  extra TEXT,                        -- JSON (e.g. signature count, last fetched time)
  PRIMARY KEY (kind, key, from_ts)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS credit_log (
  day TEXT NOT NULL,                 -- YYYY-MM-DD (UTC) the credits were spent
  kind TEXT NOT NULL,
  calls INTEGER NOT NULL,
  credits INTEGER NOT NULL,
  PRIMARY KEY (day, kind)
) WITHOUT ROWID;

-- Pool reserves after every fetched tx touching a pool vault (captures liquidity pulls, not just swaps).
CREATE TABLE IF NOT EXISTS pool_states (
  pool TEXT NOT NULL,                -- token vault address
  block_time INTEGER NOT NULL,
  sig TEXT NOT NULL,
  mint TEXT NOT NULL,
  token_reserve REAL NOT NULL,
  quote_mint TEXT,
  quote_reserve REAL,                -- effective (pump.fun curves include virtual SOL)
  PRIMARY KEY (pool, block_time, sig)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS sol_usd (
  hour INTEGER PRIMARY KEY,          -- unix seconds, start of hour
  price REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS mints (
  mint TEXT PRIMARY KEY,
  program TEXT NOT NULL,             -- spl | 2022
  decimals INTEGER,
  mint_authority TEXT,               -- current (null = revoked)
  freeze_authority TEXT,
  transfer_fee_bps INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER,                -- block time of first tx touching the mint
  creator TEXT,                      -- fee payer of the first tx
  authority_events TEXT,             -- JSON [{t, kind, value}] from the mint's history (null if not fetched)
  fetched_at INTEGER NOT NULL
);
`;

export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 60000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  db.exec(SCHEMA);
  return db;
}

export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function insertSwaps(db: DatabaseSync, rows: SwapRow[]): number {
  if (rows.length === 0) return 0;
  const stmt = db.prepare(`INSERT OR IGNORE INTO swaps VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  let n = 0;
  tx(db, () => {
    for (const r of rows) {
      const res = stmt.run(
        r.sig, r.wallet, r.mint, r.slot, r.blockTime, r.txIndex, r.side, r.tokenAmount, r.quoteMint, r.quoteAmount,
        r.poolPrice, r.poolQuoteMint, r.pool, r.venue, r.poolTokenReserve, r.poolQuoteReserve, r.feeLamports,
        r.txSwapCount, r.signer ? 1 : 0, r.tokenProgram, r.createsMint ? 1 : 0,
      );
      n += Number(res.changes);
    }
  });
  return n;
}

export interface Progress {
  status: string;
  rows: number;
  toTs: number;
  extra: string | null;
}

export function getProgress(db: DatabaseSync, kind: string, key: string, fromTs: number): Progress | undefined {
  const r = db
    .prepare("SELECT status, rows, to_ts AS toTs, extra FROM fetch_progress WHERE kind = ? AND key = ? AND from_ts = ?")
    .get(kind, key, fromTs) as Progress | undefined;
  return r;
}

export function setProgress(
  db: DatabaseSync, kind: string, key: string, fromTs: number, toTs: number, status: string, rows: number, extra?: unknown,
): void {
  db.prepare("INSERT OR REPLACE INTO fetch_progress VALUES (?,?,?,?,?,?,?)").run(
    kind, key, fromTs, toTs, status, rows, extra === undefined ? null : JSON.stringify(extra),
  );
}

export function logCredits(db: DatabaseSync, kind: string, credits: number): void {
  const day = new Date().toISOString().slice(0, 10);
  db.prepare(
    `INSERT INTO credit_log VALUES (?,?,1,?) ON CONFLICT(day, kind) DO UPDATE SET calls = calls + 1, credits = credits + excluded.credits`,
  ).run(day, kind, credits);
}

export function creditsUsed(db: DatabaseSync): number {
  const r = db.prepare("SELECT COALESCE(SUM(credits),0) AS c FROM credit_log").get() as { c: number };
  return Number(r.c);
}

export function creditsByKind(db: DatabaseSync): Record<string, { calls: number; credits: number }> {
  const out: Record<string, { calls: number; credits: number }> = {};
  for (const r of db.prepare("SELECT kind, SUM(calls) c, SUM(credits) k FROM credit_log GROUP BY kind").all() as Array<{ kind: string; c: number; k: number }>)
    out[r.kind] = { calls: Number(r.c), credits: Number(r.k) };
  return out;
}

export interface PoolStateRow {
  pool: string;
  blockTime: number;
  sig: string;
  mint: string;
  tokenReserve: number;
  quoteMint: string | null;
  quoteReserve: number | null;
}

export function insertPoolStates(db: DatabaseSync, rows: PoolStateRow[]): void {
  if (rows.length === 0) return;
  const stmt = db.prepare("INSERT OR IGNORE INTO pool_states VALUES (?,?,?,?,?,?,?)");
  tx(db, () => {
    for (const r of rows) stmt.run(r.pool, r.blockTime, r.sig, r.mint, r.tokenReserve, r.quoteMint, r.quoteReserve);
  });
}

export function insertDiscovery(db: DatabaseSync, rows: SwapRow[], sampleVenue: string, sampleDay: number): void {
  const stmt = db.prepare("INSERT OR IGNORE INTO discovery VALUES (?,?,?,?,?,?,?,?,?,?)");
  tx(db, () => {
    for (const r of rows)
      if (r.side === "buy" || r.side === "sell")
        stmt.run(r.sig, r.wallet, r.mint, r.blockTime, r.side, r.quoteMint, r.quoteAmount, r.venue, sampleVenue, sampleDay);
  });
}

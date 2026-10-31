/**
 * Fomo trade → on-chain wallet (the October fomo-wallets matching): for each trade Fomo shows, read the token's txs
 * in [minute − 5 s, minute + 65 s), parse swaps, and vote for every wallet with a swap of the same side and token
 * amount within the shown rounding. The wallet with the most votes wins. Resolutions are cached by handle in
 * data/fomo/wallets.json; votes accumulate across snapshots (a trade is only ever looked up once).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Helius } from "../data/helius.js";
import { parseTx } from "../data/parse/tx.js";
import type { SwapRow } from "../data/parse/types.js";
import { FORWARD } from "./config.js";
import { parseFomoTrade, type Snapshot, type SnapshotTrader } from "./snapshot.js";

export const WALLETS_FILE = join("data", "fomo", "wallets.json");
const MAX_PAGES = 6;

export interface Resolution {
  handle: string;
  wallet: string | null;
  /** "given": address supplied in a snapshot; "matched": from trade matching. */
  source: "given" | "matched" | "none";
  votes: number;
  runnerUp: number;
  /** Trades looked up so far. */
  tried: number;
  weak: boolean;
  /** Votes per wallet, accumulated over every trade looked up. */
  tally: Record<string, number>;
  /** Trade keys already looked up (mint|text). */
  keys: string[];
  details: string[];
}

export type WalletCache = Record<string, Resolution>;

export function loadWalletCache(file = WALLETS_FILE): WalletCache {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as WalletCache) : {};
}

export function saveWalletCache(c: WalletCache, file = WALLETS_FILE): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(c, null, 1));
}

/** Best wallet from a tally; ties broken by address so the pick is deterministic (and flagged weak). */
export function decide(tally: Record<string, number>): { wallet: string | null; votes: number; runnerUp: number } {
  const best = Object.entries(tally).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return { wallet: best[0]?.[0] ?? null, votes: best[0]?.[1] ?? 0, runnerUp: best[1]?.[1] ?? 0 };
}

export function isWeak(r: Pick<Resolution, "source" | "votes" | "runnerUp">): boolean {
  return r.source === "matched" && (r.votes <= FORWARD.weakVotes || r.runnerUp >= r.votes);
}

/** Wallets whose swap matches one Fomo trade line. */
export function matchingWallets(rows: SwapRow[], mint: string, side: "buy" | "sell", amount: number, tol: number): string[] {
  const hits = rows.filter((r) => r.mint === mint && r.side === side && Math.abs(r.tokenAmount / amount - 1) <= tol);
  return [...new Set(hits.map((r) => r.wallet))];
}

/** Count, without fetching, the trade lookups a snapshot still needs (for --estimate). */
export function pendingLookups(s: Snapshot, cache: WalletCache): number {
  let n = 0;
  for (const x of s.traders) {
    if (x.wallet) continue;
    const done = new Set(cache[x.handle]?.keys ?? []);
    n += x.trades.filter((tr) => !done.has(`${tr.mint}|${tr.text}`)).length;
  }
  return n;
}

/** Resolve one trader, looking up only trades not tried before. Updates the cache entry in place. */
export async function resolveTrader(helius: Helius | null, s: Snapshot, x: SnapshotTrader, cache: WalletCache): Promise<Resolution> {
  const prev = cache[x.handle];
  if (x.wallet) {
    const r: Resolution = { handle: x.handle, wallet: x.wallet, source: "given", votes: 0, runnerUp: 0, tried: prev?.tried ?? 0, weak: false, tally: prev?.tally ?? {}, keys: prev?.keys ?? [], details: [...(prev?.details ?? []), `given in ${s.date}`] };
    cache[x.handle] = r;
    return r;
  }
  if (prev?.source === "given") return prev;
  const r: Resolution = prev ? { ...prev, tally: { ...prev.tally }, keys: [...prev.keys], details: [...prev.details] } : {
    handle: x.handle, wallet: null, source: "none", votes: 0, runnerUp: 0, tried: 0, weak: true, tally: {}, keys: [], details: [],
  };
  for (const tr of x.trades) {
    const key = `${tr.mint}|${tr.text}`;
    if (r.keys.includes(key)) continue;
    const p = parseFomoTrade(tr.text, s.utcOffsetMinutes, s.takenAt);
    if (!p) {
      r.details.push(`${s.date}: unreadable trade "${tr.text}"`);
      r.keys.push(key);
      continue;
    }
    if (!helius) continue; // dry run
    const rows: SwapRow[] = [];
    let token: string | null = null;
    let pages = 0;
    do {
      const page = await helius.txPage(tr.mint, { from: p.t0 - 5, to: p.t0 + 65, limit: 100, ...(token ? { paginationToken: token } : {}) }, "fomo-match");
      pages++;
      rows.push(...page.txs.flatMap(parseTx));
      token = page.txs.length < 100 ? null : page.next;
    } while (token && pages < MAX_PAGES);
    const ws = matchingWallets(rows, tr.mint, p.side, p.amount, p.tol);
    for (const w of ws) r.tally[w] = (r.tally[w] ?? 0) + 1;
    r.keys.push(key);
    r.tried++;
    r.details.push(`${s.date}: ${p.side} ${tr.text.split(" ").slice(-2).join(" ")} → ${ws.length} wallet(s)${pages >= MAX_PAGES && token ? " (page cap: token too busy)" : ""}`);
  }
  const d = decide(r.tally);
  Object.assign(r, d, { source: d.wallet ? "matched" : "none" });
  r.weak = isWeak(r);
  cache[x.handle] = r;
  return r;
}

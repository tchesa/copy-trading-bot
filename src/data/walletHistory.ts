import type { DatabaseSync } from "node:sqlite";
import { getProgress, insertSwaps, setProgress } from "../db/db.js";
import type { Helius } from "./helius.js";
import { parseTx } from "./parse/tx.js";

export interface Screen {
  /** Signatures seen in the range (capped at 1000). */
  n: number;
  /** Lower bound on txs per day. */
  perDay: number;
  hft: boolean;
}

/**
 * Cheap bot screen (10 credits): one signature page. If 1000 signatures fit in less than
 * 1000 / maxTradesPerDay days, the wallet is a high-frequency bot.
 */
export async function screenWallet(
  db: DatabaseSync, helius: Helius, wallet: string, from: number, to: number, maxTradesPerDay: number,
): Promise<Screen> {
  const prior = getProgress(db, "sigcount", wallet, from);
  let n: number;
  let span: number;
  if (prior && prior.toTs === to) {
    ({ n, span } = JSON.parse(prior.extra ?? "{}") as { n: number; span: number });
  } else {
    const { sigs } = await helius.sigPage(wallet, { from, to, limit: 1000 }, "screen");
    n = sigs.length;
    const times = sigs.map((s) => s.blockTime ?? from);
    span = n >= 1000 ? Math.max(1, Math.max(...times) - Math.min(...times)) : to - from;
    setProgress(db, "sigcount", wallet, from, to, "done", n, { n, span });
  }
  const perDay = n / (span / 86_400);
  return { n, perDay, hft: perDay > maxTradesPerDay };
}

/**
 * Ensure the wallet's full history is stored for [from, to). Coverage is one contiguous interval per wallet
 * (kind 'wallet'), extended backward or forward as needed. Returns false if a gap exceeds `maxTx` (too active):
 * the gap is recorded as kind 'wallet-cap' and the existing coverage is kept, so ranges already stored stay usable.
 * (Before this, a cap replaced the coverage row, so a wallet capped while extending for a later step lost the
 * coverage an earlier step had used.)
 */
export async function ensureHistory(
  db: DatabaseSync, helius: Helius, wallet: string, from: number, to: number, maxTx: number,
): Promise<boolean> {
  const cov = db
    .prepare("SELECT from_ts AS f, to_ts AS t, status FROM fetch_progress WHERE kind = 'wallet' AND key = ?")
    .get(wallet) as { f: number; t: number; status: string } | undefined;
  if (cov?.status === "capped") return false; // legacy rows: coverage unknown
  const gaps: Array<[number, number]> = [];
  if (!cov) gaps.push([from, to]);
  else {
    if (from < cov.f) gaps.push([from, cov.f]);
    if (to > cov.t) gaps.push([cov.t, to]);
  }
  if (gaps.length === 0) return true;
  // A gap overlapping a range that already exceeded the cap would exceed it again: don't pay for it twice.
  const capped = db.prepare("SELECT 1 FROM fetch_progress WHERE kind = 'wallet-cap' AND key = ? AND from_ts < ? AND to_ts > ? LIMIT 1");
  for (const [a, b] of gaps) if (capped.get(wallet, b, a)) return false;

  // Covered interval so far (null = nothing yet). Gaps are adjacent to it, so it stays contiguous.
  let covered: [number, number] | null = cov ? [cov.f, cov.t] : null;
  const save = () => {
    db.prepare("DELETE FROM fetch_progress WHERE kind = 'wallet' AND key = ?").run(wallet);
    if (covered) setProgress(db, "wallet", wallet, covered[0], covered[1], "done", 0);
  };
  for (const [a, b] of gaps) {
    let token: string | null = null;
    let count = 0;
    do {
      const page = await helius.txPage(
        wallet,
        { from: a, to: b, limit: 100, tokenAccounts: "balanceChanged", ...(token ? { paginationToken: token } : {}) },
        "wallet",
      );
      insertSwaps(db, page.txs.flatMap(parseTx).filter((r) => r.wallet === wallet));
      count += page.txs.length;
      token = page.txs.length < 100 ? null : page.next;
      if (count > maxTx) {
        setProgress(db, "wallet-cap", wallet, a, b, "capped", count);
        save(); // keep what is covered (including gaps completed above)
        return false;
      }
    } while (token);
    covered = covered ? [Math.min(covered[0], a), Math.max(covered[1], b)] : [a, b];
  }
  save();
  return true;
}

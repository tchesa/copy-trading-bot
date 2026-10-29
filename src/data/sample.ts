import type { DatabaseSync } from "node:sqlite";
import { getProgress, insertDiscovery, insertSwaps, setProgress } from "../db/db.js";
import { logger } from "../log.js";
import { hashSeed, rng } from "../util/rng.js";
import type { Helius } from "./helius.js";
import { parseTx } from "./parse/tx.js";
import { VENUES } from "./programs.js";

const log = logger("sample");
export const DAY = 86_400;

export interface SampleChunk {
  t: number;
  n: number;
  first: number | null;
  last: number | null;
}

/**
 * Discovery sample for one venue-day: `perDay` stratified random times, 100 consecutive txs of the venue's
 * program from each. This is a time-uniform random sample of swaps, independent of what happens later (R-W1).
 */
export async function sampleVenueDay(
  db: DatabaseSync, helius: Helius, venue: keyof typeof VENUES, day: number, perDay: number,
): Promise<SampleChunk[]> {
  const prior = getProgress(db, "sample", venue, day);
  if (prior?.status === "done") return JSON.parse(prior.extra ?? "[]") as SampleChunk[];
  const rand = rng(hashSeed("sample", venue, day));
  const chunks: SampleChunk[] = [];
  let rows = 0;
  for (let k = 0; k < perDay; k++) {
    const t = day + Math.floor(((k + rand()) / perDay) * DAY);
    const { txs } = await helius.txPage(VENUES[venue], { from: t, to: t + 600, limit: 100 }, "sample");
    const parsed = txs.flatMap(parseTx);
    rows += insertSwaps(db, parsed);
    insertDiscovery(db, parsed, venue, day);
    const times = txs.map((x) => x.blockTime ?? t);
    chunks.push({ t, n: txs.length, first: times.length ? Math.min(...times) : null, last: times.length ? Math.max(...times) : null });
  }
  setProgress(db, "sample", venue, day, day + DAY, "done", rows, chunks);
  return chunks;
}

export async function sampleRange(
  db: DatabaseSync, helius: Helius, from: number, to: number, perDay: number, concurrency: number,
): Promise<void> {
  const jobs: Array<[keyof typeof VENUES, number]> = [];
  for (let d = from; d < to; d += DAY) for (const v of Object.keys(VENUES) as Array<keyof typeof VENUES>) jobs.push([v, d]);
  let done = 0;
  const { pool } = await import("./http.js");
  await pool(jobs, concurrency, async ([v, d]) => {
    await sampleVenueDay(db, helius, v, d, perDay);
    if (++done % 50 === 0) log.info("sampled", { done, of: jobs.length, credits: helius.creditsUsed });
  });
}

/**
 * Per venue-day scale factor from sampled seconds to a full day: a chunk of n txs spanning s seconds
 * observes s seconds of the venue's flow (or the full 600s window if it returned fewer than 100 txs).
 */
export function sampleScale(db: DatabaseSync, from: number, to: number): Map<string, number> {
  const out = new Map<string, number>();
  const rows = db
    .prepare("SELECT key, from_ts, extra FROM fetch_progress WHERE kind = 'sample' AND from_ts >= ? AND from_ts < ? AND status = 'done'")
    .all(from, to) as Array<{ key: string; from_ts: number; extra: string }>;
  for (const r of rows) {
    const chunks = JSON.parse(r.extra) as SampleChunk[];
    let seconds = 0;
    for (const c of chunks) {
      if (c.n >= 100 && c.first !== null && c.last !== null) seconds += Math.max(1, c.last - c.first + 1);
      else seconds += 600;
    }
    out.set(`${r.key}|${r.from_ts}`, seconds > 0 ? DAY / seconds : 0);
  }
  return out;
}

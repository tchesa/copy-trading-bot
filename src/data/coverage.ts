/**
 * Copyability spec 5.5: why a replication fill was unreadable, per fill, from stored data only (no fetch).
 * Classes:
 *  - not-fetched: no stored tape page covers the action time (the run ran out of credits, or the page was never asked for);
 *  - coverage-short: tape stored from the action time but it ends before the fill window does;
 *  - unpriced: tape stored and complete, trades exist, but none is pool-priced (dust, or the parser found no pool leg);
 *  - quiet-untrusted: no trade within the hour; the pool's prior state could not be trusted offline (needs a backward page).
 */
import type { Oracle } from "./oracle.js";
import type { Fill, ReplRecord } from "../research/types.js";

export type MissCause = "not-fetched" | "coverage-short" | "unpriced" | "quiet-untrusted";

export interface MissingFill {
  sig: string;
  venue: string;
  /** entry@<d>s, exit@<d>s (sell), out@<d>s (transfer out), time stop */
  leg: string;
  pool: string;
  t: number;
  cause: MissCause;
}

export async function classifyMiss(oracle: Oracle, pool: string, t: number): Promise<MissCause> {
  if (oracle.coveredUntil(pool, t) === null) return "not-fetched";
  const short = await oracle.tradesFrom(pool, t, 30);
  const wide = short.rows.some((r) => r.poolPriced) ? short : await oracle.tradesFrom(pool, t, 3600);
  if (!wide.complete && !wide.rows.some((r) => r.poolPriced)) return wide.rows.length ? "unpriced" : "coverage-short";
  if (wide.rows.length && !wide.rows.some((r) => r.poolPriced)) return "unpriced";
  return "quiet-untrusted";
}

/** Every unreadable fill of a record, with the pool and time it was asked for. */
export async function missingFills(oracle: Oracle, r: ReplRecord): Promise<MissingFill[]> {
  const out: MissingFill[] = [];
  const lastPool = [...r.sells].reverse().find((s) => s.pool)?.pool ?? r.pool;
  const seen = new Set<string>();
  const add = async (leg: string, pool: string, t: number, f: Fill | null | undefined) => {
    if (!f?.missing || seen.has(`${pool}|${t}`)) return;
    seen.add(`${pool}|${t}`);
    out.push({ sig: r.sig, venue: r.venue, leg, pool, t, cause: await classifyMiss(oracle, pool, t) });
  };
  for (const [d, f] of Object.entries(r.fills)) {
    await add(`entry@${d}s`, r.pool, r.t + Number(d), f.entry);
    for (let i = 0; i < f.exits.length; i++) {
      const s = r.sells[i]!;
      await add(`${s.kind === "out" ? "out" : "exit"}@${d}s`, s.pool ?? r.pool, s.t + Number(d), f.exits[i]);
    }
    await add("time stop", lastPool, r.timeStopT, f.timeStop);
  }
  return out;
}

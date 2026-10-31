import type { DatabaseSync } from "node:sqlite";
import { logger } from "../log.js";
import { getJson, qs } from "./http.js";
import { tx } from "../db/db.js";

const log = logger("solusd");
const H = 3600;

/** Hourly SOL/USD closes from Binance's public market-data mirror (free, no key). */
export async function backfillSolUsd(db: DatabaseSync, from: number, to: number): Promise<number> {
  const have = db.prepare("SELECT MIN(hour) lo, MAX(hour) hi, COUNT(*) n FROM sol_usd WHERE hour >= ? AND hour < ?").get(from, to) as {
    lo: number | null; hi: number | null; n: number;
  };
  const expected = Math.floor((to - from) / H);
  if (Number(have.n) >= expected - 1) return 0;
  let start = from * 1000;
  let n = 0;
  const stmt = db.prepare("INSERT OR REPLACE INTO sol_usd VALUES (?, ?)");
  while (start < to * 1000) {
    const rows = await getJson<Array<[number, string, string, string, string]>>(
      `https://data-api.binance.vision/api/v3/klines?${qs({ symbol: "SOLUSDT", interval: "1h", startTime: start, limit: 1000 })}`,
    );
    if (rows.length === 0) break;
    tx(db, () => {
      for (const r of rows) stmt.run(Math.floor(r[0] / 1000), Number(r[4]));
    });
    n += rows.length;
    start = rows[rows.length - 1]![0] + H * 1000;
  }
  log.info("sol/usd hours stored", { n });
  return n;
}

export class SolUsd {
  private readonly hours: Map<number, number>;
  constructor(db: DatabaseSync) {
    this.hours = new Map(
      (db.prepare("SELECT hour, price FROM sol_usd").all() as Array<{ hour: number; price: number }>).map((r) => [r.hour, r.price]),
    );
  }
  /** Close of the last complete hour before t (never the hour containing t). */
  at(t: number): number {
    const p = this.tryAt(t);
    if (p !== null) return p;
    throw new Error(`no SOL/USD price near ${new Date(t * 1000).toISOString()}`);
  }

  /** Like at(), but null when no hour within 48 h before t is stored (e.g. before the SOL/USD backfill starts). */
  tryAt(t: number): number | null {
    let h = Math.floor(t / H) * H - H;
    for (let i = 0; i < 48; i++, h -= H) {
      const p = this.hours.get(h);
      if (p !== undefined) return p;
    }
    return null;
  }
}

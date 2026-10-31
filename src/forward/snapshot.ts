/**
 * Fomo leaderboard snapshots, saved by hand to data/fomo/snapshots/<YYYY-MM-DD>.json (or .csv). Fomo's terms forbid
 * scraping and automated access: nothing here ever fetches fomo.family. Template: docs/fomo-snapshot-template.json.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const SNAPSHOT_DIR = join("data", "fomo", "snapshots");

export interface FomoTrade {
  /** Token mint (Solana) from the trade's /tokens/solana/<mint> link. */
  mint: string;
  /** The trade line as Fomo shows it, e.g. "Buy +$87.05 Oct 30, 10:05 AM 18.5M at $7.99K MC". */
  text: string;
}

export interface SnapshotTrader {
  handle: string;
  rank: number;
  /** Known wallet address (skips matching), or null. */
  wallet: string | null;
  trades: FomoTrade[];
}

export interface Snapshot {
  /** File date (YYYY-MM-DD). */
  date: string;
  /** When the leaderboard was read (unix seconds): copying starts here. */
  takenAt: number;
  /** Offset of the clock Fomo showed trade times in, minutes east of UTC (-180 = UTC-3). */
  utcOffsetMinutes: number;
  traders: SnapshotTrader[];
  file: string;
}

export const SNAPSHOT_FORMAT = `Save this week's leaderboard to data/fomo/snapshots/<YYYY-MM-DD>.json (copy docs/fomo-snapshot-template.json):
  {
    "takenAt": "2026-11-02T09:30:00-03:00",      // when you read the board, with your UTC offset
    "board": "30D Tokens",                        // optional note
    "traders": [
      { "handle": "OinkersRUs", "rank": 11, "wallet": null,
        "trades": [ { "mint": "<Solana mint from the trade's token link>", "text": "Buy +$87.05 Oct 30, 10:05 AM 18.5M" } ] }
    ]
  }
Give either "wallet" (if you know it) or 2-4 Solana token trades per trader (more trades = a more certain match).
Trade times are read in the takenAt offset unless "utcOffset" (e.g. "-03:00") says otherwise.
CSV alternative (.csv): first line "# takenAt=2026-11-02T09:30:00-03:00", then header handle,rank,wallet,mint,trade
with one row per trade (quote the trade text: it contains commas).`;

function offsetMinutes(s: string): number {
  if (/z$/i.test(s)) return 0;
  const m = s.match(/([+-])(\d{2}):?(\d{2})$/);
  if (!m) throw new Error(`takenAt/utcOffset needs an explicit UTC offset (e.g. -03:00): ${s}`);
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

function parseTakenAt(s: unknown, file: string): { t: number; off: number } {
  if (typeof s !== "string") throw new Error(`${file}: "takenAt" is required (ISO time with offset, e.g. 2026-11-02T09:30:00-03:00)`);
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`${file}: bad takenAt ${s}`);
  return { t: Math.floor(t / 1000), off: offsetMinutes(s) };
}

/** Minimal CSV line split with double-quote support. */
export function csvSplit(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

function validate(traders: SnapshotTrader[], file: string): SnapshotTrader[] {
  if (!traders.length) throw new Error(`${file}: no traders`);
  for (const x of traders) {
    if (!x.handle) throw new Error(`${file}: trader without handle`);
    if (!Number.isFinite(x.rank)) throw new Error(`${file}: @${x.handle} has no numeric rank`);
    if (!x.wallet && !x.trades.length) throw new Error(`${file}: @${x.handle} needs a wallet or at least one trade`);
    for (const tr of x.trades) if (!tr.mint || !tr.text) throw new Error(`${file}: @${x.handle} has a trade without mint or text`);
  }
  return traders;
}

export function parseSnapshot(file: string, content: string): Snapshot {
  const date = file.match(/(\d{4}-\d{2}-\d{2})\.(json|csv)$/)?.[1];
  if (!date) throw new Error(`${file}: name must be <YYYY-MM-DD>.json or .csv`);
  if (file.endsWith(".json")) {
    const j = JSON.parse(content) as { takenAt?: string; utcOffset?: string; traders?: Array<Record<string, unknown>> };
    const { t, off } = parseTakenAt(j.takenAt, file);
    const traders = (j.traders ?? []).map((x) => ({
      handle: String(x.handle ?? "").replace(/^@/, ""),
      rank: Number(x.rank),
      wallet: typeof x.wallet === "string" && x.wallet ? x.wallet : null,
      trades: ((x.trades as FomoTrade[] | undefined) ?? []).map((tr) => ({ mint: String(tr.mint ?? ""), text: String(tr.text ?? "") })),
    }));
    return { date, takenAt: t, utcOffsetMinutes: j.utcOffset ? offsetMinutes(j.utcOffset) : off, traders: validate(traders, file), file };
  }
  const lines = content.split(/\r?\n/).filter((l) => l.trim());
  const meta = lines.find((l) => l.startsWith("#") && /takenAt\s*=/.test(l));
  const { t, off } = parseTakenAt(meta?.split("=")[1]?.trim(), file);
  const offLine = lines.find((l) => l.startsWith("#") && /utcOffset\s*=/.test(l));
  const rows = lines.filter((l) => !l.startsWith("#"));
  const head = csvSplit(rows[0] ?? "").map((h) => h.toLowerCase());
  const col = (k: string) => head.indexOf(k);
  for (const k of ["handle", "rank"]) if (col(k) < 0) throw new Error(`${file}: CSV header needs handle,rank,wallet,mint,trade`);
  const by = new Map<string, SnapshotTrader>();
  for (const l of rows.slice(1)) {
    const c = csvSplit(l);
    const handle = (c[col("handle")] ?? "").replace(/^@/, "");
    const x = by.get(handle) ?? { handle, rank: Number(c[col("rank")]), wallet: null, trades: [] };
    const w = col("wallet") >= 0 ? c[col("wallet")] : "";
    if (w) x.wallet = w;
    const mint = col("mint") >= 0 ? c[col("mint")] : "";
    const text = col("trade") >= 0 ? c[col("trade")] : "";
    if (mint && text) x.trades.push({ mint, text });
    by.set(handle, x);
  }
  const utc = offLine ? offsetMinutes(offLine.split("=")[1]!.trim()) : off;
  return { date, takenAt: t, utcOffsetMinutes: utc, traders: validate([...by.values()], file), file };
}

/** All snapshots, oldest first. */
export function loadSnapshots(dir = SNAPSHOT_DIR): Snapshot[] {
  if (!existsSync(dir)) return [];
  const snaps = readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.(json|csv)$/.test(f))
    .sort()
    .map((f) => parseSnapshot(join(dir, f), readFileSync(join(dir, f), "utf8")));
  for (let i = 1; i < snaps.length; i++) {
    if (snaps[i]!.takenAt <= snaps[i - 1]!.takenAt) throw new Error(`${snaps[i]!.file}: takenAt is not after ${snaps[i - 1]!.file}`);
    if (snaps[i]!.date === snaps[i - 1]!.date) throw new Error(`two snapshots for ${snaps[i]!.date} (.json and .csv?)`);
  }
  return snaps;
}

export interface ParsedTrade {
  side: "buy" | "sell";
  /** Start of the minute Fomo shows (unix seconds, UTC). */
  t0: number;
  /** Token amount as shown (18.5M → 18_500_000). */
  amount: number;
  /** Relative tolerance implied by the shown rounding. */
  tol: number;
}

const MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/**
 * Parse a Fomo trade line ("Buy +$87.05 Oct 30, 10:05 AM 18.5M at $7.99K MC"). Times are minute precision in the
 * viewer's clock (`utcOffsetMinutes`); the year is the snapshot's (the previous one if that would be after it).
 */
export function parseFomoTrade(text: string, utcOffsetMinutes: number, takenAt: number): ParsedTrade | null {
  const m = text.match(/^(Buy|Sell)\s+[+-]?\$([\d,.]+)\s+(\w{3})\s+(\d+),\s+(\d+):(\d+)\s+(AM|PM)\s+([\d.]+)([KMB]?)/i);
  if (!m) return null;
  const mon = MONTHS[m[3]!.slice(0, 1).toUpperCase() + m[3]!.slice(1, 3).toLowerCase()];
  if (mon === undefined) return null;
  let hr = Number(m[5]) % 12;
  if (m[7]!.toUpperCase() === "PM") hr += 12;
  const year = new Date(takenAt * 1000).getUTCFullYear();
  const at = (y: number) => Date.UTC(y, mon, Number(m[4]), hr, Number(m[6])) / 1000 - utcOffsetMinutes * 60;
  let t0 = at(year);
  if (t0 > takenAt + 86_400) t0 = at(year - 1);
  const shown = m[8]!;
  const unit = m[9]!.toUpperCase();
  const amount = parseFloat(shown) * (unit === "B" ? 1e9 : unit === "M" ? 1e6 : unit === "K" ? 1e3 : 1);
  // Rounding of the shown number: half a unit in its last shown digit, plus slack for fees/decimals.
  const decimals = shown.includes(".") ? shown.split(".")[1]!.length : 0;
  const tol = Math.max(0.006, (0.5 * 10 ** -decimals) / parseFloat(shown) + 0.004);
  return { side: m[1]!.toLowerCase() === "buy" ? "buy" : "sell", t0, amount, tol };
}

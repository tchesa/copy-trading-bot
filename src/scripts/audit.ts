/**
 * Data-quality audit over cached study steps (offline, no credits):
 *  1. implausible position returns (> MAX_PLAUSIBLE_RET) logged by the pipeline, with raw amounts;
 *  2. consistency: follower at 0s vs the leader's own realized return on the same buys;
 *  3. hand-check of N "rug" trades at 0s against the leader's own later transactions in that mint.
 */
import { parseArgs } from "node:util";
import { defaultCosts } from "../config/params.js";
import { leaderReturn, simulateFollower } from "../research/follower.js";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { leaderOwnReturn } from "../research/feasibility.js";
import { hasMissingTape, loadSteps } from "../research/loadSteps.js";
import type { Fill, ReplRecord } from "../research/types.js";
import { hashSeed, rng, sample } from "../util/rng.js";
import { mean, median, quantile, trimTop } from "../util/stats.js";
import { iso, num, pct, table, writeReportFiles } from "../util/run.js";
import { MAX_PLAUSIBLE_RET } from "../wallets/audit.js";
import { buildContext, commonOptions } from "./context.js";

const { values } = parseArgs({ options: { ...commonOptions, dir: { type: "string" }, rugs: { type: "string", default: "20" } } });
const { ctx, p } = buildContext({ ...values, offline: true });
const dir = values.dir ?? ctx.stepsDir;
const steps = loadSteps(dir);
const costs = defaultCosts();
const md: string[] = [`# Data-quality audit`, ``, `Steps: ${steps.length} from \`${dir}\`.`, ``];
const json: Record<string, unknown> = { dir };

// 1. Outliers ---------------------------------------------------------------------------------------------------
const outliers = steps.flatMap((s) => (s.outliers ?? []).map((o) => ({ step: s.step, ...o })));
const repairedOutliers = outliers.filter((o) => o.trades.some((t) => t.repaired));
md.push(`## 1. Positions returning more than ${MAX_PLAUSIBLE_RET}×`, ``);
const ls = steps.at(-1)?.loader;
if (ls) md.push(`Trade loader (cumulative): ${ls.priced} priced swaps, ${ls.repaired} (${pct(ls.repaired / ls.priced)}) revalued at the pool price because the stored quote leg was incomplete, ${ls.unchecked} (${pct(ls.unchecked / ls.priced)}) without a pool price to check against.`, ``);
md.push(`${outliers.length} positions above ${MAX_PLAUSIBLE_RET}× after the fix (${repairedOutliers.length} involve a repaired trade).`, ``);
if (outliers.length) {
  md.push(table(["Step", "Phase", "Wallet", "Mint", "Return", "Cost SOL", "Proceeds SOL", "Mark SOL", "First trades (side tokens sol | raw quote, pool price)"],
    outliers.slice(0, 30).map((o) => [o.step, o.phase, o.wallet.slice(0, 8), o.mint.slice(0, 8), `${Math.round(o.ret)}×`, o.costSol.toFixed(4), o.proceedsSol.toFixed(3), o.markSol.toFixed(3),
      o.trades.slice(0, 3).map((t) => `${t.side} ${t.tokens.toPrecision(4)} ${t.sol.toPrecision(3)} | ${t.raw?.quoteAmount?.toPrecision(3)} ${t.raw?.quoteMint?.slice(0, 4)}, ${t.raw?.poolPrice?.toPrecision(3)}`).join("; ")])), ``);
}
json.outliers = outliers;

// 2. Consistency: follower at 0s vs leader ---------------------------------------------------------------------
const records = steps.flatMap((s) => s.records);
const pairs: Array<{ r: ReplRecord; f: number; l: number; d: number; rug: boolean }> = [];
let notOk = 0;
for (const r of records) {
  if (!r.fills["0"]) continue;
  const f = simulateFollower(r, { delay: 0, sizeSol: 1, costs });
  if (!f.ok) { notOk++; continue; }
  const l = leaderReturn(r);
  pairs.push({ r, f: f.ret, l, d: f.ret - l, rug: f.rug });
}
const ds = pairs.map((x) => x.d).sort((a, b) => a - b);
const absd = ds.map(Math.abs);
md.push(`## 2. Consistency: follower at 0s vs the leader's realized return (same buys)`, ``,
  `The follower at 0s fills at the leader's own pool prices, so the two should differ only by the follower's fees and its own size impact (≈ a few %). ` +
  `Leader return = own SOL in/out (fees included), remainder valued at the time-stop fill; follower = 1 SOL, constant-product impact, venue fee per side, tx costs, rug = −100% on the remainder.`, ``,
  table(["Pairs", "Excluded (no fill)", "Median diff", "p5", "p95", "|diff| > 10pp", "|diff| > 50pp", "Rug pairs", "Median leader", "Median follower"],
    [[pairs.length, notOk, pct(median(ds)), pct(quantile(ds, 0.05)), pct(quantile(ds, 0.95)), pct(absd.filter((x) => x > 0.1).length / pairs.length),
      pct(absd.filter((x) => x > 0.5).length / pairs.length), pairs.filter((x) => x.rug).length, pct(median(pairs.map((x) => x.l))), pct(median(pairs.map((x) => x.f)))]]), ``);
const worst = [...pairs].sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 15);
md.push(`Largest disagreements (entry ratio = leader's own price ÷ pool price at the buy; exit ratios likewise per sell):`, ``,
  table(["Step", "Sig", "Mint", "Leader", "Follower 0s", "Rug", "Entry ratio", "Exit ratios", "Sells", "Time stop fill"],
    worst.map(({ r, f, l, rug }) => [r.step, r.sig.slice(0, 10), r.mint.slice(0, 8), pct(l), pct(f), rug ? "yes" : "", (r.leaderSol / r.leaderTokens / r.leaderPoolPrice).toFixed(2),
      r.sells.slice(0, 4).map((s) => (s.poolPrice ? (s.price / s.poolPrice).toFixed(2) : "–")).join(" "), r.sells.length, fillStr(r.fills["0"]!.timeStop)])), ``);
json.consistency = { pairs: pairs.length, notOk, median: median(ds), p5: quantile(ds, 0.05), p95: quantile(ds, 0.95) };

// 3. Rug hand-check ----------------------------------------------------------------------------------------------
const rugRecs = pairs.filter((x) => x.rug).map((x) => x.r);
const picked = sample(rugRecs, Number(values.rugs), rng(hashSeed("rug-audit")));
const qAfter = ctx.db.prepare(
  `SELECT sig, block_time, side, token_amount, quote_amount, quote_mint, pool, venue FROM swaps
   WHERE wallet = ? AND mint = ? AND block_time >= ? AND block_time < ? ORDER BY block_time, tx_index`,
);
const qCov = ctx.db.prepare("SELECT from_ts AS f, to_ts AS t, status FROM fetch_progress WHERE kind = 'wallet' AND key = ?");
const qPoolTrades = ctx.db.prepare("SELECT COUNT(*) AS n, MIN(block_time) AS first FROM swaps WHERE pool = ? AND block_time >= ? AND block_time < ? AND side IN ('buy','sell')");
const qOtherPools = ctx.db.prepare(
  "SELECT pool, venue, COUNT(*) AS n, MIN(block_time) AS first FROM swaps WHERE mint = ? AND block_time >= ? AND block_time < ? AND side IN ('buy','sell') AND pool IS NOT NULL AND pool != ? GROUP BY pool ORDER BY n DESC LIMIT 3",
);
const rugRows: Array<Array<string | number | undefined>> = [];
const classes: Record<string, number> = {};
const details: unknown[] = [];
for (const r of picked) {
  const f0 = r.fills["0"]!;
  // which leg rugged, and why (re-derived from stored tape)
  // At 0s, mirrored sells fill at the leader's own price (never a rug); only transfer-out legs (tape) and the time
  // stop can rug.
  const legs: Array<{ name: string; t: number; fill: Fill }> = [
    ...r.sells.flatMap((s, i) => (s.kind === "out" ? [{ name: `out${i + 1}`, t: s.t, fill: f0.exits[i]! }] : [])),
    ...(f0.timeStop ? [{ name: "timestop", t: r.timeStopT, fill: f0.timeStop }] : []),
  ];
  const rugLeg = legs.find((l) => l.fill.rug || l.fill.price === null);
  const reason = rugLeg ? rugReason(r.pool, rugLeg.t, rugLeg.fill) : "–";
  const cov = qCov.get(r.wallet) as { f: number; t: number; status: string } | undefined;
  const after = qAfter.all(r.wallet, r.mint, r.t, r.timeStopT + 7 * 86_400) as Array<{ sig: string; block_time: number; side: string; token_amount: number; quote_amount: number; quote_mint: string | null; pool: string | null; venue: string }>;
  const later = after.filter((x) => x.sig !== r.sig);
  const sells = later.filter((x) => x.side === "sell");
  const outs = later.filter((x) => x.side === "out");
  const otherPoolSells = sells.filter((x) => x.pool && x.pool !== r.pool);
  const migrated = qOtherPools.all(r.mint, r.t, r.timeStopT + 3600, r.pool) as Array<{ pool: string; venue: string; n: number; first: number }>;
  let cls: string;
  if (otherPoolSells.length) cls = "leader sold on another pool (migration/route)";
  else if (sells.length && sells.some((s) => s.block_time <= r.timeStopT)) cls = "leader sold in window; exit fill on this pool failed";
  else if (outs.length) cls = "leader transferred tokens out";
  else if (sells.length) cls = "leader sold after the 48h time stop";
  else cls = cov && cov.t >= r.timeStopT ? "leader held (no sell/transfer seen)" : "leader held (history not covered)";
  classes[cls] = (classes[cls] ?? 0) + 1;
  rugRows.push([r.step, r.sig.slice(0, 10), r.mint.slice(0, 8), r.venue, rugLeg?.name ?? "–", reason, cls,
    later.slice(0, 4).map((x) => `${x.side} ${((x.block_time - r.t) / 3600).toFixed(1)}h ${x.pool === r.pool ? "same pool" : x.pool ? `pool ${x.pool.slice(0, 6)} (${x.venue})` : "no pool"}`).join("; ") || "none",
    migrated.map((m) => `${m.venue} ${m.pool.slice(0, 6)} n=${m.n}`).join(", ") || "–"]);
  details.push({ step: r.step, sig: r.sig, wallet: r.wallet, mint: r.mint, pool: r.pool, venue: r.venue, t: iso(r.t), rugLeg: rugLeg?.name, reason, cls, later, otherPools: migrated, walletCoverage: cov });
}
md.push(`## 3. Hand-check of ${picked.length} rug trades at 0s (of ${rugRecs.length})`, ``,
  `For each: the exit leg that was scored as a rug and why (re-derived from the stored tape), and the leader's own later transactions in the mint from its stored history (up to 7 days after the time stop).`, ``,
  table(["Class", "Count"], Object.entries(classes).sort((a, b) => b[1] - a[1])), ``,
  table(["Step", "Buy sig", "Mint", "Venue", "Rug leg", "Why", "Class", "Leader's later txs in mint", "Other pools trading the mint"], rugRows), ``);
json.rugs = details;

// 4. Dropped records (unreadable tape): where, which fill, and are they different? ----------------------------------
// Leader return from its own flows only (no tape): sells at its own price, transfers out and any remainder at its
// last own trade price. Same measure for kept and dropped buys.
const rawRecords = readdirSync(dir).filter((f) => /^step-\d+\.json$/.test(f))
  .flatMap((f) => (JSON.parse(readFileSync(join(dir, f), "utf8")) as { records: ReplRecord[] }).records);
const ownReturn = leaderOwnReturn;
const whichMissing = (r: ReplRecord) => {
  const w = new Set<string>();
  for (const [d, f] of Object.entries(r.fills)) {
    if (f.entry.missing) w.add(`entry@${d}s`);
    if (f.timeStop?.missing) w.add("time stop");
    f.exits.forEach((x, i) => x.missing && w.add(r.sells[i]?.kind === "out" ? "transfer-out exit" : `sell exit@${d === "0" ? "0" : ">0"}s`));
  }
  return [...w];
};
const venues = [...new Set(rawRecords.map((r) => r.venue))].sort();
const vrows = venues.map((v) => {
  const all = rawRecords.filter((r) => r.venue === v);
  const dr = all.filter(hasMissingTape);
  const kp = all.filter((r) => !hasMissingTape(r));
  const med = (xs: ReplRecord[]) => (xs.length ? pct(median(xs.map(ownReturn).filter(Number.isFinite))) : "–");
  return [v, all.length, dr.length, pct(dr.length / all.length), med(kp), med(dr)];
});
const dropped = rawRecords.filter(hasMissingTape);
const kept = rawRecords.filter((r) => !hasMissingTape(r));
const reasons: Record<string, number> = {};
for (const r of dropped) for (const w of whichMissing(r)) reasons[w] = (reasons[w] ?? 0) + 1;
const sumRow = (name: string, xs: ReplRecord[]) => {
  const rs = xs.map(ownReturn).filter(Number.isFinite);
  return [name, xs.length, pct(median(rs)), pct(mean(trimTop(rs, 0.01))), pct(rs.filter((x) => x > 0).length / rs.length),
    num(median(xs.map((r) => r.leaderSol)), 3), pct(xs.filter((r) => r.group === "ranked").length / xs.length)];
};
md.push(`## 4. Dropped leader buys (part of their tape unreadable)`, ``,
  `${dropped.length} of ${rawRecords.length} buys (${pct(dropped.length / rawRecords.length)}) are dropped. Leader return here uses the leader's own flows only (sells at its own price; transfers out and any remainder at its last own price), so it is defined for both groups.`, ``,
  table(["Group", "Buys", "Median leader return", "Mean −top1%", "Hit", "Median leader size (SOL)", "Ranked share"], [sumRow("kept", kept), sumRow("dropped", dropped)]), ``,
  table(["Venue", "Buys", "Dropped", "Dropped %", "Median leader return (kept)", "Median leader return (dropped)"], vrows), ``,
  `Which fill was unreadable (a buy can have several): ${Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ")}.`, ``);
json.dropped = { total: dropped.length, of: rawRecords.length, reasons, byVenue: vrows };

const files = writeReportFiles("reports", "audit", md.join("\n"), json);
console.log(files);

function fillStr(f: Fill | null): string {
  if (!f) return "–";
  if (f.missing) return "missing";
  if (f.rug) return f.price === null ? "rug (no trade)" : `rug (Q ${f.reserveSol?.toFixed(2)})`;
  return `${f.price?.toPrecision(3)} Q ${f.reserveSol?.toFixed(1)}`;
}

function rugReason(pool: string, t: number, fill: Fill): string {
  const n = qPoolTrades.get(pool, t, t + 3600) as { n: number; first: number | null };
  if (fill.price === null) return `no trade on this pool within 1h (stored trades in 1h: ${n.n})`;
  if (fill.reserveSol !== null && fill.reserveSol < p.minExitLiquiditySol) return `quote reserve ${fill.reserveSol.toFixed(3)} SOL < ${p.minExitLiquiditySol}`;
  return `buy-only tape (${n.n} trades in 1h)`;
}

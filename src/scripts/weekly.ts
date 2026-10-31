/**
 * Weekly forward paper-test of Fomo leaderboard wallets (`pnpm weekly`), run by hand every Thursday (Helius billing cycle) after saving that
 * week's leaderboard snapshot to data/fomo/snapshots/<YYYY-MM-DD>.json (never fetched: Fomo's terms forbid scraping).
 *   (default)        resolve the new snapshot's wallets, score every week whose next snapshot exists (closed buys only),
 *                    finish buys that were open last time, baselines, then write reports/fomo-forward.md|json
 *   --estimate       offline: expected credits for this run, nothing fetched
 *   --report-only    rebuild the report from the cached weeks
 *   --budget N       per-run credit cap (default FORWARD.defaultRunBudget); the run stops cleanly and resumes next time
 *   --skip-snapshot  run without this week's snapshot (finishes open buys, no new week)
 * Refuses to pull with uncommitted changes in src/ or package.json (pre-registration: the config is committed first).
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { env } from "../config/env.js";
import { Helius } from "../data/helius.js";
import { Oracle } from "../data/oracle.js";
import { backfillSolUsd } from "../data/solusd.js";
import { creditsByKind, creditsUsed, openDb } from "../db/db.js";
import { FORWARD } from "../forward/config.js";
import { buildForwardReport } from "../forward/report.js";
import { FORWARD_DIR, ForwardRun, loadWeeks } from "../forward/run.js";
import { loadSnapshots, SNAPSHOT_DIR, SNAPSHOT_FORMAT } from "../forward/snapshot.js";
import { logger } from "../log.js";
import { DAY } from "../research/pipeline.js";
import { gitCommit, table } from "../util/run.js";
import { buildContext } from "./context.js";

const { values } = parseArgs({
  options: {
    estimate: { type: "boolean", default: false },
    "report-only": { type: "boolean", default: false },
    budget: { type: "string", default: String(FORWARD.defaultRunBudget) },
    "skip-snapshot": { type: "boolean", default: false },
    "allow-dirty": { type: "boolean", default: false },
  },
});
const log = logger("weekly");
const now = Math.floor(Date.now() / 1000);
const runT = Math.floor(now / 3600) * 3600;
const mode = values.estimate ? "estimate" : values["report-only"] ? "report" : "pull";
const today = new Date(now * 1000).toISOString().slice(0, 10);
const missing = (why: string) => {
  console.error(`${why}\n\nSave this week's Fomo leaderboard by hand as ${join(SNAPSHOT_DIR, `${today}.json`)}.\n${SNAPSHOT_FORMAT}\n\n` +
    `(Or run with --skip-snapshot to only finish last week's open buys, or --report-only.)`);
  process.exit(1);
};

const snaps = loadSnapshots();
if (!snaps.length) missing(`No snapshot in ${SNAPSHOT_DIR}.`);
for (const s of snaps) if (s.takenAt > now) throw new Error(`${s.file}: takenAt is in the future`);
const latest = snaps[snaps.length - 1]!;
if (mode === "pull" && !values["skip-snapshot"] && now - latest.takenAt > 3 * DAY)
  missing(`This week's snapshot is missing: the latest is ${latest.date} (${((now - latest.takenAt) / DAY).toFixed(1)} days old).`);

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const weekday = new Date((latest.takenAt + latest.utcOffsetMinutes * 60) * 1000).getUTCDay();
if (mode === "pull" && !values["skip-snapshot"] && weekday !== FORWARD.snapshotWeekday)
  log.warn(`latest snapshot ${latest.date} is a ${DAYS[weekday]}; the routine is every ${DAYS[FORWARD.snapshotWeekday]} (Helius billing cycle). Continuing.`);

if (mode === "pull") {
  const dirty = execSync("git status --porcelain src package.json", { encoding: "utf8" }).trim();
  if (dirty && !values["allow-dirty"]) throw new Error(`Pre-registration: commit src/ (including src/forward/config.ts) before pulling:\n${dirty}`);
}

// SOL/USD (free) before the context loads it.
if (mode === "pull") {
  const db = openDb(env().DB_PATH);
  await backfillSolUsd(db, snaps[0]!.takenAt - (FORWARD.lookbackDays + 2) * DAY, runT + 3600);
  db.close();
}

const { ctx, costs } = buildContext({ from: "2026-01-01", to: "2026-01-02", budget: "0", offline: true, params: JSON.stringify({ maxHoldHours: FORWARD.maxHoldHours, delays: [...FORWARD.delays] }) });
mkdirSync(FORWARD_DIR, { recursive: true });
const metaFile = join(FORWARD_DIR, "meta.json");
const runsFile = join(FORWARD_DIR, "runs.json");
const before = creditsByKind(ctx.db);
const used0 = creditsUsed(ctx.db);
if (mode === "pull" && !existsSync(metaFile))
  writeFileSync(metaFile, JSON.stringify({ firstCommit: gitCommit(), startedAt: new Date().toISOString(), creditsBefore: used0, byKindBefore: before, configVersion: FORWARD.version }, null, 2));
const meta = existsSync(metaFile) ? (JSON.parse(readFileSync(metaFile, "utf8")) as { firstCommit: string; creditsBefore: number; byKindBefore: Record<string, { credits: number }>; configVersion: number }) : null;
if (meta && meta.configVersion !== FORWARD.version) log.warn("config version changed since the first forward run: results are exploratory", { first: meta.configVersion, now: FORWARD.version });

let stopped: string | null = null;
if (mode !== "report") {
  if (mode === "pull") {
    const helius = new Helius(ctx.db, used0 + Number(values.budget));
    Object.assign(ctx, { helius, oracle: new Oracle(ctx.db, helius, ctx.solUsd) });
  }
  const run = new ForwardRun(ctx, snaps, runT, mode);
  await run.run();
  stopped = run.stopped;
  if (mode === "estimate") {
    const e = run.est;
    const total = e.match + e.screen + e.history + e.tape + e.baseline;
    console.log([
      `# Forward test: credit estimate for this run (nothing fetched)`, ``,
      table(["Part", "Credits"], [
        ["Wallet matching (Fomo trades not looked up yet)", Math.round(e.match).toLocaleString("en-US")],
        ["Bot screen (lookback week histories not stored)", Math.round(e.screen).toLocaleString("en-US")],
        ["Week histories not stored (October average per wallet-week)", Math.round(e.history).toLocaleString("en-US")],
        ["Tape for closed buys (dry run where history is stored, else October average)", Math.round(e.tape).toLocaleString("en-US")],
        ["Random-wallet baseline (rough)", Math.round(e.baseline).toLocaleString("en-US")],
        ["**Total** (high estimate: 2×)", `${Math.round(total).toLocaleString("en-US")} (${Math.round(2 * total).toLocaleString("en-US")})`],
      ]), ``,
      `Run budget: ${Number(values.budget).toLocaleString("en-US")} (--budget). Over it, the run stops cleanly and the next run continues; buys are taken in a fixed-seed random order, so a cut week is a uniform sample.`,
    ].join("\n"));
    process.exit(0);
  }
}

const after = creditsByKind(ctx.db);
const delta = (a: Record<string, { credits: number }>, b: Record<string, { credits: number }>) =>
  Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v.credits - (b[k]?.credits ?? 0)]).filter(([, v]) => (v as number) > 0)) as Record<string, number>;
const runByKind = delta(after, before);
const cumulativeByKind = meta ? delta(after, meta.byKindBefore) : {};
const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
const commit = gitCommit();
if (mode === "pull") {
  const runs = existsSync(runsFile) ? (JSON.parse(readFileSync(runsFile, "utf8")) as unknown[]) : [];
  runs.push({ at: new Date().toISOString(), commit, credits: sum(runByKind), byKind: runByKind, stopped });
  writeFileSync(runsFile, JSON.stringify(runs, null, 2));
}
const states = loadWeeks(snaps);
const { md, json } = buildForwardReport(states, costs, {
  commit, firstCommit: meta?.firstCommit ?? null, runT, stopped, skipped: [],
  credits: { run: sum(runByKind), cumulative: sum(cumulativeByKind), runByKind, cumulativeByKind },
});
mkdirSync("reports", { recursive: true });
writeFileSync(join("reports", "fomo-forward.md"), md);
writeFileSync(join("reports", "fomo-forward.json"), JSON.stringify(json, null, 2));
const v = json.verdict as { status: string; weeks: number };
console.log(`STATUS ${v.status} (${v.weeks} of ${FORWARD.goWeeks} complete weeks) | credits this run ${sum(runByKind).toLocaleString("en-US")}${stopped ? " | stopped early: run again next week (or with a larger --budget)" : ""} | reports/fomo-forward.md`);

/**
 * Exploratory selection-rule search (`pnpm explore`): monthly steps, 30-day scoring and simulation windows, every
 * non-bot wallet replicated, then the rule search and holdout report (offline).
 *   (default)       pull under the hard cap (EXPLORE.creditCap on top of the credits used when the run started)
 *   --report-only   report on the cached steps
 *   --steps N       pull only the first N steps
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { creditsByKind, creditsUsed } from "../db/db.js";
import { BudgetExceeded, Helius } from "../data/helius.js";
import { QuotaExhausted } from "../data/http.js";
import { Oracle } from "../data/oracle.js";
import { EXPLORE, exploreStudyParams } from "../explore/config.js";
import { buildExploreReport } from "../explore/report.js";
import { exploreSteps, runUniverseStep, uStepFile, type UStep } from "../explore/universe.js";
import { logger } from "../log.js";
import { STAGE1 } from "../score/config.js";
import { gitCommit, num, writeReportFiles } from "../util/run.js";
import { buildContext, commonOptions, PIPELINE_VERSION } from "./context.js";

const { values } = parseArgs({
  options: {
    ...commonOptions,
    "report-only": { type: "boolean", default: false },
    steps: { type: "string", default: "6" },
    cap: { type: "string", default: String(EXPLORE.creditCap) },
  },
});
const log = logger("explore");
const EXPLORE_VERSION = 1;
const { ctx, costs, p, from } = buildContext({ ...values, offline: true, params: JSON.stringify(exploreStudyParams) });
const windows = exploreSteps(from).slice(0, Number(values.steps));
// Cache key: only what changes the pulled data (report settings and the rule grid do not).
const { formationDays, evalDays, stepDays, candidateCap, screenCap, maxHistoryTx, minClosed, evalBuys } = EXPLORE;
const dataKey = { formationDays, evalDays, stepDays, candidateCap, screenCap, maxHistoryTx, minClosed, evalBuys };
const dir = join("data", "explore", createHash("sha1").update(JSON.stringify({ dataKey, exploreStudyParams, STAGE1, from, v: EXPLORE_VERSION, pv: PIPELINE_VERSION })).digest("hex").slice(0, 10));
mkdirSync(dir, { recursive: true });
const metaFile = join(dir, "meta.json");

if (!values["report-only"]) {
  if (!existsSync(metaFile)) writeFileSync(metaFile, JSON.stringify({ commit: gitCommit(), startedAt: new Date().toISOString(), creditsBefore: creditsUsed(ctx.db), byKindBefore: creditsByKind(ctx.db) }, null, 2));
  const meta0 = JSON.parse(readFileSync(metaFile, "utf8")) as { creditsBefore: number };
  const helius = new Helius(ctx.db, meta0.creditsBefore + Number(values.cap));
  Object.assign(ctx, { helius, oracle: new Oracle(ctx.db, helius, ctx.solUsd) });
  log.info("explore", { steps: windows.length, dir, budgetLeft: helius.remaining });
  for (const w of windows) {
    try {
      await runUniverseStep(ctx, dir, w, costs);
    } catch (e) {
      if (e instanceof BudgetExceeded || e instanceof QuotaExhausted) {
        log.warn("credits exhausted; reporting on completed steps", { step: w.step, error: (e as Error).message });
        break;
      }
      throw e;
    }
  }
}

const steps = windows.map((w) => uStepFile(dir, w.step)).filter(existsSync).map((f) => JSON.parse(readFileSync(f, "utf8")) as UStep);
const meta = existsSync(metaFile) ? (JSON.parse(readFileSync(metaFile, "utf8")) as { commit: string; creditsBefore: number; byKindBefore: Record<string, { credits: number }> }) : null;
const now = creditsByKind(ctx.db);
const byKind = Object.fromEntries(Object.entries(now).map(([k, v]) => [k, v.credits - (meta?.byKindBefore[k]?.credits ?? v.credits)]).filter(([, v]) => (v as number) > 0)) as Record<string, number>;
const { md, json } = buildExploreReport(steps, costs, p.maxHoldHours, { commit: meta?.commit ?? gitCommit(), credits: meta ? creditsUsed(ctx.db) - meta.creditsBefore : 0, creditsByKind: byKind, dir });
const files = writeReportFiles("reports", values.label ?? "explore", md, json);
log.info("report", { ...files, steps: steps.length, credits: num(meta ? creditsUsed(ctx.db) - meta.creditsBefore : 0, 0) });

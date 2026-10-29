/**
 * Copyability spec Stage 1 (`pnpm score`): formation scores C and I, S5/S6, eval replication, report.
 *   --estimate    offline: expected credits before any pull (5.4)
 *   (default)     pull under the hard cap (STAGE1.creditCap on top of credits already used), then report
 *   --report-only report on the cached Stage 1 steps
 * Refuses to pull with uncommitted changes in src/, docs/ or package.json (R-P1: the spec and config are committed first).
 */
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { creditsByKind, creditsUsed } from "../db/db.js";
import { BudgetExceeded, Helius } from "../data/helius.js";
import { QuotaExhausted } from "../data/http.js";
import { Oracle } from "../data/oracle.js";
import { logger } from "../log.js";
import { loadSteps } from "../research/loadSteps.js";
import { replicateEval, runStage1Step, scoreFormation, stage1File, type Stage1Step } from "../research/stage1.js";
import { buildStage1Report } from "../research/stage1Report.js";
import { STAGE1 } from "../score/config.js";
import { gitCommit, num, table, writeReportFiles } from "../util/run.js";
import { buildContext, commonOptions } from "./context.js";

const { values } = parseArgs({
  options: {
    ...commonOptions,
    estimate: { type: "boolean", default: false },
    "report-only": { type: "boolean", default: false },
    "first-step": { type: "string", default: "0" },
    cap: { type: "string", default: String(STAGE1.creditCap) },
    methods: { type: "string", default: "S2,S5,S6" },
    "allow-dirty": { type: "boolean", default: false },
  },
});
const log = logger("score");
const STAGE1_VERSION = 1;
const offline = values.estimate || values["report-only"];
const { ctx, costs, p } = buildContext({ ...values, offline: true });
const phaseA = loadSteps(ctx.stepsDir).filter((s) => s.step >= Number(values["first-step"]));
const dir = join("data", "stage1", createHash("sha1").update(JSON.stringify({ a: ctx.stepsDir, STAGE1, v: STAGE1_VERSION })).digest("hex").slice(0, 10));
mkdirSync(dir, { recursive: true });
const metaFile = join(dir, "meta.json");

if (values.estimate) {
  // Dry run with no client: count distinct tape pages (pool × minute) a fetch would be needed for.
  const o = ctx.oracle;
  const rows: Array<Array<string | number>> = [];
  let total = 0;
  for (const a of phaseA) {
    const k0 = o.wouldFetch.size;
    await scoreFormation(ctx, a, costs, () => new Set());
    const k1 = o.wouldFetch.size;
    const known = [...new Set([...a.rankings.S2.slice(0, STAGE1.topN), ...a.randomPool])];
    await replicateEval(ctx, a, known, new Set(a.rankings.S2));
    const k2 = o.wouldFetch.size;
    // S5/S6 add up to 2 × topN wallets not in S2 or the random pool: priced at the known wallets' average.
    const extra = known.length ? ((k2 - k1) / known.length) * 2 * STAGE1.topN : 0;
    const pages = k1 - k0 + (k2 - k1) + extra;
    total += pages * 10;
    rows.push([a.step, a.eligibleWallets.length, k1 - k0, k2 - k1, Math.round(extra), Math.round(pages * 10)]);
  }
  const md = [
    `# Stage 1 credit estimate`, ``,
    `Dry run over ${phaseA.length} cached Phase A steps (\`${ctx.stepsDir}\`): distinct tape pages (pool × minute) not yet stored, at 10 credits per page (≤ 100 txs). ` +
    `A busy pool can need up to 4 pages per fill, so the high estimate is 2×. S5/S6 wallets are unknown before C is computed: priced as ${2 * STAGE1.topN} extra wallets per step at the known wallets' average.`, ``,
    table(["Step", "Eligible", "Formation pages", "Eval pages (S2 + random)", "Eval pages (S5/S6, est.)", "Credits"], rows), ``,
    `**Estimate: ${Math.round(total).toLocaleString("en-US")} credits (high ${Math.round(2 * total).toLocaleString("en-US")}); cap ${STAGE1.creditCap.toLocaleString("en-US")}.** ` +
    (2 * total <= STAGE1.creditCap ? `Fits: run all ${phaseA.length} steps.` : `Over the cap at the high estimate: drop the oldest steps (--first-step).`),
  ].join("\n");
  console.log(md);
  writeReportFiles("reports", "score-estimate", md, { rows, total, cap: STAGE1.creditCap });
  process.exit(0);
}

if (!offline) {
  const dirty = execSync("git status --porcelain src docs package.json", { encoding: "utf8" }).trim();
  if (dirty && !values["allow-dirty"]) throw new Error(`R-P1: commit the spec and Stage 1 config before pulling:\n${dirty}`);
  const used = creditsUsed(ctx.db);
  if (!existsSync(metaFile)) writeFileSync(metaFile, JSON.stringify({ commit: gitCommit(), startedAt: new Date().toISOString(), creditsBefore: used, byKindBefore: creditsByKind(ctx.db) }, null, 2));
  const meta0 = JSON.parse(readFileSync(metaFile, "utf8")) as { creditsBefore: number };
  // Hard cap on Stage 1 as a whole (across resumed runs).
  const helius = new Helius(ctx.db, meta0.creditsBefore + Number(values.cap));
  Object.assign(ctx, { helius, oracle: new Oracle(ctx.db, helius, ctx.solUsd) });
  log.info("stage 1", { steps: phaseA.length, dir, budgetLeft: helius.remaining });
  const done: Stage1Step[] = [];
  for (const a of phaseA) {
    try {
      done.push(await runStage1Step(ctx, dir, a, costs, done));
    } catch (e) {
      if (e instanceof BudgetExceeded || e instanceof QuotaExhausted) {
        log.warn("credits exhausted; reporting on completed steps", { step: a.step, error: (e as Error).message });
        break;
      }
      throw e;
    }
  }
}

const steps = phaseA.map((a) => stage1File(dir, a.step)).filter(existsSync).map((f) => JSON.parse(readFileSync(f, "utf8")) as Stage1Step);
const meta = existsSync(metaFile) ? (JSON.parse(readFileSync(metaFile, "utf8")) as { commit: string; creditsBefore: number; byKindBefore: Record<string, { credits: number }> }) : null;
const now = creditsByKind(ctx.db);
const byKind = Object.fromEntries(Object.entries(now).map(([k, v]) => [k, v.credits - (meta?.byKindBefore[k]?.credits ?? v.credits)]).filter(([, v]) => (v as number) > 0));
const { md, json, outcome } = buildStage1Report(steps, p, costs, {
  commit: meta?.commit ?? gitCommit(), credits: meta ? creditsUsed(ctx.db) - meta.creditsBefore : 0, creditsByKind: byKind, dir, phaseADir: ctx.stepsDir,
});
const files = writeReportFiles("reports", values.label ?? "copyability", md, json);
log.info("report", { ...files, outcome, steps: steps.length, credits: num(json.meta.credits, 0) });

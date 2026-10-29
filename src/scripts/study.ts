import { parseArgs } from "node:util";
import { creditsByKind, creditsUsed } from "../db/db.js";
import { BudgetExceeded } from "../data/helius.js";
import { QuotaExhausted } from "../data/http.js";
import { logger } from "../log.js";
import { loadSteps } from "../research/loadSteps.js";
import { makeSteps, runStep } from "../research/pipeline.js";
import { buildStudyReport } from "../research/studyReport.js";
import { gitCommit, writeReportFiles } from "../util/run.js";
import { buildContext, commonOptions } from "./context.js";

// `--methods S2,S5,S6`: the copyability spec's Stage 1 (scripts/score.ts) instead of Phase A.
const mi = process.argv.indexOf("--methods");
if (mi >= 0 && /S5|S6/.test(process.argv[mi + 1] ?? "")) {
  await import("./score.js");
  process.exit(0);
}
const { values } = parseArgs({ options: { ...commonOptions, steps: { type: "string" }, "report-only": { type: "boolean", default: false } } });
const log = logger("study");
const { ctx, from, to, costs, p } = buildContext(values);
const windows = makeSteps(from, to, p).slice(0, values.steps ? Number(values.steps) : undefined);
log.info("study", { steps: windows.length, cache: ctx.stepsDir, credits: ctx.helius?.creditsUsed });

if (!values["report-only"]) {
  for (const w of windows) {
    try {
      await runStep(ctx, w);
    } catch (e) {
      if (e instanceof BudgetExceeded || e instanceof QuotaExhausted) {
        log.warn("credits exhausted; reporting on completed steps", { step: w.step, error: (e as Error).message });
        break;
      }
      throw e;
    }
  }
}
const steps = loadSteps(ctx.stepsDir).filter((s) => windows.some((w) => w.step === s.step));
const { md, json, gate, chosen } = buildStudyReport(steps, p, costs, {
  from, to, commit: gitCommit(), credits: ctx.helius?.creditsUsed ?? creditsUsed(ctx.db), creditsByKind: creditsByKind(ctx.db), label: values.label ?? "study",
});
const files = writeReportFiles("reports", values.label ?? "study", md, json);
log.info("report", { ...files, gate, chosen });

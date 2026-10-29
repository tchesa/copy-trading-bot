import { parseArgs } from "node:util";
import { DEFAULT_GRID, QUICK_GRID, loadMints, runMethod } from "../backtest/phaseB.js";
import { sweepMarkdown } from "../backtest/sweepReport.js";
import type { Grid } from "../backtest/walkforward.js";
import { logger } from "../log.js";
import { loadSteps } from "../research/loadSteps.js";
import type { RankingId } from "../ranking/rank.js";
import type { StrategyParams } from "../strategy/params.js";
import { gitCommit, pct, writeReportFiles } from "../util/run.js";
import { buildContext, commonOptions } from "./context.js";
import { latestStudy } from "./latest.js";

const { values } = parseArgs({
  options: {
    ...commonOptions,
    ranking: { type: "string" },
    delay: { type: "string", default: "5" },
    grid: { type: "string" },
    "base-params": { type: "string" },
    quick: { type: "boolean", default: false },
    train: { type: "string", default: "8" },
  },
});
const log = logger("sweep");
const { ctx, costs, p } = buildContext({ ...values, offline: true });
const steps = loadSteps(ctx.stepsDir);
if (steps.length === 0) throw new Error(`no study steps in ${ctx.stepsDir}; run pnpm study first`);
const study = latestStudy();
const method = (values.ranking ?? study?.chosen?.id ?? "S2") as RankingId;
const headlineDelay = Number(values.delay);
const grid: Grid<StrategyParams> = values.grid ? JSON.parse(values.grid) : values.quick ? QUICK_GRID : DEFAULT_GRID;
const base: Partial<StrategyParams> = JSON.parse(values["base-params"] ?? "{}");
const trainSteps = Number(values.train);
const mints = await loadMints(ctx.db, steps);

const runs = p.delays.map((d) => {
  const r = runMethod(steps, mints, costs, p, method, d, base, grid, trainSteps);
  log.info("delay", { method, delay: d, apr: r.wf.oos.apr, dd: r.wf.oos.maxDrawdown, trades: r.wf.oos.metrics.trades });
  return r;
});
const headline = runs.find((r) => r.delay === headlineDelay)!;
const label = values.label ?? `sweep-${method}`;
const md = sweepMarkdown(runs, headline, {
  label, commit: gitCommit(), grid, base, study: p, costs, trainSteps, studyGate: study ? (study.gate ? "PASS" : "FAIL") : "not run",
  dataVersion: `helius getTransactionsForAddress (jsonParsed, v1 txs), steps cache ${ctx.stepsDir}`,
});
const files = writeReportFiles("reports", label, md, {
  method, headlineDelay, grid, base, trainSteps, costs, study: p, commit: gitCommit(),
  runs: runs.map((r) => ({ delay: r.delay, oos: r.wf.oos, windows: r.wf.results.map(({ testCurve: _c, trades: _t, ...w }) => w) })),
});
const o = headline.wf.oos;
console.log(`SUMMARY\t${label}\tapr=${pct(o.apr)}\tdd=${pct(o.maxDrawdown)}\tsharpe=${o.sharpe.toFixed(2)}\tpos=${pct(o.positiveWindowShare, 0)}\ttrades=${o.metrics.trades}`);
log.info("report", files);

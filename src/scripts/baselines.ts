import { parseArgs } from "node:util";
import { DEFAULT_GRID, QUICK_GRID, loadMints, runMethod } from "../backtest/phaseB.js";
import { OOS_HEAD, oosRow } from "../backtest/sweepReport.js";
import { randomWallets, runWalkForward, type Grid } from "../backtest/walkforward.js";
import { runB2 } from "../baselines/b2.js";
import { logger } from "../log.js";
import { loadSteps } from "../research/loadSteps.js";
import type { RankingId } from "../ranking/rank.js";
import { strategySchema, type StrategyParams } from "../strategy/params.js";
import { gitCommit, iso, num, pct, table, writeReportFiles } from "../util/run.js";
import { median, mean } from "../util/stats.js";
import { buildContext, commonOptions } from "./context.js";
import { latestReport } from "./latest.js";

const { values } = parseArgs({
  options: {
    ...commonOptions,
    seeds: { type: "string", default: "20" },
    "b2-seeds": { type: "string", default: "5" },
    ranking: { type: "string" },
    delay: { type: "string" },
    quick: { type: "boolean", default: false },
    train: { type: "string", default: "8" },
  },
});
const log = logger("baselines");
const { ctx, costs, p } = buildContext(values);
const steps = loadSteps(ctx.stepsDir);
const sweep = latestReport(new RegExp(`-sweep-${values.ranking ?? "S\\d"}\\.json$`))?.json;
const study = latestReport(/-study\.json$/)?.json;
const method = (values.ranking ?? sweep?.method ?? study?.chosen?.id ?? "S2") as RankingId;
const delay = Number(values.delay ?? sweep?.headlineDelay ?? 5);
const grid: Grid<StrategyParams> = sweep?.grid ?? (values.quick ? QUICK_GRID : DEFAULT_GRID);
const base: Partial<StrategyParams> = sweep?.base ?? {};
const trainSteps = Number(values.train ?? sweep?.trainSteps ?? 8);
const mints = await loadMints(ctx.db, steps);

// Strategy (recomputed; deterministic) at the headline delay and the next slower one.
const strat = runMethod(steps, mints, costs, p, method, delay, base, grid, trainSteps);
const slower = p.delays.filter((d) => d > delay).sort((a, b) => a - b)[0];
const stratSlow = slower !== undefined ? runMethod(steps, mints, costs, p, method, slower, base, grid, trainSteps) : null;
const fixed = new Map(strat.wf.results.map((w) => [w.step, w.params]));
log.info("strategy", { method, delay, apr: strat.wf.oos.apr });

// B1: random eligible wallets, same number followed and same per-window rules.
const b1 = [];
for (let seed = 0; seed < Number(values.seeds); seed++) {
  const wf = runWalkForward({ steps, mints, costs, combos: [], selector: randomWallets(seed), trainSteps, stepDays: p.stepDays, fixed });
  b1.push({ seed, oos: wf.oos });
}
const b1Aprs = b1.map((x) => x.oos.apr).sort((a, b) => a - b);
const beatsShare = b1Aprs.filter((a) => strat.wf.oos.apr > a).length / Math.max(1, b1Aprs.length);

// B4: S1 raw-PnL top 1, no entry filters, fixed default exits.
const b4Params = strategySchema.parse({ followN: 1, delay, minEntryLiquiditySol: 0, minTokenAgeMinutes: 0, requireRevoked: false, maxTransferFeeBps: 10_000, minLeaderBuySol: 0 });
const b4 = runMethod(steps, mints, costs, p, "S1", delay, b4Params, {}, trainSteps);

// B5: zero-delay copy of the same selection and per-window params.
const fixed0 = new Map([...fixed].map(([k, v]) => [k, { ...v, delay: 0 }]));
const b5 = { method, delay: 0, wf: runWalkForward({ steps, mints, costs, combos: [], selector: (s, n) => s.rankings[method].slice(0, n), trainSteps, stepDays: p.stepDays, fixed: fixed0 }) };

// B2: same entry times, random tokens in the same liquidity band (fetches tape for the random tokens).
const stratTrades = strat.wf.results.flatMap((w) => w.trades.map((t) => {
  const rec = steps.flatMap((s) => s.records).find((r) => r.sig === t.sig && r.wallet === t.wallet);
  return { ...t, entryReserveSol: rec?.fills[String(delay)]?.entry.reserveSol ?? rec?.entryReserveSol ?? null };
}));
const b2: Array<{ seed: number; pnl: number; meanRet: number; medianRet: number; n: number; rugRate: number }> = [];
for (let seed = 0; seed < Number(values["b2-seeds"]); seed++) {
  const res = await runB2(ctx.db, ctx.oracle, stratTrades, seed, p, costs);
  const traded = res.filter((x) => x.mint);
  b2.push({ seed, pnl: res.reduce((a, x) => a + x.pnlSol, 0), meanRet: mean(traded.map((x) => x.ret)), medianRet: median(traded.map((x) => x.ret)), n: traded.length, rugRate: traded.filter((x) => x.rug).length / Math.max(1, traded.length) });
}
const stratPnl = stratTrades.filter((t) => !t.failed).reduce((a, t) => a + t.pnlSol, 0);
const b2MedianPnl = median(b2.map((x) => x.pnl));

// B3: hold SOL (strategy equity is in SOL, so B3 = 0% in SOL terms; SOL/USD shown for the USD view).
const first = strat.wf.results[0];
const last = strat.wf.results[strat.wf.results.length - 1];
const solStart = first ? ctx.solUsd.at(first.testFrom) : NaN;
const solEnd = last ? ctx.solUsd.at(last.testTo) : NaN;
const hours = strat.wf.oos.metrics.hours;
const solApr = (solEnd / solStart) ** (8760 / hours) - 1;
const stratUsdApr = (1 + strat.wf.oos.apr) * (1 + solApr) - 1;

// §8.3 go/no-go
const o = strat.wf.oos;
const checks = [
  { name: `OOS APR at ${delay}s`, value: pct(o.apr), threshold: "≥ 30%", pass: o.apr >= 0.3 && delay >= 5 },
  { name: "Max drawdown", value: pct(o.maxDrawdown), threshold: "≤ 30%", pass: o.maxDrawdown <= 0.3 },
  { name: "Sharpe", value: num(o.sharpe), threshold: "≥ 1.0", pass: o.sharpe >= 1 },
  { name: "Windows positive", value: pct(o.positiveWindowShare, 0), threshold: "≥ 67%", pass: o.positiveWindowShare >= 0.67 },
  { name: "APR with top 5 trades removed", value: pct(o.metrics.aprExTop5), threshold: "> 0", pass: o.metrics.aprExTop5 > 0 },
  { name: "Beats B1 median and ≥ 90% of seeds", value: `${pct(beatsShare, 0)} of ${b1.length} seeds (B1 median ${pct(median(b1Aprs))})`, threshold: "≥ 90%", pass: beatsShare >= 0.9 && o.apr > median(b1Aprs) },
  { name: "Beats B2 (same timing, random tokens)", value: `strategy PnL ${num(stratPnl)} SOL vs B2 median ${num(b2MedianPnl)} SOL`, threshold: "strategy > B2", pass: stratPnl > b2MedianPnl },
  { name: `Positive at next slower delay (${slower ?? "n/a"}s)`, value: stratSlow ? pct(stratSlow.wf.oos.apr) : "n/a", threshold: "> 0", pass: !!stratSlow && stratSlow.wf.oos.apr > 0 },
];
const go = checks.every((c) => c.pass);

const md = `# Baselines and go/no-go (${method}, ${delay}s)

**Verdict: ${go ? "GO" : "NO-GO"}** against the §8.3 bar. Phase A gate: ${study ? (study.gate ? "PASS" : "FAIL") : "not run"}. Commit ${gitCommit()}.

${table(["Check", "Value", "Threshold", "Pass"], checks.map((c) => [c.name, c.value, c.threshold, c.pass ? "✅" : "❌"]))}

## Chained OOS

${table(OOS_HEAD, [
  oosRow(`Strategy ${method}`, strat),
  ...(stratSlow ? [oosRow(`Strategy ${method}`, stratSlow)] : []),
  oosRow("B4 S1 top-1 unfiltered", b4),
  oosRow("B5 zero delay", b5),
])}

## B1: random eligible wallets (${b1.length} seeds, same number followed and same per-window rules)

OOS APR across seeds: min ${pct(b1Aprs[0] ?? NaN)}, p10 ${pct(b1Aprs[Math.floor(b1Aprs.length * 0.1)] ?? NaN)}, median ${pct(median(b1Aprs))}, p90 ${pct(b1Aprs[Math.floor(b1Aprs.length * 0.9)] ?? NaN)}, max ${pct(b1Aprs[b1Aprs.length - 1] ?? NaN)}. Strategy beats ${pct(beatsShare, 0)} of seeds.

## B2: same entry/exit times and sizes, random tokens (±15 min, liquidity 0.5×–2×)

${table(["Seed", "Trades", "PnL (SOL)", "Mean trade", "Median trade", "Rug rate"], b2.map((x) => [x.seed, x.n, num(x.pnl), pct(x.meanRet), pct(x.medianRet), pct(x.rugRate)]))}

Strategy on the same schedule: ${num(stratPnl)} SOL over ${stratTrades.filter((t) => !t.failed).length} trades.

## B3: hold SOL

The strategy's equity is in SOL, so holding SOL is 0% in SOL terms. SOL/USD over the test period (${first ? iso(first.testFrom) : "?"} → ${last ? iso(last.testTo) : "?"}): ${num(solStart)} → ${num(solEnd)} (${pct(solApr)} annualized). Strategy in USD terms: ${pct(stratUsdApr)} APR.
`;
const files = writeReportFiles("reports", values.label ?? "baselines", md, {
  method, delay, go, checks, strategy: strat.wf.oos, slower: stratSlow?.wf.oos ?? null, b1: b1.map((x) => ({ seed: x.seed, apr: x.oos.apr, dd: x.oos.maxDrawdown })),
  b2, b3: { solStart, solEnd, solApr, stratUsdApr }, b4: b4.wf.oos, b5: b5.wf.oos, commit: gitCommit(), credits: ctx.helius?.creditsUsed,
});
log.info("report", { ...files, go });

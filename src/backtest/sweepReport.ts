import type { CostParams, StudyParams } from "../config/params.js";
import type { StrategyParams } from "../strategy/params.js";
import { iso, num, pct, table } from "../util/run.js";
import type { PhaseBRun } from "./phaseB.js";
import type { Grid } from "./walkforward.js";

export function oosRow(label: string, r: PhaseBRun) {
  const o = r.wf.oos;
  const m = o.metrics;
  return [label, `${r.delay}s`, o.windows, pct(o.apr), pct(o.maxDrawdown), num(o.sharpe), num(o.sortino), pct(o.positiveWindowShare, 0), pct(o.windowStd), m.trades, pct(m.winRate, 0), pct(m.medianTradeRet), pct(m.meanTradeRet), num(m.avgHoldHours, 1), pct(m.top5TradeShare, 0), pct(m.aprExTop5), pct(m.rugRate), num(m.captureRatio, 2)];
}
export const OOS_HEAD = ["Run", "Delay", "Windows", "OOS APR", "Max DD", "Sharpe", "Sortino", "Windows +", "Window std", "Trades", "Win rate", "Median trade", "Mean trade", "Avg hold (h)", "Top-5 trade share", "APR ex top 5", "Rug rate", "Capture"];

export function sweepMarkdown(runs: PhaseBRun[], headline: PhaseBRun, meta: { label: string; commit: string; grid: Grid<StrategyParams>; base: Partial<StrategyParams>; study: StudyParams; costs: CostParams; trainSteps: number; studyGate: string; dataVersion: string }) {
  const md: string[] = [];
  md.push(`# Phase B sweep: ${headline.method}, headline delay ${headline.delay}s`);
  md.push(`\nPhase A gate: **${meta.studyGate}**. Walk-forward: params chosen on the preceding ${meta.trainSteps} weekly steps by APR − 0.5·maxDD, tested on the next week; test weeks are chained. Equity in SOL. Commit ${meta.commit}. Data: ${meta.dataVersion}.`);
  md.push(`\n## Chained out-of-sample results by delay\n`);
  md.push(table(OOS_HEAD, runs.map((r) => oosRow(`${r.method}`, r))));
  md.push(`\n## Headline per window (${headline.delay}s)\n`);
  md.push(table(
    ["Step", "Test week", "Train APR", "Test return", "Test DD", "Trades", "followN", "Stop", "Trail", "Hold h", "Min liq", "Min age", "Min leader buy"],
    headline.wf.results.map((w) => [w.step, iso(w.testFrom), pct(w.train.apr), pct(w.test.totalReturn), pct(w.test.maxDrawdown), w.test.trades, w.params.followN, w.params.stopLossPct || "off", w.params.trailPct || "off", w.params.maxHoldHours, w.params.minEntryLiquiditySol, w.params.minTokenAgeMinutes, w.params.minLeaderBuySol]),
  ));
  md.push(`\n## Grid\n\n\`\`\`json\n${JSON.stringify({ base: meta.base, grid: meta.grid }, null, 2)}\n\`\`\`\n\nCosts:\n\n\`\`\`json\n${JSON.stringify(meta.costs, null, 2)}\n\`\`\``);
  return md.join("\n");
}

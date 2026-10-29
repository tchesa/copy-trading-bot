/**
 * Follower-size sensitivity (offline, cached steps): the replication at several follower sizes, with
 * wallet-clustered bootstrap 95% intervals for the median and the top-1%-trimmed mean, plus B1 (random eligible
 * wallets) at the same size and a capacity estimate (SOL per week).
 */
import { parseArgs } from "node:util";
import { methodRecords, randomSeedRecords, followerResults } from "../research/studyReport.js";
import { loadSteps } from "../research/loadSteps.js";
import type { FollowerResult } from "../research/follower.js";
import type { ReplRecord } from "../research/types.js";
import type { RankingId } from "../ranking/rank.js";
import { hashSeed, rng } from "../util/rng.js";
import { mean, median, quantile, trimTop } from "../util/stats.js";
import { num, pct, table, writeReportFiles } from "../util/run.js";
import { buildContext, commonOptions } from "./context.js";

const { values } = parseArgs({
  options: {
    ...commonOptions,
    sizes: { type: "string", default: "0.05,0.1,0.25,1" },
    delays: { type: "string", default: "0,5,15,60" },
    methods: { type: "string", default: "S1,S2,S4" },
    boot: { type: "string", default: "2000" },
  },
});
const { ctx, p, costs } = buildContext({ ...values, offline: true });
const steps = loadSteps(ctx.stepsDir);
const sizes = values.sizes!.split(",").map(Number);
const delays = values.delays!.split(",").map(Number);
const methods = values.methods!.split(",") as RankingId[];
const B = Number(values.boot);
const weeks = steps.length;

const stat = (rets: number[]) => ({ median: median(rets), trimmed: mean(trimTop(rets, 0.01)) });

/** Wallet-clustered bootstrap: resample leader wallets with replacement, keep all of each wallet's trades. */
function bootstrap(recs: ReplRecord[], res: FollowerResult[], seed: string) {
  const byWallet = new Map<string, number[]>();
  recs.forEach((r, i) => {
    const k = `${r.step}|${r.wallet}`;
    if (!byWallet.has(k)) byWallet.set(k, []);
    byWallet.get(k)!.push(res[i]!.ret);
  });
  const clusters = [...byWallet.values()];
  const rand = rng(hashSeed("size-boot", seed));
  const meds: number[] = [], trims: number[] = [];
  for (let b = 0; b < B; b++) {
    const rets: number[] = [];
    for (let i = 0; i < clusters.length; i++) rets.push(...clusters[Math.floor(rand() * clusters.length)]!);
    const s = stat(rets);
    meds.push(s.median);
    trims.push(s.trimmed);
  }
  meds.sort((a, b) => a - b);
  trims.sort((a, b) => a - b);
  return { median: [quantile(meds, 0.025), quantile(meds, 0.975)], trimmed: [quantile(trims, 0.025), quantile(trims, 0.975)], wallets: clusters.length };
}

/** Results aligned with records (only records whose simulation is ok at this delay/size). */
function run(recs: ReplRecord[], delay: number, size: number) {
  const pp = { ...p, followerSizeSol: size };
  const kept: ReplRecord[] = [];
  const res: FollowerResult[] = [];
  for (const r of recs) {
    const [x] = followerResults([r], delay, pp, costs);
    if (x) {
      kept.push(r);
      res.push(x);
    }
  }
  return { kept, res };
}

const md: string[] = [
  `# Follower-size sensitivity`, ``,
  `Steps: ${weeks} weekly steps from \`${ctx.stepsDir}\` (cached, no credits). Same leader buys at every size and delay (records with unreadable tape are dropped at load). ` +
  `Costs: venue fee per side, base ${costs.baseFeeSol} + priority ${costs.priorityFeeSol} SOL per tx, contested entries (≥ ${costs.contestedBuyers30} buyers in 30 s) ${costs.contestedPriorityFeeSol} priority + ${costs.jitoTipSol} Jito. ` +
  `Intervals: 95% wallet-clustered bootstrap (${B} resamples of leader-wallet × week clusters). B1 = median over ${p.seeds} seeds of random eligible wallets at the same size and delay.`, ``,
];
const json: Record<string, unknown>[] = [];
for (const id of methods) {
  const recs = methodRecords(steps, id, p.topN);
  md.push(`## ${id} (top ${p.topN} per week, ${recs.length} buys)`, ``);
  const rows: Array<Array<string | number>> = [];
  for (const size of sizes) {
    for (const d of delays) {
      const { kept, res } = run(recs, d, size);
      const rets = res.map((x) => x.ret);
      const s = stat(rets);
      const ci = bootstrap(kept, res, `${id}|${size}|${d}`);
      const b1 = Array.from({ length: p.seeds }, (_, seed) => stat(followerResults(randomSeedRecords(steps, seed, p.topN, p.maxBuysRandom), d, { ...p, followerSizeSol: size }, costs).map((x) => x.ret)));
      const solPerWeek = (mean(rets) * size * res.length) / weeks;
      rows.push([size, `${d}s`, res.length, pct(s.median), `${pct(ci.median[0]!)} … ${pct(ci.median[1]!)}`, pct(s.trimmed), `${pct(ci.trimmed[0]!)} … ${pct(ci.trimmed[1]!)}`,
        pct(mean(res.map((x) => x.slippage))), pct(mean(res.map((x) => x.fees))), pct(mean(res.map((x) => x.delayCost))),
        pct(median(b1.map((x) => x.median))), pct(median(b1.map((x) => x.trimmed))), num(solPerWeek, 3)]);
      json.push({ method: id, size, delay: d, n: res.length, ...s, ci, slippage: mean(res.map((x) => x.slippage)), fees: mean(res.map((x) => x.fees)),
        b1Median: median(b1.map((x) => x.median)), b1Trimmed: median(b1.map((x) => x.trimmed)), solPerWeek });
    }
  }
  md.push(table(["Size SOL", "Delay", "Trades", "Median", "95% CI", "Mean −top1%", "95% CI", "Slippage", "Fees", "Delay cost", "B1 median", "B1 mean −top1%", "SOL / week"], rows), ``);
}
const leader = steps.flatMap((s) => s.records).map((r) => r.leaderSol).sort((a, b) => a - b);
md.push(`Leader buy size: median ${num(median(leader), 3)} SOL, p25 ${num(quantile(leader, 0.25), 3)}, p75 ${num(quantile(leader, 0.75), 3)}.`, ``);
md.push(`"SOL / week" = mean net return × size × trades ÷ weeks: what following every sampled buy of the top ${p.topN} would have made per week (sampled buys only, so a lower bound on volume, not on return).`);
const files = writeReportFiles("reports", "size", md.join("\n"), { rows: json, leaderSize: { median: median(leader) } });
console.log(files);

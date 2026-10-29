import type { CostParams, StudyParams } from "../config/params.js";
import { RANKINGS, type RankingId } from "../ranking/rank.js";
import { hashSeed, rng, sample } from "../util/rng.js";
import { iso, num, pct, table } from "../util/run.js";
import { mean, median, spearman, stats, trimTop, type Stats } from "../util/stats.js";
import { simulateFollower, type FollowerResult } from "./follower.js";
import type { StepResult } from "./pipeline.js";
import type { ReplRecord } from "./types.js";

export interface DelayRow {
  delay: number;
  stats: Stats;
  meanTrimmed1: number;
  captureRatio: number;
  rugRate: number;
  alpha: number;
  delayCost: number;
  slippage: number;
  fees: number;
  rugLoss: number;
  leaderMean: number;
}

export interface GateCheck {
  name: string;
  value: string;
  threshold: string;
  pass: boolean;
}

export function followerResults(recs: ReplRecord[], delay: number, p: StudyParams, costs: CostParams): FollowerResult[] {
  return recs
    .map((r) => simulateFollower(r, { delay, sizeSol: p.followerSizeSol, costs, maxHoldHours: p.maxHoldHours }))
    .filter((x) => x.ok);
}

export function delayRow(res: FollowerResult[], delay: number): DelayRow {
  const rets = res.map((x) => x.ret);
  const lead = res.map((x) => x.leaderRet);
  return {
    delay,
    stats: stats(rets),
    meanTrimmed1: mean(trimTop(rets, 0.01)),
    captureRatio: mean(lead) !== 0 ? mean(rets) / mean(lead) : NaN,
    rugRate: res.length ? res.filter((x) => x.rug).length / res.length : NaN,
    alpha: mean(res.map((x) => x.alpha)),
    delayCost: mean(res.map((x) => x.delayCost)),
    slippage: mean(res.map((x) => x.slippage)),
    fees: mean(res.map((x) => x.fees)),
    rugLoss: mean(res.map((x) => x.rugLoss)),
    leaderMean: mean(lead),
  };
}

/** Records of a method's top-N wallets. */
export function methodRecords(steps: StepResult[], id: RankingId, topN: number): ReplRecord[] {
  return steps.flatMap((s) => {
    const top = new Set(s.rankings[id].slice(0, topN));
    return s.records.filter((r) => top.has(r.wallet));
  });
}

/** B1: per seed, per step, `n` random wallets from the random eligible pool; each wallet's records capped to maxBuys. */
export function randomSeedRecords(steps: StepResult[], seed: number, n: number, maxBuys: number): ReplRecord[] {
  const out: ReplRecord[] = [];
  for (const s of steps) {
    const rand = rng(hashSeed("B1", seed, s.step));
    const pool = s.randomPool.filter((w) => s.records.some((r) => r.wallet === w));
    for (const w of sample(pool, n, rand)) out.push(...sample(s.records.filter((r) => r.wallet === w), maxBuys, rand));
  }
  return out;
}

export function buildStudyReport(
  steps: StepResult[], p: StudyParams, costs: CostParams, meta: { from: number; to: number; commit: string; credits: number; creditsByKind: unknown; label: string },
) {
  const primaryEval = String(p.evalDays[0]);
  // --- Persistence (H1) ---
  const persistence: Record<string, Array<Record<string, number>>> = {};
  const pooled: Record<string, { f: number[]; e: number[] }> = {};
  for (const ed of p.evalDays.map(String)) {
    persistence[ed] = [];
    pooled[ed] = { f: [], e: [] };
    for (const s of steps) {
      const perf = s.evalPerf[ed] ?? {};
      const el = s.metrics.filter((m) => Number.isFinite(m.roc) && perf[m.wallet] && isEligible(s, m.wallet));
      if (el.length < 10) continue;
      const sorted = [...el].sort((a, b) => b.roc - a.roc);
      const ev = (ws: string[]) => ws.map((w) => perf[w]?.roc ?? NaN).filter(Number.isFinite);
      const dec = Math.max(1, Math.floor(sorted.length / 10));
      const deciles: number[] = [];
      for (let d = 0; d < 10; d++) deciles.push(median(ev(sorted.slice(d * dec, d === 9 ? sorted.length : (d + 1) * dec).map((m) => m.wallet))));
      const all = ev(sorted.map((m) => m.wallet));
      const row: Record<string, number> = { step: s.step, n: el.length, medianAll: median(all), spearman: spearman(el.map((m) => m.roc), el.map((m) => perf[m.wallet]!.roc)) };
      deciles.forEach((v, i) => (row[`d${i + 1}`] = v));
      for (const id of RANKINGS) for (const k of [1, 3, 10]) row[`${id}top${k}`] = mean(ev(s.rankings[id].slice(0, k)));
      persistence[ed].push(row);
      pooled[ed].f.push(...el.map((m) => m.roc));
      pooled[ed].e.push(...el.map((m) => perf[m.wallet]!.roc));
    }
  }
  const prim = persistence[primaryEval] ?? [];
  const topBeats = prim.filter((r) => r.d1! > r.medianAll!).length;
  const pooledRho = spearman(pooled[primaryEval]?.f ?? [], pooled[primaryEval]?.e ?? []);
  const g1 = prim.length > 0 && topBeats / prim.length >= 0.67 && pooledRho > 0;

  // --- Replication (H2) and selection (H3) ---
  const repl: Record<string, DelayRow[]> = {};
  for (const id of RANKINGS) repl[id] = p.delays.map((d) => delayRow(followerResults(methodRecords(steps, id, p.topN), d, p, costs), d));
  const seeds: Record<string, Array<{ median: number; trimmed: number; n: number }>> = {};
  for (const d of p.delays) {
    seeds[String(d)] = [];
    for (let seed = 0; seed < p.seeds; seed++) {
      const res = followerResults(randomSeedRecords(steps, seed, p.topN, p.maxBuysRandom), d, p, costs);
      const rets = res.map((x) => x.ret);
      seeds[String(d)]!.push({ median: median(rets), trimmed: mean(trimTop(rets, 0.01)), n: rets.length });
    }
  }
  const b1Row = (d: number) => {
    const s = seeds[String(d)]!;
    return { median: median(s.map((x) => x.median)), trimmed: median(s.map((x) => x.trimmed)) };
  };
  // G2: some method with median > 0 and trimmed mean > 0 at a delay >= 5s. G3: that method beats B1 at that delay.
  let chosen: { id: RankingId; delay: number } | null = null;
  let g2 = false, g3 = false;
  const candidates: Array<{ id: RankingId; delay: number; median: number; trimmed: number; beatsB1: boolean }> = [];
  for (const id of RANKINGS)
    for (const row of repl[id]!) {
      if (row.delay < 5 || row.stats.n === 0) continue;
      const b = b1Row(row.delay);
      candidates.push({ id, delay: row.delay, median: row.stats.median, trimmed: row.meanTrimmed1, beatsB1: row.stats.median > b.median && row.meanTrimmed1 > b.trimmed });
    }
  const passing = candidates.filter((c) => c.median > 0 && c.trimmed > 0);
  if (passing.length) {
    g2 = true;
    const best = passing.find((c) => c.beatsB1) ?? passing[0]!;
    chosen = { id: best.id, delay: best.delay };
    g3 = best.beatsB1;
  } else {
    // nothing passes G2: report the best method at the 5s headline delay for Phase B
    const at5 = candidates.filter((c) => c.delay === 5).sort((a, b) => b.median - a.median)[0];
    if (at5) {
      chosen = { id: at5.id, delay: 5 };
      g3 = at5.beatsB1;
    }
  }
  const checks: GateCheck[] = [
    { name: "G1 persistence: top decile beats median eligible", value: prim.length ? `${topBeats}/${prim.length} steps (${pct(topBeats / prim.length, 0)})` : "no steps", threshold: "≥ 67%", pass: prim.length > 0 && topBeats / prim.length >= 0.67 },
    { name: "G1 persistence: pooled Spearman", value: num(pooledRho, 3), threshold: "> 0", pass: pooledRho > 0 },
    { name: "G2 copyability: median and top-1%-trimmed mean > 0 at ≥ 5s", value: passing.length ? passing.map((c) => `${c.id}@${c.delay}s`).join(", ") : "none", threshold: "some method", pass: g2 },
    { name: "G3 selection: beats random eligible wallets (B1)", value: chosen ? `${chosen.id}@${chosen.delay}s ${g3 ? "beats" : "does not beat"} B1 median of ${p.seeds} seeds` : "n/a", threshold: "median and trimmed mean above B1", pass: g3 },
  ];
  const gate = g1 && g2 && g3;

  // --- Markdown ---
  const totalRecs = new Set(steps.flatMap((s) => s.records.map((r) => r.sig + r.wallet))).size;
  const md: string[] = [];
  md.push(`# Phase A: persistence and replication study`);
  md.push(`\n**Gate: ${gate ? "PASS" : "FAIL"}** (G1 ${g1 ? "pass" : "fail"}, G2 ${g2 ? "pass" : "fail"}, G3 ${g3 ? "pass" : "fail"}). Phase B is run regardless (user decision) and its results should be read in light of this.`);
  const dropped = steps.reduce((x, st) => x + (st.droppedMissing ?? 0), 0);
  md.push(`\nData ${iso(meta.from)} → ${iso(meta.to)}, ${steps.length} walk-forward steps (formation ${p.formationDays}d, eval ${p.evalDays.join("/")}d, step ${p.stepDays}d). ${totalRecs} replicated leader buys${dropped ? ` (plus ${dropped} dropped because part of their tape could not be read; every delay uses the same buys)` : ""}. Commit ${meta.commit}. Helius credits used in total: ${meta.credits.toLocaleString("en-US")}.`);
  md.push(`\n## Gate\n\n${table(["Check", "Value", "Threshold", "Pass"], checks.map((c) => [c.name, c.value, c.threshold, c.pass ? "✅" : "❌"]))}`);

  md.push(`\n## Discovery and filtering per step\n`);
  md.push(table(
    ["Step", "Formation", "Sampled swaps", "Qualifying tokens", "Sampled wallets", "Screened", "HFT", "Too active", "Candidates (cap)", "Excluded (mev/arb/creator/hft)", "Eligible"],
    steps.map((s) => [s.step, `${iso(s.F0)}→${iso(s.F1)}`, s.discovery.sampledSwaps, s.discovery.qualifyingTokens, s.discovery.sampledWallets, s.discovery.screened, s.discovery.hft, s.discovery.capped, `${s.discovery.candidates} (${s.discovery.candidateCap})`, `${s.excluded.mev ?? 0}/${s.excluded.arb ?? 0}/${s.excluded.creator ?? 0}/${s.excluded.hft ?? 0}`, s.eligible]),
  ));
  const inel: Record<string, number> = {};
  for (const s of steps) for (const [k, v] of Object.entries(s.ineligible)) inel[k] = (inel[k] ?? 0) + v;
  md.push(`\nIneligibility reasons (summed over steps; a wallet can fail several): ${Object.entries(inel).map(([k, v]) => `${k} ${v}`).join(", ")}.`);
  md.push(`Seed group (R-W3): no manual Fomo seed list was supplied (\`data/seed-wallets.txt\`), so it is not reported.`);

  for (const ed of p.evalDays.map(String)) {
    const rows = persistence[ed] ?? [];
    md.push(`\n## Persistence (H1), ${ed}-day evaluation window\n`);
    md.push(`Median eval-window return on capital of eligible wallets, by formation decile (d1 = best formation ROC), vs the median eligible wallet.\n`);
    md.push(table(
      ["Step", "n", "d1", "d2", "d5", "d10", "Median all", "Top1 S2", "Top3 S2", "Top10 S2", "Spearman"],
      rows.map((r) => [r.step!, r.n!, pct(r.d1!), pct(r.d2!), pct(r.d5!), pct(r.d10!), pct(r.medianAll!), pct(r.S2top1!), pct(r.S2top3!), pct(r.S2top10!), num(r.spearman!, 2)]),
    ));
    const avg = (k: string) => median(rows.map((r) => r[k]!).filter(Number.isFinite));
    md.push(`\nAcross steps (median): ${["d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8", "d9", "d10"].map((k) => `${k} ${pct(avg(k))}`).join(", ")}; median eligible ${pct(avg("medianAll"))}. Pooled Spearman ${num(spearman(pooled[ed]!.f, pooled[ed]!.e), 3)} (n=${pooled[ed]!.f.length}).`);
    md.push(`\nTop-k by method (mean eval ROC, median across steps): ${RANKINGS.map((id) => `${id} top1 ${pct(avg(`${id}top1`))} / top3 ${pct(avg(`${id}top3`))} / top10 ${pct(avg(`${id}top10`))}`).join("; ")}.`);
  }

  md.push(`\n## Replication (H2): follower of each leader buy, ${p.followerSizeSol} SOL, exits mirror leader sells, time stop ${p.maxHoldHours}h\n`);
  md.push(`Returns are net of venue fees, priority fees/tips and rugs. Delay 0 is B5 (leader's own fill price). Capture = mean follower return ÷ mean leader return on the same buys.\n`);
  for (const id of RANKINGS) {
    md.push(`\n### ${id}, top ${p.topN} wallets per step\n`);
    md.push(table(
      ["Delay", "Trades", "Median", "Mean", "Mean −top1%", "Hit", "p5", "p95", "Capture", "Rug rate", "Alpha", "Delay cost", "Slippage", "Fees", "Rug loss", "B1 median"],
      repl[id]!.map((r) => [`${r.delay}s`, r.stats.n, pct(r.stats.median), pct(r.stats.mean), pct(r.meanTrimmed1), pct(r.stats.hit, 0), pct(r.stats.p5), pct(r.stats.p95), num(r.captureRatio, 2), pct(r.rugRate), pct(r.alpha), pct(r.delayCost), pct(r.slippage), pct(r.fees), pct(r.rugLoss), pct(b1Row(r.delay).median)]),
    ));
  }
  md.push(`\nAttribution columns are mean contributions to the follower's return and sum to the mean (alpha + delay cost + slippage + fees + rug loss = mean).`);
  md.push(`\n## Random eligible wallets (B1 control), ${p.seeds} seeds × ${p.topN} wallets per step\n`);
  md.push(table(["Delay", "Median of seed medians", "Median of seed trimmed means", "Seed medians p10–p90"], p.delays.map((d) => {
    const s = seeds[String(d)]!.map((x) => x.median).sort((a, b) => a - b);
    return [`${d}s`, pct(b1Row(d).median), pct(b1Row(d).trimmed), `${pct(s[Math.floor(s.length * 0.1)] ?? NaN)} – ${pct(s[Math.floor(s.length * 0.9)] ?? NaN)}`];
  })));
  md.push(`\n## Config\n\n\`\`\`json\n${JSON.stringify({ study: p, costs }, null, 2)}\n\`\`\``);
  md.push(`\nCredits by kind: \`${JSON.stringify(meta.creditsByKind)}\``);
  return { md: md.join("\n"), json: { meta, gate, checks, chosen, persistence, pooledRho, repl, seeds, study: p, costs }, gate, chosen };
}

function isEligible(s: StepResult, wallet: string): boolean {
  return s.eligibleWallets.includes(wallet);
}

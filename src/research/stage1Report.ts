/**
 * Copyability spec Stage 1 report: S5, S6 against S2, B1 (random eligible wallets, 20 seeds) and B5 (same buys at
 * 0 s), the pre-registered gates G1–G7 and the outcome. Pure over cached Stage 1 steps.
 */
import type { CostParams, StudyParams } from "../config/params.js";
import { STAGE1 } from "../score/config.js";
import { asLeaderExit, simulateC, trimmed } from "../score/copyability.js";
import { hashSeed, rng, sample } from "../util/rng.js";
import { iso, num, pct, table } from "../util/run.js";
import { mean, median, quantile, spearman } from "../util/stats.js";
import { simulateFollower, type FollowerResult } from "./follower.js";
import { hasMissingTape } from "./loadSteps.js";
import { STAGE1_METHODS, type Stage1Method, type Stage1Step } from "./stage1.js";
import type { ReplRecord } from "./types.js";

type Sel = { rec: ReplRecord; res: FollowerResult };

function run(recs: ReplRecord[], delay: number, size: number, p: StudyParams, costs: CostParams): Sel[] {
  return recs.flatMap((rec) => {
    const res = simulateFollower(rec, { delay, sizeSol: size, costs, maxHoldHours: p.maxHoldHours });
    return res.ok ? [{ rec, res }] : [];
  });
}

/** Wallet-clustered bootstrap (resample wallets, all their trades across weeks): 95% two-sided and the one-sided 95% lower bound. */
function boot(xs: Sel[], seed: string) {
  const by = new Map<string, number[]>();
  for (const x of xs) by.set(x.rec.wallet, [...(by.get(x.rec.wallet) ?? []), x.res.ret]);
  const cl = [...by.values()];
  if (!cl.length) return { median: [NaN, NaN], trimmed: [NaN, NaN], lower: NaN };
  const rand = rng(hashSeed("stage1-boot", seed));
  const meds: number[] = [], trims: number[] = [];
  for (let b = 0; b < STAGE1.boot; b++) {
    const r: number[] = [];
    for (let i = 0; i < cl.length; i++) r.push(...cl[Math.floor(rand() * cl.length)]!);
    meds.push(median(r));
    trims.push(trimmed(r));
  }
  meds.sort((a, b) => a - b);
  trims.sort((a, b) => a - b);
  return { median: [quantile(meds, 0.025), quantile(meds, 0.975)], trimmed: [quantile(trims, 0.025), quantile(trims, 0.975)], lower: quantile(trims, 0.05) };
}

function summary(xs: Sel[], weeks: number, size: number) {
  const r = xs.map((x) => x.res.ret);
  const m = (k: "alpha" | "delayCost" | "slippage" | "fees" | "rugLoss") => mean(xs.map((x) => x.res[k]));
  return {
    trades: xs.length, wallets: new Set(xs.map((x) => x.rec.wallet)).size, median: r.length ? median(r) : NaN, trimmed: r.length ? trimmed(r) : NaN,
    hit: r.length ? r.filter((v) => v > 0).length / r.length : NaN, rug: r.length ? xs.filter((x) => x.res.rug).length / r.length : NaN,
    alpha: m("alpha"), delayCost: m("delayCost"), slippage: m("slippage"), fees: m("fees"), rugLoss: m("rugLoss"),
    solPerWeek: r.length ? (mean(r) * size * r.length) / weeks : 0,
  };
}

export function buildStage1Report(steps: Stage1Step[], p: StudyParams, costs: CostParams, meta: { commit: string; credits: number; creditsByKind: unknown; dir: string; phaseADir: string }) {
  const weeks = steps.length;
  const raw = steps.flatMap((s) => s.records);
  const kept = (rs: ReplRecord[]) => rs.filter((r) => !hasMissingTape(r));
  const methodRaw = (m: Stage1Method) => steps.flatMap((s) => {
    const w = new Set(s.rankings[m]);
    return s.records.filter((r) => w.has(r.wallet));
  });
  const methodRecs = (m: Stage1Method) => kept(methodRaw(m));
  const b1Seed = (seed: number) => steps.flatMap((s) => {
    const rs = kept(s.records);
    const pool = s.randomPool.filter((w) => rs.some((r) => r.wallet === w)).sort();
    const pick = new Set(sample(pool, STAGE1.topN, rng(hashSeed("S1-B1", seed, s.step))));
    return rs.filter((r) => pick.has(r.wallet));
  });
  const H = STAGE1.headlineDelay, size = STAGE1.sizeSol;
  const settings = [
    { name: `${H} s / ${size} SOL (headline)`, d: H, size },
    { name: `${STAGE1.robustDelay} s / ${size} SOL`, d: STAGE1.robustDelay, size },
    { name: `${H} s / ${STAGE1.robustSize} SOL`, d: H, size: STAGE1.robustSize },
    { name: `0 s / ${size} SOL (B5)`, d: 0, size },
  ];
  const res: Record<string, Record<string, ReturnType<typeof summary> & { ci?: ReturnType<typeof boot>; perWeek?: number[] }>> = {};
  for (const m of STAGE1_METHODS) {
    res[m] = {};
    for (const st of settings) {
      const xs = run(methodRecs(m), st.d, st.size, p, costs);
      const perWeek = steps.map((s) => { const r = xs.filter((x) => x.rec.step === s.step).map((x) => x.res.ret); return r.length ? trimmed(r) : NaN; });
      res[m]![st.name] = { ...summary(xs, weeks, st.size), ci: boot(xs, `${m}|${st.name}`), perWeek };
    }
  }
  const b1: Record<string, { median: number; trimmed: number; trades: number }> = {};
  for (const st of settings) {
    const per = Array.from({ length: STAGE1.seeds }, (_, seed) => summary(run(b1Seed(seed), st.d, st.size, p, costs), weeks, st.size));
    b1[st.name] = { median: median(per.map((x) => x.median)), trimmed: median(per.map((x) => x.trimmed)), trades: median(per.map((x) => x.trades)) };
  }

  // Score persistence (G7): formation C vs eval-window C (same semantics) per wallet-step.
  const pairs: Array<{ step: number; wallet: string; f: number; e: number; n: number }> = [];
  for (const s of steps) {
    for (const w of s.evalWallets) {
      const f = s.scores[w]?.C;
      if (f === null || f === undefined) continue;
      const rs = kept(s.records.filter((r) => r.wallet === w)).map((r) => simulateC(asLeaderExit(r, p.minExitLiquiditySol), costs)).filter((x) => x !== null).map((x) => x!.ret);
      if (rs.length >= STAGE1.evalCMinBuys) pairs.push({ step: s.step, wallet: w, f, e: trimmed(rs), n: rs.length });
    }
  }
  const rho = pairs.length >= 3 ? spearman(pairs.map((x) => x.f), pairs.map((x) => x.e)) : NaN;

  // Drop rates per method (5.5)
  const drop = (rs: ReplRecord[]) => (rs.length ? rs.filter(hasMissingTape).length / rs.length : NaN);
  const randomRaw = steps.flatMap((s) => s.records.filter((r) => s.randomPool.includes(r.wallet)));
  const drops: Record<string, number> = { ...Object.fromEntries(STAGE1_METHODS.map((m) => [m, drop(methodRaw(m))])), B1: drop(randomRaw), all: drop(raw) };
  const venues = [...new Set(raw.map((r) => r.venue))].sort();

  // Gates
  const hl = settings[0]!.name, rb = settings[1]!.name;
  const gates = (m: "S5" | "S6") => {
    const h = res[m]![hl]!, r15 = res[m]![rb]!, s2 = res.S2![hl]!, b = b1[hl]!;
    const pos = h.perWeek!.filter((x) => x > 0).length;
    return [
      { id: "G1", name: "≥ 150 eval buys from ≥ 15 wallets", value: `${h.trades} buys, ${h.wallets} wallets`, pass: h.trades >= STAGE1.minTrades && h.wallets >= STAGE1.minWallets },
      { id: "G2", name: "median > 0 and trimmed mean > 0 (5 s)", value: `${pct(h.median)}, ${pct(h.trimmed)}`, pass: h.median > 0 && h.trimmed > 0 },
      { id: "G3", name: "one-sided 95% lower bound of trimmed mean > 0", value: pct(h.ci!.lower), pass: h.ci!.lower > 0 },
      { id: "G4", name: "trimmed mean > 0 at 15 s", value: pct(r15.trimmed), pass: r15.trimmed > 0 },
      { id: "G5", name: "beats B1 and S2 on median and trimmed mean (5 s)", value: `${pct(h.median)} / ${pct(h.trimmed)} vs B1 ${pct(b.median)} / ${pct(b.trimmed)}, S2 ${pct(s2.median)} / ${pct(s2.trimmed)}`,
        pass: h.median > b.median && h.trimmed > b.trimmed && h.median > s2.median && h.trimmed > s2.trimmed },
      { id: "G6", name: `positive trimmed mean in ≥ ${STAGE1.minPositiveWeeks} of ${weeks} weeks`, value: `${pos} of ${weeks}`, pass: pos >= STAGE1.minPositiveWeeks },
      { id: "G7", name: "Spearman(formation C, eval C) > 0", value: `${num(rho)} (n = ${pairs.length})`, pass: rho > 0 },
    ];
  };
  const g = { S5: gates("S5"), S6: gates("S6") };
  const outcomeOf = (gs: ReturnType<typeof gates>) => {
    const ok = (id: string) => gs.find((x) => x.id === id)!.pass;
    if (gs.every((x) => x.pass)) return "GO";
    if (ok("G2") && ok("G5") && (!ok("G1") || !ok("G3"))) return "INCONCLUSIVE";
    return "NO-GO";
  };
  const outcomes = { S5: outcomeOf(g.S5), S6: outcomeOf(g.S6) };
  const outcome = Object.values(outcomes).includes("GO") ? "GO" : Object.values(outcomes).includes("INCONCLUSIVE") ? "INCONCLUSIVE" : "NO-GO";

  const md: string[] = [
    `# Copyability score: Stage 1`, ``,
    `**Outcome: ${outcome}** (S5 ${outcomes.S5}, S6 ${outcomes.S6}).`, ``,
    `Pre-registered spec \`docs/copyability-score-spec.md\` and config \`src/score/config.ts\`, commit **${meta.commit}**. ${weeks} weekly steps (${steps.length ? `${iso(steps[0]!.F0)} → ${iso(steps[steps.length - 1]!.F1)} formations` : "none"}). ` +
    `Universe: the cached Phase A steps \`${meta.phaseADir}\` (eligible wallets, formation metrics, S2, random pool). Stage 1 cache: \`${meta.dir}\`.`, ``,
    `Methods: S5 = top ${STAGE1.topN} eligible by C (top-1%-trimmed mean of ${STAGE1.cDelay} s copy returns over ≤ ${STAGE1.formationBuys} formation buys, exits at the leader's own sells, ≥ ${STAGE1.minCBuys} readable); ` +
    `S6 = eligible with I ≤ ${STAGE1.maxImpact}, top ${STAGE1.topN} by formation return on capital; S2 = Phase A list. B1 = ${STAGE1.topN} random wallets from the random pool, median over ${STAGE1.seeds} seeds. ` +
    `Eval: ≤ ${STAGE1.evalBuys} buys per wallet in the first eval week, Phase A simulator (exits mirror the leader at the same delay, ${p.maxHoldHours} h time stop, fees, rugs).`, ``,
    `## Gates`, ``,
    table(["Gate", "Criterion", "S5", "S6"], g.S5.map((x, i) => [x.id, x.name, `${x.value} ${x.pass ? "✓" : "✗"}`, `${g.S6[i]!.value} ${g.S6[i]!.pass ? "✓" : "✗"}`])), ``,
    `GO needs G1–G7 for one method; INCONCLUSIVE = G2 and G5 pass but G1 or G3 fails (only follow-up: more data, same spec); otherwise NO-GO.`, ``,
    `## Results`, ``,
  ];
  for (const st of settings) {
    md.push(`### ${st.name}`, ``, table(["Method", "Trades", "Wallets", "Median", "95% CI", "Mean −top1%", "95% CI", "1-sided 95% LB", "Hit", "Rug", "Alpha", "Delay", "Slippage", "Fees", "Rug loss", "SOL / week"],
      STAGE1_METHODS.map((m) => {
        const x = res[m]![st.name]!;
        return [m, x.trades, x.wallets, pct(x.median), `${pct(x.ci!.median[0]!)} … ${pct(x.ci!.median[1]!)}`, pct(x.trimmed), `${pct(x.ci!.trimmed[0]!)} … ${pct(x.ci!.trimmed[1]!)}`, pct(x.ci!.lower),
          pct(x.hit), pct(x.rug), pct(x.alpha), pct(x.delayCost), pct(x.slippage), pct(x.fees), pct(x.rugLoss), num(x.solPerWeek, 3)];
      }).concat([["B1", b1[st.name]!.trades, "–", pct(b1[st.name]!.median), "–", pct(b1[st.name]!.trimmed), "–", "–", "–", "–", "–", "–", "–", "–", "–", "–"]])), ``);
  }
  md.push(`### Per week, ${hl}: mean −top1%`, ``,
    table(["Method", ...steps.map((s) => `${s.step} (${iso(s.F1)})`)], STAGE1_METHODS.map((m) => [m, ...res[m]![hl]!.perWeek!.map((x) => (Number.isFinite(x) ? pct(x) : "–"))])), ``);
  md.push(`## Score persistence (G7)`, ``,
    `Spearman between each wallet's formation C and its eval-window C (same semantics on its eval buys, ≥ ${STAGE1.evalCMinBuys} readable), pooled over wallet-steps of every replicated wallet (S2, S5, S6, random pool): **${num(rho)}** over ${pairs.length} pairs.`, ``);
  const withC = steps.map((s) => Object.values(s.scores).filter((x) => x.C !== null).length);
  const withI = steps.map((s) => Object.values(s.scores).filter((x) => x.I !== null).length);
  md.push(`## Scoring coverage`, ``,
    table(["Step", "Eligible", "With C", "With I", "I ≤ 0.30", "S5", "S6", "S2", "S5∩S2", "S6∩S2", "Eval records (raw)", "Credits"], steps.map((s, i) => [s.step, Object.keys(s.scores).length, withC[i], withI[i],
      Object.values(s.scores).filter((x) => x.I !== null && x.I <= STAGE1.maxImpact).length, s.rankings.S5.length, s.rankings.S6.length, s.rankings.S2.length,
      s.rankings.S5.filter((w) => s.rankings.S2.includes(w)).length, s.rankings.S6.filter((w) => s.rankings.S2.includes(w)).length, s.records.length, s.creditsAfter - s.creditsBefore])), ``);
  md.push(`## Drop rates (unreadable tape)`, ``,
    table(["Method", "Drop rate", "Flag (> 15 pts from S2)"], Object.entries(drops).map(([k, v]) => [k, pct(v), STAGE1_METHODS.includes(k as Stage1Method) && k !== "S2" && Math.abs(v - drops.S2!) > STAGE1.dropFlag ? "**flagged**" : ""])), ``,
    table(["Venue", "Eval buys", "Dropped %"], venues.map((v) => { const rs = raw.filter((r) => r.venue === v); return [v, rs.length, pct(drop(rs))]; })), ``);
  md.push(`## Credits`, ``, `Stage 1 used ${meta.credits.toLocaleString("en-US")} credits (cap ${STAGE1.creditCap.toLocaleString("en-US")}). By kind: ${Object.entries(meta.creditsByKind as Record<string, number>).map(([k, v]) => `${k} ${v.toLocaleString("en-US")}`).join(", ")}.`);
  return { md: md.join("\n"), json: { meta, config: STAGE1, outcome, outcomes, gates: g, results: res, b1, persistence: { rho, pairs }, drops }, outcome };
}

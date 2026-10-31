/**
 * Exploratory selection-rule report over the cached universe steps (pure). Exploratory: rules are searched on
 * steps 0–2 and judged on the holdout steps 3–5, against random wallets passing the same filter, with a
 * max-statistic permutation null for the search itself.
 */
import type { CostParams } from "../config/params.js";
import { suspectRecord } from "../research/stage1Report.js";
import { iso, num, pct, table } from "../util/run.js";
import { mean, median, spearman } from "../util/stats.js";
import { EXPLORE } from "./config.js";
import type { UStep } from "./universe.js";
import {
  BASE_FILTER, boot, buildGrid, filterLabel, KEYS, permutations, prepare, randomPick, ruleLabel, scoreGrid, selectWallets, selsOf, summarize, trimmed, valid,
  type Rule, type Sel, type StepData,
} from "./variants.js";

const H = EXPLORE.settings[0].name;
const Z = EXPLORE.settings.find((x) => x.delay === 0)!.name;
const ONE = EXPLORE.settings.find((x) => x.delay === 1)!.name;
const clean = (r: Parameters<typeof suspectRecord>[0]) => !suspectRecord(r);

function perStep(data: StepData[], xs: Sel[]) {
  return data.map((d) => {
    const r = xs.filter((x) => x.rec.step === d.step).map((x) => x.res.ret);
    return r.length ? trimmed(r) : NaN;
  });
}

function randomBaseline(data: StepData[], filter: Rule["filter"], topN: number, setting = H) {
  const per = Array.from({ length: EXPLORE.seeds }, (_, seed) => summarize(selsOf(data, randomPick(filter, topN, seed), setting), clean));
  return { median: median(per.map((x) => x.median)), trimmed: median(per.map((x) => x.trimmed)), trades: median(per.map((x) => x.trades)) };
}

export function buildExploreReport(steps: UStep[], costs: CostParams, maxHoldHours: number, meta: { commit: string; credits: number; creditsByKind: Record<string, number>; dir: string }) {
  const data = prepare(steps, costs, maxHoldHours);
  const idx = (ids: readonly number[]) => ids.map((s) => data.findIndex((d) => d.step === s)).filter((i) => i >= 0);
  // Planned split: discovery 0–2, holdout 3–5. With fewer completed steps (credit cap), the later half is the holdout.
  const planned = EXPLORE.holdoutSteps.every((x) => data.some((d) => d.step === x));
  const nD = Math.ceil(data.length / 2);
  const discSteps = planned ? [...EXPLORE.discoverySteps] : data.slice(0, nD).map((d) => d.step);
  const holdSteps = planned ? [...EXPLORE.holdoutSteps] : data.slice(nD).map((d) => d.step);
  const disc = idx(discSteps), hold = idx(holdSteps);
  const dData = disc.map((i) => data[i]!), hData = hold.map((i) => data[i]!);
  const md: string[] = [];
  const json: Record<string, unknown> = { meta, config: EXPLORE };

  md.push(`# Selection rules: exploratory search`, ``,
    `**Exploratory, not pre-registered.** Scoring window ${EXPLORE.formationDays} days, simulation window ${EXPLORE.evalDays} days (the following month), ${steps.length} monthly steps. ` +
    `Universe per step: every discovered candidate (≤ ${EXPLORE.candidateCap}, histories ≤ ${EXPLORE.maxHistoryTx} txs) that is not a bot / MEV / arb / creator and closed ≥ ${EXPLORE.minClosed} positions in the scoring window, ` +
    `with its eval history and at least one buy in the simulation month. Up to ${EXPLORE.evalBuys} of each wallet's buys in the month are replicated; leader buys under 0.01 SOL are not copied (Phase A simulator: exits mirror the leader at the same delay, ${maxHoldHours} h time stop, fees, rugs). ` +
    `Rules are searched on steps ${discSteps.join(", ")} and judged on the holdout steps ${holdSteps.join(", ") || "(none)"}${planned ? "" : " (planned 0–2 / 3–5; fewer steps completed under the credit cap)"}. Commit ${meta.commit}; cache \`${meta.dir}\`.`, ``);

  md.push(`## Steps`, ``, table(["Step", "Scoring", "Simulation", "Candidates", "Universe", "Phase A eligible", "Selectable", "With C", "With I", "Records", "Readable", "Credits"],
    steps.map((s, i) => {
      const d = data[i]!;
      const sc = s.universe.map((x) => s.wallets[x]!.score);
      return [s.step, `${iso(s.F0)} → ${iso(s.F1)}`, `${iso(s.F1)} → ${iso(s.E)}`, s.discovery.candidates, s.universe.length, s.universe.filter((x) => !s.wallets[x]!.ineligible.length).length,
        d.wallets.length, sc.filter((x) => x?.C != null).length, sc.filter((x) => x?.I != null).length, s.records.length, [...d.recs.values()].flat().length, s.creditsAfter - s.creditsBefore];
    })), ``);

  // 1. Simple rankings over all steps
  md.push(`## 1. One ranking at a time (all ${steps.length} steps, top 10, filter: ${filterLabel(BASE_FILTER)})`, ``,
    `Own next month = the selected wallets' own return on capital in the simulation month (median). Leader = the leader's own return on the copied buys; 0 s = copy at the leader's price (fees, slippage, rugs); 0 s and 1 s columns are mean −top1%.`, ``);
  const simple = KEYS.map((k) => {
    const rule: Rule = { filter: BASE_FILTER, key: k.id, topN: 10 };
    const pick = (d: StepData) => selectWallets(d, rule);
    const xs = selsOf(data, pick, H), x0 = selsOf(data, pick, Z), x1 = selsOf(data, pick, ONE);
    const own = data.flatMap((d) => pick(d).map((w) => d.wallets.find((u) => u.wallet === w)!.own?.roc).filter((v): v is number => v !== undefined));
    const s = summarize(xs, clean), ci = boot(xs, `simple|${k.id}`), ps = perStep(data, xs);
    return { key: k.id, label: k.label, s, ci, ps, own: own.length ? median(own) : NaN, leader: mean(xs.filter((x) => clean(x.rec)).map((x) => x.res.leaderRet)), zero: summarize(x0, clean).trimmed, one: summarize(x1, clean).trimmed };
  });
  const allSel = selsOf(data, (d) => d.wallets.map((u) => u.wallet), H);
  const rb = randomBaseline(data, BASE_FILTER, 10);
  md.push(table(["Ranking", "Trades", "Wallets", "Own next month", "Leader", "0 s", "1 s", "5 s median", "5 s mean −top1%", "1-sided 95% LB", "Alpha", "Delay", "Positive steps"],
    simple.map((r) => [r.label, r.s.trades, r.s.wallets, pct(r.own), pct(r.leader), pct(r.zero), pct(r.one), pct(r.s.median), pct(r.s.trimmed), pct(r.ci.lower), pct(r.s.alpha), pct(r.s.delayCost), `${r.ps.filter((x) => x > 0).length} of ${steps.length}`])
      .concat([["random 10 (median of 20 seeds)", rb.trades, "–", "–", "–", "–", "–", pct(rb.median), pct(rb.trimmed), "–", "–", "–", "–"]])
      .concat([(() => { const s = summarize(allSel, clean); const every = (d: StepData) => d.wallets.map((u) => u.wallet);
        return ["all selectable wallets", s.trades, s.wallets, "–", "–", pct(summarize(selsOf(data, every, Z), clean).trimmed), pct(summarize(selsOf(data, every, ONE), clean).trimmed), pct(s.median), pct(s.trimmed), "–", pct(s.alpha), pct(s.delayCost), "–"]; })()])), ``);
  json.simple = simple.map(({ key, s, ci, ps, own, leader, zero, one }) => ({ key, ...s, lower: ci.lower, perStep: ps, own, leader, zero, one }));
  json.randomBase = rb;

  // 2. Predictive power per feature
  const rho = KEYS.map((k) => {
    const per = (y: (d: StepData, w: string) => number | null) => data.map((d) => {
      const pts = d.wallets.map((u) => [k.get(u, d), y(d, u.wallet)] as const).filter(([a, b]) => a !== null && b !== null && Number.isFinite(a) && Number.isFinite(b)) as Array<readonly [number, number]>;
      return pts.length >= 10 ? spearman(pts.map((p) => p[0]), pts.map((p) => p[1])) : NaN;
    }).filter(Number.isFinite);
    const copy = (d: StepData, w: string) => { const xs = d.sims.get(H)!.get(w)!; return xs.length >= 3 ? mean(xs.map((x) => Math.min(x.res.ret, 10))) : null; };
    const lead = (d: StepData, w: string) => { const xs = d.sims.get(H)!.get(w)!.filter((x) => clean(x.rec)); return xs.length >= 3 ? median(xs.map((x) => x.res.leaderRet)) : null; };
    const own = (d: StepData, w: string) => d.wallets.find((u) => u.wallet === w)!.own?.roc ?? null;
    return { key: k.id, label: k.label, own: mean(per(own)), lead: mean(per(lead)), copy: mean(per(copy)) };
  });
  md.push(`## 2. Does the feature predict next month? (mean per-step Spearman over selectable wallets)`, ``,
    `Own ROC = the wallet's own return on capital next month. Leader median = median leader return on its replicated buys. Copy mean = mean 5 s follower return (capped at 1000%), wallets with ≥ 3 readable buys.`, ``,
    table(["Feature", "→ own ROC", "→ leader median", "→ copy mean (5 s)"], rho.map((r) => [r.label, num(r.own), num(r.lead), num(r.copy)])), ``);
  json.rho = rho;

  // 3. Grid search on discovery steps, judged on holdout
  const grid = buildGrid(data);
  const dScores = scoreGrid(grid, disc);
  const hScores = scoreGrid(grid, hold);
  const nRules = dScores.length, nValid = dScores.filter(valid).length;
  const ranked = dScores.map((x, i) => ({ d: x, h: hScores[i]! })).filter((x) => valid(x.d)).sort((a, b) => b.d.mean - a.d.mean);
  const seen = new Set<string>();
  const top = ranked.filter((x) => {
    const sig = `${x.d.mean.toFixed(6)}|${x.d.trades}`;
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  }).slice(0, 15);
  const toRule = (x: { f: number; k: number; topN: number }): Rule => ({ filter: grid.filters[x.f]!, key: KEYS[x.k]!.id, topN: x.topN });
  const topRows = top.map((x, i) => {
    const rule = toRule(x.d);
    const xs = selsOf(hData, (d) => selectWallets(d, rule), H);
    const s = summarize(xs, clean), ci = boot(xs, `top|${i}`), rnd = randomBaseline(hData, rule.filter, rule.topN);
    return { rule, label: ruleLabel(rule), dMean: x.d.mean, s, lower: ci.lower, rnd, ps: perStep(hData, xs) };
  });
  const hValid = ranked.filter((x) => valid(x.h));
  md.push(`## 3. Rule search (${nRules.toLocaleString("en-US")} rules: ${KEYS.length} rankings × ${grid.filters.length} filter combinations × top ${EXPLORE.topNs.join("/")})`, ``,
    `Searched on steps ${discSteps.join(", ")} by mean 5 s return (per-trade cap at the pooled p99, ${pct(grid.cap)}); ${nValid.toLocaleString("en-US")} rules have ≥ ${EXPLORE.minWallets} wallets and ≥ ${EXPLORE.minTradesPerStep} trades per step. ` +
    `Of those, **${pct(hValid.filter((x) => x.h.mean > 0).length / Math.max(1, hValid.length))}** have a positive mean on the holdout (${hValid.length} valid there). Top 15 discovery rules (identical selections merged), judged on the holdout:`, ``,
    table(["#", "Rule", "Discovery mean", "Holdout trades", "Wallets", "Median", "Mean −top1%", "1-sided 95% LB", "Random same filter", "Positive steps"],
      topRows.map((r, i) => [i + 1, r.label, pct(r.dMean), r.s.trades, r.s.wallets, pct(r.s.median), pct(r.s.trimmed), pct(r.lower), pct(r.rnd.trimmed), `${r.ps.filter((x) => x > 0).length} of ${hData.length}`])), ``);
  json.search = { nRules, nValid, holdoutPositiveShare: hValid.filter((x) => x.h.mean > 0).length / Math.max(1, hValid.length), top: topRows.map(({ rule, label, dMean, s, lower, rnd, ps }) => ({ rule, label, dMean, ...s, lower, random: rnd, perStep: ps })) };

  // 4. Max-statistic permutation null for the search
  const best = ranked[0]?.d.mean ?? NaN;
  const perms = permutations(grid, EXPLORE.permutations);
  const nullBest = perms.map((p) => Math.max(-Infinity, ...scoreGrid(grid, disc, p).filter(valid).map((x) => x.mean)));
  const pval = (1 + nullBest.filter((x) => x >= best).length) / (1 + nullBest.length);
  md.push(`## 4. Is the best discovery rule better than luck?`, ``,
    `The search was repeated ${EXPLORE.permutations} times with each step's wallet results shuffled among its wallets (features no longer tied to results). ` +
    `Best discovery mean: **${pct(best)}**; shuffled best: median ${pct(median(nullBest))}, 95th percentile ${pct([...nullBest].sort((a, b) => a - b)[Math.floor(0.95 * nullBest.length)]!)}. p = **${num(pval, 3)}**.`, ``);
  json.permutation = { best, nullBest, p: pval };

  // 5. Walk-forward: the best rule on all earlier steps, applied to the next
  const wf = data.slice(1).map((d, j) => {
    const prior = [...Array(j + 1).keys()];
    const sc = scoreGrid(grid, prior).filter((x) => x.wallets >= Math.min(EXPLORE.minWallets, 5 * prior.length) && x.minStepTrades >= EXPLORE.minTradesPerStep).sort((a, b) => b.mean - a.mean)[0];
    if (!sc) return null;
    const rule = toRule(sc);
    const xs = selsOf([d], (dd) => selectWallets(dd, rule), H);
    return { step: d.step, rule, label: ruleLabel(rule), xs, s: summarize(xs, clean), rnd: randomBaseline([d], rule.filter, rule.topN) };
  }).filter((x) => x !== null);
  const wfAll = wf.flatMap((x) => x!.xs);
  const wfS = summarize(wfAll, clean), wfCi = boot(wfAll, "wf");
  md.push(`## 5. Walk-forward: pick the best rule on all earlier months, trade it next month`, ``,
    table(["Step", "Rule chosen", "Trades", "Median", "Mean −top1%", "Random same filter"], wf.map((x) => [x!.step, x!.label, x!.s.trades, pct(x!.s.median), pct(x!.s.trimmed), pct(x!.rnd.trimmed)])), ``,
    `Pooled out of sample: ${wfS.trades} trades, median ${pct(wfS.median)}, mean −top1% **${pct(wfS.trimmed)}** (1-sided 95% LB ${pct(wfCi.lower)}).`, ``);
  json.walkForward = { steps: wf.map((x) => ({ step: x!.step, rule: x!.rule, label: x!.label, ...x!.s, random: x!.rnd })), pooled: { ...wfS, lower: wfCi.lower } };

  // 6. Settings for the top holdout rule
  const bestH = [...topRows].sort((a, b) => b.lower - a.lower)[0];
  if (bestH) {
    md.push(`## 6. Strongest holdout rule across settings: ${bestH.label}`, ``,
      `Picked among the top 15 by its holdout lower bound, so this is the holdout's best case (optimistic), not a fresh test. Holdout steps only.`, ``,
      table(["Setting", "Trades", "Median", "Mean −top1%", "1-sided 95% LB", "Hit", "Rug", "Alpha", "Delay", "Slippage", "Fees", "Rug loss"], EXPLORE.settings.map((st) => {
        const xs = selsOf(hData, (d) => selectWallets(d, bestH.rule), st.name);
        const s = summarize(xs, clean), ci = boot(xs, `bestH|${st.name}`);
        return [st.name, s.trades, pct(s.median), pct(s.trimmed), pct(ci.lower), pct(s.hit), pct(s.rug), pct(s.alpha), pct(s.delayCost), pct(s.slippage), pct(s.fees), pct(s.rugLoss)];
      })), ``);
  }

  // 7. Universe attribution
  md.push(`## 7. Every selectable wallet, by setting`, ``,
    table(["Setting", "Trades", "Median", "Mean −top1%", "Hit", "Rug", "Leader", "Alpha", "Delay", "Slippage", "Fees", "Rug loss"], EXPLORE.settings.map((st) => {
      const xs = selsOf(data, (d) => d.wallets.map((u) => u.wallet), st.name);
      const s = summarize(xs, clean);
      return [st.name, s.trades, pct(s.median), pct(s.trimmed), pct(s.hit), pct(s.rug), pct(mean(xs.filter((x) => clean(x.rec)).map((x) => x.res.leaderRet))), pct(s.alpha), pct(s.delayCost), pct(s.slippage), pct(s.fees), pct(s.rugLoss)];
    })), ``,
    `Attribution columns leave out records with a fill priced > 1000× above the leader's entry (drained pools); returns include them.`, ``);

  md.push(`## Credits`, ``, `${meta.credits.toLocaleString("en-US")} credits (cap ${EXPLORE.creditCap.toLocaleString("en-US")}). By kind: ${Object.entries(meta.creditsByKind).map(([k, v]) => `${k} ${v.toLocaleString("en-US")}`).join(", ")}.`);
  return { md: md.join("\n"), json };
}

/** reports/fomo-forward.md|json from the week states (pure: no fetching). */
import type { CostParams } from "../config/params.js";
import { simulateFollower } from "../research/follower.js";
import { hasMissingTape } from "../research/loadSteps.js";
import type { ReplRecord } from "../research/types.js";
import { iso, num, table } from "../util/run.js";
import { mean, median, spearman } from "../util/stats.js";
import { FORWARD, VARIANT_LABEL, VARIANTS, type Variant } from "./config.js";
import { weekComplete, type CopyPool, type WeekState } from "./run.js";
import { assertNoLookahead } from "./select.js";
import { clusterBoot, summarize, trimmedMean, verdict, withoutBestToken, type Copy, type Summary } from "./stats.js";

/** Records the simulator can use at every delay (same buys at every delay), and why the others were dropped. */
export function usableRecords(records: ReplRecord[], costs: CostParams): { kept: ReplRecord[]; missing: number; badFill: number; noFill: number } {
  let missing = 0, badFill = 0, noFill = 0;
  const kept: ReplRecord[] = [];
  for (const r of records) {
    if (hasMissingTape(r)) { missing++; continue; }
    if (r.leaderSol < FORWARD.minBuySol) continue;
    if (FORWARD.delays.some((d) => { const e = r.fills[String(d)]?.entry; return d > 0 && e && e.price !== null && e.price < r.leaderPoolPrice / FORWARD.maxEntryDiscount; })) { badFill++; continue; }
    if (!FORWARD.delays.every((d) => simulateFollower(r, { delay: d, sizeSol: FORWARD.headlineSize, costs, maxHoldHours: FORWARD.maxHoldHours }).ok)) { noFill++; continue; }
    kept.push(r);
  }
  return { kept, missing, badFill, noFill };
}

export function toCopies(week: string, records: ReplRecord[], delay: number, size: number, costs: CostParams): Copy[] {
  return records.map((r) => {
    const s = simulateFollower(r, { delay, sizeSol: size, costs, maxHoldHours: FORWARD.maxHoldHours });
    return { week, wallet: r.wallet, mint: r.mint, sig: r.sig, ret: s.ret, pnlSol: s.pnlSol, rug: s.rug, alpha: s.alpha, delayCost: s.delayCost, slippage: s.slippage, fees: s.fees, rugLoss: s.rugLoss, leaderRet: s.leaderRet };
  });
}

/** Wallets of each variant for a week (fixed by the snapshot: rank and match strength, never by results). */
export function variantWallets(st: WeekState): Record<Exclude<Variant, "baseline">, Set<string>> {
  const sel = Object.values(st.wallets).filter((w) => w.status === "ok" || w.status === "capped").sort((a, b) => a.rank - b.rank || (a.wallet < b.wallet ? -1 : 1));
  return {
    all: new Set(sel.map((w) => w.wallet)),
    confident: new Set(sel.filter((w) => !w.weak).map((w) => w.wallet)),
    top5: new Set(sel.slice(0, FORWARD.topN[0]).map((w) => w.wallet)),
    top10: new Set(sel.slice(0, FORWARD.topN[1]).map((w) => w.wallet)),
  };
}

export interface ReportMeta {
  commit: string;
  firstCommit: string | null;
  runT: number;
  credits: { run: number; cumulative: number; runByKind: Record<string, number>; cumulativeByKind: Record<string, number> };
  stopped: string | null;
  skipped: string[];
}

const f = (x: number) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%` : "–");
const ci = (c: [number, number]) => (Number.isFinite(c[0]) ? `${f(c[0])} … ${f(c[1])}` : "–");

export function buildForwardReport(states: WeekState[], costs: CostParams, meta: ReportMeta) {
  const H: number = FORWARD.headlineDelay, S: number = FORWARD.headlineSize;
  const usable = new Map<string, ReturnType<typeof usableRecords>>();
  const recs = (st: WeekState, which: "fomo" | "baseline") => {
    const key = `${st.week}|${which}`;
    if (!usable.has(key)) {
      const pool: CopyPool = which === "fomo" ? st.fomo : st.baseline.pool;
      const all = Object.values(pool.records);
      if (st.T1 !== null) assertNoLookahead(all, st.T0, st.T1, `week ${st.week} ${which}`);
      usable.set(key, usableRecords(all, costs));
    }
    return usable.get(key)!;
  };
  const copies = (st: WeekState, v: Variant, delay = H, size = S): Copy[] => {
    if (v === "baseline") return toCopies(st.week, recs(st, "baseline").kept, delay, size, costs);
    const ws = variantWallets(st)[v];
    return toCopies(st.week, recs(st, "fomo").kept.filter((r) => ws.has(r.wallet)), delay, size, costs);
  };
  const scored = states.filter((s) => s.T1 !== null);
  const complete = scored.filter((s) => weekComplete(s, meta.runT));
  const cum = (v: Variant, d = H, sz = S) => scored.flatMap((s) => copies(s, v, d, sz));

  const L: string[] = [];
  const json: Record<string, unknown> = {};
  const v = verdict(complete.map((s) => copies(s, "all")), complete.flatMap((s) => copies(s, "baseline")));
  json.verdict = v;
  json.meta = { ...meta, config: FORWARD };

  L.push(`# Fomo leaderboard forward test`, ``);
  L.push(`Strategy: every week, take the Fomo 30-day leaderboard wallets saved that week and copy their **new** buys until the next snapshot (out of sample: no buy before the selecting snapshot is ever used). ` +
    `Phase A simulator: exits mirror the leader at the same delay, ${FORWARD.maxHoldHours} h time stop, venue fees, priority fee + Jito tip on contested entries, rugs, constant-product slippage. ` +
    `Headline: all snapshot wallets, ${H} s, ${S} SOL per copied buy.`, ``);
  L.push(`Config \`src/forward/config.ts\` v${FORWARD.version}, commit \`${meta.commit}\`${meta.firstCommit && meta.firstCommit !== meta.commit ? ` (first forward run: \`${meta.firstCommit}\`; a config change since then makes results exploratory)` : ""}. Run ${new Date(meta.runT * 1000).toISOString().slice(0, 16)} UTC.`, ``);

  L.push(`## Status: **${v.status}**${v.status === "PENDING" ? ` (${v.weeks} of ${FORWARD.goWeeks} complete forward weeks)` : ` (first ${FORWARD.goWeeks} complete weeks)`}`, ``);
  L.push(table(["Criterion (headline variant, cumulative)", "Now", "Pass"], v.criteria.map((c) => [c.name, c.value, c.pass ? "yes" : "**no**"])));
  L.push(``, `GO needs every criterion; INCONCLUSIVE if only the sample size fails; otherwise NO-GO. Evaluated once ${FORWARD.goWeeks} weeks are complete (every buy closed and replicated).`, ``);
  if (meta.stopped) L.push(`> This run stopped early: ${meta.stopped}. Weeks marked "pending" continue on the next run.`, ``);

  // Weeks
  L.push(`## Weeks`, ``);
  const weekRows = states.map((s) => {
    const ws = Object.values(s.wallets);
    const u = recs(s, "fomo");
    const c = copies(s, "all");
    const sm = summarize(c);
    const state = s.T1 === null ? "selecting (next snapshot not saved yet)" : weekComplete(s, meta.runT) ? "complete" : s.fomo.counts.open ? "open buys" : "pending (budget)";
    return [s.week, s.T1 ? `${iso(s.T0)} → ${iso(s.T1)}` : `from ${iso(s.T0)}`, state,
      `${ws.filter((w) => w.status === "ok" || w.status === "capped").length} (${ws.filter((w) => w.weak).length} weak)`,
      `${ws.filter((w) => w.status === "bot").length} bot, ${ws.filter((w) => w.status === "capped").length} capped, ${s.unresolved.length} unmatched`,
      s.fomo.counts.universe, Object.keys(s.fomo.decided).length, s.fomo.counts.open, s.fomo.counts.pending, `${u.missing} / ${u.badFill} / ${u.noFill}`,
      sm.trades, f(sm.median), f(sm.trimmed), num(sm.pnlSol, 3)];
  });
  L.push(table(["Snapshot", "Copy window", "State", "Wallets copied", "Skipped", "Buys in window", "Replicated", "Open", "Waiting (budget)", "Dropped: missing tape / bad fill / no fill", `Copies @${H}s`, "Median", "Trimmed mean", `PnL SOL @${S}`], weekRows));
  L.push(``, `Buys are taken in a fixed-seed random order; when a run's budget stops, the replicated buys are a uniform sample of the week's closed buys ("Replicated" vs "Buys in window").`, ``);

  // Per week × variant
  L.push(`### Per week and variant (@${H} s, ${S} SOL)`, ``);
  const pwRows: Array<Array<string | number>> = [];
  for (const s of scored) for (const vv of VARIANTS) {
    const sm = summarize(copies(s, vv));
    pwRows.push([s.week, VARIANT_LABEL[vv], sm.trades, sm.wallets, f(sm.median), f(sm.mean), f(sm.trimmed), f(sm.hit), num(sm.pnlSol, 3)]);
  }
  L.push(pwRows.length ? table(["Week", "Variant", "Trades", "Wallets", "Median", "Mean", "Trimmed", "Hit", "PnL SOL"], pwRows) : "_No week scored yet: a week is scored once the next snapshot is saved._", ``);

  // Cumulative by variant
  L.push(`## Cumulative (all scored weeks, @${H} s, ${S} SOL)`, ``);
  const cumJson: Record<string, unknown> = {};
  const cumRows = VARIANTS.map((vv) => {
    const c = cum(vv);
    const sm = summarize(c);
    const wb = withoutBestToken(c);
    const tb = trimmedMean(wb.rest.map((x) => x.ret));
    const cw = clusterBoot(c, "wallet");
    const ct = clusterBoot(c, "mint");
    cumJson[vv] = { ...sm, ciWallet: cw, ciToken: ct, withoutBestToken: { mint: wb.mint, removed: wb.removed, trimmed: tb } };
    return [VARIANT_LABEL[vv], sm.trades, sm.wallets, sm.tokens, f(sm.median), f(sm.mean), f(sm.trimmed), ci(cw), ci(ct), `${f(tb)} (${wb.removed} buys of ${wb.mint?.slice(0, 6) ?? "–"}…)`, f(sm.hit), f(sm.rug), num(sm.pnlSol, 3)];
  });
  json.cumulative = cumJson;
  L.push(table(["Variant", "Trades", "Wallets", "Tokens", "Median", "Mean", "Trimmed", "90% (by wallet)", "90% (by token)", "Trimmed w/o best token", "Hit", "Rug", "PnL SOL"], cumRows));
  L.push(``, `Intervals: bootstrap of the trimmed mean (top ${FORWARD.trim * 100}% removed), ${FORWARD.boot} resamples of whole wallets or whole tokens. "Without best token" removes every buy of the token with the largest total return, across all wallets.`, ``);

  // Attribution
  L.push(`### Attribution (mean per copied buy, @${H} s, ${S} SOL)`, ``);
  L.push(table(["Variant", "Leader's own return", "Alpha (leader prices)", "Delay cost", "Slippage", "Fees", "Rug loss", "Net mean"], VARIANTS.map((vv) => {
    const sm = summarize(cum(vv));
    return [VARIANT_LABEL[vv], f(sm.leader), f(sm.alpha), f(sm.delayCost), f(sm.slippage), f(sm.fees), f(sm.rugLoss), f(sm.mean)];
  })), ``);

  // Delays × sizes
  L.push(`### Headline variant by delay and size`, ``);
  const dRows: Array<Array<string | number>> = [];
  const dJson: Record<string, Summary> = {};
  for (const sz of FORWARD.sizes) for (const d of FORWARD.delays) {
    const sm = summarize(cum("all", d, sz));
    dJson[`${d}s|${sz}`] = sm;
    dRows.push([`${d} s${d === 0 ? " (upper bound)" : ""}`, `${sz} SOL`, sm.trades, f(sm.median), f(sm.mean), f(sm.trimmed), f(sm.hit), num(sm.pnlSol, 3)]);
  }
  json.byDelay = dJson;
  L.push(table(["Delay", "Size", "Trades", "Median", "Mean", "Trimmed", "Hit", "PnL SOL"], dRows), ``);

  // Per wallet
  L.push(`## Per wallet (all scored weeks, @${H} s, ${S} SOL)`, ``);
  const listed = new Map<string, { handles: Set<string>; weeks: number; weak: boolean; best: number }>();
  for (const s of states) for (const w of Object.values(s.wallets)) {
    const e = listed.get(w.wallet) ?? { handles: new Set<string>(), weeks: 0, weak: w.weak, best: w.rank };
    w.handles.forEach((h) => e.handles.add(h));
    e.weeks++;
    e.best = Math.min(e.best, w.rank);
    e.weak = e.weak && w.weak;
    listed.set(w.wallet, e);
  }
  const all = cum("all");
  const byW = new Map<string, Copy[]>();
  for (const c of all) byW.set(c.wallet, [...(byW.get(c.wallet) ?? []), c]);
  const wRows = [...listed].map(([w, e]) => {
    const c = byW.get(w) ?? [];
    return { w, e, c, m: mean(c.map((x) => x.ret)) };
  }).sort((a, b) => (Number.isFinite(b.m) ? b.m : -Infinity) - (Number.isFinite(a.m) ? a.m : -Infinity) || a.e.best - b.e.best);
  L.push(table(["Wallet", "Fomo handle(s)", "Best rank", "Weeks on leaderboard", "Weeks copied", "Copied buys", `Copy mean @${H}s`, "Median", "Leader's own return on them"], wRows.map(({ w, e, c, m }) => [
    `\`${w.slice(0, 6)}…${w.slice(-4)}\``, [...e.handles].map((h) => `@${h}`).join(", ") + (e.weak ? " (weak match)" : ""), e.best, e.weeks,
    new Set(c.map((x) => x.week)).size, c.length, f(m), f(median(c.map((x) => x.ret))), f(mean(c.map((x) => x.leaderRet))),
  ])), ``);

  // Persistence
  L.push(`## Persistence`, ``);
  const prevSet = new Map<string, Set<string>>();
  states.forEach((s, i) => prevSet.set(s.week, new Set(i > 0 ? Object.keys(states[i - 1]!.wallets) : [])));
  const stay: Copy[] = [], fresh: Copy[] = [];
  for (const c of all) (prevSet.get(c.week)?.has(c.wallet) ? stay : fresh).push(c);
  const share = (cs: Copy[]) => {
    const g = new Map<string, number[]>();
    for (const c of cs) g.set(`${c.week}|${c.wallet}`, [...(g.get(`${c.week}|${c.wallet}`) ?? []), c.ret]);
    const ms = [...g.values()].map((x) => mean(x));
    return ms.length ? `${ms.filter((x) => x > 0).length} of ${ms.length}` : "–";
  };
  L.push(table(["Wallet-weeks", "Copies", "Median", "Trimmed", "Wallet-weeks with positive copy mean"], [
    ["Also on the previous snapshot (stayed)", stay.length, f(median(stay.map((x) => x.ret))), f(trimmedMean(stay.map((x) => x.ret))), share(stay)],
    ["New on the leaderboard", fresh.length, f(median(fresh.map((x) => x.ret))), f(trimmedMean(fresh.map((x) => x.ret))), share(fresh)],
  ]), ``);
  // Consecutive weeks: wallet copy mean in week k vs k+1 (wallets scored in both, ≥ 3 copies each).
  const wm = new Map<string, number>();
  const wn = new Map<string, number>();
  for (const [k, cs] of [...byW].flatMap(([w, cs]) => [...new Set(cs.map((x) => x.week))].map((wk) => [`${wk}|${w}`, cs.filter((x) => x.week === wk)] as const))) {
    wm.set(k, mean(cs.map((x) => x.ret)));
    wn.set(k, cs.length);
  }
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i + 1 < scored.length; i++) for (const w of byW.keys()) {
    const a = `${scored[i]!.week}|${w}`, b = `${scored[i + 1]!.week}|${w}`;
    if ((wn.get(a) ?? 0) >= 3 && (wn.get(b) ?? 0) >= 3) pairs.push([wm.get(a)!, wm.get(b)!]);
  }
  const pp = pairs.filter(([a]) => a > 0), pn = pairs.filter(([a]) => a <= 0);
  L.push(pairs.length
    ? `Wallets copied in consecutive weeks (≥ 3 copies each): ${pairs.length} pairs. Positive week → positive next week: ${pp.filter(([, b]) => b > 0).length} of ${pp.length}; ` +
      `negative week → positive next week: ${pn.filter(([, b]) => b > 0).length} of ${pn.length}. Spearman (week k mean vs week k+1 mean): ${num(spearman(pairs.map((x) => x[0]), pairs.map((x) => x[1])), 2)}.`
    : `No wallet has been copied in two consecutive weeks yet (≥ 3 copies each).`, ``);
  json.persistence = { stay: summarize(stay), fresh: summarize(fresh), pairs };

  // Baseline
  L.push(`## Baseline: random wallets`, ``);
  L.push(`Per complete week: up to ${FORWARD.baselineWallets} wallets drawn (fixed seed) from every wallet that bought one of the week's copied tokens in the same week, ` +
    `minus the snapshot's wallets, bots (signature screen, history over ${FORWARD.baselineMaxTx} txs) and wallets excluded as MEV/HFT/arb/creator in the lookback week; up to ${FORWARD.baselineBuysPerWallet} of their buys in the week, same simulator.`, ``);
  L.push(table(["Week", "Candidates", "Accepted", "Rejected", "Copies", "Median", "Trimmed"], scored.map((s) => {
    const b = s.baseline;
    const sm = summarize(copies(s, "baseline"));
    const rej = Object.values(b.wallets).filter((x) => x.status === "rejected");
    return [s.week, b.candidates?.length ?? "– (week not complete)", Object.values(b.wallets).filter((x) => x.status === "accepted").length, rej.length, sm.trades, f(sm.median), f(sm.trimmed)];
  })), ``);

  // Skipped wallets and credits
  L.push(`## Skipped and unmatched`, ``);
  const sk: string[] = [];
  for (const s of states) {
    for (const w of Object.values(s.wallets)) if (w.status === "bot" || w.status === "capped") sk.push(`- ${s.week}: ${w.handles.map((h) => `@${h}`).join(", ")} \`${w.wallet}\`: ${w.status === "bot" ? `> ${FORWARD.botTxPerWeek.toLocaleString("en-US")} txs in the lookback week (bot)` : "history over the cap while scoring"}`);
    for (const u of s.unresolved) sk.push(`- ${s.week}: @${u.handle} (#${u.rank}): ${u.reason}`);
    for (const w of Object.values(s.wallets)) if (w.weak) sk.push(`- ${s.week}: @${w.handles.join(", @")} weak match (${w.votes} matching trade${w.votes === 1 ? "" : "s"} or a tie): in "All", left out of "Without weak matches"`);
  }
  L.push(sk.length ? sk.join("\n") : "None.", ``);
  for (const x of meta.skipped) L.push(`- ${x}`);
  L.push(`## Credits`, ``);
  const kinds = [...new Set([...Object.keys(meta.credits.runByKind), ...Object.keys(meta.credits.cumulativeByKind)])].sort();
  L.push(table(["Kind", "This run", "Cumulative (forward test)"], [...kinds.map((k) => [k, (meta.credits.runByKind[k] ?? 0).toLocaleString("en-US"), (meta.credits.cumulativeByKind[k] ?? 0).toLocaleString("en-US")]),
    ["**Total**", meta.credits.run.toLocaleString("en-US"), meta.credits.cumulative.toLocaleString("en-US")]]), ``);
  L.push(`## Caveats`, ``);
  L.push(`- Solana trades only: Fomo ranks traders across chains (and in USD), so a trader can rank well on trades this test cannot see.`);
  L.push(`- Wallets come from matching a few Fomo trades to on-chain swaps; weak matches (one trade, or a tie) may be the wrong wallet. "Without weak matches" shows the effect.`);
  L.push(`- Buys whose position later received a token transfer in, or showed a > 1000× price jump, are not copied (Phase A data-quality rules), and entries filled > ${FORWARD.maxEntryDiscount}× below the leader's price are dropped as bad fills.`);
  return { md: L.join("\n") + "\n", json };
}


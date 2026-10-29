/**
 * Copyability spec, Stage 0 (`pnpm feasibility`, offline, no credits): leader return vs 5 s delay cost per wallet-week
 * on the cached steps, the quadrant counts, the "profitable and copyable" corner and the pre-registered stop rule.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { simulateFollower } from "../research/follower.js";
import { hasMissingTape } from "../research/loadSteps.js";
import { STAGE0, leaderOwnReturn, stage0Decision, trimmedMean, walletWeeks, type WalletWeek } from "../research/feasibility.js";
import type { ReplRecord } from "../research/types.js";
import { median } from "../util/stats.js";
import { gitCommit, num, pct, table, writeReportFiles } from "../util/run.js";
import { buildContext, commonOptions } from "./context.js";

const { values } = parseArgs({ options: { ...commonOptions, dir: { type: "string" }, boot: { type: "string", default: "2000" } } });
const { ctx, p, costs } = buildContext({ ...values, offline: true });
const dir = values.dir ?? ctx.stepsDir;
const B = Number(values.boot);

const raw = readdirSync(dir).filter((f) => /^step-\d+\.json$/.test(f)).sort()
  .flatMap((f) => (JSON.parse(readFileSync(join(dir, f), "utf8")) as { records: ReplRecord[] }).records);
const kept = raw.filter((r) => !hasMissingTape(r));
const sim = (r: ReplRecord, delay: number) => {
  const x = simulateFollower(r, { delay, sizeSol: STAGE0.sizeSol, costs, maxHoldHours: p.maxHoldHours });
  return x.ok ? x : null;
};

const ws = walletWeeks(raw, sim, p.topN);
const d = stage0Decision(ws, B);
const quad = (pr: boolean, co: boolean) => ws.filter((w) => w.profitable === pr && w.copyable === co);
const qRow = (name: string, xs: WalletWeek[]) => {
  const rets = xs.flatMap((w) => w.rets5);
  return [name, xs.length, new Set(xs.map((w) => w.wallet)).size, new Set(xs.map((w) => w.step)).size, rets.length,
    rets.length ? pct(median(rets)) : "–", rets.length ? pct(trimmedMean(rets)) : "–"];
};

// Scatter (SVG): x = leader trimmed mean, y = median delay cost at 5 s; both clipped for display.
const methodColor: Record<string, string> = { S1: "#d1495b", S2: "#2e86ab", S3: "#8f5db7", S4: "#3a9d5d", random: "#9a9a9a" };
const colorOf = (w: WalletWeek) => methodColor[w.methods[0]!] ?? "#555";
const [W, H, pad] = [640, 420, 50];
const clip = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const [x0, x1, y0, y1] = [-1, 1, -0.5, 0.2];
const sx = (v: number) => pad + ((clip(v, x0, x1) - x0) / (x1 - x0)) * (W - 2 * pad);
const sy = (v: number) => H - pad - ((clip(v, y0, y1) - y0) / (y1 - y0)) * (H - 2 * pad);
const svg = [
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="sans-serif" font-size="11">`,
  `<rect width="${W}" height="${H}" fill="white"/>`,
  `<line x1="${sx(0)}" y1="${pad}" x2="${sx(0)}" y2="${H - pad}" stroke="#bbb"/>`,
  `<line x1="${pad}" y1="${sy(STAGE0.maxDelayCost)}" x2="${W - pad}" y2="${sy(STAGE0.maxDelayCost)}" stroke="#bbb" stroke-dasharray="4 3"/>`,
  `<text x="${W / 2}" y="${H - 12}" text-anchor="middle">leader own return, mean −top 1% (clipped to ±100%)</text>`,
  `<text x="14" y="${H / 2}" transform="rotate(-90 14 ${H / 2})" text-anchor="middle">median delay cost at 5 s (clipped −50%…+20%)</text>`,
  `<text x="${W - pad}" y="${pad - 8}" text-anchor="end">profitable and copyable ↗</text>`,
  ...ws.map((w) => `<circle cx="${sx(w.leaderTrimmed).toFixed(1)}" cy="${sy(w.delayCost5).toFixed(1)}" r="4" fill="${colorOf(w)}" fill-opacity="0.75"><title>${w.wallet} step ${w.step} ${w.methods.join(",")}</title></circle>`),
  ...Object.entries(methodColor).map(([k, c], i) => `<circle cx="${pad + 10 + i * 70}" cy="${pad - 12}" r="4" fill="${c}"/><text x="${pad + 18 + i * 70}" y="${pad - 8}">${k}</text>`),
  `</svg>`,
].join("\n");

const md: string[] = [
  `# Copyability score: Stage 0 feasibility`, ``,
  `**Decision: ${d.proceed ? "PROCEED to Stage 1" : "STOP the project"}.** Stage 0 is in-sample and post hoc: it can only stop the project, never count as evidence for GO.`, ``,
  `Data: \`${dir}\`, cached (no credits). ${raw.length} leader buys, ${kept.length} with readable tape. Follower ${STAGE0.sizeSol} SOL at 0 s and ${STAGE0.delay} s, exits mirror the leader, ${p.maxHoldHours} h time stop, Phase A costs and rug model. Commit ${gitCommit()}.`, ``,
  `Per (wallet, step) with ≥ ${STAGE0.minBuys} replicated buys: leader own return over all its buys that week (kept + dropped; sells at its own price, the rest at its last own price), median delay cost at 5 s (follower 5 s − follower 0 s, same buys), follower 5 s return. ` +
  `Cutoffs (spec 3.3, fixed): profitable = leader mean −top 1% > 0; copyable = median delay cost > ${pct(STAGE0.maxDelayCost, 0)}.`, ``,
  `## Stop rule (spec 3.4)`, ``,
  table(["Check", "Value", "Needed", "Pass"], d.checks.map((c) => [c.name, c.value, c.threshold, c.pass ? "yes" : "**no**"])), ``,
  `Corner: ${d.wallets} wallets, ${d.weeks} weeks, ${d.trades} copy trades. Pooled 5 s copy return: median ${pct(d.copyMedian)} (95% CI ${pct(d.ci.median[0]!)} … ${pct(d.ci.median[1]!)}), ` +
  `mean −top 1% ${pct(d.copyTrimmed)} (95% CI ${pct(d.ci.trimmed[0]!)} … ${pct(d.ci.trimmed[1]!)}); intervals from a wallet-clustered bootstrap, ${B} resamples.`, ``,
  `Sensitivity (descriptive, not part of the rule): pooled 5 s mean −top 1% with one corner wallet left out: ` +
  d.leaveOneOut.map((x) => `without ${x.wallet.slice(0, 8)} (${x.trades} trades) ${pct(x.trimmed)}`).join(", ") + `. ` +
  `With ${d.trades} trades the top-1% trim removes ${Math.ceil(d.trades * STAGE0.trim)} of them.`, ``,
  `## Quadrants`, ``,
  table(["Quadrant", "Wallet-weeks", "Wallets", "Weeks", "Copy trades", "Copy 5 s median", "Copy 5 s mean −top1%"], [
    qRow("profitable, copyable", quad(true, true)), qRow("profitable, not copyable", quad(true, false)),
    qRow("unprofitable, copyable", quad(false, true)), qRow("unprofitable, not copyable", quad(false, false)), qRow("all", ws)]), ``,
  `By method (a wallet-week counts for every method whose top ${p.topN} held it; "random" = B1 pool only):`, ``,
  table(["Method", "Wallet-weeks", "In corner", "Leader mean −top1% (median over wallet-weeks)", "Delay cost 5 s (median)", "Copy 5 s mean −top1% (pooled)"],
    [...["S1", "S2", "S3", "S4", "random"]].map((m) => {
      const xs = ws.filter((w) => w.methods.includes(m));
      return [m, xs.length, xs.filter((w) => w.profitable && w.copyable).length, xs.length ? pct(median(xs.map((w) => w.leaderTrimmed))) : "–",
        xs.length ? pct(median(xs.map((w) => w.delayCost5))) : "–", xs.length ? pct(trimmedMean(xs.flatMap((w) => w.rets5))) : "–"];
    })), ``,
  `## Corner wallet-weeks`, ``,
  table(["Step", "Wallet", "Methods", "Buys (replicated / all)", "Leader median", "Leader mean −top1%", "Delay cost 5 s", "Copy 5 s median", "Copy 5 s mean −top1%"],
    quad(true, true).map((w) => [w.step, w.wallet.slice(0, 8), w.methods.join(","), `${w.n} / ${w.nAll}`, pct(w.leaderMedian), pct(w.leaderTrimmed), pct(w.delayCost5), pct(w.copyMedian), pct(w.copyTrimmed)])), ``,
  `Scatter: \`SCATTER\` (one point per wallet-week, colored by first method).`, ``,
  `Leader own return over replicated buys only, for reference: median ${pct(median(kept.map(leaderOwnReturn).filter(Number.isFinite)))} across ${kept.length} buys.`,
];
const files = writeReportFiles("reports", "feasibility", md.join("\n"), {
  config: { ...STAGE0, dir, boot: B, commit: gitCommit() }, decision: d,
  walletWeeks: ws.map(({ rets5, ...w }) => ({ ...w, rets5: rets5.map((x) => Number(num(x, 4))) })),
});
const svgPath = files.md.replace(/\.md$/, ".svg");
writeFileSync(svgPath, svg);
writeFileSync(files.md, md.join("\n").replace("SCATTER", svgPath.split("/").pop()!));
console.log({ ...files, svg: svgPath, proceed: d.proceed, checks: d.checks });

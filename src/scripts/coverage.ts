/**
 * Copyability spec 5.5 (`pnpm coverage`, offline): per-venue drop rates of the cached replication records and the
 * cause of each unreadable fill (see data/coverage.ts).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { missingFills, type MissingFill } from "../data/coverage.js";
import { hasMissingTape } from "../research/loadSteps.js";
import type { ReplRecord } from "../research/types.js";
import { pct, table, writeReportFiles } from "../util/run.js";
import { buildContext, commonOptions } from "./context.js";

const { values } = parseArgs({ options: { ...commonOptions, dir: { type: "string" } } });
const { ctx } = buildContext({ ...values, offline: true });
const dir = values.dir ?? ctx.stepsDir;
const raw = readdirSync(dir).filter((f) => /^step-\d+\.json$/.test(f)).sort()
  .flatMap((f) => (JSON.parse(readFileSync(join(dir, f), "utf8")) as { records: ReplRecord[] }).records);

const misses: MissingFill[] = [];
const recCause = new Map<string, Set<string>>();
for (const r of raw.filter(hasMissingTape)) {
  const m = await missingFills(ctx.oracle, r);
  misses.push(...m);
  recCause.set(r.sig + r.wallet + r.step, new Set(m.map((x) => x.cause)));
}
const causes = ["not-fetched", "coverage-short", "unpriced", "quiet-untrusted"];
const venues = [...new Set(raw.map((r) => r.venue))].sort();
const rows = venues.map((v) => {
  const all = raw.filter((r) => r.venue === v);
  const dr = all.filter(hasMissingTape);
  const by = (c: string) => dr.filter((r) => recCause.get(r.sig + r.wallet + r.step)?.has(c)).length;
  return [v, all.length, dr.length, pct(dr.length / all.length), ...causes.map(by)];
});
const legRows = [...new Set(misses.map((m) => m.leg))].sort().map((leg) => [leg, ...causes.map((c) => misses.filter((m) => m.leg === leg && m.cause === c).length)]);
const dropped = raw.filter(hasMissingTape).length;
const md = [
  `# Coverage diagnostics (copyability spec 5.5)`, ``,
  `Cached records in \`${dir}\`: ${raw.length} leader buys, ${dropped} (${pct(dropped / raw.length)}) dropped for an unreadable fill. Offline, no credits.`, ``,
  `Causes: **not-fetched** = no stored tape covers the time (budget ran out / never fetched); **coverage-short** = stored tape ends before the fill window; ` +
  `**unpriced** = trades stored but none pool-priced; **quiet-untrusted** = no trade within 1 h and the prior state needs a backward page. A record can have several.`, ``,
  `## Records by venue (dropped records with each cause)`, ``,
  table(["Venue", "Buys", "Dropped", "Dropped %", ...causes], rows), ``,
  `## Unreadable fills by leg`, ``,
  table(["Leg", ...causes], legRows), ``,
];
const files = writeReportFiles("reports", "coverage", md.join("\n"), { dir, byVenue: rows, byLeg: legRows, misses });
console.log(md.join("\n"));
console.log(files);

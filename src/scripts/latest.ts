import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Most recent Phase A study JSON in reports/, if any. */
export function latestStudy(): { gate: boolean; chosen: { id: string; delay: number } | null } | null {
  if (!existsSync("reports")) return null;
  const f = readdirSync("reports").filter((x) => x.endsWith("-study.json")).sort().pop();
  return f ? JSON.parse(readFileSync(join("reports", f), "utf8")) : null;
}

export function latestReport(pattern: RegExp): { path: string; json: any } | null {
  if (!existsSync("reports")) return null;
  const f = readdirSync("reports").filter((x) => x.endsWith(".json") && pattern.test(x)).sort().pop();
  return f ? { path: join("reports", f), json: JSON.parse(readFileSync(join("reports", f), "utf8")) } : null;
}

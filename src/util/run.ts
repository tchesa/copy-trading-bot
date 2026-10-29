import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Short git commit, with +dirty if src/ has uncommitted changes (R-I7). */
export function gitCommit(): string {
  try {
    const c = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    const dirty = execSync("git status --porcelain src", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    return c + (dirty ? "+dirty" : "");
  } catch {
    return "uncommitted";
  }
}

export function stamp(generatedAt: number, label?: string): string {
  return new Date(generatedAt).toISOString().replace(/[:.]/g, "-").slice(0, 19) + (label ? `-${label}` : "");
}

/** Write reports/<ts>-<label>.md and .json. */
export function writeReportFiles(dir: string, label: string, md: string, json: unknown): { md: string; json: string } {
  mkdirSync(dir, { recursive: true });
  const base = join(dir, stamp(Date.now(), label));
  writeFileSync(`${base}.md`, md);
  writeFileSync(`${base}.json`, JSON.stringify(json, null, 2));
  return { md: `${base}.md`, json: `${base}.json` };
}

export const iso = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
export const pct = (x: number, d = 1) => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : Number.isNaN(x) ? "n/a" : String(x));
export const num = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : String(x));

export function parseDate(s: string): number {
  const t = Date.parse(s.length === 10 ? `${s}T00:00:00Z` : s);
  if (Number.isNaN(t)) throw new Error(`bad date ${s}`);
  return Math.floor(t / 1000);
}

/** Markdown table. */
export function table(head: string[], rows: Array<Array<string | number | undefined>>): string {
  return [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
}

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { StepResult } from "./pipeline.js";
import type { ReplRecord } from "./types.js";

/** True if any fill the simulator could use (entry, exits, time stop, at any delay) has an unreadable tape. */
export function hasMissingTape(r: ReplRecord): boolean {
  return Object.values(r.fills).some((f) => f.entry.missing || f.timeStop?.missing || f.exits.some((x) => x.missing));
}

/**
 * Cached steps. Records with unreadable tape at any delay are dropped (counted in `droppedMissing`), so every delay
 * and every consumer (study, sweep, baselines) compares the same leader buys.
 */
export function loadSteps(dir: string): StepResult[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^step-\d+\.json$/.test(f))
    .sort()
    .map((f) => {
      const s = JSON.parse(readFileSync(join(dir, f), "utf8")) as StepResult;
      const kept = s.records.filter((r) => !hasMissingTape(r));
      return { ...s, droppedMissing: s.records.length - kept.length, records: kept };
    });
}

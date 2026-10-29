import { createHash } from "node:crypto";
import { join } from "node:path";
import { env } from "../config/env.js";
import { costSchema, studySchema, type CostParams, type StudyParams } from "../config/params.js";
import { Helius } from "../data/helius.js";
import { Oracle } from "../data/oracle.js";
import { SolUsd } from "../data/solusd.js";
import { openDb } from "../db/db.js";
import { setLogLevel } from "../log.js";
import type { Ctx } from "../research/pipeline.js";
import { parseDate } from "../util/run.js";
import { defaultEligibility, eligibilitySchema } from "../wallets/eligibility.js";
import { TradeLoader } from "../wallets/load.js";

export interface CommonArgs {
  from: string;
  to: string;
  budget: string;
  offline?: boolean;
  params?: string;
  costs?: string;
  eligibility?: string;
}

export const PIPELINE_VERSION = 10;

export const commonOptions = {
  from: { type: "string" as const, default: "2026-03-28" },
  to: { type: "string" as const, default: "2026-10-27" },
  budget: { type: "string" as const, default: "3000000" },
  offline: { type: "boolean" as const, default: false },
  params: { type: "string" as const },
  costs: { type: "string" as const },
  eligibility: { type: "string" as const },
  label: { type: "string" as const },
};

export function buildContext(a: CommonArgs): { ctx: Ctx; from: number; to: number; costs: CostParams; p: StudyParams } {
  setLogLevel(env().LOG_LEVEL);
  const db = openDb(env().DB_PATH);
  const p = studySchema.parse(JSON.parse(a.params ?? "{}"));
  const costs = costSchema.parse(JSON.parse(a.costs ?? "{}"));
  const el = eligibilitySchema.parse({ ...defaultEligibility(), ...JSON.parse(a.eligibility ?? "{}") });
  const solUsd = new SolUsd(db);
  const helius = a.offline ? null : new Helius(db, Number(a.budget));
  const oracle = new Oracle(db, helius, solUsd);
  const from = parseDate(a.from);
  const to = parseDate(a.to);
  // Step cache is keyed by everything that changes step contents (cost params do not: they apply at simulation time).
  // PIPELINE_VERSION: bump when step logic changes (2: quote-leg repair, formation-opened positions excluded from eval,
  // missing tape is not a rug, outlier audit; 3: liquidity-bounded marks, nearby-price check; 4: transfers out exit at
  // the last traded price, marks on the latest buy's pool; 5: leader transfers out are mirrored exits;
  // 6: repaired trades take the reference price; fills/marks/paths use pool-priced trades only;
  // 7: transfers out valued at the last validated (pool) price; 8: dust trades (< 0.01 SOL) are never a price;
  // 9: marks = median of the last 5 pool trades; transfers out valued at the mark when they happen;
  // 10: fetched marks use the latest buy's pool too).
  const key = createHash("sha1").update(JSON.stringify({ p, el, from, to, v: PIPELINE_VERSION })).digest("hex").slice(0, 10);
  const ctx: Ctx = {
    db, helius, oracle, loader: new TradeLoader(db, solUsd), solUsd, p, el,
    concurrency: env().DOWNLOAD_CONCURRENCY, stepsDir: join("data", "steps", key),
  };
  return { ctx, from, to, costs, p };
}

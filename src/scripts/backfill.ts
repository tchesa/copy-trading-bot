import { parseArgs } from "node:util";
import { env } from "../config/env.js";
import { defaultStudy } from "../config/params.js";
import { Helius } from "../data/helius.js";
import { DAY, sampleRange } from "../data/sample.js";
import { backfillSolUsd } from "../data/solusd.js";
import { creditsByKind, openDb } from "../db/db.js";
import { logger, setLogLevel } from "../log.js";
import { parseDate } from "../util/run.js";

const { values } = parseArgs({
  options: {
    from: { type: "string", default: "2026-03-28" },
    to: { type: "string", default: "2026-10-27" },
    budget: { type: "string", default: "3000000" },
    "per-day": { type: "string" },
  },
});
setLogLevel(env().LOG_LEVEL);
const log = logger("backfill");
const db = openDb(env().DB_PATH);
const from = parseDate(values.from!);
const to = parseDate(values.to!);
const helius = new Helius(db, Number(values.budget));
const perDay = Number(values["per-day"] ?? defaultStudy().samplesPerVenueDay);

log.info("sol/usd");
await backfillSolUsd(db, from - 2 * DAY, to + DAY);
log.info("discovery sample", { from: values.from, to: values.to, perDay, credits: helius.creditsUsed });
await sampleRange(db, helius, from, to, perDay, env().DOWNLOAD_CONCURRENCY);
log.info("done", { credits: helius.creditsUsed, byKind: creditsByKind(db) });

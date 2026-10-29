import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  HELIUS_API_KEY: z.string().min(1, "HELIUS_API_KEY is required (see .env.example)"),
  DB_PATH: z.string().default("data/shadow.sqlite"),
  CACHE_DIR: z.string().default("data/cache"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  DOWNLOAD_CONCURRENCY: z.coerce.number().int().positive().default(8),
  HELIUS_RPS: z.coerce.number().positive().default(10),
});

export type Env = z.infer<typeof envSchema>;
let cached: Env | undefined;
/** Lazily parsed so pure modules and tests never need the key. */
export function env(): Env {
  return (cached ??= envSchema.parse(process.env));
}

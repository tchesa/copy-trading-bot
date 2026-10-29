import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { StudyParams } from "../config/params.js";
import { pool } from "../data/http.js";
import { BudgetExceeded, type Helius } from "../data/helius.js";
import { loadMint } from "../data/mints.js";
import { toSol, type Oracle } from "../data/oracle.js";
import { sampleScale } from "../data/sample.js";
import { VENUES } from "../data/programs.js";
import type { SolUsd } from "../data/solusd.js";
import { ensureHistory, screenWallet } from "../data/walletHistory.js";
import { logger } from "../log.js";
import { RANKINGS, rank, type RankingId } from "../ranking/rank.js";
import { hashSeed, rng, sample, shuffle } from "../util/rng.js";
import { measureCrowding } from "../wallets/crowding.js";
import { defaultExclusions, exclusionReasons } from "../wallets/exclusions.js";
import { ineligibleReasons, type EligibilityParams } from "../wallets/eligibility.js";
import type { TradeLoader } from "../wallets/load.js";
import { auditPositions, type PositionOutlier } from "../wallets/audit.js";
import { walletMetrics, type WalletMetrics } from "../wallets/metrics.js";
import { buildPositions, type Mark } from "../wallets/positions.js";
import type { Position, Trade } from "../wallets/types.js";
import { replicateBuy } from "./replicate.js";
import type { ReplRecord } from "./types.js";

const log = logger("pipeline");
export const DAY = 86_400;

export interface Ctx {
  db: DatabaseSync;
  helius: Helius | null;
  oracle: Oracle;
  loader: TradeLoader;
  solUsd: SolUsd;
  p: StudyParams;
  el: EligibilityParams;
  concurrency: number;
  stepsDir: string;
}

export interface StepWindow {
  step: number;
  F0: number;
  F1: number;
}

export interface EvalPerf {
  roc: number;
  pnl: number;
  positions: number;
}

export interface StepResult {
  step: number;
  F0: number;
  F1: number;
  discovery: {
    sampledSwaps: number;
    qualifyingTokens: number;
    sampledWallets: number;
    screened: number;
    hft: number;
    capped: number;
    /** Skipped because screening or history needed a fetch with no credits left (cache-only replay). */
    unfetched?: number;
    candidates: number;
    screenCap: number;
    candidateCap: number;
  };
  excluded: Record<string, number>;
  ineligible: Record<string, number>;
  eligible: number;
  eligibleWallets: string[];
  /** Formation metrics for eligible wallets and S1's top list. */
  metrics: WalletMetrics[];
  rankings: Record<RankingId, string[]>;
  randomPool: string[];
  /** Eval-window performance by eval length (days) for eligible wallets and S1 top (R-A1). */
  evalPerf: Record<string, Record<string, EvalPerf>>;
  records: ReplRecord[];
  creditsAfter: number;
  /** Records dropped at load time because some fill's tape was unreadable (see loadSteps). */
  droppedMissing?: number;
  /** Positions above MAX_PLAUSIBLE_RET (formation and eval), for inspection. */
  outliers?: PositionOutlier[];
  /** Trade loader quote-leg checks (cumulative for the run when the step was computed). */
  loader?: { priced: number; repaired: number; unchecked: number };
}

export function makeSteps(dataStart: number, dataEnd: number, p: StudyParams): StepWindow[] {
  const maxEval = Math.max(...p.evalDays);
  const out: StepWindow[] = [];
  for (let F0 = dataStart, i = 0; ; F0 += p.stepDays * DAY, i++) {
    const F1 = F0 + p.formationDays * DAY;
    if (F1 + maxEval * DAY > dataEnd) break;
    out.push({ step: i, F0, F1 });
  }
  return out;
}

/** Candidate wallets from the discovery sample in [F0, F1) on tokens with enough estimated volume (R-W1/R-W2). */
export function discoverCandidates(ctx: Ctx, F0: number, F1: number) {
  const rows = ctx.db
    .prepare("SELECT wallet, mint, block_time, quote_mint, quote_amount, sample_venue, sample_day FROM discovery WHERE block_time >= ? AND block_time < ?")
    .all(F0, F1) as Array<{ wallet: string; mint: string; block_time: number; quote_mint: string | null; quote_amount: number; sample_venue: string; sample_day: number }>;
  const scale = sampleScale(ctx.db, F0 - DAY, F1);
  const vol = new Map<string, number>();
  for (const r of rows) {
    const s = toSol(r.quote_amount, r.quote_mint, r.block_time, ctx.solUsd);
    if (s === null) continue;
    vol.set(r.mint, (vol.get(r.mint) ?? 0) + s * (scale.get(`${r.sample_venue}|${r.sample_day}`) ?? 0));
  }
  const qualifying = new Set([...vol].filter(([, v]) => v >= ctx.p.minTokenVolumeSol).map(([m]) => m));
  const counts = new Map<string, number>();
  for (const r of rows) if (qualifying.has(r.mint)) counts.set(r.wallet, (counts.get(r.wallet) ?? 0) + 1);
  // Seeded random order among wallets above the activity minimum. Ordering by sampled count (R-W2 as written)
  // puts bots first: in the pilot 99% of the most active sampled wallets failed the bot screen.
  const eligibleByCount = [...counts].filter(([, n]) => n >= ctx.p.minSampledTrades).map(([w]) => w).sort();
  const ordered = shuffle(eligibleByCount, rng(hashSeed("discover", F0)));
  return { sampledSwaps: rows.length, qualifyingTokens: qualifying.size, sampledWallets: counts.size, ordered };
}

function localMark(ctx: Ctx) {
  return (_mint: string, pool: string | null, t: number): Mark => {
    const r = pool ? ctx.oracle.lastTradeBefore(pool, t, 7 * DAY) : null;
    return r ? { price: r.price, reserveSol: r.poolQuoteReserveSol } : null;
  };
}

/** Positions with marks fetched at `to` for anything still open (R-I2). */
async function positionsWithMarks(ctx: Ctx, trades: Trade[], from: number, to: number): Promise<Position[]> {
  const first = buildPositions(trades, from, to, () => null);
  const marks = new Map<string, Mark>();
  for (const p of first.filter((x) => x.closeT === null && x.markPool)) {
    const m = await ctx.oracle.markAt(p.markPool!, to);
    marks.set(p.mint, m ? { price: m.price, reserveSol: m.poolQuoteReserveSol } : null);
  }
  // At `to`: the fetched marks. Earlier (transfers out): the stored tape before that moment.
  const stored = localMark(ctx);
  return buildPositions(trades, from, to, (mint, pool, t) => (t >= to ? (marks.get(mint) ?? null) : stored(mint, pool, t)));
}

export async function runStep(ctx: Ctx, w: StepWindow): Promise<StepResult> {
  const file = join(ctx.stepsDir, `step-${String(w.step).padStart(2, "0")}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as StepResult;
  const { p, oracle, loader } = ctx;
  const { F0, F1 } = w;
  const rand = rng(hashSeed("step", w.step));
  const outliers: PositionOutlier[] = [];

  // 1. Discovery + screen + histories. Refuse to run on an incomplete sample (it would be cached silently).
  const sampled = ctx.db
    .prepare("SELECT COUNT(*) AS n FROM fetch_progress WHERE kind = 'sample' AND status = 'done' AND from_ts >= ? AND from_ts < ?")
    .get(F0, F1) as { n: number };
  const expected = ((F1 - F0) / DAY) * Object.keys(VENUES).length;
  if (Number(sampled.n) < expected) throw new Error(`step ${w.step}: discovery sample incomplete (${sampled.n}/${expected} venue-days); run pnpm backfill first`);
  const disc = discoverCandidates(ctx, F0, F1);
  const toScreen = disc.ordered.slice(0, p.screenCap);
  const candidates: string[] = [];
  let screened = 0, hft = 0, capped = 0, unfetched = 0;
  for (let i = 0; i < toScreen.length && candidates.length < p.candidateCap; i += ctx.concurrency) {
    const batch = toScreen.slice(i, i + ctx.concurrency);
    const ok: string[] = [];
    await pool(batch, ctx.concurrency, async (wallet) => {
      if (!ctx.helius) {
        ok.push(wallet);
        return;
      }
      let s;
      try {
        s = await screenWallet(ctx.db, ctx.helius, wallet, F0, F1, defaultExclusions.maxTradesPerDay);
      } catch (e) {
        // Out of credits (e.g. a cache-only replay): skip wallets that would need a fetch, and count them.
        if (!(e instanceof BudgetExceeded)) throw e;
        unfetched++;
        return;
      }
      screened++;
      if (s.hft) {
        hft++;
        return;
      }
      if (s.n >= p.maxFormationTx) {
        capped++;
        return;
      }
      const hist = await ensureHistory(ctx.db, ctx.helius, wallet, F0, F1, p.maxHistoryTx).catch((e) => {
        if (!(e instanceof BudgetExceeded)) throw e;
        unfetched++;
        return null;
      });
      if (hist === null) return;
      if (!hist) {
        capped++;
        return;
      }
      ok.push(wallet);
    });
    for (const x of batch) if (ok.includes(x) && candidates.length < p.candidateCap) candidates.push(x);
  }
  log.info("candidates", { step: w.step, sampled: disc.sampledWallets, screened, hft, capped, unfetched, candidates: candidates.length });

  // 2. Formation metrics (local marks), exclusions, eligibility
  const excluded: Record<string, number> = {};
  const ineligible: Record<string, number> = {};
  const all: WalletMetrics[] = [];
  const pre: string[] = [];
  const tradesOf = new Map<string, Trade[]>();
  for (const wallet of candidates) {
    const trades = loader.load(wallet, F0, F1);
    tradesOf.set(wallet, trades);
    const pos = buildPositions(trades, F0, F1, localMark(ctx));
    const m = walletMetrics(wallet, pos, trades, F0, F1);
    all.push(m);
    const ex = exclusionReasons(trades, pos, F0, F1, defaultExclusions);
    for (const r of ex) excluded[r] = (excluded[r] ?? 0) + 1;
    if (ex.length) continue;
    // cheap pre-filter on counts and activity before paying for marks
    const inel = ineligibleReasons(m, F1, { ...ctx.el, maxPnlConcentration: Infinity });
    if (inel.length === 0) pre.push(wallet);
    else for (const r of inel) ineligible[r] = (ineligible[r] ?? 0) + 1;
  }
  // S1 (raw PnL, unfiltered) top list with fetched marks
  const s1Pre = rank("S1", { all, eligible: [] }).slice(0, p.topN * 3).map((m) => m.wallet);
  const refined = new Map<string, { m: WalletMetrics; pos: Position[] }>();
  await pool([...new Set([...pre, ...s1Pre])], ctx.concurrency, async (wallet) => {
    const trades = tradesOf.get(wallet)!;
    const pos = await positionsWithMarks(ctx, trades, F0, F1);
    outliers.push(...auditPositions("formation", pos));
    refined.set(wallet, { m: walletMetrics(wallet, pos, trades, F0, F1), pos });
  });
  const eligible: WalletMetrics[] = [];
  for (const wallet of pre) {
    const { m } = refined.get(wallet)!;
    const inel = ineligibleReasons(m, F1, ctx.el);
    if (inel.length) for (const r of inel) ineligible[r] = (ineligible[r] ?? 0) + 1;
    else eligible.push(m);
  }
  // Crowding for eligible wallets (S3 input, §4.4)
  await pool(eligible, ctx.concurrency, async (m) => {
    const c = await measureCrowding(oracle, m.wallet, refined.get(m.wallet)!.pos, F1, rng(hashSeed("crowd", w.step, m.wallet)), p.crowdBuys, p.crowdSells);
    Object.assign(m, c);
  });
  const allRefined = all.map((m) => refined.get(m.wallet)?.m ?? m);
  const rankings = {} as Record<RankingId, string[]>;
  for (const id of RANKINGS) rankings[id] = rank(id, { all: allRefined, eligible }).slice(0, p.topN).map((m) => m.wallet);
  const randomPool = sample(eligible.map((m) => m.wallet).sort(), p.randomPool, rand);
  log.info("ranked", { step: w.step, eligible: eligible.length, credits: ctx.helius?.creditsUsed });

  // 3. Eval histories for eligible + ranked
  const maxEval = Math.max(...p.evalDays);
  const evalWallets = [...new Set([...eligible.map((m) => m.wallet), ...Object.values(rankings).flat()])];
  const hasEval = new Set<string>();
  await pool(evalWallets, ctx.concurrency, async (wallet) => {
    const covered = !ctx.helius || (await ensureHistory(ctx.db, ctx.helius, wallet, F0, F1 + maxEval * DAY, p.maxHistoryTx * 2).catch((e) => {
      if (!(e instanceof BudgetExceeded)) throw e;
      unfetched++;
      return false;
    }));
    if (covered) hasEval.add(wallet);
  });

  // 4. Persistence: same wallets' own eval-window performance (R-A1)
  const evalPerf: StepResult["evalPerf"] = {};
  for (const days of p.evalDays) {
    const E = F1 + days * DAY;
    const perf: Record<string, EvalPerf> = {};
    await pool([...hasEval], ctx.concurrency, async (wallet) => {
      // Load from F0 so positions opened in the formation window are tracked (and excluded), not split into the eval.
      const trades = loader.load(wallet, F0, E);
      const pos = await positionsWithMarks(ctx, trades, F1, E);
      outliers.push(...auditPositions(`eval${days}`, pos));
      const m = walletMetrics(wallet, pos, trades, F1, E);
      perf[wallet] = { roc: m.roc, pnl: m.pnl, positions: m.positions };
    });
    evalPerf[String(days)] = perf;
  }

  // 5. Replication of ranked and random wallets' buys in the first eval week (R-A4..A8)
  const ranksOf = new Map<string, Partial<Record<RankingId, number>>>();
  for (const id of RANKINGS) rankings[id].forEach((wl, i) => ranksOf.set(wl, { ...(ranksOf.get(wl) ?? {}), [id]: i + 1 }));
  const jobs: Array<{ wallet: string; group: "ranked" | "random" }> = [
    ...[...ranksOf.keys()].map((wallet) => ({ wallet, group: "ranked" as const })),
    ...randomPool.filter((x) => !ranksOf.has(x)).map((wallet) => ({ wallet, group: "random" as const })),
  ];
  const records: ReplRecord[] = [];
  const replEnd = F1 + p.stepDays * DAY;
  const tradeEnd = replEnd + p.maxHoldHours * 3600;
  await pool(jobs, ctx.concurrency, async ({ wallet, group }) => {
    if (!hasEval.has(wallet)) return;
    const trades = loader.load(wallet, F0, tradeEnd);
    const pos = buildPositions(trades, F1, tradeEnd, () => null).filter((x) => x.openT < replEnd && !x.tainted);
    const buys = pos.flatMap((x) => x.buys.filter((b) => b.t < replEnd).map((b) => ({ x, b })));
    const r = ranksOf.get(wallet) ?? {};
    const probe = group === "random" || Object.values(r).some((k) => k <= p.probeTopN);
    const chosen = sample(buys, group === "ranked" ? p.maxBuysRanked : p.maxBuysRandom, rng(hashSeed("buys", w.step, wallet)));
    for (const { x, b } of chosen) {
      const rec = await replicateBuy(oracle, p, w.step, group, r, x, b, probe);
      if (rec) records.push(rec);
    }
  });
  // Mint state for Phase B entry filters (probed records only)
  const mints = [...new Set(records.filter((r) => r.path).map((r) => r.mint))];
  await pool(mints, ctx.concurrency, async (m) => {
    await loadMint(ctx.db, ctx.helius, m);
  });

  const keep = new Set([...eligible.map((m) => m.wallet), ...Object.values(rankings).flat()]);
  const result: StepResult = {
    step: w.step, F0, F1,
    discovery: {
      sampledSwaps: disc.sampledSwaps, qualifyingTokens: disc.qualifyingTokens, sampledWallets: disc.sampledWallets,
      screened, hft, capped, unfetched, candidates: candidates.length, screenCap: p.screenCap, candidateCap: p.candidateCap,
    },
    excluded, ineligible, eligible: eligible.length, eligibleWallets: eligible.map((m) => m.wallet),
    metrics: allRefined.filter((m) => keep.has(m.wallet)).map((m) => eligible.find((e) => e.wallet === m.wallet) ?? m),
    rankings, randomPool, evalPerf, records: records.sort((a, b) => a.t - b.t || (a.sig < b.sig ? -1 : 1)),
    creditsAfter: ctx.helius?.creditsUsed ?? 0,
    outliers,
    loader: { ...loader.stats },
  };
  mkdirSync(ctx.stepsDir, { recursive: true });
  writeFileSync(file, JSON.stringify(result));
  log.info("step done", { step: w.step, records: records.length, credits: ctx.helius?.creditsUsed, oracleFetches: oracle.fetches });
  return result;
}

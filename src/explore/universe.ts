/**
 * One exploratory step: every non-bot candidate wallet of the window, its formation metrics, C and I, its own
 * eval-window performance, and up to EXPLORE.evalBuys replicated eval buys (all delays). Cached per step.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CostParams } from "../config/params.js";
import { BudgetExceeded } from "../data/helius.js";
import { pool } from "../data/http.js";
import { ensureHistory } from "../data/walletHistory.js";
import { logger } from "../log.js";
import { collectCandidates, DAY, positionsWithMarks, type Ctx, type EvalPerf, type StepWindow } from "../research/pipeline.js";
import { formationScores, replicateEval, type WalletScore } from "../research/stage1.js";
import type { ReplRecord } from "../research/types.js";
import { ineligibleReasons, defaultEligibility, type IneligibleReason } from "../wallets/eligibility.js";
import { defaultExclusions, exclusionReasons, type ExclusionReason } from "../wallets/exclusions.js";
import { walletMetrics, type WalletMetrics } from "../wallets/metrics.js";
import { buildPositions } from "../wallets/positions.js";
import { EXPLORE } from "./config.js";

const log = logger("explore");

export interface UWallet {
  wallet: string;
  /** Formation metrics with fetched marks (universe wallets) or without (excluded ones). */
  m: WalletMetrics;
  excluded: ExclusionReason[];
  /** Phase A §4.3 reasons under the default eligibility (empty = Phase A eligible). */
  ineligible: IneligibleReason[];
  inUniverse: boolean;
  score?: WalletScore;
  /** The wallet's own result over the eval window (positions opened in it). */
  own?: EvalPerf;
  evalCovered?: boolean;
}

export interface UStep extends StepWindow {
  E: number;
  discovery: { sampledWallets: number; screened: number; hft: number; capped: number; unfetched: number; candidates: number };
  wallets: Record<string, UWallet>;
  universe: string[];
  records: ReplRecord[];
  creditsBefore: number;
  creditsAfter: number;
}

export function exploreSteps(from: number, n = 6): StepWindow[] {
  return Array.from({ length: n }, (_, step) => {
    const F0 = from + step * EXPLORE.stepDays * DAY;
    return { step, F0, F1: F0 + EXPLORE.formationDays * DAY };
  });
}

export const uStepFile = (dir: string, step: number) => join(dir, `step-${String(step).padStart(2, "0")}.json`);

export async function runUniverseStep(ctx: Ctx, dir: string, w: StepWindow, costs: CostParams): Promise<UStep> {
  const file = uStepFile(dir, w.step);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as UStep;
  const { F0, F1, step } = w;
  const E = F1 + EXPLORE.evalDays * DAY;
  const creditsBefore = ctx.helius?.creditsUsed ?? 0;

  // 1. Candidates (discovery, bot screen, formation histories)
  const c = await collectCandidates(ctx, w);

  // 2. Exclusions, then formation metrics with marks for the universe
  const wallets: Record<string, UWallet> = {};
  const pre: string[] = [];
  for (const wallet of c.candidates) {
    const trades = ctx.loader.load(wallet, F0, F1);
    const pos = buildPositions(trades, F0, F1, () => null);
    const m = walletMetrics(wallet, pos, trades, F0, F1);
    const excluded = exclusionReasons(trades, pos, F0, F1, defaultExclusions);
    wallets[wallet] = { wallet, m, excluded, ineligible: [], inUniverse: false };
    if (!excluded.length && m.closed >= EXPLORE.minClosed) pre.push(wallet);
  }
  await pool(pre, ctx.concurrency, async (wallet) => {
    const trades = ctx.loader.load(wallet, F0, F1);
    const pos = await positionsWithMarks(ctx, trades, F0, F1);
    const m = walletMetrics(wallet, pos, trades, F0, F1);
    Object.assign(wallets[wallet]!, { m, ineligible: ineligibleReasons(m, F1, defaultEligibility()), inUniverse: m.closed >= EXPLORE.minClosed });
  });
  const universe = pre.filter((x) => wallets[x]!.inUniverse).sort();
  log.info("universe", { step, candidates: c.candidates.length, universe: universe.length, phaseAEligible: universe.filter((x) => !wallets[x]!.ineligible.length).length, credits: ctx.helius?.creditsUsed });

  // 3. Eval histories and each wallet's own eval-window result
  await pool(universe, ctx.concurrency, async (wallet) => {
    const ok = !ctx.helius || (await ensureHistory(ctx.db, ctx.helius, wallet, F0, E, ctx.p.maxHistoryTx * 2));
    wallets[wallet]!.evalCovered = ok;
    if (!ok) return;
    const trades = ctx.loader.load(wallet, F0, E);
    const pos = await positionsWithMarks(ctx, trades, F1, E);
    const m = walletMetrics(wallet, pos, trades, F1, E);
    wallets[wallet]!.own = { roc: m.roc, pnl: m.pnl, positions: m.positions };
  });

  // 4. Formation C and I (tape fenced at F1; no eval reuse exclusion: monthly eval windows do not overlap scoring)
  const roc = new Map(universe.map((x) => [x, wallets[x]!.m.roc]));
  const scores = await formationScores(ctx, w, universe, costs, () => new Set(), roc);
  for (const [x, s] of Object.entries(scores)) wallets[x]!.score = s;
  log.info("scored", { step, withC: Object.values(scores).filter((s) => s.C !== null).length, withI: Object.values(scores).filter((s) => s.I !== null).length, credits: ctx.helius?.creditsUsed });

  // 5. Eval replication for every covered universe wallet
  const covered = universe.filter((x) => wallets[x]!.evalCovered);
  const records = await replicateEval(ctx, w, covered, new Set(), { days: EXPLORE.evalDays, nBuys: EXPLORE.evalBuys, seedTag: "explore" });

  if (ctx.helius && ctx.oracle.budgetMisses) throw new BudgetExceeded(ctx.helius.creditsUsed, ctx.helius.budget);
  const out: UStep = {
    ...w, E,
    discovery: { sampledWallets: c.disc.sampledWallets, screened: c.screened, hft: c.hft, capped: c.capped, unfetched: c.unfetched, candidates: c.candidates.length },
    wallets, universe, records, creditsBefore, creditsAfter: ctx.helius?.creditsUsed ?? 0,
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(out));
  log.info("step done", { step, universe: universe.length, records: records.length, credits: out.creditsAfter - creditsBefore });
  return out;
}

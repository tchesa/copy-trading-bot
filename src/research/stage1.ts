/**
 * Copyability spec Stage 1 data collection, per walk-forward step, on top of the cached Phase A step (its eligible
 * wallets, formation metrics, S2 list and random pool):
 *  1. formation scores C and I for every eligible wallet (formation-window trades and tape only, fenced: R-P2);
 *  2. S5 (top C) and S6 (I ≤ 0.30, top formation return on capital);
 *  3. eval replication (Phase A simulator inputs, all delays) of up to 20 buys per wallet for S2, S5, S6 and the
 *     random pool (B1).
 * Each step is cached to `<dir>/step-NN.json`; a step is computed only after every earlier one (R-P5 needs their
 * eval buys).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pool } from "../data/http.js";
import { BudgetExceeded } from "../data/helius.js";
import { ensureHistory } from "../data/walletHistory.js";
import { logger } from "../log.js";
import { STAGE1 } from "../score/config.js";
import { copyScore, fence, formationBuys, replicateFormationBuy, simulateC } from "../score/copyability.js";
import { followBuyersOf, followMoveOf, impactOf, impactScores, sellIntoCrowdOf, walletComponents, type ImpactComponents } from "../score/impact.js";
import { hashSeed, rng, sample } from "../util/rng.js";
import { buildPositions } from "../wallets/positions.js";
import type { CostParams } from "../config/params.js";
import { DAY, type Ctx, type StepResult } from "./pipeline.js";
import { replicateBuy } from "./replicate.js";
import type { ReplRecord } from "./types.js";

const log = logger("stage1");

export type Stage1Method = "S2" | "S5" | "S6";
export const STAGE1_METHODS: Stage1Method[] = ["S5", "S6", "S2"];

export interface WalletScore {
  C: number | null;
  /** Readable replicated formation buys behind C. */
  nC: number;
  /** Follower returns of those buys (for audit). */
  rets: number[];
  sampled: number;
  comps: ImpactComponents;
  I: number | null;
  roc: number;
}

export interface Stage1Step {
  step: number;
  F0: number;
  F1: number;
  scores: Record<string, WalletScore>;
  rankings: Record<Stage1Method, string[]>;
  randomPool: string[];
  /** Raw eval records (unreadable ones included; dropped at load, see stage1Records). */
  records: ReplRecord[];
  evalWallets: string[];
  creditsBefore: number;
  creditsAfter: number;
}

/** Formation C and I for `wallets` (I percentiles among them). Reads only formation-window trades and a tape fenced at F1. */
export async function formationScores(
  ctx: Ctx, w: { step: number; F0: number; F1: number }, wallets: string[], costs: CostParams, exclude: (wallet: string) => Set<string>, roc: Map<string, number>,
): Promise<Record<string, WalletScore>> {
  const { F0, F1, step } = w;
  const tape = fence(ctx.oracle, F1);
  const scores: Record<string, WalletScore> = {};
  const comps = new Map<string, ImpactComponents>();
  await pool(wallets, ctx.concurrency, async (wallet) => {
    const trades = ctx.loader.load(wallet, F0, F1);
    const positions = buildPositions(trades, F0, F1, () => null);
    const chosen = formationBuys(positions, F0, F1, step, wallet, exclude(wallet));
    const results = [];
    const buyComps = [];
    const sells = new Map<string, boolean | null>();
    for (const { pos, buy } of chosen) {
      const rec = await replicateFormationBuy(tape, step, pos, buy, ctx.p.minExitLiquiditySol);
      results.push(rec ? simulateC(rec, costs) : null);
      const ref = { sig: buy.sig, wallet, t: buy.t, sol: buy.sol, reserveAfterSol: buy.poolQuoteReserveSol };
      const w = STAGE1.crowdWindow;
      const { rows, complete } = await tape.tradesFrom(buy.pool!, buy.t - w, 2 * w + 1);
      buyComps.push({ impact: impactOf(ref), followMove: complete ? followMoveOf(rows, ref) : null, followBuyers: complete ? followBuyersOf(rows, ref) : null });
      for (const s of rec?.sells ?? []) {
        const sp = s.pool ?? buy.pool!;
        const k = `${sp}|${s.t}`;
        if (s.kind === "out" || sells.has(k)) continue;
        const before = await tape.tradesBefore(sp, s.t, STAGE1.baselineSeconds);
        sells.set(k, before.from === null ? null : sellIntoCrowdOf(before.rows, wallet, s.t, before.from));
      }
    }
    const c = copyScore(results);
    const wc = walletComponents(buyComps, [...sells.values()]);
    comps.set(wallet, wc);
    scores[wallet] = {
      C: c.C, nC: c.n, rets: results.filter((x) => x !== null).map((x) => x!.ret), sampled: chosen.length,
      comps: wc, I: null, roc: roc.get(wallet) ?? NaN,
    };
  });
  for (const [x, I] of impactScores(comps)) scores[x]!.I = I;
  return scores;
}

/** The step's formation scores, S5/S6. */
export async function scoreFormation(ctx: Ctx, a: StepResult, costs: CostParams, exclude: (wallet: string) => Set<string>) {
  const roc = new Map(a.metrics.map((m) => [m.wallet, m.roc]));
  const scores = await formationScores(ctx, a, a.eligibleWallets, costs, exclude, roc);
  const by = (ws: string[], k: (w: string) => number) =>
    ws.filter((w) => Number.isFinite(k(w))).sort((x, y) => k(y) - k(x) || (x < y ? -1 : 1)).slice(0, STAGE1.topN);
  const el = [...a.eligibleWallets].sort();
  const rankings: Record<Stage1Method, string[]> = {
    S5: by(el.filter((w) => scores[w]!.C !== null), (w) => scores[w]!.C!),
    S6: by(el.filter((w) => scores[w]!.I !== null && scores[w]!.I! <= STAGE1.maxImpact), (w) => scores[w]!.roc),
    S2: a.rankings.S2.slice(0, STAGE1.topN),
  };
  return { scores, rankings };
}

/**
 * Eval replication: up to `nBuys` buys per wallet made in [F1, F1 + days), all delays (Phase A replicateBuy).
 * Stage 1: the first eval week, evalBuys per wallet; histories are ensured up to the longest of evalDays and days.
 */
export async function replicateEval(
  ctx: Ctx, a: { step: number; F0: number; F1: number }, wallets: string[], ranked: Set<string>,
  opt: { days?: number; nBuys?: number; seedTag?: string } = {},
): Promise<ReplRecord[]> {
  const { F0, F1, step } = a;
  const p = { ...ctx.p, delays: [...STAGE1.delays] };
  const days = opt.days ?? p.stepDays;
  const maxEval = Math.max(...p.evalDays, days);
  const replEnd = F1 + days * DAY;
  const tradeEnd = replEnd + p.maxHoldHours * 3600;
  const records: ReplRecord[] = [];
  await pool(wallets, ctx.concurrency, async (wallet) => {
    if (ctx.helius && !(await ensureHistory(ctx.db, ctx.helius, wallet, F0, F1 + maxEval * DAY, p.maxHistoryTx * 2))) return;
    const trades = ctx.loader.load(wallet, F0, tradeEnd);
    const pos = buildPositions(trades, F1, tradeEnd, () => null).filter((x) => x.openT < replEnd && !x.tainted && !x.suspect);
    const buys = pos.flatMap((x) => x.buys.filter((b) => b.t < replEnd).map((b) => ({ x, b })));
    const chosen = sample(buys, opt.nBuys ?? STAGE1.evalBuys, rng(hashSeed(opt.seedTag ?? "eval20", step, wallet)));
    const group = ranked.has(wallet) ? "ranked" : "random";
    for (const { x, b } of chosen) {
      const rec = await replicateBuy(ctx.oracle, p, step, group, {}, x, b, false);
      if (rec) records.push(rec);
    }
  });
  return records.sort((x, y) => x.t - y.t || (x.sig < y.sig ? -1 : 1));
}

export function stage1File(dir: string, step: number) {
  return join(dir, `step-${String(step).padStart(2, "0")}.json`);
}

export async function runStage1Step(ctx: Ctx, dir: string, a: StepResult, costs: CostParams, earlier: Stage1Step[]): Promise<Stage1Step> {
  const file = stage1File(dir, a.step);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as Stage1Step;
  const creditsBefore = ctx.helius?.creditsUsed ?? 0;
  const used = new Map<string, Set<string>>();
  for (const s of earlier) for (const r of s.records) {
    if (!used.has(r.wallet)) used.set(r.wallet, new Set());
    used.get(r.wallet)!.add(r.sig);
  }
  const { scores, rankings } = await scoreFormation(ctx, a, costs, (w) => used.get(w) ?? new Set());
  log.info("scored", { step: a.step, withC: Object.values(scores).filter((s) => s.C !== null).length, withI: Object.values(scores).filter((s) => s.I !== null).length, S5: rankings.S5.length, S6: rankings.S6.length, credits: ctx.helius?.creditsUsed });
  const ranked = new Set([...rankings.S2, ...rankings.S5, ...rankings.S6]);
  const evalWallets = [...new Set([...ranked, ...a.randomPool])].sort();
  const records = await replicateEval(ctx, a, evalWallets, ranked);
  const out: Stage1Step = {
    step: a.step, F0: a.F0, F1: a.F1, scores, rankings, randomPool: a.randomPool, records, evalWallets,
    creditsBefore, creditsAfter: ctx.helius?.creditsUsed ?? 0,
  };
  if (ctx.helius && ctx.oracle.budgetMisses) throw new BudgetExceeded(ctx.helius.creditsUsed, ctx.helius.budget);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(out));
  log.info("step done", { step: a.step, records: records.length, credits: ctx.helius?.creditsUsed });
  return out;
}

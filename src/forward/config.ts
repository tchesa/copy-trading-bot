/**
 * Weekly forward paper-test of Fomo leaderboard wallets (`pnpm weekly`). Pre-registered: committed before the first
 * forward week is scored; every report prints the commit. Changing anything here after the first scored week makes
 * the results exploratory (say so in the report).
 */
export const FORWARD = {
  version: 1,
  // Simulation (Phase A simulator: src/research/replicate.ts + follower.ts)
  delays: [0, 1, 5, 15],
  headlineDelay: 1,
  sizes: [0.1, 1],
  headlineSize: 0.1,
  maxHoldHours: 48,
  /** Leader buys below this cost are not copied (MIN_POSITION_COST_SOL). */
  minBuySol: 0.01,
  /** A buy is replicated once its time stop is at least this far in the past (the tape after it must be complete). */
  closeMarginSeconds: 2 * 3600,
  /** Data-quality drop (from the October run): a 1/5/15 s entry filled more than this many times below the leader's
   * own pool price is a stale or wrong pool, not a real discount. */
  maxEntryDiscount: 3,
  /** Every buy ≥ minBuySol is copied if the run's budget allows; otherwise buys are taken in a fixed-seed random order. */
  seed: "fomo-forward-v1",
  /** Snapshot day (0 = Sunday … 4 = Thursday, in the snapshot's own UTC offset): weekly runs on Thursdays, matching
   * the Helius billing cycle. A snapshot on another day only warns (weeks are snapshot to snapshot either way). */
  snapshotWeekday: 4,
  // Wallets
  /** History before the snapshot loaded for positions (buys adding to a position opened in it are still copied)
   * and for the bot screen. */
  lookbackDays: 7,
  /** Snapshot wallets with more txs than this in the lookback week are bots: skipped for that week. */
  botTxPerWeek: 50_000,
  /** A match on this many Fomo trades or fewer (or a tie) is weak: reported with and without. */
  weakVotes: 1,
  // Variants (by Fomo rank among the snapshot's copyable wallets)
  topN: [5, 10],
  // Baseline: random wallets that bought the same tokens in the same week (B1-style random pool)
  baselineWallets: 20,
  baselineBuysPerWallet: 20,
  /** Random wallets above this many txs over lookback + week are bots (history cap, like Phase A). */
  baselineMaxTx: 5000,
  // Statistics
  /** Top-1% trimmed mean (as STAGE1.trim). */
  trim: 0.01,
  boot: 2000,
  // Go / no-go, evaluated on the first `goWeeks` complete forward weeks
  goWeeks: 6,
  minTrades: 300,
  minWallets: 20,
  minPositiveWeeks: 4,
  // Budget
  /** Default per-run credit cap. October: 487k credits for 18 wallets × 60 buys over 27 days plus 38 days of
   * history; a full week of every buy from ~20 wallets is ~1.5–2.5k buys. */
  defaultRunBudget: 500_000,
  /** --estimate constants when a wallet's history is not stored yet (from the October run). */
  est: { historyCreditsPerWalletWeek: 3300, buysPerWalletWeek: 110, creditsPerBuy: 150, matchCreditsPerTrade: 20 },
} as const;

export type Variant = "all" | "confident" | "top5" | "top10" | "baseline";
export const VARIANTS: Variant[] = ["all", "confident", "top5", "top10", "baseline"];
export const VARIANT_LABEL: Record<Variant, string> = {
  all: "All snapshot wallets (headline)",
  confident: "Without weak matches",
  top5: "Top 5 by Fomo rank",
  top10: "Top 10 by Fomo rank",
  baseline: "Random wallets, same tokens & week",
};

/**
 * Exploratory follow-up to the copyability spec (not pre-registered): 30-day scoring window, 30-day simulation
 * window, monthly non-overlapping steps, and a sample of eval buys replicated for every non-bot wallet so any
 * selection rule can be tested offline. Steps 0–2 pick rules, steps 3–5 are the holdout that judges them.
 */
export const EXPLORE = {
  formationDays: 30,
  evalDays: 30,
  stepDays: 30,
  /** Discovery and screen: wider than Phase A (400 / 3000) so active wallets are not dropped by the budget. */
  candidateCap: 800,
  screenCap: 6000,
  /** Formation history per wallet (eval: 2×). Phase A dropped wallets above 1000 txs. */
  maxHistoryTx: 3000,
  /** Universe: not a bot / MEV / arb / creator and at least this many closed formation positions. */
  minClosed: 5,
  evalBuys: 15,
  creditCap: 6_000_000,
  discoverySteps: [0, 1, 2],
  holdoutSteps: [3, 4, 5],
  /** Selection rules need this much data on the steps they are judged on. */
  minWallets: 10,
  minTradesPerStep: 40,
  topNs: [5, 10, 25],
  /** Max-statistic null: features shuffled among wallets within each step. */
  permutations: 200,
  seeds: 20,
  boot: 2000,
  trim: 0.01,
  settings: [
    { name: "5 s / 0.1 SOL", delay: 5, size: 0.1 },
    { name: "15 s / 0.1 SOL", delay: 15, size: 0.1 },
    { name: "5 s / 1 SOL", delay: 5, size: 1 },
    { name: "0 s / 0.1 SOL (B5)", delay: 0, size: 0.1 },
    { name: "1 s / 0.1 SOL", delay: 1, size: 0.1 },
  ],
} as const;

/** Study params passed to the shared pipeline pieces (discovery, histories, replication). */
export const exploreStudyParams = {
  formationDays: EXPLORE.formationDays,
  evalDays: [EXPLORE.evalDays],
  stepDays: EXPLORE.stepDays,
  candidateCap: EXPLORE.candidateCap,
  screenCap: EXPLORE.screenCap,
  // The screen reads one 1000-signature page, so its count never exceeds 1000: the history cap does the capping.
  maxFormationTx: 1_000_000,
  maxHistoryTx: EXPLORE.maxHistoryTx,
};

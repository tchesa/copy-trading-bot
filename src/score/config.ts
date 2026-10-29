/**
 * Copyability spec (docs/copyability-score-spec.md), Stage 1 configuration. Pre-registered (R-P1): committed before any
 * Stage 1 data is pulled; the report prints the commit. Changing anything here after the pull makes results exploratory.
 */
export const STAGE1 = {
  // 4.1 Copyability score C
  formationBuys: 12,
  minCBuys: 8,
  cDelay: 5,
  sizeSol: 0.1,
  maxHoldHours: 48,
  /** Top-1% trimmed mean (C and every "trimmed mean" in the report). */
  trim: 0.01,
  // 4.2 Market impact score I
  minIBuys: 8,
  /** Follow-on window around a buy, and before a sell (seconds). */
  crowdWindow: 30,
  /** sellIntoCrowd: buyers in the 30 s before the sell ≥ crowdMultiple × the 1 h baseline (and ≥ crowdMinBuyers). */
  crowdMultiple: 2,
  crowdMinBuyers: 2,
  baselineSeconds: 3600,
  // 5.1 Methods
  topN: 10,
  maxImpact: 0.3,
  // 5.3 Evaluation
  evalBuys: 20,
  delays: [0, 1, 5, 15, 30, 60, 300],
  headlineDelay: 5,
  robustDelay: 15,
  robustSize: 0.25,
  seeds: 20,
  /** Eval-window C (G7) needs at least this many readable eval buys (the spec leaves it open; fixed here). */
  evalCMinBuys: 3,
  boot: 2000,
  // 5.4 Budget
  creditCap: 1_000_000,
  // 5.5 / 6
  dropFlag: 0.15,
  minWallets: 15,
  minTrades: 150,
  minPositiveWeeks: 5,
} as const;

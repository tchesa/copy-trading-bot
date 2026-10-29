# shadow-wallets — Copyability score test (spec)

Test whether ranking wallets by **how copyable their profits are**, instead of by raw profit, finds wallets a 5-second-delayed follower can actually make money on.

Builds on the existing Phase A pipeline (walk-forward steps, replication simulator, cost model, wallet-clustered bootstrap, B1 baseline). Everything in sections 3–6 is **fixed before any Stage 1 data is pulled** (pre-registration, section 7).

---

## 1. Background and hypothesis

Phase A found:
- **S1 (top raw PnL):** leaders have positive alpha (+8.8% mean), but a follower loses 22–24 points within 1–5 seconds. Their gains happen before anyone can copy.
- **S2/S4 (return on capital, consistency):** almost no delay cost, but no edge either. Median trade negative at every size and delay, rugs ~15% at 5s.
- **S3 (PnL ÷ crowding):** selected the same top 10 as S2, so the crowding idea was never really tested.

> **H1:** Some wallets earn gains that arrive *after* the first seconds following their buy (information, not speed or crowd reaction). Ranking wallets on that property in the formation window selects wallets whose eval-window buys are profitable for a 5s follower.

> **H0 (expected if NO-GO):** Wallet profits are either front-loaded (speed/crowd) or absent, so a copyability ranking performs no better than S2 or random wallets.

---

## 2. Stages

| Stage | Data | Credits | Purpose | Outcome |
|---|---|---|---|---|
| 0 | Cached (353 kept eval buys) | None | Feasibility: does the "profitable and copyable" corner exist at all? | Stop, or proceed to Stage 1 |
| 1 | New formation-window tape | Yes (budgeted, section 5.4) | The real out-of-sample test | GO / NO-GO / inconclusive |

Stage 0 is in-sample and post hoc. It can only **stop** the project; it can never count as evidence for GO, and its results must not be used to change any Stage 1 parameter.

---

## 3. Stage 0 — Feasibility check (cached data)

### 3.1 Inputs
- The 353 replicated eval buys from `data/steps/f6b5c3c746` (follower results at 0s and 5s, 0.1 SOL size).
- Leader-own returns for all 939 buys (kept + dropped), from the audit.

### 3.2 Per wallet-week metrics
For each (wallet, step) with ≥ 3 replicated buys:
- `leaderRet`: median and top-1%-trimmed mean of the leader's own return.
- `delayCost5`: median of (follower 5s return − follower 0s return).
- `copyRet5`: median and trimmed mean of follower 5s return.

### 3.3 Outputs
- Scatter: `leaderRet` (x) vs `delayCost5` (y), one point per wallet-week, colored by ranking method.
- Quadrant counts with fixed cutoffs: leader trimmed mean > 0, and median `delayCost5` > −2%.
- For the "profitable and copyable" quadrant: number of distinct wallets, weeks covered, pooled `copyRet5` median and trimmed mean with wallet-clustered 95% intervals.

### 3.4 Stage 0 stop rule
**Stop the project** if any of:
- fewer than 5 distinct wallets fall in the "profitable and copyable" quadrant, or
- those wallets appear in fewer than 3 different weeks, or
- their pooled `copyRet5` trimmed mean is ≤ 0.

Otherwise proceed to Stage 1. Passing Stage 0 only means the corner is not empty.

---

## 4. Scores (Stage 1)

All scores use **formation-window data only** (the 30 days before each step's eval week).

### 4.1 Copyability score `C` (primary)
For every eligible wallet:
1. Sample up to **12 formation-window buys** (uniformly at random, fixed seed per wallet-step).
2. Replicate each with the existing simulator: **5s delay, 0.1 SOL size**, exits mirror the leader's sells (priced at the leader's own sell fills), 48h time stop, same fee/priority/rug model as Phase A.
3. `C` = top-1%-trimmed mean of the follower returns.
4. Wallets with fewer than **8** readable replicated formation buys get no `C` and are not ranked by S5.

### 4.2 Market impact score `I` (secondary, 0–1)
Four components per wallet, each the median over its formation buys. The leader's own trades are excluded from all follow-on measures.

| Component | Definition |
|---|---|
| `impact` | Leader buy size ÷ pool quote reserve before the buy |
| `followMove` | log(price at t+30s ÷ price at t+1 slot) − log(price at t ÷ price at t−30s) |
| `followBuyers` | distinct buyers in (t, t+30s] − distinct buyers in [t−30s, t) |
| `sellIntoCrowd` | share of the leader's sells made while distinct buyers in the preceding 30s ≥ 2× the same token's 1h baseline |

Each component is converted to a percentile rank among that step's eligible wallets (higher = more market-moving). `I` = mean of the four percentiles, in [0, 1].

Wallets with fewer than 8 measurable formation buys get no `I` and are not ranked by S6.

---

## 5. Methods and evaluation (Stage 1)

### 5.1 Methods tested (only these two)
| ID | Selection each week |
|---|---|
| **S5** | Eligible wallets (same filters as S2), ranked by `C`; top 10 |
| **S6** | Eligible wallets with `I` ≤ 0.30, ranked by formation return on capital; top 10 |

No other variants (different thresholds, sizes, windows) may be added after Stage 1 data is seen without being reported as exploratory.

### 5.2 Baselines
| ID | Baseline |
|---|---|
| S2 | Existing method, same eval buys and settings |
| B1 | Random eligible wallets, 20 seeds, same number of wallets |
| B5 | Same selected buys at 0s delay (upper bound) |

### 5.3 Evaluation
- Same 8 walk-forward steps (2026-03-28 → 2026-06-15 formations), plus any later weeks the budget allows (section 5.4).
- Eval window: 7 days after formation.
- Replicate up to **20 eval buys per selected wallet per week** (raised from 8 to get enough trades).
- Headline: **5s delay, 0.1 SOL**. Robustness: 15s at 0.1 SOL, and 5s at 0.25 SOL.
- Report per method: trades, median, trimmed mean, hit rate, rug rate, attribution (alpha, delay cost, slippage, fees, rug loss), wallet-clustered 95% intervals, per-week results, SOL/week.
- Also report **persistence of the score itself**: Spearman between each wallet's formation `C` and its eval-window `C`.

### 5.4 Data budget
- Formation tape: up to 12 buys × eligible wallets × steps, deduplicated by buy signature across overlapping formation windows, **5s entry and leader-exit fills only** (no 1s/15s/60s/300s entries in formation).
- Eval tape: up to 20 buys per selected wallet per week, all eval delays.
- `pnpm score --estimate` prints the expected credit cost before any pull.
- **Hard cap: 1,000,000 Helius credits for Stage 1** (one free-tier month), enforced in the client. If the estimate exceeds the cap, reduce the number of steps (newest first are kept), not the per-wallet buy counts.

### 5.5 Coverage improvement (prerequisite, cached data)
62% of eval buys were dropped for unreadable tape, concentrated in meteora_damm2 (93%), meteora_dlmm (88%), raydium_clmm (80%) and pumpswap (71%). Before Stage 1:
- Diagnose the main unreadable-fill cause per venue and fix what can be fixed without new pulls.
- Report the drop rate per venue before and after.
- Stage 1 must report drop rates per method; a method whose drop rate differs from S2's by more than 15 points is flagged.

---

## 6. Go/no-go (pre-registered)

**GO** requires S5 or S6 to meet *all* of:

| ID | Criterion |
|---|---|
| G1 | ≥ 150 replicated eval buys from ≥ 15 distinct wallets |
| G2 | At 5s / 0.1 SOL: median > 0 **and** trimmed mean > 0 |
| G3 | Wallet-clustered **one-sided 95% lower bound** of the trimmed mean > 0 at 5s / 0.1 SOL |
| G4 | Trimmed mean > 0 at 15s / 0.1 SOL as well |
| G5 | Beats B1 and S2 on both median and trimmed mean at 5s |
| G6 | Positive trimmed mean in ≥ 5 of 8 weeks |
| G7 | Positive Spearman between formation `C` and eval `C` (score persists) |

Outcomes:
- **GO:** all of G1–G7 pass for at least one method.
- **Inconclusive:** G2 and G5 pass but G1 or G3 fails (not enough data). The only allowed follow-up is more data with the same spec.
- **NO-GO:** anything else.

The stricter bar (G3, a confidence bound rather than a point estimate) compensates for the number of ranking methods already tried on this data.

---

## 7. Integrity requirements

- **R-P1 Pre-registration:** this spec and the Stage 1 config are committed, and their git hash recorded, before any Stage 1 data is pulled. The report prints that hash.
- **R-P2 No lookahead:** `C` and `I` use only formation-window trades and tape. Eval-window data is never read during ranking.
- **R-P3 Stage separation:** Stage 0 results may not change any threshold, size, delay, sample count or method definition in sections 4–6.
- **R-P4 Leader exclusion:** follow-on measures (`followMove`, `followBuyers`, `sellIntoCrowd`) exclude the leader's own transactions.
- **R-P5 Dedup:** a buy used in a wallet's formation `C` for one step can appear in another step's formation (overlapping windows) but never in any eval window for the same wallet.
- **R-P6 Tests:** unit tests for each `I` component on synthetic tapes (known crowd, known impact), for `C` replication reuse of the Phase A simulator, and a lookahead test that fails if ranking reads any trade after formation end.
- **R-P7 Reproducibility:** report written to `reports/<ts>-copyability.md|json` with config, credits used per kind, commit hash and all tables.

---

## 8. Implementation notes

```
src/
├── score/
│   ├── copyability.ts      # C: formation-window 5s replication per wallet
│   └── impact.ts           # I: four components + percentile ranking
├── research/
│   ├── feasibility.ts      # Stage 0
│   └── study.ts            # add S5, S6 to the existing methods
└── data/
    └── coverage.ts         # per-venue unreadable-fill diagnostics (5.5)
```

Commands:
- `pnpm feasibility` → Stage 0 report (no credits)
- `pnpm coverage` → per-venue drop diagnostics
- `pnpm score --estimate` → credit estimate for Stage 1
- `pnpm study --methods S2,S5,S6 --label copyability` → Stage 1 report

---

## 9. Deliverables

1. Stage 0 feasibility report with the stop/proceed decision.
2. Coverage diagnostics before and after fixes.
3. Stage 1 credit estimate.
4. Stage 1 study report with the pre-registered gate outcome.
5. Update to the shadow-wallets final report (verdict for the whole project).

---

## 10. Open questions

- Stage 0 cutoffs (−2% delay cost, 5 wallets, 3 weeks) are judgment calls; confirm before running.
- Whether to extend Stage 1 to weeks after 2026-06-15 if budget allows (more regimes, but the walk-forward must keep the same formation/eval structure).
- Whether 0.1 SOL is the right headline size given leaders' median buy of 0.03 SOL.

# copy-trading — Requirements

Test whether **some Solana wallets show persistent trading skill**, and whether a follower who copies them **with a realistic delay** still makes money after costs, rugs and crowding.

New repo (proposed name: `shadow-wallets`). It ports the walk-forward harness, sweep/report conventions and integrity rules from funding-harvester; the data layer is new (on-chain Solana instead of exchange klines).

---

## 1. Background and hypothesis

Funding-harvester and funding-momentum both failed for the same reason: simple public signals on perps are priced in, and what's left is tail risk. Copy trading is a different mechanism. It doesn't harvest a premium; it borrows an **information edge** from wallets that find tokens early.

> **H1 (persistence):** Wallets ranked highly on past performance keep outperforming other wallets in the following period.

> **H2 (copyability):** A follower entering after a realistic delay (seconds to minutes) captures enough of that outperformance to be profitable after fees, slippage, priority fees and rugs.

> **H3 (selection):** The ranking method (filters, crowding adjustment) matters: selected wallets beat randomly chosen wallets that pass the same basic filters.

H1 can be true while H2 fails: skilled wallets may exist but their edge may be speed you can't copy.

**Main risks to the hypothesis**
- Past PnL in memecoins is mostly luck; the top of any ranking regresses toward average.
- The follower always enters late, often into the price impact of the leader and other copiers.
- Leaders with many copiers may sell into them (follower as exit liquidity).
- Rugs, honeypots and dead liquidity turn many follower trades into −100%.

---

## 2. Scope

**In scope**
- Solana only.
- Wallet discovery from on-chain data (no scraping of fomo.family or other apps). A small manually curated seed list of Fomo trader addresses may be added as an extra candidate group.
- Phase A: persistence and follower-replication study (no portfolio simulation).
- Phase B: portfolio simulation of a copy strategy with walk-forward evaluation.
- Test period: the most recent 12 months with full data (longer if data cost allows).

**Out of scope**
- Live or paper trading.
- Other chains.
- Copying perps or CEX activity.

---

## 3. Data requirements

### 3.1 Sources (to evaluate in a spike before committing)
| Need | Candidates | Evaluate |
|---|---|---|
| Parsed swap history per wallet | Helius enhanced transactions / parsed history | coverage of DEXs and launchpads, rate limits, cost, history depth |
| Trade tape or 1-minute OHLCV per token/pool | Helius, Birdeye, GeckoTerminal, Dune, Bitquery | history depth, coverage of dead/rugged tokens, cost |
| Token metadata at a point in time | Helius DAS + on-chain account history | mint/freeze authority status as of a slot, Token-2022 transfer fees |
| Pool liquidity at a point in time | Same as tape, or reconstructed from pool account state | needed for slippage and rug detection |

**R-D0:** A short data spike (1–2 days) produces a note: chosen sources, cost estimate for the full backfill, known coverage gaps. This is a go/no-go for the project itself; if trustworthy historical prices for dead tokens aren't affordable, the study can't be done honestly.

### 3.2 Requirements
| Requirement | Detail |
|---|---|
| R-D1 | Every swap by candidate wallets: timestamp (block time and slot), token in/out, amounts, venue (Raydium, Meteora, Orca, pump.fun or successors, aggregator routes) |
| R-D2 | Price series for every token traded, **including tokens that later rugged or died**, at ≤ 1-minute resolution, ideally trade-level for the first hours after a leader's buy |
| R-D3 | Liquidity per pool at entry and exit times (for slippage and "can't exit" detection) |
| R-D4 | Token risk attributes as of the entry slot: mint authority, freeze authority, transfer fee, LP locked/burned if known, token age |
| R-D5 | SOL/USD hourly price for valuation |
| R-D6 | All data stored locally (SQLite, same conventions as funding-harvester), backfill resumable per (source, wallet or token, day) |

---

## 4. Wallet discovery and filtering

### 4.1 Discovery (per formation window)
- **R-W1** Candidate wallets come from **all** swaps on tokens that traded ≥ `minTokenVolume` during the formation window, not from tokens that later pumped. Discovering wallets through known winners is lookahead and is forbidden.
- **R-W2** Cap candidates per window (e.g., the most active 5,000 by trade count above a minimum), with the cap recorded in the report.
- **R-W3** Optional seed group: manually supplied Fomo trader addresses, evaluated with the same rules and reported as a separate group.

### 4.2 Exclusions
Remove wallets that are not human-style traders:
- MEV/sandwich bots: buy and sell of the same token in the same or adjacent slots, multiple swaps per transaction.
- High-frequency bots: more than `maxTradesPerDay` (e.g., 200).
- Arbitrage and market-making wallets: balanced two-way flow in the same pools with tiny holding times.
- Token creators/deployers of the traded token (tagged; reported separately, excluded from the main group).

### 4.3 Eligibility filters (tunable, applied on formation-window data only)
- ≥ `minClosedPositions` closed positions (start 40)
- active in the last 7 days of the formation window
- no single position above `maxPnlConcentration` of formation PnL (start 30%)
- median holding time ≥ `minMedianHoldMinutes` (start 10)
- median entry liquidity ≥ `minEntryLiquidity` (so a follower can size in)

### 4.4 Metrics per wallet (formation window)
- return on capital (PnL ÷ peak capital deployed), not absolute PnL
- win rate, median and mean position return
- max drawdown of the wallet's equity curve
- **crowding:** median number of distinct wallets buying the same token within 5s, 30s and 60s after the wallet's buys (the on-chain replacement for follower count)
- **sell-into-crowd rate:** share of the wallet's sells that happen while crowd buying is still elevated

### 4.5 Ranking methods (each tested separately)
| ID | Method |
|---|---|
| S1 | Raw PnL, no filters (the "top 1 by PnL" starting idea) |
| S2 | Return on capital, with eligibility filters |
| S3 | S2 plus crowding penalty (PnL ÷ crowding, the on-chain version of PnL/followers) |
| S4 | S2 ranked on consistency (median return, % positive weeks) instead of total return |

---

## 5. Phase A — Persistence and replication study

### 5.1 Persistence (H1)
- **R-A1** For each walk-forward step: rank eligible wallets in the formation window (30 days), then measure the **same wallets' own** performance in the following evaluation window (7 and 14 days).
- **R-A2** Report evaluation-window performance by formation decile (and top 1, top 3, top 10), versus the median eligible wallet.
- **R-A3** Report the rank correlation (Spearman) between formation and evaluation performance, per step and pooled.

### 5.2 Replication (H2)
For every buy by a ranked wallet in the evaluation window, simulate a single follower trade:
- **R-A4** Entry at delays of 1s, 5s, 15s, 30s, 60s and 5 min after the leader's transaction, priced from the trade tape (first trades after `t + delay`) plus a size-based slippage model from pool liquidity.
- **R-A5** Exit: mirror the leader's sells proportionally, with the same delay. If the leader never sells within `maxHoldHours`, exit at the time stop.
- **R-A6** If liquidity at exit is below a threshold, or the token cannot be sold (honeypot, frozen account), the trade is −100%.
- **R-A7** Report per delay: median and mean follower return, hit rate, tail percentiles, and the **capture ratio** (follower return ÷ leader return on the same trade).
- **R-A8** Report the follower's net result split into leader alpha, delay cost (price moved before entry), slippage, fees and rug losses.

### 5.3 Phase A gate
Proceed to Phase B only if:
- **G1 persistence:** top-decile formation wallets beat the median eligible wallet in the evaluation window in ≥ 67% of steps, with positive pooled rank correlation.
- **G2 copyability:** for some ranking method, the median follower trade return net of all costs is > 0 at a delay of **≥ 5s**, and the mean is > 0 with the top 1% of trades removed.
- **G3 selection:** that ranking method's follower results beat randomly selected eligible wallets (B1 below) at the same delay.

Otherwise: write up the findings and stop.

---

## 6. Phase B — Portfolio simulation

### 6.1 Strategy
- Follow the top `followN` wallets (1, 3, 5) from the chosen ranking method; re-rank every `rerankDays` (start 7).
- Copy buys after `delaySeconds` (grid over the realistic range, minimum 5s for the headline result).
- Entry filters, evaluated with data as of the entry slot only:
  - token age ≥ `minTokenAgeMinutes`
  - pool liquidity ≥ `minEntryLiquidity`
  - mint authority and freeze authority revoked
  - no transfer fee (Token-2022)
  - leader's buy size ≥ `minLeaderBuySol` (skip dust and test buys)
- Exit: mirror leader sells proportionally; plus own hard stop `stopLossPct`, trailing stop `trailPct`, and time stop `maxHoldHours`.

### 6.2 Sizing
- Position size: fixed `positionPct` of equity (start 2%) or a fixed SOL amount, capped by `maxPctOfLiquidity` of the pool (start 1%).
- Max concurrent positions `maxPositions` (start 10); at most one position per token.
- Daily loss circuit breaker `maxDailyLossPct`.

### 6.3 Costs
- DEX/launchpad fees per venue (verify current values per venue).
- Base fee + priority fee + optional Jito tip per transaction (configurable SOL amounts, with a "contested" setting for hot tokens).
- Slippage from pool liquidity and trade size; tape-based price after the delay.
- Token-2022 transfer fees if any slip through the filter.
- Failed transactions: a configurable failure rate where the fee is paid and no fill occurs.

### 6.4 Attribution
Every trade split into **leader alpha captured, delay cost, slippage, fees, rug/exit failures.**

---

## 7. Controls and baselines

| ID | Baseline | Purpose |
|---|---|---|
| B1 | Random eligible wallets, same number followed, same rules (≥ 20 seeds) | Does ranking matter? (H3) |
| B2 | Same entry times, random tokens from the same liquidity/age band | Does the wallet pick better tokens, or is it timing/market? |
| B3 | Hold SOL | Market benchmark |
| B4 | S1 raw-PnL top 1, unfiltered | The original idea, as a reference point |
| B5 | Zero-delay copy of the selected wallets | Upper bound: how much the delay costs |

**The strategy only counts if it beats B1 and B2 out-of-sample at a realistic delay.**

---

## 8. Evaluation

### 8.1 Walk-forward
Memecoin edges decay fast, so windows are shorter than in funding-harvester:
- formation 30 days, test 7 days, step 7 days
- ~48 test windows over 12 months
- parameters chosen per step on a train period preceding the test (e.g., the 8 weeks before), by `APR − 0.5·maxDD`; reported numbers chain test windows only

### 8.2 Metrics
- OOS APR, max drawdown, Sharpe and Sortino (hourly equity)
- per-window return std dev and % of windows positive
- trades, win rate, median and mean trade return, average hold time
- concentration: share of P&L from top 5 trades and top 5 tokens; **APR with top 5 trades removed**
- rug/exit-failure rate and losses
- capture ratio vs leaders; results at each delay

### 8.3 Go/no-go bar (proposed; confirm before running Phase B)
- OOS APR ≥ 30% at a delay ≥ 5s, with max drawdown ≤ 30%
- Sharpe ≥ 1.0
- ≥ 67% of windows positive
- still positive with the top 5 trades removed
- beats the B1 median and at least 90% of B1 seeds; beats B2
- results hold at the next-slower delay step (e.g., if headline is 5s, still positive at 15s)

The bar is higher than funding-momentum's because the strategy is directional, fat-tailed and exposed to rugs.

---

## 9. Integrity requirements

- **R-I1 No lookahead in discovery:** wallets come only from formation-window activity across all qualifying tokens (R-W1). No "find wallets that bought winners".
- **R-I2 No lookahead in ranking:** formation metrics use positions closed before the window ends; open positions are marked at the formation-end price.
- **R-I3 Point-in-time token data:** filters use token and pool state as of the entry slot, not today's state.
- **R-I4 No survivorship:** dead and rugged tokens remain in the data with their real exit outcome; untradeable exits are −100%.
- **R-I5 Realistic timing:** delays are measured from the leader's block time; Solana block time has 1-second resolution, so sub-second delays are not claimed.
- **R-I6 Tests:** unit tests for swap parsing per venue, position reconstruction (partial sells, multiple buys), delay pricing, rug detection and a lookahead test that fails if any decision reads data after its timestamp.
- **R-I7 Reproducibility:** each run writes `reports/<ts>-<label>.md|json` with config, data source versions, git commit and results.
- **R-I8 Terms compliance:** no scraping or automated access to fomo.family or similar apps; on-chain public data only.

---

## 10. Implementation notes

```
shadow-wallets/
├── src/
│   ├── data/          # source clients, backfill, swap parsing per venue
│   ├── db/            # SQLite schema and queries
│   ├── wallets/       # discovery, exclusions, position reconstruction, metrics
│   ├── ranking/       # S1–S4
│   ├── research/      # Phase A: persistence and replication study
│   ├── strategy/      # pure functions: entry filters, exits, sizing
│   ├── backtest/      # portfolio sim with delay pricing and costs
│   └── baselines/     # B1–B5
├── reports/
└── tests/
```

Commands:
- `pnpm spike` → data source comparison note (R-D0)
- `pnpm backfill --from … --to …`
- `pnpm study` → Phase A report
- `pnpm sweep --ranking S1|S2|S3|S4 [--params …] [--grid …] [--label …]`
- `pnpm baselines [--seeds 20]`

---

## 11. Deliverables

1. Data spike note with sources, cost and coverage (project go/no-go).
2. Phase A report with the gate decision.
3. If the gate passes: Phase B sweep reports and baselines.
4. A final `report.md` in the same format as funding-harvester and funding-momentum.

---

## 12. Open questions

- Data budget for the backfill (decides history length and wallet cap).
- Confirm the go/no-go bar in 8.3 before Phase B.
- Whether to include the manual Fomo seed group, and how many addresses.
- Realistic delay for your setup: a self-hosted listener on a paid RPC/webhook is likely 1–5s end to end; this sets which delay is the headline result.
- Starting capital assumptions for sizing vs pool liquidity (small size makes liquidity caps rarely bind).

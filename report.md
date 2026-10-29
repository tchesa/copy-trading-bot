# shadow-wallets: Phase A report

**Verdict: NO-GO. Close the project; don't buy more Helius credits.** No wallet ranking produces a copy trade that is profitable after costs at a 5 s delay, at any follower size from 0.05 to 1 SOL. The leaders' own trades do carry an edge at their own prices (+3% to +9% mean), but a delayed copier can't keep it:
- **For the most profitable wallets (S1), the edge is speed.** A 5 s delay costs 24 points per trade.
- **For the slower, copyable wallets (S2, S4), rugs and fixed costs eat it.**

Headline, at the 5 s delay and 0.1 SOL per trade (wallet-clustered bootstrap 95% intervals; full table in section 3.4):

| Ranking | Trades | Median trade | Mean −top 1% | Leader alpha (mean) | What eats it |
|---|---|---|---|---|---|
| S1 raw PnL | 94 | −16.4% (−23.6 … −7.7) | −21.2% (−29.4 … −14.7) | +8.8% | delay −24.1% |
| S2 return on capital | 45 | −3.3% (−10.6 … −1.1) | −15.1% (−31.7 … +27.0) | +9.2% | rugs −9.7%, fees −2.0% |
| S4 consistency | 110 | −1.3% (−1.9 … −1.0) | −7.2% (−13.9 … +8.1) | +3.3% | rugs −3.2%, fees −1.4% |
| *B1 random eligible wallets* | | *−2.5%* | *−12.7%* | | |

None of these comes close to the §8.3 bar (≥ 30% OOS APR at ≥ 5 s, Sharpe ≥ 1, ≥ 67% of windows positive). Capacity is also too small to matter even if a trimmed mean turned positive. Leaders buy a median of 0.03 SOL, and following every sampled buy of a top-10 list would move a few hundredths of a SOL per week.

Read the numbers with section 5 in mind. They cover **8 of the planned 25 weekly steps** (the Helius plan's 1M credits ran out), and a cache-only replay had to drop 62% of the copied buys. Every check run on what remains points the same way.

---

## 1. Implementation

### Stack
- Node ≥ 22.13, ESM and TypeScript run from source with `tsx`. Storage is `node:sqlite` (WAL) at `data/shadow.sqlite`.
- Libraries: zod for config, `@noble/curves` for the on-curve check, vitest for tests (57 tests, including a lookahead test).
- Layout and conventions are in [CLAUDE.md](CLAUDE.md). Commands: `pnpm spike | backfill | study | sweep | baselines | size | check-data`.

### Data (Helius only)
- **One method does almost everything:** `getTransactionsForAddress` (full jsonParsed transactions, 10 credits per 100). It is used for wallet histories, the token-vault tape of a pool (prices, liquidity, crowding) and mint authority events. SOL/USD comes from Binance's free hourly data.
- **The data spike (R-D0) was GO, with a reduced design.** Every venue serves at least 400 days of history, including dead tokens. But the 11 DEX programs carry about 1–3M txs/day each, so a full tape is about 1.9M credits per day. Instead:
  - **Discovery** reads a random sample: 12 chunks of 100 txs per venue per day, 2,343 venue-days.
  - **Prices and liquidity** come from pool-vault pages, fetched only where a decision needs them, and cached.
- **One parser for every venue,** built from balance changes:
  - **Traders vs pools:** a trader is an on-curve owner; a pool is identified by its token-vault address.
  - **SOL:** summed per owner from lamport changes, so wrapped SOL and rent net out.
  - **Fixtures:** recorded mainnet transactions cover 9 venues.
- **Credits:** 1,000,217 used in total, after which Helius answered `429 max usage reached`.

| Kind | Credits |
|---|---|
| Discovery sample | 283k |
| Bot screen | 233k |
| Wallet histories | 220k |
| Pool tape pages | 226k |
| Marks | 29k |
| Mint data | 6k |

### Pipeline (per weekly step: formation 30 d, eval 7/14 d)
1. **Discovery and screening.** Wallets with ≥ 2 sampled trades on tokens with ≥ 500 SOL estimated volume are taken in seeded random order (the most active sampled wallets were almost all bots). A 1-page bot screen follows.
2. **Histories and exclusions.**
   - Wallets with ≥ 1,000 txs in 30 days are skipped.
   - The first 400 candidates that pass get full histories.
   - MEV, high-frequency, arbitrage and creator wallets are excluded.
   - The §4.3 eligibility filters apply, with ≥ 20 closed positions instead of 40.
3. **Rankings:** S1 raw PnL, S2 return on capital, S3 S2 ÷ crowding, S4 consistency.
4. **Persistence (H1):** each eligible wallet's own return on capital in the next 7 and 14 days.
5. **Replication (H2).** Up to 8 sampled buys per ranked wallet per week are copied at delays of 0, 1, 5, 15, 30, 60 and 300 s:
   - **Fill:** the first trade at or after t + delay.
   - **Slippage:** constant product on the pool's quote reserve.
   - **Costs:** venue fee plus base, priority and Jito fees.
   - **Exits:** mirror the leader's sells and transfers out, with a 48 h time stop.
   - **Rugs:** liquidity below 2 SOL at exit, or a honeypot.
   - **Attribution:** sums exactly to the return (alpha + delay + slippage + fees + rug loss).
6. **Phase B (`pnpm sweep`):** walk-forward portfolio simulation on the same records.

## 2. Data quality: what the audit found and fixed

The first interim run showed wallet ROCs of 20,000×. `pnpm check-data` audits the cached steps three ways:
- it logs every position above 100× with its raw stored amounts;
- it checks that the 0 s follower roughly matches the leader's own realized return on the same buys;
- it hand-checks rug trades against the leader's later transactions.

Each problem below was confirmed against raw transactions (public RPC) and is now covered by a test:

| Problem | Effect | Fix |
|---|---|---|
| Buys paid in USDT/USDC routed through SOL recorded only the SOL dust | 300 USDT recorded as 0.001 SOL; ROC in the tens of thousands | Parser takes the stablecoin leg; loader revalues a buy that paid > 2× under the pool price (0.7% of swaps). One-directional: tips and fixed fees stay a cost |
| Transfers out removed "remaining cost × moved ÷ holding" | Buy, sell 80%, transfer the rest out left a cost of about 0 | A transfer out is an exit at the market price at that time (the copier mirrors it too) |
| Marks: dust trades, Meteora launch-fee trades (priced up to 700× the market), the wrong pool, no liquidity limit | Open positions marked at tens of thousands of SOL | Mark = median of the last 5 non-dust pool trades, on the latest buy's pool, capped by what the pool can pay |
| Dust and crashed pools (a 40,000× crash in 7 minutes, bought into by a bot) | Micro wallets with 2,000% ROC on 0.009 SOL topped the deciles | Positions under 0.01 SOL, or with > 1,000× jumps between consecutive trades in one pool, are excluded from metrics |
| Formation-opened positions leaked into eval | A top-up in the eval window got credit for selling the whole bag | Episodes opened before the window are tracked but never reported |
| Wallets with no eval trades scored 0% | 0% "beats" a negative median; in 2 steps the whole top decile was inactive | Left out of persistence stats (51 wallet-weeks) |
| "No trade within 1 h = rug" | A quiet pool still quotes (one had 1,600 SOL in it); 0 s rugs were overstated 3.5× | A quiet exit is priced at the pool's state after its last trade; it's a rug only if liquidity is < 2 SOL |
| Missing tape was scored as a rug; percentiles were taken on unsorted data; rug losses were booked as slippage | Wrong rug counts and wrong winsorizing; S2's "7% slippage" was 3 rugs | Unreadable tape is `missing` and the buy is dropped at every delay; percentiles sort first; rugged legs book everything to rug loss |

After the fixes, the 0 s follower matches the leader to −0.8 points at the median (the follower's fees), and 0.6% of pairs differ by more than 50 points. All 10 rugs left at 0 s are genuine: the pool was drained below 2 SOL. Four positions remain above 100×, and all four are real early buys.

## 3. Results (8 weekly steps, 2026-03-28 → 2026-06-22)

### 3.1 Funnel per step
About 190k sampled swaps, about 21–22k qualifying tokens and about 65k sampled wallets per step. Screening about 2,100–2,500 wallets finds about 1,150–1,450 high-frequency bots and about 530–700 that are too active. 400 candidates get full histories, and **27–56 are eligible**. The biggest eligibility failures are median hold < 10 min, < 20 closed positions and inactivity.

### 3.2 Persistence (H1): weak, and not enough to pass G1

| Eval window | Top decile beats median eligible | Pooled Spearman | Median eval ROC, top decile | Median eval ROC, all eligible | Bottom decile |
|---|---|---|---|---|---|
| 7 days | 5/8 steps (63%; gate ≥ 67%) | 0.35 | −1.4% | −29.4% | −38.8% |
| 14 days | — | 0.41 | +1.2% | −45.8% | −66.9% |

Ranking by formation ROC does separate wallets: the deciles fall almost monotonically. But the best decile only breaks even. Most eligible "skilled" wallets lose a quarter to a half of their capital in the following weeks.

### 3.3 Replication (H2): the edge is speed, or it is eaten by rugs

At 1 SOL per trade (the spec's default size), mean contributions to the copier's return:

| Ranking | Delay | Median | Mean | Mean −top 1% | Hit | Rug rate | Alpha | Delay cost | Slippage | Fees | Rug loss |
|---|---|---|---|---|---|---|---|---|---|---|---|
| S1 | 0 s | −5.6% | +0.3% | −2.2% | 38% | 0.0% | +8.8% | 0 | −6.8% | −1.6% | 0 |
| S1 | 5 s | −18.9% | −21.8% | −23.0% | 15% | 2.1% | +8.8% | **−24.1%** | −4.4% | −1.3% | −0.8% |
| S1 | 15 s | −14.4% | −19.4% | −20.5% | 16% | 2.1% | +8.8% | −21.1% | −5.8% | −1.3% | 0 |
| S2 | 5 s | −3.0% | −3.5% | −15.6% | 29% | 15.6% | +9.2% | −0.5% | −1.5% | −1.1% | **−9.7%** |
| S4 | 5 s | −0.9% | −1.0% | −7.1% | 29% | 4.5% | +3.3% | +0.3% | −0.7% | −0.7% | **−3.2%** |
| B1 random | 5 s | −1.7% | | −12.6% | | | | | | | |

- **S1 is a speed game.** These wallets' buys are the first in a fast move. The pool price 5 s later is already about 24% higher, and the gap barely closes by 15 s or 60 s.
- **S2 and S4 wallets are slow enough to copy** (delay cost about 0). But their trades end in rugs often enough (16% and 5% of trades) to wipe out a modest edge.
- **S3 is identical to S2 here.** Crowding (≥ 2 other buyers within 30 s) was rare among eligible wallets, so dividing by crowding never changed the order.
- **G2 fails** (no method has a positive median and trimmed mean at ≥ 5 s). **G3 "passes"** only because S4 loses less than random wallets, which means nothing while G2 fails.

### 3.4 Follower-size sensitivity (`pnpm size`)
The copier is 1 SOL by default, about 30× the median leader buy (0.03 SOL; p75 1 SOL). Shrinking it is free on cached data:

| Ranking | Size (SOL) | Median at 5 s (95% CI) | Mean −top 1% at 5 s (95% CI) | Slippage | Fees | SOL / week |
|---|---|---|---|---|---|---|
| S2 | 0.05 | −3.4% (−10.7 … −1.8) | −15.9% (−31.8 … +21.9) | −0.1% | −2.9% | −0.011 |
| S2 | 0.10 | −3.3% (−10.6 … −1.1) | −15.1% (−31.7 … +27.0) | −0.2% | −2.0% | −0.018 |
| S2 | 0.25 | −3.2% (−10.6 … −0.6) | −14.8% (−31.8 … +25.9) | −0.4% | −1.4% | −0.039 |
| S2 | 1.00 | −3.0% (−11.4 … −0.4) | −15.6% (−32.0 … +22.3) | −1.5% | −1.1% | −0.199 |
| S4 | 0.05 | −1.9% (−3.2 … −1.4) | −7.9% (−14.1 … +5.1) | −0.0% | −2.2% | −0.013 |
| S4 | 0.10 | −1.3% (−1.9 … −1.0) | −7.2% (−13.9 … +8.1) | −0.1% | −1.4% | −0.015 |
| S4 | 0.25 | −0.9% (−1.5 … −0.7) | −6.8% (−13.5 … +8.2) | −0.2% | −1.0% | −0.026 |
| S4 | 1.00 | −0.9% (−1.5 … −0.5) | −7.1% (−13.4 … +6.9) | −0.7% | −0.7% | −0.141 |

- **Size isn't the lever.** Slippage is small at every size, since the median entry pool holds about 330 SOL.
- **Smaller trades trade slippage for fixed costs.** Priority, base and Jito fees are about 2–3% of a 0.05 SOL round trip.
- **The trimmed mean at 5 s is negative at every size.** The wide upper intervals come from a handful of trades in 45 (S2). The median intervals sit wholly below zero for both S2 and S4 at every size.
- **Even at 0 s, the best weekly result is +0.024 SOL** (S2 at 0.25 SOL), and 0 s isn't achievable.

### 3.5 Phase B and baselines
- **Phase B (walk-forward portfolio) had too little data.** Only buys with a stored price path and mint data qualify: 191 over 8 steps.
  - With 4 training weeks, the optimizer chose not to trade in 3 of 4 test weeks, because every configuration that traded lost money in training.
  - A fixed configuration (top 10, 0.1 SOL, no filters) made 1 trade (S2) and 9 trades (S4) in the 4 test weeks, at about −1.3% APR.
- **Baselines:**
  - **B1 (random eligible wallets):** reported throughout.
  - **B3 (hold SOL):** 0% in SOL terms.
  - **B4 (S1 top 1):** the S1 rows above.
  - **B5 (zero delay):** the 0 s rows.
  - **B2 (random tokens):** not run, because it needs new tape and the credits were gone.

## 4. Conclusions

1. **Wallet skill on Solana memecoins is mostly speed.** The wallets with the highest PnL buy first. Their trades are worth about +9% at their own prices and about −22% to someone 5 s behind. Copying them needs to be faster than they are, which makes it a sniping problem, not copy trading.
2. **The slower, copyable wallets carry no edge after costs.** S2 and S4 wallets can be followed at almost no delay cost. Their small edge (+3% to +9% at their own prices) goes to rugs and per-trade fixed costs, and smaller copy sizes only swap slippage for fees.
3. **Persistence exists only in relative terms.** Formation ROC ranks next-week ROC (Spearman about 0.35–0.41), but the top decile only breaks even while the median eligible wallet loses about 30%. Being "less bad than other memecoin traders" is not a strategy.
4. **Capacity rules it out even if the sign flipped.** Leaders buy about 0.03 SOL at the median, and a top-10 list produces tens of copyable buys a week. Any edge confined to 0.05–0.1 SOL trades adds up to a fraction of a SOL a week. That doesn't justify the infrastructure (a low-latency bot, RPC, Jito) or the rug exposure.
5. **Most of the work was data hygiene,** and that is reusable. Memecoin swap data is full of traps: routed stablecoin legs, launch fees inflating the pool price, dust pools, crashes, migrations and quiet pools. Without the audit, the first interim run would have reported wallets with 20,000× ROC.

### Caveats
- **8 of the planned 25 weekly steps** (Mar 28 – Jun 22, 2026). The Helius plan's monthly credits (about 1M) ran out first.
- **The cache-only replay dropped 62% of copied buys** (586 of 939). Their tape had not been fetched, because the data fixes changed which buys get sampled, and the replay can't fetch.
  - **Venue skew:** drops cluster in DAMM v2 (93%), DLMM (88%), CLMM (80%) and PumpSwap (71%); Raydium AMM is at 46%.
  - **Leader returns are close in both groups** (computed from the leader's own transactions): median −0.5% kept vs 0.0% dropped; trimmed mean −3.2% vs +0.5%; hit rate 37% vs 42%.
  - The kept sample is therefore mildly pessimistic, but not enough to flip a −7% to −15% trimmed mean at 5 s.
- **The replay also lost some top-ranked wallets' eval histories.** A coverage-deletion bug, now fixed, means S2/S3 top-1 has no eval data in several steps ("n/a" in the study report).
- **Deviations from the spec,** forced by cost or data:
  - sampled discovery instead of all swaps;
  - 400 candidates per step instead of 5,000;
  - wallets with ≥ 1,000 txs in 30 days skipped;
  - ≥ 20 closed positions instead of 40;
  - sampled leader buys (8 per ranked wallet per week);
  - no manual Fomo seed list;
  - the Token-2022 transfer fee taken from the current config;
  - Phase B stops evaluated on a sparse price path.
- **Optimistic in places:** the follower always lands its transaction (apart from a 5% failure rate in Phase B), and exits after a quiet hour fill at the prior state with no queueing.

### If this is revisited
Don't restart it as copy trading. The reusable parts are:
- the venue-agnostic swap parser;
- the vault-tape oracle (point-in-time price, liquidity and rug detection for dead tokens);
- the position builder with its data-quality rules;
- `pnpm check-data`.

A different question would justify new credits, for example measuring how often memecoin pools rug within 48 h by venue and launchpad. That only needs pool tapes, not wallet histories. To finish the remaining 17 weeks anyway, the estimate is about 1.5M credits, which needs a larger Helius plan than the current about 1M a month.

## 5. Reports and reproducing

| Report | What |
|---|---|
| `reports/2026-10-29T03-59-28-spike.md` | R-D0 data spike (GO, reduced design) |
| `reports/2026-10-29T18-35-37-study-final.md` | Phase A on the corrected data: funnel, persistence, replication, gates |
| `reports/2026-10-29T18-11-01-audit.md` | Data-quality audit: outliers, leader vs 0 s consistency, rug hand-check, dropped-buy bias |
| `reports/2026-10-29T18-33-57-size.md` | Follower-size sensitivity with bootstrap intervals |
| `reports/2026-10-29T18-34-58-sweep-fixed-S2.md`, `…-S4.md` | Phase B, fixed configuration |
| `reports/2026-10-29T16-23-51-study-interim.md` | First interim run, **before** the data fixes (kept for comparison; don't use its numbers) |

Everything above runs offline from `data/shadow.sqlite` and the step cache `data/steps/f6b5c3c746`:

```
pnpm study --steps 8 --report-only --offline
pnpm check-data
pnpm size --sizes 0.05,0.1,0.25,1 --delays 0,5,15,60
pnpm sweep --ranking S4 --train 4 --grid '{"followN":[10]}' --base-params '{"minLeaderBuySol":0,"fixedSol":0.1,"requireRevoked":false,"minEntryLiquiditySol":0}'
```

A fresh online run of all 25 steps would be `pnpm study` with credits available. It fetches only what isn't cached.

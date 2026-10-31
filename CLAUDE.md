# shadow-wallets

Research harness for `copy-trading-requirements.md`: do some Solana wallets show persistent skill (H1), can a delayed follower still profit after costs and rugs (H2), and does ranking beat random selection (H3)? On-chain data only (Helius). No live or paper trading.

State: **closed (NO-GO)**, see `report.md` (section 6: the copyability-score follow-up, also NO-GO against pre-registered gates; section 7: exploratory rule search with 30-day windows over every non-bot wallet, no rule copies profitably). Phase A on 8 of 25 weeks: copy trades lose after costs at every delay ≥ 5 s and every follower size; the Helius plan's credits are exhausted.

Active: **weekly forward paper-test of Fomo leaderboard wallets** (`pnpm weekly`, `src/forward/`, report `reports/fomo-forward.md`). Pre-registered in `src/forward/config.ts`; go/no-go after 6 complete forward weeks.

## Commands

- `pnpm spike` — R-D0 data-source note: venue activity, parse coverage per venue, dead-token history check, cost extrapolation.
- `pnpm backfill --from 2026-03-28 --to 2026-10-27 [--budget 3000000] [--per-day 12]` — SOL/USD hourly + discovery sample (12 random 100-tx chunks per venue per day). Resumable per venue-day.
- `pnpm study [--steps N] [--params JSON] [--eligibility JSON] [--costs JSON] [--offline] [--report-only] [--label]` — Phase A. Runs each weekly walk-forward step (discovery → screen → wallet histories → formation metrics → exclusions/eligibility → crowding → S1–S4 → eval-window persistence → replication of leader buys), caches each step to `data/steps/<hash>/step-NN.json`, then writes `reports/<ts>-study.md|json` with gates G1–G3.
- `pnpm sweep [--ranking S1..S4] [--delay 5] [--grid JSON] [--base-params JSON] [--quick] [--train 8] [--label]` — Phase B walk-forward at every delay, offline from cached steps. Prints a `SUMMARY` line.
- `pnpm baselines [--seeds 20] [--b2-seeds 5]` — B1–B5 and the §8.3 go/no-go table. B2 fetches tape for random tokens (online).
- `pnpm size [--sizes 0.05,0.1,0.25,1] [--delays 0,5,15,60] [--methods S1,S2,S4] [--boot 2000]` — follower-size sensitivity with wallet-clustered bootstrap intervals (offline).
- `pnpm check-data [--dir data/steps/<hash>] [--rugs 20]` — data-quality audit of cached steps (offline): positions above 100×, follower-at-0s vs leader consistency, hand-check of rug trades against the leader's later txs.
- `pnpm feasibility [--boot 2000]` — copyability spec (`docs/copyability-score-spec.md`) Stage 0 on cached steps (offline): leader return vs 5 s delay cost per wallet-week, quadrants, stop rule, SVG scatter.
- `pnpm coverage` — why cached replication fills were unreadable, per venue and leg (spec 5.5, offline).
- `pnpm score --estimate` — Stage 1 credit estimate (offline dry run). `pnpm score` (= `pnpm study --methods S2,S5,S6 --label copyability`) — Stage 1: C and I on formation data (tape fenced at F1), S5/S6, eval replication of ≤ 20 buys/wallet for S2, S5, S6 and the random pool, under a hard 1M-credit cap counted from `data/stage1/<hash>/meta.json`; refuses to pull with uncommitted changes (R-P1). `--report-only` re-reports. Config is pre-registered in `src/score/config.ts`: changing it after the pull makes results exploratory.
- `pnpm explore [--steps N] [--cap 6000000] [--report-only]` — exploratory (not pre-registered) selection-rule search, `src/explore/`: monthly steps, 30-day scoring and 30-day simulation windows, every non-bot candidate (≤ 800, histories ≤ 3000 txs) replicated (≤ 15 eval buys), cached to `data/explore/<hash>/`. Report: each ranking alone, feature → next-month Spearman, a grid of 14 rankings × 3456 filter combinations × top 5/10/25 searched on steps 0–2 and judged on holdout steps 3–5 vs random wallets of the same filter, a permutation null for the search, walk-forward rule choice.
- `pnpm weekly [--estimate] [--report-only] [--budget 500000] [--skip-snapshot] [--allow-dirty]` — forward paper-test of Fomo leaderboard wallets (`src/forward/`). Each run: resolves the newest snapshot's traders to wallets (Fomo trade → on-chain swap matching, cached by handle in `data/fomo/wallets.json`; ≤ 1 matching trade or a tie = weak), skips bots (> 50k txs in the week before the snapshot), replicates the previous snapshot's wallets' buys made between the two snapshots once their 48 h time stop has passed (open ones wait for the next run), runs the random-wallet baseline for complete weeks, and rewrites `reports/fomo-forward.md|json` (per week, cumulative, go/no-go status). Incremental and idempotent: state per snapshot in `data/fomo/forward/weeks/<date>.json`, every decision frozen once made; buys in a fixed-seed random order so a budget-cut week is a uniform sample. `--estimate` prints expected credits without fetching. Refuses to pull with uncommitted changes in `src/` or `package.json` (pre-registration).
- Cache-only replay (no credits): `pnpm study --steps N --budget <credits already used>` — every real fetch throws `BudgetExceeded`; wallets that would need one are skipped (`unfetched`), unreadable tape is `missing` (never a rug) and those records are dropped at load.
- `pnpm typecheck`, `pnpm test`.

Env (`.env`): `HELIUS_API_KEY` (required), `HELIUS_RPS` (default 10; ~8 is sustainable for `getTransactionsForAddress`), `DOWNLOAD_CONCURRENCY`, `DB_PATH`, `LOG_LEVEL`. Never print the key; `redact()` strips it from logged URLs.

## Layout

- `src/data/` — `helius.ts` (client + persistent credit meter + hard budget), `http.ts` (adaptive limiter, retries), `parse/` (venue-agnostic swap parser, pool state), `sample.ts` (discovery), `walletHistory.ts` (bot screen + history), `oracle.ts` (cached point-in-time tape: prices, liquidity, marks), `mints.ts` (point-in-time token state), `solusd.ts`, `programs.ts` (venue program ids, quote mints).
- `src/db/db.ts` — node:sqlite schema (`swaps`, `discovery`, `pool_states`, `fetch_progress`, `credit_log`, `mints`, `sol_usd`).
- `src/wallets/` — positions, metrics, exclusions, eligibility, crowding, trade loader.
- `src/ranking/rank.ts` — S1–S4. `src/score/` — copyability spec: C (`copyability.ts`, formation replication with leader-exit fills, lookahead `fence`), I (`impact.ts`), pre-registered `config.ts`. `src/research/stage1*.ts` — Stage 1 runner and report; `feasibility.ts` — Stage 0. `src/explore/` — exploratory rule search (config, universe step, rule grid, report).
- `src/forward/` — weekly forward test: `config.ts` (pre-registered settings and go/no-go), `snapshot.ts` (hand-saved snapshots, Fomo trade-line parser), `match.ts` (trade → wallet), `select.ts` (pure: week buys, closed rule, fixed-seed order, no-lookahead guard), `run.ts` (incremental week state, baseline), `stats.ts` (summaries, wallet/token-clustered bootstrap, best-token removal, verdict), `report.ts`.
- `src/research/` — pipeline (per step), replication (`replicate.ts` collects fills; `follower.ts` simulates; pure), study report + gates.
- `src/strategy/` — Phase B params and entry filters (pure). `src/backtest/` — portfolio sim, metrics, walk-forward, sweep report. `src/baselines/` — B2. B1/B4/B5 live in `scripts/baselines.ts` on top of the walk-forward.
- `test/` — vitest; `test/fixtures/venues.json` holds one recorded mainnet tx per venue.

## Conventions

- Times are unix seconds (block time). Amounts in UI units; values in SOL (stable quotes converted at the last complete hour's SOL/USD).
- Pools are identified by the **token vault address** (unique per pool even when a program uses one shared authority, and queryable directly for the pool's tape).
- Traders are **on-curve** owners whose token holdings changed; pools/curves are off-curve (PDA) owners. SOL per owner is summed from lamports (wrapped SOL and rent net out); the fee payer gets the network fee added back.
- Everything fetched is cached (`fetch_progress`), so re-running costs nothing. Credits are logged per kind in `credit_log`; the budget is a hard stop (`BudgetExceeded`).
- No lookahead: decisions read only data before their time (`test/lookahead.test.ts`). Execution reads the tape at/after t + delay (that is the fill). Token authority state is replayed from events; without an event a token counts as not revoked.
- Commit only when asked.

## Weekly routine (forward test)

Every **Thursday** (matches the end of the Helius subscription period; `FORWARD.snapshotWeekday`, a snapshot on another day only warns).

1. Open fomo.family by hand (never scrape or fetch it from code: its terms forbid automated access), read the 30-day leaderboard and save it to `data/fomo/snapshots/<YYYY-MM-DD>.json`: `takenAt` with your UTC offset, then per trader `handle`, `rank` and either `wallet` or 2–4 Solana token trades (`mint` from the trade's token link, `text` = the trade line as shown). Template: `docs/fomo-snapshot-template.json` (CSV also accepted: see `src/forward/snapshot.ts`).
2. `pnpm weekly --estimate` (optional), then `pnpm weekly`. If the run stops at its budget, run it again (or with a larger `--budget`): it continues where it stopped.
3. Read `reports/fomo-forward.md`. A snapshot's week is scored once the next snapshot exists, and only buys whose 48 h time stop has passed: the next weekly run scores most of it, the one after that finishes it (the week is "complete").
- Never edit or delete a snapshot once its week has started (`takenAt` is checked against the week state). No buy before its selecting snapshot is ever replicated (`assertNoLookahead`, checked on every write and in the report).

## Data-quality rules (from the audit; keep them)

- Step cache key includes `PIPELINE_VERSION` (`scripts/context.ts`): bump it when step logic changes.
- Quote legs (`wallets/load.ts`), directional: a buy paying > 2× less (a sell receiving > 2× more) than the pool price — or the mint's nearest pool-priced trade within 30 min — is missing part of its payment and is revalued at that price (typical cause: paid in USDC/USDT routed through SOL; rent refunds on sells). The other direction is real cost (bot/Jito tips) and is kept; only the price is the pool's. The parser takes the stablecoin leg when it dominates.
- Wallet metrics ignore positions costing < 0.01 SOL (`MIN_POSITION_COST_SOL`) and positions with a > 1000× price jump between consecutive trades on one pool (`suspect`; crashed/dust pools). Persistence stats winsorize eval ROC at p5/p95 per step and leave out eligible wallets with no eval positions.
- Exits: a leg with no trade within 1h is priced at the pool's state before it (last trade, reserve after any LP change; `Oracle.priorState`), a rug only if that liquidity is below the floor. Trusted if the last trade is ≤ 10 min old, the tape covers the gap, or (online) a backward page is fetched; otherwise `missing`. Exits fill on the pool the leader sold on; the time stop on the last such pool.
- Prices never come from dust (< 0.01 SOL, `MIN_PRICE_TRADE_SOL`) or from trades without a pool price. Marks are the median of the last 5 such trades on the pool, and an open position's value is bounded by what the pool could pay (constant product on its quote reserve), on the pool of its latest buy.
- Transfers out are exits valued at the mark at that time (not cost removal). Copiers mirror them as exits. Positions opened before a window (formation) absorb their later trades and are never reported in it.
- Helius 429 `max usage reached` = plan quota exhausted → `QuotaExhausted` (not retried).

## Simulator semantics (keep these when changing it)

- Follower fill = first trade on the pool at or after the action time, at that trade's pool price; delay 0 uses the leader's own pool price (B5).
- Slippage: constant product on the pool's quote reserve (pump.fun curves include virtual reserves). Fees: all-in venue fee per side + base/priority fee per tx, contested entries (≥ 5 distinct buyers in 30s) pay a higher priority fee + Jito tip.
- Exits mirror leader sells and transfers out proportionally (fraction of holding at each), same delay; time stop at `maxHoldHours`. A transfer out has no leader price, so even at delay 0 it fills on the tape. Phase B adds stop loss / trailing stop on the sparse stored price path.
- Rug (−100% on the remaining position): pool quote reserve below `minExitLiquiditySol` at the exit (from the first trade at/after it, or the prior state if the pool is quiet), buy-only tape (honeypot), or a pool that never traded.
- Attribution sums exactly to the return: alpha (leader pool prices) + delay cost + slippage + fees + rug loss.

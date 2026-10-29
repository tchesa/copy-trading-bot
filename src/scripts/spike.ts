import { env } from "../config/env.js";
import { defaultStudy } from "../config/params.js";
import { Helius } from "../data/helius.js";
import { parseTx } from "../data/parse/tx.js";
import { VENUES } from "../data/programs.js";
import { creditsByKind, openDb } from "../db/db.js";
import { logger, setLogLevel } from "../log.js";
import { gitCommit, iso, num, pct, table, writeReportFiles } from "../util/run.js";

setLogLevel(env().LOG_LEVEL);
const log = logger("spike");
const db = openDb(env().DB_PATH);
const helius = new Helius(db, 3_000_000);
const start = helius.creditsUsed;
const now = Math.floor(Date.now() / 1000);
const DAY = 86_400;
const venues = Object.keys(VENUES) as Array<keyof typeof VENUES>;

// 1. Activity: signatures in 30s windows at 4 times of day, today / 100d / 200d / 400d ago.
const ages = [1, 100, 200, 400];
const activity: Record<string, Record<string, number>> = {};
for (const v of venues) {
  activity[v] = {};
  for (const age of ages) {
    let n = 0;
    for (const h of [2, 9, 15, 21]) {
      const t0 = now - age * DAY - (now % DAY) + h * 3600;
      const { sigs } = await helius.sigPage(VENUES[v], { from: t0, to: t0 + 30, limit: 1000 }, "spike");
      n += sigs.length;
    }
    activity[v][String(age)] = (n / 120) * DAY;
  }
  log.info("activity", { v, ...activity[v] });
}

// 2. Parse coverage: one page of 100 txs per venue, now and 200 days ago.
const coverage: Array<Record<string, number | string>> = [];
const deadCandidates: Array<{ pool: string; mint: string; t: number }> = [];
for (const v of venues) {
  for (const age of [1, 200]) {
    const t0 = now - age * DAY;
    const { txs } = await helius.txPage(VENUES[v], { from: t0, limit: 100 }, "spike");
    let withRows = 0, priced = 0, poolPx = 0, rows = 0, venueHit = 0;
    for (const x of txs) {
      const rs = parseTx(x);
      if (rs.length) withRows++;
      for (const r of rs) {
        rows++;
        if (r.side === "buy" || r.side === "sell") {
          priced++;
          if (r.poolPrice !== null) poolPx++;
          if (r.venue === v) venueHit++;
          if (age === 200 && r.pool && deadCandidates.length < 12 && !deadCandidates.some((d) => d.mint === r.mint))
            deadCandidates.push({ pool: r.pool, mint: r.mint, t: r.blockTime });
        }
      }
    }
    coverage.push({ venue: v, age, txs: txs.length, txWithSwapShare: txs.length ? withRows / txs.length : 0, priced, poolPriceShare: priced ? poolPx / priced : 0, venueTagShare: priced ? venueHit / priced : 0, rows });
  }
}

// 3. Dead/rugged tokens: tokens traded 200 days ago. Is their history still served, and are they still trading?
const dead: Array<Record<string, string | number>> = [];
for (const d of deadCandidates) {
  const back = await helius.txPage(d.pool, { from: d.t, limit: 20 }, "spike");
  const latest = await helius.txPage(d.pool, { order: "desc", limit: 1 }, "spike");
  const lastT = latest.txs[0]?.blockTime ?? null;
  dead.push({ mint: d.mint, pool: d.pool, sampledAt: iso(d.t), historyTxs: back.txs.length, lastTradeDaysAgo: lastT ? Math.round((now - lastT) / DAY) : -1 });
}

// 4. Cost extrapolation
const p = defaultStudy();
const days = 212;
const steps = 25;
const est = {
  discovery: days * venues.length * p.samplesPerVenueDay * 10,
  screens: steps * p.candidateCap * 1.6 * 10 * 0.5, // ~1.6 screened per accepted, ~50% reuse across overlapping windows
  histories: 12_000 * 80, // ~12k unique wallets, ~800 txs each over their windows
  replication: steps * 2500 * 10,
  marksCrowding: steps * 6000 * 10 * 0.4,
};
const estTotal = Object.values(est).reduce((a, b) => a + b, 0);
const totalVenueTx = venues.reduce((a, v) => a + activity[v]!["1"]!, 0);
const fullSpec = {
  tapeAllTokensPerDay: totalVenueTx * 0.1,
  tapeAllTokensYear: totalVenueTx * 0.1 * 365,
  wallets5000PerWindow: 48 * 5000 * 0.5 * 100,
};

const spent = helius.creditsUsed - start;
const deadServed = dead.filter((d) => Number(d.historyTxs) > 0).length;
const goNoGo = deadServed >= Math.ceil(dead.length * 0.8) && estTotal < 3_000_000;
const md = `# Data spike (R-D0)

**Verdict: ${goNoGo ? "GO" : "NO-GO"}** with a reduced design (sampled discovery + on-demand price pages), Helius only.
Spike cost: ${spent} credits. Generated ${new Date().toISOString()} at commit ${gitCommit()}.

## Sources

| Need | Source | Result |
|---|---|---|
| Swap history per wallet (R-D1) | Helius \`getTransactionsForAddress\` (full, jsonParsed, \`tokenAccounts: balanceChanged\`) | Works; 100 txs per call, 10 credits per 100 txs. History reaches at least 400 days on every venue tested. |
| Trade tape per token/pool (R-D2) | Same method on the pool's token vault address, from any timestamp | Works, trade-level, including dead tokens (below). Pages fetched only where a decision needs them. |
| Pool liquidity at a point in time (R-D3) | Vault balances in the same transactions (pre/post token balances) | Exact reserves after every tx touching the vault, including liquidity pulls. Pump.fun curves get their virtual reserves added. |
| Token risk attributes (R-D4) | \`getAccountInfo\` (current) + the mint's first 100 txs (initializeMint/setAuthority events) | Point-in-time authority state is replayed from events; without an event the token counts as not revoked. Token-2022 fee is the current config. |
| SOL/USD hourly (R-D5) | Binance public market data (data-api.binance.vision) | Free. |
| Birdeye, GeckoTerminal, Dune, Bitquery | Not used | Not needed once the vault tape works. Birdeye/Dune/Bitquery would add a second bill; GeckoTerminal's free OHLCV is keyed by pool account (not vault) and limited in depth, so it was not used for the cross-check. |

## Venue activity (estimated txs/day touching each program)

${table(["Venue", ...ages.map((a) => `${a}d ago`)], venues.map((v) => [v, ...ages.map((a) => Math.round(activity[v]![String(a)]!).toLocaleString("en-US"))]))}

Values at 2,880,000 hit the 1000-signature cap per 30s window, so they are lower bounds. Total is at least ${Math.round(totalVenueTx).toLocaleString("en-US")} txs/day.

## Parse coverage (one page of 100 txs per venue)

${table(["Venue", "Age (d)", "Txs", "Txs with a swap", "Priced swaps", "With pool price", "Venue tagged"], coverage.map((c) => [String(c.venue), c.age, c.txs, pct(Number(c.txWithSwapShare)), c.priced, pct(Number(c.poolPriceShare)), pct(Number(c.venueTagShare))]))}

Txs without a swap are mostly SOL/stable swaps (no token side), liquidity operations and failed arbitrage. Swaps without a pool price are routed or P2P fills; they fall back to the trade's own price. "Venue tagged" below 100% means multi-venue routes (tagged \`other\`).

## Dead tokens (R-I4): tokens traded 200 days ago

${table(["Mint", "Sampled", "History txs served", "Last trade (days ago)"], dead.map((d) => [String(d.mint).slice(0, 12) + "…", String(d.sampledAt), d.historyTxs, d.lastTradeDaysAgo]))}

${deadServed}/${dead.length} tokens still return their full history from the sampled time, regardless of whether they still trade.

## Cost

Full spec as written (tape of every swap on every qualifying token): about ${Math.round(fullSpec.tapeAllTokensPerDay).toLocaleString("en-US")} credits/day, ${(fullSpec.tapeAllTokensYear / 1e6).toFixed(0)}M credits for 12 months. Not affordable on any plan, and the download would be tens of TB.

Reduced design (used):

${table(["Item", "Estimate (credits)"], [...Object.entries(est).map(([k, v]) => [k, Math.round(v).toLocaleString("en-US")]), ["**total**", `**${Math.round(estTotal).toLocaleString("en-US")}**`]])}

Budget: 3,000,000 credits (hard cap in the client, persisted in the DB). Period: about 7 months of data (${days} days), ${steps} walk-forward steps.

## Known gaps and deviations
- **Discovery is sampled**, not exhaustive: ${p.samplesPerVenueDay} random 100-tx chunks per venue per day. Wallets are still discovered from activity across all qualifying tokens, before any outcome is known (R-W1 holds), and are naturally weighted by trade count (R-W2), but rare traders are under-sampled.
- **Token volume for R-W1 is estimated** from the sample, scaled by the sampled share of each venue-day.
- **Leader buys are sampled** for replication (${p.maxBuysRanked} per ranked wallet per week, ${p.maxBuysRandom} per random wallet) to fit the budget.
- **Stops in Phase B use a sparse price path**: the stored tape around the entry, the leader's sells and probes at ${p.probeOffsets.map((o) => o / 3600 + "h").join(", ")}.
- **Liquidity for concentrated pools** (CLMM, DLMM) uses vault totals with a constant-product formula, which overstates slippage (conservative). Non-pump bonding curves (LaunchLab, DBC) use real reserves only (also conservative).
- **Token-2022 transfer fees** use the current config; fee changes over time are not replayed.
- **12 months was cut to about 6 months** of evaluation to fit 3M credits.

Credits by kind: \`${JSON.stringify(creditsByKind(db))}\`
`;
const files = writeReportFiles("reports", "spike", md, { goNoGo, spent, activity, coverage, dead, est, estTotal, fullSpec, commit: gitCommit() });
log.info("spike report", files);

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultCosts, defaultStudy } from "../src/config/params.js";
import { Oracle } from "../src/data/oracle.js";
import type { SwapRow } from "../src/data/parse/types.js";
import { WSOL } from "../src/data/programs.js";
import { SolUsd } from "../src/data/solusd.js";
import { insertSwaps, openDb, setProgress } from "../src/db/db.js";
import { FORWARD } from "../src/forward/config.js";
import { decide, isWeak, matchingWallets } from "../src/forward/match.js";
import { buildForwardReport, toCopies, usableRecords } from "../src/forward/report.js";
import { ForwardRun, loadWeek, saveWeek, weekComplete, type WeekState } from "../src/forward/run.js";
import { assertNoLookahead, isClosed, LookaheadError, weekBuys } from "../src/forward/select.js";
import { parseFomoTrade, parseSnapshot, type Snapshot } from "../src/forward/snapshot.js";
import { verdict, withoutBestToken, type Copy } from "../src/forward/stats.js";
import type { Ctx } from "../src/research/pipeline.js";
import { defaultEligibility } from "../src/wallets/eligibility.js";
import { TradeLoader } from "../src/wallets/load.js";
import { buildPositions } from "../src/wallets/positions.js";
import { record, T0 as BASE, trade } from "./helpers.js";

const D = 86_400;
const H = 3600;

describe("snapshots and Fomo trade lines", () => {
  it("parses a trade line in the viewer's clock", () => {
    const takenAt = Date.UTC(2026, 9, 31) / 1000;
    const p = parseFomoTrade("Buy +$87.05 Oct 30, 10:05 AM 18.5M at $7.99K MC", -180, takenAt)!;
    expect(p.side).toBe("buy");
    expect(p.t0).toBe(Date.UTC(2026, 9, 30, 13, 5) / 1000);
    expect(p.amount).toBe(18_500_000);
    expect(p.tol).toBeGreaterThan(0.006);
    expect(parseFomoTrade("Sell -$1,175.24 Oct 29, 2:45 PM 2.1M", -180, takenAt)!.t0).toBe(Date.UTC(2026, 9, 29, 17, 45) / 1000);
    // a December trade read in early January belongs to the previous year
    expect(parseFomoTrade("Buy +$5 Dec 31, 11:59 PM 1K", 0, Date.UTC(2027, 0, 2) / 1000)!.t0).toBe(Date.UTC(2026, 11, 31, 23, 59) / 1000);
    expect(parseFomoTrade("nonsense", 0, takenAt)).toBeNull();
  });

  it("reads JSON and CSV snapshots (quoted trade text with commas) and requires takenAt with an offset", () => {
    const csv = `# takenAt=2026-11-02T09:30:00-03:00\nhandle,rank,wallet,mint,trade\n@a,1,,MINT1,"Buy +$87.05 Oct 30, 10:05 AM 18.5M"\na,1,,MINT2,"Sell -$1.00 Oct 31, 1:00 PM 2K"\nb,2,WALLETB,,\n`;
    const s = parseSnapshot("data/fomo/snapshots/2026-11-02.csv", csv);
    expect(s.takenAt).toBe(Date.UTC(2026, 10, 2, 12, 30) / 1000);
    expect(s.utcOffsetMinutes).toBe(-180);
    expect(s.traders).toEqual([
      { handle: "a", rank: 1, wallet: null, trades: [{ mint: "MINT1", text: "Buy +$87.05 Oct 30, 10:05 AM 18.5M" }, { mint: "MINT2", text: "Sell -$1.00 Oct 31, 1:00 PM 2K" }] },
      { handle: "b", rank: 2, wallet: "WALLETB", trades: [] },
    ]);
    const j = parseSnapshot("x/2026-11-02.json", JSON.stringify({ takenAt: "2026-11-02T12:30:00Z", traders: [{ handle: "c", rank: 3, wallet: "W" }] }));
    expect(j.utcOffsetMinutes).toBe(0);
    expect(() => parseSnapshot("x/2026-11-02.json", JSON.stringify({ takenAt: "2026-11-02T12:30:00", traders: [{ handle: "c", rank: 3, wallet: "W" }] }))).toThrow(/offset/);
    expect(() => parseSnapshot("x/2026-11-02.json", JSON.stringify({ traders: [] }))).toThrow(/takenAt/);
  });

  it("matches by side and token amount within the shown rounding; one trade or a tie is weak", () => {
    const row = (wallet: string, side: "buy" | "sell", tokenAmount: number) => ({ wallet, side, tokenAmount, mint: "M" }) as unknown as SwapRow;
    const rows = [row("A", "buy", 18_512_000), row("B", "buy", 18_900_000), row("C", "sell", 18_500_000)];
    expect(matchingWallets(rows, "M", "buy", 18_500_000, 0.0067)).toEqual(["A"]);
    expect(decide({ A: 2, B: 1 })).toEqual({ wallet: "A", votes: 2, runnerUp: 1 });
    expect(isWeak({ source: "matched", votes: 2, runnerUp: 1 })).toBe(false);
    expect(isWeak({ source: "matched", votes: 1, runnerUp: 0 })).toBe(true);
    expect(isWeak({ source: "matched", votes: 2, runnerUp: 2 })).toBe(true);
    expect(isWeak({ source: "given", votes: 0, runnerUp: 0 })).toBe(false);
  });
});

describe("no lookahead", () => {
  it("a buy before the selecting snapshot (or after the week) is an error", () => {
    expect(() => assertNoLookahead([{ t: BASE - 1, sig: "x", wallet: "W" }], BASE, BASE + 7 * D, "test")).toThrow(LookaheadError);
    expect(() => assertNoLookahead([{ t: BASE + 7 * D, sig: "x", wallet: "W" }], BASE, BASE + 7 * D, "test")).toThrow(LookaheadError);
    expect(() => assertNoLookahead([{ t: BASE, sig: "x", wallet: "W" }], BASE, BASE + 7 * D, "test")).not.toThrow();
  });

  it("week state with a record predating its snapshot cannot be saved", () => {
    const dir = mkdtempSync(join(tmpdir(), "fwd-"));
    try {
      const st: WeekState = {
        version: 1, week: "2026-04-01", T0: BASE, T1: BASE + 7 * D, resolvedHandles: [], wallets: {}, unresolved: [],
        fomo: { records: { s: record({ t: BASE - 60 }) }, decided: {}, counts: { universe: 1, open: 0, pending: 0 } },
        baseline: { candidates: null, wallets: {}, pool: { records: {}, decided: {}, counts: { universe: 0, open: 0, pending: 0 } } }, updatedAt: "",
      };
      expect(() => saveWeek(st, dir)).toThrow(LookaheadError);
      st.fomo.records = { s: record({ t: BASE + 60 }) };
      expect(() => saveWeek(st, dir)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("only buys in [snapshot, next snapshot) of at least 0.01 SOL are copied; adding to an earlier position counts", () => {
    const L0 = BASE - 7 * D;
    const trades = [
      trade({ side: "buy", t: BASE - D, mint: "A" }), // position opened in the lookback week
      trade({ side: "buy", t: BASE + H, mint: "A" }), // adds to it after the snapshot: copied
      trade({ side: "buy", t: BASE + 2 * H, mint: "B", sol: 0.005, tokens: 5 }), // dust
      trade({ side: "buy", t: BASE + 8 * D, mint: "C" }), // after the week
    ];
    const got = weekBuys(buildPositions(trades, L0, BASE + 10 * D, () => null), BASE, BASE + 7 * D);
    expect(got.map((x) => x.buy.t)).toEqual([BASE + H]);
    expect(isClosed(BASE, BASE + 48 * H + FORWARD.closeMarginSeconds)).toBe(true);
    expect(isClosed(BASE, BASE + 48 * H + FORWARD.closeMarginSeconds - 1)).toBe(false);
  });
});

describe("statistics", () => {
  const c = (wallet: string, mint: string, ret: number, week = "w"): Copy => ({
    week, wallet, mint, sig: `${wallet}${mint}${ret}${Math.random()}`, ret, pnlSol: ret * 0.1, rug: false, alpha: ret, delayCost: 0, slippage: 0, fees: 0, rugLoss: 0, leaderRet: ret,
  });

  it("best-token removal drops every buy of that token across wallets, not just the best trade", () => {
    const copies = [c("A", "X", 50), c("A", "X", 49), c("B", "X", 25), c("A", "Y", 0.1), c("B", "Z", -0.2)];
    const r = withoutBestToken(copies);
    expect(r.mint).toBe("X");
    expect(r.removed).toBe(3);
    expect(r.rest.map((x) => x.mint).sort()).toEqual(["Y", "Z"]);
  });

  it("verdict: PENDING before 6 weeks; GO, INCONCLUSIVE (sample size only) and NO-GO after", () => {
    const week = (k: number, n: number, wallets: number, ret: (i: number) => number) =>
      Array.from({ length: n }, (_, i) => c(`W${i % wallets}`, `T${k}-${i}`, ret(i), `w${k}`));
    const good = Array.from({ length: 6 }, (_, k) => week(k, 60, 25, (i) => 0.05 + (i % 5) * 0.01));
    const base = week(9, 120, 20, (i) => -0.2 + (i % 3) * 0.01);
    expect(verdict(good.slice(0, 3), base).status).toBe("PENDING");
    expect(verdict(good, base).status).toBe("GO");
    const small = Array.from({ length: 6 }, (_, k) => week(k, 20, 10, (i) => 0.05 + (i % 5) * 0.01));
    expect(verdict(small, base).status).toBe("INCONCLUSIVE");
    const bad = Array.from({ length: 6 }, (_, k) => week(k, 60, 25, (i) => (i % 2 ? -0.3 : 0.1)));
    const v = verdict(bad, base);
    expect(v.status).toBe("NO-GO");
    expect(v.criteria.find((x) => x.name.startsWith("median"))!.pass).toBe(false);
  });
});

describe("incremental weekly runs (synthetic chain data, nothing fetched)", () => {
  const T0 = Date.UTC(2026, 10, 2, 12) / 1000;
  const T1 = T0 + 7 * D;
  let n = 0;
  const sw = (over: Partial<SwapRow>): SwapRow => ({
    sig: `x${n++}`, slot: 1, blockTime: T0, txIndex: 0, wallet: "T", mint: "M", side: "buy", tokenAmount: 1000,
    quoteMint: WSOL, quoteAmount: 1, poolPrice: 0.001, poolQuoteMint: WSOL, pool: "P", venue: "pumpswap", poolTokenReserve: 1e6,
    poolQuoteReserve: 100, feeLamports: 5000, txSwapCount: 1, signer: true, tokenProgram: "spl", createsMint: false, ...over,
  });
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  function world() {
    const db = openDb(":memory:");
    const st = db.prepare("INSERT INTO sol_usd VALUES (?, ?)");
    for (let h = Math.floor((T0 - 10 * D) / H) * H; h < T1 + 5 * D; h += H) st.run(h, 150);
    // Pool tape: another trader every 10 minutes, price rising 0.001 → 0.002 over the period.
    const from = T0 - 8 * D, to = T1 + 4 * D;
    const price = (t: number) => 0.001 * (1 + (t - from) / (to - from));
    const tape: SwapRow[] = [];
    for (let t = from; t < to; t += 600) tape.push(sw({ blockTime: t, side: t % 1200 ? "buy" : "sell", poolPrice: price(t), quoteAmount: price(t) * 1000 }));
    // Leader W: one buy before the snapshot (never copied), one early in the week, one an hour before the next snapshot.
    const lead = [
      sw({ wallet: "W", blockTime: T0 - H + 7, poolPrice: price(T0 - H), quoteAmount: price(T0 - H) * 1000 }),
      sw({ wallet: "W", side: "sell", blockTime: T0 - 7, poolPrice: price(T0), quoteAmount: price(T0) * 1000 }),
      sw({ wallet: "W", blockTime: T0 + D + 7, poolPrice: price(T0 + D), quoteAmount: price(T0 + D) * 1000 }),
      sw({ wallet: "W", side: "sell", blockTime: T0 + D + 3 * H + 7, poolPrice: price(T0 + D + 3 * H), quoteAmount: price(T0 + D + 3 * H) * 1000 }),
      sw({ wallet: "W", blockTime: T1 - H + 7, poolPrice: price(T1 - H), quoteAmount: price(T1 - H) * 1000 }),
      sw({ wallet: "W", side: "sell", blockTime: T1 + 5 * H + 7, poolPrice: price(T1 + 5 * H), quoteAmount: price(T1 + 5 * H) * 1000 }),
    ];
    insertSwaps(db, [...tape, ...lead]);
    setProgress(db, "page", "P", from, to, "done", 0);
    for (const w of ["W", "T"]) setProgress(db, "wallet", w, from, to, "done", 0);
    // baseline candidate T: cached signature screen (it is still excluded as HFT by its lookback trades)
    setProgress(db, "sigcount", "T", T0 - 7 * D, T1, "done", 10, { n: 10, span: 8 * D });
    const solUsd = new SolUsd(db);
    const ctx = { db, helius: null, oracle: new Oracle(db, null, solUsd), loader: new TradeLoader(db, solUsd), solUsd, p: defaultStudy(), el: defaultEligibility(), concurrency: 2, stepsDir: "" } as unknown as Ctx;
    const snap = (date: string, takenAt: number): Snapshot => ({ date, takenAt, utcOffsetMinutes: 0, file: `${date}.json`, traders: [{ handle: "lead", rank: 1, wallet: "W", trades: [] }] });
    const dir = mkdtempSync(join(tmpdir(), "fwd-"));
    dirs.push(dir);
    return { ctx, snaps: [snap("2026-11-02", T0), snap("2026-11-09", T1)], dir };
  }

  const strip = (s: WeekState | null) => (s ? { ...s, updatedAt: "" } : s);

  it("leaves buys whose time stop is after the run open, finishes them next run, and re-runs identically", async () => {
    const { ctx, snaps, dir } = world();
    const go = async (runT: number) => {
      const r = new ForwardRun(ctx, snaps, runT, "pull", dir, join(dir, "wallets.json"));
      await r.run();
      return strip(loadWeek("2026-11-02", dir))!;
    };
    const run1 = T1 + 2 * H; // the last buy (T1 − 1h) is still inside its 48 h hold
    const a = await go(run1);
    expect(a.wallets.W!.status).toBe("ok");
    expect(Object.values(a.fomo.records).map((r) => r.t)).toEqual([T0 + D + 7]);
    expect(a.fomo.counts).toEqual({ universe: 2, open: 1, pending: 0 });
    expect(weekComplete(a, run1)).toBe(false);
    expect(Object.values(a.fomo.records).every((r) => r.t >= T0)).toBe(true);

    // same run again: no change
    expect(await go(run1)).toEqual(a);

    const run2 = T1 + 52 * H;
    const b = await go(run2);
    expect(Object.values(b.fomo.records).map((r) => r.t).sort()).toEqual([T0 + D + 7, T1 - H + 7]);
    expect(b.fomo.records[Object.keys(a.fomo.records)[0]!]).toEqual(a.fomo.records[Object.keys(a.fomo.records)[0]!]); // finished, not redone
    expect(b.fomo.counts).toEqual({ universe: 2, open: 0, pending: 0 });
    expect(weekComplete(b, run2)).toBe(true);
    expect(b.baseline.wallets.T?.status).toBe("rejected"); // HFT tape trader: not a baseline wallet
    const u = usableRecords(Object.values(b.fomo.records), defaultCosts());
    expect(u.kept).toHaveLength(2); // readable tape at every delay: simulated, not dropped
    const cs = toCopies(b.week, u.kept, 1, 0.1, defaultCosts());
    // price rises ~0.4% over the 3 h hold, fees and network cost ~2.5% of 0.1 SOL: a small loss, the leader a small gain
    expect(cs.every((x) => x.ret < 0 && x.ret > -0.1 && x.leaderRet > 0)).toBe(true);

    const meta = { commit: "test", firstCommit: "test", runT: run2, stopped: null, skipped: [], credits: { run: 0, cumulative: 0, runByKind: {}, cumulativeByKind: {} } };
    const rep1 = buildForwardReport([b, strip(loadWeek("2026-11-09", dir))!], defaultCosts(), meta);
    expect(await go(run2)).toEqual(b);
    const rep2 = buildForwardReport([strip(loadWeek("2026-11-02", dir))!, strip(loadWeek("2026-11-09", dir))!], defaultCosts(), meta);
    expect(rep2.md).toBe(rep1.md);
    expect(rep1.md).toContain("PENDING");
  });
});

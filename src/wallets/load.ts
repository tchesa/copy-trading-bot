import type { DatabaseSync, StatementSync } from "node:sqlite";
import { rowPrice, toSol } from "../data/oracle.js";
import type { Venue } from "../data/programs.js";
import type { SolUsd } from "../data/solusd.js";
import type { Trade } from "./types.js";

interface Row {
  sig: string; wallet: string; mint: string; slot: number; block_time: number; tx_index: number; side: string;
  token_amount: number; quote_mint: string | null; quote_amount: number; pool_price: number | null;
  pool_quote_mint: string | null; pool: string | null; venue: string; pool_quote_reserve: number | null;
  fee_lamports: number; tx_swap_count: number; creates_mint: number;
}

/**
 * A buy paying (sell receiving) more than this factor less (more) than the pool price is missing part of its quote
 * leg (e.g. paid in USDT routed through SOL, where only the SOL dust was attributed); it is revalued at the pool
 * price. Fees and slippage on these venues stay well inside 2×.
 */
export const QUOTE_REPAIR_FACTOR = 2;

export interface LoaderStats {
  priced: number;
  /** Own price disagreed with the pool by more than QUOTE_REPAIR_FACTOR; revalued at the pool price. */
  repaired: number;
  /** No pool price on the trade (pool absorbed < 50% of the tokens): checked against the mint's nearest priced trade. */
  checkedNearby: number;
  /** Neither the trade nor the mint's tape within REF_WINDOW has a pool price: left as stored. */
  unchecked: number;
}

/** How far (seconds, either side) to look on the mint's stored tape for a reference price. */
const REF_WINDOW = 1800;

export class TradeLoader {
  private readonly q: StatementSync;
  readonly stats: LoaderStats = { priced: 0, repaired: 0, checkedNearby: 0, unchecked: 0 };
  private readonly qRef: StatementSync;
  constructor(db: DatabaseSync, private readonly solUsd: SolUsd) {
    this.q = db.prepare(
      `SELECT * FROM swaps WHERE wallet = ? AND block_time >= ? AND block_time < ? ORDER BY block_time, tx_index`,
    );
    // Nearest trade on the same mint with a pool price (the market price at that moment, from either side).
    this.qRef = db.prepare(
      `SELECT pool_price, pool_quote_mint, block_time FROM swaps
       WHERE mint = ? AND block_time BETWEEN ? AND ? AND pool_price IS NOT NULL AND side IN ('buy','sell')
       ORDER BY ABS(block_time - ?) LIMIT 1`,
    );
  }

  convert(r: Row): Trade | null {
    let sol = 0;
    let quoteRepaired = false;
    const swap = r.side === "buy" || r.side === "sell";
    if (swap) {
      const s = toSol(r.quote_amount, r.quote_mint, r.block_time, this.solUsd);
      if (s === null) return null;
      sol = s;
    }
    let price = swap ? rowPrice(r, this.solUsd) : null;
    if (swap) {
      this.stats.priced++;
      let pool = r.pool_price === null ? null : toSol(r.pool_price, r.pool_quote_mint, r.block_time, this.solUsd);
      if (pool === null) {
        const ref = this.qRef.get(r.mint, r.block_time - REF_WINDOW, r.block_time + REF_WINDOW, r.block_time) as
          { pool_price: number; pool_quote_mint: string | null; block_time: number } | undefined;
        if (ref) {
          pool = toSol(ref.pool_price, ref.pool_quote_mint, ref.block_time, this.solUsd);
          this.stats.checkedNearby++;
        }
      }
      if (pool === null || !(pool > 0) || !(r.token_amount > 0)) this.stats.unchecked++;
      else {
        const own = sol / r.token_amount;
        // Directional: repair only a quote leg that is missing part of the payment — a buy that paid far less than
        // the pool price, or a sell that received far more (e.g. a token-account rent refund). The other direction
        // is real cost (bot/Jito tips, fixed fees on small trades) and stays in `sol`; only the price is the pool's.
        const missing = r.side === "buy" ? !(own > 0) || pool / own > QUOTE_REPAIR_FACTOR : own / pool > QUOTE_REPAIR_FACTOR;
        const extraCost = r.side === "buy" ? own / pool > QUOTE_REPAIR_FACTOR : own > 0 && pool / own > QUOTE_REPAIR_FACTOR;
        if (missing) {
          sol = r.token_amount * pool;
          quoteRepaired = true;
          this.stats.repaired++;
        }
        if (missing || extraCost) price = pool; // own price is not the market price either way
      }
    }
    return {
      sig: r.sig, t: r.block_time, slot: r.slot, txIndex: r.tx_index, wallet: r.wallet, mint: r.mint,
      side: r.side as Trade["side"], tokens: r.token_amount, sol, price, pool: r.pool, venue: r.venue as Venue,
      poolQuoteReserveSol: r.pool_quote_reserve === null ? null : toSol(r.pool_quote_reserve, r.pool_quote_mint, r.block_time, this.solUsd),
      feeSol: r.fee_lamports / 1e9, txSwapCount: r.tx_swap_count, createsMint: r.creates_mint === 1, quoteRepaired,
      raw: { quoteAmount: r.quote_amount, quoteMint: r.quote_mint, poolPrice: r.pool_price, poolQuoteMint: r.pool_quote_mint },
    };
  }

  /** Trades of a wallet in [from, to), stored data only. */
  load(wallet: string, from: number, to: number): Trade[] {
    return (this.q.all(wallet, from, to) as unknown as Row[]).map((r) => this.convert(r)).filter((t): t is Trade => t !== null);
  }
}

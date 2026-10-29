import type { Venue } from "../data/programs.js";

export interface Trade {
  sig: string;
  t: number;
  slot: number;
  txIndex: number;
  wallet: string;
  mint: string;
  side: "buy" | "sell" | "in" | "out";
  tokens: number;
  /** SOL paid (buy) or received (sell), network fee excluded; 0 for in/out. */
  sol: number;
  /** SOL per token from the pool's flows (or the trade itself). */
  price: number | null;
  pool: string | null;
  venue: Venue;
  poolQuoteReserveSol: number | null;
  feeSol: number;
  txSwapCount: number;
  createsMint: boolean;
  /** `sol` was revalued at the pool price because the stored quote leg was incomplete (see load.ts). */
  quoteRepaired?: boolean;
  /** Stored amounts, for audit logs. */
  raw?: { quoteAmount: number; quoteMint: string | null; poolPrice: number | null; poolQuoteMint: string | null };
}

export interface Position {
  wallet: string;
  mint: string;
  pool: string | null;
  venue: Venue;
  openT: number;
  closeT: number | null;
  costSol: number;
  proceedsSol: number;
  /** Tokens transferred out, valued at the position's last traded price (counts as an exit). */
  transferredOutSol: number;
  /** Pool the position is marked on: the pool of its latest buy. */
  markPool: string | null;
  /** Value of the remaining tokens at the window end (0 if closed or unpriced). */
  markSol: number;
  pnl: number;
  ret: number;
  holdSeconds: number;
  /** Tokens arrived by transfer during the position: PnL is not trustworthy. */
  tainted: boolean;
  /** Two consecutive trades of the position on the same pool differ in price by more than MAX_PRICE_JUMP×
   * (a crashed/dust pool or a bad parse): PnL is not trustworthy, excluded like a tainted position. */
  suspect: boolean;
  entryLiquiditySol: number | null;
  buys: Trade[];
  sells: Trade[];
  /** Transfers out during the position (exits we can see but not price from the wallet's own flows). */
  outs: Trade[];
}

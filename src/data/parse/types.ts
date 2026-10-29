import type { Venue } from "../programs.js";

/** jsonParsed transaction as returned by getTransactionsForAddress(transactionDetails: "full"). */
export interface RawTx {
  slot: number;
  blockTime: number | null;
  transactionIndex?: number;
  transaction: {
    signatures: string[];
    message: {
      accountKeys: Array<{ pubkey: string; signer: boolean; writable: boolean }>;
      instructions: Array<{ programId: string; parsed?: unknown }>;
    };
  };
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: RawTokenBalance[];
    postTokenBalances?: RawTokenBalance[];
    innerInstructions?: Array<{ instructions: Array<{ programId: string; parsed?: unknown }> }>;
  } | null;
}

export interface RawTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  programId?: string;
  uiTokenAmount: { amount: string; decimals: number };
}

/** buy/sell: token exchanged against SOL or a stable. in/out: token moved without a priced quote leg. */
export type Side = "buy" | "sell" | "in" | "out";

export interface SwapRow {
  sig: string;
  slot: number;
  blockTime: number;
  txIndex: number;
  wallet: string;
  mint: string;
  side: Side;
  /** Token amount, UI units, always positive. */
  tokenAmount: number;
  /** WSOL (native SOL included), USDC or USDT; null for in/out. */
  quoteMint: string | null;
  /** What the wallet paid (buy) or received (sell) in quote UI units, network fee excluded, always positive. */
  quoteAmount: number;
  /** Quote (in poolQuoteMint) per token implied by the pool's own flows (excludes the trader's tips and bot fees); null if no pool found. */
  poolPrice: number | null;
  /** Quote mint of poolPrice and poolQuoteReserve (may differ from quoteMint on routed swaps). */
  poolQuoteMint: string | null;
  pool: string | null;
  venue: Venue;
  /** Effective pool reserves after the tx (pump.fun curves include virtual reserves). */
  poolTokenReserve: number | null;
  poolQuoteReserve: number | null;
  /** Network fee in lamports, charged to this row only if the wallet paid the tx fee. */
  feeLamports: number;
  /** Number of buy/sell rows in the tx (MEV and bundling signal). */
  txSwapCount: number;
  signer: boolean;
  /** Token program of the mint: spl | 2022 */
  tokenProgram: "spl" | "2022";
  /** The tx also initialized this mint (the wallet is the token's creator/deployer). */
  createsMint: boolean;
}

/** Known swap venues by program id. Order matters only for display. */
export const VENUES = {
  pumpfun: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  pumpswap: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
  raydium_amm: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  raydium_cpmm: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
  raydium_clmm: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
  launchlab: "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj",
  meteora_dlmm: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
  meteora_damm1: "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB",
  meteora_damm2: "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG",
  meteora_dbc: "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN",
  orca: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
} as const;
export type Venue = keyof typeof VENUES | "other";

export const AGGREGATORS = {
  jupiter: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
} as const;

export const PROGRAM_TO_VENUE: ReadonlyMap<string, Venue> = new Map(
  Object.entries(VENUES).map(([v, p]) => [p, v as Venue]),
);

/** Launchpads that create tokens with mint and freeze authority already revoked. */
export const LAUNCHPADS: ReadonlySet<Venue> = new Set(["pumpfun", "launchlab", "meteora_dbc"]);

export const WSOL = "So11111111111111111111111111111111111111112";
export const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
export const USD1 = "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB";
export const STABLES: ReadonlySet<string> = new Set([USDC, USDT, USD1]);
/** Mints that are never the "token" side of a trade. */
export const QUOTE_MINTS: ReadonlySet<string> = new Set([WSOL, USDC, USDT, USD1]);
export const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/**
 * Pump.fun bonding curves price off virtual reserves: real SOL + 30 SOL, and
 * real tokens + 279.9M (initial virtual 1.073B vs real 793.1M).
 */
export const PUMP_VIRTUAL_SOL = 30;
export const PUMP_VIRTUAL_TOKENS = 279_900_000;

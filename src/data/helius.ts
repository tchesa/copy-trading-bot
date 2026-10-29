import type { DatabaseSync } from "node:sqlite";
import { env } from "../config/env.js";
import { creditsUsed, logCredits } from "../db/db.js";
import { logger } from "../log.js";
import { Limiter, postJson } from "./http.js";
import type { RawTx } from "./parse/types.js";

const log = logger("helius");

export class BudgetExceeded extends Error {
  constructor(used: number, budget: number) {
    super(`Helius credit budget reached: ${used} of ${budget} used`);
  }
}

export interface SigInfo {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown;
}

export interface GtfaOptions {
  from?: number; // unix seconds, inclusive
  to?: number; // unix seconds, exclusive
  order?: "asc" | "desc";
  limit?: number;
  status?: "succeeded" | "failed" | "any";
  /** Include txs that only touch the address's token accounts (needed for wallets). */
  tokenAccounts?: "none" | "balanceChanged" | "all";
  paginationToken?: string;
}

interface RpcResponse<T> {
  result?: T;
  error?: { code: number; message: string };
}

/**
 * Helius client with a persistent credit meter. Costs follow Helius's published metering:
 * getTransactionsForAddress full = 10 credits per 100 returned txs (min 10), signatures = 10 flat,
 * other RPC = 1, DAS = 10.
 */
export class Helius {
  private readonly url: string;
  private readonly limiter: Limiter;
  private used: number;

  constructor(
    private readonly db: DatabaseSync,
    readonly budget: number,
    rps = env().HELIUS_RPS,
  ) {
    this.url = `https://mainnet.helius-rpc.com/?api-key=${env().HELIUS_API_KEY}`;
    this.limiter = new Limiter(rps);
    this.used = creditsUsed(db);
  }

  get creditsUsed(): number {
    return this.used;
  }

  get remaining(): number {
    return this.budget - this.used;
  }

  private charge(kind: string, credits: number): void {
    this.used += credits;
    logCredits(this.db, kind, credits);
  }

  private guard(worstCase: number): void {
    if (this.used + worstCase > this.budget) throw new BudgetExceeded(this.used, this.budget);
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await postJson<RpcResponse<T>>(this.url, { jsonrpc: "2.0", id: 1, method, params }, this.limiter);
      if (res.error) {
        // -32429 / rate limit style errors arrive as JSON-RPC errors on some paths
        if (attempt < 5 && /rate|limit|timeout|unavailable/i.test(res.error.message)) {
          await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
          continue;
        }
        throw new Error(`${method}: ${res.error.code} ${res.error.message}`);
      }
      return res.result as T;
    }
  }

  private filters(o: GtfaOptions) {
    const f: Record<string, unknown> = { status: o.status ?? "succeeded" };
    if (o.from !== undefined || o.to !== undefined) {
      const bt: Record<string, number> = {};
      if (o.from !== undefined) bt.gte = o.from;
      if (o.to !== undefined) bt.lt = o.to;
      f.blockTime = bt;
    }
    if (o.tokenAccounts) f.tokenAccounts = o.tokenAccounts;
    return f;
  }

  /** One page of full transactions (max 100). */
  async txPage(address: string, o: GtfaOptions, kind: string): Promise<{ txs: RawTx[]; next: string | null }> {
    const limit = Math.min(o.limit ?? 100, 100);
    this.guard(10);
    const cfg: Record<string, unknown> = {
      transactionDetails: "full",
      sortOrder: o.order ?? "asc",
      limit,
      encoding: "jsonParsed",
      maxSupportedTransactionVersion: 1,
      filters: this.filters(o),
    };
    if (o.paginationToken) cfg.paginationToken = o.paginationToken;
    const r = await this.rpc<{ data: RawTx[]; paginationToken: string | null }>("getTransactionsForAddress", [address, cfg]);
    const n = r?.data?.length ?? 0;
    this.charge(kind, Math.max(10, 10 * Math.ceil(n / 100)));
    return { txs: r?.data ?? [], next: r?.paginationToken ?? null };
  }

  /** One page of signatures (max 1000), 10 credits flat. */
  async sigPage(address: string, o: GtfaOptions, kind: string): Promise<{ sigs: SigInfo[]; next: string | null }> {
    this.guard(10);
    const cfg: Record<string, unknown> = {
      transactionDetails: "signatures",
      sortOrder: o.order ?? "asc",
      limit: Math.min(o.limit ?? 1000, 1000),
      filters: this.filters(o),
    };
    if (o.paginationToken) cfg.paginationToken = o.paginationToken;
    const r = await this.rpc<{ data: SigInfo[]; paginationToken: string | null }>("getTransactionsForAddress", [address, cfg]);
    this.charge(kind, 10);
    return { sigs: r?.data ?? [], next: r?.paginationToken ?? null };
  }

  async accountInfo(address: string, kind: string): Promise<unknown> {
    this.guard(1);
    const r = await this.rpc<{ value: unknown }>("getAccountInfo", [address, { encoding: "jsonParsed" }]);
    this.charge(kind, 1);
    return r?.value ?? null;
  }

  async multipleAccounts(addresses: string[], kind: string): Promise<unknown[]> {
    this.guard(1);
    const r = await this.rpc<{ value: unknown[] }>("getMultipleAccounts", [addresses, { encoding: "jsonParsed" }]);
    this.charge(kind, 1);
    return r?.value ?? [];
  }

  logStatus(): void {
    log.info("credits", { used: this.used, budget: this.budget });
  }
}

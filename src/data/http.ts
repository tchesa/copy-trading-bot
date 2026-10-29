import { logger } from "../log.js";

const log = logger("http");
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_RETRIES = 6;

/**
 * Spaces requests out to at most `perSecond` per instance (shared by all callers). Adaptive: every 429 widens
 * the spacing, every success narrows it back toward the configured rate.
 */
export class Limiter {
  private next = 0;
  private readonly base: number;
  private interval: number;
  constructor(perSecond: number) {
    this.base = 1000 / perSecond;
    this.interval = this.base;
  }
  async take(): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + this.interval;
    if (at > now) await sleep(at - now);
  }
  backoff(): void {
    this.interval = Math.min(this.interval * 1.3, 2000);
  }
  ok(): void {
    this.interval = Math.max(this.base, this.interval * 0.995);
  }
  get rate(): number {
    return 1000 / this.interval;
  }
}

/** Strip secrets (api-key query params) before logging a URL. */
export function redact(url: string): string {
  return url.replace(/(api[-_]?key=)[^&]+/gi, "$1***").slice(0, 160);
}

/** The provider's plan quota is exhausted (HTTP 429 "max usage reached"); retrying cannot help. */
export class QuotaExhausted extends Error {
  constructor(url: string) {
    super(`provider quota exhausted (max usage reached): ${url}`);
  }
}

/** Fetch with retry on network errors, 429 and 5xx. Returns null on 404. */
export async function fetchWithRetry(url: string, limiter?: Limiter, init?: RequestInit): Promise<Response | null> {
  for (let attempt = 0; ; attempt++) {
    await limiter?.take();
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
    } catch (e) {
      if (attempt >= MAX_RETRIES) throw e;
      const wait = 1000 * 2 ** attempt;
      log.warn("network error, retrying", { url: redact(url), attempt, wait, error: (e as Error).message });
      await sleep(wait);
      continue;
    }
    if (res.status === 404) return null;
    if (res.status === 429) {
      // Rate limited: never fatal, except when the provider says the plan's quota is used up.
      const body = await res.text().catch(() => "");
      if (/max usage reached/i.test(body)) throw new QuotaExhausted(redact(url));
      limiter?.backoff();
      const wait = Math.min(30_000, Math.max(Number(res.headers.get("retry-after") ?? 0) * 1000, 500 * 2 ** Math.min(attempt, 6)));
      if (attempt % 5 === 4) log.warn("rate limited", { url: redact(url), attempt, wait, rate: limiter?.rate });
      await sleep(wait);
      continue;
    }
    if (res.status >= 500) {
      if (attempt >= MAX_RETRIES) throw new Error(`${init?.method ?? "GET"} ${redact(url)} -> ${res.status}`);
      const wait = Math.max(Number(res.headers.get("retry-after") ?? 0) * 1000, 1000 * 2 ** attempt);
      log.warn("retrying", { url: redact(url), status: res.status, wait });
      await res.body?.cancel();
      await sleep(wait);
      continue;
    }
    if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${redact(url)} -> ${res.status} ${(await res.text().catch(() => "")).slice(0, 300)}`);
    limiter?.ok();
    return res;
  }
}

/** Fetch and parse JSON, retrying when the connection drops while the body is being read. */
async function fetchJson<T>(url: string, limiter: Limiter | undefined, init: RequestInit | undefined): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchWithRetry(url, limiter, init);
    if (!res) throw new Error(`${init?.method ?? "GET"} ${redact(url)} -> 404`);
    try {
      return (await res.json()) as T;
    } catch (e) {
      if (attempt >= MAX_RETRIES) throw e;
      log.warn("body read failed, retrying", { url: redact(url), attempt, error: (e as Error).message });
      await sleep(1000 * 2 ** attempt);
    }
  }
}

export async function getJson<T>(url: string, limiter?: Limiter): Promise<T> {
  return fetchJson<T>(url, limiter, undefined);
}

export async function postJson<T>(url: string, body: unknown, limiter?: Limiter): Promise<T> {
  return fetchJson<T>(url, limiter, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

export function qs(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
  return q.toString();
}

/** Run `fn` over items with bounded concurrency. */
export async function pool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++]!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

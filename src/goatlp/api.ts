// Client of api.cashmere.exchange for the Goat LP tools. A careful client of a shared service:
//  - it says who it is: `User-Agent: cashmere-agent-sdk/<package version>`;
//  - it keeps each response for its Cache-Control max-age and revalidates with If-None-Match / ETag;
//  - it sends one request at a time per rate-limit zone, and stays under each zone's per-minute budget;
//  - on 429 it waits the Retry-After once, then gives up with a clear message;
//  - it never asks for huge pages (the callers pass small limits).
// Path parts are checked before a URL is built: no unchecked input reaches a URL.
import { readFileSync } from 'fs';
import { join } from 'path';
import { GOAT_API_BASE } from './constants';

const { version: PACKAGE_VERSION } = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version: string };
export const USER_AGENT = `cashmere-agent-sdk/${PACKAGE_VERSION}`;

/** Per-IP request budgets per minute of api.cashmere.exchange */
export const ZONE_LIMITS = {
  discover: 6,
  'stock-pools': 30,
  'token-pools': 20,
  account: 30,
  'account-lifetime': 10,
  position: 20,
  history: 20,
  'keeper-write': 12,
  other: 120,
} as const;
export type Zone = keyof typeof ZONE_LIMITS;

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  status: number; ok: boolean; headers: { get(name: string): string | null }; text(): Promise<string>;
}>;

export class GoatApiError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfterSec: number | null = null) {
    super(message);
    this.name = 'GoatApiError';
  }
}

export interface GoatApiOptions {
  baseUrl?: string;
  fetch?: FetchLike;
  /** milliseconds since the epoch; tests move it */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  /** the longest Retry-After the client waits once; a longer one gives up at once */
  maxRetryAfterMs?: number;
  /** the longest the client waits for room in a zone's budget before it refuses */
  maxBudgetWaitMs?: number;
}

interface CacheEntry { body: unknown; etag: string | null; expiresAt: number }

const MAX_CACHE = 200;

/** max-age of a Cache-Control header in seconds; null for no-store / no-cache / private or no max-age */
export function maxAgeOf(cacheControl: string | null): number | null {
  if (!cacheControl) return null;
  const v = cacheControl.toLowerCase();
  if (/\bno-store\b|\bno-cache\b/.test(v)) return null;
  const m = /\bmax-age=(\d+)/.exec(v);
  return m ? Number(m[1]) : null;
}

/** Retry-After in seconds (delta seconds or an HTTP date); null when missing or unreadable */
export function retryAfterSec(value: string | null, nowMs: number): number | null {
  if (!value) return null;
  const s = value.trim();
  if (/^\d+$/.test(s)) return Number(s);
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.max(0, Math.ceil((t - nowMs) / 1000)) : null;
}

export class GoatApi {
  readonly base: string;
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly maxRetryAfterMs: number;
  private readonly maxBudgetWaitMs: number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly lanes = new Map<Zone, Promise<unknown>>();
  private readonly sent = new Map<Zone, number[]>();

  constructor(o: GoatApiOptions = {}) {
    this.base = (o.baseUrl ?? GOAT_API_BASE).replace(/\/+$/, '');
    this.fetchFn = o.fetch ?? ((url, init) => fetch(url, init) as never);
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.timeoutMs = o.timeoutMs ?? 15_000;
    this.maxRetryAfterMs = o.maxRetryAfterMs ?? 60_000;
    this.maxBudgetWaitMs = o.maxBudgetWaitMs ?? 5_000;
  }

  /** GET a JSON body (cached by max-age, revalidated by ETag) */
  get<T>(path: string, zone: Zone): Promise<T> {
    return this.lane(zone, () => this.getNow<T>(path, zone));
  }

  /** A write request (never cached); the body is JSON */
  send<T>(method: 'POST' | 'DELETE', path: string, zone: Zone, body?: unknown): Promise<T> {
    return this.lane(zone, async () => {
      const r = await this.request(method, path, zone, {}, body === undefined ? undefined : JSON.stringify(body));
      const text = await r.text();
      return (text ? JSON.parse(text) : null) as T;
    });
  }

  /** One request at a time per zone: calls of a zone wait for the one before them */
  private lane<T>(zone: Zone, work: () => Promise<T>): Promise<T> {
    const before = this.lanes.get(zone) ?? Promise.resolve();
    const next = before.then(work, work);
    this.lanes.set(zone, next.catch(() => undefined));
    return next;
  }

  private async getNow<T>(path: string, zone: Zone): Promise<T> {
    const key = path;
    const hit = this.cache.get(key);
    if (hit && this.now() < hit.expiresAt) return hit.body as T;
    const headers: Record<string, string> = hit?.etag ? { 'if-none-match': hit.etag } : {};
    const r = await this.request('GET', path, zone, headers);
    const age = maxAgeOf(r.headers.get('cache-control'));
    if (r.status === 304 && hit) {
      hit.expiresAt = this.now() + (age ?? 0) * 1000;
      return hit.body as T;
    }
    const text = await r.text();
    let body: unknown;
    try { body = JSON.parse(text); } catch { throw new GoatApiError(`api.cashmere.exchange answered ${path.split('?')[0]} with something that is not JSON.`, r.status); }
    const etag = r.headers.get('etag');
    if (age !== null || etag) this.remember(key, { body, etag, expiresAt: this.now() + (age ?? 0) * 1000 });
    else this.cache.delete(key);
    return body as T;
  }

  private remember(key: string, e: CacheEntry): void {
    this.cache.delete(key);
    this.cache.set(key, e);
    while (this.cache.size > MAX_CACHE) this.cache.delete(this.cache.keys().next().value as string);
  }

  /** Room in the zone's per-minute budget: waits a few seconds at most, else refuses */
  private async budget(zone: Zone): Promise<void> {
    const limit = ZONE_LIMITS[zone];
    const list = (this.sent.get(zone) ?? []).filter((t) => this.now() - t < 60_000);
    if (list.length >= limit) {
      const waitMs = 60_000 - (this.now() - list[0]) + 50;
      if (waitMs > this.maxBudgetWaitMs) {
        throw new GoatApiError(`Not sent: this server already made ${limit} requests to api.cashmere.exchange (${zone}) in the last minute, its limit per minute. Try again in ${Math.ceil(waitMs / 1000)} s.`, 429, Math.ceil(waitMs / 1000));
      }
      await this.sleep(waitMs);
    }
    const fresh = (this.sent.get(zone) ?? []).filter((t) => this.now() - t < 60_000);
    fresh.push(this.now());
    this.sent.set(zone, fresh);
  }

  private async request(method: string, path: string, zone: Zone, headers: Record<string, string>, body?: string) {
    const route = path.split('?')[0];
    for (let attempt = 0; ; attempt++) {
      await this.budget(zone);
      const h: Record<string, string> = { accept: 'application/json', 'user-agent': USER_AGENT, ...headers };
      if (body !== undefined) h['content-type'] = 'application/json';
      let r: Awaited<ReturnType<FetchLike>>;
      try {
        r = await this.fetchFn(`${this.base}${path}`, { method, headers: h, body, signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (err) {
        const timedOut = (err as Error)?.name === 'TimeoutError' || (err as Error)?.name === 'AbortError';
        throw new GoatApiError(timedOut ? `api.cashmere.exchange did not answer ${route} in time.` : `Could not reach api.cashmere.exchange (${route}).`, 0);
      }
      if (r.status === 429) {
        const wait = retryAfterSec(r.headers.get('retry-after'), this.now());
        const waitMs = (wait ?? 5) * 1000;
        if (attempt === 0 && waitMs <= this.maxRetryAfterMs) {
          await this.sleep(waitMs);
          continue;
        }
        throw new GoatApiError(`api.cashmere.exchange is limiting requests from this IP (${zone}, HTTP 429). Try again${wait !== null ? ` in ${wait} s` : ' later'}.`, 429, wait);
      }
      if (r.ok || r.status === 304) return r;
      let msg = `HTTP ${r.status}`;
      try {
        const b = JSON.parse(await r.text()) as { error?: unknown; message?: unknown };
        if (typeof b?.message === 'string' && b.message) msg = b.message;
        else if (typeof b?.error === 'string' && b.error) msg = b.error;
      } catch { /* the status is enough */ }
      throw new GoatApiError(`api.cashmere.exchange answered ${route} with ${msg}.`, r.status);
    }
  }
}

// ------------------------------------------------------------------ checked path parts

export type ApiVenue = 'uniswapv3' | 'uniswapv4';
export const apiVenue = (v: 'v3' | 'v4'): ApiVenue => (v === 'v4' ? 'uniswapv4' : 'uniswapv3');
export const venueOfApi = (e: string): 'v3' | 'v4' | null => (e === 'uniswapv4' ? 'v4' : e === 'uniswapv3' ? 'v3' : null);

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const POOL_ID_RE = /^0x[0-9a-fA-F]{64}$/;

/** v3 pools are 20-byte addresses, v4 pools 32-byte pool ids */
export function checkPoolId(venue: 'v3' | 'v4', pool: string): string {
  const p = pool.trim();
  if (venue === 'v4' ? !POOL_ID_RE.test(p) : !ADDR_RE.test(p)) {
    throw new Error(venue === 'v4' ? 'A Uniswap v4 pool is a 32-byte pool id (0x followed by 64 hex characters).' : 'A Uniswap v3 pool is a 20-byte address (0x followed by 40 hex characters).');
  }
  return p.toLowerCase();
}
export function checkAddress(a: string, what = 'address'): string {
  const s = a.trim();
  if (!ADDR_RE.test(s)) throw new Error(`The ${what} must be 0x followed by 40 hex characters.`);
  return s.toLowerCase();
}
export function checkNftId(id: string | number | bigint): string {
  const s = String(id).trim();
  if (!/^\d{1,20}$/.test(s)) throw new Error('A position id is a whole number.');
  return s;
}

/** Addresses the API never treats as accounts (every burned position belongs to the zero address) */
export const SENTINEL_OWNERS: readonly string[] = [
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
  '0xdead000000000000000042069420694206942069',
  '0x0000000000000000000000000000000000000001',
];

// ------------------------------------------------------------------ routes

export interface DiscoverQuery {
  sortBy: 'tvl' | 'volume' | 'apr' | 'fees-apr';
  limit: number;
  offset?: number;
  venue?: 'v3' | 'v4';
  period?: 'day' | 'week' | 'month';
}

export const routes = {
  discover: (q: DiscoverQuery) => {
    const s = new URLSearchParams({ period: q.period ?? 'day', 'sort-by': q.sortBy, 'sort-dir': 'desc', limit: String(Math.min(100, Math.max(1, Math.floor(q.limit)))), offset: String(Math.max(0, Math.floor(q.offset ?? 0))) });
    if (q.venue) s.set('exchanges', apiVenue(q.venue));
    return `/v2/discover-pools?${s}`;
  },
  tokenPools: (token: string, q: Omit<DiscoverQuery, 'venue'>) => {
    const s = new URLSearchParams({ period: q.period ?? 'day', 'sort-by': q.sortBy, 'sort-dir': 'desc', limit: String(Math.min(100, Math.max(1, Math.floor(q.limit)))), offset: String(Math.max(0, Math.floor(q.offset ?? 0))) });
    return `/v2/tokens/robinhood/${checkAddress(token, 'token address')}/pools?${s}`;
  },
  pool: (venue: 'v3' | 'v4', pool: string) => `/v2/pools/robinhood/${apiVenue(venue)}/${checkPoolId(venue, pool)}`,
  accountPositions: (owner: string, q: { scope: 'active' | 'lifetime'; limit: number; cursor?: string | null; venue?: 'v3' | 'v4' }) => {
    const a = checkAddress(owner, 'owner');
    if (SENTINEL_OWNERS.includes(a)) throw new Error('That address is a burn or reserved address, not an account: it has no positions of its own.');
    const s = new URLSearchParams({ scope: q.scope, limit: String(Math.min(100, Math.max(1, Math.floor(q.limit)))) });
    if (q.cursor) {
      if (!/^[A-Za-z0-9_\-=.:]{1,200}$/.test(q.cursor)) throw new Error('The cursor is not one this tool returned.');
      s.set('cursor', q.cursor);
    }
    if (q.venue) s.set('exchanges', apiVenue(q.venue));
    return `/v2/positions/account/${a}?${s}`;
  },
  position: (venue: 'v3' | 'v4', id: string | number | bigint) => `/v2/positions/robinhood/${apiVenue(venue)}/${checkNftId(id)}`,
  cashFlows: (venue: 'v3' | 'v4', id: string | number | bigint) => `/v2/positions/robinhood/${apiVenue(venue)}/${checkNftId(id)}/cash-flows`,
  tokenPrices: (venue: 'v3' | 'v4', addresses: readonly string[]) => {
    const list = [...new Set(addresses.map((a) => checkAddress(a, 'token address')))].slice(0, 50);
    return `/v2/tokens/prices?${new URLSearchParams({ exchange: apiVenue(venue), addresses: list.join(',') })}`;
  },
  automationPolicy: () => '/v2/automation/policy',
  health: () => '/v2/health',
  automationStatus: () => '/automation/status',
  permits: () => '/automation/permits',
  permitsOf: (id: bigint) => `/automation/permits/${checkNftId(id)}`,
} as const;

/** The rate-limit zone of an account route: lifetime lists have the smaller budget */
export const accountZone = (scope: 'active' | 'lifetime'): Zone => (scope === 'lifetime' ? 'account-lifetime' : 'account');

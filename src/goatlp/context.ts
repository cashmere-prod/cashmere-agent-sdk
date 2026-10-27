// What every Goat LP tool works with: the API client, the chain reader, the signer (write tools only), the clock, and a
// short cache of the chain environment (chain id, pins, contract state) for the read tools. The write tools always read
// the environment fresh.
import type { Address } from 'viem';
import { GoatApi, type FetchLike } from './api';
import { viemChain, viemSigner, type GoatChain, type GoatSigner } from './chain';
import { DEFAULT_ROBINHOOD_RPC_URL } from './constants';
import { loadEnv, type GoatEnv } from './facts';
import { SessionLog } from './permits';

/** Settings of the Goat LP tools (environment-only in the MCP server) */
export interface GoatLpSettings {
  /** Robinhood Chain RPC (https); default the public endpoint */
  rpcUrl?: string;
  /** largest USD value one goatlp_add_liquidity call may deposit */
  maxDepositUsd?: number;
  /** largest USD value the add-liquidity tool may deposit while the server runs */
  maxTotalUsd?: number;
}

/** Replaceable parts, for tests (no network in tests) */
export interface GoatLpDeps {
  api?: GoatApi;
  fetch?: FetchLike;
  chain?: GoatChain;
  signer?: GoatSigner | null;
  /** milliseconds since the epoch */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface GoatLpContext {
  api: GoatApi;
  chain: GoatChain;
  /** the configured wallet (null in read-only mode or without a key) */
  signer: GoatSigner | null;
  account: Address | null;
  settings: GoatLpSettings;
  now: () => number;
  nowSec: () => number;
  sleep: (ms: number) => Promise<void>;
  /** the chain environment; `fresh` skips the read cache */
  env(fresh?: boolean): Promise<GoatEnv>;
  /** sessions of signed messages this server made (no signature bytes) */
  sessions: SessionLog;
}

const ENV_TTL_MS = 60_000;

export function createGoatLpContext(o: { privateKey?: string | null; settings?: GoatLpSettings; deps?: GoatLpDeps }): GoatLpContext {
  const settings = o.settings ?? {};
  const deps = o.deps ?? {};
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const rpcUrl = settings.rpcUrl ?? DEFAULT_ROBINHOOD_RPC_URL;
  const api = deps.api ?? new GoatApi({ fetch: deps.fetch, now, sleep });
  const chain = deps.chain ?? viemChain(rpcUrl);
  const signer = deps.signer !== undefined ? deps.signer : o.privateKey ? viemSigner(o.privateKey, rpcUrl) : null;
  let cached: { at: number; env: Promise<GoatEnv> } | null = null;
  return {
    api, chain, signer, account: signer?.address ?? null, settings, now, sleep,
    nowSec: () => Math.floor(now() / 1000),
    env(fresh = false) {
      if (!fresh && cached && now() - cached.at < ENV_TTL_MS) return cached.env;
      const p = loadEnv(chain);
      cached = { at: now(), env: p };
      p.catch(() => { if (cached?.env === p) cached = null; });
      return p;
    },
    sessions: new SessionLog(),
  };
}

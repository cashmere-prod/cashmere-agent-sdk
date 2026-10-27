// Test kit of the Goat LP tests: a fake Robinhood Chain (answers by contract and function, no RPC), a fake fetch for
// api.cashmere.exchange (answers by path, records every request), the fixtures trimmed from real API answers, and a
// throwaway signer. No test reaches the network.
import { readFileSync } from 'fs';
import { join } from 'path';
import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, keccak256, toEventSelector, type Abi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { GoatChain, GoatSigner, McCall, McRes, TxLog, TxReceipt, TypedDataToSign } from '../chain';
import {
  AUTO_EXIT_V3, AUTO_RANGE_V3, GOAT_AUTO_COMPOUND_V3, GOAT_AUTO_COMPOUND_V4, GOAT_PAIR_TABLE, GOAT_PRICE_ANCHOR, GOAT_TREASURY,
  GOAT_V4_COMPOUNDOR, GOAT_V4_PAIR_REGISTRY, GOAT_V4_STEWARD, GOAT_V4_STEWARD_ENGINE, NPM, PINS, POSM,
} from '../constants';
import type { FetchLike } from '../api';
import {
  autoExitAbi as autoExitAbiK, autoRangeAbi as autoRangeAbiK, erc20Abi as erc20AbiK, gac3Abi as gac3AbiK, gac4Abi as gac4AbiK, npmAbi as npmAbiK,
  permit2Abi as permit2AbiK, posmAbi as posmAbiK, stewardAbi as stewardAbiK,
} from '../abis';
import { Actions, V4_PARAMS, decodeUnlockData } from '../lp/encode';
import { getSqrtRatioAtTick } from '../lp/tickMath';
import type { Spenders } from '../calldata';
import { TARGETS } from '../facts';
import type { GuardCtx } from '../guard';
import type { ContractGates, Kind, Venue } from '../types';
import type { PoolCtx } from '../validate';

export const fixture = <T = unknown>(name: string): T => JSON.parse(readFileSync(join(__dirname, name), 'utf8')) as T;

const lc = (s: string) => s.toLowerCase();
export const NOW_SEC = 1_793_092_400;
/** a throwaway key: the write tools only ever sign against the fake chain */
export const TEST_KEY = `0x${'ab'.repeat(32)}` as Hex;
export const TEST_ACCOUNT = privateKeyToAccount(TEST_KEY).address;
export const OTHER = '0x00000000000000000000000000000000000000aa' as Address;
export const FOREIGN_APP = '0x00000000000000000000000000000000000000bb' as Address;

type Handler = (args: readonly unknown[], call: McCall) => unknown;

/** A fake GoatChain. Unknown reads throw, so a test sees every read it did not expect. */
export class FakeChain implements GoatChain {
  id = 4663;
  time = NOW_SEC;
  codeHashes = new Map<string, Hex | null>();
  codes = new Map<string, Hex>();
  handlers = new Map<string, Handler>();
  reads: string[] = [];
  /** eth_call simulations: return data, or throw to revert */
  simulate: (tx: { from: Address; to: Address; data: Hex; value?: bigint }) => Hex = () => '0x';
  simulated: { from: Address; to: Address; data: Hex; value?: bigint }[] = [];
  receiptStatus: (hash: Hex) => 'success' | 'reverted' = () => 'success';
  /** logs of a receipt (by default none) */
  receiptLogs: (hash: Hex) => TxLog[] = () => [];
  /** ETH balances, by lower-case address */
  balances = new Map<string, bigint>();
  block = 1000n;

  constructor() {
    for (const p of Object.values(PINS)) this.codeHashes.set(lc(p.address), p.codehash);
    this.defaults();
  }

  on(address: string, fn: string, h: Handler | unknown): this {
    this.handlers.set(`${lc(address)}:${fn}`, typeof h === 'function' ? (h as Handler) : () => h);
    return this;
  }

  private defaults(): void {
    this.on(GOAT_V4_STEWARD, 'ENGINE', GOAT_V4_STEWARD_ENGINE).on(GOAT_V4_STEWARD, 'REGISTRY', GOAT_V4_PAIR_REGISTRY).on(GOAT_V4_STEWARD, 'POSM', POSM)
      .on(GOAT_AUTO_COMPOUND_V4, 'compoundor', GOAT_V4_COMPOUNDOR).on(GOAT_AUTO_COMPOUND_V4, 'positionManager', POSM)
      .on(GOAT_AUTO_COMPOUND_V3, 'priceAnchor', GOAT_PRICE_ANCHOR).on(GOAT_AUTO_COMPOUND_V3, 'nonfungiblePositionManager', NPM)
      .on(GOAT_V4_COMPOUNDOR, 'priceAnchor', GOAT_PRICE_ANCHOR)
      .on(AUTO_RANGE_V3, 'pairTable', GOAT_PAIR_TABLE).on(AUTO_EXIT_V3, 'pairTable', GOAT_PAIR_TABLE)
      // the position managers' own wiring
      .on(POSM, 'poolManager', '0x8366a39CC670B4001A1121B8F6A443A643e40951').on(NPM, 'factory', '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA');
    // contract state: nothing paused, live fees 10% / 0.15%, every fee recipient the treasury
    const tenPct = (1n << 64n) / 10n;
    const x64 = (bps: bigint) => (bps * (1n << 64n)) / 10_000n;
    this.on(GOAT_AUTO_COMPOUND_V3, 'paused', false).on(GOAT_AUTO_COMPOUND_V3, 'totalRewardX64', tenPct).on(GOAT_AUTO_COMPOUND_V3, 'feeRecipient', GOAT_TREASURY)
      .on(GOAT_AUTO_COMPOUND_V4, 'paused', false).on(GOAT_V4_COMPOUNDOR, 'totalRewardX64', tenPct).on(GOAT_V4_COMPOUNDOR, 'feeRecipient', GOAT_TREASURY)
      .on(GOAT_V4_STEWARD, 'pausedModes', 0).on(GOAT_V4_STEWARD, 'retired', false).on(GOAT_V4_STEWARD, 'feeBps', 15).on(GOAT_V4_STEWARD, 'feeRecipient', GOAT_TREASURY)
      .on(AUTO_RANGE_V3, 'paused', false).on(AUTO_RANGE_V3, 'rangeFeeX64', x64(15n)).on(AUTO_RANGE_V3, 'withdrawer', GOAT_TREASURY)
      .on(AUTO_EXIT_V3, 'paused', false).on(AUTO_EXIT_V3, 'exitFeeX64', x64(15n)).on(AUTO_EXIT_V3, 'withdrawer', GOAT_TREASURY);
  }

  private dispatch(c: McCall): unknown {
    const key = `${lc(c.address)}:${c.functionName}`;
    this.reads.push(key);
    const h = this.handlers.get(key);
    if (!h) throw new Error(`fake chain: no answer for ${c.functionName} at ${c.address}`);
    return h(c.args ?? [], c);
  }

  async chainId() { return this.id; }
  async getCode(a: Address) { return this.codes.get(lc(a)) ?? (this.codeHashes.get(lc(a)) ? '0x60' as Hex : undefined); }
  async codeHash(a: Address) { return this.codeHashes.has(lc(a)) ? this.codeHashes.get(lc(a))! : null; }
  async read<T>(c: McCall) { return this.dispatch(c) as T; }
  async multicall(calls: readonly McCall[]): Promise<McRes[]> {
    return calls.map((c) => { try { return { status: 'success' as const, result: this.dispatch(c) }; } catch (error) { return { status: 'failure' as const, error }; } });
  }
  async call(tx: { from: Address; to: Address; data: Hex; value?: bigint }) { this.simulated.push(tx); return this.simulate(tx); }
  async blockTimestamp() { return this.time; }
  async balance(a: Address) { return this.balances.get(lc(a)) ?? 0n; }
  async waitReceipt(hash: Hex): Promise<TxReceipt> { this.block += 1n; return { status: this.receiptStatus(hash), blockNumber: this.block, logs: this.receiptLogs(hash) }; }
}

/** Decode a call against an ABI (for asserting what the fake chain was asked) */
export const decodeCall = (abi: readonly unknown[], data: Hex) => decodeFunctionData({ abi: abi as Abi, data });

/** A recording signer: sent transactions and signed messages are kept; nothing leaves the process */
export class FakeSigner implements GoatSigner {
  readonly account = privateKeyToAccount(TEST_KEY);
  readonly address = this.account.address;
  sent: { to: Address; data: Hex; value: bigint }[] = [];
  signed: TypedDataToSign[] = [];
  onSend: (tx: { to: Address; data: Hex; value: bigint }) => void = () => {};
  async sendTransaction(tx: { to: Address; data: Hex; value: bigint }) {
    this.onSend(tx);
    this.sent.push(tx);
    return keccak256(`0x${(this.sent.length).toString(16).padStart(64, '0')}` as Hex);
  }
  async signTypedData(td: TypedDataToSign) {
    this.signed.push(td);
    return this.account.signTypedData(td as never);
  }
}

export interface FakeAnswer { status?: number; body?: unknown; headers?: Record<string, string | undefined> }

/** A fake fetch: answers by path (with the query), records every request */
export function fakeFetch(routes: Record<string, FakeAnswer | ((init: { method: string; headers: Record<string, string>; body?: string }) => FakeAnswer)>) {
  const requests: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
  const fetch: FetchLike = async (url, init) => {
    requests.push({ url, method: init.method, headers: init.headers, body: init.body });
    const path = url.replace(/^https:\/\/api\.cashmere\.exchange/, '');
    const r = routes[`${init.method} ${path}`] ?? routes[path] ?? routes[`${init.method} ${path.split('?')[0]}`] ?? routes[path.split('?')[0]];
    const a = typeof r === 'function' ? r(init) : r ?? { status: 404, body: { success: false, error: 'unknown route' } };
    const status = a.status ?? 200;
    const headers = new Map(Object.entries(a.headers ?? {}).filter(([, v]) => v !== undefined).map(([k, v]) => [k.toLowerCase(), v as string]));
    return {
      status, ok: status >= 200 && status < 300,
      headers: { get: (n: string) => headers.get(n.toLowerCase()) ?? null },
      text: async () => (a.body === undefined ? '' : typeof a.body === 'string' ? a.body : JSON.stringify(a.body)),
    };
  };
  return { fetch, requests };
}

// ------------------------------------------------------------------ decode-check contexts

/** a v4 and a v3 position of the tests (the v4 one is the real ETH/USDG position 4006316) */
export const P4 = { id: 4006316n, tickLower: -198960, tickUpper: -198650, tickSpacing: 10 };
export const P3 = { id: 1489972n, tickLower: -221280, tickUpper: -221100, tickSpacing: 60 };
export const RANGE_FEE_X64 = (15n * (1n << 64n)) / 10_000n;
export const SPENDERS: Spenders = {
  autoCompoundV3: GOAT_AUTO_COMPOUND_V3, autoCompoundV4: GOAT_AUTO_COMPOUND_V4, rangeExitV3: AUTO_RANGE_V3, exitV3: AUTO_EXIT_V3, rangeExitV4: GOAT_V4_STEWARD_ENGINE,
};
export const GATES_OK: ContractGates = {
  autoCompoundV3: { ok: true, reason: '' }, autoCompoundV4: { ok: true, reason: '' }, rangeExitV3: { ok: true, reason: '' }, exitV3: { ok: true, reason: '' }, rangeExitV4: { ok: true, reason: '' },
};
export const pool4: PoolCtx & { tickLower: number; tickUpper: number; swapAllowed: boolean } = {
  gate: 101, tickSpacing: 10, maxSlippageBps: 100, floorFeePips: 500, tickLower: P4.tickLower, tickUpper: P4.tickUpper, swapAllowed: true,
};
export const pool3: PoolCtx & { tickLower: number; tickUpper: number; swapAllowed: boolean } = {
  gate: 101, tickSpacing: 60, maxSlippageBps: 100, floorFeePips: 3000, tickLower: P3.tickLower, tickUpper: P3.tickUpper, swapAllowed: true,
};

export function ctx(kind: Kind, venue: Venue, over: Partial<GuardCtx> = {}): GuardCtx {
  const p = venue === 'v4' ? P4 : P3;
  return {
    chainId: 4663, account: TEST_ACCOUNT, tokenId: p.id, ownerOnChain: TEST_ACCOUNT, kind, venue, intent: 'turn-on', gates: GATES_OK,
    targets: TARGETS, spenders: SPENDERS, currentApproved: null, pool: venue === 'v4' ? pool4 : pool3,
    liveFees: { rangeFeeX64: RANGE_FEE_X64, exitFeeX64: RANGE_FEE_X64 },
    treasuryOk: { autoCompoundV3: true, autoCompoundV4: true, rangeExitV4: true, rangeExitV3: true, exitV3: true }, activeKinds: [], revokeAllowed: [], nowSec: NOW_SEC,
    ...over,
  };
}


// ------------------------------------------------------------------ a small Robinhood Chain world

export const API_OWNER = '0x4178b8f0469d5efee99fd07f0c3deff5ca2bb52f' as Address;
export const V4_POS = 4006316n;
export const V3_POS = 1489972n;
export const ETH_USDG_V4 = '0xbac3aa3b91584a53a579b3c999a56756e954e59247e497bad1d25a4334bde551' as Hex;
export const REVIEWED_HOOK = '0x06a889870c8f83640d6816319f72e2aa579b6080' as Address;
export const REVIEWED_HOOK_HASH = '0x0430617b26dfc5c3f6be1e1733304c6050c6b6ba9d0fb950b57070b5b2a96db4' as Hex;
export const AMZN = '0x12f190a9f9d7d37a250758b26824b97ce941bf54' as Address;
export const USDG_T = '0x5fc5360d0400a0fd4f2af552add042d716f1d168' as Address;
export const WETH_T = '0x0bd7d308f8e1639fab988df18a8011f41eacad73' as Address;
export const AMZN_USDG_V3 = '0x8ac92da74ab5f3b1d024dc1943ad7e15dc4179ef' as Address;
const ZERO = '0x0000000000000000000000000000000000000000' as Address;
const ZERO32 = `0x${'00'.repeat(32)}` as Hex;
const FEED = '0x00000000000000000000000000000000000000f1' as Address;

const s24 = (n: number) => BigInt(n < 0 ? n + 0x1000000 : n);
export const v4Info = (tickLower: number, tickUpper: number) => (s24(tickUpper) << 32n) | (s24(tickLower) << 8n);

export interface WorldState {
  owner: Map<string, Address>;
  approved: Map<string, Address>;
  gac3: Map<bigint, unknown[]>; gac3Owner: Map<bigint, Address>;
  gac4: Map<bigint, unknown[]>; gac4Owner: Map<bigint, Address>;
  ar: Map<bigint, unknown[]>; arOwner: Map<bigint, Address>;
  ae: Map<bigint, unknown[]>; aeOwner: Map<bigint, Address>;
  steward: Map<bigint, Record<string, number>>; stewardOwner: Map<bigint, Address>;
  /** POSM nonce bitmaps by `${owner}:${word}` */
  nonces: Map<string, bigint>;
  /** approvals for all positions by `${venue}:${owner}:${operator}` */
  forAll: Set<string>;
}

const GAC3_OFF_T = [false, false, 0, 0, 0, 0n, 0n];
const GAC4_OFF_T = [false, false, false, 0, 0, 0, 0n];
const AR_OFF_T = [0, 0, 0, 0, 0n, 0n, false, false, 0n];
const AE_OFF_T = [false, false, false, -887273, 887273, 0n, 0n, false, 0n];
const ST_OFF = { mode: 0, triggerTicks: 0, slippageBps: 0, minInterval: 0, budget: 0, lastRunAt: 0, flags: 0, lowerTrigger: 0, upperTrigger: 0, pairEpoch: 0, maxSwapFeePips: 0 };

/**
 * The fake chain with the two real positions of the fixtures (v4 ETH/USDG 4006316 in the reviewed-hook pool, v3 AMZN/USDG
 * 1489972), their pools listed for automation with Chainlink prices, and every rule off. `owner` owns both positions.
 * The state is mutable: `apply` plays a sent transaction onto it, so the read-back after a write sees the change.
 */
export function goatWorld(o: { owner?: Address; v4Range?: [number, number] } = {}) {
  const owner = o.owner ?? API_OWNER;
  const [v4Lower, v4Upper] = o.v4Range ?? [-198960, -198650];
  const chain = new FakeChain();
  const st: WorldState = {
    owner: new Map([[`v4:${V4_POS}`, owner], [`v3:${V3_POS}`, owner]]), approved: new Map(),
    gac3: new Map(), gac3Owner: new Map(), gac4: new Map(), gac4Owner: new Map(), ar: new Map(), arOwner: new Map(), ae: new Map(), aeOwner: new Map(),
    steward: new Map(), stewardOwner: new Map(), nonces: new Map(), forAll: new Set(),
  };
  chain.codeHashes.set(REVIEWED_HOOK.toLowerCase(), REVIEWED_HOOK_HASH);
  const id = (a: readonly unknown[]) => BigInt(a[0] as bigint);
  const notMinted = () => { throw new Error('NOT_MINTED'); };
  chain.on(GOAT_PRICE_ANCHOR, 'feedOf', (a: readonly unknown[]) => ([WETH_T, USDG_T, AMZN].includes(lc(a[0] as string) as Address) ? FEED : ZERO))
    .on(GOAT_PRICE_ANCHOR, 'poolFor', [ZERO, 0n])
    .on(GOAT_AUTO_COMPOUND_V4, 'reviewedHookCodehash', (a: readonly unknown[]) => (lc(a[0] as string) === REVIEWED_HOOK ? REVIEWED_HOOK_HASH : ZERO32))
    .on(GOAT_V4_PAIR_REGISTRY, 'entryOf', { srcKind: 1, gate: 101, epoch: 1 })
    .on(GOAT_V4_PAIR_REGISTRY, 'poolInfo', [101, 1, true, true])
    .on(GOAT_V4_PAIR_REGISTRY, 'hookEntry', (a: readonly unknown[]) => (lc(a[0] as string) === ETH_USDG_V4
      ? { codehash: REVIEWED_HOOK_HASH, pinnedFee: 6000, maxSlippageBps: 40, kind: 1, requiredBits: 0 }
      : { codehash: ZERO32, pinnedFee: 0, maxSlippageBps: 0, kind: 0, requiredBits: 0 }))
    .on(GOAT_V4_PAIR_REGISTRY, 'checkUnlisted', undefined)
    .on(GOAT_V4_PAIR_REGISTRY, 'swapBudgetOf', [10n ** 30n, 0n, 10n ** 30n, 10n ** 30n, 0n, 10n ** 30n])
    .on(GOAT_V4_PAIR_REGISTRY, 'ncSourceOf', { ncIs0: false })
    .on(GOAT_PAIR_TABLE, 'coverage', [true, true])
    .on(GOAT_PAIR_TABLE, 'swapBudgetOf', [10n ** 30n, 0n, 10n ** 30n, 0n])
    .on(GOAT_PAIR_TABLE, 'swapBudgetXOf', [10n ** 30n, 0n, 10n ** 30n, 0n])
    .on(GOAT_PAIR_TABLE, 'pair', { gate: 101, gateHighFee: 151, feed0: { proxy: FEED } })
    .on(GOAT_PAIR_TABLE, 'nc', { refPool: ZERO, gate: 0, gateHighFee: 0, capIn0: true })
    .on('0x1f7d7550B1b028f7571E69A784071F0205FD2EfA', 'getPool', AMZN_USDG_V3)
    // v4 position manager
    .on(POSM, 'ownerOf', (a: readonly unknown[]) => st.owner.get(`v4:${id(a)}`) ?? notMinted())
    .on(POSM, 'getApproved', (a: readonly unknown[]) => st.approved.get(`v4:${id(a)}`) ?? ZERO)
    .on(POSM, 'isApprovedForAll', (a: readonly unknown[]) => st.forAll.has(`v4:${lc(a[0] as string)}:${lc(a[1] as string)}`))
    .on(NPM, 'isApprovedForAll', (a: readonly unknown[]) => st.forAll.has(`v3:${lc(a[0] as string)}:${lc(a[1] as string)}`))
    .on(POSM, 'getPoolAndPositionInfo', (a: readonly unknown[]) => (id(a) === V4_POS
      ? [{ currency0: ZERO, currency1: USDG_T, fee: 8388608, tickSpacing: 10, hooks: REVIEWED_HOOK }, v4Info(v4Lower, v4Upper)] : notMinted()))
    .on(POSM, 'getPositionLiquidity', (a: readonly unknown[]) => (id(a) === V4_POS ? 7629398407350629n : 0n))
    .on(POSM, 'nonces', (a: readonly unknown[]) => st.nonces.get(`${lc(a[0] as string)}:${String(a[1])}`) ?? 0n)
    .on(POSM, 'DOMAIN_SEPARATOR', '0x061938567e6832ca43b380ce1978347d2ab5aea073ca93cdf29074c9ebfa15dd')
    // v3 position manager
    .on(NPM, 'ownerOf', (a: readonly unknown[]) => st.owner.get(`v3:${id(a)}`) ?? notMinted())
    .on(NPM, 'getApproved', (a: readonly unknown[]) => st.approved.get(`v3:${id(a)}`) ?? ZERO)
    .on(NPM, 'positions', (a: readonly unknown[]) => (id(a) === V3_POS
      ? [0n, ZERO, AMZN, USDG_T, 3000, -221280, -221100, 14732486021543492n, 0n, 0n, 0n, 0n] : notMinted()))
    // rules
    .on(GOAT_AUTO_COMPOUND_V3, 'configs', (a: readonly unknown[]) => st.gac3.get(id(a)) ?? GAC3_OFF_T)
    .on(GOAT_AUTO_COMPOUND_V3, 'configOwner', (a: readonly unknown[]) => st.gac3Owner.get(id(a)) ?? ZERO)
    .on(GOAT_AUTO_COMPOUND_V4, 'configs', (a: readonly unknown[]) => st.gac4.get(id(a)) ?? GAC4_OFF_T)
    .on(GOAT_AUTO_COMPOUND_V4, 'configOwner', (a: readonly unknown[]) => st.gac4Owner.get(id(a)) ?? ZERO)
    .on(AUTO_RANGE_V3, 'positionConfigs', (a: readonly unknown[]) => st.ar.get(id(a)) ?? AR_OFF_T)
    .on(AUTO_RANGE_V3, 'positionConfigOwners', (a: readonly unknown[]) => st.arOwner.get(id(a)) ?? ZERO)
    .on(AUTO_EXIT_V3, 'positionConfigs', (a: readonly unknown[]) => st.ae.get(id(a)) ?? AE_OFF_T)
    .on(AUTO_EXIT_V3, 'positionConfigOwners', (a: readonly unknown[]) => st.aeOwner.get(id(a)) ?? ZERO)
    .on(GOAT_V4_STEWARD, 'configOf', (a: readonly unknown[]) => [st.steward.get(id(a)) ?? ST_OFF, st.stewardOwner.get(id(a)) ?? ZERO])
    .on(GOAT_V4_STEWARD, 'previewTrigger', [false, false, '0x00000000']);
  return { chain, st, owner };
}

/** The API answers of the fixtures, by path (the status file is made fresh at NOW_SEC) */
export function apiWorld(extra: Record<string, FakeAnswer | ((init: { method: string; headers: Record<string, string>; body?: string }) => FakeAnswer)> = {}) {
  return fakeFetch({
    '/v2/discover-pools': { body: fixture('discover-pools.json'), headers: { 'cache-control': 'public, max-age=300', etag: 'W/"d1"' } },
    [`/v2/tokens/robinhood/${USDG_T}/pools`]: { body: fixture('discover-pools.json'), headers: { 'cache-control': 'public, max-age=300' } },
    [`/v2/pools/robinhood/uniswapv4/${ETH_USDG_V4}`]: { body: fixture('pool-v4.json'), headers: { 'cache-control': 'public, max-age=2' } },
    '/v2/pools/robinhood/uniswapv3/0x69bfaf19c9f377bb306a89aed9f6b07e2c1a8d9a': { body: fixture('pool-v3.json'), headers: { 'cache-control': 'public, max-age=2' } },
    [`/v2/positions/account/${API_OWNER}`]: { body: fixture('account-positions.json'), headers: { 'cache-control': 'public, max-age=2' } },
    [`/v2/positions/robinhood/uniswapv4/${V4_POS}`]: { body: fixture('position-v4.json') },
    [`/v2/positions/robinhood/uniswapv4/${V4_POS}/cash-flows`]: { body: fixture('cash-flows-v4.json') },
    '/v2/tokens/prices': { body: fixture('token-prices.json') },
    '/v2/automation/policy': { body: fixture('automation-policy.json'), headers: { 'cache-control': 'public, max-age=300' } },
    '/automation/status': { body: { version: 1, updatedAt: NOW_SEC - 60, positions: [{ tokenId: String(V4_POS), venue: 'v4', kind: 'range', status: 'ok', reason: null }] }, headers: { 'cache-control': 'public, max-age=30' } },
    [`/automation/permits/${V4_POS}`]: { body: { sessions: [] }, headers: { 'cache-control': 'no-store' } },
    ...extra,
  });
}

/** Play a sent transaction onto the world (approvals, rules, cancelled nonces), as the chain would */
export function playTx(st: WorldState, from: Address, tx: { to: Address; data: Hex }): void {
  const to = lc(tx.to);
  const d = (abi: readonly unknown[]) => decodeFunctionData({ abi: abi as Abi, data: tx.data }) as { functionName: string; args: readonly unknown[] };
  if (to === lc(POSM)) {
    const c = d(posmAbiK);
    const one = (fn: string, args: readonly unknown[]) => {
      if (fn === 'approve') { const a = args[0] as Address; if (/^0x0{40}$/i.test(a)) st.approved.delete(`v4:${args[1]}`); else st.approved.set(`v4:${args[1]}`, a); }
      if (fn === 'revokeNonce') { const n = args[0] as bigint; const k = `${lc(from)}:${n >> 8n}`; st.nonces.set(k, (st.nonces.get(k) ?? 0n) | (1n << (n & 255n))); }
    };
    if (c.functionName === 'multicall') for (const inner of c.args[0] as Hex[]) { const x = decodeFunctionData({ abi: posmAbiK as Abi, data: inner }) as { functionName: string; args: readonly unknown[] }; one(x.functionName, x.args); }
    else one(c.functionName, c.args);
  } else if (to === lc(NPM)) {
    const c = d(npmAbiK);
    if (c.functionName === 'approve') { const a = c.args[0] as Address; if (/^0x0{40}$/i.test(a)) st.approved.delete(`v3:${c.args[1]}`); else st.approved.set(`v3:${c.args[1]}`, a); }
  } else if (to === lc(GOAT_AUTO_COMPOUND_V3)) {
    const c = d(gac3AbiK); const id = c.args[0] as bigint; const g = c.args[1] as Record<string, unknown>;
    st.gac3.set(id, [g.enabled, g.swapEnabled, g.maxSlippageBps, g.minInterval, 0, 0n, 0n]); st.gac3Owner.set(id, from);
  } else if (to === lc(GOAT_AUTO_COMPOUND_V4)) {
    const c = d(gac4AbiK); const id = c.args[0] as bigint; const g = c.args[1] as Record<string, unknown>;
    st.gac4.set(id, [g.enabled, g.claimOnly, g.allowStandingApproval, g.maxSlippageBps, g.minInterval, 0, 0n]); st.gac4Owner.set(id, from);
  } else if (to === lc(AUTO_RANGE_V3)) {
    const c = d(autoRangeAbiK); const id = c.args[0] as bigint; const g = c.args[2] as Record<string, unknown>;
    st.ar.set(id, [g.lowerTickLimit, g.upperTickLimit, g.lowerTickDelta, g.upperTickDelta, g.token0SlippageX64, g.token1SlippageX64, g.onlyFees, g.autoCompound, g.maxRewardX64]); st.arOwner.set(id, from);
  } else if (to === lc(AUTO_EXIT_V3)) {
    const c = d(autoExitAbiK); const id = c.args[0] as bigint; const g = c.args[1] as Record<string, unknown>;
    st.ae.set(id, [g.isActive, g.token0Swap, g.token1Swap, g.token0TriggerTick, g.token1TriggerTick, g.token0SlippageX64, g.token1SlippageX64, g.onlyFees, g.maxRewardX64]); st.aeOwner.set(id, from);
  } else if (to === lc(GOAT_V4_STEWARD)) {
    const c = d(stewardAbiK); const id = c.args[0] as bigint;
    if (c.functionName === 'clearConfig') st.steward.set(id, { ...ST_OFF });
    else if (c.functionName === 'setRangeConfig') { const g = c.args[1] as Record<string, number>; st.steward.set(id, { ...ST_OFF, mode: 1, triggerTicks: g.triggerTicks, slippageBps: g.slippageBps, minInterval: g.minInterval, budget: g.budget, maxSwapFeePips: g.maxSwapFeePips, pairEpoch: 1 }); st.stewardOwner.set(id, from); }
    else if (c.functionName === 'setExitConfig') { const g = c.args[1] as Record<string, number>; st.steward.set(id, { ...ST_OFF, mode: 2, flags: g.flags, lowerTrigger: g.lowerTrigger, upperTrigger: g.upperTrigger, slippageBps: g.slippageBps, maxSwapFeePips: g.maxSwapFeePips, pairEpoch: 1 }); st.stewardOwner.set(id, from); }
  }
}

/** The world, owned by the test signer, with a signer whose transactions play onto it */
export function writeWorld(o: { v4Range?: [number, number] } = {}) {
  const w = goatWorld({ owner: TEST_ACCOUNT, v4Range: o.v4Range });
  const signer = new FakeSigner();
  signer.onSend = (tx) => playTx(w.st, signer.address, tx);
  return { ...w, signer };
}

// ------------------------------------------------------------------ deposits

export const WETH_USDG_V3 = '0x69bfaf19c9f377bb306a89aed9f6b07e2c1a8d9a' as Address;
/** slot0 of the WETH/USDG 0.05% pool, read on chain */
export const WETH_USDG_SQRT = 3813742849960397548252994n;
export const WETH_USDG_TICK = -198840;
export const AMZN_TICK = -221190;
/** a hook-free v4 ETH/USDG pool of the tests, and a position in it */
export const KEY_V4_FREE = { currency0: ZERO, currency1: USDG_T, fee: 500, tickSpacing: 10, hooks: ZERO };
export const V4_FREE_POS = 5000001n;
export const COPY_TSLA = '0x00000000000000000000000000000000000c0b1a' as Address;
export const TAX_TOKEN = '0x337f3f7384a2e2cfb9757971d469773f23e509f0' as Address;
export const FEEDS = {
  weth: '0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9' as Address,
  usdg: '0x61B7e5650328764B076A108EFF5fa7282a1B9aD2' as Address,
  amzn: '0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C' as Address,
};
const PERMIT2_A = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as Address;
const POOL_MANAGER_A = '0x8366a39CC670B4001A1121B8F6A443A643e40951' as Address;
const V3_FACTORY_A = '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA' as Address;
const TRANSFER = toEventSelector('event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)');

export interface LpState {
  /** ERC20 balances and allowances by `${token}:${owner}` and `${token}:${owner}:${spender}` */
  bal: Map<string, bigint>;
  allowance: Map<string, bigint>;
  /** Permit2 allowances by `${owner}:${token}:${spender}` */
  permit2: Map<string, { amount: bigint; expiration: number }>;
  liquidity: Map<string, bigint>;
  nextId: bigint;
  /** the receipt logs of the next mint */
  minted: Hex[] | null;
}

/** The v4 PoolManager slot0 word of a pool */
export const slot0Word = (sqrtPriceX96: bigint, tick: number, lpFee: number) =>
  (BigInt(lpFee) << 208n) | (BigInt(tick < 0 ? tick + 0x1000000 : tick) << 160n) | sqrtPriceX96;
export const slotOf = (poolId: Hex) => keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [poolId, 6n]));

/**
 * The write world plus what a deposit reads: three tokens (WETH, USDG, AMZN), a copied ticker and a token that takes a fee,
 * the WETH/USDG and AMZN/USDG v3 pools, a hook-free v4 ETH/USDG pool with one position of the wallet, fresh Chainlink feeds
 * at the pools' prices, the wallet's balances (10 ETH) and no allowances. Sent approvals and deposits play onto it; the
 * deposit's simulation reverts while an allowance it needs is missing.
 */
export function lpWorld(o: { ethPrice?: number } = {}) {
  const w = writeWorld();
  const { chain, signer } = w;
  const me = lc(signer.address);
  const lp: LpState = { bal: new Map(), allowance: new Map(), permit2: new Map(), liquidity: new Map([[`v3:${V3_POS}`, 14732486021543492n], [`v4:${V4_FREE_POS}`, 10n ** 15n]]), nextId: 6_000_000n, minted: null };
  const tokens: Record<string, { decimals: number; symbol: string }> = {
    [WETH_T]: { decimals: 18, symbol: 'WETH' }, [USDG_T]: { decimals: 6, symbol: 'USDG' }, [AMZN]: { decimals: 18, symbol: 'AMZN' },
    [COPY_TSLA]: { decimals: 18, symbol: 'TSLA' }, [TAX_TOKEN]: { decimals: 18, symbol: 'TAXX' },
  };
  for (const [t, m] of Object.entries(tokens)) {
    chain.on(t, 'decimals', m.decimals).on(t, 'symbol', m.symbol)
      .on(t, 'balanceOf', (a: readonly unknown[]) => lp.bal.get(`${t}:${lc(a[0] as string)}`) ?? 0n)
      .on(t, 'allowance', (a: readonly unknown[]) => lp.allowance.get(`${t}:${lc(a[0] as string)}:${lc(a[1] as string)}`) ?? 0n);
  }
  lp.bal.set(`${WETH_T}:${me}`, 5n * 10n ** 18n);
  lp.bal.set(`${USDG_T}:${me}`, 20_000n * 10n ** 6n);
  lp.bal.set(`${AMZN}:${me}`, 50n * 10n ** 18n);
  chain.balances.set(me, 10n * 10n ** 18n);
  chain.on(PERMIT2_A, 'allowance', (a: readonly unknown[]) => {
    const p = lp.permit2.get(`${lc(a[0] as string)}:${lc(a[1] as string)}:${lc(a[2] as string)}`);
    return p ? [p.amount, p.expiration, 0] : [0n, 0, 0];
  });
  // v3 pools and the factory
  const v3Pools: Record<string, { t0: Address; t1: Address; fee: number; spacing: number; sqrt: bigint; tick: number }> = {
    [WETH_USDG_V3]: { t0: WETH_T, t1: USDG_T, fee: 500, spacing: 10, sqrt: WETH_USDG_SQRT, tick: WETH_USDG_TICK },
    [AMZN_USDG_V3]: { t0: AMZN, t1: USDG_T, fee: 3000, spacing: 60, sqrt: sqrtAt(AMZN_TICK), tick: AMZN_TICK },
    '0x00000000000000000000000000000000000c0b1b': { t0: COPY_TSLA, t1: USDG_T, fee: 3000, spacing: 60, sqrt: sqrtAt(-221190), tick: -221190 },
    '0x00000000000000000000000000000000000c0b1c': { t0: TAX_TOKEN, t1: USDG_T, fee: 3000, spacing: 60, sqrt: sqrtAt(-221190), tick: -221190 },
  };
  for (const [p, d] of Object.entries(v3Pools)) {
    chain.on(p, 'token0', d.t0).on(p, 'token1', d.t1).on(p, 'fee', d.fee).on(p, 'tickSpacing', d.spacing).on(p, 'slot0', () => [d.sqrt, d.tick, 0, 1, 1, 0, true]);
  }
  chain.on(V3_FACTORY_A, 'getPool', (a: readonly unknown[]) => {
    const [x, y, fee] = [lc(a[0] as string), lc(a[1] as string), Number(a[2])];
    const hit = Object.entries(v3Pools).find(([, d]) => d.fee === fee && ((d.t0 === x && d.t1 === y) || (d.t0 === y && d.t1 === x)));
    return hit ? hit[0] : ZERO;
  });
  chain.on(NPM, 'positions', (a: readonly unknown[]) => {
    const id = BigInt(a[0] as bigint);
    if (id !== V3_POS) throw new Error('NOT_MINTED');
    return [0n, ZERO, AMZN, USDG_T, 3000, -221280, -221100, lp.liquidity.get(`v3:${V3_POS}`)!, 0n, 0n, 0n, 0n];
  });
  // the hook-free v4 pool and the position in it
  const freeId = poolIdOfKey(KEY_V4_FREE);
  const slots = new Map<string, bigint>([[lc(slotOf(freeId)), slot0Word(WETH_USDG_SQRT, WETH_USDG_TICK, 500)], [lc(slotOf(ETH_USDG_V4)), slot0Word(WETH_USDG_SQRT, WETH_USDG_TICK, 1243)]]);
  chain.on(POOL_MANAGER_A, 'extsload', (a: readonly unknown[]) => `0x${(slots.get(lc(a[0] as string)) ?? 0n).toString(16).padStart(64, '0')}`);
  w.st.owner.set(`v4:${V4_FREE_POS}`, signer.address);
  const infoOld = chain.handlers.get(`${lc(POSM)}:getPoolAndPositionInfo`)!;
  chain.on(POSM, 'getPoolAndPositionInfo', (a: readonly unknown[], c: McCall) => (BigInt(a[0] as bigint) === V4_FREE_POS ? [KEY_V4_FREE, v4Info(-199200, -198600)] : infoOld(a, c)));
  const liqOld = chain.handlers.get(`${lc(POSM)}:getPositionLiquidity`)!;
  chain.on(POSM, 'getPositionLiquidity', (a: readonly unknown[], c: McCall) => (BigInt(a[0] as bigint) === V4_FREE_POS ? lp.liquidity.get(`v4:${V4_FREE_POS}`)! : liqOld(a, c)));
  // Chainlink at the pools' prices (8 decimals, updated a minute ago)
  const ethUsd = o.ethPrice ?? priceOf(WETH_USDG_TICK, 18, 6);
  const round = (usd: number) => [100n, BigInt(Math.round(usd * 1e8)), BigInt(NOW_SEC - 60), BigInt(NOW_SEC - 60), 100n];
  chain.on(FEEDS.weth, 'decimals', 8).on(FEEDS.weth, 'latestRoundData', () => round(ethUsd))
    .on(FEEDS.usdg, 'decimals', 8).on(FEEDS.usdg, 'latestRoundData', () => round(1))
    .on(FEEDS.amzn, 'decimals', 8).on(FEEDS.amzn, 'latestRoundData', () => round(priceOf(AMZN_TICK, 18, 6)));
  // a deposit's simulation reverts while an allowance it needs is missing
  chain.simulate = (tx) => { const why = missingAllowance(lp, tx, chain.time); if (why) throw new Error(`execution reverted: ${why}`); return '0x'; };
  signer.onSend = (tx) => { playTx(w.st, signer.address, tx); playLp(lp, w.st, signer.address, tx); };
  chain.receiptLogs = () => { const m = lp.minted; lp.minted = null; return m ? [{ address: m[0] as Address, topics: m.slice(1) as Hex[], data: '0x' }] : []; };
  return { ...w, lp, freeId };
}

const sqrtAt = (tick: number) => getSqrtRatioAtTick(tick);
const priceOf = (tick: number, d0: number, d1: number) => Math.pow(1.0001, tick) * 10 ** (d0 - d1);
const poolIdOfKey = (k: typeof KEY_V4_FREE) => keccak256(encodeAbiParameters(
  [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }], [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]));

/** What a deposit pulls, decoded: per token the amount it may take, and from whom */
function depositNeeds(tx: { to: Address; data: Hex; value?: bigint }): { venue: Venue; take: [Address, bigint][]; mint: boolean; id?: bigint } | null {
  const to = lc(tx.to);
  if (to === lc(NPM)) {
    let c = decodeFunctionData({ abi: npmAbiK as Abi, data: tx.data }) as { functionName: string; args: readonly unknown[] };
    let ethPaid = false;
    if (c.functionName === 'multicall') { c = decodeFunctionData({ abi: npmAbiK as Abi, data: (c.args[0] as Hex[])[0] }) as typeof c; ethPaid = true; }
    const p = c.args[0] as Record<string, unknown>;
    if (c.functionName === 'mint') {
      const take: [Address, bigint][] = [[p.token0 as Address, p.amount0Desired as bigint], [p.token1 as Address, p.amount1Desired as bigint]];
      return { venue: 'v3', take: ethPaid ? take.filter(([t]) => lc(t) !== WETH_T) : take, mint: true };
    }
    if (c.functionName === 'increaseLiquidity') {
      const take: [Address, bigint][] = [[AMZN, p.amount0Desired as bigint], [USDG_T, p.amount1Desired as bigint]];
      return { venue: 'v3', take: ethPaid ? take.filter(([t]) => lc(t) !== WETH_T) : take, mint: false, id: p.tokenId as bigint };
    }
    return null;
  }
  if (to === lc(POSM)) {
    const c = decodeFunctionData({ abi: posmAbiK as Abi, data: tx.data }) as { functionName: string; args: readonly unknown[] };
    if (c.functionName !== 'modifyLiquidities') return null;
    const { actions, params } = decodeUnlockData(c.args[0] as Hex);
    if (actions[0] === Actions.MINT_POSITION) {
      const m = decodeAbiParameters(V4_PARAMS.mint, params[0]);
      const k = m[0] as { currency0: Address; currency1: Address };
      return { venue: 'v4', take: ([[k.currency0, m[4] as bigint], [k.currency1, m[5] as bigint]] as [Address, bigint][]).filter(([t]) => !/^0x0{40}$/i.test(t)), mint: true };
    }
    if (actions[0] === Actions.INCREASE_LIQUIDITY) {
      const p = decodeAbiParameters(V4_PARAMS.increase, params[0]);
      const [c0] = decodeAbiParameters(V4_PARAMS.close, params[1]);
      const [c1] = decodeAbiParameters(V4_PARAMS.close, params[2]);
      return { venue: 'v4', take: ([[c0, p[2] as bigint], [c1, p[3] as bigint]] as [Address, bigint][]).filter(([t]) => !/^0x0{40}$/i.test(t)), mint: false, id: p[0] as bigint };
    }
  }
  return null;
}

function missingAllowance(lp: LpState, tx: { from: Address; to: Address; data: Hex; value?: bigint }, now: number): string | null {
  const d = depositNeeds(tx);
  if (!d) return null;
  const from = lc(tx.from);
  for (const [t, amount] of d.take) {
    if (amount <= 0n) continue;
    if (d.venue === 'v3' && (lp.allowance.get(`${lc(t)}:${from}:${lc(NPM)}`) ?? 0n) < amount) return 'STF';
    if (d.venue === 'v4') {
      if ((lp.allowance.get(`${lc(t)}:${from}:${lc(PERMIT2_A)}`) ?? 0n) < amount) return 'TRANSFER_FROM_FAILED';
      const p = lp.permit2.get(`${from}:${lc(t)}:${lc(POSM)}`);
      if (!p || p.amount < amount) return 'InsufficientAllowance';
      if (p.expiration < now) return 'AllowanceExpired';
    }
  }
  return null;
}

/** Play an approval or a deposit onto the deposit state */
function playLp(lp: LpState, st: WorldState, from: Address, tx: { to: Address; data: Hex; value: bigint }): void {
  const to = lc(tx.to);
  const f = lc(from);
  if (to === lc(PERMIT2_A)) {
    const c = decodeFunctionData({ abi: permit2AbiK as Abi, data: tx.data }) as { args: readonly unknown[] };
    const [token, spender, amount, expiration] = c.args as [Address, Address, bigint, number];
    lp.permit2.set(`${f}:${lc(token)}:${lc(spender)}`, { amount, expiration: Number(expiration) });
    return;
  }
  if ([WETH_T, USDG_T, AMZN, COPY_TSLA, TAX_TOKEN].includes(to as Address)) {
    const c = decodeFunctionData({ abi: erc20AbiK as Abi, data: tx.data }) as { args: readonly unknown[] };
    lp.allowance.set(`${to}:${f}:${lc(c.args[0] as string)}`, c.args[1] as bigint);
    return;
  }
  const d = depositNeeds(tx);
  if (!d) return;
  for (const [t, amount] of d.take) {
    const k = `${lc(t)}:${f}`;
    lp.bal.set(k, (lp.bal.get(k) ?? 0n) - amount);
    if (d.venue === 'v3') lp.allowance.set(`${lc(t)}:${f}:${lc(NPM)}`, (lp.allowance.get(`${lc(t)}:${f}:${lc(NPM)}`) ?? 0n) - amount);
  }
  if (d.mint) {
    const id = lp.nextId++;
    st.owner.set(`${d.venue}:${id}`, from);
    const nft = d.venue === 'v3' ? NPM : POSM;
    lp.minted = [nft, TRANSFER, `0x${'0'.repeat(64)}`, `0x${f.slice(2).padStart(64, '0')}`, `0x${id.toString(16).padStart(64, '0')}`] as Hex[];
  } else {
    const k = `${d.venue}:${d.id}`;
    lp.liquidity.set(k, (lp.liquidity.get(k) ?? 0n) + 1000n);
  }
}

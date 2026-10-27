// Chain reads of the automation tools, through Multicall3 with allowFailure: a failed field is 'unknown', never "off".
//  - the environment: chain id, the pin check of every contract, the addresses the pinned contracts name (they must equal
//    the pins), and the contract state (paused, live fees, fee recipient);
//  - pool facts (price references, registry and pair-table entries, hook entries and code hashes);
//  - position facts (owner, permission, liquidity, range, every rule of the venue).
// The mappers from raw results to facts are pure and tested.
import { encodeAbiParameters, keccak256, type Address, type Hex } from 'viem';
import {
  autoExitAbi, autoRangeAbi, gac3Abi, gac4Abi, gv4cAbi, npmAbi, pairTableAbi, posmAbi, priceAnchorAbi, registryAbi, stewardAbi,
  v3FactoryAbi,
} from './abis';
import {
  AUTO_EXIT_V3, AUTO_RANGE_V3, GOAT_AUTO_COMPOUND_V3, GOAT_AUTO_COMPOUND_V4, GOAT_CHAIN_ID, GOAT_PAIR_TABLE, GOAT_PRICE_ANCHOR,
  GOAT_TREASURY, GOAT_V4_COMPOUNDOR, GOAT_V4_PAIR_REGISTRY, GOAT_V4_STEWARD, GOAT_V4_STEWARD_ENGINE, NC_SRC_KINDS, NPM, PINS, POSM,
  ST_MODE, V3_FACTORY, WETH, ZERO_ADDRESS, type PinKey,
} from './constants';
import { checkPins, type GoatChain, type McCall, type McRes, type PinResult } from './chain';
import { autoCheckKey, needsCompoundHookRead, needsHookCodeHash } from './hooks';
import type {
  AeConfig, ArConfig, ContractFacts, ContractGates, ContractKey, Gac3Config, Gac4Config, Kind, Maybe, PoolFacts, PositionFacts,
  RuleRead, StewardConfig, Venue,
} from './types';

const eqA = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const isZero = (a: string | null | undefined) => !a || /^0x0{40}$/i.test(a);
const native = (a: Address) => (isZero(a) ? WETH : a);
const val = <T>(r: McRes | undefined): Maybe<T> => (r && r.status === 'success' ? (r.result as T) : 'unknown');

/** The automation contracts at their pinned addresses */
export const TARGETS: Readonly<Record<ContractKey, Address>> = Object.freeze({
  autoCompoundV3: GOAT_AUTO_COMPOUND_V3, autoCompoundV4: GOAT_AUTO_COMPOUND_V4, rangeExitV3: AUTO_RANGE_V3, exitV3: AUTO_EXIT_V3, rangeExitV4: GOAT_V4_STEWARD,
});

/** The contracts each automation needs pinned (its own code, its spender, its fee taker, its read sources, the NFT manager) */
export const PINS_OF: Readonly<Record<ContractKey, readonly PinKey[]>> = {
  autoCompoundV3: ['autoCompoundV3', 'priceAnchor', 'npm', 'multicall3'],
  autoCompoundV4: ['autoCompoundV4', 'compoundorV4', 'priceAnchor', 'posm', 'multicall3'],
  rangeExitV3: ['rangeExitV3', 'pairTable', 'npm', 'multicall3'],
  exitV3: ['exitV3', 'pairTable', 'npm', 'multicall3'],
  rangeExitV4: ['rangeExitV4', 'engine', 'registry', 'posm', 'multicall3'],
};
export const ALL_PIN_KEYS = Object.keys(PINS) as PinKey[];

/** The addresses the pinned contracts name in their immutables (they must equal the pins) */
export interface Derived { engine?: Address; registry?: Address; gv4c?: Address; priceAnchorV3?: Address; priceAnchorV4?: Address; pairTableR?: Address; pairTableE?: Address; posmOfSteward?: Address; posmOfGac4?: Address; npmOfGac3?: Address }

export interface GoatEnv {
  chainId: number;
  pins: Record<PinKey, PinResult>;
  derived: Derived;
  /** per automation contract: may it be used now? */
  gates: ContractGates;
  targets: Readonly<Record<ContractKey, Address>>;
  contracts: ContractFacts;
  /** unix seconds of the latest block when the environment was read */
  blockTime: number;
}

const DERIVED_CALLS: readonly [keyof Derived, McCall][] = [
  ['engine', { address: GOAT_V4_STEWARD, abi: stewardAbi, functionName: 'ENGINE' }],
  ['registry', { address: GOAT_V4_STEWARD, abi: stewardAbi, functionName: 'REGISTRY' }],
  ['posmOfSteward', { address: GOAT_V4_STEWARD, abi: stewardAbi, functionName: 'POSM' }],
  ['gv4c', { address: GOAT_AUTO_COMPOUND_V4, abi: gac4Abi, functionName: 'compoundor' }],
  ['posmOfGac4', { address: GOAT_AUTO_COMPOUND_V4, abi: gac4Abi, functionName: 'positionManager' }],
  ['priceAnchorV3', { address: GOAT_AUTO_COMPOUND_V3, abi: gac3Abi, functionName: 'priceAnchor' }],
  ['npmOfGac3', { address: GOAT_AUTO_COMPOUND_V3, abi: gac3Abi, functionName: 'nonfungiblePositionManager' }],
  ['priceAnchorV4', { address: GOAT_V4_COMPOUNDOR, abi: gv4cAbi, functionName: 'priceAnchor' }],
  ['pairTableR', { address: AUTO_RANGE_V3, abi: autoRangeAbi, functionName: 'pairTable' }],
  ['pairTableE', { address: AUTO_EXIT_V3, abi: autoExitAbi, functionName: 'pairTable' }],
];

/** What each derived address must equal, and which automation it belongs to */
const DERIVED_EXPECT: Readonly<Record<keyof Derived, { want: Address; of: ContractKey }>> = {
  engine: { want: GOAT_V4_STEWARD_ENGINE, of: 'rangeExitV4' },
  registry: { want: GOAT_V4_PAIR_REGISTRY, of: 'rangeExitV4' },
  posmOfSteward: { want: POSM, of: 'rangeExitV4' },
  gv4c: { want: GOAT_V4_COMPOUNDOR, of: 'autoCompoundV4' },
  posmOfGac4: { want: POSM, of: 'autoCompoundV4' },
  priceAnchorV3: { want: GOAT_PRICE_ANCHOR, of: 'autoCompoundV3' },
  npmOfGac3: { want: NPM, of: 'autoCompoundV3' },
  priceAnchorV4: { want: GOAT_PRICE_ANCHOR, of: 'autoCompoundV4' },
  pairTableR: { want: GOAT_PAIR_TABLE, of: 'rangeExitV3' },
  pairTableE: { want: GOAT_PAIR_TABLE, of: 'exitV3' },
};

/** The contract-state reads: [key, call] */
const STATE_CALLS: readonly [string, McCall][] = [
  ['p:autoCompoundV3', { address: GOAT_AUTO_COMPOUND_V3, abi: gac3Abi, functionName: 'paused' }],
  ['fee:compound:v3', { address: GOAT_AUTO_COMPOUND_V3, abi: gac3Abi, functionName: 'totalRewardX64' }],
  ['rcpt:autoCompoundV3', { address: GOAT_AUTO_COMPOUND_V3, abi: gac3Abi, functionName: 'feeRecipient' }],
  ['p:autoCompoundV4', { address: GOAT_AUTO_COMPOUND_V4, abi: gac4Abi, functionName: 'paused' }],
  ['fee:compound:v4', { address: GOAT_V4_COMPOUNDOR, abi: gv4cAbi, functionName: 'totalRewardX64' }],
  ['rcpt:autoCompoundV4', { address: GOAT_V4_COMPOUNDOR, abi: gv4cAbi, functionName: 'feeRecipient' }],
  ['modes', { address: GOAT_V4_STEWARD, abi: stewardAbi, functionName: 'pausedModes' }],
  ['retired', { address: GOAT_V4_STEWARD, abi: stewardAbi, functionName: 'retired' }],
  ['fee:range:v4', { address: GOAT_V4_STEWARD, abi: stewardAbi, functionName: 'feeBps', args: [0n] }],
  ['fee:exit:v4', { address: GOAT_V4_STEWARD, abi: stewardAbi, functionName: 'feeBps', args: [1n] }],
  ['rcpt:rangeExitV4', { address: GOAT_V4_STEWARD, abi: stewardAbi, functionName: 'feeRecipient' }],
  ['p:rangeExitV3', { address: AUTO_RANGE_V3, abi: autoRangeAbi, functionName: 'paused' }],
  ['fee:range:v3', { address: AUTO_RANGE_V3, abi: autoRangeAbi, functionName: 'rangeFeeX64' }],
  // the v3 contracts keep their fee for the withdrawer: that address must be the treasury
  ['rcpt:rangeExitV3', { address: AUTO_RANGE_V3, abi: autoRangeAbi, functionName: 'withdrawer' }],
  ['p:exitV3', { address: AUTO_EXIT_V3, abi: autoExitAbi, functionName: 'paused' }],
  ['fee:exit:v3', { address: AUTO_EXIT_V3, abi: autoExitAbi, functionName: 'exitFeeX64' }],
  ['rcpt:exitV3', { address: AUTO_EXIT_V3, abi: autoExitAbi, functionName: 'withdrawer' }],
];

const X64_TO_BPS = (x: bigint) => Number((x * 10_000n + (1n << 63n)) >> 64n);

/** Map the contract-state results to ContractFacts. Pure. */
export function contractFactsFrom(res: readonly McRes[], derived: Derived): ContractFacts {
  const f: ContractFacts = { paused: {}, feesBps: {}, treasuryOk: {}, spenders: {}, feesX64: {} };
  STATE_CALLS.forEach(([k], i) => {
    const r = res[i];
    const v = r?.status === 'success' ? r.result : undefined;
    const [a, b, c] = k.split(':');
    if (a === 'p') f.paused![b as ContractKey] = v === undefined ? 'unknown' : !!v;
    else if (a === 'modes') f.stewardPausedModes = v === undefined ? 'unknown' : Number(v);
    else if (a === 'retired') f.stewardRetired = v === undefined ? 'unknown' : !!v;
    else if (a === 'rcpt') f.treasuryOk![b as ContractKey] = v === undefined ? 'unknown' : eqA(v as string, GOAT_TREASURY);
    else if (a === 'fee' && v !== undefined) {
      const kind = b as Kind; const venue = c as Venue;
      const bps = venue === 'v4' && kind !== 'compound' ? Number(v) : X64_TO_BPS(BigInt(v as bigint));
      f.feesBps![kind] = { ...(f.feesBps![kind] ?? {}), [venue]: bps };
      if (venue === 'v3' && kind === 'range') f.feesX64!.rangeFeeX64 = BigInt(v as bigint);
      if (venue === 'v3' && kind === 'exit') f.feesX64!.exitFeeX64 = BigInt(v as bigint);
    }
  });
  f.spenders = { autoCompoundV3: GOAT_AUTO_COMPOUND_V3, autoCompoundV4: GOAT_AUTO_COMPOUND_V4, rangeExitV3: AUTO_RANGE_V3, exitV3: AUTO_EXIT_V3 };
  if (derived.engine && eqA(derived.engine, GOAT_V4_STEWARD_ENGINE)) f.spenders.rangeExitV4 = GOAT_V4_STEWARD_ENGINE;
  return f;
}

/** The gates from the pin results and the derived addresses. Pure. */
export function gatesFrom(chainId: number, pins: Record<PinKey, PinResult>, derived: Derived): ContractGates {
  const out = {} as Record<ContractKey, { ok: boolean; reason: string }>;
  for (const key of Object.keys(TARGETS) as ContractKey[]) {
    if (chainId !== GOAT_CHAIN_ID) { out[key] = { ok: false, reason: `The RPC is on chain ${chainId}, not Robinhood Chain (4663).` }; continue; }
    const bad = PINS_OF[key].map((k) => pins[k]).find((p) => !p?.ok);
    if (bad) { out[key] = { ok: false, reason: bad.reason }; continue; }
    const wrong = (Object.entries(DERIVED_EXPECT) as [keyof Derived, { want: Address; of: ContractKey }][])
      .find(([d, e]) => e.of === key && !eqA(derived[d], e.want));
    if (wrong) { out[key] = { ok: false, reason: `${PINS[key === 'rangeExitV4' ? 'rangeExitV4' : key].name} names an unexpected ${String(wrong[0])} address, or it could not be read.` }; continue; }
    out[key] = { ok: true, reason: 'Every contract this automation uses matches its pinned build.' };
  }
  return out;
}

/** Read the environment: chain id, the pins, the derived addresses and the contract state. */
export async function loadEnv(chain: GoatChain): Promise<GoatEnv> {
  const [chainId, pins, blockTime] = await Promise.all([chain.chainId(), checkPins(chain, ALL_PIN_KEYS), chain.blockTimestamp().catch(() => Math.floor(Date.now() / 1000))]);
  let derived: Derived = {};
  let state: McRes[] = [];
  if (chainId === GOAT_CHAIN_ID && pins.multicall3.ok) {
    const res = await chain.multicall([...DERIVED_CALLS.map(([, c]) => c), ...STATE_CALLS.map(([, c]) => c)]);
    derived = {};
    DERIVED_CALLS.forEach(([k], i) => { const r = res[i]; if (r?.status === 'success') derived[k] = r.result as Address; });
    state = res.slice(DERIVED_CALLS.length);
  }
  const gates = gatesFrom(chainId, pins, derived);
  return { chainId, pins, derived, gates, targets: TARGETS, contracts: contractFactsFrom(state, derived), blockTime };
}

// ------------------------------------------------------------------ pool facts

/** The v4 pool id of a pool key */
export function poolIdOf(key: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
    [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
  ));
}

/** Pool facts for eligibility (only for contracts whose gate is ok). `caps`: also read the pair's swap caps. */
export async function loadPoolFacts(chain: GoatChain, pools: readonly PoolFacts[], env: Pick<GoatEnv, 'gates'>, opts: { caps?: boolean } = {}): Promise<PoolFacts[]> {
  const calls: McCall[] = [];
  const plan: { i: number; field: string }[] = [];
  const push = (i: number, field: string, c: McCall) => { plan.push({ i, field }); calls.push(c); };
  const g = env.gates;
  pools.forEach((p, i) => {
    const compoundOk = p.venue === 'v4' ? g.autoCompoundV4.ok : g.autoCompoundV3.ok;
    if (compoundOk) {
      push(i, 'feed0', { address: GOAT_PRICE_ANCHOR, abi: priceAnchorAbi, functionName: 'feedOf', args: [native(p.token0)] });
      push(i, 'feed1', { address: GOAT_PRICE_ANCHOR, abi: priceAnchorAbi, functionName: 'feedOf', args: [native(p.token1)] });
      push(i, 'poolFor', { address: GOAT_PRICE_ANCHOR, abi: priceAnchorAbi, functionName: 'poolFor', args: [p.token0, p.token1] });
    }
    if (p.venue === 'v4' && g.autoCompoundV4.ok && needsCompoundHookRead(p)) {
      push(i, 'gac4Pin', { address: GOAT_AUTO_COMPOUND_V4, abi: gac4Abi, functionName: 'reviewedHookCodehash', args: [p.hooks] });
    }
    if (p.venue === 'v4' && g.rangeExitV4.ok) {
      push(i, 'entry', { address: GOAT_V4_PAIR_REGISTRY, abi: registryAbi, functionName: 'entryOf', args: [p.token0, p.token1] });
      if (opts.caps) {
        push(i, 'caps4', { address: GOAT_V4_PAIR_REGISTRY, abi: registryAbi, functionName: 'swapBudgetOf', args: [p.token0, p.token1] });
        push(i, 'ncsrc', { address: GOAT_V4_PAIR_REGISTRY, abi: registryAbi, functionName: 'ncSourceOf', args: [p.token0, p.token1] });
      }
      if (p.poolId) {
        push(i, 'poolInfo', { address: GOAT_V4_PAIR_REGISTRY, abi: registryAbi, functionName: 'poolInfo', args: [p.token0, p.token1, p.poolId] });
        push(i, 'hookEntry', { address: GOAT_V4_PAIR_REGISTRY, abi: registryAbi, functionName: 'hookEntry', args: [p.poolId] });
        push(i, 'red', { address: GOAT_V4_PAIR_REGISTRY, abi: registryAbi, functionName: 'checkUnlisted', args: [p.token0, p.token1, p.hooks ?? ZERO_ADDRESS, p.poolId] });
      }
    }
    if (p.venue === 'v3' && (g.rangeExitV3.ok || g.exitV3.ok)) {
      push(i, 'coverage', { address: GOAT_PAIR_TABLE, abi: pairTableAbi, functionName: 'coverage', args: [p.token0, p.token1, p.fee] });
      push(i, 'budget', { address: GOAT_PAIR_TABLE, abi: pairTableAbi, functionName: 'swapBudgetOf', args: [p.token0, p.token1] });
      push(i, 'pair', { address: GOAT_PAIR_TABLE, abi: pairTableAbi, functionName: 'pair', args: [p.token0, p.token1] });
      push(i, 'nc', { address: GOAT_PAIR_TABLE, abi: pairTableAbi, functionName: 'nc', args: [p.token0, p.token1] });
      if (opts.caps) push(i, 'budgetX', { address: GOAT_PAIR_TABLE, abi: pairTableAbi, functionName: 'swapBudgetXOf', args: [p.token0, p.token1] });
    }
  });
  // the code hash of each hook that needs it, read once per hook
  const v4Live = g.rangeExitV4.ok || g.autoCompoundV4.ok;
  const hookHashes = new Map<string, Promise<Hex | null | 'unknown'>>();
  if (v4Live) {
    for (const p of pools) {
      if (!p.hooks || !((g.rangeExitV4.ok && needsHookCodeHash(p)) || (g.autoCompoundV4.ok && needsCompoundHookRead(p)))) continue;
      const k = p.hooks.toLowerCase();
      if (!hookHashes.has(k)) hookHashes.set(k, chain.codeHash(p.hooks).then((h) => h, () => 'unknown' as const));
    }
  }
  const res = calls.length ? await chain.multicall(calls).catch((error: unknown): McRes[] => calls.map(() => ({ status: 'failure', error }))) : [];
  const raw: Record<string, McRes>[] = pools.map(() => ({}));
  plan.forEach((s, j) => { raw[s.i][s.field] = res[j]; });
  return Promise.all(pools.map(async (p, i) => {
    const f = poolFactsFrom(p, raw[i]);
    const h = p.hooks ? hookHashes.get(p.hooks.toLowerCase()) : undefined;
    return h ? { ...f, hookCodeHash: await h } : f;
  }));
}

const REGISTRY_RED_ERRORS = /RedListed/i;
const NOT_LISTED_ERRORS = /PoolNotAllowed/;
const failedWith = (r: McRes | undefined, re: RegExp): boolean => {
  if (!r || r.status !== 'failure') return false;
  const e = r.error as { message?: string; shortMessage?: string; data?: { errorName?: string } } | undefined;
  return re.test([e?.data?.errorName, e?.shortMessage, e?.message, String(e)].filter(Boolean).join(' '));
};
const zeroish = (x: unknown) => typeof x !== 'string' || /^0x0{40}$/i.test(x);

/** Map one pool's raw reads to PoolFacts. Pure. */
export function poolFactsFrom(p: PoolFacts, r: Record<string, McRes | undefined>): PoolFacts {
  const out: PoolFacts = { ...p };
  if ('feed0' in r || 'poolFor' in r) {
    const f0 = val<Address>(r.feed0); const f1 = val<Address>(r.feed1); const pf = val<readonly [Address, bigint]>(r.poolFor);
    if (f0 === 'unknown' || f1 === 'unknown' || pf === 'unknown') out.compoundAnchor = 'unknown';
    else {
      // a v3 position inside the pair's own anchor pool is checked against that pool's own 30-minute average
      const selfAnchor = p.venue === 'v3' && !isZero(pf[0]) && eqA(pf[0], p.pool);
      out.compoundAnchor = { chainlinkBoth: !isZero(f0) && !isZero(f1), anchorPool: !isZero(pf[0]), ...(selfAnchor ? { selfAnchor: true } : {}) };
    }
  }
  if ('entry' in r) {
    const e = val<{ srcKind: number; gate: number; epoch: number }>(r.entry);
    const pi = r.poolInfo;
    if (e === 'unknown') {
      // a pair that is not listed makes entryOf revert PoolNotAllowed: that is "not listed", not "couldn't check"
      out.v4Entry = failedWith(r.entry, NOT_LISTED_ERRORS)
        ? { listed: false, pairListed: false, srcKind: 0, gate: 0, swapsOpen: false, budgeted: false } : 'unknown';
    } else {
      const piOk = pi?.status === 'success' ? (pi.result as readonly [number, number, boolean, boolean]) : null;
      const pairListed = Number(e.epoch) > 0;
      out.v4Entry = {
        listed: pairListed && (pi === undefined || !!piOk), srcKind: Number(e.srcKind), gate: Number(piOk?.[0] ?? e.gate),
        swapsOpen: piOk ? !!piOk[2] : false, budgeted: piOk ? !!piOk[3] : false, pairListed,
      };
      if (out.v4Entry.listed && NC_SRC_KINDS.has(out.v4Entry.srcKind)) out.ncKey = autoCheckKey('v4', p.token0, p.token1);
    }
  }
  if ('hookEntry' in r) {
    const h = val<{ codehash: Hex; pinnedFee: number; maxSlippageBps: number; kind: number; requiredBits: number }>(r.hookEntry);
    if (h === 'unknown') out.hookEntry = 'unknown';
    else if (/^0x0{64}$/i.test(h.codehash)) out.hookEntry = null;
    else {
      const kind = Number(h.kind);
      out.hookEntry = {
        kind, maxSlippageBps: Number(h.maxSlippageBps), exitOnly: kind === 2 && (Number(h.requiredBits) & 0x0c00) !== 0,
        taxBps: kind === 3 ? Math.round(Number(h.pinnedFee) / 100) : 0, feeCapPips: kind === 1 ? Number(h.pinnedFee) : 0,
      };
    }
  }
  if ('gac4Pin' in r) {
    const g = val<Hex>(r.gac4Pin);
    out.gac4HookPin = g === 'unknown' ? 'unknown' : /^0x0{64}$/i.test(g) ? null : g;
  }
  if ('caps4' in r) {
    const c = val<readonly [bigint, bigint, bigint, bigint, bigint, bigint]>(r.caps4);
    const nn = val<{ ncIs0: boolean }>(r.ncsrc);
    if (c === 'unknown' || nn === 'unknown') out.swapCaps = 'unknown';
    else {
      const hard = BigInt(c[0]); const x = BigInt(c[3]);
      out.swapCaps = nn.ncIs0 ? { cap0: x, cap1: hard } : { cap0: hard, cap1: x };
    }
  }
  if ('budgetX' in r) {
    const b = val<readonly [bigint, bigint, bigint, bigint]>(r.budget);
    const bx = val<readonly [bigint, bigint, bigint, bigint]>(r.budgetX);
    const nn = val<{ capIn0: boolean }>(r.nc);
    if (b === 'unknown' || bx === 'unknown' || nn === 'unknown') out.swapCaps = 'unknown';
    else {
      const hard = BigInt(b[0]); const x = BigInt(bx[0]);
      out.swapCaps = nn.capIn0 ? { cap0: hard, cap1: x } : { cap0: x, cap1: hard };
    }
  }
  if ('red' in r) {
    const x = r.red;
    if (!x) out.redListed = 'unknown';
    else if (x.status === 'success') out.redListed = false;
    else out.redListed = REGISTRY_RED_ERRORS.test(String((x.error as { message?: string })?.message ?? x.error)) ? true : 'unknown';
  }
  if ('coverage' in r) {
    const c = val<readonly [boolean, boolean]>(r.coverage);
    const b = val<readonly [bigint, bigint, bigint, bigint]>(r.budget);
    const pr = val<{ gate: number; gateHighFee: number; feed0?: { proxy?: string } }>(r.pair);
    const nr = 'nc' in r ? val<{ refPool: string; gate: number; gateHighFee: number }>(r.nc) : undefined;
    if (c === 'unknown') out.v3Coverage = 'unknown';
    else {
      const high = p.fee > 3000;
      const gate = pr === 'unknown' ? 0 : Number(high ? pr.gateHighFee : pr.gate);
      const baseGate = pr === 'unknown' ? 0 : Number(pr.gate);
      const cov: Exclude<NonNullable<PoolFacts['v3Coverage']>, 'unknown'> = { pairListed: !!c[0], feeCovered: !!c[1], swapsOpen: b === 'unknown' ? true : BigInt(b[2]) > 0n, gate, baseGate };
      // a row with no Chainlink pair config and a reference pool in nc() is priced without Chainlink; a failed nc() read on
      // such a row cannot tell the two apart: "couldn't check", never offered on a guess
      const noCl = pr !== 'unknown' && zeroish(pr.feed0?.proxy);
      if (noCl && nr && nr !== 'unknown' && !zeroish(nr.refPool)) {
        Object.assign(cov, { nc: true, ncGate: Number(high ? nr.gateHighFee : nr.gate), ncBaseGate: Number(nr.gate) });
        if (cov.pairListed) out.ncKey = autoCheckKey('v3', p.token0, p.token1);
      }
      out.v3Coverage = noCl && nr === 'unknown' && cov.pairListed ? 'unknown' : cov;
    }
  }
  return out;
}

// ------------------------------------------------------------------ position facts

export interface PositionRef { id: bigint; venue: Venue }

/** Owner, permission, liquidity, range, pool key and every rule of the venue, 20 positions per multicall. */
export async function loadPositionFacts(chain: GoatChain, refs: readonly PositionRef[], env: Pick<GoatEnv, 'gates'>): Promise<PositionFacts[]> {
  const out: PositionFacts[] = [];
  for (let s = 0; s < refs.length; s += 20) {
    const chunk = refs.slice(s, s + 20);
    const calls: McCall[] = [];
    const plan: { i: number; field: string }[] = [];
    const push = (i: number, field: string, c: McCall) => { plan.push({ i, field }); calls.push(c); };
    chunk.forEach((p, i) => {
      const nft = p.venue === 'v4' ? { address: POSM, abi: posmAbi } : { address: NPM, abi: npmAbi };
      push(i, 'owner', { ...nft, functionName: 'ownerOf', args: [p.id] });
      push(i, 'approved', { ...nft, functionName: 'getApproved', args: [p.id] });
      if (p.venue === 'v4') {
        push(i, 'info', { address: POSM, abi: posmAbi, functionName: 'getPoolAndPositionInfo', args: [p.id] });
        push(i, 'liq', { address: POSM, abi: posmAbi, functionName: 'getPositionLiquidity', args: [p.id] });
      } else push(i, 'pos', { address: NPM, abi: npmAbi, functionName: 'positions', args: [p.id] });
      for (const [field, call] of ruleReads(p.venue, env, p.id)) push(i, field, call);
    });
    const res = await chain.multicall(calls).catch((error: unknown): McRes[] => calls.map(() => ({ status: 'failure', error })));
    const raw: Record<string, McRes>[] = chunk.map(() => ({}));
    plan.forEach((x, j) => { raw[x.i][x.field] = res[j]; });
    chunk.forEach((p, i) => out.push(positionFactsFrom(p, raw[i])));
  }
  return out;
}

/** Rule reads of the contracts whose gate is ok: [field, call]. Fields rule:<kind> and rule:<kind>Owner. */
function ruleReads(venue: Venue, env: Pick<GoatEnv, 'gates'>, id: bigint): [string, McCall][] {
  const r: [string, McCall][] = [];
  const g = env.gates;
  const pair = (kind: Kind, address: Address, abi: readonly unknown[], cfgFn: string, ownerFn: string) => {
    r.push([`rule:${kind}`, { address, abi, functionName: cfgFn, args: [id] }]);
    r.push([`rule:${kind}Owner`, { address, abi, functionName: ownerFn, args: [id] }]);
  };
  if (venue === 'v3') {
    if (g.autoCompoundV3.ok) pair('compound', GOAT_AUTO_COMPOUND_V3, gac3Abi, 'configs', 'configOwner');
    if (g.rangeExitV3.ok) pair('range', AUTO_RANGE_V3, autoRangeAbi, 'positionConfigs', 'positionConfigOwners');
    if (g.exitV3.ok) pair('exit', AUTO_EXIT_V3, autoExitAbi, 'positionConfigs', 'positionConfigOwners');
  } else {
    if (g.autoCompoundV4.ok) pair('compound', GOAT_AUTO_COMPOUND_V4, gac4Abi, 'configs', 'configOwner');
    if (g.rangeExitV4.ok) {
      r.push(['rule:range', { address: GOAT_V4_STEWARD, abi: stewardAbi, functionName: 'configOf', args: [id] }]);
      r.push(['preview', { address: GOAT_V4_STEWARD, abi: stewardAbi, functionName: 'previewTrigger', args: [id] }]);
    }
  }
  return r;
}

export const BURNED_RE = /NOT_MINTED|nonexistent token|NotMinted|invalid token ID/i;
export function isBurnedError(r: McRes | undefined): boolean {
  if (!r || r.status !== 'failure') return false;
  const e = r.error as { message?: string; shortMessage?: string; cause?: { message?: string } } | undefined;
  return BURNED_RE.test([e?.shortMessage, e?.message, e?.cause?.message, String(e)].filter(Boolean).join(' '));
}

/** v4 PositionInfo: ticks at bits 8 and 32 (int24), the subscriber flag in the low byte */
export function decodePositionInfo(info: bigint): { tickLower: number; tickUpper: number; subscriber: boolean } {
  const s24 = (x: bigint) => { const v = Number(x & 0xffffffn); return v >= 0x800000 ? v - 0x1000000 : v; };
  return { tickLower: s24(info >> 8n), tickUpper: s24(info >> 32n), subscriber: (info & 0xffn) !== 0n };
}

const V3_SPACING: Readonly<Record<number, number>> = { 100: 1, 500: 10, 3000: 60, 10000: 200 };

/** Map one position's raw reads to PositionFacts. Pure. */
export function positionFactsFrom(p: PositionRef, r: Record<string, McRes | undefined>): PositionFacts {
  const owner = val<Address>(r.owner);
  const approved = val<Address>(r.approved);
  let tickLower = 0; let tickUpper = 0; let tickSpacing = 1; let liquidity: Maybe<bigint> = 'unknown'; let subscriber: Maybe<boolean> | undefined;
  let token0: Address | undefined; let token1: Address | undefined; let fee: number | undefined; let hooks: Address | undefined;
  if (p.venue === 'v4') {
    const info = val<readonly [{ currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }, bigint]>(r.info);
    if (info !== 'unknown') {
      const d = decodePositionInfo(BigInt(info[1]));
      tickLower = d.tickLower; tickUpper = d.tickUpper; subscriber = d.subscriber; tickSpacing = Number(info[0].tickSpacing);
      token0 = info[0].currency0; token1 = info[0].currency1; fee = Number(info[0].fee); hooks = info[0].hooks;
    } else subscriber = 'unknown';
    const l = val<bigint>(r.liq); liquidity = l === 'unknown' ? 'unknown' : BigInt(l);
  } else {
    const pos = val<readonly unknown[]>(r.pos);
    if (pos !== 'unknown') {
      token0 = pos[2] as Address; token1 = pos[3] as Address; fee = Number(pos[4]);
      tickLower = Number(pos[5]); tickUpper = Number(pos[6]); liquidity = BigInt(pos[7] as bigint);
      tickSpacing = V3_SPACING[fee] ?? 1;
    }
  }
  const rules: PositionFacts['rules'] = {};
  const ownerOf = (k: string): Address | null => { const o = val<Address>(r[`rule:${k}Owner`]); return o === 'unknown' || isZero(o) ? null : o; };
  if ('rule:compound' in r) {
    const c = val<unknown>(r['rule:compound']);
    rules.compound = c === 'unknown' ? 'unknown' : p.venue === 'v4'
      ? ruleRead('compound', 'v4', toGac4(c), ownerOf('compound')) : ruleRead('compound', 'v3', toGac3(c), ownerOf('compound'));
  }
  if (p.venue === 'v4' && 'rule:range' in r) {
    const c = val<readonly [unknown, Address]>(r['rule:range']);
    if (c === 'unknown') { rules.range = 'unknown'; rules.exit = 'unknown'; }
    else {
      const cfg = toSt(c[0]); const own = isZero(c[1]) ? null : c[1];
      rules.range = ruleRead('range', 'v4', cfg, own); rules.exit = ruleRead('exit', 'v4', cfg, own);
    }
  } else {
    if ('rule:range' in r) { const c = val<unknown>(r['rule:range']); rules.range = c === 'unknown' ? 'unknown' : ruleRead('range', 'v3', toAr(c), ownerOf('range')); }
    if ('rule:exit' in r) { const c = val<unknown>(r['rule:exit']); rules.exit = c === 'unknown' ? 'unknown' : ruleRead('exit', 'v3', toAe(c), ownerOf('exit')); }
  }
  let preview: PositionFacts['preview'];
  if ('preview' in r && p.venue === 'v4') {
    const pv = val<readonly [boolean, boolean, Hex]>(r.preview);
    const ruleOn = (rules.range && rules.range !== 'unknown' && rules.range.on) || (rules.exit && rules.exit !== 'unknown' && rules.exit.on);
    if (pv !== 'unknown') preview = { ready: !!pv[0], upperSide: !!pv[1], reason: pv[2] };
    else if (ruleOn) preview = 'unknown';
  }
  const burned = owner === 'unknown' && isBurnedError(r.owner);
  return {
    id: p.id, venue: p.venue, owner, ...(burned ? { burned: true } : {}), approved: approved === 'unknown' ? 'unknown' : isZero(approved) ? null : approved,
    liquidity, tickLower, tickUpper, tickSpacing, ...(subscriber !== undefined ? { subscriber } : {}), rules, ...(preview !== undefined ? { preview } : {}),
    ...(token0 ? { token0, token1, fee } : {}), ...(hooks ? { hooks } : {}),
  };
}

/** Is a rule read on? Compound: enabled; v4: the Steward mode of the kind; v3 range: deltas differ; v3 exit: active. */
export function isOnRaw(kind: Kind, venue: Venue, cfg: unknown): boolean {
  if (!cfg) return false;
  if (kind === 'compound') return !!(cfg as { enabled: boolean }).enabled;
  if (venue === 'v4') return Number((cfg as { mode: number }).mode) === (kind === 'range' ? ST_MODE.RECENTER : ST_MODE.EXIT);
  if (kind === 'range') { const c = cfg as { lowerTickDelta: number; upperTickDelta: number }; return Number(c.lowerTickDelta) !== Number(c.upperTickDelta); }
  return !!(cfg as { isActive: boolean }).isActive;
}

function ruleRead(kind: Kind, venue: Venue, cfg: unknown, owner: Address | null): RuleRead {
  return { kind, venue, on: isOnRaw(kind, venue, cfg), owner, cfg } as RuleRead;
}

/** The kinds that are on with the position's owner as the rule's owner (a rule a previous owner set does not run). When
 *  no rule reads on but a slot could not be read: 'unknown' (a turn-on is then refused). */
export function onKindsOf(rules: PositionFacts['rules'], owner?: Maybe<Address> | null): Kind[] | 'unknown' {
  if (!rules) return [];
  const out: Kind[] = [];
  for (const k of ['range', 'exit', 'compound'] as const) {
    const r = rules[k];
    if (!r || r === 'unknown' || r.kind !== k || !r.on) continue;
    if (owner && owner !== 'unknown' && r.owner && !eqA(r.owner, owner)) continue;
    out.push(k);
  }
  if (out.length) return out;
  for (const k of ['range', 'exit', 'compound'] as const) if (rules[k] === 'unknown') return 'unknown';
  return out;
}

const tup = (c: unknown, names: string[]): Record<string, unknown> =>
  Array.isArray(c) ? Object.fromEntries(names.map((nm, i) => [nm, (c as unknown[])[i]])) : (c as Record<string, unknown>);
const num = (x: unknown) => Number(x as number);
const big = (x: unknown) => BigInt(x as bigint);

export function toGac3(c: unknown): Gac3Config {
  const o = tup(c, ['enabled', 'swapEnabled', 'maxSlippageBps', 'minInterval', 'lastRunAt', 'minReward0', 'minReward1']);
  return { enabled: !!o.enabled, swapEnabled: !!o.swapEnabled, maxSlippageBps: num(o.maxSlippageBps), minInterval: num(o.minInterval), lastRunAt: num(o.lastRunAt), minReward0: big(o.minReward0), minReward1: big(o.minReward1) };
}
export function toGac4(c: unknown): Gac4Config {
  const o = tup(c, ['enabled', 'claimOnly', 'allowStandingApproval', 'maxSlippageBps', 'minInterval', 'lastRunAt', 'minLiquidityDelta']);
  return { enabled: !!o.enabled, claimOnly: !!o.claimOnly, allowStandingApproval: !!o.allowStandingApproval, maxSlippageBps: num(o.maxSlippageBps), minInterval: num(o.minInterval), lastRunAt: num(o.lastRunAt), minLiquidityDelta: big(o.minLiquidityDelta) };
}
export function toSt(c: unknown): StewardConfig {
  const o = tup(c, ['mode', 'triggerTicks', 'slippageBps', 'minInterval', 'budget', 'lastRunAt', 'flags', 'lowerTrigger', 'upperTrigger', 'pairEpoch', 'maxSwapFeePips']);
  return { mode: num(o.mode), triggerTicks: num(o.triggerTicks), slippageBps: num(o.slippageBps), minInterval: num(o.minInterval), budget: num(o.budget), lastRunAt: num(o.lastRunAt), flags: num(o.flags), lowerTrigger: num(o.lowerTrigger), upperTrigger: num(o.upperTrigger), pairEpoch: num(o.pairEpoch), maxSwapFeePips: num(o.maxSwapFeePips) };
}
export function toAr(c: unknown): ArConfig {
  const o = tup(c, ['lowerTickLimit', 'upperTickLimit', 'lowerTickDelta', 'upperTickDelta', 'token0SlippageX64', 'token1SlippageX64', 'onlyFees', 'autoCompound', 'maxRewardX64']);
  return { lowerTickLimit: num(o.lowerTickLimit), upperTickLimit: num(o.upperTickLimit), lowerTickDelta: num(o.lowerTickDelta), upperTickDelta: num(o.upperTickDelta), token0SlippageX64: big(o.token0SlippageX64), token1SlippageX64: big(o.token1SlippageX64), onlyFees: !!o.onlyFees, autoCompound: !!o.autoCompound, maxRewardX64: big(o.maxRewardX64) };
}
export function toAe(c: unknown): AeConfig {
  const o = tup(c, ['isActive', 'token0Swap', 'token1Swap', 'token0TriggerTick', 'token1TriggerTick', 'token0SlippageX64', 'token1SlippageX64', 'onlyFees', 'maxRewardX64']);
  return { isActive: !!o.isActive, token0Swap: !!o.token0Swap, token1Swap: !!o.token1Swap, token0TriggerTick: num(o.token0TriggerTick), token1TriggerTick: num(o.token1TriggerTick), token0SlippageX64: big(o.token0SlippageX64), token1SlippageX64: big(o.token1SlippageX64), onlyFees: !!o.onlyFees, maxRewardX64: big(o.maxRewardX64) };
}

/** The v3 pool address of (token0, token1, fee), read from the factory */
export async function v3PoolOf(chain: GoatChain, token0: Address, token1: Address, fee: number): Promise<Address | null> {
  try {
    const a = await chain.read<Address>({ address: V3_FACTORY, abi: v3FactoryAbi, functionName: 'getPool', args: [token0, token1, fee] });
    return isZero(a) ? null : a;
  } catch { return null; }
}

/** The pool facts a position implies (v3: pool from the factory; v4: the pool key and its id) */
export async function poolOfPosition(chain: GoatChain, p: PositionFacts): Promise<PoolFacts | null> {
  if (!p.token0 || !p.token1 || p.fee === undefined) return null;
  if (p.venue === 'v3') {
    const pool = await v3PoolOf(chain, p.token0, p.token1, p.fee);
    return { venue: 'v3', token0: p.token0, token1: p.token1, fee: p.fee, tickSpacing: p.tickSpacing, ...(pool ? { pool } : {}) };
  }
  const hooks = p.hooks ?? ZERO_ADDRESS;
  const poolId = poolIdOf({ currency0: p.token0, currency1: p.token1, fee: p.fee, tickSpacing: p.tickSpacing, hooks });
  return { venue: 'v4', token0: p.token0, token1: p.token1, fee: p.fee, tickSpacing: p.tickSpacing, hooks, poolId };
}

// Hook, token and pair rules of the automation tools (fail closed).
//  - A v4 pool is offered for auto-range and auto-exit only when it has no hook, or when its hook is on the reviewed list
//    with its pinned code hash read on chain (and, in eligibility, the GoatV4PairRegistry has an entry for the pool).
//  - Auto-compound follows GoatAutoCompoundV4's own on-chain reviewed list: the hook's live code hash must equal the code
//    hash that contract records for it. The Doppler hook and the hooks kept to deposits only are never offered.
//  - Any other hook, a hook without code, or a code hash that differs is "Hook not reviewed"; an unread code hash is
//    "couldn't check", never offered.
import type { Address, Hex } from 'viem';
import { DOPPLER_CODEHASH, DOPPLER_HOOK, DOPPLER_POOL_IDS, TRANSFER_TAX_TOKENS, type TransferRecord } from './hookData';
import type { Maybe, PoolFacts, Venue } from './types';

const ZERO_RE = /^0x0{40}$/i;
const lc = (s: string) => s.toLowerCase();

/** Hooks reviewed for automation: address and the code hash pinned at review */
export const REVIEWED_HOOKS: readonly { address: string; codehash: string; label: string }[] = [
  { address: '0x06a889870c8f83640d6816319f72e2aa579b6080', codehash: '0x0430617b26dfc5c3f6be1e1733304c6050c6b6ba9d0fb950b57070b5b2a96db4', label: 'ETH/USDG fee hook' },
  { address: '0xa0e8fbff13e24af2b5e61a72800e08a161bde080', codehash: '0x336405ef8a51dd6b02b53eb46fccddc87bf15dbd0a16b3d86fccc3e0298eca73', label: 'SPY/USDG fee hook' },
  { address: '0x67d86050d22d574df046f3d90f722045f714e080', codehash: '0xa40a02521b3a20e56851d833baf5baf0ee258e954c0f4e3f96e1bd30c8681db3', label: 'TSLA/USDG fee hook' },
  { address: '0x70a9a88402989226847ec122043ce5e7ff462080', codehash: '0x165ccaced1f37263fd1a36b051c43d1759bab3005c2f7083ab32ee2db3b217e3', label: 'USDG/AAPL fee hook' },
  { address: '0x08e52564bad99e05a694b4809f397edca417a080', codehash: '0xbb52b2dc4a14fc6c3f90d0a268b51680d7adbdaa392b211bc524b6fd9368bb85', label: 'PONS/USDG fee hook' },
  { address: '0xb608a78761f179f7c56f15e7d13921b92f00a080', codehash: '0x514b632f9bb987403ca7a3fb35780b2c092726a437c1efbb4479fd612549d25b', label: 'USDG/GLD fee hook' },
  { address: '0x5eb87f69be00df39981622fd60a8de4b7837e080', codehash: '0x577978ad29223268205cb40a5215c46839f5c27a1218beac7d4a0f7cd0aaa341', label: 'SPCX/USDG, USDG/CRCL and AMZN/USDG fee hook' },
];

/** Hooks kept to deposits only: auto-compound is never offered on them, whatever GoatAutoCompoundV4's list says */
export const COMPOUND_DENY_HOOKS: ReadonlySet<string> = new Set([
  '0x66622f77b797d506e5376f7798b67ab288966080',
  '0x79576fbad6e83915630bbb5d5658483f05532080',
  '0xca89f079af00f752bfd3c345358dc38d4d73e080',
]);

export { DOPPLER_HOOK };
const DOPPLER_POOLS: ReadonlySet<string> = new Set(DOPPLER_POOL_IDS);

/** The code hash the reviewed list pins for (hook, poolId), or null when the hook is not on the list. */
export function reviewedHookPin(hook: string | null | undefined, poolId?: string | null): string | null {
  if (!hook || ZERO_RE.test(hook)) return null;
  const e = REVIEWED_HOOKS.find((x) => x.address === lc(hook));
  if (e) return lc(e.codehash);
  if (lc(hook) === DOPPLER_HOOK && poolId && DOPPLER_POOLS.has(lc(poolId))) return DOPPLER_CODEHASH;
  return null;
}

export type HookReview = 'none' | 'reviewed' | 'not-reviewed' | 'unread';

/** Review state of a pool's hook for auto-range and auto-exit. */
export function hookReview(f: Pick<PoolFacts, 'venue' | 'hooks' | 'poolId'> & { hookCodeHash?: Maybe<Hex | null> }): HookReview {
  if (f.venue !== 'v4' || !f.hooks || ZERO_RE.test(f.hooks)) return 'none';
  const pin = reviewedHookPin(f.hooks, f.poolId);
  if (!pin) return 'not-reviewed';
  const h = f.hookCodeHash;
  if (h === undefined || h === 'unknown') return 'unread';
  if (h === null) return 'not-reviewed';
  return lc(h) === pin ? 'reviewed' : 'not-reviewed';
}

/** Should the loader read this hook's code hash (it is on the reviewed list)? */
export const needsHookCodeHash = (f: Pick<PoolFacts, 'venue' | 'hooks' | 'poolId'>): boolean =>
  f.venue === 'v4' && !!reviewedHookPin(f.hooks, f.poolId);

/** Review state of a pool's hook for auto-compound (GoatAutoCompoundV4's on-chain list). */
export function compoundHookReview(f: Pick<PoolFacts, 'venue' | 'hooks' | 'poolId' | 'hookCodeHash' | 'gac4HookPin'>): HookReview {
  if (f.venue !== 'v4' || !f.hooks || ZERO_RE.test(f.hooks)) return 'none';
  if (lc(f.hooks) === DOPPLER_HOOK || COMPOUND_DENY_HOOKS.has(lc(f.hooks))) return 'not-reviewed';
  const pin = f.gac4HookPin;
  if (pin === undefined || pin === 'unknown') return 'unread';
  if (pin === null || /^0x0{64}$/i.test(pin)) return 'not-reviewed';
  const h = f.hookCodeHash;
  if (h === undefined || h === 'unknown') return 'unread';
  if (h === null) return 'not-reviewed';
  return lc(h) === lc(pin) ? 'reviewed' : 'not-reviewed';
}

/** Should the loader read GoatAutoCompoundV4's list entry and the code hash of this hook? */
export const needsCompoundHookRead = (f: Pick<PoolFacts, 'venue' | 'hooks'>): boolean =>
  f.venue === 'v4' && !!f.hooks && !ZERO_RE.test(f.hooks) && lc(f.hooks) !== DOPPLER_HOOK && !COMPOUND_DENY_HOOKS.has(lc(f.hooks));

/** Hooks with their own auto-compound line */
export type HookClass = 'cut-25' | 'cut-9' | 'claim-only' | 'no-lp-fee';
const HOOK_CLASS: Readonly<Record<string, HookClass>> = {
  '0x64e9ae1066c47ac4a3cc0a5bd7b135908590e088': 'cut-25',
  '0xcb787a5cdea8b3715d984d82f1203fd7bfebe0c4': 'cut-9',
  '0x4445520306c9c70952bdfec28f3989f53d9f80c4': 'claim-only',
  '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044': 'no-lp-fee',
  '0x745d717620052a97a22deee2e5eba59583f3e0cc': 'no-lp-fee',
};
export const hookClassOf = (hook: string | null | undefined): HookClass | null => (hook ? HOOK_CLASS[lc(hook)] ?? null : null);

/** Permission bits of a v4 hook address (its low 14 bits) */
export function hookPermissionBits(hook: Address | undefined): number {
  if (!hook || !/^0x[0-9a-fA-F]{40}$/.test(hook)) return 0;
  return parseInt(hook.slice(-4), 16) & ((1 << 14) - 1);
}

// ------------------------------------------------------------------ pairs priced without Chainlink

/** The keeper's list of pairs priced without Chainlink that it double-checks against the pair's other pools. `offered` =
 *  auto-range and swap exits are offered on it; any other such pair runs exits without a swap only. */
export const AUTO_CHECK_PAIRS: readonly { key: string; pair: string; offered: boolean }[] = [
  { key: 'nc:0x020bfc650a365f8bb26819deaabf3e21291018b4:0x0bd7d308f8e1639fab988df18a8011f41eacad73', pair: 'CASHCAT/WETH', offered: false },
  { key: 'nc:0x0bd7d308f8e1639fab988df18a8011f41eacad73:0x39dbed3a2bd333467115de45665cc57f813c4571', pair: 'WETH/PONS', offered: false },
  { key: 'nc:0x5fc5360d0400a0fd4f2af552add042d716f1d168:0xccee82fe024c36fa15e1005ede3e9e4787e23d09', pair: 'USDG/HIMS', offered: false },
  { key: 'v4nc:0x39dbed3a2bd333467115de45665cc57f813c4571:0x5fc5360d0400a0fd4f2af552add042d716f1d168', pair: 'PONS/USDG', offered: true },
  { key: 'nc:0x05b37fb53a299a1b874a619e1c4c404d52c36f4c:0x5fc5360d0400a0fd4f2af552add042d716f1d168', pair: 'RDDT/USDG', offered: false },
  { key: 'nc:0x0bd7d308f8e1639fab988df18a8011f41eacad73:0x2e8c31162b855a2ffa90f6f8634643ad6f111e18', pair: 'WETH/AI', offered: false },
  { key: 'nc:0x0bd7d308f8e1639fab988df18a8011f41eacad73:0x5cb6f181081301b44905f3ae15419112ecabd8a6', pair: 'WETH/PIPEDOG', offered: false },
  { key: 'nc:0x0bd7d308f8e1639fab988df18a8011f41eacad73:0xe8ffd7e24187f72afb08d75b1bb13088a989a791', pair: 'WETH/DELTA', offered: false },
  { key: 'nc:0x4ea005168d7f09a7a0ba9d1def21a479950e44c2:0x5fc5360d0400a0fd4f2af552add042d716f1d168', pair: 'COST/USDG', offered: false },
];

/** The keeper's key of a pair (lower case, token0 below token1) */
export function autoCheckKey(venue: Venue, tokenA: string, tokenB: string): string {
  const a = lc(tokenA);
  const b = lc(tokenB);
  const [lo, hi] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  return `${venue === 'v4' ? 'v4nc' : 'nc'}:${lo}:${hi}`;
}
export const autoCheckOffered = (key: string): boolean => AUTO_CHECK_PAIRS.some((p) => p.key === key && p.offered);

// ------------------------------------------------------------------ tokens that keep a cut when they move

/**
 * Pairs where auto-compound is closed on one venue because their pools there are too small (token order does not matter).
 * The list is empty today; a row closes auto-compound for every pool of that pair on that venue.
 */
export interface ThinVenue { label: string; venue: Venue; a: string; b: string }
export const THIN_COMPOUND_VENUES: readonly ThinVenue[] = [];

export function isThinCompoundPool(f: Pick<PoolFacts, 'venue' | 'token0' | 'token1'>, list: readonly ThinVenue[] = THIN_COMPOUND_VENUES): boolean {
  const x = lc(f.token0), y = lc(f.token1);
  return list.some((t) => t.venue === f.venue && ((lc(t.a) === x && lc(t.b) === y) || (lc(t.a) === y && lc(t.b) === x)));
}

/** Token entries of the automation red list */
export const RED_LIST_TOKENS: readonly string[] = ['0xa65d0267c8637fcc46ff91e48de766721c750fe3'];

const pos = (x: number | null | undefined) => typeof x === 'number' && x > 0;
const BY_TOKEN: ReadonlyMap<string, TransferRecord> = new Map(TRANSFER_TAX_TOKENS.map((r) => [r.token, r]));

/** Does the token keep a cut (or fail) when it moves at this venue? v4: through the PoolManager; v3: the pool. */
export function transferBlocked(token: string, venue: Venue): boolean {
  const st = BY_TOKEN.get(lc(token));
  if (!st) return false;
  if (venue === 'v4') {
    const out = st.from_pm_bps ?? null;
    if (st.from_pm_reverts || st.to_pm_reverts) return true;
    if (pos(out) || pos(st.to_pm_bps)) return true;
    // a token known to keep a cut whose behaviour here was not measured fails closed
    return !!(st.venue_unknown || out === null || st.to_pm_bps === null || st.to_pm_bps === undefined);
  }
  const v3 = st.v3_largest_pool;
  if (!v3) return true;
  if (v3.from_pool_reverts) return true;
  if (pos(v3.from_pool_bps) || pos(v3.to_pool_bps)) return true;
  return v3.from_pool_bps === null || v3.from_pool_bps === undefined || v3.to_pool_bps === null || v3.to_pool_bps === undefined;
}

/** A token of the pool keeps a cut when it moves: the fact when read, else the red list and the measured table. */
export function transferTaxOf(f: Pick<PoolFacts, 'venue' | 'token0' | 'token1' | 'transferTax'>): boolean {
  if (f.transferTax === true) return true;
  if (f.transferTax === false) return false;
  if (RED_LIST_TOKENS.includes(lc(f.token0)) || RED_LIST_TOKENS.includes(lc(f.token1))) return true;
  return [f.token0, f.token1].some((t) => !ZERO_RE.test(t) && transferBlocked(t, f.venue));
}

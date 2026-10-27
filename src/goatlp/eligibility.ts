// Which automations a pool and a position can have, and why not. One function family for the read tools and the write
// tools. Rule order is the priority of the reason given:
//  1. the contract's code-hash check (not live = nothing can be sent).
//  2. pool-wide blocks for every kind: the registry's red list, a hook that can change what a withdrawal returns, a dynamic
//     fee without a hook, and the hook rule of ./hooks.ts (an unread code hash = "couldn't check").
//  3. a price reference for every kind: auto-compound needs Chainlink for both tokens or a deep anchor pool; v4 auto-range /
//     auto-exit need a listed registry entry with a price source; v3 ones need the pair table to cover the fee tier.
//  4. kind-specific limits: no new deposits, unlisted pools, closed swaps, transfer-tax tokens, taxed pools, reviewed hooks.
//  5. position level: owner, empty, subscriber, one automation at a time, full range, too narrow, size, paused, retired.
// A fact that was not read adds no line; a fact whose read failed adds a "couldn't check" block, never an "off".
import type { Address } from 'viem';
import { getSqrtRatioAtTick } from './lp/tickMath';
import { amountsForLiquidityUp } from './lp/liquidity';
import { BOUNDS, CAP_UNLIMITED, RANGE_MIN_MOVABLE_USD, hasPriceSource } from './constants';
import { ELIG, oneAtATimeText, pctOfBps, pctOfPips, pctOfTicks } from './copy';
import { autoCheckOffered, compoundHookReview, hookClassOf, hookPermissionBits, hookReview, transferTaxOf } from './hooks';
import { KINDS } from './types';
import type {
  ContractFacts, ContractGates, Kind, KindLimits, KindVerdict, Line, PoolFacts, PoolVerdict, PositionFacts, Venue,
} from './types';
import { contractFor } from './calldata';
import { minWidth } from './validate';

export const LIQUIDITY_RETURN_DELTA_MASK = 0x0003;
export const DYNAMIC_FEE_FLAG = 0x800000;
/** v4 pools without a hook are listed for automation only up to a 1% fee and a tick spacing of 200 */
export const V4_LISTED_MAX_FEE_PIPS = 10_000;
export const V4_LISTED_MAX_TICK_SPACING = 200;

const ZERO_RE = /^0x0{40}$/i;
const isZeroAddr = (a: string | undefined) => !a || ZERO_RE.test(a);

export const minWidthTicks = minWidth;

const line = (code: Line['code'], level: Line['level'], text: string, why?: string): Line => (why ? { code, level, text, why } : { code, level, text });
const hasBlock = (lines: readonly Line[]) => lines.some((l) => l.level === 'block' && l.code !== 'NOT_LIVE');

/** The pair's gate G in ticks, read on chain; 0 when it was not read (never a guessed default). */
function gateOf(f: PoolFacts): number {
  if (f.venue === 'v4' && f.v4Entry && f.v4Entry !== 'unknown' && f.v4Entry.listed && f.v4Entry.gate > 0) return f.v4Entry.gate;
  if (f.venue === 'v3' && f.v3Coverage && f.v3Coverage !== 'unknown' && f.v3Coverage.gate > 0) return f.v3Coverage.gate;
  return 0;
}

/**
 * The gate of a withdraw-only exit in a pool the pair's rule does not cover (a v4 pool of a listed pair that is not itself
 * listed; a v3 fee tier whose own gate is 0): v4 the pair entry's gate, v3 the row's normal gate (or the gate of a row priced
 * without Chainlink). 0 when unread.
 */
export function withdrawOnlyExitGate(f: PoolFacts): number {
  if (f.venue === 'v4') {
    const e = f.v4Entry;
    return e && e !== 'unknown' && (e.pairListed ?? e.listed) && Number.isInteger(e.gate) && e.gate > 0 ? e.gate : 0;
  }
  const c = f.v3Coverage;
  if (!c || c === 'unknown' || !c.pairListed) return 0;
  if (typeof c.baseGate === 'number' && Number.isInteger(c.baseGate) && c.baseGate > 0) return c.baseGate;
  return c.nc === true && typeof c.ncBaseGate === 'number' && Number.isInteger(c.ncBaseGate) && c.ncBaseGate > 0 ? c.ncBaseGate : 0;
}

export function ncPairKey(f: PoolFacts): string | null {
  return typeof f.ncKey === 'string' && /^(nc|v4nc):0x[0-9a-f]{40}:0x[0-9a-f]{40}$/.test(f.ncKey) ? f.ncKey : null;
}

/** The pool's price protection cap for auto-range / auto-exit: a reviewed hook's own, else 1% */
function poolMaxSlip(f: PoolFacts): number {
  if (f.venue === 'v4' && f.hookEntry && f.hookEntry !== 'unknown' && f.hookEntry.maxSlippageBps > 0) return f.hookEntry.maxSlippageBps;
  return BOUNDS.steward.hookFreeMaxSlippageBps;
}

/**
 * Usable size per pair: the one-token principal (all token0 below the range, all token1 above it) against that token's
 * swap cap. Auto-range keeps half of a finite cap free, a swap exit may use all of it. A warning, never a block by itself.
 */
export function usableShare(p: Pick<PositionFacts, 'liquidity' | 'tickLower' | 'tickUpper'>, caps: { cap0: bigint; cap1: bigint } | undefined, valueUsd?: number): { share: number; capUsd: number | null } | null {
  if (!caps || p.liquidity === 'unknown' || p.liquidity <= 0n || p.tickUpper <= p.tickLower) return null;
  let sa: bigint; let sb: bigint;
  try { sa = getSqrtRatioAtTick(p.tickLower); sb = getSqrtRatioAtTick(p.tickUpper); } catch { return null; }
  const full0 = amountsForLiquidityUp(sa, sa, sb, p.liquidity).amount0;
  const full1 = amountsForLiquidityUp(sb, sa, sb, p.liquidity).amount1;
  let best: { share: number; capUsd: number | null } | null = null;
  for (const [amt, cap] of [[full0, caps.cap0], [full1, caps.cap1]] as const) {
    if (cap === 0n || cap >= CAP_UNLIMITED || amt <= 0n) continue;
    const share = Number((amt * 1_000_000n) / cap) / 1_000_000;
    const capUsd = typeof valueUsd === 'number' && Number.isFinite(valueUsd) && valueUsd > 0 && share > 0 ? valueUsd / share : null;
    if (!best || share > best.share) best = { share, capUsd };
  }
  return best;
}
const usdShort = (v: number | null): string | null => (v === null ? null : `$${v >= 1000 ? Math.round(v).toLocaleString('en-US') : v.toFixed(0)}`);

function kindPool(kind: Kind, f: PoolFacts, gates: ContractGates): KindVerdict {
  const lines: Line[] = [];
  const limits: KindLimits = {};
  const gate = gates[contractFor(kind, f.venue)];
  const live = gate.ok;
  if (!live) lines.push(line('NOT_LIVE', 'block', ELIG.NOT_LIVE, gate.reason));
  const isV4 = f.venue === 'v4';
  const hooks = isV4 ? f.hooks : undefined;
  const hooksRead = !isV4 || hooks !== undefined;
  const hooked = isV4 && hooksRead && !isZeroAddr(hooks);
  const g = gateOf(f);
  limits.gateTicks = g;
  limits.poolFeePips = f.fee & DYNAMIC_FEE_FLAG ? undefined : f.fee;
  if (kind === 'compound') limits.maxSlippageBps = isV4 ? BOUNDS.gac4.maxSlippageBps : BOUNDS.gac3.maxSlippageBps;
  else limits.maxSlippageBps = poolMaxSlip(f);
  if (kind !== 'compound' && f.swapCaps && f.swapCaps !== 'unknown') limits.swapCaps = f.swapCaps;
  if (kind === 'range' && g > 0) limits.minWidthTicks = minWidthTicks(g, f.tickSpacing);
  if (isV4 && kind !== 'compound') limits.maxSwapFeeEditable = (f.fee & DYNAMIC_FEE_FLAG) !== 0;

  // 2. pool-wide blocks
  if (f.redListed === true) lines.push(line('RED_LISTED', 'block', ELIG.RED_LISTED));
  if (hooked && (hookPermissionBits(hooks) & LIQUIDITY_RETURN_DELTA_MASK) !== 0) {
    lines.push(line('HOOK_RETURN_DELTA', 'block', kind === 'compound' ? ELIG.HOOK_RETURN_DELTA_COMPOUND : ELIG.HOOK_RETURN_DELTA));
  }
  if (isV4 && hooksRead && !hooked && (f.fee & DYNAMIC_FEE_FLAG) !== 0) lines.push(line('DYNAMIC_FEE_NO_HOOK', 'block', ELIG.DYNAMIC_FEE_NO_HOOK));
  if (isV4 && !hooksRead && live) lines.push(line('UNKNOWN', 'block', ELIG.UNKNOWN));
  if (f.redListed === 'unknown' && live) lines.push(line('UNKNOWN', 'block', ELIG.UNKNOWN));
  const hr = kind === 'compound' ? compoundHookReview(f) : hookReview(f);
  const hookClass = hooked ? hookClassOf(hooks) : null;
  if (hr === 'not-reviewed') {
    lines.push(line('UNREVIEWED_HOOK', 'block', kind === 'compound' && hookClass === 'no-lp-fee' ? ELIG.HOOK_NO_LP_FEE : ELIG.UNREVIEWED_HOOK_BLOCK));
  } else if (hr === 'unread' && live) lines.push(line('UNKNOWN', 'block', ELIG.UNKNOWN));
  if (kind === 'compound' && hr === 'reviewed') {
    if (hookClass === 'cut-25') lines.push(line('HOOK_CUT', 'info', ELIG.HOOK_CUT('0.25%')));
    if (hookClass === 'cut-9') lines.push(line('HOOK_CUT', 'info', ELIG.HOOK_CUT('0.09%')));
    if (hookClass === 'claim-only') { lines.push(line('HOOK_CLAIM_ONLY', 'limit', ELIG.HOOK_CLAIM_ONLY)); limits.claimOnly = true; }
    const he = f.hookEntry;
    const cap = he && he !== 'unknown' && he.feeCapPips > 0 ? he.feeCapPips : 0;
    lines.push(line('HOOK_SLIP_HINT', 'info', cap ? ELIG.HOOK_SLIP(pctOfBps(Math.ceil(cap / 100) + 50)) : ELIG.HOOK_SLIP_GENERIC));
  }

  // 3. price reference
  const noRef = () => line('NO_PRICE_REFERENCE', 'block', ELIG.NO_PRICE_REFERENCE);
  if (kind === 'compound') {
    const ca = f.compoundAnchor;
    if (ca === 'unknown') { if (live) lines.push(line('UNKNOWN', 'block', ELIG.UNKNOWN)); }
    else if (ca && !ca.chainlinkBoth && !ca.anchorPool) lines.push(noRef());
    else if (ca && !ca.chainlinkBoth && ca.selfAnchor) lines.push(line('SELF_ANCHOR', 'limit', ELIG.SELF_ANCHOR));
  } else if (isV4) {
    const e = f.v4Entry;
    if (e === 'unknown') { if (live) lines.push(line('UNKNOWN', 'block', ELIG.UNKNOWN)); }
    else if (e && (!e.listed || !hasPriceSource(e.srcKind))) {
      // a listed pair whose pool is not listed (or an exit-only row): withdraw-only exit; an unlisted pair: nothing
      const pairListed = e.pairListed ?? e.listed;
      if (kind === 'exit' && pairListed) { lines.push(line('NO_PRICE_REFERENCE', 'limit', ELIG.UNLISTED_POOL)); limits.exitWithdrawOnly = true; }
      else lines.push(noRef());
    }
  } else {
    const c = f.v3Coverage;
    if (c === 'unknown') { if (live) lines.push(line('UNKNOWN', 'block', ELIG.UNKNOWN)); }
    else if (c && (!c.pairListed || !c.feeCovered)) {
      if (kind === 'exit' && c.pairListed) { lines.push(line('NO_PRICE_REFERENCE', 'limit', ELIG.UNLISTED_POOL)); limits.exitWithdrawOnly = true; }
      else lines.push(noRef());
    }
  }

  // 4. kind-specific
  if (kind !== 'compound') {
    const swapLimit = (code: Line['code'], rangeText: string, exitText: string) => {
      if (kind === 'range') lines.push(line(code, 'block', rangeText));
      else { lines.push(line(code, 'limit', exitText)); limits.exitWithdrawOnly = true; }
    };
    const he = isV4 ? f.hookEntry : undefined;
    if (isV4 && hooked && he && he !== 'unknown' && he.exitOnly && kind === 'range') lines.push(line('HOOK_NO_NEW_DEPOSITS', 'block', ELIG.HOOK_NO_NEW_DEPOSITS));
    // reviewed by this package's list but not in the registry's hook list: the Steward cannot run it
    if (isV4 && hooked && he === null && hr === 'reviewed') lines.push(line('UNLISTED_POOL', 'block', ELIG.UNLISTED_POOL_BLOCK));
    if (isV4 && hooked && he === 'unknown' && hr === 'reviewed' && live) lines.push(line('UNKNOWN', 'block', ELIG.UNKNOWN));
    if (isV4 && hooksRead && !hooked && ((f.fee & ~DYNAMIC_FEE_FLAG) > V4_LISTED_MAX_FEE_PIPS || f.tickSpacing > V4_LISTED_MAX_TICK_SPACING)) {
      swapLimit('UNLISTED_POOL', ELIG.UNLISTED_POOL_BLOCK, ELIG.UNLISTED_POOL);
    }
    const swapsClosed = isV4
      ? f.v4Entry && f.v4Entry !== 'unknown' && f.v4Entry.listed && hasPriceSource(f.v4Entry.srcKind) && !f.v4Entry.swapsOpen
      : f.v3Coverage && f.v3Coverage !== 'unknown' && f.v3Coverage.pairListed && f.v3Coverage.feeCovered && !f.v3Coverage.swapsOpen;
    if (swapsClosed) swapLimit('SWAPS_CLOSED', ELIG.SWAPS_CLOSED, ELIG.SWAPS_CLOSED_EXIT);
    // a pair priced without Chainlink runs auto-range and swap exits only where the keeper double-checks its price
    const ncKey = ncPairKey(f);
    if (ncKey && !autoCheckOffered(ncKey) && !(kind === 'exit' ? limits.exitWithdrawOnly : hasBlock(lines))) swapLimit('NO_PRICE_CHECK', ELIG.NO_PRICE_CHECK, ELIG.NO_PRICE_CHECK);
    if (transferTaxOf(f)) swapLimit('TRANSFER_TAX_TOKEN', ELIG.TRANSFER_TAX_TOKEN_BLOCK, ELIG.TRANSFER_TAX_TOKEN);
    if (isV4 && hooked && he && he !== 'unknown') {
      if (he.taxBps > 0) lines.push(line('TAXED_POOL', 'info', ELIG.TAXED_POOL(pctOfBps(he.taxBps))));
      if (!he.exitOnly && he.feeCapPips > 0) lines.push(line('REVIEWED_HOOK', 'info', ELIG.REVIEWED_HOOK(pctOfPips(he.feeCapPips), pctOfBps(poolMaxSlip(f)))));
    }
  }
  if (kind === 'exit' && limits.exitWithdrawOnly && !(g > 0)) {
    const wg = withdrawOnlyExitGate(f);
    if (wg > 0) limits.gateTicks = wg;
  }
  return { live, offered: !hasBlock(lines), lines: sortLines(lines), limits };
}

/** Pool verdict: each kind offered or not, with the reasons and the pair's limits. */
export function poolVerdict(f: PoolFacts, gates: ContractGates): PoolVerdict {
  return { venue: f.venue, kinds: { compound: kindPool('compound', f, gates), range: kindPool('range', f, gates), exit: kindPool('exit', f, gates) } };
}

export interface PositionCtx {
  /** the signer (undefined = none, every kind gets NOT_OWNER) */
  account?: Address;
  /** the kinds that are on for this position; 'unknown' = a rule slot could not be read */
  onKinds?: readonly Kind[] | 'unknown';
  contracts?: ContractFacts;
  valueUsd?: number;
  /** the minimum position size in USD (the served policy figure, else 50) */
  minUsd?: number;
}

const eqA = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

const underMinUsd = (v: number | null | undefined, min: number): boolean => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < min;

export function isFullRange(tickLower: number, tickUpper: number, tickSpacing: number | null): boolean {
  const ts = tickSpacing && tickSpacing > 0 ? tickSpacing : 1;
  return tickLower <= BOUNDS.tick.min + ts && tickUpper >= BOUNDS.tick.max - ts;
}

/** Position verdict = pool verdict + the position-level reasons. */
export function positionVerdict(pv: PoolVerdict, p: PositionFacts, ctx: PositionCtx = {}): PoolVerdict {
  const kinds = {} as Record<Kind, KindVerdict>;
  const on = ctx.onKinds;
  for (const k of KINDS) {
    const src = pv.kinds[k];
    const lines = [...src.lines];
    const limits: KindLimits = { ...src.limits };
    const add = (l: Line) => lines.push(l);
    if (p.owner !== 'unknown' && (!ctx.account || !eqA(p.owner, ctx.account))) add(line('NOT_OWNER', 'block', ELIG.NOT_OWNER));
    if (p.owner === 'unknown' && src.live) add(line('UNKNOWN', 'block', ELIG.UNKNOWN));
    if (p.liquidity === 0n) add(line('EMPTY', 'block', ELIG.EMPTY));
    if (p.venue === 'v4' && p.subscriber === true) add(line('SUBSCRIBER', 'block', ELIG.SUBSCRIBER));
    if (on === 'unknown') { if (src.live) add(line('UNKNOWN', 'block', ELIG.UNKNOWN)); }
    else {
      const others = (on ?? []).filter((o) => o !== k);
      if (others.length) add(line('ONE_AT_A_TIME', 'block', oneAtATimeText(others[0], k, p.venue)));
    }
    const full = isFullRange(p.tickLower, p.tickUpper, p.tickSpacing);
    if (k !== 'compound' && full) add(line('FULL_RANGE', 'block', ELIG.FULL_RANGE));
    if (k === 'range' && limits.minWidthTicks && p.tickUpper - p.tickLower < limits.minWidthTicks && !full) {
      const minPct = pctOfTicks(limits.minWidthTicks);
      if (p.venue === 'v4') add(line('TOO_NARROW', 'block', ELIG.TOO_NARROW_V4(minPct)));
      else add(line('TOO_NARROW', 'limit', ELIG.TOO_NARROW_V3(minPct)));
    }
    const minUsd = typeof ctx.minUsd === 'number' && ctx.minUsd > 0 ? ctx.minUsd : RANGE_MIN_MOVABLE_USD;
    const rangeOn = Array.isArray(on) && on.includes('range');
    const othersOn = Array.isArray(on) && on.some((o) => o !== 'range');
    if (k === 'range' && underMinUsd(ctx.valueUsd, minUsd)) {
      if (rangeOn) add(line('USABLE_SIZE', 'limit', ELIG.SMALL_WAIT));
      else add(line('SMALL_POSITION', 'block', ELIG.SMALL_RANGE(`$${Math.round(minUsd)}`, !othersOn)));
    }
    if (k === 'compound' && underMinUsd(ctx.valueUsd, minUsd)) add(line('USABLE_SIZE', 'info', ELIG.SMALL_COMPOUND));
    if (k !== 'compound' && limits.swapCaps) {
      const u = usableShare(p, limits.swapCaps, ctx.valueUsd);
      if (u && k === 'range' && u.share > 0.5) add(line('USABLE_SIZE', rangeOn ? 'limit' : 'block', ELIG.USABLE_RANGE(usdShort(u.capUsd === null ? null : u.capUsd / 2))));
      if (u && k === 'exit' && !limits.exitWithdrawOnly && u.share > 1) add(line('USABLE_SIZE', 'limit', ELIG.USABLE_EXIT(usdShort(u.capUsd))));
    }
    const c = ctx.contracts;
    if (c) {
      const key = contractFor(k, p.venue);
      if (p.venue === 'v4' && k !== 'compound' && c.stewardRetired === true) add(line('RETIRED', 'block', ELIG.RETIRED));
      const modeBit = k === 'range' ? 1 : 2;
      const stewardPaused = p.venue === 'v4' && k !== 'compound' && typeof c.stewardPausedModes === 'number' && (c.stewardPausedModes & modeBit) !== 0;
      if (c.paused?.[key] === true || stewardPaused) add(line('PAUSED', stewardPaused ? 'block' : 'limit', ELIG.PAUSED));
    }
    kinds[k] = { live: src.live, offered: !hasBlock(lines), lines: sortLines(lines), limits };
  }
  return { venue: pv.venue, kinds };
}

const LEVEL_RANK = { block: 0, limit: 1, info: 2 } as const;
const CODE_RANK: Readonly<Record<Line['code'], number>> = {
  NOT_LIVE: 0, NOT_OWNER: 2, RETIRED: 3, RED_LISTED: 4, HOOK_RETURN_DELTA: 5, DYNAMIC_FEE_NO_HOOK: 6, NO_PRICE_REFERENCE: 7,
  EMPTY: 8, SUBSCRIBER: 9, ONE_AT_A_TIME: 10, FULL_RANGE: 11, HOOK_NO_NEW_DEPOSITS: 12, UNREVIEWED_HOOK: 13, UNLISTED_POOL: 14,
  SWAPS_CLOSED: 15, NO_PRICE_CHECK: 15, TRANSFER_TAX_TOKEN: 16, TOO_NARROW: 17, PAUSED: 18, UNKNOWN: 20, TAXED_POOL: 21,
  REVIEWED_HOOK: 22, SMALL_POSITION: 23, SELF_ANCHOR: 24, HOOK_CLAIM_ONLY: 25, USABLE_SIZE: 26, HOOK_CUT: 27, HOOK_SLIP_HINT: 28,
};
/** Lines in display order: blocks first (by priority), then limits, then notes. */
export function sortLines(lines: readonly Line[]): Line[] {
  return [...lines].sort((x, y) => LEVEL_RANK[x.level] - LEVEL_RANK[y.level] || CODE_RANK[x.code] - CODE_RANK[y.code]);
}

/** The first block of a kind other than "not live" (why it is not offered), or null. */
export function blockOf(v: KindVerdict): Line | null {
  return v.lines.find((l) => l.level === 'block' && l.code !== 'NOT_LIVE') ?? (v.live ? null : v.lines.find((l) => l.code === 'NOT_LIVE') ?? null);
}

/** A compact summary of a verdict for the read tools: offered, the first reason when not, and the other lines. */
export function verdictSummary(v: KindVerdict): { offered: boolean; why?: string; notes?: string[] } {
  const b = v.offered ? null : blockOf(v);
  const notes = v.lines.filter((l) => l !== b && l.code !== 'NOT_LIVE').map((l) => l.text);
  return { offered: v.offered, ...(b ? { why: b.text } : {}), ...(notes.length ? { notes } : {}) };
}

export type { Venue };

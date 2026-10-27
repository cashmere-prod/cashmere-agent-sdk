// The four read tools: goatlp_pools, goatlp_pool, goatlp_positions, goatlp_position. Numbers come from
// api.cashmere.exchange as it gives them; what automation a pool or position can have, and every rule that is on, is read
// from Robinhood Chain. A chain read that fails says so ("couldn't check"), it never reads as "off".
import type { Address, Hex } from 'viem';
import {
  accountZone, routes, venueOfApi, type GoatApi,
} from './api';
import type {
  ApiAutomationPolicy, ApiCashFlow, ApiDiscoverPool, ApiDiscoverResponse, ApiPerf, ApiPoolDetail, ApiPosition, ApiPositionsResponse,
} from './apiTypes';
import { addressUrl } from './chain';
import { PINS, PLANNED_FEES, RANGE_MIN_MOVABLE_USD, ST_FLAG, ZERO_ADDRESS } from './constants';
import { pctOfBps, pctOfTicks } from './copy';
import type { GoatLpContext } from './context';
import { DYNAMIC_FEE_FLAG, poolVerdict, positionVerdict, verdictSummary } from './eligibility';
import {
  loadPoolFacts, loadPositionFacts, onKindsOf, poolIdOf, poolOfPosition, type GoatEnv,
} from './facts';
import { hookReview, compoundHookReview } from './hooks';
import { keeperStatusOf, KEEPER_STATUS_TEXT, listStoredSessions, readKeeperStatus, type KeeperStatusFile } from './keeper';
import { fullRange, rangeAroundPrice, tickToPrice } from './lp/liquidity';
import { ownSessions, permitWord, unusedCount, type SessionRecord } from './permits';
import { posmAbi } from './abis';
import { isGoatSpender } from './calldata';
import { x64ToBps, V3_EXIT_OFF_HIGH, V3_EXIT_OFF_LOW } from './validate';
import type { ContractFacts, Kind, KindVerdict, PoolFacts, PoolVerdict, PositionFacts, RuleRead, Venue } from './types';

// ------------------------------------------------------------------ formatting

const r2 = (x: number | null | undefined): number | null => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
/** six significant digits, never exponent notation for prices in a normal range */
export function sig(x: number | null | undefined): number | null {
  if (typeof x !== 'number' || !Number.isFinite(x)) return null;
  if (x === 0) return 0;
  return Number(x.toPrecision(6));
}
export function feeTierText(fee: number): string {
  if ((fee & DYNAMIC_FEE_FLAG) !== 0) return 'dynamic';
  return `${Number((fee / 10_000).toFixed(4))}%`;
}
const lc = (s: string) => s.toLowerCase();
const isZero = (a: string | null | undefined) => !a || /^0x0{40}$/i.test(a);
const kindKey: Readonly<Record<Kind, 'autoCompound' | 'autoRange' | 'autoExit'>> = { compound: 'autoCompound', range: 'autoRange', exit: 'autoExit' };

function automationOf(v: PoolVerdict): Record<'autoCompound' | 'autoRange' | 'autoExit', ReturnType<typeof verdictSummary>> {
  return { autoCompound: verdictSummary(v.kinds.compound), autoRange: verdictSummary(v.kinds.range), autoExit: verdictSummary(v.kinds.exit) };
}

/** The fee lines, live when read: auto-compound only states the 10% fee and that Cashmere pays the gas. */
function feesText(c: ContractFacts | undefined, venue: Venue) {
  const bps = (k: Kind) => c?.feesBps?.[k]?.[venue] ?? (k === 'compound' ? PLANNED_FEES.compoundBps : k === 'range' ? PLANNED_FEES.rangeBps : PLANNED_FEES.exitBps);
  return {
    autoCompound: `${pctOfBps(bps('compound'))} of the fees it adds back (or sends to the wallet). Cashmere pays the gas.`,
    autoRange: `${pctOfBps(bps('range'))} of the amount moved, per move.`,
    autoExit: `${pctOfBps(bps('exit'))}, once, when it closes the position.`,
  };
}

export async function minUsdOf(api: GoatApi): Promise<number> {
  try {
    const p = await api.get<ApiAutomationPolicy>(routes.automationPolicy(), 'other');
    const v = p?.keeper?.min_position_display_usd;
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : RANGE_MIN_MOVABLE_USD;
  } catch { return RANGE_MIN_MOVABLE_USD; }
}

const chainNote = (e: unknown) => `Could not read Robinhood Chain right now (${e instanceof Error ? e.message.split('\n')[0].slice(0, 160) : String(e)}).`;

// ------------------------------------------------------------------ goatlp_pools

export interface PoolsInput { token?: string; venue?: Venue; minTvlUsd?: number; sortBy?: 'apr' | 'tvl' | 'volume'; limit?: number; automation?: boolean }

const feeOfTier = (t: string | number): number => Number(t);

function poolFactsOfDiscover(p: ApiDiscoverPool): PoolFacts | null {
  const venue = venueOfApi(p.exchange);
  if (!venue) return null;
  const fee = feeOfTier(p.fee_tier);
  const ts = Number(p.tick_spacing ?? 0);
  if (!Number.isInteger(fee) || !Number.isInteger(ts) || ts <= 0) return null;
  const base = { venue, token0: p.token0 as Address, token1: p.token1 as Address, fee, tickSpacing: ts };
  if (venue === 'v4') return { ...base, hooks: (p.hooks ?? ZERO_ADDRESS) as Address, poolId: p.address as Hex };
  return { ...base, pool: p.address as Address };
}

export async function poolsTool(ctx: GoatLpContext, input: PoolsInput) {
  const limit = Math.min(50, Math.max(1, Math.floor(input.limit ?? 20)));
  const sortBy = input.sortBy ?? 'tvl';
  const token = input.token?.trim();
  const byAddress = !!token && /^0x[0-9a-fA-F]{40}$/.test(token);
  const filtered = (!!token && !byAddress) || input.minTvlUsd !== undefined || (byAddress && !!input.venue);
  const fetchLimit = filtered ? 100 : limit;
  const body = byAddress
    ? await ctx.api.get<ApiDiscoverResponse>(routes.tokenPools(token!, { sortBy, limit: fetchLimit }), 'token-pools')
    : await ctx.api.get<ApiDiscoverResponse>(routes.discover({ sortBy, limit: fetchLimit, venue: input.venue }), 'discover');
  const sym = token && !byAddress ? token.toUpperCase() : null;
  const rows = (body.data ?? []).filter((p) => {
    const venue = venueOfApi(p.exchange);
    if (!venue) return false;
    if (input.venue && venue !== input.venue) return false;
    if (sym && (p.token0_symbol ?? '').toUpperCase() !== sym && (p.token1_symbol ?? '').toUpperCase() !== sym) return false;
    const tvl = p.tvl_current ?? p.pool_tvl;
    if (input.minTvlUsd !== undefined && !(typeof tvl === 'number' && tvl >= input.minTvlUsd)) return false;
    return true;
  }).slice(0, limit);

  let automation: Map<string, PoolVerdict> | null = null;
  let automationNote: string | undefined;
  if (input.automation !== false && rows.length) {
    try {
      const env = await ctx.env();
      const facts = rows.map(poolFactsOfDiscover);
      const loaded = await loadPoolFacts(ctx.chain, facts.filter((f): f is PoolFacts => !!f), env);
      automation = new Map();
      let j = 0;
      rows.forEach((p, i) => { if (facts[i]) automation!.set(lc(p.address), poolVerdict(loaded[j++], env.gates)); });
    } catch (e) {
      automationNote = chainNote(e);
    }
  }
  const pools = rows.map((p) => {
    const venue = venueOfApi(p.exchange)!;
    const fee = feeOfTier(p.fee_tier);
    const feeApr = r2(p.pool_fees_apr);
    const rewardsApr = r2(p.pool_rewards_apr);
    const v = automation?.get(lc(p.address));
    return {
      venue, pool: p.address, pair: `${p.token0_symbol ?? '?'}/${p.token1_symbol ?? '?'}`,
      token0: { address: p.token0, symbol: p.token0_symbol ?? null }, token1: { address: p.token1, symbol: p.token1_symbol ?? null },
      feeTier: feeTierText(fee), tickSpacing: p.tick_spacing ?? null, hook: venue === 'v4' && !isZero(p.hooks) ? p.hooks : null,
      tvlUsd: r2(p.tvl_current ?? p.pool_tvl), volume24hUsd: r2(p.pool_volume), fees24hUsd: r2(p.fees),
      aprPct: feeApr === null && rewardsApr === null ? null : r2((feeApr ?? 0) + (rewardsApr ?? 0)), feeAprPct: feeApr, rewardsAprPct: rewardsApr,
      ...(p.swap_tax?.pct ? { swapTaxPct: p.swap_tax.pct } : {}),
      ...(p.price_stale ? { priceStale: true } : {}),
      automation: v ? automationOf(v) : automationNote ? 'not checked' : undefined,
    };
  });
  return {
    pools,
    sortedBy: sortBy,
    ...(filtered && !byAddress ? { searched: `the top ${fetchLimit} pools by ${sortBy}; pass a token address to list every pool of a token` } : {}),
    ...(automationNote ? { automationNote } : {}),
    source: 'api.cashmere.exchange (24 h figures); automation read on Robinhood Chain',
  };
}

// ------------------------------------------------------------------ goatlp_pool

export interface PoolInput { venue: Venue; pool: string }

function rangesOf(tick: number, spacing: number, d0: number, d1: number) {
  const mk = (label: string, r: { tickLower: number; tickUpper: number }) => ({
    label, tickLower: r.tickLower, tickUpper: r.tickUpper, priceLower: sig(tickToPrice(r.tickLower, d0, d1)), priceUpper: sig(tickToPrice(r.tickUpper, d0, d1)),
  });
  const out = [1, 5, 10, 20].map((p) => mk(`±${p}%`, rangeAroundPrice(tick, spacing, p, p)));
  const f = fullRange(spacing);
  out.push({ label: 'full range', tickLower: f.tickLower, tickUpper: f.tickUpper, priceLower: 0, priceUpper: null });
  return out;
}

function hookStatus(f: PoolFacts) {
  if (f.venue !== 'v4' || !f.hooks || isZero(f.hooks)) return null;
  const range = hookReview(f);
  const compound = compoundHookReview(f);
  const he = f.hookEntry;
  return {
    address: f.hooks,
    forAutoRangeAndExit: range,
    forAutoCompound: compound,
    registryEntry: he === undefined ? 'not read' : he === 'unknown' ? 'unknown' : he === null ? 'none'
      : { maxPriceProtection: pctOfBps(he.maxSlippageBps), exitOnly: he.exitOnly, ...(he.taxBps ? { swapTax: pctOfBps(he.taxBps) } : {}), ...(he.feeCapPips ? { feeCap: `${(he.feeCapPips / 10_000).toFixed(2)}%` } : {}) },
    explorer: addressUrl(f.hooks),
  };
}

function limitsOf(k: Kind, v: KindVerdict) {
  const l = v.limits;
  return {
    ...(l.gateTicks ? { closestTriggerTicks: l.gateTicks + 1, closestTrigger: pctOfTicks(l.gateTicks + 1) } : {}),
    ...(k === 'range' && l.minWidthTicks ? { minWidthTicks: l.minWidthTicks, minWidth: pctOfTicks(l.minWidthTicks) } : {}),
    ...(l.maxSlippageBps ? { maxPriceProtection: pctOfBps(l.maxSlippageBps) } : {}),
    ...(k === 'exit' && l.exitWithdrawOnly ? { withdrawOnly: true } : {}),
    ...(k === 'compound' && l.claimOnly ? { sendToWalletOnly: true } : {}),
  };
}

export async function poolTool(ctx: GoatLpContext, input: PoolInput) {
  const d = await ctx.api.get<ApiPoolDetail>(routes.pool(input.venue, input.pool), 'other');
  const tokens = d.tokens ?? {};
  const t0 = tokens[lc(d.token0)] ?? tokens[d.token0];
  const t1 = tokens[lc(d.token1)] ?? tokens[d.token1];
  const d0 = t0?.decimals ?? null;
  const d1 = t1?.decimals ?? null;
  const fee = Number(d.fee_tier);
  const facts: PoolFacts = input.venue === 'v4'
    ? { venue: 'v4', token0: d.token0 as Address, token1: d.token1 as Address, fee, tickSpacing: d.tick_spacing, hooks: (d.hooks ?? ZERO_ADDRESS) as Address, poolId: d.address as Hex }
    : { venue: 'v3', token0: d.token0 as Address, token1: d.token1 as Address, fee, tickSpacing: d.tick_spacing, pool: d.address as Address };
  if (facts.venue === 'v4') {
    const id = poolIdOf({ currency0: facts.token0, currency1: facts.token1, fee, tickSpacing: facts.tickSpacing, hooks: facts.hooks! });
    if (lc(id) !== lc(d.address)) throw new Error('The pool key the API gives does not hash to this pool id; nothing is shown.');
  }
  let automation: Record<string, unknown> | string;
  let hook: ReturnType<typeof hookStatus> = null;
  let fees: ReturnType<typeof feesText> | undefined;
  try {
    const env = await ctx.env();
    const [f] = await loadPoolFacts(ctx.chain, [facts], env, { caps: true });
    const v = poolVerdict(f, env.gates);
    hook = hookStatus(f);
    fees = feesText(env.contracts, input.venue);
    automation = Object.fromEntries((['compound', 'range', 'exit'] as const).map((k) => [kindKey[k], { ...verdictSummary(v.kinds[k]), ...limitsOf(k, v.kinds[k]) }]));
  } catch (e) {
    automation = chainNote(e);
  }
  const last = d.last_24h ?? null;
  const feeApr = r2(last?.fees_apr);
  const rewardsApr = r2(last?.rewards_apr);
  const tick = typeof d.tick === 'number' ? d.tick : null;
  return {
    venue: input.venue, pool: d.address, pair: `${d.token0_symbol ?? t0?.symbol ?? '?'}/${d.token1_symbol ?? t1?.symbol ?? '?'}`,
    token0: { address: d.token0, symbol: t0?.symbol ?? d.token0_symbol ?? null, decimals: d0, priceUsd: sig(t0?.price ?? null) },
    token1: { address: d.token1, symbol: t1?.symbol ?? d.token1_symbol ?? null, decimals: d1, priceUsd: sig(t1?.price ?? null) },
    feeTier: feeTierText(fee), tickSpacing: d.tick_spacing,
    ...(d.lp_fee_charged?.avg_pips ? { dynamicFeeAvg24h: `${(d.lp_fee_charged.avg_pips / 10_000).toFixed(4)}%` } : {}),
    hook: hook ?? (input.venue === 'v4' && !isZero(d.hooks) ? { address: d.hooks } : null),
    price: {
      tick, sqrtPriceX96: d.sqrt_price ?? null,
      token1PerToken0: sig(d.pool_price ?? (tick !== null && d0 !== null && d1 !== null ? tickToPrice(tick, d0, d1) : null)),
      token0PerToken1: sig(d.pool_price ? 1 / d.pool_price : null),
    },
    tvlUsd: r2(d.tvl_usd),
    last24h: last ? {
      volumeUsd: r2(last.volume_usd), feesUsd: r2(last.fees_lp_usd ?? last.fees_usd), aprPct: feeApr === null && rewardsApr === null ? null : r2((feeApr ?? 0) + (rewardsApr ?? 0)),
      feeAprPct: feeApr, rewardsAprPct: rewardsApr, ...(last.fees_apr_gross !== undefined ? { feeAprGrossPct: r2(last.fees_apr_gross) } : {}),
    } : null,
    ...(d.swap_tax?.pct ? { swapTaxPct: d.swap_tax.pct } : {}),
    ranges: tick !== null && d0 !== null && d1 !== null ? rangesOf(tick, d.tick_spacing, d0, d1) : 'unavailable (the price or the token decimals are missing)',
    automation,
    ...(fees ? { automationFees: fees } : {}),
  };
}

// ------------------------------------------------------------------ positions

const perfOf = (p: ApiPerf | undefined) => (p ? {
  pnl: r2(p.pnl), roiPct: r2(p.roi), aprPct: r2(p.apr), feeAprPct: r2(p.fee_apr), poolPnl: r2(p.pool_pnl), impermanentLoss: r2(p.il),
  ...(p.apr_reason ? { aprNote: p.apr_reason } : {}),
} : null);

function ruleStatus(k: Kind, r: RuleRead | null | 'unknown' | undefined, owner: Address | 'unknown', keeper: KeeperStatusFile, id: bigint, venue: Venue) {
  if (r === undefined) return { on: 'not checked' };
  if (r === 'unknown') return { on: 'unknown', note: "Couldn't read this rule on chain." };
  const on = !!r && r.on && (owner === 'unknown' || !r.owner || lc(r.owner) === lc(owner));
  const row = on ? keeperStatusOf(keeper, id, venue, k) : null;
  return {
    on,
    ...(r && r.on && !on ? { note: 'A rule from a previous owner is left on chain; it does not run for the new owner.' } : {}),
    ...(row ? { keeper: KEEPER_STATUS_TEXT[row.status] } : {}),
  };
}

export interface PositionsInput { owner?: string; venue?: Venue; includeClosed?: boolean; limit?: number; cursor?: string }

export async function positionsTool(ctx: GoatLpContext, input: PositionsInput) {
  const owner = input.owner?.trim() || ctx.account;
  if (!owner) throw new Error('Pass the owner address: this server has no wallet configured (read-only, or no CASHMERE_EVM_PRIVATE_KEY).');
  const scope = input.includeClosed ? 'lifetime' : 'active';
  const limit = Math.min(50, Math.max(1, Math.floor(input.limit ?? 20)));
  const body = await ctx.api.get<ApiPositionsResponse>(routes.accountPositions(owner, { scope, limit, cursor: input.cursor ?? null, venue: input.venue }), accountZone(scope));
  const rows = (body.data ?? []).filter((p) => venueOfApi(p.exchange));
  let facts: Map<string, PositionFacts> | null = null;
  let keeper: KeeperStatusFile = { state: 'failed', updatedAt: null, rows: [] };
  let chainNoteText: string | undefined;
  const open = rows.filter((p) => !p.exited);
  if (open.length) {
    try {
      const env = await ctx.env();
      const refs = open.map((p) => ({ id: BigInt(p.nft_id), venue: venueOfApi(p.exchange)! }));
      const [loaded, k] = await Promise.all([loadPositionFacts(ctx.chain, refs, env), readKeeperStatus(ctx.api, ctx.nowSec())]);
      facts = new Map(loaded.map((f) => [`${f.venue}:${f.id}`, f]));
      keeper = k;
    } catch (e) { chainNoteText = chainNote(e); }
  }
  const positions = rows.map((p) => {
    const venue = venueOfApi(p.exchange)!;
    const id = BigInt(p.nft_id);
    const t = p.tokens ?? {};
    const s0 = t[lc(p.token0)]?.symbol ?? '?';
    const s1 = t[lc(p.token1)]?.symbol ?? '?';
    const f = facts?.get(`${venue}:${id}`);
    const auto = p.exited ? null : f
      ? Object.fromEntries((['compound', 'range', 'exit'] as const).map((k) => [kindKey[k], ruleStatus(k, f.rules?.[k], f.owner, keeper, id, venue)]))
      : 'not checked';
    return {
      venue, id: String(p.nft_id), pool: p.pool, pair: `${s0}/${s1}`, feeTier: feeTierText(Number(p.fee_tier)),
      inRange: p.exited ? null : p.in_range ?? null, closed: !!p.exited,
      range: { tickLower: p.tick_lower, tickUpper: p.tick_upper, priceLower: sig(p.price_lower), priceUpper: sig(p.price_upper), priceNow: sig(p.pool_price) },
      valueUsd: r2(p.underlying_value),
      uncollectedFees: { usd: r2(p.uncollected_fees_value), [s0]: p.uncollected_fees0 ?? null, [s1]: p.uncollected_fees1 ?? null },
      performance: { usd: perfOf(p.performance?.usd), hodl: perfOf(p.performance?.hodl) },
      automation: auto,
    };
  });
  return {
    owner, scope, positions,
    nextCursor: body.pagination?.has_next ? body.pagination.next_cursor ?? null : null,
    ...(typeof body.pagination?.total_count === 'number' ? { totalCount: body.pagination.total_count } : {}),
    ...(keeper.state !== 'fresh' && open.length && !chainNoteText ? { keeperStatus: keeper.state === 'stale' ? 'The keeper status file is older than 10 minutes; its rows are not shown.' : 'The keeper status file could not be read; rules are shown from the chain only.' } : {}),
    ...(chainNoteText ? { automationNote: chainNoteText } : {}),
    source: 'api.cashmere.exchange (performance as the API gives it); automation read on Robinhood Chain',
  };
}

// ------------------------------------------------------------------ goatlp_position

export interface PositionInput { venue: Venue; id: string }

const secText = (s: number) => (s % 86_400 === 0 ? `${s / 86_400} day${s === 86_400 ? '' : 's'}` : s % 3600 === 0 ? `${s / 3600} hour${s === 3600 ? '' : 's'}` : `${s} s`);
const whenText = (sec: number) => (sec > 0 ? new Date(sec * 1000).toISOString() : null);

/** A rule in plain fields (ticks and, when the decimals are known, prices of token1 per token0) */
export function describeRule(r: RuleRead, decimals: readonly [number, number] | null, range: { tickLower: number; tickUpper: number }) {
  const price = (t: number) => (decimals ? sig(tickToPrice(t, decimals[0], decimals[1])) : null);
  const base = { on: r.on, ...(r.owner ? { setBy: r.owner } : {}) };
  if (r.kind === 'compound' && r.venue === 'v3') {
    const c = r.cfg;
    return { ...base, swapToMatch: c.swapEnabled, maxPriceProtection: pctOfBps(c.maxSlippageBps), atMostOnceEvery: secText(c.minInterval), lastRun: whenText(c.lastRunAt) };
  }
  if (r.kind === 'compound' && r.venue === 'v4') {
    const c = r.cfg;
    return { ...base, mode: c.claimOnly ? 'send fees to the wallet' : 'add fees back', maxPriceProtection: pctOfBps(c.maxSlippageBps), atMostOnceEvery: secText(c.minInterval), lastRun: whenText(c.lastRunAt) };
  }
  if (r.kind === 'range' && r.venue === 'v4') {
    const c = r.cfg;
    return {
      ...base, triggerTicks: c.triggerTicks, trigger: pctOfTicks(c.triggerTicks), movesBelowTick: range.tickLower - c.triggerTicks, movesAboveTick: range.tickUpper + c.triggerTicks,
      movesBelowPrice: price(range.tickLower - c.triggerTicks), movesAbovePrice: price(range.tickUpper + c.triggerTicks),
      maxPriceProtection: pctOfBps(c.slippageBps), atMostOneMoveEvery: secText(c.minInterval), movesLeft: c.budget, maxSwapFee: `${(c.maxSwapFeePips / 10_000).toFixed(2)}%`, lastRun: whenText(c.lastRunAt),
    };
  }
  if (r.kind === 'exit' && r.venue === 'v4') {
    const c = r.cfg;
    const side = (on: boolean, tick: number, swap: boolean) => (on ? { tick, price: price(tick), swap } : null);
    return {
      ...base, lower: side((c.flags & ST_FLAG.LOWER_ON) !== 0, c.lowerTrigger, (c.flags & ST_FLAG.SWAP_ON_LOWER) !== 0),
      upper: side((c.flags & ST_FLAG.UPPER_ON) !== 0, c.upperTrigger, (c.flags & ST_FLAG.SWAP_ON_UPPER) !== 0),
      maxPriceProtection: pctOfBps(c.slippageBps), ...((c.flags & (ST_FLAG.SWAP_ON_LOWER | ST_FLAG.SWAP_ON_UPPER)) !== 0 ? { maxSwapFee: `${(c.maxSwapFeePips / 10_000).toFixed(2)}%` } : {}),
    };
  }
  if (r.kind === 'range' && r.venue === 'v3') {
    const c = r.cfg;
    return {
      ...base, triggerTicks: c.lowerTickLimit, trigger: pctOfTicks(c.lowerTickLimit), newWidthTicks: c.upperTickDelta - c.lowerTickDelta,
      movesBelowTick: range.tickLower - c.lowerTickLimit, movesAboveTick: range.tickUpper + c.upperTickLimit,
      movesBelowPrice: price(range.tickLower - c.lowerTickLimit), movesAbovePrice: price(range.tickUpper + c.upperTickLimit),
      maxPriceProtection: pctOfBps(x64ToBps(c.token0SlippageX64)),
    };
  }
  const c = (r as Extract<RuleRead, { kind: 'exit'; venue: 'v3' }>).cfg;
  const lowerOn = c.token0TriggerTick !== V3_EXIT_OFF_LOW;
  const upperOn = c.token1TriggerTick !== V3_EXIT_OFF_HIGH;
  return {
    ...base, lower: lowerOn ? { tick: c.token0TriggerTick, price: price(c.token0TriggerTick), swap: c.token0Swap } : null,
    upper: upperOn ? { tick: c.token1TriggerTick, price: price(c.token1TriggerTick), swap: c.token1Swap } : null,
    maxPriceProtection: pctOfBps(x64ToBps(c.token0SlippageX64)),
  };
}

/** Signed and unused v4 auto-compound messages of a position: from the keeper store, else this server's record. Without
 *  any record the count is not known (a stop still cancels every unused one: it scans the position's nonce window). */
async function signedRunsLeft(ctx: GoatLpContext, owner: Address, id: bigint, env: GoatEnv): Promise<{ left: number | null; until: string | null; source: string } | null> {
  const gac4 = env.contracts.spenders?.autoCompoundV4;
  if (!gac4) return null;
  const base = permitWord(gac4, id);
  const stored = await listStoredSessions(ctx.api, id);
  let sessions: SessionRecord[] = ownSessions(base, stored?.sessions ?? []);
  let source = 'the keeper store';
  if (!sessions.length) { sessions = ownSessions(base, ctx.sessions.list(owner, id)); source = 'this server'; }
  if (!sessions.length) return { left: null, until: null, source: 'no record of the signed messages' };
  const bitmaps = new Map<string, bigint>();
  for (const s of sessions) bitmaps.set(String(s.word), await ctx.chain.read<bigint>({ address: PINS.posm.address, abi: posmAbi, functionName: 'nonces', args: [owner, s.word] }));
  const until = sessions.reduce((a, b) => (b.deadline > a.deadline ? b : a)).deadline;
  return { left: unusedCount(sessions, (w) => bitmaps.get(String(w)) ?? 0n, ctx.nowSec()), until: whenText(Number(until)), source };
}

const SPENDER_NAME: Readonly<Record<string, string>> = {
  autoCompoundV3: 'GoatAutoCompoundV3', autoCompoundV4: 'GoatAutoCompoundV4', rangeExitV3: 'AutoRange', exitV3: 'AutoExit', rangeExitV4: 'GoatV4StewardEngine',
};

export async function positionTool(ctx: GoatLpContext, input: PositionInput) {
  const id = BigInt(input.id);
  let api: ApiPosition | null = null;
  let apiNote: string | undefined;
  try {
    const d = await ctx.api.get<{ data?: ApiPosition } & ApiPosition>(routes.position(input.venue, id), 'position');
    api = (d as { data?: ApiPosition }).data ?? d;
  } catch (e) { apiNote = e instanceof Error ? e.message : String(e); }
  let flows: ApiCashFlow[] | null = api?.cash_flows ?? null;
  if (api && !flows) {
    try { flows = await ctx.api.get<ApiCashFlow[]>(routes.cashFlows(input.venue, id), 'history'); } catch { flows = null; }
  }
  const t = api?.tokens ?? {};
  const s0 = api ? t[lc(api.token0)]?.symbol ?? '?' : '?';
  const s1 = api ? t[lc(api.token1)]?.symbol ?? '?' : '?';
  const dec0 = api ? t[lc(api.token0)]?.decimals : undefined;
  const dec1 = api ? t[lc(api.token1)]?.decimals : undefined;
  const decimals: [number, number] | null = typeof dec0 === 'number' && typeof dec1 === 'number' ? [dec0, dec1] : null;

  let chain: Record<string, unknown> | string;
  try {
    const env = await ctx.env();
    const [f] = await loadPositionFacts(ctx.chain, [{ id, venue: input.venue }], env);
    const pool = await poolOfPosition(ctx.chain, f);
    const [pf] = pool ? await loadPoolFacts(ctx.chain, [pool], env, { caps: true }) : [null];
    const owner = f.owner;
    const range = { tickLower: f.tickLower, tickUpper: f.tickUpper };
    const rules = Object.fromEntries((['compound', 'range', 'exit'] as const).map((k) => {
      const r = f.rules?.[k];
      if (r === undefined) return [kindKey[k], 'not checked (the contract does not match its pin)'];
      if (r === 'unknown') return [kindKey[k], "couldn't read this rule on chain"];
      if (!r) return [kindKey[k], { on: false }];
      const d = describeRule(r, decimals, range);
      const ownerNow = owner !== 'unknown' ? owner : null;
      const fromOld = r.on && ownerNow && r.owner && lc(r.owner) !== lc(ownerNow);
      return [kindKey[k], fromOld ? { ...d, on: false, note: 'Set by a previous owner; it does not run for the new owner.' } : d];
    }));
    const onKinds = onKindsOf(f.rules, owner);
    const minUsd = await minUsdOf(ctx.api);
    const account = ctx.account ?? (owner !== 'unknown' ? owner : undefined);
    const verdict = pf ? positionVerdict(poolVerdict(pf, env.gates), f, { account: account ?? undefined, onKinds, contracts: env.contracts, valueUsd: api?.underlying_value ?? undefined, minUsd }) : null;
    const approved = f.approved;
    const spenderKey = approved && approved !== 'unknown' ? isGoatSpender(approved, env.contracts.spenders ?? {}) : null;
    const keeper = await readKeeperStatus(ctx.api, ctx.nowSec());
    const keeperRows = (['compound', 'range', 'exit'] as const).map((k) => [k, keeperStatusOf(keeper, id, input.venue, k)] as const).filter(([, r]) => r);
    let signed: Awaited<ReturnType<typeof signedRunsLeft>> = null;
    const c4 = f.rules?.compound;
    if (input.venue === 'v4' && c4 && c4 !== 'unknown' && c4.on && owner !== 'unknown') signed = await signedRunsLeft(ctx, owner, id, env).catch(() => null);
    chain = {
      owner, ...(f.burned ? { burned: true } : {}),
      liquidity: f.liquidity === 'unknown' ? 'unknown' : f.liquidity.toString(),
      range: { ...range, ...(decimals ? { priceLower: sig(tickToPrice(f.tickLower, decimals[0], decimals[1])), priceUpper: sig(tickToPrice(f.tickUpper, decimals[0], decimals[1])) } : {}) },
      ...(input.venue === 'v4' && f.subscriber !== undefined ? { subscriber: f.subscriber } : {}),
      permission: approved === 'unknown' ? 'unknown' : approved === null || approved === undefined ? 'none'
        : { address: approved, holder: spenderKey ? SPENDER_NAME[spenderKey] : 'another app (not Goat LP)' },
      rules,
      ...(signed ? { autoCompoundSignedMessages: signed } : {}),
      ...(keeperRows.length ? { keeper: Object.fromEntries(keeperRows.map(([k, r]) => [kindKey[k], { status: KEEPER_STATUS_TEXT[r!.status], ...(r!.reasonKey ? { reason: r!.reasonKey } : {}) }])) } : {}),
      ...(keeper.state === 'stale' ? { keeperStatus: 'The keeper status file is older than 10 minutes; its rows are not shown.' } : {}),
      canTurnOn: verdict ? Object.fromEntries((['compound', 'range', 'exit'] as const).map((k) => [kindKey[k], { ...verdictSummary(verdict.kinds[k]), ...limitsOf(k, verdict.kinds[k]) }])) : 'unknown (the pool could not be read)',
      ...(ctx.account ? {} : { canTurnOnNote: 'Checked for the owner shown; this server has no wallet configured.' }),
      automationFees: feesText(env.contracts, input.venue),
    };
  } catch (e) {
    chain = chainNote(e);
  }
  return {
    venue: input.venue, id: input.id,
    ...(api ? {
      pool: api.pool, pair: `${s0}/${s1}`, feeTier: feeTierText(Number(api.fee_tier)), owner: api.owner, inRange: api.exited ? null : api.in_range ?? null, closed: !!api.exited,
      range: { tickLower: api.tick_lower, tickUpper: api.tick_upper, priceLower: sig(api.price_lower), priceUpper: sig(api.price_upper), priceNow: sig(api.pool_price) },
      amounts: { [s0]: api.current_amount0 ?? null, [s1]: api.current_amount1 ?? null },
      valueUsd: r2(api.underlying_value),
      uncollectedFees: { usd: r2(api.uncollected_fees_value), [s0]: api.uncollected_fees0 ?? null, [s1]: api.uncollected_fees1 ?? null },
      performance: { usd: perfOf(api.performance?.usd), hodl: perfOf(api.performance?.hodl) },
      cashFlows: (flows ?? []).filter((c) => c.type !== 'current-amount-state' && c.type !== 'unclaimed-fees-state').slice(-50).map((c) => ({
        type: c.type, time: whenText(c.timestamp), tx: c.tx_hash ?? null,
        ...(c.amount0 !== undefined ? { [s0]: c.amount0 } : {}), ...(c.amount1 !== undefined ? { [s1]: c.amount1 } : {}),
        ...(c.amount !== undefined ? { amountEth: c.amount } : {}), usd: r2(c.amount_usd ?? null),
      })),
    } : { apiNote: `Position data from api.cashmere.exchange is unavailable: ${apiNote}` }),
    chain,
  };
}


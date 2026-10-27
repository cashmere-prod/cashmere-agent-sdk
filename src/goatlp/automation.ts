// Plans of the automation write tools: goatlp_set_auto_range, goatlp_set_auto_exit, goatlp_set_auto_compound and
// goatlp_stop_automation. They follow the app's review and stop flows:
//  - fresh reads (chain id, pins, the position, its pool, every rule) and the eligibility of ./eligibility.ts;
//  - the app's defaults and the contracts' bounds (./validate.ts), never clamped;
//  - turn on: [allow this position, turn on] (v3, and v4 auto-range / auto-exit), or [sign N runs, turn on, hand the
//    signed messages to the keeper] (v4 auto-compound); a rule that is on is changed with one "save" transaction;
//  - stop: as the app's stop plans (rule off, then remove this automation's own permission and cancel unused signed
//    messages); another app's approval is never touched.
// One automation per position: a v3 position has one approved address, so a second one is refused.
import { encodeFunctionData, type Abi, type Address, type Hex } from 'viem';
import { autoExitAbi, autoRangeAbi, gac3Abi, gac4Abi, npmAbi, posmAbi, stewardAbi } from './abis';
import { routes } from './api';
import type { ApiPosition } from './apiTypes';
import { checkPins, type McCall } from './chain';
import {
  BOUNDS, COMPOUND_INTERVAL_DEFAULT, COMPOUND_INTERVAL_PRESETS, COMPOUND_SLIP_DEFAULT_BPS, DAY, EXIT_DEFAULT_OFFSET_PCT, GOAT_CHAIN_ID,
  HORIZON_DEFAULT_DAYS, HORIZON_MAX_DAYS, HOUR, MAX_RUNS_PER_SESSION, MAX_SWAP_FEE_DEFAULT_PIPS, NPM, PINS, POSM, RANGE_INTERVAL_DEFAULT,
  RANGE_SLIP_DEFAULT_BPS, RUNS_TO_SIGN_DEFAULT, SMALL_HORIZON_DAYS, SMALL_RUNS_TO_SIGN, STEWARD_BUDGET, pinOf, type PinKey,
} from './constants';
import {
  alignWidth, contractFor, isGoatSpender, setExit, setRange, spenderFor, stopPlan, turnOnSteps, v3CompoundEnable, v3ExitEnable,
  v3RangeEnable, v4CompoundEnable, type Spenders,
} from './calldata';
import { ELIG, INVALID, KIND_NAME, LIMITS_UNREAD, PAUSED_ALL_LINE, STEP, VENUE_NAME, WRONG_OWNER_NOW, pctOfBps, pctOfTicks } from './copy';
import type { GoatLpContext } from './context';
import { blockOf, poolVerdict, positionVerdict } from './eligibility';
import {
  TARGETS, loadPoolFacts, loadPositionFacts, onKindsOf, poolOfPosition, toAe, toAr, toGac3, toGac4, toSt, type GoatEnv,
} from './facts';
import { assertAutomationTx, checkAutomationTypedData, type GuardCtx, type GuardIntent } from './guard';
import {
  deleteStoredSessions, handOverRefusal, handOverSessions, listStoredSessions, postSession, type SignedSession,
} from './keeper';
import { tickToPrice } from './lp/liquidity';
import { simulate, type BuiltPlan, type PlanStep, type TxStep, type WorkStep } from './plans';
import {
  allocateSessionWord, isUsed, ownSessions, permitTypedData, permitWord, revokeSet, scanSessionWords, sessionNonces, type SessionRecord,
} from './permits';
import { describeRule, minUsdOf, sig } from './read';
import type {
  AutoCall, CompoundV3Draft, CompoundV4Draft, ExitSide, ExitV3Draft, ExitV4Draft, Kind, KindVerdict, PoolFacts, PositionFacts, RangeV3Draft,
  RangeV4Draft, RuleDraft, RuleRead, Venue,
} from './types';
import { minWidth, type PoolCtx } from './validate';

const lc = (s: string) => s.toLowerCase();
const REVOKE_NONCE_SELECTOR = encodeFunctionData({ abi: posmAbi as unknown as Abi, functionName: 'revokeNonce', args: [0n] }).slice(0, 10);
const eq = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && lc(a) === lc(b);
const isZero = (a: string | null | undefined) => !a || /^0x0{40}$/i.test(a);
const LN = Math.log(1.0001);
const ticksUp = (pct: number) => Math.round(Math.log(1 + pct / 100) / LN);
const ticksDown = (pct: number) => Math.round(-Math.log(1 - pct / 100) / LN);
/** ticks for at least `pct` percent (rounded up) */
const ticksOfPct = (pct: number) => (pct > 0 ? Math.ceil(Math.log(1 + pct / 100) / LN) : 0);
function refuse(msg: string): never { throw new Error(`Not planned: ${msg}`); }

export interface ExitSideInput { tick?: number; pctBeyondRange?: number; swap?: boolean }
export interface SetAutomationInput {
  kind: Kind;
  venue: Venue;
  id: string;
  /** price protection in bps */
  maxPriceProtectionBps?: number;
  /** auto-compound and v4 auto-range: at most one run every N hours */
  minIntervalHours?: number;
  /** v3 auto-compound: swap part of the fees to match the range */
  swapToMatch?: boolean;
  /** v4 auto-compound */
  mode?: 'addBack' | 'claim';
  runsToSign?: number;
  horizonDays?: number;
  signMore?: boolean;
  /** auto-range */
  triggerPct?: number;
  triggerTicks?: number;
  newWidthPctEachSide?: number;
  newWidthTicks?: number;
  /** v4 auto-range and swap exits: the highest pool fee the swap may pay, in percent */
  maxSwapFeePct?: number;
  /** auto-exit sides */
  lower?: ExitSideInput;
  upper?: ExitSideInput;
}

// ------------------------------------------------------------------ shared reads

interface Gathered {
  env: GoatEnv;
  f: PositionFacts;
  pf: PoolFacts;
  onKinds: Kind[] | 'unknown';
  valueUsd?: number;
  minUsd: number;
  api: ApiPosition | null;
  spenders: Spenders;
}

async function apiPosition(ctx: GoatLpContext, venue: Venue, id: bigint): Promise<ApiPosition | null> {
  try {
    const d = await ctx.api.get<{ data?: ApiPosition } & ApiPosition>(routes.position(venue, id), 'position');
    return (d as { data?: ApiPosition }).data ?? d;
  } catch { return null; }
}

/** Fresh reads every write plan starts from. Refuses when the signer does not own the position. */
async function gather(ctx: GoatLpContext, venue: Venue, id: bigint): Promise<Gathered> {
  const signer = ctx.signer;
  if (!signer) refuse('this server has no wallet configured.');
  const env = await ctx.env(true);
  if (env.chainId !== GOAT_CHAIN_ID) refuse(`the RPC is on chain ${env.chainId}, not Robinhood Chain (4663).`);
  const [f] = await loadPositionFacts(ctx.chain, [{ id, venue }], env);
  if (f.owner === 'unknown') refuse(f.burned ? `${VENUE_NAME[venue]} position #${id} does not exist (or was burned).` : "couldn't read the owner of this position on chain.");
  if (!eq(f.owner as string, signer!.address)) refuse(`${WRONG_OWNER_NOW} It belongs to ${f.owner as string}.`);
  const pool = await poolOfPosition(ctx.chain, f);
  if (!pool) refuse("couldn't read this position's pool on chain.");
  const [[pf], api, minUsd] = await Promise.all([loadPoolFacts(ctx.chain, [pool!], env, { caps: true }), apiPosition(ctx, venue, id), minUsdOf(ctx.api)]);
  const v = api?.underlying_value;
  return {
    env, f, pf, onKinds: onKindsOf(f.rules, f.owner), minUsd, api,
    ...(typeof v === 'number' && Number.isFinite(v) ? { valueUsd: v } : {}),
    spenders: env.contracts.spenders ?? {},
  };
}

const decimalsOf = (api: ApiPosition | null): [number, number] | null => {
  if (!api) return null;
  const t = api.tokens ?? {};
  const d0 = t[lc(api.token0)]?.decimals; const d1 = t[lc(api.token1)]?.decimals;
  return typeof d0 === 'number' && typeof d1 === 'number' ? [d0, d1] : null;
};
const pairOf = (api: ApiPosition | null): string | null => {
  if (!api) return null;
  const t = api.tokens ?? {};
  return `${t[lc(api.token0)]?.symbol ?? '?'}/${t[lc(api.token1)]?.symbol ?? '?'}`;
};

function positionView(g: Gathered, venue: Venue, id: bigint) {
  const d = decimalsOf(g.api);
  const price = (t: number) => (d ? sig(tickToPrice(t, d[0], d[1])) : null);
  return {
    venue, id: id.toString(), ...(pairOf(g.api) ? { pair: pairOf(g.api) } : {}), owner: g.f.owner,
    range: { tickLower: g.f.tickLower, tickUpper: g.f.tickUpper, ...(d ? { priceLower: price(g.f.tickLower), priceUpper: price(g.f.tickUpper), priceUnit: 'token1 per token0' } : {}) },
    ...(g.valueUsd !== undefined ? { valueUsd: Math.round(g.valueUsd * 100) / 100 } : {}),
  };
}

/** A transaction step with the fresh reads and the decode check that run right before it is signed */
function txStep(ctx: GoatLpContext, g: Gathered, call: AutoCall, x: { kind: Kind; venue: Venue; intent: GuardIntent; pool?: GuardCtx['pool']; revokeAllowed?: readonly bigint[]; activeKinds: GuardCtx['activeKinds'] }, verify: () => Promise<string | null>): TxStep {
  const pinOfTo = pinOf(call.to);
  const view: Record<string, unknown> = {
    type: 'transaction', contract: pinOfTo?.pin.name ?? call.to, to: call.to, call: callText(call), value: '0 ETH',
  };
  return {
    kind: 'tx', label: call.label, to: call.to, data: call.data, value: call.value, view, verify,
    precheck: async () => {
      const signer = ctx.signer!;
      // the target, and a spender it is given, must still have their pinned code
      const keys = new Set<PinKey>();
      if (pinOfTo) keys.add(pinOfTo.key);
      if (call.functionName === 'approve' && !isZero(call.args[0] as string)) { const p = pinOf(call.args[0] as string); if (p) keys.add(p.key); else return 'the permission would go to an address that is not pinned'; }
      const pins = await checkPins(ctx.chain, [...keys]);
      const bad = Object.values(pins).find((p) => !p.ok);
      if (bad) return bad.reason;
      const chainId = await ctx.chain.chainId();
      const nft = x.venue === 'v4' ? { address: POSM, abi: posmAbi } : { address: NPM, abi: npmAbi };
      const [owner, approved] = await Promise.all([
        ctx.chain.read<Address>({ ...nft, functionName: 'ownerOf', args: [call.tokenId] } as McCall),
        ctx.chain.read<Address>({ ...nft, functionName: 'getApproved', args: [call.tokenId] } as McCall),
      ]);
      const v = assertAutomationTx({ to: call.to, data: call.data, value: call.value, chainId: GOAT_CHAIN_ID }, guardCtx(ctx, g, {
        ...x, chainId, account: signer.address, ownerOnChain: owner, currentApproved: isZero(approved) ? null : approved, tokenId: call.tokenId,
      }));
      return v.ok ? null : `${v.reason} (${v.rule})`;
    },
  };
}

function guardCtx(ctx: GoatLpContext, g: Gathered, x: { kind: Kind; venue: Venue; intent: GuardIntent; pool?: GuardCtx['pool']; revokeAllowed?: readonly bigint[]; activeKinds: GuardCtx['activeKinds']; chainId: number; account: Address; ownerOnChain: Address | null; currentApproved: Address | null; tokenId: bigint }): GuardCtx {
  const treasuryOk = Object.fromEntries(Object.entries(g.env.contracts.treasuryOk ?? {}).map(([k, v]) => [k, v === true]));
  return {
    chainId: x.chainId, account: x.account, tokenId: x.tokenId, ownerOnChain: x.ownerOnChain, kind: x.kind, venue: x.venue, intent: x.intent,
    gates: g.env.gates, targets: TARGETS, spenders: g.spenders, currentApproved: x.currentApproved, pool: x.pool,
    liveFees: g.env.contracts.feesX64, treasuryOk, activeKinds: x.activeKinds, revokeAllowed: x.revokeAllowed ?? [], nowSec: ctx.nowSec(),
  };
}

/** "approve(GoatV4StewardEngine 0xD12D..., 4006316)" */
function callText(c: AutoCall): string {
  const name = (a: unknown) => (typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) ? (pinOf(a)?.pin.name ? `${pinOf(a)!.pin.name} ${a}` : isZero(a) ? 'nobody (0x0)' : a) : a);
  const show = (v: unknown): unknown => (typeof v === 'bigint' ? v.toString() : Array.isArray(v) ? v.map(show) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, show(x)])) : name(v));
  if (c.functionName === 'multicall') return `multicall(${(c.args[0] as Hex[]).length} calls: ${c.label.toLowerCase()})`;
  return `${c.functionName}(${c.args.map((a) => JSON.stringify(show(a))).join(', ')})`;
}

// ------------------------------------------------------------------ read-back after a confirmed transaction

/** What is not as expected after a call, or null (the app's post-confirm check) */
export async function verifyCall(ctx: GoatLpContext, call: AutoCall): Promise<string | null> {
  const id = call.tokenId;
  const read = <T>(address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[]) => ctx.chain.read<T>({ address, abi, functionName, args });
  const sameCfg = (sent: Record<string, unknown>, got: Record<string, unknown>) => Object.keys(sent).filter((k) => k !== 'lastRunAt').every((k) => String(sent[k]) === String(got[k]));
  const nftOf = call.contract === 'npm' ? { address: NPM, abi: npmAbi } : { address: POSM, abi: posmAbi };
  const NOT_SEEN = 'the chain does not show the expected result yet; check the position again in a moment';
  if (call.functionName === 'approve') {
    const a = await read<Address>(nftOf.address, nftOf.abi, 'getApproved', [id]);
    const want = call.args[0] as Address;
    return eq(a, want) || (isZero(want) && isZero(a)) ? null : NOT_SEEN;
  }
  if (call.functionName === 'multicall') {
    const owner = ctx.signer!.address;
    for (const d of call.args[0] as Hex[]) {
      if (d.slice(0, 10).toLowerCase() === REVOKE_NONCE_SELECTOR) {
        const nonce = BigInt(`0x${d.slice(10)}`);
        const bm = await read<bigint>(POSM, posmAbi, 'nonces', [owner, nonce >> 8n]);
        if (!isUsed(bm, Number(nonce & 255n))) return NOT_SEEN;
      } else if (!isZero(await read<Address>(POSM, posmAbi, 'getApproved', [id]))) return NOT_SEEN;
    }
    return null;
  }
  switch (call.contract) {
    case 'autoCompoundV3': return sameCfg(call.args[1] as Record<string, unknown>, toGac3(await read(call.to, gac3Abi, 'configs', [id])) as unknown as Record<string, unknown>) ? null : NOT_SEEN;
    case 'autoCompoundV4': return sameCfg(call.args[1] as Record<string, unknown>, toGac4(await read(call.to, gac4Abi, 'configs', [id])) as unknown as Record<string, unknown>) ? null : NOT_SEEN;
    case 'rangeExitV3': return sameCfg(call.args[2] as Record<string, unknown>, toAr(await read(call.to, autoRangeAbi, 'positionConfigs', [id])) as unknown as Record<string, unknown>) ? null : NOT_SEEN;
    case 'exitV3': return sameCfg(call.args[1] as Record<string, unknown>, toAe(await read(call.to, autoExitAbi, 'positionConfigs', [id])) as unknown as Record<string, unknown>) ? null : NOT_SEEN;
    case 'rangeExitV4': {
      const [raw] = await read<readonly [unknown, Address]>(call.to, stewardAbi, 'configOf', [id]);
      const c = toSt(raw);
      if (call.functionName === 'clearConfig') return c.mode === 0 ? null : NOT_SEEN;
      if (call.functionName === 'setRangeConfig') { const p = call.args[1] as { triggerTicks: number; slippageBps: number; minInterval: number; maxSwapFeePips: number }; return c.mode === 1 && c.triggerTicks === p.triggerTicks && c.slippageBps === p.slippageBps && c.minInterval === p.minInterval && c.maxSwapFeePips === p.maxSwapFeePips ? null : NOT_SEEN; }
      if (call.functionName === 'setExitConfig') { const p = call.args[1] as { flags: number; slippageBps: number }; return c.mode === 2 && c.flags === p.flags && c.slippageBps === p.slippageBps ? null : NOT_SEEN; }
      return null;
    }
    default: return null;
  }
}

// ------------------------------------------------------------------ drafts from inputs (the app's defaults)

function slipDefault(maxBps: number): number {
  if (maxBps >= RANGE_SLIP_DEFAULT_BPS) return RANGE_SLIP_DEFAULT_BPS;
  const under = [10, 25].filter((b) => b < maxBps);
  return under.length ? under[under.length - 1] : maxBps;
}

/** "At most once every" for v4 signed runs: the horizon over the runs, rounded down to a preset, never under 1 hour */
export function signIntervalOf(horizonDays: number, runs: number): number {
  if (!(horizonDays > 0) || !(runs > 0)) return COMPOUND_INTERVAL_DEFAULT;
  const each = (horizonDays * DAY) / runs;
  let best = COMPOUND_INTERVAL_PRESETS[0];
  for (const s of COMPOUND_INTERVAL_PRESETS) if (s <= each) best = s;
  return best;
}

const hours = (h: number | undefined, dflt: number): number => (h === undefined ? dflt : Math.round(h * HOUR));

export function buildDraft(input: SetAutomationInput, kv: KindVerdict, p: { tickLower: number; tickUpper: number; tickSpacing: number; fee: number }, valueUsd: number | undefined, minUsd: number): RuleDraft {
  const l = kv.limits;
  const gate = l.gateTicks ?? 0;
  const maxSlip = l.maxSlippageBps ?? BOUNDS.steward.hookFreeMaxSlippageBps;
  const swapFee = input.maxSwapFeePct !== undefined ? Math.round(input.maxSwapFeePct * 10_000) : Math.max(MAX_SWAP_FEE_DEFAULT_PIPS, l.poolFeePips ?? 0);
  if (input.kind === 'compound') {
    const slip = input.maxPriceProtectionBps ?? COMPOUND_SLIP_DEFAULT_BPS;
    if (input.venue === 'v3') {
      return { kind: 'compound', venue: 'v3', swapEnabled: input.swapToMatch ?? true, maxSlippageBps: slip, minInterval: hours(input.minIntervalHours, COMPOUND_INTERVAL_DEFAULT) } satisfies CompoundV3Draft;
    }
    const small = typeof valueUsd === 'number' && valueUsd > 0 && valueUsd < minUsd;
    const runs = input.runsToSign ?? (small ? SMALL_RUNS_TO_SIGN : RUNS_TO_SIGN_DEFAULT);
    const horizon = input.horizonDays ?? (small ? SMALL_HORIZON_DAYS : HORIZON_DEFAULT_DAYS);
    if (l.claimOnly && input.mode === 'addBack') refuse(ELIG.HOOK_CLAIM_ONLY);
    return {
      kind: 'compound', venue: 'v4', mode: input.mode ?? (l.claimOnly ? 'claim' : 'addBack'), maxSlippageBps: slip,
      minInterval: hours(input.minIntervalHours, signIntervalOf(horizon, runs)), runsToSign: runs, horizonDays: horizon,
    } satisfies CompoundV4Draft;
  }
  if (!(gate > 0)) refuse(LIMITS_UNREAD);
  const slip = input.maxPriceProtectionBps ?? slipDefault(maxSlip);
  if (input.kind === 'range') {
    if (input.triggerTicks !== undefined && input.triggerPct !== undefined) refuse('give the trigger as triggerTicks or triggerPct, not both.');
    const trigger = input.triggerTicks ?? (input.triggerPct !== undefined ? ticksOfPct(input.triggerPct) : gate + 1);
    if (input.venue === 'v4') {
      if (input.newWidthTicks !== undefined || input.newWidthPctEachSide !== undefined) refuse('a v4 auto-range move keeps the width of the position; the new width applies to v3 only.');
      return { kind: 'range', venue: 'v4', triggerTicks: trigger, slippageBps: slip, minInterval: hours(input.minIntervalHours, RANGE_INTERVAL_DEFAULT), maxSwapFeePips: swapFee } satisfies RangeV4Draft;
    }
    if (input.minIntervalHours !== undefined) refuse('v3 auto-range moves whenever the price passes the trigger; it has no interval.');
    if (input.newWidthTicks !== undefined && input.newWidthPctEachSide !== undefined) refuse('give the new width as newWidthTicks or newWidthPctEachSide, not both.');
    const minW = minWidth(gate, p.tickSpacing);
    const width = input.newWidthTicks ?? (input.newWidthPctEachSide !== undefined ? alignWidth(2 * ticksOfPct(input.newWidthPctEachSide), p.tickSpacing) : Math.max(minW, alignWidth(p.tickUpper - p.tickLower, p.tickSpacing)));
    return { kind: 'range', venue: 'v3', triggerTicks: trigger, widthTicks: width, slippageBps: slip } satisfies RangeV3Draft;
  }
  if (!input.lower && !input.upper) refuse(INVALID.exitNoSide);
  const side = (which: 'lower' | 'upper', s: ExitSideInput | undefined): ExitSide => {
    if (!s) return { on: false, tick: 0, swap: false };
    if (s.tick !== undefined && s.pctBeyondRange !== undefined) refuse(`give the ${which} exit as a tick or as pctBeyondRange, not both.`);
    const pct = s.pctBeyondRange ?? EXIT_DEFAULT_OFFSET_PCT;
    const tick = s.tick ?? (which === 'lower' ? p.tickLower - ticksDown(pct) : p.tickUpper + ticksUp(pct));
    return { on: true, tick, swap: s.swap === true };
  };
  const lower = side('lower', input.lower);
  const upper = side('upper', input.upper);
  if (input.venue === 'v4') return { kind: 'exit', venue: 'v4', lower, upper, slippageBps: slip, maxSwapFeePips: swapFee } satisfies ExitV4Draft;
  if (input.maxSwapFeePct !== undefined) refuse('the max swap fee applies to v4 exits only.');
  return { kind: 'exit', venue: 'v3', lower, upper, slippageBps: slip } satisfies ExitV3Draft;
}

function poolCtxOf(p: { tickSpacing: number; fee: number }, kv: KindVerdict): PoolCtx {
  const staticFee = p.fee < 0x800000 ? p.fee : 0;
  return { gate: kv.limits.gateTicks ?? 0, tickSpacing: p.tickSpacing, maxSlippageBps: kv.limits.maxSlippageBps ?? 100, floorFeePips: kv.limits.poolFeePips ?? staticFee };
}

/** The rule as the plan shows it */
function draftView(d: RuleDraft, p: { tickLower: number; tickUpper: number }, decimals: [number, number] | null, nowSec: number): Record<string, unknown> {
  const price = (t: number) => (decimals ? sig(tickToPrice(t, decimals[0], decimals[1])) : null);
  const at = (t: number) => ({ tick: t, ...(decimals ? { price: price(t) } : {}) });
  const every = (s: number) => (s % DAY === 0 ? `${s / DAY} day${s === DAY ? '' : 's'}` : `${Math.round(s / HOUR)} hour${s === HOUR ? '' : 's'}`);
  switch (`${d.kind}:${d.venue}`) {
    case 'compound:v3': { const x = d as CompoundV3Draft; return { swapToMatch: x.swapEnabled, maxPriceProtection: pctOfBps(x.maxSlippageBps), atMostOnceEvery: every(x.minInterval) }; }
    case 'compound:v4': {
      const x = d as CompoundV4Draft;
      return {
        mode: x.mode === 'claim' ? 'send the fees to the wallet' : 'add the fees back', maxPriceProtection: pctOfBps(x.maxSlippageBps), atMostOnceEvery: every(x.minInterval),
        signedRuns: x.runsToSign, signedUntil: new Date((nowSec + x.horizonDays * DAY) * 1000).toISOString(),
      };
    }
    case 'range:v4': {
      const x = d as RangeV4Draft;
      return {
        trigger: `${pctOfTicks(x.triggerTicks)} past the range (${x.triggerTicks} ticks)`, movesWhenBelow: at(p.tickLower - x.triggerTicks), movesWhenAbove: at(p.tickUpper + x.triggerTicks),
        newRange: 'the same width, centred on the price', maxPriceProtection: pctOfBps(x.slippageBps), atMostOneMoveEvery: every(x.minInterval),
        maxSwapFee: `${(x.maxSwapFeePips / 10_000).toFixed(2)}%`, movesAllowed: STEWARD_BUDGET,
      };
    }
    case 'range:v3': {
      const x = d as RangeV3Draft;
      return {
        trigger: `${pctOfTicks(x.triggerTicks)} past the range (${x.triggerTicks} ticks)`, movesWhenBelow: at(p.tickLower - x.triggerTicks), movesWhenAbove: at(p.tickUpper + x.triggerTicks),
        newWidth: `${x.widthTicks} ticks (${pctOfTicks(x.widthTicks)}), centred on the price`, maxPriceProtection: pctOfBps(x.slippageBps),
        note: 'Each move gives the position a new ID; the new position goes to the wallet.',
      };
    }
    default: {
      const x = d as ExitV3Draft | ExitV4Draft;
      const side = (s: ExitSide, swapTo: string) => (s.on ? { ...at(s.tick), then: s.swap ? `withdraw and swap all to ${swapTo}` : 'withdraw only' } : 'off');
      return {
        lower: side(x.lower, 'token1'), upper: side(x.upper, 'token0'), maxPriceProtection: pctOfBps(x.slippageBps),
        ...(x.venue === 'v4' && (x.lower.swap || x.upper.swap) ? { maxSwapFee: `${(x.maxSwapFeePips / 10_000).toFixed(2)}%` } : {}),
        note: 'Runs once, then turns itself off.',
      };
    }
  }
}

/** The fee lines of a kind (auto-compound: only the 10% fee and that Cashmere pays the gas) */
function feeLine(g: Gathered, kind: Kind, venue: Venue): string {
  const bps = g.env.contracts.feesBps?.[kind]?.[venue];
  if (kind === 'compound') return `${pctOfBps(bps ?? 1000)} of the fees it adds back (or sends to the wallet). Cashmere pays the gas.`;
  return kind === 'range' ? `${pctOfBps(bps ?? 15)} of the amount moved, per move.` : `${pctOfBps(bps ?? 15)}, once, when it closes the position.`;
}

// ------------------------------------------------------------------ set auto-range / auto-exit / auto-compound

export async function planSetAutomation(ctx: GoatLpContext, input: SetAutomationInput, nowSec: number): Promise<BuiltPlan> {
  const id = BigInt(input.id);
  const { kind, venue } = input;
  const g = await gather(ctx, venue, id);
  const signer = ctx.signer!;
  const verdict = positionVerdict(poolVerdict(g.pf, g.env.gates), g.f, { account: signer.address, onKinds: g.onKinds, contracts: g.env.contracts, valueUsd: g.valueUsd, minUsd: g.minUsd });
  const kv = verdict.kinds[kind];
  const name = KIND_NAME[kind];
  if (!kv.live) refuse(`${name} on ${VENUE_NAME[venue]}: ${kv.lines.find((l) => l.code === 'NOT_LIVE')?.why ?? ELIG.NOT_LIVE}`);
  const on = Array.isArray(g.onKinds) && g.onKinds.includes(kind);
  if (!kv.offered) refuse(`${name} is not offered for this position: ${blockOf(kv)?.text ?? 'see goatlp_position'}`);
  const c = g.env.contracts;
  const key = contractFor(kind, venue);
  if (c.paused?.[key] === true || (venue === 'v4' && kind !== 'compound' && typeof c.stewardPausedModes === 'number' && (c.stewardPausedModes & (kind === 'range' ? 1 : 2)) !== 0)) refuse(PAUSED_ALL_LINE);
  const approved = g.f.approved === 'unknown' ? refuse("couldn't read this position's permission on chain.") : g.f.approved ?? null;
  if (input.signMore && !(kind === 'compound' && venue === 'v4')) refuse('signMore applies to v4 auto-compound only.');
  const mode: 'turn-on' | 'change' | 'sign' = on ? (input.signMore ? 'sign' : 'change') : 'turn-on';
  if (input.signMore && !on) refuse('auto-compound is not on for this position; call without signMore to turn it on.');
  if (mode !== 'change' && approved && !isGoatSpender(approved, g.spenders)) {
    refuse(`another app (${approved}) is allowed to manage this position. ${kind === 'compound' && venue === 'v4' ? "Auto-compound can't run next to it." : 'Turning this on would replace that permission.'} This tool never changes another app's approval; remove it yourself first if that is what you want.`);
  }
  const p = { tickLower: g.f.tickLower, tickUpper: g.f.tickUpper, tickSpacing: g.f.tickSpacing, fee: g.pf.fee };
  const draft = buildDraft(input, kv, p, g.valueUsd, g.minUsd);
  const pool = poolCtxOf(p, kv);
  const swapAllowed = !kv.limits.exitWithdrawOnly;
  const change = mode !== 'turn-on';
  const fees = c.feesX64 ?? {};
  const to = TARGETS[key];
  let built: { ok: true; value: AutoCall } | { ok: false; errors: string[] };
  switch (`${kind}:${venue}`) {
    case 'compound:v3': built = v3CompoundEnable({ tokenId: id, draft: draft as CompoundV3Draft, gac3: to, change }); break;
    case 'compound:v4': built = v4CompoundEnable({ tokenId: id, draft: draft as CompoundV4Draft, gac4: to, change }); break;
    case 'range:v4': built = setRange({ tokenId: id, draft: draft as RangeV4Draft, steward: to, pool, widthTicks: p.tickUpper - p.tickLower, change }); break;
    case 'exit:v4': built = setExit({ tokenId: id, draft: draft as ExitV4Draft, steward: to, pool, tickLower: p.tickLower, tickUpper: p.tickUpper, swapAllowed, change }); break;
    case 'range:v3':
      if (fees.rangeFeeX64 === undefined) refuse("couldn't read the current auto-range fee.");
      built = v3RangeEnable({ tokenId: id, draft: draft as RangeV3Draft, autoRange: to, gate: pool.gate, tickSpacing: pool.tickSpacing, rangeFeeX64: fees.rangeFeeX64!, change }); break;
    default:
      if (fees.exitFeeX64 === undefined) refuse("couldn't read the current auto-exit fee.");
      built = v3ExitEnable({ tokenId: id, draft: draft as ExitV3Draft, autoExit: to, gate: pool.gate, tickLower: p.tickLower, tickUpper: p.tickUpper, swapAllowed, exitFeeX64: fees.exitFeeX64!, change });
  }
  if (!built.ok) refuse(built.errors.join(' '));
  const turnOn = (built as { ok: true; value: AutoCall }).value;
  const v4c = draft.kind === 'compound' && draft.venue === 'v4' ? draft : null;
  if (v4c && (!Number.isInteger(v4c.runsToSign) || v4c.runsToSign < 1 || v4c.runsToSign > MAX_RUNS_PER_SESSION)) refuse(INVALID.runs);
  if (v4c && (!Number.isInteger(v4c.horizonDays) || v4c.horizonDays < 1 || v4c.horizonDays > HORIZON_MAX_DAYS)) refuse(INVALID.horizon);
  const sign = v4c && mode !== 'change' ? { count: v4c.runsToSign, deadline: BigInt(nowSec + v4c.horizonDays * DAY) } : undefined;
  const stepsBuilt = mode === 'sign' ? null : turnOnSteps({ kind, venue, tokenId: id, spenders: g.spenders, approved, turnOn, change, sign });
  if (stepsBuilt && !stepsBuilt.ok) refuse(stepsBuilt.errors.join(' '));
  const intentOf = (k: string): GuardIntent => (k === 'allow' ? 'allow' : change ? 'change' : 'turn-on');
  const guardX = { kind, venue, pool: { ...pool, tickLower: p.tickLower, tickUpper: p.tickUpper, swapAllowed }, activeKinds: g.onKinds };
  const steps: PlanStep[] = [];
  const sessions: SignedSession[] = [];
  for (const s of stepsBuilt?.value ?? [{ key: 'sign' as const, label: STEP.sign(sign!.count), calls: [], sign }]) {
    if (s.key === 'sign') steps.push(await signStep(ctx, g, id, s.sign!, sessions));
    else for (const call of s.calls) steps.push(txStep(ctx, g, call, { ...guardX, intent: intentOf(s.key) }, () => verifyCall(ctx, call)));
  }
  if (sign) steps.push(postStep(ctx, id, sessions));
  // every transaction passes the decode check now, with the reads of this plan
  for (const s of steps) {
    if (s.kind !== 'tx') continue;
    const call = { to: s.to, data: s.data, value: s.value };
    const isAllow = s.label === STEP.allow;
    const v = assertAutomationTx({ ...call, chainId: GOAT_CHAIN_ID }, guardCtx(ctx, g, {
      ...guardX, intent: isAllow ? 'allow' : change ? 'change' : 'turn-on', chainId: g.env.chainId, account: signer.address, ownerOnChain: g.f.owner as Address,
      currentApproved: approved, tokenId: id,
    }));
    if (!v.ok) refuse(`${v.reason} (${v.rule}).`);
  }
  const notes = kv.lines.filter((l) => l.level !== 'block').map((l) => l.text);
  return {
    tool: `goatlp_set_auto_${kind}`,
    view: {
      action: mode === 'turn-on' ? `Turn on ${name.toLowerCase()}` : mode === 'change' ? `Change the ${name.toLowerCase()} rule that is on` : 'Sign more auto-compound runs',
      position: positionView(g, venue, id),
      rule: draftView(draft, p, decimalsOf(g.api), nowSec),
      fee: feeLine(g, kind, venue),
      permission: kind === 'compound' && venue === 'v4'
        ? 'No permission on the position NFT: each run uses one signed message, valid only for GoatAutoCompoundV4, this position and until the end date.'
        : `This position only, to ${pinOf(spenderFor(kind, venue, g.spenders) ?? '')?.pin.name ?? 'the automation contract'}. Never a permission for all positions.`,
      ...(notes.length ? { notes } : {}),
    },
    steps,
    readBack: async () => {
      const [f] = await loadPositionFacts(ctx.chain, [{ id, venue }], await ctx.env());
      const r = f.rules?.[kind];
      return { rule: r && r !== 'unknown' ? describeRule(r as RuleRead, decimalsOf(g.api), { tickLower: f.tickLower, tickUpper: f.tickUpper }) : r === 'unknown' ? "couldn't read" : { on: false } };
    },
  };
}

/** The signing step of v4 auto-compound: one session (a fresh nonce word), N messages, each checked before it is signed */
async function signStep(ctx: GoatLpContext, g: Gathered, id: bigint, sign: { count: number; deadline: bigint }, sessions: SignedSession[]): Promise<WorkStep> {
  const signer = ctx.signer!;
  const gac4 = TARGETS.autoCompoundV4;
  const owner = signer.address;
  const stored = await listStoredSessions(ctx.api, id);
  const base = permitWord(gac4, id);
  const recorded = [...ownSessions(base, stored?.sessions ?? []), ...ownSessions(base, ctx.sessions.list(owner, id))].map((s) => s.word);
  const readNonces = (o: Address, w: bigint) => ctx.chain.read<bigint>({ address: POSM, abi: posmAbi, functionName: 'nonces', args: [o, w] });
  const word = await allocateSessionWord(readNonces, { owner, gac4, tokenId: id, recordedWords: recorded });
  const nonces = sessionNonces(word, sign.count);
  return {
    kind: 'sign', label: STEP.sign(sign.count), key: `${lc(gac4)}|${id}|${word}|${sign.count}|${sign.deadline}`,
    view: {
      type: 'signatures', count: sign.count, gas: 'none', message: 'Permit(spender, tokenId, nonce, deadline) of the Uniswap v4 position NFT',
      spender: `GoatAutoCompoundV4 ${gac4}`, position: id.toString(), nonceWord: word.toString(), validUntil: new Date(Number(sign.deadline) * 1000).toISOString(),
    },
    run: async () => {
      const pins = await checkPins(ctx.chain, ['autoCompoundV4', 'posm', 'compoundorV4']);
      const bad = Object.values(pins).find((x) => !x.ok);
      const [chainId, ownerNow, sep] = await Promise.all([
        ctx.chain.chainId(),
        ctx.chain.read<Address>({ address: POSM, abi: posmAbi, functionName: 'ownerOf', args: [id] }),
        ctx.chain.read<Hex>({ address: POSM, abi: posmAbi, functionName: 'DOMAIN_SEPARATOR' }),
      ]);
      const items = nonces.map((nonce) => permitTypedData({ spender: gac4, tokenId: id, nonce, deadline: sign.deadline }));
      for (const td of items) {
        const c = checkAutomationTypedData(td, {
          chainId, gac4, tokenId: id, allowedNonces: nonces, onchainDomainSeparator: sep, nowSec: ctx.nowSec(), gac4Target: TARGETS.autoCompoundV4,
          gateOk: !bad && g.env.gates.autoCompoundV4.ok, ownerOk: eq(ownerNow, owner),
        });
        if (!c.ok) throw new Error(`Not signed: ${c.reason} (${c.rule}).`);
      }
      const signed: SignedSession['signatures'] = [];
      for (const td of items) signed.push({ nonce: td.message.nonce, signature: await signer.signTypedData(td) });
      // a wallet with code (a 7702 delegation) may not produce signatures the position NFT accepts: checked on the first
      const code = await ctx.chain.getCode(owner);
      if (code && code !== '0x') {
        const permit = { to: POSM, data: encodePermit(gac4, id, sign.deadline, signed[0].nonce, signed[0].signature), value: 0n };
        if (await simulate(ctx.chain, owner, permit)) throw new Error(ELIG.WALLET_CANNOT_SIGN);
      }
      sessions.push({ word, deadline: sign.deadline, signatures: signed });
      ctx.sessions.add(owner, id, { word, size: signed.length, deadline: sign.deadline });
      return { signed: signed.length, validUntil: new Date(Number(sign.deadline) * 1000).toISOString() };
    },
  };
}

/** POSM.permit(spender, tokenId, deadline, nonce, signature): simulated only, never sent */
function encodePermit(spender: Address, tokenId: bigint, deadline: bigint, nonce: bigint, signature: Hex): Hex {
  return encodeFunctionData({ abi: posmAbi as unknown as Abi, functionName: 'permit', args: [spender, tokenId, deadline, nonce, signature] });
}

/** The hand-over of the signed sessions to the keeper store, after the rule is on */
function postStep(ctx: GoatLpContext, id: bigint, sessions: SignedSession[]): WorkStep {
  const signer = ctx.signer!;
  return {
    kind: 'post', label: STEP.post, key: `${id}|keeper-store`,
    view: { type: 'hand-over', to: `${ctx.api.base}/automation/permits`, what: 'the signed messages of this plan (no gas); the keeper uses one per run' },
    run: async () => {
      const ownerNow = await ctx.chain.read<Address>({ address: POSM, abi: posmAbi, functionName: 'ownerOf', args: [id] });
      for (const s of sessions) {
        const why = handOverRefusal({ owner: signer.address, ownerOnChain: ownerNow, gac4: TARGETS.autoCompoundV4, spender: TARGETS.autoCompoundV4, tokenId: id, session: s, nowSec: ctx.nowSec() });
        if (why) throw new Error(`Not handed over: ${why}.`);
      }
      const ok = await handOverSessions(sessions, (s) => postSession(ctx.api, signer.address, id, s));
      return ok
        ? { handedOver: true, messages: sessions.reduce((a, s) => a + s.signatures.length, 0) }
        : { handedOver: false, note: 'The rule is on, but the keeper store did not take the signed messages, so no run can happen yet. Call goatlp_set_auto_compound with signMore: true to sign and hand over a new batch.' };
    },
  };
}

// ------------------------------------------------------------------ stop

export interface StopInput { kind: Kind; venue: Venue; id: string }

export async function planStop(ctx: GoatLpContext, input: StopInput): Promise<BuiltPlan> {
  const id = BigInt(input.id);
  const { kind, venue } = input;
  const g = await gather(ctx, venue, id);
  const signer = ctx.signer!;
  const key = contractFor(kind, venue);
  if (!g.env.gates[key].ok) refuse(`${KIND_NAME[kind]} on ${VENUE_NAME[venue]}: ${g.env.gates[key].reason}`);
  const r = g.f.rules?.[kind];
  if (r === 'unknown' || r === undefined) refuse(`couldn't read the ${KIND_NAME[kind].toLowerCase()} rule of this position on chain.`);
  const approved = g.f.approved === 'unknown' ? refuse("couldn't read this position's permission on chain.") : g.f.approved ?? null;
  const ruleOn = !!r && r.on;
  let revokeNonces: bigint[] = [];
  let signedNote: string | undefined;
  if (kind === 'compound' && venue === 'v4') {
    const gac4 = TARGETS.autoCompoundV4;
    const base = permitWord(gac4, id);
    const owner = signer.address;
    const stored = await listStoredSessions(ctx.api, id);
    const fromStore = ownSessions(base, stored?.sessions ?? []);
    const sessions: SessionRecord[] = fromStore.length ? fromStore : ownSessions(base, ctx.sessions.list(owner, id));
    const read = (o: Address, w: bigint) => ctx.chain.read<bigint>({ address: POSM, abi: posmAbi, functionName: 'nonces', args: [o, w] });
    const bitmaps = new Map<string, bigint>();
    for (const s of sessions) bitmaps.set(String(s.word), await read(owner, s.word));
    let fallbackWords: bigint[] = [];
    if (!sessions.length) {
      const scan = await scanSessionWords(read, { owner, gac4, tokenId: id });
      fallbackWords = scan.words;
      for (const [k, v] of scan.bitmaps) bitmaps.set(k, v);
    }
    revokeNonces = revokeSet({ base, sessions, bitmaps, fallbackWords });
    signedNote = sessions.length ? `${revokeNonces.length} signed and unused messages are cancelled.` : `No record of the signed messages: every unused nonce of this position's signing window that may hold one is cancelled (${revokeNonces.length}).`;
  }
  const plan = stopPlan(kind, venue, { tokenId: id, targets: TARGETS, spenders: g.spenders, approved, revokeNonces, ruleOn });
  if (!plan.ok) refuse(plan.errors.join(' '));
  const calls = (plan as { ok: true; value: AutoCall[] }).value;
  if (!calls.length) refuse(`nothing to stop: ${KIND_NAME[kind].toLowerCase()} is off and no Goat LP permission or signed message is left on this position.`);
  const guardX = { kind, venue, intent: 'stop' as const, revokeAllowed: revokeNonces, activeKinds: [] as Kind[] };
  for (const call of calls) {
    const v = assertAutomationTx({ to: call.to, data: call.data, value: call.value, chainId: GOAT_CHAIN_ID }, guardCtx(ctx, g, {
      ...guardX, chainId: g.env.chainId, account: signer.address, ownerOnChain: g.f.owner as Address, currentApproved: approved, tokenId: id,
    }));
    if (!v.ok) refuse(`${v.reason} (${v.rule}).`);
  }
  const steps: PlanStep[] = calls.map((call) => txStep(ctx, g, call, guardX, () => verifyCall(ctx, call)));
  if (kind === 'compound' && venue === 'v4') {
    steps.push({
      kind: 'post', label: 'Ask the keeper store to drop the signed messages', key: `${id}|keeper-store-delete`,
      view: { type: 'hand-over', to: `${ctx.api.base}/automation/permits/${id}`, what: 'DELETE: the cancel on chain is what makes them unusable; the store then holds nothing the keeper could use' },
      run: async () => {
        const ok = await deleteStoredSessions(ctx.api, id);
        ctx.sessions.clear(signer.address, id);
        return { storeCleared: ok };
      },
    });
  }
  const approvedHere = !!approved && isGoatSpender(approved, g.spenders);
  return {
    tool: 'goatlp_stop_automation',
    view: {
      action: `Stop ${KIND_NAME[kind].toLowerCase()}`,
      position: positionView(g, venue, id),
      ruleNow: r ? describeRule(r as RuleRead, decimalsOf(g.api), { tickLower: g.f.tickLower, tickUpper: g.f.tickUpper }) : { on: false },
      removes: [
        ...(ruleOn ? [`the ${KIND_NAME[kind].toLowerCase()} rule`] : []),
        ...(approvedHere && eq(approved, kind === 'compound' && venue === 'v4' ? g.spenders.autoCompoundV4 : spenderFor(kind, venue, g.spenders)) ? ['this automation\'s permission on the position'] : []),
        ...(signedNote ? [signedNote] : []),
      ],
      ...(approved && !approvedHere ? { leftAlone: `another app's approval (${approved}) is not touched` } : {}),
      afterwards: 'The position stays as it is: same range and tokens, and fees keep accruing.',
    },
    steps,
    readBack: async () => {
      const [f] = await loadPositionFacts(ctx.chain, [{ id, venue }], await ctx.env());
      const rr = f.rules?.[kind];
      return { ruleOn: rr === 'unknown' ? 'unknown' : !!rr && rr.on, permission: f.approved === 'unknown' ? 'unknown' : f.approved ?? 'none' };
    },
  };
}


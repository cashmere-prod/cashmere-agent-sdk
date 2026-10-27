// Rule validators shared by the builders (before encoding) and the decode check (on the decoded final bytes), so an
// argument changed after building still fails. The bounds are the contracts' own checks plus the launch policy.
// Validators never clamp: they return the list of problems ([] = fine).
import { BOUNDS, HORIZON_MAX_SEC, MAX_RUNS_PER_SESSION, ST_FLAG, STEWARD_BUDGET } from './constants';
import { INVALID, pctOfBps, pctOfPips, pctOfTicks } from './copy';

export const Q64 = 1n << 64n;
/** v3 price protection cap: 1% in X64 */
export const V3_MAX_SLIPPAGE_X64 = Q64 / 100n;
export const MIN_TICK = BOUNDS.tick.min;
export const MAX_TICK = BOUNDS.tick.max;
/** v3 AutoExit "side off" ticks */
export const V3_EXIT_OFF_LOW = MIN_TICK - 1;
export const V3_EXIT_OFF_HIGH = MAX_TICK + 1;

const int = (n: unknown) => typeof n === 'number' && Number.isInteger(n);

/** bps -> X64 (rounded down) */
export const bpsToX64 = (bps: number): bigint => (BigInt(Math.round(bps)) * Q64) / 10_000n;
/** X64 -> bps (rounded) */
export const x64ToBps = (x: bigint): number => Number((x * 10_000n + Q64 / 2n) / Q64);

// ------------------------------------------------------------------ auto-compound

export interface Gac3CfgIn { enabled: boolean; swapEnabled: boolean; maxSlippageBps: number; minInterval: number; lastRunAt: number | bigint; minReward0: bigint; minReward1: bigint }
export function validateGac3(c: Gac3CfgIn): string[] {
  const e: string[] = [];
  if (!int(c.maxSlippageBps) || c.maxSlippageBps < 0 || c.maxSlippageBps > BOUNDS.gac3.maxSlippageBps) e.push(INVALID.compoundSlipV3);
  if (c.enabled) {
    if (!int(c.minInterval) || c.minInterval < BOUNDS.gac3.minInterval) e.push(INVALID.interval);
    if (c.swapEnabled && c.maxSlippageBps === 0) e.push(INVALID.compoundSlipV3);
  }
  if (BigInt(c.lastRunAt) !== 0n) e.push('lastRunAt must be 0 (only runs write it).');
  if (c.minReward0 !== 0n || c.minReward1 !== 0n) e.push('minReward must be 0.');
  return e;
}

export interface Gac4CfgIn { enabled: boolean; claimOnly: boolean; allowStandingApproval: boolean; maxSlippageBps: number; minInterval: number; lastRunAt: number | bigint; minLiquidityDelta: bigint }
/** Signed-message mode only: the standing-approval flag is never set by this package. */
export function validateGac4(c: Gac4CfgIn): string[] {
  const e: string[] = [];
  if (!int(c.maxSlippageBps) || c.maxSlippageBps < 0 || c.maxSlippageBps > BOUNDS.gac4.maxSlippageBps) e.push(INVALID.compoundSlipV4);
  if (c.enabled) {
    if (!c.claimOnly && c.maxSlippageBps === 0) e.push(INVALID.compoundSlipV4);
    if (!int(c.minInterval) || c.minInterval < BOUNDS.gac4.minInterval) e.push(INVALID.interval);
  }
  if (c.allowStandingApproval) e.push('The per-run approval mode is not offered: auto-compound on v4 runs on signed messages only.');
  if (BigInt(c.lastRunAt) !== 0n) e.push('lastRunAt must be 0 (only runs write it).');
  if (c.minLiquidityDelta !== 0n) e.push('minLiquidityDelta must be 0.');
  return e;
}

/** A signing session: 1..30 messages and a deadline in (now, now + 90 days] */
export function validateSession(x: { count: number; deadline: bigint; nowSec: number }): string[] {
  const e: string[] = [];
  if (!int(x.count) || x.count < 1 || x.count > MAX_RUNS_PER_SESSION) e.push(INVALID.runs);
  if (x.deadline <= BigInt(x.nowSec) || x.deadline > BigInt(x.nowSec + HORIZON_MAX_SEC)) e.push(INVALID.horizon);
  return e;
}

// ------------------------------------------------------------------ v4 Steward

export interface PoolCtx {
  /** the pair's gate G in ticks (read on chain) */
  gate: number;
  tickSpacing: number;
  /** the pool's price protection cap for auto-range / auto-exit (bps) */
  maxSlippageBps: number;
  /** floor of the max swap fee (the static pool fee, else 0, which means at least 1) */
  floorFeePips: number;
}

export interface RangeParamsIn { triggerTicks: number; slippageBps: number; minInterval: number; budget: number; standing: boolean; maxSwapFeePips: number }
export function validateRangeV4(p: RangeParamsIn, ctx: PoolCtx & { widthTicks: number }): string[] {
  const e: string[] = [];
  const S = BOUNDS.steward;
  if (!int(p.triggerTicks) || p.triggerTicks <= ctx.gate) e.push(INVALID.trigger(pctOfTicks(ctx.gate + 1)));
  else if (p.triggerTicks > S.maxTriggerTicks) e.push(INVALID.triggerMax);
  if (!int(p.slippageBps) || p.slippageBps < S.minSlippageBps || p.slippageBps > ctx.maxSlippageBps) e.push(INVALID.rangeSlip(pctOfBps(ctx.maxSlippageBps)));
  if (!int(p.minInterval) || p.minInterval < S.minInterval || p.minInterval > S.maxInterval) e.push(INVALID.rangeInterval);
  if (!int(p.budget) || p.budget < 1 || p.budget > STEWARD_BUDGET) e.push('Moves allowed must be between 1 and 20.');
  if (p.standing !== false) e.push('A permission for all positions is never used: the rule covers this position only.');
  const floor = Math.max(1, ctx.floorFeePips);
  if (!int(p.maxSwapFeePips) || p.maxSwapFeePips < floor || p.maxSwapFeePips > S.maxSwapFeePips) e.push(INVALID.swapFee(pctOfPips(floor)));
  const minW = minWidth(ctx.gate, ctx.tickSpacing);
  if (ctx.widthTicks < minW) e.push(INVALID.width(pctOfTicks(minW)));
  return e;
}

export interface ExitParamsIn { flags: number; lowerTrigger: number; upperTrigger: number; slippageBps: number; maxSwapFeePips: number }
export function validateExitV4(p: ExitParamsIn, ctx: PoolCtx & { tickLower: number; tickUpper: number; swapAllowed: boolean }): string[] {
  const e: string[] = [];
  const S = BOUNDS.steward;
  const F = ST_FLAG;
  const lowerOn = (p.flags & F.LOWER_ON) !== 0;
  const upperOn = (p.flags & F.UPPER_ON) !== 0;
  const swapLower = (p.flags & F.SWAP_ON_LOWER) !== 0;
  const swapUpper = (p.flags & F.SWAP_ON_UPPER) !== 0;
  const swap = swapLower || swapUpper;
  if (!int(p.flags) || p.flags < 0 || p.flags > 15) e.push('Exit flags out of range (the permission for all positions is never used).');
  if (!lowerOn && !upperOn) e.push(INVALID.exitNoSide);
  if ((swapLower && !lowerOn) || (swapUpper && !upperOn)) e.push(INVALID.exitSwapNeedsSide);
  if (swap && !ctx.swapAllowed) e.push(INVALID.exitSwapNotOffered);
  if (!int(p.slippageBps) || p.slippageBps < S.minSlippageBps || p.slippageBps > ctx.maxSlippageBps) e.push(INVALID.rangeSlip(pctOfBps(ctx.maxSlippageBps)));
  const pct = pctOfTicks(ctx.gate + 1);
  if (lowerOn && (!int(p.lowerTrigger) || p.lowerTrigger < MIN_TICK || p.lowerTrigger > ctx.tickLower - ctx.gate - 1)) e.push(INVALID.exitLower(pct));
  if (upperOn && (!int(p.upperTrigger) || p.upperTrigger > MAX_TICK || p.upperTrigger < ctx.tickUpper + ctx.gate + 1)) e.push(INVALID.exitUpper(pct));
  if (!lowerOn && p.lowerTrigger !== 0) e.push('A side that is off carries no level.');
  if (!upperOn && p.upperTrigger !== 0) e.push('A side that is off carries no level.');
  if (swap) {
    const floor = Math.max(1, ctx.floorFeePips);
    if (!int(p.maxSwapFeePips) || p.maxSwapFeePips < floor || p.maxSwapFeePips > S.maxSwapFeePips) e.push(INVALID.swapFee(pctOfPips(floor)));
  } else if (p.maxSwapFeePips !== 0) e.push('The max swap fee is 0 when no side swaps.');
  return e;
}

/** The narrowest auto-range width: roundUp(max(400, 2 (G + tickSpacing)), tickSpacing) */
export function minWidth(gate: number, tickSpacing: number): number {
  const ts = tickSpacing > 0 ? tickSpacing : 1;
  return Math.ceil(Math.max(BOUNDS.steward.minWidthTicks, 2 * (gate + ts)) / ts) * ts;
}

// ------------------------------------------------------------------ v3 AutoRange / AutoExit

export interface ArCfgIn { lowerTickLimit: number; upperTickLimit: number; lowerTickDelta: number; upperTickDelta: number; token0SlippageX64: bigint; token1SlippageX64: bigint; onlyFees: boolean; autoCompound: boolean; maxRewardX64: bigint }
/** An active rule (deltas differ) gets every check; the off rule (all zero) only the fixed flags. */
export function validateAr(c: ArCfgIn, ctx: { gate: number; tickSpacing: number; rangeFeeX64: bigint }): string[] {
  const e: string[] = [];
  if (c.onlyFees || c.autoCompound) e.push('The fee-only and combined compound modes are not offered.');
  if (c.token0SlippageX64 > V3_MAX_SLIPPAGE_X64 || c.token1SlippageX64 > V3_MAX_SLIPPAGE_X64) e.push(INVALID.rangeSlip('1.00%'));
  const off = c.lowerTickDelta === c.upperTickDelta;
  if (off) {
    if (c.lowerTickDelta !== 0 || c.lowerTickLimit !== 0 || c.upperTickLimit !== 0) e.push('Turning off sends an all-zero rule.');
    return e;
  }
  const ts = ctx.tickSpacing > 0 ? ctx.tickSpacing : 1;
  if (c.lowerTickDelta > c.upperTickDelta) e.push(INVALID.widthStep);
  if (c.lowerTickLimit !== c.upperTickLimit) e.push('Both sides use the same trigger distance.');
  if (!int(c.lowerTickLimit) || c.lowerTickLimit < ctx.gate + 1 || c.lowerTickLimit > 0xffffff) e.push(INVALID.trigger(pctOfTicks(ctx.gate + 1)));
  const w = c.upperTickDelta - c.lowerTickDelta;
  const s = c.lowerTickDelta + c.upperTickDelta;
  if (w % ts !== 0) e.push(INVALID.widthStep);
  if (w < minWidth(ctx.gate, ts)) e.push(INVALID.width(pctOfTicks(minWidth(ctx.gate, ts))));
  if (w > 2 * MAX_TICK) e.push(INVALID.width(pctOfTicks(minWidth(ctx.gate, ts))));
  if (Math.abs(s) > ts) e.push('The new range must be centred on the price.');
  if (c.token0SlippageX64 !== c.token1SlippageX64 || c.token0SlippageX64 < bpsToX64(10)) e.push(INVALID.rangeSlip('1.00%'));
  if (c.maxRewardX64 !== ctx.rangeFeeX64) e.push('The fee agreed must be the live auto-range fee.');
  return e;
}

export interface AeCfgIn { isActive: boolean; token0Swap: boolean; token1Swap: boolean; token0TriggerTick: number; token1TriggerTick: number; token0SlippageX64: bigint; token1SlippageX64: bigint; onlyFees: boolean; maxRewardX64: bigint }
export function validateAe(c: AeCfgIn, ctx: { gate: number; tickLower: number; tickUpper: number; swapAllowed: boolean; exitFeeX64: bigint }): string[] {
  const e: string[] = [];
  if (c.onlyFees) e.push('The fee-only mode is not offered.');
  if (c.token0SlippageX64 > V3_MAX_SLIPPAGE_X64 || c.token1SlippageX64 > V3_MAX_SLIPPAGE_X64) e.push(INVALID.rangeSlip('1.00%'));
  if (!c.isActive) {
    if (c.token0Swap || c.token1Swap) e.push('A rule that is off has no swap side.');
    return e;
  }
  if (c.token0TriggerTick >= c.token1TriggerTick) e.push(INVALID.exitNoSide);
  const lowerOn = c.token0TriggerTick !== V3_EXIT_OFF_LOW;
  const upperOn = c.token1TriggerTick !== V3_EXIT_OFF_HIGH;
  if (!lowerOn && !upperOn) e.push(INVALID.exitNoSide);
  if ((c.token0Swap && !lowerOn) || (c.token1Swap && !upperOn)) e.push(INVALID.exitSwapNeedsSide);
  if ((c.token0Swap || c.token1Swap) && !ctx.swapAllowed) e.push(INVALID.exitSwapNotOffered);
  const pct = pctOfTicks(ctx.gate + 1);
  if (lowerOn && (c.token0TriggerTick < MIN_TICK || c.token0TriggerTick > ctx.tickLower - ctx.gate - 1)) e.push(INVALID.exitLower(pct));
  if (upperOn && (c.token1TriggerTick > MAX_TICK || c.token1TriggerTick < ctx.tickUpper + ctx.gate + 1)) e.push(INVALID.exitUpper(pct));
  if (c.token0SlippageX64 !== c.token1SlippageX64 || c.token0SlippageX64 < bpsToX64(10)) e.push(INVALID.rangeSlip('1.00%'));
  if (c.maxRewardX64 !== ctx.exitFeeX64) e.push('The fee agreed must be the live auto-exit fee.');
  return e;
}

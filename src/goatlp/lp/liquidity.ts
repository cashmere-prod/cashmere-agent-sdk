// Liquidity and range math (Uniswap LiquidityAmounts, exact bigint) and the tick <-> price helpers. Prices are token1 per
// token0 in human units (decimals applied): the raw tick price 1.0001^tick is raw token1 per raw token0.
import { getSqrtRatioAtTick, MAX_TICK, MIN_TICK } from './tickMath';

const Q96 = 1n << 96n;
const LN_1_0001 = Math.log(1.0001);

export interface TickRange { tickLower: number; tickUpper: number }

export const minUsableTick = (spacing: number) => Math.ceil(MIN_TICK / spacing) * spacing;
export const maxUsableTick = (spacing: number) => Math.floor(MAX_TICK / spacing) * spacing;

export function alignTick(tick: number, spacing: number, mode: 'floor' | 'ceil' | 'nearest' = 'nearest'): number {
  if (!Number.isFinite(tick) || spacing <= 0) throw new Error('bad tick or spacing');
  const q = tick / spacing;
  const k = mode === 'floor' ? Math.floor(q) : mode === 'ceil' ? Math.ceil(q) : Math.round(q);
  return Math.min(maxUsableTick(spacing), Math.max(minUsableTick(spacing), k * spacing)) + 0;
}

/** tick -> human price (token1 per token0) */
export function tickToPrice(tick: number, d0: number, d1: number): number {
  return Math.pow(1.0001, tick) * 10 ** (d0 - d1);
}

/** human price (token1 per token0) -> tick, rounded down */
export function priceToTick(price: number, d0: number, d1: number): number {
  if (!(price > 0) || !Number.isFinite(price)) throw new Error('price must be > 0');
  const raw = price * 10 ** (d1 - d0);
  return Math.floor(Math.log(raw) / LN_1_0001 + 1e-9);
}

export const inRange = (tick: number, r: TickRange) => tick >= r.tickLower && tick < r.tickUpper;

/**
 * A range `pctBelow` percent under and `pctAbove` percent over the current price, aligned outwards to the tick spacing. The
 * result always holds the current tick.
 */
export function rangeAroundPrice(currentTick: number, spacing: number, pctBelow: number, pctAbove: number): TickRange {
  if (!(pctBelow > 0 && pctBelow < 100) || !(pctAbove > 0)) throw new Error('the percentages must be above 0 (and below 100 under the price)');
  const down = Math.log(1 - pctBelow / 100) / LN_1_0001;
  const up = Math.log(1 + pctAbove / 100) / LN_1_0001;
  let tl = alignTick(currentTick + down, spacing, 'floor');
  let tu = alignTick(currentTick + up, spacing, 'ceil');
  if (tl > currentTick) tl = alignTick(currentTick, spacing, 'floor');
  if (tu <= currentTick) tu = alignTick(currentTick, spacing, 'floor') + spacing;
  if (tu <= tl) tu = tl + spacing;
  return { tickLower: tl, tickUpper: tu };
}

/** The full usable range of a tick spacing */
export const fullRange = (spacing: number): TickRange => ({ tickLower: minUsableTick(spacing), tickUpper: maxUsableTick(spacing) });

// ------------------------------------------------------------------ liquidity

export function liquidityForAmount0(sa: bigint, sb: bigint, a0: bigint): bigint {
  if (sa > sb) [sa, sb] = [sb, sa];
  return (a0 * ((sa * sb) / Q96)) / (sb - sa);
}
export function liquidityForAmount1(sa: bigint, sb: bigint, a1: bigint): bigint {
  if (sa > sb) [sa, sb] = [sb, sa];
  return (a1 * Q96) / (sb - sa);
}
export function liquidityForAmounts(sqrtP: bigint, sa: bigint, sb: bigint, a0: bigint, a1: bigint): bigint {
  if (sa > sb) [sa, sb] = [sb, sa];
  if (sqrtP <= sa) return liquidityForAmount0(sa, sb, a0);
  if (sqrtP < sb) {
    const l0 = liquidityForAmount0(sqrtP, sb, a0), l1 = liquidityForAmount1(sa, sqrtP, a1);
    return l0 < l1 ? l0 : l1;
  }
  return liquidityForAmount1(sa, sb, a1);
}

const divUp = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** The amounts liquidity L needs, rounded up (what a mint or an increase pays) */
export function amountsForLiquidityUp(sqrtP: bigint, sa: bigint, sb: bigint, L: bigint): { amount0: bigint; amount1: bigint } {
  if (sa > sb) [sa, sb] = [sb, sa];
  if (L <= 0n) return { amount0: 0n, amount1: 0n };
  const a0 = (lo: bigint, hi: bigint) => divUp(divUp((L << 96n) * (hi - lo), hi), lo);
  const a1 = (lo: bigint, hi: bigint) => divUp(L * (hi - lo), Q96);
  if (sqrtP <= sa) return { amount0: a0(sa, sb), amount1: 0n };
  if (sqrtP < sb) return { amount0: a0(sqrtP, sb), amount1: a1(sa, sqrtP) };
  return { amount0: 0n, amount1: a1(sa, sb) };
}

const amount0Down = (sa: bigint, sb: bigint, L: bigint) => ((L << 96n) * (sb - sa)) / sb / sa;
const amount1Down = (sa: bigint, sb: bigint, L: bigint) => (L * (sb - sa)) / Q96;

/** What liquidity L holds at the given price, rounded down (what a withdrawal returns) */
export function principalForLiquidity(tick: number, sqrtPriceX96: bigint, tickLower: number, tickUpper: number, liquidity: bigint): { amount0: bigint; amount1: bigint } {
  if (liquidity <= 0n) return { amount0: 0n, amount1: 0n };
  const sa = getSqrtRatioAtTick(tickLower), sb = getSqrtRatioAtTick(tickUpper);
  if (tick < tickLower) return { amount0: amount0Down(sa, sb, liquidity), amount1: 0n };
  if (tick < tickUpper) return { amount0: amount0Down(sqrtPriceX96, sb, liquidity), amount1: amount1Down(sa, sqrtPriceX96, liquidity) };
  return { amount0: 0n, amount1: amount1Down(sa, sb, liquidity) };
}

/** Raw price (raw token1 per raw token0) from sqrtPriceX96, as a float (display only) */
export function rawPriceFromSqrt(sqrtP: bigint): number {
  const s = Number(sqrtP) / 2 ** 96;
  return s * s;
}

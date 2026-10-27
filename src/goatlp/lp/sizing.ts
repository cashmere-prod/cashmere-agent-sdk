// Deposit sizing, as the app does it. The liquidity of a deposit and its limits come from the pool price read on chain
// and the range, never from the API. Exact bigint math.
//  - v4 (the call names the liquidity): the maxima come from a price band of +-b bps around the pool price, b being a
//    tenth of the range width and between 3 and 30 bps. L = min(L0 at the band's low end, L1 at its high end);
//    amount0Max = amount0(L) at the low end, amount1Max = amount1(L) at the high end. A price move inside the band goes
//    through; one past it reverts (only gas is spent). The maxima never exceed the amounts given.
//  - v3 (the position manager computes the liquidity): desired = what that liquidity needs at the pool price (never more
//    than given). The minimums come from the price band [P(1 - s), P / (1 - s)] of the slippage s: a move inside it goes
//    through, one past it reverts. An amount the band cannot size keeps the flat rule desired x (1 - s).
import { amountsForLiquidityUp, liquidityForAmount0, liquidityForAmount1, liquidityForAmounts, type TickRange } from './liquidity';
import { getSqrtRatioAtTick, isqrt, MAX_SQRT_RATIO, MIN_SQRT_RATIO } from './tickMath';

const Q96 = 1n << 96n;
export const MAX_U128 = (1n << 128n) - 1n;

/** The v4 price band: at most 30 bps, at least 3, a tenth of the range width in between */
export const V4_PRICE_BAND_BPS = 30n;
export const MIN_PRICE_BAND_BPS = 3n;
const BAND_WIDTH_DIVISOR = 10n;

/** The v4 band of a range, in bps */
export function adaptiveBandBps(r: TickRange): bigint {
  const ticks = Math.max(0, r.tickUpper - r.tickLower);
  const widthBps = (Math.pow(1.0001, Math.min(ticks, 200_000)) - 1) * 10_000;
  const b = BigInt(Math.floor(widthBps / Number(BAND_WIDTH_DIVISOR)));
  return b < MIN_PRICE_BAND_BPS ? MIN_PRICE_BAND_BPS : b > V4_PRICE_BAND_BPS ? V4_PRICE_BAND_BPS : b;
}

/** (L0, L1): the liquidity each amount gives on its own at sqrt price sqrtP (MAX for a side the range does not use) */
export function lFrom(sqrtP: bigint, r: TickRange, a0: bigint, a1: bigint): [bigint, bigint] {
  const sa = getSqrtRatioAtTick(r.tickLower), sb = getSqrtRatioAtTick(r.tickUpper);
  if (sqrtP <= sa) return [liquidityForAmount0(sa, sb, a0), MAX_U128];
  if (sqrtP < sb) return [liquidityForAmount0(sqrtP, sb, a0), liquidityForAmount1(sa, sqrtP, a1)];
  return [MAX_U128, liquidityForAmount1(sa, sb, a1)];
}

export interface Banded { liquidity: bigint; amount0Max: bigint; amount1Max: bigint; need0: bigint; need1: bigint }

/** The v4 band sizing: L and the two maxima (need = what L takes at the pool price) */
export function bandedLiquidity(sqrtP: bigint, r: TickRange, a0: bigint, a1: bigint, bandBps: bigint = V4_PRICE_BAND_BPS): Banded {
  if (bandBps < 0n || bandBps >= 10_000n) throw new Error('bad band');
  const pips = bandBps * 100n;
  const sLow = (sqrtP * (2_000_000n - pips)) / 2_000_000n;
  const sHigh = (sqrtP * (2_000_000n + pips)) / 2_000_000n;
  const [L0] = lFrom(sLow, r, a0, a1);
  const [, L1] = lFrom(sHigh, r, a0, a1);
  let L = L0 < L1 ? L0 : L1;
  if (L >= MAX_U128) L = 0n;
  const sa = getSqrtRatioAtTick(r.tickLower), sb = getSqrtRatioAtTick(r.tickUpper);
  const amount0Max = amountsForLiquidityUp(sLow, sa, sb, L).amount0;
  const amount1Max = amountsForLiquidityUp(sHigh, sa, sb, L).amount1;
  const need = amountsForLiquidityUp(sqrtP, sa, sb, L);
  return { liquidity: L, amount0Max, amount1Max, need0: need.amount0, need1: need.amount1 };
}

/** The other token's amount that `amount` of one side needs at the pool price (0 when the price is outside the range) */
export function otherSideAmount(sqrtP: bigint, r: TickRange, side: 0 | 1, amount: bigint): bigint {
  const sa = getSqrtRatioAtTick(r.tickLower), sb = getSqrtRatioAtTick(r.tickUpper);
  if (amount <= 0n || sqrtP <= sa || sqrtP >= sb) return 0n;
  const L = side === 0 ? liquidityForAmount0(sqrtP, sb, amount) : liquidityForAmount1(sa, sqrtP, amount);
  const need = amountsForLiquidityUp(sqrtP, sa, sb, L);
  return side === 0 ? need.amount1 : need.amount0;
}

// ------------------------------------------------------------------ v3 minimums from a price band

export const BAND_TOO_SMALL_TEXT = 'The amount is too small for this range and price move. Add more.';
export const BAND_EDGE_TEXT = 'The price is too close to the edge of your range for a one-token deposit. Try a different amount, or deposit both tokens.';

/** An amount the band rule cannot size: 'small' (the minimums add nothing) or 'edge' (a one-token add at the range edge) */
export class BandRefusal extends Error {
  constructor(readonly kind: 'small' | 'edge') {
    super(kind === 'small' ? BAND_TOO_SMALL_TEXT : BAND_EDGE_TEXT);
    this.name = 'BandRefusal';
  }
}

const BAND_MIN_BPS = 1n;
const BAND_MAX_BPS = 5000n;

/** The sqrt price ends of the band [P(1 - s), P / (1 - s)], rounded outwards and clamped */
export function bandEnds(sqrtRef: bigint, bps: bigint): { lo: bigint; hi: bigint } {
  if (bps < BAND_MIN_BPS || bps > BAND_MAX_BPS) throw new Error('bad band');
  if (sqrtRef < MIN_SQRT_RATIO || sqrtRef >= MAX_SQRT_RATIO) throw new Error('bad price');
  const R = isqrt(((10_000n - bps) << 192n) / 10_000n);
  let lo = (sqrtRef * R) >> 96n;
  const num = sqrtRef << 96n;
  let hi = num / R + (num % R === 0n ? 0n : 1n);
  if (lo < MIN_SQRT_RATIO) lo = MIN_SQRT_RATIO;
  if (lo > MAX_SQRT_RATIO - 1n) lo = MAX_SQRT_RATIO - 1n;
  if (hi > MAX_SQRT_RATIO - 1n) hi = MAX_SQRT_RATIO - 1n;
  return { lo, hi };
}

/** The v3 position manager's add at sqrt price x with desired (b0, b1): its liquidity, then the pool's round-up amounts */
function npmAdd(x: bigint, sa: bigint, sb: bigint, b0: bigint, b1: bigint): { L: bigint; u: [bigint, bigint] } {
  let L = liquidityForAmounts(x, sa, sb, b0 > 0n ? b0 : 0n, b1 > 0n ? b1 : 0n);
  if (L > MAX_U128) L = MAX_U128;
  if (L <= 0n) return { L: 0n, u: [0n, 0n] };
  const a = amountsForLiquidityUp(x, sa, sb, L);
  return { L, u: [a.amount0, a.amount1] };
}

const divUp = (a: bigint, b: bigint) => (a % b === 0n ? a / b : a / b + 1n);
const a0Up = (a: bigint, b: bigint, L: bigint) => divUp(divUp((L << 96n) * (b - a), b), a);
const a1Up = (a: bigint, b: bigint, L: bigint) => divUp(L * (b - a), Q96);

/** Rounding margin of token i: 2 + one unit of liquidity at the worst band price + the inner floor of the liquidity math + 1 */
function roundingDelta(i: 0 | 1, used: bigint, lo: bigint, hi: bigint, sa: bigint, sb: bigint): bigint {
  const perL = i === 0 ? (() => { const x = lo > sa ? lo : sa; return x >= sb ? 0n : a0Up(x, sb, 1n); })()
    : (() => { const x = hi < sb ? hi : sb; return x <= sa ? 0n : a1Up(sa, x, 1n); })();
  return 2n + perL + (used * Q96) / (sa * sb) + 1n;
}

export interface AddMins {
  mins: [bigint, bigint];
  /** token i's band end is past the range edge: its minimum is 1 wei (the add still uses some of it while the price is in range) */
  edge: [boolean, boolean];
  /** a one-token add whose band reaches the range: it reverts by itself once the price enters the range */
  outside: boolean;
}

/**
 * The minimums of a two-token add with desired F at the reference price xRef and the band ends xLo / xHi: a token unused at
 * the reference gets 0; a one-token add gets the reference amount less the margin; otherwise token0 at the band's upper end
 * and token1 at its lower end, less the margin; a band end past the range edge gives 1 wei (edge). Never 0 for a used token.
 */
export function addMins(F: readonly [bigint, bigint], sa: bigint, sb: bigint, xRef: bigint, xLo: bigint, xHi: bigint): AddMins {
  const [F0, F1] = F;
  const ref = npmAdd(xRef, sa, sb, F0, F1);
  const single = F0 <= 0n || F1 <= 0n;
  if (ref.L <= 0n) throw new BandRefusal(single && sa < xRef && xRef < sb ? 'edge' : 'small');
  const mins: [bigint, bigint] = [0n, 0n];
  const edge: [boolean, boolean] = [false, false];
  let outside = false;
  for (const i of [0, 1] as const) {
    const refU = ref.u[i];
    if (refU === 0n) continue;
    if ((i === 0 ? F1 : F0) <= 0n) {
      const d = roundingDelta(i, refU, xLo, xHi, sa, sb);
      mins[i] = refU > d ? refU - d : 1n;
      if ((i === 0 && xHi > sa) || (i === 1 && xLo < sb)) outside = true;
      continue;
    }
    const e = npmAdd(i === 0 ? xHi : xLo, sa, sb, F0, F1);
    if (e.L <= 0n) throw new BandRefusal('small');
    if (e.u[i] === 0n) { mins[i] = 1n; edge[i] = true; continue; }
    const d = roundingDelta(i, e.u[i], xLo, xHi, sa, sb);
    mins[i] = e.u[i] > d ? e.u[i] - d : 1n;
  }
  return { mins, edge, outside };
}

/** The minimums of a two-token v3 add of `desired` within +-bps of the pool price */
export function twoTokenBand(x: { sqrtP: bigint; tickLower: number; tickUpper: number; desired: readonly [bigint, bigint]; bps: bigint }): AddMins & { lo: bigint; hi: bigint } {
  const sa = getSqrtRatioAtTick(x.tickLower), sb = getSqrtRatioAtTick(x.tickUpper);
  const { lo, hi } = bandEnds(x.sqrtP, x.bps);
  return { ...addMins(x.desired, sa, sb, x.sqrtP, lo, hi), lo, hi };
}

export interface DepositSize {
  v4: { liquidity: bigint; amount0Max: bigint; amount1Max: bigint; add0: bigint; add1: bigint; bandBps: bigint };
  v3: { amount0Desired: bigint; amount1Desired: bigint; amount0Min: bigint; amount1Min: bigint; band: boolean; edge: [boolean, boolean]; outside: boolean };
}

/** A deposit of (in0, in1) into range r at sqrt price sqrtP: the v4 liquidity and maxima, and the v3 desired amounts and minimums */
export function sizeDeposit(sqrtP: bigint, r: TickRange, in0: bigint, in1: bigint, depositSlipBps: bigint, bandBps: bigint = adaptiveBandBps(r)): DepositSize {
  if (depositSlipBps < 0n || depositSlipBps >= 10_000n) throw new Error('bad slippage');
  const b = bandedLiquidity(sqrtP, r, in0, in1, bandBps);
  const dn = (x: bigint) => (x * (10_000n - depositSlipBps)) / 10_000n;
  const sa = getSqrtRatioAtTick(r.tickLower), sb = getSqrtRatioAtTick(r.tickUpper);
  const [L0, L1] = lFrom(sqrtP, r, in0, in1);
  const Lspot = L0 < L1 ? L0 : L1;
  const spot = Lspot >= MAX_U128 ? { amount0: 0n, amount1: 0n } : amountsForLiquidityUp(sqrtP, sa, sb, Lspot);
  const want0 = spot.amount0 > in0 ? in0 : spot.amount0, want1 = spot.amount1 > in1 ? in1 : spot.amount1;
  let m0 = dn(want0), m1 = dn(want1), band = false, edge: [boolean, boolean] = [false, false], outside = false;
  if (depositSlipBps >= 1n && depositSlipBps <= 5000n && (want0 > 0n || want1 > 0n)) {
    try {
      const t = twoTokenBand({ sqrtP, tickLower: r.tickLower, tickUpper: r.tickUpper, desired: [want0, want1], bps: depositSlipBps });
      m0 = t.mins[0]; m1 = t.mins[1]; band = true; edge = t.edge; outside = t.outside;
    } catch (e) { if (!(e instanceof BandRefusal)) throw e; }
  }
  return {
    v4: { liquidity: b.liquidity, amount0Max: b.amount0Max, amount1Max: b.amount1Max, add0: b.need0, add1: b.need1, bandBps },
    v3: { amount0Desired: want0, amount1Desired: want1, amount0Min: m0, amount1Min: m1, band, edge, outside },
  };
}

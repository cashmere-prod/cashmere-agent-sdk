// An exact (bigint) copy of Uniswap's TickMath. Exact on purpose: at a range edge one tick decides whether an amount is
// needed, and floating-point logarithms miss by one tick at the extreme prices.

export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const MIN_SQRT_RATIO = 4295128739n;
export const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;
const MAX_U256 = (1n << 256n) - 1n;

const MULS: readonly [number, bigint][] = [
  [0x2, 0xfff97272373d413259a46990580e213an], [0x4, 0xfff2e50f5f656932ef12357cf3c7fdccn],
  [0x8, 0xffe5caca7e10e4e61c3624eaa0941cd0n], [0x10, 0xffcb9843d60f6159c9db58835c926644n],
  [0x20, 0xff973b41fa98c081472e6896dfb254c0n], [0x40, 0xff2ea16466c96a3843ec78b326b52861n],
  [0x80, 0xfe5dee046a99a2a811c461f1969c3053n], [0x100, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
  [0x200, 0xf987a7253ac413176f2b074cf7815e54n], [0x400, 0xf3392b0822b70005940c7a398e4b70f3n],
  [0x800, 0xe7159475a2c29b7443b29c7fa6e889d9n], [0x1000, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000, 0xa9f746462d870fdf8a65dc1f90e061e5n], [0x4000, 0x70d869a156d2a1b890bb3df62baf32f7n],
  [0x8000, 0x31be135f97d08fd981231505542fcfa6n], [0x10000, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
  [0x20000, 0x5d6af8dedb81196699c329225ee604n], [0x40000, 0x2216e584f5fa1ea926041bedfe98n],
  [0x80000, 0x48a170391f7dc42444e8fa2n],
];

export function getSqrtRatioAtTick(tick: number): bigint {
  const abs = Math.abs(tick);
  if (!Number.isInteger(tick) || abs > MAX_TICK) throw new Error('tick out of range');
  let ratio = (abs & 0x1) !== 0 ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  for (const [bit, m] of MULS) if ((abs & bit) !== 0) ratio = (ratio * m) >> 128n;
  if (tick > 0) ratio = MAX_U256 / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

/** The largest tick t with getSqrtRatioAtTick(t) <= sqrtP (Uniswap's getTickAtSqrtRatio). */
export function getTickAtSqrtRatio(sqrtP: bigint): number {
  if (sqrtP < MIN_SQRT_RATIO || sqrtP >= MAX_SQRT_RATIO) throw new Error('sqrt price out of range');
  let lo = MIN_TICK, hi = MAX_TICK - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (getSqrtRatioAtTick(mid) <= sqrtP) lo = mid; else hi = mid - 1;
  }
  return lo;
}

export function isqrt(x: bigint): bigint {
  if (x < 0n) throw new Error('negative');
  if (x < 2n) return x;
  let z = x, y = (x >> 1n) + 1n;
  while (y < z) { z = y; y = (x / y + y) >> 1n; }
  return z;
}

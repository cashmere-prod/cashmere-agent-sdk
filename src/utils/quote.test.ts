import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_NATIVE_FEE, MAX_STABLE_FEE, checkQuote } from './quote';

const NOW = 1_800_000_000;
const ok = { fee: 81_734_491_955_605n, deadline: BigInt(NOW + 110), destinationDomain: 6 };
const request = { from: 'base' as const, dstDomain: 6, amount: 100_000_000n, isNative: true };

test('a quote like the ones the Gas API returns passes', () => {
  checkQuote(ok, request, NOW);
  // Oct 2026 quotes: 2.08 POL on Polygon, 9.5 MON on Monad, 0.27 APT, 0.21 SUI, 0.0019 SOL
  checkQuote({ ...ok, fee: 2_080_413_454_800_280_308n }, { ...request, from: 'polygon' }, NOW);
  checkQuote({ ...ok, fee: 9_500_000_000_000_000_000n }, { ...request, from: 'monad' }, NOW);
  checkQuote({ ...ok, fee: 26_875_332n }, { ...request, from: 'aptos' }, NOW);
  checkQuote({ ...ok, fee: 206_128_527n }, { ...request, from: 'sui' }, NOW);
  checkQuote({ ...ok, fee: 1_862_928n }, { ...request, from: 'solana' }, NOW);
  checkQuote({ ...ok, fee: 190_000n }, { ...request, isNative: false }, NOW);
});

test('a quote for another destination is refused', () => {
  assert.throws(() => checkQuote({ ...ok, destinationDomain: 5 }, request, NOW), /^Error: Not sent: the Gas API quote is for CCTP domain 5, not the requested 6$/);
});

test('fees above the caps are refused before signing', () => {
  assert.throws(() => checkQuote({ ...ok, fee: MAX_NATIVE_FEE.base + 1n }, request, NOW), /Not sent: .*native fee/);
  assert.throws(() => checkQuote({ ...ok, fee: MAX_NATIVE_FEE.polygon + 1n }, { ...request, from: 'polygon' }, NOW), /native fee/);
  assert.throws(() => checkQuote({ ...ok, fee: MAX_STABLE_FEE + 1n }, { ...request, isNative: false }, NOW), /USDC fee/);
  // A USDC fee that would leave the recipient nothing
  assert.throws(() => checkQuote({ ...ok, fee: 1_000_000n }, { ...request, isNative: false, amount: 1_000_000n }, NOW), /USDC fee/);
});

test('an expired quote, or one that lasts over an hour, is refused', () => {
  assert.throws(() => checkQuote({ ...ok, deadline: BigInt(NOW - 120) }, request, NOW), /already expired/);
  // A few seconds behind the local clock is clock skew, not expiry
  checkQuote({ ...ok, deadline: BigInt(NOW - 10) }, request, NOW);
  assert.throws(() => checkQuote({ ...ok, deadline: BigInt(NOW + 2 * 3600) }, request, NOW), /more than an hour/);
});

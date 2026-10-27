// The add-liquidity builders, ported with the app's tests where they apply: the v4 encoders, the price-band sizing, the v3
// band minimums, the Chainlink price check and the token checks; then every refusal of the deposit decode check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeAbiParameters, encodeAbiParameters, encodeFunctionData, type Address, type Hex } from 'viem';
import { erc20Abi, npmAbi, permit2Abi } from './abis';
import { NPM, PERMIT2, POSM, USDG, WETH } from './constants';
import { assertLpTx, type LpPlanned } from './lpGuard';
import {
  Actions, V4_PARAMS, decodeUnlockData, encodeV4Increase, encodeV4Mint, modifyLiquiditiesData, REFUND_ETH, unlockData, v3IncreaseData, v3MintData,
  v3WithEthData, type PoolKey,
} from './lp/encode';
import { amountsForLiquidityUp } from './lp/liquidity';
import { chainlinkSqrtPriceX96, feedFresh, priceCheck, priceDeviationPct } from './lp/reference';
import { adaptiveBandBps, bandedLiquidity, lFrom, MAX_U128, MIN_PRICE_BAND_BPS, otherSideAmount, sizeDeposit, twoTokenBand, V4_PRICE_BAND_BPS, BandRefusal } from './lp/sizing';
import { getSqrtRatioAtTick } from './lp/tickMath';
import { copiedStockToken, depositTokenRefusal } from './lp/tokens';

const ACCT = '0x1234567890123456789012345678901234567890' as Address;
const EVE = '0x9999999999999999999999999999999999999999' as Address;
const ETH = '0x0000000000000000000000000000000000000000' as Address;
const SPY = '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C' as Address;
const Q96 = 1n << 96n;
const NOW = 1_790_600_000;
const DL = BigInt(NOW + 1200);

test('v4 encoders: mint = MINT_POSITION + SETTLE_PAIR (+ SWEEP(ETH, owner) with native ETH); increase = INCREASE + CLOSE_CURRENCY x2 (+ SWEEP)', () => {
  const key: PoolKey = { currency0: ETH, currency1: USDG, fee: 500, tickSpacing: 10, hooks: ETH };
  const nat = decodeUnlockData(encodeV4Increase(7n, 100n, 11n, 22n, ETH, USDG, ACCT));
  assert.deepEqual(nat.actions, [Actions.INCREASE_LIQUIDITY, Actions.CLOSE_CURRENCY, Actions.CLOSE_CURRENCY, Actions.SWEEP]);
  assert.deepEqual(decodeAbiParameters(V4_PARAMS.sweep, nat.params[3]), [ETH, ACCT]);
  const erc = decodeUnlockData(encodeV4Increase(7n, 100n, 11n, 22n, SPY, USDG, ACCT));
  assert.deepEqual(erc.actions, [Actions.INCREASE_LIQUIDITY, Actions.CLOSE_CURRENCY, Actions.CLOSE_CURRENCY]);
  assert.ok(!(nat.actions as number[]).includes(Actions.SETTLE_PAIR) && !(erc.actions as number[]).includes(Actions.SETTLE_PAIR), 'an increase never uses SETTLE_PAIR');
  const m = decodeUnlockData(encodeV4Mint(key, -10, 10, 7n, 3n, 4n, ACCT));
  assert.deepEqual(m.actions, [Actions.MINT_POSITION, Actions.SETTLE_PAIR, Actions.SWEEP]);
  const mp = decodeAbiParameters(V4_PARAMS.mint, m.params[0]);
  assert.deepEqual([mp[1], mp[2], mp[3], mp[4], mp[5], mp[6], mp[7]], [-10, 10, 7n, 3n, 4n, ACCT, '0x']);
  assert.deepEqual(decodeUnlockData(encodeV4Mint({ ...key, currency0: SPY }, -10, 10, 7n, 3n, 4n, ACCT)).actions, [Actions.MINT_POSITION, Actions.SETTLE_PAIR]);
  for (const bad of [ETH, '0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002'] as Address[]) {
    assert.throws(() => encodeV4Increase(7n, 1n, 1n, 1n, ETH, USDG, bad), /wallet address/);
    assert.throws(() => encodeV4Mint(key, -10, 10, 1n, 1n, 1n, bad), /wallet address/);
  }
  assert.throws(() => unlockData([1, 2], ['0x']), /length/);
});

test('the v4 price band: the maxima never exceed the amounts given, and every price inside the band needs at most the maxima', () => {
  assert.equal(V4_PRICE_BAND_BPS, 30n);
  const r = { tickLower: -600, tickUpper: 600 };
  for (const tick of [-599, -300, 0, 17, 299, 599]) {
    const sqrtP = getSqrtRatioAtTick(tick);
    const a0 = 10n ** 18n, a1 = 10n ** 18n;
    const b = bandedLiquidity(sqrtP, r, a0, a1);
    assert.ok(b.liquidity > 0n, `L > 0 at ${tick}`);
    assert.ok(b.amount0Max <= a0 && b.amount1Max <= a1, `maxima within the amounts at ${tick}`);
    for (const f of [-29n, 0n, 29n]) {
      const s = (sqrtP * (20_000n + f)) / 20_000n;
      const need = amountsForLiquidityUp(s, getSqrtRatioAtTick(r.tickLower), getSqrtRatioAtTick(r.tickUpper), b.liquidity);
      assert.ok(need.amount0 <= b.amount0Max + 1n && need.amount1 <= b.amount1Max + 1n, `inside the band (${f}) at ${tick}`);
    }
  }
  // below the range only token0, above it only token1
  const below = bandedLiquidity(getSqrtRatioAtTick(-900), r, 10n ** 18n, 0n);
  assert.ok(below.liquidity > 0n && below.amount1Max === 0n);
  const above = bandedLiquidity(getSqrtRatioAtTick(900), r, 0n, 10n ** 18n);
  assert.ok(above.liquidity > 0n && above.amount0Max === 0n);
  const [L0, L1] = lFrom(getSqrtRatioAtTick(900), r, 5n, 5n);
  assert.equal(L0, MAX_U128); assert.ok(L1 > 0n);
});

test('the adaptive band: 30 bps on a wide range, a tenth of the width on a narrow one, never under 3 bps', () => {
  assert.equal(adaptiveBandBps({ tickLower: -600, tickUpper: 600 }), V4_PRICE_BAND_BPS);
  assert.equal(adaptiveBandBps({ tickLower: -500, tickUpper: 500 }), V4_PRICE_BAND_BPS);
  assert.equal(adaptiveBandBps({ tickLower: -100, tickUpper: 100 }), 20n);
  assert.equal(adaptiveBandBps({ tickLower: -16, tickUpper: 16 }), MIN_PRICE_BAND_BPS);
  assert.equal(adaptiveBandBps({ tickLower: 0, tickUpper: 1 }), MIN_PRICE_BAND_BPS);
});

test('deposit sizing from the chain price: the other side from the price; v3 desired within the amounts and band minimums under the flat rule', () => {
  const r = { tickLower: -600, tickUpper: 600 };
  const other = otherSideAmount(Q96, r, 0, 10n ** 18n);
  assert.ok(other > 0n, 'the other side at the pool price');
  assert.equal(otherSideAmount(getSqrtRatioAtTick(900), r, 1, 3_000_000n), 0n, 'above the range: token1 alone');
  const z = sizeDeposit(Q96, r, 10n ** 18n, 10n ** 18n, 100n);
  assert.ok(z.v4.amount0Max <= 10n ** 18n && z.v4.amount1Max <= 10n ** 18n && z.v4.liquidity > 0n);
  const band = twoTokenBand({ sqrtP: Q96, tickLower: -600, tickUpper: 600, desired: [z.v3.amount0Desired, z.v3.amount1Desired], bps: 100n });
  assert.ok(z.v3.amount0Desired <= 10n ** 18n && z.v3.amount0Min === band.mins[0] && z.v3.amount1Min === band.mins[1] && z.v3.band);
  assert.ok(z.v3.amount0Min < (z.v3.amount0Desired * 9_900n) / 10_000n, 'the band minimum allows the whole price move');
  assert.ok(z.v3.amount0Min > 0n && z.v3.amount1Min > 0n);
  // a one-token add next to the range edge: the band refuses it; the deposit keeps the flat rule
  assert.throws(() => twoTokenBand({ sqrtP: getSqrtRatioAtTick(599), tickLower: -600, tickUpper: 600, desired: [1n, 0n], bps: 100n }), BandRefusal);
  assert.throws(() => sizeDeposit(Q96, r, 1n, 1n, 10_000n), /bad slippage/);
});

test('the Chainlink price check: more than 5% refuses, more than 1% asks for an acknowledgement, none without a feed', () => {
  const ref = getSqrtRatioAtTick(0);
  assert.equal(priceCheck(getSqrtRatioAtTick(0), ref).kind, 'ok');
  assert.equal(priceCheck(getSqrtRatioAtTick(200), ref).kind, 'ack', 'about 2%');
  assert.match(priceCheck(getSqrtRatioAtTick(200), ref).text!, /^the pool price is 2\.02% from Chainlink$/);
  const r = priceCheck(getSqrtRatioAtTick(-600), ref);
  assert.equal(r.kind, 'refuse');
  assert.match(r.text!, /above Goat LP's 5% limit for deposits/);
  assert.equal(priceCheck(ref, null).kind, 'none');
  assert.ok(Math.abs(priceDeviationPct(getSqrtRatioAtTick(100), ref) - 1.0050) < 0.001);
  // the real feeds of Robinhood Chain (ETH/USD, USDG/USD, 8 decimals) give the WETH/USDG pool's price
  const s = chainlinkSqrtPriceX96(231384587346n, 8, 99989392n, 8, 18, 6)!;
  const px = (Number(s) / 2 ** 96) ** 2 * 1e12;
  assert.ok(Math.abs(px - 2314.09) < 0.01, `${px}`);
  // a round older than 25 hours, unfinished or from the future is not fresh
  assert.equal(feedFresh([5n, 1n, 0n, BigInt(NOW - 60), 5n], NOW), true);
  assert.equal(feedFresh([5n, 1n, 0n, BigInt(NOW - 26 * 3600), 5n], NOW), false);
  assert.equal(feedFresh([5n, 1n, 0n, BigInt(NOW - 60), 4n], NOW), false);
  assert.equal(feedFresh([5n, 1n, 0n, BigInt(NOW + 60), 5n], NOW), false);
  assert.equal(feedFresh([5n, 0n, 0n, BigInt(NOW - 60), 5n], NOW), false);
});

test('token checks: a copied stock ticker (by address, whatever the case or padding), a token that takes a fee when it moves', () => {
  assert.equal(copiedStockToken('0x322f0929c4625ed5bad873c95208d54e1c003b2d', 'TSLA'), null, 'the official TSLA');
  assert.deepEqual(copiedStockToken('0x00000000000000000000000000000000000c0b1a', ' tsla​'), { address: '0x322f0929c4625ed5bad873c95208d54e1c003b2d', symbol: 'TSLA' });
  assert.equal(copiedStockToken('0x00000000000000000000000000000000000c0b1a', 'GOATX'), null);
  const tok = (address: string, symbol: string, tickerCollision: boolean | null = null) => ({ address, symbol, tickerCollision });
  assert.match(depositTokenRefusal('v3', [tok('0x00000000000000000000000000000000000c0b1a', 'TSLA'), tok(USDG, 'USDG')])!, /TSLA copies the ticker of an official stock token/);
  assert.match(depositTokenRefusal('v4', [tok(ETH, 'ETH'), tok('0x00000000000000000000000000000000000c0b1a', 'COPY', true)])!, /COPY copies the ticker/);
  assert.match(depositTokenRefusal('v3', [tok('0x337f3f7384a2e2cfb9757971d469773f23e509f0', 'TAXX'), tok(USDG, 'USDG')])!, /TAXX takes a fee or fails when it moves/);
  assert.match(depositTokenRefusal('v4', [tok('0x4db7374e966097be94c6680d49156d580f097bbf', 'FEE'), tok(USDG, 'USDG')])!, /takes a fee/);
  assert.equal(depositTokenRefusal('v3', [tok('0x4db7374e966097be94c6680d49156d580f097bbf', 'FEE'), tok(USDG, 'USDG')]), null, 'measured without a cut at its v3 pool');
  assert.equal(depositTokenRefusal('v4', [tok(ETH, 'ETH'), tok(USDG, 'USDG')]), null);
});

// ------------------------------------------------------------------ the decode check

const KEY: PoolKey = { currency0: ETH, currency1: USDG, fee: 500, tickSpacing: 10, hooks: ETH };
const KEY_ERC: PoolKey = { currency0: SPY, currency1: USDG, fee: 3000, tickSpacing: 60, hooks: ETH };
const v4x = (over: Partial<LpPlanned> = {}): LpPlanned => ({
  venue: 'v4', kind: 'mint', account: ACCT, chainId: 4663, nowSec: NOW, currencies: [KEY.currency0, KEY.currency1], key: KEY,
  range: { tickLower: -10, tickUpper: 10 }, approvals: [{ token: USDG, spender: PERMIT2, amount: 4n }], permit2: [{ token: USDG, amount: 4n, expiration: NOW + 1800 }],
  ethSide: null, value: 3n, ...over,
});
const v3x = (over: Partial<LpPlanned> = {}): LpPlanned => ({
  venue: 'v3', kind: 'mint', account: ACCT, chainId: 4663, nowSec: NOW, currencies: [WETH, USDG], fee: 500, range: { tickLower: -10, tickUpper: 10 },
  approvals: [{ token: WETH, spender: NPM, amount: 10n }, { token: USDG, spender: NPM, amount: 20n }], permit2: [], ethSide: null, value: 0n, ...over,
});
const posmTx = (unlock: Hex, value: bigint, deadline = DL) => ({ to: POSM, data: modifyLiquiditiesData(unlock, deadline), value, chainId: 4663 });
const fails = (v: ReturnType<typeof assertLpTx>, rule: string, re?: RegExp) => {
  assert.equal(v.ok, false, `expected ${rule}`);
  if (!v.ok) { assert.equal(v.rule, rule, v.reason); if (re) assert.match(v.reason, re); }
};

test('decode check, v4: the built mint and increase pass; a mint without SWEEP(ETH), a SWEEP of another token, a far deadline, other values refuse', () => {
  const good = posmTx(encodeV4Mint(KEY, -10, 10, 7n, 3n, 4n, ACCT), 3n);
  assert.deepEqual(assertLpTx(good, v4x()), { ok: true });
  // a native mint without the sweep leaves ETH in the position manager for anyone
  const noSweep = posmTx(unlockData([Actions.MINT_POSITION, Actions.SETTLE_PAIR], [
    encodeAbiParameters(V4_PARAMS.mint, [KEY, -10, 10, 7n, 3n, 4n, ACCT, '0x']), encodeAbiParameters(V4_PARAMS.settlePair, [ETH, USDG])]), 3n);
  fails(assertLpTx(noSweep, v4x()), 'actions');
  const usdgSweep = posmTx(unlockData([Actions.MINT_POSITION, Actions.SETTLE_PAIR, Actions.SWEEP], [
    encodeAbiParameters(V4_PARAMS.mint, [KEY, -10, 10, 7n, 3n, 4n, ACCT, '0x']), encodeAbiParameters(V4_PARAMS.settlePair, [ETH, USDG]),
    encodeAbiParameters(V4_PARAMS.sweep, [USDG, ACCT])]), 3n);
  fails(assertLpTx(usdgSweep, v4x()), 'actions', /must be ETH/);
  const sweepEve = posmTx(unlockData([Actions.MINT_POSITION, Actions.SETTLE_PAIR, Actions.SWEEP], [
    encodeAbiParameters(V4_PARAMS.mint, [KEY, -10, 10, 7n, 3n, 4n, ACCT, '0x']), encodeAbiParameters(V4_PARAMS.settlePair, [ETH, USDG]),
    encodeAbiParameters(V4_PARAMS.sweep, [ETH, EVE])]), 3n);
  fails(assertLpTx(sweepEve, v4x()), 'recipient');
  fails(assertLpTx(posmTx(encodeV4Mint(KEY, -10, 10, 7n, 3n, 4n, ACCT), 3n, BigInt(NOW + 365 * 86_400)), v4x()), 'deadline');
  fails(assertLpTx(posmTx(encodeV4Mint(KEY, -10, 10, 7n, 3n, 4n, ACCT), 2n), v4x()), 'value');
  fails(assertLpTx(posmTx(encodeV4Mint(KEY, -10, 10, 7n, 3n, 4n, EVE), 3n), v4x()), 'recipient');
  fails(assertLpTx(posmTx(encodeV4Mint(KEY, -20, 10, 7n, 3n, 4n, ACCT), 3n), v4x()), 'range');
  fails(assertLpTx(posmTx(encodeV4Mint({ ...KEY, fee: 3000 }, -10, 10, 7n, 3n, 4n, ACCT), 3n), v4x()), 'pool');
  fails(assertLpTx(posmTx(encodeV4Mint({ ...KEY, hooks: EVE }, -10, 10, 7n, 3n, 4n, ACCT), 3n), v4x()), 'pool');
  const hookData = posmTx(unlockData([Actions.MINT_POSITION, Actions.SETTLE_PAIR, Actions.SWEEP], [
    encodeAbiParameters(V4_PARAMS.mint, [KEY, -10, 10, 7n, 3n, 4n, ACCT, '0x1234']), encodeAbiParameters(V4_PARAMS.settlePair, [ETH, USDG]),
    encodeAbiParameters(V4_PARAMS.sweep, [ETH, ACCT])]), 3n);
  fails(assertLpTx(hookData, v4x()), 'hook-data');
  // a token pool: no ETH, no sweep
  const erc = v4x({ currencies: [SPY, USDG], key: KEY_ERC, value: 0n });
  assert.deepEqual(assertLpTx(posmTx(encodeV4Mint(KEY_ERC, -60, 60, 7n, 3n, 4n, ACCT), 0n), { ...erc, range: { tickLower: -60, tickUpper: 60 } }), { ok: true });
  fails(assertLpTx(posmTx(encodeV4Mint(KEY_ERC, -60, 60, 7n, 3n, 4n, ACCT), 1n), { ...erc, range: { tickLower: -60, tickUpper: 60 } }), 'value');
  // increase
  const inc = v4x({ kind: 'increase', tokenId: 77n, range: undefined });
  assert.deepEqual(assertLpTx(posmTx(encodeV4Increase(77n, 9n, 3n, 4n, ETH, USDG, ACCT), 3n), inc), { ok: true });
  fails(assertLpTx(posmTx(encodeV4Increase(78n, 9n, 3n, 4n, ETH, USDG, ACCT), 3n), inc), 'position');
  fails(assertLpTx(posmTx(encodeV4Increase(77n, 9n, 3n, 4n, ETH, USDG, EVE), 3n), inc), 'recipient');
  fails(assertLpTx(posmTx(encodeV4Mint(KEY, -10, 10, 7n, 3n, 4n, ACCT), 3n), inc), 'actions', /unexpected actions/);
  // a swap or a take is never part of a deposit
  const take = posmTx(unlockData([Actions.INCREASE_LIQUIDITY, Actions.TAKE_PAIR], [
    encodeAbiParameters(V4_PARAMS.increase, [77n, 9n, 3n, 4n, '0x']), encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }], [ETH, USDG, EVE])]), 3n);
  fails(assertLpTx(take, inc), 'actions');
  fails(assertLpTx({ ...posmTx(encodeV4Mint(KEY, -10, 10, 7n, 3n, 4n, ACCT), 3n), chainId: 1 }, v4x()), 'chain');
});

test('decode check, v3: mint and increase pass; another pool, range, recipient, a zero minimum, a minimum above the amount, ETH, a far deadline refuse', () => {
  const base = { token0: WETH, token1: USDG, fee: 500, tickLower: -10, tickUpper: 10, amount0Desired: 10n, amount1Desired: 20n, amount0Min: 9n, amount1Min: 19n, recipient: ACCT, deadline: DL };
  const tx = (data: Hex, value = 0n) => ({ to: NPM, data, value, chainId: 4663 });
  assert.deepEqual(assertLpTx(tx(v3MintData(base)), v3x()), { ok: true });
  fails(assertLpTx(tx(v3MintData({ ...base, fee: 3000 })), v3x()), 'pool');
  fails(assertLpTx(tx(v3MintData({ ...base, tickUpper: 20 })), v3x()), 'range');
  fails(assertLpTx(tx(v3MintData({ ...base, deadline: BigInt(NOW + 7200) })), v3x()), 'deadline');
  fails(assertLpTx(tx(v3MintData({ ...base, deadline: BigInt(NOW - 1) })), v3x()), 'deadline');
  fails(assertLpTx(tx(v3MintData({ ...base, amount0Min: 0n })), v3x()), 'minimums', /above zero/);
  fails(assertLpTx(tx(v3MintData({ ...base, amount1Min: 21n })), v3x()), 'minimums', /above the amount/);
  fails(assertLpTx(tx(v3MintData(base), 1n), v3x()), 'value');
  fails(assertLpTx(tx(v3MintData({ ...base, recipient: EVE })), v3x()), 'recipient');
  const inc = v3x({ kind: 'increase', tokenId: 5n, range: undefined });
  const ip = { tokenId: 5n, amount0Desired: 10n, amount1Desired: 20n, amount0Min: 9n, amount1Min: 19n, deadline: DL };
  assert.deepEqual(assertLpTx(tx(v3IncreaseData(ip)), inc), { ok: true });
  fails(assertLpTx(tx(v3IncreaseData({ ...ip, tokenId: 6n })), inc), 'position');
  fails(assertLpTx(tx(v3MintData(base)), inc), 'function');
  // collect, decrease, burn: never part of a deposit
  const collect = encodeFunctionData({ abi: [{ type: 'function', name: 'collect', stateMutability: 'payable', inputs: [{ name: 'p', type: 'tuple', components: [{ name: 'tokenId', type: 'uint256' }, { name: 'recipient', type: 'address' }, { name: 'amount0Max', type: 'uint128' }, { name: 'amount1Max', type: 'uint128' }] }], outputs: [] }], functionName: 'collect', args: [{ tokenId: 5n, recipient: EVE, amount0Max: 1n, amount1Max: 1n }] });
  fails(assertLpTx(tx(collect), inc), 'function');
});

test('decode check, v3 paid with ETH: [deposit, refundETH] with the WETH amount as value; every other shape refuses', () => {
  const base = { token0: WETH, token1: USDG, fee: 500, tickLower: -10, tickUpper: 10, amount0Desired: 10n, amount1Desired: 20n, amount0Min: 9n, amount1Min: 19n, recipient: ACCT, deadline: DL };
  const x = v3x({ ethSide: 0, value: 10n, approvals: [{ token: USDG, spender: NPM, amount: 20n }] });
  const tx = (data: Hex, value: bigint) => ({ to: NPM, data, value, chainId: 4663 });
  assert.deepEqual(assertLpTx(tx(v3WithEthData(v3MintData(base)), 10n), x), { ok: true });
  fails(assertLpTx(tx(v3WithEthData(v3MintData(base)), 9n), x), 'value');
  fails(assertLpTx(tx(v3WithEthData(v3MintData(base)), 11n), x), 'value');
  fails(assertLpTx(tx(v3MintData(base), 10n), x), 'eth');
  const noRefund = encodeFunctionData({ abi: npmAbi, functionName: 'multicall', args: [[v3MintData(base)]] });
  fails(assertLpTx(tx(noRefund, 10n), x), 'eth', /refundETH/);
  const refundFirst = encodeFunctionData({ abi: npmAbi, functionName: 'multicall', args: [[REFUND_ETH, v3MintData(base)]] });
  fails(assertLpTx(tx(refundFirst, 10n), x), 'eth');
  fails(assertLpTx(tx(v3WithEthData(v3MintData(base)), 20n), { ...x, ethSide: 1, value: 20n }), 'eth', /only the WETH side/);
});

test('decode check, approvals: exact amounts to the planned spender only; never unlimited, never a permission for all, never a transfer', () => {
  const approve = (spender: Address, amount: bigint) => encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] });
  const tx = (to: Address, data: Hex, value = 0n) => ({ to, data, value, chainId: 4663 });
  assert.deepEqual(assertLpTx(tx(WETH, approve(NPM, 10n)), v3x()), { ok: true });
  fails(assertLpTx(tx(WETH, approve(NPM, 11n)), v3x()), 'approval', /exact amount/);
  fails(assertLpTx(tx(WETH, approve(NPM, (1n << 256n) - 1n)), v3x()), 'approval', /unlimited/);
  fails(assertLpTx(tx(WETH, approve(EVE, 10n)), v3x()), 'approval');
  fails(assertLpTx(tx(WETH, approve(PERMIT2, 10n)), v3x()), 'approval', /Uniswap v3 position manager/);
  fails(assertLpTx(tx(WETH, approve(NPM, 10n), 1n), v3x()), 'no-value');
  fails(assertLpTx(tx(SPY, approve(NPM, 10n)), v3x()), 'target', /not a contract this deposit uses/);
  const transfer = encodeFunctionData({ abi: [{ type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] }], functionName: 'transfer', args: [EVE, 1n] });
  fails(assertLpTx(tx(WETH, transfer), v3x()), 'function');
  const forAll = encodeFunctionData({ abi: [{ type: 'function', name: 'setApprovalForAll', stateMutability: 'nonpayable', inputs: [{ name: 'operator', type: 'address' }, { name: 'approved', type: 'bool' }], outputs: [] }], functionName: 'setApprovalForAll', args: [EVE, true] });
  fails(assertLpTx(tx(NPM, forAll), v3x()), 'function', /permission for all positions/);
  fails(assertLpTx(tx(POSM, forAll), v4x()), 'function');
  // Permit2: the planned token, amount and expiry; the v4 position manager only; at most 30 minutes
  const p2 = (token: Address, spender: Address, amount: bigint, expiration: number) => encodeFunctionData({ abi: permit2Abi, functionName: 'approve', args: [token, spender, amount, expiration] });
  assert.deepEqual(assertLpTx(tx(USDG, approve(PERMIT2, 4n)), v4x()), { ok: true });
  assert.deepEqual(assertLpTx(tx(PERMIT2, p2(USDG, POSM, 4n, NOW + 1800)), v4x()), { ok: true });
  fails(assertLpTx(tx(PERMIT2, p2(USDG, EVE, 4n, NOW + 1800)), v4x()), 'permit2', /v4 position manager/);
  fails(assertLpTx(tx(PERMIT2, p2(USDG, POSM, 5n, NOW + 1800)), v4x()), 'permit2', /exact amount/);
  fails(assertLpTx(tx(PERMIT2, p2(USDG, POSM, (1n << 160n) - 1n, NOW + 1800)), v4x()), 'permit2', /unlimited/);
  fails(assertLpTx(tx(PERMIT2, p2(USDG, POSM, 4n, NOW + 30 * 86_400)), v4x()), 'permit2', /30 minutes/);
  fails(assertLpTx(tx(PERMIT2, p2(SPY, POSM, 4n, NOW + 1800)), v4x()), 'permit2', /outside this pool/);
  fails(assertLpTx(tx(PERMIT2, p2(WETH, NPM, 4n, NOW + 1800)), v3x()), 'target', /v4 deposits only/);
});

// goatlp_add_liquidity through the MCP server, on the fake chain (approvals and deposits play onto it) with a recording
// signer and fake API answers: v3 and v4, new positions and additions, ETH payments, the exact approvals, the pool, token,
// price, balance and limit checks, and the execute's own checks. No network, no real key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { decodeAbiParameters, decodeFunctionData, toFunctionSelector, type Abi, type Address, type Hex } from 'viem';
import { createCashmereMcpServer, type CashmereMcpServerOptions } from '../mcp/server';
import { erc20Abi, npmAbi, permit2Abi, posmAbi } from './abis';
import { GoatApi } from './api';
import { NPM, PERMIT2, POSM } from './constants';
import { Actions, REFUND_ETH, V4_PARAMS, decodeUnlockData } from './lp/encode';
import { rangeAroundPrice } from './lp/liquidity';
import { getSqrtRatioAtTick } from './lp/tickMath';
import {
  AMZN, AMZN_USDG_V3, ETH_USDG_V4, KEY_V4_FREE, NOW_SEC, OTHER, TEST_KEY, USDG_T, V3_POS, V4_FREE_POS, V4_POS, WETH_T, WETH_USDG_TICK, WETH_USDG_V3,
  apiWorld, fixture, lpWorld, type FakeAnswer,
} from './__fixtures__/kit';

const ZERO = '0x0000000000000000000000000000000000000000' as Address;
const priceOf = (tick: number, d0: number, d1: number) => Math.pow(1.0001, tick) * 10 ** (d0 - d1);
const ETH_USD = priceOf(WETH_USDG_TICK, 18, 6);
const AMZN_USD = priceOf(-221190, 18, 6);

type Route = FakeAnswer | ((init: { method: string; headers: Record<string, string>; body?: string }) => FakeAnswer);
function prices(over: Record<string, unknown> = {}) {
  const row = (symbol: string, usd: number | null) => ({ symbol, price: usd, prices: usd === null ? {} : { usd }, ticker_collision: false });
  return { [ZERO]: row('ETH', ETH_USD), [WETH_T]: row('WETH', ETH_USD), [USDG_T]: row('USDG', 1), [AMZN]: row('AMZN', AMZN_USD), ...over };
}

function setup(o: { ethPrice?: number; api?: Record<string, Route>; limits?: { maxDepositUsd?: number; maxTotalUsd?: number } } = {}) {
  const w = lpWorld({ ethPrice: o.ethPrice });
  const freePool = {
    address: w.freeId, exchange: 'uniswapv4', fee_tier: 500, tick_spacing: 10, hooks: null, token0: ZERO, token1: USDG_T,
    tokens: { [ZERO]: { address: ZERO, symbol: 'ETH', decimals: 18 }, [USDG_T]: { address: USDG_T, symbol: 'USDG', decimals: 6 } },
  };
  const api = apiWorld({
    '/v2/tokens/prices': { body: prices() },
    [`/v2/pools/robinhood/uniswapv4/${w.freeId}`]: { body: freePool },
    ...o.api,
  });
  let clock = NOW_SEC * 1000;
  const goatApi = new GoatApi({ fetch: api.fetch, now: () => clock, sleep: async () => {} });
  const options: CashmereMcpServerOptions = {
    config: { evm: { privateKey: TEST_KEY } },
    goatlp: { ...o.limits, deps: { api: goatApi, chain: w.chain, signer: w.signer, now: () => clock } },
  };
  return { ...w, api, options, tick: (ms: number) => { clock += ms; w.chain.time += Math.floor(ms / 1000); } };
}

async function connect(options: CashmereMcpServerOptions): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createCashmereMcpServer(options).connect(serverTransport);
  const client = new Client({ name: 'goatlp-deposit-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

async function call(c: Client, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await c.callTool({ name: 'goatlp_add_liquidity', arguments: args });
  const [content] = r.content as { type: string; text: string }[];
  if (r.isError) return { error: content.text };
  return JSON.parse(content.text) as Record<string, unknown>;
}

/** plan, then execute with its planId */
async function planAndRun(c: Client, args: Record<string, unknown>) {
  const plan = await call(c, args);
  assert.equal(plan.error, undefined, String(plan.error));
  const done = await call(c, { ...args, execute: true, planId: plan.planId });
  return { plan, done };
}

const fn = (abi: readonly unknown[], data: Hex) => decodeFunctionData({ abi: abi as Abi, data }) as { functionName: string; args: readonly unknown[] };
const steps = (p: Record<string, unknown>) => p.steps as Record<string, unknown>[];
const NEVER = ['setApprovalForAll(address,bool)', 'transfer(address,uint256)', 'transferFrom(address,address,uint256)', 'safeTransferFrom(address,address,uint256)']
  .map((s) => toFunctionSelector(`function ${s}`));

test('v3 add to a position: exact approvals to the position manager, then increaseLiquidity sized at the pool price; execute sends exactly that', async () => {
  const s = setup();
  const c = await connect(s.options);
  const args = { venue: 'v3', id: String(V3_POS), amount0: '1', amount1: '300' };
  const { plan, done } = await planAndRun(c, args);
  assert.deepEqual(steps(plan).map((x) => x.action), ['Allow AMZN', 'Allow USDG', 'Add liquidity']);
  assert.match(String(steps(plan)[0].simulation), /^ok/);
  assert.match(String(steps(plan)[2].simulation), /^runs after step 1; simulated again right before it is sent$/);
  assert.equal(plan.warning, 'Goat LP is experimental. Use small amounts.');
  assert.equal(done.error, undefined, String(done.error));
  const [a0, a1, dep] = s.signer.sent;
  assert.deepEqual([a0.to, a1.to, dep.to], [AMZN, USDG_T, NPM]);
  const p = fn(npmAbi, dep.data).args[0] as { tokenId: bigint; amount0Desired: bigint; amount1Desired: bigint; amount0Min: bigint; amount1Min: bigint; deadline: bigint };
  assert.equal(fn(npmAbi, dep.data).functionName, 'increaseLiquidity');
  assert.equal(p.tokenId, V3_POS);
  assert.deepEqual(fn(erc20Abi, a0.data).args, [NPM, p.amount0Desired], 'exactly the AMZN the deposit may take');
  assert.deepEqual(fn(erc20Abi, a1.data).args, [NPM, p.amount1Desired], 'exactly the USDG the deposit may take');
  assert.ok(p.amount0Desired <= 10n ** 18n && p.amount1Desired <= 300n * 10n ** 6n, 'never more than given');
  assert.ok(p.amount0Min > 0n && p.amount0Min < p.amount0Desired && p.amount1Min > 0n && p.amount1Min < p.amount1Desired);
  assert.equal(p.deadline, BigInt(NOW_SEC + 1200));
  assert.ok(s.signer.sent.every((t) => t.value === 0n));
  assert.equal(((done.now as Record<string, Record<string, unknown>>).position).liquidity, (14732486021543492n + 1000n).toString());
  assert.ok((done.steps as Record<string, unknown>[]).every((x) => x.status === 'confirmed' && x.readBack === undefined));
  const amounts = plan.amounts as Record<string, string[]>;
  assert.match(amounts.usesAtMost[1], / USDG$/);
  assert.match(String(plan.priceLimit), /the minimums allow a 1\.00% price move/);
  assert.match(String(plan.priceCheck), /^Pool price vs Chainlink: [+-]0\.0\d%$/);
  await c.close();
});

test('v3 new position paying the WETH side with ETH: multicall([mint, refundETH]) with the WETH amount as value; no WETH approval', async () => {
  const s = setup();
  const c = await connect(s.options);
  const args = { venue: 'v3', pool: WETH_USDG_V3, rangePct: 5, amount0: '0.1', payWithEth: true };
  const { plan, done } = await planAndRun(c, args);
  assert.deepEqual(steps(plan).map((x) => x.action), ['Allow USDG', 'Open the position']);
  assert.equal(done.error, undefined, String(done.error));
  const [approve, dep] = s.signer.sent;
  assert.equal(approve.to, USDG_T);
  const top = fn(npmAbi, dep.data);
  assert.equal(top.functionName, 'multicall');
  const [mintData, refund] = top.args[0] as Hex[];
  assert.equal(refund, REFUND_ETH);
  const m = fn(npmAbi, mintData).args[0] as Record<string, unknown>;
  const r = rangeAroundPrice(WETH_USDG_TICK, 10, 5, 5);
  assert.deepEqual([m.tickLower, m.tickUpper, m.fee, String(m.recipient).toLowerCase()], [r.tickLower, r.tickUpper, 500, s.signer.address.toLowerCase()]);
  assert.equal(dep.value, m.amount0Desired, 'value = the WETH side');
  assert.ok((m.amount0Desired as bigint) <= 10n ** 17n);
  assert.deepEqual(fn(erc20Abi, approve.data).args, [NPM, m.amount1Desired]);
  assert.deepEqual(done.now, { newPosition: { venue: 'v3', id: '6000000' } });
  assert.match(String(steps(plan)[1].ethSent), /ETH \(unused ETH comes back in the same transaction\)$/);
  await c.close();
});

test('v4 new position in a hook-free ETH pool: USDG to Permit2, Permit2 to the position manager for 30 minutes, MINT + SETTLE_PAIR + SWEEP', async () => {
  const s = setup();
  const c = await connect(s.options);
  const args = { venue: 'v4', pool: s.freeId, tickLower: -199200, tickUpper: -198600, amount0: '0.5' };
  const { plan, done } = await planAndRun(c, args);
  assert.deepEqual(steps(plan).map((x) => x.action), ['Allow USDG', 'Allow USDG through Permit2', 'Open the position']);
  assert.equal(done.error, undefined, String(done.error));
  const [erc, p2, dep] = s.signer.sent;
  assert.deepEqual([erc.to, p2.to, dep.to], [USDG_T, PERMIT2, POSM]);
  const top = fn(posmAbi, dep.data);
  const { actions, params } = decodeUnlockData(top.args[0] as Hex);
  assert.deepEqual(actions, [Actions.MINT_POSITION, Actions.SETTLE_PAIR, Actions.SWEEP]);
  const mint = decodeAbiParameters(V4_PARAMS.mint, params[0]);
  const k = mint[0] as typeof KEY_V4_FREE;
  assert.deepEqual({ ...k, currency1: k.currency1.toLowerCase() }, KEY_V4_FREE);
  assert.deepEqual([mint[1], mint[2], String(mint[6]).toLowerCase(), mint[7]], [-199200, -198600, s.signer.address.toLowerCase(), '0x']);
  assert.equal(dep.value, mint[4], 'the ETH maximum goes as value; the sweep returns what is not used');
  assert.ok((mint[4] as bigint) <= 5n * 10n ** 17n);
  assert.deepEqual(fn(erc20Abi, erc.data).args, [PERMIT2, mint[5]]);
  const [tok, spender, amt, exp] = fn(permit2Abi, p2.data).args as [Address, Address, bigint, number];
  assert.deepEqual([tok.toLowerCase(), spender, amt, exp], [USDG_T, POSM, mint[5], NOW_SEC + 1800], 'exactly the USDG maximum, for 30 minutes');
  assert.equal(top.args[1], BigInt(NOW_SEC + 1200));
  assert.deepEqual(decodeAbiParameters(V4_PARAMS.sweep, params[2]).map((x) => String(x).toLowerCase()), [ZERO, s.signer.address.toLowerCase()]);
  assert.deepEqual(done.now, { newPosition: { venue: 'v4', id: '6000000' } });
  assert.match(String(plan.priceLimit), /within 0\.30% of the plan's price/);
  assert.equal((plan.pool as Record<string, unknown>).hooks, 'none');
  await c.close();
});

test('v4 add to a hook-free position with the allowances in place: one transaction; a Permit2 allowance that ends before the deadline is renewed', async () => {
  const s = setup();
  const me = s.signer.address.toLowerCase();
  s.lp.allowance.set(`${USDG_T}:${me}:${PERMIT2.toLowerCase()}`, 10n ** 12n);
  s.lp.permit2.set(`${me}:${USDG_T}:${POSM.toLowerCase()}`, { amount: 10n ** 12n, expiration: NOW_SEC + 86_400 });
  const c = await connect(s.options);
  const args = { venue: 'v4', id: String(V4_FREE_POS), amount0: '0.2' };
  const { plan, done } = await planAndRun(c, args);
  assert.deepEqual(steps(plan).map((x) => x.action), ['Add liquidity']);
  assert.match(String(steps(plan)[0].simulation), /^ok/);
  assert.equal(done.error, undefined, String(done.error));
  const { actions, params } = decodeUnlockData(fn(posmAbi, s.signer.sent[0].data).args[0] as Hex);
  assert.deepEqual(actions, [Actions.INCREASE_LIQUIDITY, Actions.CLOSE_CURRENCY, Actions.CLOSE_CURRENCY, Actions.SWEEP]);
  assert.equal(decodeAbiParameters(V4_PARAMS.increase, params[0])[0], V4_FREE_POS);
  assert.equal(((done.now as Record<string, Record<string, unknown>>).position).liquidity, (10n ** 15n + 1000n).toString());
  // an allowance that ends before the deposit's deadline
  s.lp.permit2.set(`${me}:${USDG_T}:${POSM.toLowerCase()}`, { amount: 10n ** 12n, expiration: NOW_SEC + 600 });
  const p2 = await call(c, args);
  assert.deepEqual(steps(p2).map((x) => x.action), ['Allow USDG through Permit2', 'Add liquidity']);
  await c.close();
});

test('v4 pools with a hook are refused with the reason (a position in the ETH/USDG fee-hook pool, and that pool for a new position)', async () => {
  const s = setup({ api: { [`/v2/pools/robinhood/uniswapv4/${ETH_USDG_V4}`]: { body: fixture('pool-v4.json') } } });
  const c = await connect(s.options);
  assert.match(String((await call(c, { venue: 'v4', id: String(V4_POS), amount0: '0.01' })).error), /^Not planned: Deposits into v4 pools with a hook are not offered by this tool yet/);
  assert.match(String((await call(c, { venue: 'v4', pool: ETH_USDG_V4, rangePct: 5, amount0: '0.01' })).error), /pools with a hook are not offered/);
  assert.equal(s.signer.sent.length, 0);
  await c.close();
});

test('token checks: a copied stock ticker or a token that takes a fee when it moves is refused; so is the API\'s ticker collision flag', async () => {
  const s = setup();
  const c = await connect(s.options);
  assert.match(String((await call(c, { venue: 'v3', pool: '0x00000000000000000000000000000000000c0b1b', rangePct: 5, amount1: '10' })).error), /New deposits blocked in this pool: TSLA copies the ticker of an official stock token\./);
  assert.match(String((await call(c, { venue: 'v3', pool: '0x00000000000000000000000000000000000c0b1c', rangePct: 5, amount1: '10' })).error), /TAXX takes a fee or fails when it moves in or out of this pool/);
  await c.close();
  const s2 = setup({ api: { '/v2/tokens/prices': { body: prices({ [AMZN]: { symbol: 'AMZN', price: AMZN_USD, ticker_collision: true } }) } } });
  const c2 = await connect(s2.options);
  assert.match(String((await call(c2, { venue: 'v3', id: String(V3_POS), amount0: '1' })).error), /AMZN copies the ticker/);
  await c2.close();
});

test('the Chainlink price check: more than 5% off refuses; between 1% and 5% the plan asks the user to acknowledge it', async () => {
  const s = setup({ ethPrice: ETH_USD * 1.07 });
  let c = await connect(s.options);
  assert.match(String((await call(c, { venue: 'v3', pool: WETH_USDG_V3, rangePct: 5, amount0: '0.1' })).error), /The pool price is 6\.5\d% from Chainlink, above Goat LP's 5% limit for deposits\./);
  await c.close();
  const s2 = setup({ ethPrice: ETH_USD * 1.02 });
  c = await connect(s2.options);
  const plan = await call(c, { venue: 'v3', pool: WETH_USDG_V3, rangePct: 5, amount0: '0.1' });
  assert.deepEqual(plan.acknowledge, ['I understand that the pool price is 1.96% from Chainlink.']);
  await c.close();
  // no feed for one token: the plan says the deposit uses the pool price
  const s3 = setup();
  s3.chain.on('0x61B7e5650328764B076A108EFF5fa7282a1B9aD2', 'latestRoundData', [100n, 100000000n, 0n, BigInt(NOW_SEC - 30 * 3600), 100n]);
  c = await connect(s3.options);
  assert.equal((await call(c, { venue: 'v3', pool: WETH_USDG_V3, rangePct: 5, amount0: '0.1' })).priceCheck, 'No Chainlink price for this pair; the deposit uses the pool price.');
  await c.close();
});

test('limits: CASHMERE_GOATLP_MAX_DEPOSIT_USD per call, CASHMERE_GOATLP_MAX_TOTAL_USD while the server runs; a missing USD price refuses only with a limit', async () => {
  const s = setup({ limits: { maxDepositUsd: 100 } });
  let c = await connect(s.options);
  assert.match(String((await call(c, { venue: 'v3', pool: WETH_USDG_V3, rangePct: 5, amount0: '0.1' })).error), /worth about 4\d\d\.\d\d USD, above the limit of 100 USD per deposit \(CASHMERE_GOATLP_MAX_DEPOSIT_USD\)/);
  const small = await call(c, { venue: 'v3', pool: WETH_USDG_V3, rangePct: 5, amount0: '0.01' });
  assert.equal(small.error, undefined, String(small.error));
  assert.deepEqual(small.limits, { perDepositUsd: 100 });
  await c.close();

  const t = setup({ limits: { maxTotalUsd: 700 } });
  c = await connect(t.options);
  const args = { venue: 'v3', id: String(V3_POS), amount0: '1', amount1: '300' };
  const first = await planAndRun(c, args);
  assert.equal(first.done.error, undefined, String(first.done.error));
  const second = await call(c, args);
  assert.match(String(second.error), /this server has deposited about \d+\.\d\d USD; \d+\.\d\d more would pass its total limit of 700 USD \(CASHMERE_GOATLP_MAX_TOTAL_USD\)/);
  await c.close();

  const u = setup({ limits: { maxDepositUsd: 1000 }, api: { '/v2/tokens/prices': { body: prices({ [USDG_T]: undefined }) } } });
  c = await connect(u.options);
  assert.match(String((await call(c, { venue: 'v3', id: String(V3_POS), amount0: '1' })).error), /the USD price of USDG is not available, so the deposit limits \(CASHMERE_GOATLP_MAX_DEPOSIT_USD\) cannot be checked/);
  await c.close();
  const v = setup({ api: { '/v2/tokens/prices': { status: 503, body: { error: 'down' } } } });
  c = await connect(v.options);
  const plan = await call(c, { venue: 'v3', id: String(V3_POS), amount0: '1' });
  assert.equal(plan.error, undefined, String(plan.error));
  assert.equal(plan.valueUsd, null);
  await c.close();
});

test('balances: a shortfall refuses before any approval; paying ETH keeps about 0.002 ETH for gas', async () => {
  const s = setup();
  const me = s.signer.address.toLowerCase();
  s.lp.bal.set(`${USDG_T}:${me}`, 1_000_000n);
  const c = await connect(s.options);
  assert.match(String((await call(c, { venue: 'v3', id: String(V3_POS), amount0: '1', amount1: '300' })).error), /not enough USDG: the deposit needs up to \d+\.\d+, the wallet has 1\.?$/);
  s.chain.balances.set(me, 10n ** 17n + 10n ** 15n);
  assert.match(String((await call(c, { venue: 'v4', pool: s.freeId, tickLower: -199200, tickUpper: -198600, amount0: '0.1' })).error), /keep about 0\.002 ETH for gas/);
  assert.equal(s.signer.sent.length, 0);
  await c.close();
});

test('inputs: id with pool, a range with id, no range, unaligned ticks, too many decimals, payWithEth where it does not apply, a pool not of the factory, a key that does not hash, not the owner', async () => {
  const s = setup({ api: { [`/v2/pools/robinhood/uniswapv4/0x${'ab'.repeat(32)}`]: { body: { address: `0x${'ab'.repeat(32)}`, fee_tier: 500, tick_spacing: 10, hooks: null, token0: ZERO, token1: USDG_T } } } });
  const c = await connect(s.options);
  const id = String(V3_POS);
  const err = async (args: Record<string, unknown>) => String((await call(c, args)).error);
  assert.match(await err({ venue: 'v3', id, pool: WETH_USDG_V3, amount0: '1' }), /give either id .* or pool/);
  assert.match(await err({ venue: 'v3', id, rangePct: 5, amount0: '1' }), /a position keeps its range/);
  assert.match(await err({ venue: 'v3', pool: WETH_USDG_V3, amount0: '1' }), /exactly one of them/);
  assert.match(await err({ venue: 'v3', pool: WETH_USDG_V3, tickLower: -198845, tickUpper: -198000, amount0: '1' }), /multiples of the pool's tick spacing \(10\), such as -198850 and -198000/);
  assert.match(await err({ venue: 'v3', pool: WETH_USDG_V3, tickLower: -198000, tickUpper: -199000, amount0: '1' }), /tickLower must be below tickUpper/);
  assert.match(await err({ venue: 'v3', id, amount1: '1.0000001' }), /USDG has 6 decimals; the amount has more/);
  assert.match(await err({ venue: 'v3', id }), /give amount0, amount1 or both/);
  assert.match(await err({ venue: 'v3', id, amount0: '1', payWithEth: true }), /this pool has no WETH side to pay with ETH/);
  assert.match(await err({ venue: 'v4', pool: s.freeId, fullRange: true, amount0: '0.1', payWithEth: true }), /payWithEth is for v3 pools with WETH/);
  assert.match(await err({ venue: 'v4', pool: s.freeId, fullRange: true, amount0: '0.1', slippageBps: 50 }), /slippageBps applies to v3/);
  assert.match(await err({ venue: 'v3', pool: '0x00000000000000000000000000000000000000c3', fullRange: true, amount0: '1' }), /not a Uniswap v3 pool on Robinhood Chain/);
  assert.match(await err({ venue: 'v3', pool: '0x1234', fullRange: true, amount0: '1' }), /20-byte address/);
  assert.match(await err({ venue: 'v4', pool: `0x${'ab'.repeat(32)}`, fullRange: true, amount0: '0.1' }), /does not hash to this pool id/);
  assert.match(await err({ venue: 'v3', id: '424242', amount0: '1' }), /Uniswap v3 position #424242 does not exist/);
  s.st.owner.set(`v3:${V3_POS}`, OTHER);
  assert.match(await err({ venue: 'v3', id, amount0: '1' }), /does not own this position on chain\. It belongs to 0x0{38}aa/);
  const r = await c.callTool({ name: 'goatlp_add_liquidity', arguments: { venue: 'v3', id, amount0: '1', slippageBps: 301 } });
  assert.equal(r.isError, true, 'more than 3% slippage is refused by the schema');
  assert.equal(s.signer.sent.length, 0);
  await c.close();
});

test('execute: a small price move keeps the plan; a move past the price limit or a changed pin refuses before anything is sent', async () => {
  const s = setup();
  const c = await connect(s.options);
  const args = { venue: 'v3', id: String(V3_POS), amount0: '1', amount1: '300' };
  const move = (ticks: number) => s.chain.on(AMZN_USDG_V3, 'slot0', () => [getSqrtRatioAtTick(-221190 + ticks), -221190 + ticks, 0, 1, 1, 0, true]);
  let plan = await call(c, args);
  move(30);
  const ok = await call(c, { ...args, execute: true, planId: plan.planId });
  assert.equal(ok.error, undefined, String(ok.error));
  const sent = s.signer.sent.length;
  move(0);
  plan = await call(c, args);
  move(150);
  assert.match(String((await call(c, { ...args, execute: true, planId: plan.planId })).error), /the pool price moved past the deposit's price limit \(1\.00%\) since the plan/);
  move(0);
  plan = await call(c, args);
  s.chain.codeHashes.set(NPM.toLowerCase(), `0x${'77'.repeat(32)}`);
  assert.match(String((await call(c, { ...args, execute: true, planId: plan.planId })).error), /Uniswap v3 NonfungiblePositionManager at 0x7399.* does not match the build pinned in this package/);
  assert.equal(s.signer.sent.length, sent, 'nothing more was sent');
  await c.close();
});

test('nothing a deposit sends is a permission for all, a transfer or an unlimited allowance', async () => {
  const s = setup();
  const c = await connect(s.options);
  await planAndRun(c, { venue: 'v3', id: String(V3_POS), amount0: '1', amount1: '300' });
  await planAndRun(c, { venue: 'v3', pool: WETH_USDG_V3, fullRange: true, amount1: '50', payWithEth: true });
  await planAndRun(c, { venue: 'v4', pool: s.freeId, rangePct: 10, amount1: '100' });
  assert.ok(s.signer.sent.length >= 7, String(s.signer.sent.length));
  for (const t of s.signer.sent) {
    assert.ok(!NEVER.includes(t.data.slice(0, 10) as Hex), t.data.slice(0, 10));
    if (t.to === PERMIT2) assert.ok((fn(permit2Abi, t.data).args[2] as bigint) < 10n ** 30n);
    else if (t.to !== NPM && t.to !== POSM) assert.ok((fn(erc20Abi, t.data).args[1] as bigint) < 10n ** 30n, 'an exact amount');
  }
  await c.close();
});

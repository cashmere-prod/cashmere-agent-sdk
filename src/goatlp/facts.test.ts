// Chain reads: the pin check and the gates (code hash, chain id, the addresses the pinned contracts name), the contract
// state, and the mappers from raw results to pool and position facts (a failed field is 'unknown', never "off").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Address, Hex } from 'viem';
import { checkPins } from './chain';
import {
  GOAT_AUTO_COMPOUND_V4, GOAT_TREASURY, GOAT_V4_STEWARD, GOAT_V4_STEWARD_ENGINE, PINS,
} from './constants';
import {
  contractFactsFrom, decodePositionInfo, gatesFrom, loadEnv, loadPositionFacts, onKindsOf, poolFactsFrom, poolIdOf, positionFactsFrom,
} from './facts';
import type { PoolFacts } from './types';
import { FakeChain, TEST_ACCOUNT, fixture } from './__fixtures__/kit';

const ok = (result: unknown) => ({ status: 'success' as const, result });
const bad = (msg = 'x') => ({ status: 'failure' as const, error: new Error(msg) });

test('the pin check: every pinned contract matches; a different hash, no code or a failed read is refused with its name', async () => {
  const chain = new FakeChain();
  const all = await checkPins(chain, ['rangeExitV4', 'engine', 'posm']);
  assert.ok(all.rangeExitV4.ok && all.engine.ok && all.posm.ok);
  chain.codeHashes.set(GOAT_V4_STEWARD.toLowerCase(), `0x${'12'.repeat(32)}` as Hex);
  chain.codeHashes.set(GOAT_V4_STEWARD_ENGINE.toLowerCase(), null);
  const r = await checkPins(chain, ['rangeExitV4', 'engine']);
  assert.equal(r.rangeExitV4.ok, false);
  assert.match(r.rangeExitV4.reason, /GoatV4Steward at 0xBb64.* does not match the build pinned in this package/);
  assert.match(r.engine.reason, /GoatV4StewardEngine has no code/);
  chain.codeHash = async () => { throw new Error('rpc down'); };
  assert.match((await checkPins(chain, ['posm'])).posm.reason, /Could not read the code of Uniswap v4 PositionManager/);
});

test('the environment: all gates open on the real addresses; a pin mismatch closes only the automations that use it', async () => {
  const chain = new FakeChain();
  const env = await loadEnv(chain);
  for (const g of Object.values(env.gates)) assert.equal(g.ok, true, g.reason);
  assert.equal(env.contracts.spenders?.rangeExitV4, GOAT_V4_STEWARD_ENGINE);
  assert.deepEqual(env.contracts.feesBps, { compound: { v3: 1000, v4: 1000 }, range: { v4: 15, v3: 15 }, exit: { v4: 15, v3: 15 } });
  assert.equal(env.contracts.treasuryOk?.rangeExitV4, true);

  chain.codeHashes.set(PINS.compoundorV4.address.toLowerCase(), `0x${'34'.repeat(32)}` as Hex);
  const e2 = await loadEnv(chain);
  assert.equal(e2.gates.autoCompoundV4.ok, false, 'the fee taker behind auto-compound v4 must match too');
  assert.match(e2.gates.autoCompoundV4.reason, /GoatV4Compoundor/);
  assert.equal(e2.gates.rangeExitV4.ok, true);
  assert.equal(e2.gates.autoCompoundV3.ok, true);
});

test('the environment: an engine address other than the pinned one, or another chain, closes the gate', async () => {
  const chain = new FakeChain();
  chain.on(GOAT_V4_STEWARD, 'ENGINE', '0x00000000000000000000000000000000000000e1');
  const env = await loadEnv(chain);
  assert.equal(env.gates.rangeExitV4.ok, false);
  assert.equal(env.contracts.spenders?.rangeExitV4, undefined, 'never a spender the pin does not name');
  chain.on(GOAT_V4_STEWARD, 'ENGINE', GOAT_V4_STEWARD_ENGINE);
  chain.id = 1;
  const other = await loadEnv(chain);
  for (const g of Object.values(other.gates)) { assert.equal(g.ok, false); assert.match(g.reason, /not Robinhood Chain \(4663\)/); }
});

test('contract state: a failed read is unknown; a recipient other than the treasury is not ok', () => {
  const f = contractFactsFrom([ok(true), bad(), ok('0x00000000000000000000000000000000000000ff')], {});
  assert.equal(f.paused?.autoCompoundV3, true);
  assert.equal(f.treasuryOk?.autoCompoundV3, false);
  assert.equal(f.treasuryOk?.rangeExitV4, 'unknown');
  const g = gatesFrom(4663, Object.fromEntries(Object.keys(PINS).map((k) => [k, { ok: true, codehash: null, reason: '' }])) as never, {});
  assert.equal(g.rangeExitV4.ok, false, 'derived addresses not read');
  void GOAT_TREASURY;
});

test('pool facts: price references, registry entry, hook entry, red list, v3 coverage; failures are unknown', () => {
  const z = '0x0000000000000000000000000000000000000000';
  const p: PoolFacts = { venue: 'v4', token0: z as Address, token1: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', fee: 500, tickSpacing: 10, hooks: z as Address, poolId: `0x${'aa'.repeat(32)}` as Hex };
  const f = poolFactsFrom(p, {
    feed0: ok(z), feed1: ok('0x00000000000000000000000000000000000000f1'), poolFor: ok(['0x00000000000000000000000000000000000000a1', 10n]),
    entry: ok({ srcKind: 1, gate: 101, epoch: 3 }), poolInfo: ok([105, 3, true, true]),
    hookEntry: ok({ codehash: `0x${'00'.repeat(32)}`, pinnedFee: 0, maxSlippageBps: 0, kind: 0, requiredBits: 0 }), red: ok(undefined),
  });
  assert.deepEqual(f.compoundAnchor, { chainlinkBoth: false, anchorPool: true });
  assert.deepEqual(f.v4Entry, { listed: true, srcKind: 1, gate: 105, swapsOpen: true, budgeted: true, pairListed: true });
  assert.equal(f.hookEntry, null);
  assert.equal(f.redListed, false);
  const g = poolFactsFrom(p, { feed0: bad(), feed1: ok(z), poolFor: ok([z, 0n]), entry: bad(), red: bad('RedListedEntry()'), hookEntry: ok({ codehash: `0x${'11'.repeat(32)}`, pinnedFee: 6000, maxSlippageBps: 40, kind: 2, requiredBits: 0x0c00 }) });
  assert.equal(g.compoundAnchor, 'unknown');
  assert.equal(g.v4Entry, 'unknown');
  assert.equal(g.redListed, true);
  assert.deepEqual(g.hookEntry, { kind: 2, maxSlippageBps: 40, exitOnly: true, taxBps: 0, feeCapPips: 0 });
  const notListed = poolFactsFrom(p, { entry: { status: 'failure', error: { shortMessage: 'reverted: PoolNotAllowed()' } } });
  assert.deepEqual(notListed.v4Entry, { listed: false, pairListed: false, srcKind: 0, gate: 0, swapsOpen: false, budgeted: false }, 'an unlisted pair is a definite "not listed"');
  const poolOff = poolFactsFrom(p, { entry: ok({ srcKind: 1, gate: 101, epoch: 3 }), poolInfo: bad('PoolNotAllowed()') });
  assert.deepEqual(poolOff.v4Entry, { listed: false, srcKind: 1, gate: 101, swapsOpen: false, budgeted: false, pairListed: true });
  const v3: PoolFacts = { venue: 'v3', token0: '0x0bd7d308f8e1639fab988df18a8011f41eacad73', token1: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', fee: 500, tickSpacing: 10, pool: '0x69bfaf19c9f377bb306a89aed9f6b07e2c1a8d9a' };
  const c = poolFactsFrom(v3, { coverage: ok([true, true]), budget: ok([10n, 1n, 0n, 1n]), pair: ok({ gate: 110, gateHighFee: 140, feed0: { proxy: '0x00000000000000000000000000000000000000c1' } }), nc: ok({ refPool: z, gate: 0, gateHighFee: 0 }) });
  assert.deepEqual(c.v3Coverage, { pairListed: true, feeCovered: true, swapsOpen: false, gate: 110, baseGate: 110 });
  // a row priced without Chainlink carries the keeper's key; an unreadable nc() on such a row is "couldn't check"
  const nc = poolFactsFrom(v3, { coverage: ok([true, true]), budget: ok([10n, 1n, 5n, 1n]), pair: ok({ gate: 0, gateHighFee: 0, feed0: { proxy: z } }), nc: ok({ refPool: '0x00000000000000000000000000000000000000d1', gate: 120, gateHighFee: 150 }) });
  assert.equal((nc.v3Coverage as { nc?: boolean }).nc, true);
  assert.equal(nc.ncKey, 'nc:0x0bd7d308f8e1639fab988df18a8011f41eacad73:0x5fc5360d0400a0fd4f2af552add042d716f1d168');
  const ncUnread = poolFactsFrom(v3, { coverage: ok([true, true]), budget: ok([10n, 1n, 5n, 1n]), pair: ok({ gate: 0, gateHighFee: 0, feed0: { proxy: z } }), nc: bad() });
  assert.equal(ncUnread.v3Coverage, 'unknown');
});

test('position facts: v4 position info bits, the v3 position tuple, rule reads with their owners, unknown on failure', () => {
  const s24 = (n: number) => BigInt(n < 0 ? n + 0x1000000 : n);
  const info = (s24(-198650) << 32n) | (s24(-198960) << 8n) | 1n;
  assert.deepEqual(decodePositionInfo(info), { tickLower: -198960, tickUpper: -198650, subscriber: true });
  const key = { currency0: '0x0000000000000000000000000000000000000000', currency1: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', fee: 8388608, tickSpacing: 10, hooks: '0x06a889870c8f83640d6816319f72e2aa579b6080' };
  const f = positionFactsFrom({ id: 4006316n, venue: 'v4' }, {
    owner: ok(TEST_ACCOUNT), approved: ok(GOAT_V4_STEWARD_ENGINE), info: ok([key, info]), liq: ok(10n),
    'rule:range': ok([{ mode: 1, triggerTicks: 101, slippageBps: 50, minInterval: 3600, budget: 20, lastRunAt: 0, flags: 0, lowerTrigger: 0, upperTrigger: 0, pairEpoch: 1, maxSwapFeePips: 10000 }, TEST_ACCOUNT]),
  });
  assert.equal(f.tickSpacing, 10);
  assert.equal(f.subscriber, true);
  assert.equal(f.approved, GOAT_V4_STEWARD_ENGINE);
  assert.equal(f.hooks, key.hooks);
  assert.equal((f.rules!.range as { on: boolean }).on, true);
  assert.equal((f.rules!.exit as { on: boolean }).on, false, 'the Steward holds one rule');
  assert.deepEqual(onKindsOf(f.rules, f.owner), ['range']);
  // the pool id the API gives for this pool is the hash of its key
  assert.equal(poolIdOf(key as never), fixture<{ pool: string }>('position-v4.json').pool);
  const v3 = positionFactsFrom({ id: 6n, venue: 'v3' }, {
    owner: { status: 'failure', error: new Error('ERC721: invalid token ID') }, approved: ok('0x0000000000000000000000000000000000000000'),
    pos: ok([0n, TEST_ACCOUNT, TEST_ACCOUNT, TEST_ACCOUNT, 500, -100, 100, 7n, 0n, 0n, 0n, 0n]), 'rule:compound': bad(), 'rule:compoundOwner': ok(TEST_ACCOUNT),
  });
  assert.equal(v3.owner, 'unknown');
  assert.equal(v3.burned, true);
  assert.equal(v3.approved, null);
  assert.equal(v3.liquidity, 7n);
  assert.equal(v3.tickSpacing, 10);
  assert.equal(v3.rules!.compound, 'unknown');
  assert.equal(onKindsOf(v3.rules, v3.owner), 'unknown', 'nothing reads on and a slot failed: unknown');
});

test('rules of a previous owner do not count as on', () => {
  const f = positionFactsFrom({ id: 9n, venue: 'v4' }, {
    owner: ok(TEST_ACCOUNT), approved: ok('0x0000000000000000000000000000000000000000'), liq: ok(1n),
    'rule:compound': ok([true, false, false, 100, 3600, 0, 0n]), 'rule:compoundOwner': ok('0x00000000000000000000000000000000000000aa'),
  });
  assert.deepEqual(onKindsOf(f.rules, f.owner), []);
});

test('position facts loader: reads only the rules of contracts whose gate is open', async () => {
  const chain = new FakeChain();
  const env = await loadEnv(chain);
  const closed = { ...env.gates, autoCompoundV4: { ok: false, reason: 'x' }, rangeExitV4: { ok: false, reason: 'x' } };
  chain.reads = [];
  await loadPositionFacts(chain, [{ id: 1n, venue: 'v4' }], { gates: closed });
  assert.deepEqual(chain.reads.map((r) => r.split(':')[1]), ['ownerOf', 'getApproved', 'getPoolAndPositionInfo', 'getPositionLiquidity']);
  chain.reads = [];
  await loadPositionFacts(chain, [{ id: 1n, venue: 'v4' }], env);
  assert.ok(chain.reads.includes(`${GOAT_AUTO_COMPOUND_V4.toLowerCase()}:configs`));
  assert.ok(chain.reads.includes(`${GOAT_V4_STEWARD.toLowerCase()}:configOf`));
});

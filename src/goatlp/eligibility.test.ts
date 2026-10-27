// Eligibility: one row per pool scenario and kind, the hook rule, and the position-level reasons (owner, empty, subscriber,
// one automation at a time, full range, too narrow, size, paused, retired).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Address, Hex } from 'viem';
import { blockOf, minWidthTicks, poolVerdict, positionVerdict, sortLines } from './eligibility';
import { ELIG } from './copy';
import type { ContractFacts, ContractGates, EligCode, Kind, PoolFacts, PoolVerdict, PositionFacts } from './types';
import { GATES_OK, OTHER, TEST_ACCOUNT } from './__fixtures__/kit';

const KINDS: Kind[] = ['compound', 'range', 'exit'];
const ACCOUNT = TEST_ACCOUNT;
const z = '0x0000000000000000000000000000000000000000' as Address;
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168' as Address;
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73' as Address;
const REVIEWED_HOOK = '0x06a889870c8f83640d6816319f72e2aa579b6080' as Address;
const REVIEWED_HASH = '0x0430617b26dfc5c3f6be1e1733304c6050c6b6ba9d0fb950b57070b5b2a96db4' as Hex;
const CL = { chainlinkBoth: true, anchorPool: false };
const LISTED = { listed: true, srcKind: 1, gate: 101, swapsOpen: true, budgeted: true, pairListed: true };
const COVERED = { pairListed: true, feeCovered: true, swapsOpen: true, gate: 101, baseGate: 101 };

const v4 = (o: Partial<PoolFacts> = {}): PoolFacts => ({ venue: 'v4', token0: z, token1: USDG, fee: 500, tickSpacing: 10, hooks: z, poolId: `0x${'01'.repeat(32)}` as Hex, compoundAnchor: CL, v4Entry: LISTED, hookEntry: null, redListed: false, ...o });
const v3 = (o: Partial<PoolFacts> = {}): PoolFacts => ({ venue: 'v3', token0: WETH, token1: USDG, fee: 500, tickSpacing: 10, pool: '0x69bfaf19c9f377bb306a89aed9f6b07e2c1a8d9a', compoundAnchor: CL, v3Coverage: COVERED, ...o });

const POOLS = {
  ethUsdgV4: v4(),
  ethUsdcV3: v3(),
  anchoredV4: v4({ compoundAnchor: { chainlinkBoth: false, anchorPool: true }, v4Entry: { ...LISTED, srcKind: 2, gate: 140 }, tickSpacing: 200, fee: 10_000 }),
  thinV4: v4({ compoundAnchor: { chainlinkBoth: false, anchorPool: false }, v4Entry: { listed: false, pairListed: false, srcKind: 0, gate: 0, swapsOpen: false, budgeted: false } }),
  thinV3: v3({ compoundAnchor: { chainlinkBoth: false, anchorPool: false }, v3Coverage: { pairListed: false, feeCovered: false, swapsOpen: false, gate: 0 } }),
  returnDeltaV4: v4({ hooks: '0x0000000000000000000000000000000000000003' }),
  dynamicFeeV4: v4({ fee: 0x800000 }),
  redListedV4: v4({ redListed: true }),
  transferTaxV3: v3({ token0: '0x337f3f7384a2e2cfb9757971d469773f23e509f0' as Address }),
  unreviewedHookV4: v4({ hooks: '0x1234567890123456789012345678901234560080' as Address, hookCodeHash: `0x${'22'.repeat(32)}` as Hex, gac4HookPin: null }),
  swapsClosedV4: v4({ v4Entry: { ...LISTED, swapsOpen: false } }),
  reviewedHookV4: v4({ fee: 0x800000, hooks: REVIEWED_HOOK, hookCodeHash: REVIEWED_HASH, gac4HookPin: REVIEWED_HASH, hookEntry: { kind: 1, maxSlippageBps: 40, exitOnly: false, taxBps: 0, feeCapPips: 6000 } }),
  unknownV4: v4({ compoundAnchor: 'unknown', v4Entry: 'unknown', redListed: 'unknown' }),
};

const offered = (v: PoolVerdict) => KINDS.filter((k) => v.kinds[k].offered && v.kinds[k].live);
const firstBlock = (v: PoolVerdict, k: Kind) => blockOf(v.kinds[k])?.code ?? null;

type Row = { name: string; pool: PoolFacts; expect: Record<Kind, EligCode | 'ok' | 'withdraw-only'> };
const TABLE: Row[] = [
  { name: 'ETH/USDG v4 with Chainlink', pool: POOLS.ethUsdgV4, expect: { compound: 'ok', range: 'ok', exit: 'ok' } },
  { name: 'WETH/USDG v3 with Chainlink', pool: POOLS.ethUsdcV3, expect: { compound: 'ok', range: 'ok', exit: 'ok' } },
  { name: 'v4 pair with a deep anchor pool', pool: POOLS.anchoredV4, expect: { compound: 'ok', range: 'ok', exit: 'ok' } },
  { name: 'thin v4 pool without a price reference', pool: POOLS.thinV4, expect: { compound: 'NO_PRICE_REFERENCE', range: 'NO_PRICE_REFERENCE', exit: 'NO_PRICE_REFERENCE' } },
  { name: 'thin v3 pool outside the pair table', pool: POOLS.thinV3, expect: { compound: 'NO_PRICE_REFERENCE', range: 'NO_PRICE_REFERENCE', exit: 'NO_PRICE_REFERENCE' } },
  { name: 'a hook that can change what a withdrawal returns', pool: POOLS.returnDeltaV4, expect: { compound: 'HOOK_RETURN_DELTA', range: 'HOOK_RETURN_DELTA', exit: 'HOOK_RETURN_DELTA' } },
  { name: 'a dynamic fee without a hook', pool: POOLS.dynamicFeeV4, expect: { compound: 'DYNAMIC_FEE_NO_HOOK', range: 'DYNAMIC_FEE_NO_HOOK', exit: 'DYNAMIC_FEE_NO_HOOK' } },
  { name: 'red-listed pool', pool: POOLS.redListedV4, expect: { compound: 'RED_LISTED', range: 'RED_LISTED', exit: 'RED_LISTED' } },
  { name: 'a token that keeps a cut when it moves', pool: POOLS.transferTaxV3, expect: { compound: 'ok', range: 'TRANSFER_TAX_TOKEN', exit: 'withdraw-only' } },
  { name: 'an unreviewed hook (every automation off)', pool: POOLS.unreviewedHookV4, expect: { compound: 'UNREVIEWED_HOOK', range: 'UNREVIEWED_HOOK', exit: 'UNREVIEWED_HOOK' } },
  { name: 'swaps closed for the pair', pool: POOLS.swapsClosedV4, expect: { compound: 'ok', range: 'SWAPS_CLOSED', exit: 'withdraw-only' } },
  { name: 'a reviewed hook with its pinned code hash and a registry entry', pool: POOLS.reviewedHookV4, expect: { compound: 'ok', range: 'ok', exit: 'ok' } },
];

for (const r of TABLE) {
  test(`eligibility: ${r.name}`, () => {
    const v = poolVerdict(r.pool, GATES_OK);
    for (const k of KINDS) {
      const e = r.expect[k];
      const kv = v.kinds[k];
      assert.equal(kv.live, true);
      if (e === 'ok') {
        assert.equal(kv.offered, true, `${k}: ${JSON.stringify(kv.lines)}`);
        assert.ok(!kv.limits.exitWithdrawOnly);
      } else if (e === 'withdraw-only') {
        assert.equal(kv.offered, true, `${k} offered, limited`);
        assert.equal(kv.limits.exitWithdrawOnly, true);
      } else {
        assert.equal(kv.offered, false, `${k} not offered`);
        assert.equal(firstBlock(v, k), e, `${k} reason`);
      }
    }
  });
}

test('a contract whose code does not match its pin: that automation is not live, the others are', () => {
  const gates: ContractGates = { ...GATES_OK, rangeExitV4: { ok: false, reason: 'GoatV4Steward at 0xBb64 does not match the build pinned in this package.' } };
  const v = poolVerdict(POOLS.ethUsdgV4, gates);
  assert.equal(v.kinds.range.live, false);
  assert.equal(v.kinds.range.offered, true, 'the pool itself is fine; nothing can be sent while not live');
  assert.equal(blockOf(v.kinds.range)?.code, 'NOT_LIVE');
  assert.equal(v.kinds.compound.live, true);
});

test('the hook rule: the reviewed list with its pinned code hash, fail closed', () => {
  const r = POOLS.reviewedHookV4;
  for (const hookCodeHash of [`0x${'11'.repeat(32)}`, null] as const) {
    const v = poolVerdict({ ...r, hookCodeHash: hookCodeHash as PoolFacts['hookCodeHash'] }, GATES_OK);
    for (const k of ['range', 'exit'] as const) assert.equal(firstBlock(v, k), 'UNREVIEWED_HOOK', `${k} ${hookCodeHash}`);
    assert.equal(blockOf(v.kinds.range)?.text, ELIG.UNREVIEWED_HOOK_BLOCK);
  }
  for (const hookCodeHash of [undefined, 'unknown'] as const) {
    assert.deepEqual(offered(poolVerdict({ ...r, hookCodeHash }, GATES_OK)), [], "an unread code hash is never offered");
  }
  // reviewed here but missing in the registry's hook list: auto-compound stays, auto-range / auto-exit are refused
  const noReg = poolVerdict({ ...r, hookEntry: null }, GATES_OK);
  assert.equal(noReg.kinds.compound.offered, true);
  assert.equal(firstBlock(noReg, 'range'), 'UNLISTED_POOL');
  assert.equal(blockOf(noReg.kinds.exit)?.text, ELIG.UNLISTED_POOL_BLOCK);
  // auto-compound follows GoatAutoCompoundV4's own list
  assert.equal(firstBlock(poolVerdict({ ...r, gac4HookPin: null }, GATES_OK), 'compound'), 'UNREVIEWED_HOOK');
  assert.equal(firstBlock(poolVerdict({ ...r, gac4HookPin: 'unknown' }, GATES_OK), 'compound'), 'UNKNOWN');
  // the Doppler launch hook is never an auto-compound venue
  const doppler = poolVerdict({ ...r, hooks: '0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544', gac4HookPin: REVIEWED_HASH }, GATES_OK);
  assert.equal(firstBlock(doppler, 'compound'), 'UNREVIEWED_HOOK');
  const taxed = poolVerdict(POOLS.reviewedHookV4, GATES_OK);
  assert.ok(taxed.kinds.range.lines.some((l) => l.code === 'REVIEWED_HOOK' && l.text.includes('0.60%') && l.text.includes('0.40%')));
  assert.equal(taxed.kinds.range.limits.maxSlippageBps, 40);
});

test('failed reads: a "couldn\'t check" block, never an "off"', () => {
  const v = poolVerdict(POOLS.unknownV4, GATES_OK);
  for (const k of KINDS) assert.equal(firstBlock(v, k), 'UNKNOWN');
});

test('limits: the gate, the narrowest width, the price protection caps; no gate read = no width (never a guessed gate)', () => {
  const v = poolVerdict(POOLS.anchoredV4, GATES_OK);
  assert.equal(v.kinds.range.limits.gateTicks, 140);
  assert.equal(v.kinds.range.limits.minWidthTicks, minWidthTicks(140, 200));
  assert.equal(minWidthTicks(100, 10), 400);
  assert.equal(minWidthTicks(140, 200), 800);
  assert.equal(minWidthTicks(101, 60), 420);
  assert.equal(poolVerdict(POOLS.ethUsdcV3, GATES_OK).kinds.compound.limits.maxSlippageBps, 500);
  assert.equal(poolVerdict(POOLS.ethUsdgV4, GATES_OK).kinds.compound.limits.maxSlippageBps, 2000);
  const unread = poolVerdict(v4({ v4Entry: undefined }), GATES_OK);
  assert.equal(unread.kinds.range.limits.gateTicks, 0);
  assert.equal(unread.kinds.range.limits.minWidthTicks, undefined);
});

// ------------------------------------------------------------------ position level

const pos = (o: Partial<PositionFacts> = {}): PositionFacts => ({ id: 1n, venue: 'v4', owner: ACCOUNT, liquidity: 10n ** 18n, tickLower: -200_000, tickUpper: -198_000, tickSpacing: 10, subscriber: false, approved: null, rules: {}, ...o });
const OK_CONTRACTS: ContractFacts = { paused: {}, stewardPausedModes: 0, stewardRetired: false };

test('position: owner, empty, subscriber, one at a time (with the reason that is true for the venue), full range, too narrow', () => {
  const pv = poolVerdict(POOLS.ethUsdgV4, GATES_OK);
  assert.deepEqual(offered(positionVerdict(pv, pos(), { account: ACCOUNT })), KINDS);
  assert.equal(firstBlock(positionVerdict(pv, pos(), { account: OTHER }), 'compound'), 'NOT_OWNER');
  assert.equal(firstBlock(positionVerdict(pv, pos(), {}), 'compound'), 'NOT_OWNER');
  assert.equal(firstBlock(positionVerdict(pv, pos({ liquidity: 0n }), { account: ACCOUNT }), 'range'), 'EMPTY');
  assert.equal(firstBlock(positionVerdict(pv, pos({ subscriber: true }), { account: ACCOUNT }), 'compound'), 'SUBSCRIBER');
  const one = positionVerdict(pv, pos(), { account: ACCOUNT, onKinds: ['compound'] });
  assert.equal(one.kinds.compound.offered, true);
  assert.equal(firstBlock(one, 'range'), 'ONE_AT_A_TIME');
  const v3one = positionVerdict(poolVerdict(POOLS.ethUsdcV3, GATES_OK), pos({ venue: 'v3' }), { account: ACCOUNT, onKinds: ['range'] });
  assert.match(blockOf(v3one.kinds.exit)!.text, /new ID/);
  assert.equal(firstBlock(positionVerdict(pv, pos(), { account: ACCOUNT, onKinds: 'unknown' }), 'exit'), 'UNKNOWN');
  const full = positionVerdict(pv, pos({ tickLower: -887270, tickUpper: 887270 }), { account: ACCOUNT });
  assert.equal(firstBlock(full, 'range'), 'FULL_RANGE');
  assert.equal(full.kinds.compound.offered, true);
  assert.equal(firstBlock(positionVerdict(pv, pos({ tickLower: 0, tickUpper: 200 }), { account: ACCOUNT }), 'range'), 'TOO_NARROW', 'v4 narrow = block');
  const narrowV3 = positionVerdict(poolVerdict(POOLS.ethUsdcV3, GATES_OK), pos({ venue: 'v3', tickLower: 0, tickUpper: 200 }), { account: ACCOUNT });
  assert.equal(narrowV3.kinds.range.offered, true, 'v3 narrow = pick a wider new width');
  assert.ok(narrowV3.kinds.range.lines.some((l) => l.code === 'TOO_NARROW' && l.level === 'limit'));
});

test('position: under the minimum size, auto-range is not offered (a note when it is already on); auto-compound gets a note', () => {
  const pv = poolVerdict(POOLS.ethUsdgV4, GATES_OK);
  const small = positionVerdict(pv, pos(), { account: ACCOUNT, valueUsd: 20, minUsd: 50 });
  assert.equal(firstBlock(small, 'range'), 'SMALL_POSITION');
  assert.match(blockOf(small.kinds.range)!.text, /under about \$50/);
  assert.equal(small.kinds.compound.offered, true);
  assert.ok(small.kinds.compound.lines.some((l) => l.text === ELIG.SMALL_COMPOUND));
  const on = positionVerdict(pv, pos(), { account: ACCOUNT, valueUsd: 20, minUsd: 50, onKinds: ['range'] });
  assert.equal(on.kinds.range.offered, true, 'Change and Stop stay possible');
  assert.equal(positionVerdict(pv, pos(), { account: ACCOUNT, valueUsd: undefined }).kinds.range.offered, true, 'an unpriced position is not judged');
});

test('position: paused and retired contracts', () => {
  const pv = poolVerdict(POOLS.ethUsdgV4, GATES_OK);
  const paused = positionVerdict(pv, pos(), { account: ACCOUNT, contracts: { ...OK_CONTRACTS, paused: { autoCompoundV4: true }, stewardPausedModes: 1 } });
  assert.ok(paused.kinds.compound.lines.some((l) => l.code === 'PAUSED' && l.level === 'limit'));
  assert.equal(firstBlock(paused, 'range'), 'PAUSED', 'a paused Steward mode would revert the rule');
  assert.equal(paused.kinds.exit.offered, true);
  const retired = positionVerdict(pv, pos(), { account: ACCOUNT, contracts: { ...OK_CONTRACTS, stewardRetired: true } });
  assert.equal(firstBlock(retired, 'range'), 'RETIRED');
  assert.equal(positionVerdict(pv, pos(), { account: ACCOUNT, contracts: OK_CONTRACTS }).kinds.range.offered, true);
});

test('lines are sorted: blocks first by priority, then limits, then notes', () => {
  const s = sortLines([
    { code: 'SMALL_POSITION', level: 'info', text: 'c' }, { code: 'EMPTY', level: 'block', text: 'b' },
    { code: 'NOT_OWNER', level: 'block', text: 'a' }, { code: 'TOO_NARROW', level: 'limit', text: 'd' },
  ]);
  assert.deepEqual(s.map((l) => l.code), ['NOT_OWNER', 'EMPTY', 'TOO_NARROW', 'SMALL_POSITION']);
});

// The keeper's size limit per pair and its advice keys, the thin-pool list, and the sessions a v4 auto-compound stop
// cancels when the keeper store, this server's record and the chain disagree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Address } from 'viem';
import { ELIG } from './copy';
import { poolVerdict } from './eligibility';
import { isThinCompoundPool } from './hooks';
import { normaliseStatus, pairRowOf, pairRowsOf, sizeLimitOf, statusFileOf } from './keeper';
import { nonceOf, revokeSet, sessionUnion } from './permits';
import type { PoolFacts } from './types';
import { GATES_OK, NOW_SEC } from './__fixtures__/kit';

const ETH = '0x0000000000000000000000000000000000000000';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const AMZN = '0x12f190a9f9d7d37a250758b26824b97ce941bf54';
const row = (over: Record<string, unknown> = {}) => ({ venue: 'v4', token0: ETH, token1: USDG, state: 'limited', maxRunUsd: 5000, reason: 'price-check-depth', eta: null, ...over });

test('pairs rows: checked like the status rows, one per venue and pair, from a fresh file only', () => {
  assert.deepEqual(pairRowOf(row()), { venue: 'v4', token0: ETH, token1: USDG, state: 'limited', maxRunUsd: 5000, reason: 'price-check-depth', eta: null });
  assert.equal(pairRowOf(row({ state: 'waiting', maxRunUsd: 0, eta: NOW_SEC + 3600 }))?.state, 'waiting');
  for (const bad of [
    row({ venue: 'v2' }), row({ token0: USDG, token1: ETH }), row({ token1: USDG.toUpperCase().replace('0X', '0x') }), row({ state: 'open' }),
    row({ state: 'waiting', maxRunUsd: 10 }), row({ maxRunUsd: -1 }), row({ maxRunUsd: 1.5 }), row({ reason: 'Price Check' }), row({ eta: 'soon' }), null, [row()],
  ]) assert.equal(pairRowOf(bad), null, JSON.stringify(bad));
  const body = (rows: unknown[], version = 1) => ({ version: 1, updatedAt: NOW_SEC - 60, positions: [], pairs: { version, rows } });
  assert.equal(pairRowsOf(body([row(), row({ maxRunUsd: 1 }), row({ venue: 'v3' }), row({ token1: 'bad' })])).length, 2, 'the first row of a pair wins; bad rows are dropped');
  assert.deepEqual(pairRowsOf(body([row()], 2)), [], 'another version is not read');
  assert.equal(statusFileOf(body([row()]), NOW_SEC).pairs.length, 1);
  assert.deepEqual(statusFileOf({ ...body([row()]), updatedAt: NOW_SEC - 3600 }, NOW_SEC).pairs, [], 'never from a stale file');
  const file = statusFileOf(body([row({ venue: 'v3', token0: AMZN, token1: USDG, state: 'waiting', maxRunUsd: 0 })]), NOW_SEC);
  assert.deepEqual(sizeLimitOf(file, 'v3', USDG, AMZN), { state: 'waiting', maxRunUsd: 0, eta: null }, 'token order does not matter');
  assert.equal(sizeLimitOf(file, 'v4', USDG, AMZN), null);
});

test('advice keys: a cap-exceeded or exit-only row carries the "withdraw only" advice; the row\'s own advice key wins', () => {
  assert.equal(normaliseStatus({ tokenId: '1', status: 'cap-exceeded' })?.adviceKey, 'swap-too-large');
  assert.equal(normaliseStatus({ tokenId: '1', status: 'exit-only' })?.adviceKey, 'swaps-closed');
  assert.equal(normaliseStatus({ tokenId: '1', status: 'cap-exceeded', advice: 'raise-max-fee' })?.adviceKey, 'raise-max-fee');
  assert.equal(normaliseStatus({ tokenId: '1', status: 'ok' })?.adviceKey, undefined);
});

const v3pool: PoolFacts = {
  venue: 'v3', token0: AMZN as Address, token1: USDG as Address, fee: 3000, tickSpacing: 60, pool: '0x8ac92da74ab5f3b1d024dc1943ad7e15dc4179ef',
  compoundAnchor: { chainlinkBoth: true, anchorPool: false }, v3Coverage: { pairListed: true, feeCovered: true, swapsOpen: true, gate: 101 },
  redListed: false, transferTax: false,
};

test('the thin-pool list and the size limit in the pool verdict', () => {
  // the thin-pool list is empty today; a row closes auto-compound for that pair on that venue, in either token order
  assert.equal(isThinCompoundPool(v3pool), false);
  const thin = [{ label: 'USDG/AMZN v3', venue: 'v3' as const, a: USDG, b: AMZN }];
  assert.equal(isThinCompoundPool(v3pool, thin), true);
  assert.equal(isThinCompoundPool({ ...v3pool, venue: 'v4' }, thin), false);
  const tv = poolVerdict(v3pool, GATES_OK, { thinVenues: thin });
  assert.equal(tv.kinds.compound.offered, false);
  assert.equal(tv.kinds.compound.lines.find((l) => l.level === 'block')?.text, ELIG.THIN_POOL);
  assert.equal(tv.kinds.range.offered, true);
  // limited: a limit line for auto-range and a swap exit, nothing for auto-compound
  const lim = poolVerdict({ ...v3pool, sizeLimit: { state: 'limited', maxRunUsd: 5000, eta: null } }, GATES_OK);
  for (const k of ['range', 'exit'] as const) {
    assert.ok(lim.kinds[k].lines.some((l) => l.code === 'SIZE_LIMITED' && l.level === 'limit' && l.text === ELIG.SIZE_LIMITED), k);
    assert.equal(lim.kinds[k].offered, true);
  }
  assert.ok(!lim.kinds.compound.lines.some((l) => l.code === 'SIZE_LIMITED'));
  // waiting: auto-range is not offered; a swap exit waits, the withdraw-only exit is not affected
  const wait = poolVerdict({ ...v3pool, sizeLimit: { state: 'waiting', maxRunUsd: 0, eta: null } }, GATES_OK);
  assert.equal(wait.kinds.range.offered, false);
  assert.ok(wait.kinds.range.lines.some((l) => l.code === 'SIZE_LIMITED' && l.level === 'block' && l.text === "Auto-range isn't offered on this pair right now. Exits without a swap work."));
  assert.ok(wait.kinds.exit.lines.some((l) => l.code === 'SIZE_LIMITED' && l.level === 'limit' && l.text === 'Swap exits on this pair are paused right now. Withdraw only would act right away.'));
  assert.equal(wait.kinds.exit.offered, true);
  assert.equal(wait.kinds.exit.limits.sizeWaiting, true);
  // a withdraw-only exit (the pair's swaps are closed) gets no size line
  const closed = poolVerdict({ ...v3pool, v3Coverage: { pairListed: true, feeCovered: true, swapsOpen: false, gate: 101 }, sizeLimit: { state: 'limited', maxRunUsd: 1, eta: null } }, GATES_OK);
  assert.ok(!closed.kinds.exit.lines.some((l) => l.code === 'SIZE_LIMITED'));
});

test('stop sessions: the records when all agree; the union with the chain\'s scan when they do not; the scan alone without a record', () => {
  const base = 1000n;
  const s = (word: bigint, size: number) => ({ word, size, deadline: BigInt(NOW_SEC + 86_400) });
  const bm = (o: Record<string, bigint>) => new Map(Object.entries(o));
  // agree: the store and the record list the same session; the chain shows nothing else in use
  let u = sessionUnion(base, { store: [s(base, 6)], local: [s(base, 6)], scanWords: [base, base + 1n], bitmaps: bm({ [String(base)]: 0b11n, [String(base + 1n)]: 0n }) });
  assert.equal(u.source, 'records');
  assert.deepEqual(revokeSet({ base, sessions: u.sessions, bitmaps: bm({ [String(base)]: 0b11n }) }), [2, 3, 4, 5].map((b) => nonceOf(base, b)));
  // the store and the record differ: both, and every word of the scan
  u = sessionUnion(base, { store: [s(base, 6)], local: [s(base, 6), s(base + 1n, 4)], scanWords: [base, base + 1n, base + 2n], bitmaps: bm({ [String(base)]: 1n, [String(base + 1n)]: 1n, [String(base + 2n)]: 0n }) });
  assert.equal(u.source, 'union');
  assert.deepEqual(u.sessions.map((x) => [x.word, x.size]), [[base, 6], [base + 1n, 4], [base + 2n, 30]]);
  // the chain shows a word in use that no record has
  u = sessionUnion(base, { store: [s(base, 4)], local: [], scanWords: [base, base + 1n, base + 2n], bitmaps: bm({ [String(base)]: 1n, [String(base + 1n)]: 1n, [String(base + 2n)]: 0n }) });
  assert.equal(u.source, 'union');
  assert.deepEqual(u.sessions.map((x) => [x.word, x.size]), [[base, 4], [base + 1n, 30], [base + 2n, 30]]);
  // a used bit past the recorded size: that word counts as 30
  u = sessionUnion(base, { store: [], local: [s(base, 4)], scanWords: [base, base + 1n], bitmaps: bm({ [String(base)]: 1n << 9n, [String(base + 1n)]: 0n }) });
  assert.deepEqual(u.sessions.map((x) => [x.word, x.size]), [[base, 30], [base + 1n, 30]]);
  // no record at all: the scan
  u = sessionUnion(base, { store: [], local: [], scanWords: [base], bitmaps: bm({ [String(base)]: 0n }) });
  assert.equal(u.source, 'scan');
  assert.deepEqual(u.sessions.map((x) => [x.word, x.size]), [[base, 30]]);
  // a record outside the window is ignored
  u = sessionUnion(base, { store: [s(base + 99n, 4)], local: [], scanWords: [base], bitmaps: bm({ [String(base)]: 0n }) });
  assert.equal(u.source, 'scan');
});

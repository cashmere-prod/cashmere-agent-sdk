// The whole r4 auto-range port (preload ./__fixtures__/r4-open.ts: values filled, review switch on): the permission for all
// positions first, no move limit, standing; a rule that moves in pieces is stopped and changed on all its positions at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData, type Abi } from 'viem';
import { autoRangeAbi, npmAbi, stewardAbi } from './abis';
import { assertAutomationTx } from './guard';
import { AUTO_RANGE_OPEN, AUTO_RANGE_V3, GOAT_V4_STEWARD, NPM } from './constants';
import { sameRule } from './r4family';
import { validBudget } from './validate';
import { ETH_USDG_V4, OTHER, P4, TEST_ACCOUNT, V3_POS, V4_POS, ctx, pool4 } from './__fixtures__/kit';
import { actions, call, connect, fn, setup } from './__fixtures__/mcp';

const ALLOW_ALL = 'Allow auto-range on your positions of this venue (it acts only where auto-range is on)';
const ST_ON = { mode: 1, triggerTicks: 102, slippageBps: 25, minInterval: 21600, budget: 255, lastRunAt: 0, flags: 0, lowerTrigger: 0, upperTrigger: 0, pairEpoch: 1, maxSwapFeePips: 10000 };
const AR_ON = [102, 102, -120, 120, 1n << 56n, 1n << 56n, false, false, 27670116110564327n];
const D = 7_000_001n; const E = 7_000_002n; const F = 7_000_003n; const G = 7_000_004n;
const row = (id: bigint) => ({ exchange: 'uniswapv4', nft_id: String(id), pool: ETH_USDG_V4, fee_tier: 0, token0: '0x0', token1: '0x0', owner: TEST_ACCOUNT, tick_lower: 0, tick_upper: 0 });
const accountRoute = { [`/v2/positions/account/${TEST_ACCOUNT.toLowerCase()}`]: { body: { success: true, data: [row(D), row(E), row(F), row(G)], pagination: { has_next: false } } } };

test('open: the review switch opens auto-range; the move limit is 1-20 or 255', () => {
  assert.equal(AUTO_RANGE_OPEN, true);
  for (const b of [1, 20, 255]) assert.equal(validBudget(b), true, String(b));
  for (const b of [0, 21, 254, 256, 1.5]) assert.equal(validBudget(b), false, String(b));
});

test('open: v3 auto-range gives the permission for all positions first, then the rule; with it already on, the rule only', async () => {
  const s = setup();
  const client = await connect(s.options);
  const args = { venue: 'v3', id: String(V3_POS) };
  const plan = await call(client, 'goatlp_set_auto_range', args);
  assert.equal(plan.error, undefined, String(plan.error));
  assert.deepEqual(actions(plan), [ALLOW_ALL, 'Turn on']);
  assert.match(String((plan as { permission?: string }).permission), /^All your Uniswap v3 positions in this wallet, to AutoRange\. It acts only on positions where auto-range is on\.$/);
  await call(client, 'goatlp_set_auto_range', { ...args, execute: true, planId: plan.planId });
  assert.deepEqual(s.signer.sent.map((t) => t.to), [NPM, AUTO_RANGE_V3]);
  assert.deepEqual(fn(npmAbi, s.signer.sent[0].data).args, [AUTO_RANGE_V3, true]);
  assert.equal(fn(autoRangeAbi, s.signer.sent[1].data).functionName, 'configToken');
  const s2 = setup();
  s2.st.forAll.add(`v3:${TEST_ACCOUNT.toLowerCase()}:${AUTO_RANGE_V3.toLowerCase()}`);
  const c2 = await connect(s2.options);
  assert.deepEqual(actions(await call(c2, 'goatlp_set_auto_range', args)), ['Turn on']);
  await client.close();
  await c2.close();
});

test('open: a v4 rule moving in pieces is stopped on every position of the rule in one transaction', async () => {
  const s = setup({ api: accountRoute });
  for (const [id, holder, cfg] of [[V4_POS, TEST_ACCOUNT, ST_ON], [D, TEST_ACCOUNT, { ...ST_ON, lastRunAt: 9, budget: 255 }], [E, TEST_ACCOUNT, { ...ST_ON, lastRunAt: 5 }], [F, TEST_ACCOUNT, { ...ST_ON, triggerTicks: 150 }], [G, OTHER, ST_ON]] as const) {
    s.st.owner.set(`v4:${id}`, holder);
    s.st.steward.set(id, { ...cfg });
    s.st.stewardOwner.set(id, holder);
  }
  s.st.pieceDest.set(`v4:${V4_POS}`, D);
  const client = await connect(s.options);
  const plan = await call(client, 'goatlp_stop_automation', { venue: 'v4', id: String(V4_POS), kind: 'range' });
  assert.equal(plan.error, undefined, String(plan.error));
  assert.deepEqual(actions(plan), ['Clear the rule on every position of the move']);
  assert.deepEqual(plan.removes, [`the auto-range rule on all 3 positions of the rule (${V4_POS}, ${D}, ${E})`]);
  assert.ok((plan.notes as string[]).includes('This rule is moving in steps: the stop reaches the position the steps go to as well.'));
  assert.ok(!(plan.notes as string[]).some((n) => /Couldn't list/.test(n)), 'the list is complete');
  const done = await call(client, 'goatlp_stop_automation', { venue: 'v4', id: String(V4_POS), kind: 'range', execute: true, planId: plan.planId });
  assert.equal(done.error, undefined, String(done.error));
  assert.equal(s.signer.sent.length, 1);
  assert.equal(s.signer.sent[0].to, GOAT_V4_STEWARD);
  assert.deepEqual(fn(stewardAbi, s.signer.sent[0].data).args, [[V4_POS, D, E]]);
  for (const id of [V4_POS, D, E]) assert.equal(s.st.steward.get(id)?.mode, 0, String(id));
  assert.equal(s.st.steward.get(F)?.mode, 1, 'another rule in the same pool stays');
  await client.close();
});

test('open: the list is said to be incomplete when the wallet list cannot be read; a position of the rule that changed hands stops the batch', async () => {
  const s = setup();
  s.st.steward.set(V4_POS, { ...ST_ON }); s.st.stewardOwner.set(V4_POS, TEST_ACCOUNT);
  s.st.owner.set(`v4:${D}`, TEST_ACCOUNT); s.st.steward.set(D, { ...ST_ON }); s.st.stewardOwner.set(D, TEST_ACCOUNT);
  s.st.pieceDest.set(`v4:${V4_POS}`, D);
  const client = await connect(s.options);
  const plan = await call(client, 'goatlp_stop_automation', { venue: 'v4', id: String(V4_POS), kind: 'range' });
  assert.ok((plan.notes as string[]).some((n) => /^Couldn't list every position of this rule\./.test(n)), JSON.stringify(plan.notes));
  s.st.owner.set(`v4:${D}`, OTHER);
  const r = await call(client, 'goatlp_stop_automation', { venue: 'v4', id: String(V4_POS), kind: 'range', execute: true, planId: plan.planId });
  assert.ok(r.error, 'refused');
  assert.equal(s.signer.sent.length, 0);
  await client.close();
});

test('open: a v3 rule moving in pieces is stopped with configTokens; a v4 change goes to every position with setRangeConfigs', async () => {
  const s = setup();
  s.st.ar.set(V3_POS, [...AR_ON]); s.st.arOwner.set(V3_POS, TEST_ACCOUNT);
  s.st.owner.set(`v3:${D}`, TEST_ACCOUNT); s.st.ar.set(D, [...AR_ON]); s.st.arOwner.set(D, TEST_ACCOUNT);
  s.st.pieceDest.set(`v3:${V3_POS}`, D);
  s.st.steward.set(V4_POS, { ...ST_ON }); s.st.stewardOwner.set(V4_POS, TEST_ACCOUNT);
  s.st.owner.set(`v4:${E}`, TEST_ACCOUNT); s.st.steward.set(E, { ...ST_ON }); s.st.stewardOwner.set(E, TEST_ACCOUNT);
  s.st.pieceDest.set(`v4:${V4_POS}`, E);
  s.st.forAll.add(`v4:${TEST_ACCOUNT.toLowerCase()}:${(await import('./constants')).GOAT_V4_STEWARD_ENGINE.toLowerCase()}`);
  const client = await connect(s.options);
  const stop = await call(client, 'goatlp_stop_automation', { venue: 'v3', id: String(V3_POS), kind: 'range' });
  assert.deepEqual(actions(stop), ['Turn off auto-range on every position of the move']);
  await call(client, 'goatlp_stop_automation', { venue: 'v3', id: String(V3_POS), kind: 'range', execute: true, planId: stop.planId });
  const c = fn(autoRangeAbi, s.signer.sent[0].data);
  assert.equal(c.functionName, 'configTokens');
  assert.deepEqual(c.args.slice(0, 2), [[V3_POS, D], '0x0000000000000000000000000000000000000000']);
  const change = await call(client, 'goatlp_set_auto_range', { venue: 'v4', id: String(V4_POS), triggerTicks: 150 });
  assert.equal(change.error, undefined, String(change.error));
  assert.deepEqual(actions(change), ['Save changes']);
  await call(client, 'goatlp_set_auto_range', { venue: 'v4', id: String(V4_POS), triggerTicks: 150, execute: true, planId: change.planId });
  const p = fn(stewardAbi, s.signer.sent[1].data);
  assert.equal(p.functionName, 'setRangeConfigs');
  assert.deepEqual(p.args[0], [V4_POS, E]);
  assert.deepEqual({ ...(p.args[1] as Record<string, unknown>) }, { triggerTicks: 150, slippageBps: 25, minInterval: 21600, budget: 255, standing: true, maxSwapFeePips: 10000 });
  await client.close();
});

test('open: the decode check refuses a batch that names another position, and reads two rules alike only on the link fields', () => {
  const data = encodeFunctionData({ abi: stewardAbi as Abi, functionName: 'clearConfigs', args: [[P4.id, D, F]] });
  const c = { ...ctx('range', 'v4', { pool: pool4 }), intent: 'stop' as const, batchIds: [P4.id, D] };
  assert.equal((assertAutomationTx({ to: GOAT_V4_STEWARD, data, value: 0n, chainId: 4663 }, c) as { rule?: string }).rule, 'batch');
  const ok = encodeFunctionData({ abi: stewardAbi as Abi, functionName: 'clearConfigs', args: [[P4.id, D]] });
  assert.equal(assertAutomationTx({ to: GOAT_V4_STEWARD, data: ok, value: 0n, chainId: 4663 }, c).ok, true);
  const r = (cfg: Record<string, number>) => ({ kind: 'range' as const, venue: 'v4' as const, on: true, owner: TEST_ACCOUNT, cfg: cfg as never });
  assert.equal(sameRule('v4', r(ST_ON), r({ ...ST_ON, lastRunAt: 7, budget: 3 })), true);
  assert.equal(sameRule('v4', r(ST_ON), r({ ...ST_ON, slippageBps: 30 })), false);
});

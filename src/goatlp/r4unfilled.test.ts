// The build as published before the switch values are filled (no preload): every r4 value is a placeholder, so no rule is
// turned on and no placeholder address is read; the earlier contracts are read and their rules are stopped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData, type Abi, type Hex } from 'viem';
import { autoExitAbi, autoRangeAbi, gac3Abi, gac4Abi, npmAbi, posmAbi, stewardAbi } from './abis';
import { assertAutomationTx } from './guard';
import {
  AUTO_EXIT_V3_R3, AUTO_RANGE_OPEN, AUTO_RANGE_V3_R3, GOAT_AUTO_COMPOUND_V3_R3, GOAT_AUTO_COMPOUND_V4_R3, GOAT_PIN_KEYS, GOAT_V4_STEWARD_ENGINE_R3,
  GOAT_V4_STEWARD_R3, NPM, PINS, POSM, R3_PINS, R4_PENDING, R4_READY,
} from './constants';
import { R4_CLOSED, EARLIER_RULE } from './copy';
import { TARGETS_R3, loadEnv } from './facts';
import { permitWord } from './permits';
import { FakeChain, GATES_OK, P3, TEST_ACCOUNT, V3_POS, V4_POS, ctx } from './__fixtures__/kit';
import { actions, call, connect, fn, setup } from './__fixtures__/mcp';

const ZERO = '0x0000000000000000000000000000000000000000';
const ST_ON = { mode: 1, triggerTicks: 102, slippageBps: 25, minInterval: 21600, budget: 20, lastRunAt: 0, flags: 0, lowerTrigger: 0, upperTrigger: 0, pairEpoch: 1, maxSwapFeePips: 10000 };
const enc = (abi: readonly unknown[], functionName: string, args: readonly unknown[]) => encodeFunctionData({ abi: abi as Abi, functionName, args: args as unknown[] });

test('unfilled: every r4 value is a placeholder, turn-ons are closed, the earlier pins are the 0.4.0 ones', () => {
  assert.equal(R4_READY, false);
  assert.deepEqual([...R4_PENDING], [...GOAT_PIN_KEYS]);
  assert.equal(AUTO_RANGE_OPEN, false);
  for (const k of GOAT_PIN_KEYS) assert.equal(PINS[k].address, ZERO, k);
  assert.equal(R3_PINS.rangeExitV4.address, '0xBb6494D891bd9cCCf11ADd32FD61Afe246164b3d');
  assert.equal(R3_PINS.engine.codehash, '0xc662bd8f36221591573e4e61a709795292c59dc2bb62a25e948a1aee7a3fd57d');
});

test('unfilled: the r4 gates are closed with one plain line, no placeholder is read, the earlier gates are open', async () => {
  const chain = new FakeChain();
  const env = await loadEnv(chain);
  for (const g of Object.values(env.gates)) assert.deepEqual(g, { ok: false, reason: R4_CLOSED });
  for (const g of Object.values(env.earlier.gates)) assert.equal(g.ok, true, g.reason);
  assert.equal(env.earlier.spenders.rangeExitV4, GOAT_V4_STEWARD_ENGINE_R3);
  assert.deepEqual(env.contracts.spenders, {});
  assert.ok(!chain.reads.some((r) => r.startsWith(ZERO)), 'no read at a placeholder address');
});

test('unfilled: every turn-on is refused with the plain line and sends nothing', async () => {
  const s = setup();
  const client = await connect(s.options);
  const tries: [string, Record<string, unknown>][] = [
    ['goatlp_set_auto_compound', { venue: 'v3', id: String(V3_POS) }], ['goatlp_set_auto_compound', { venue: 'v4', id: String(V4_POS) }],
    ['goatlp_set_auto_exit', { venue: 'v3', id: String(V3_POS), lower: {} }], ['goatlp_set_auto_exit', { venue: 'v4', id: String(V4_POS), lower: {} }],
    ['goatlp_set_auto_range', { venue: 'v3', id: String(V3_POS) }], ['goatlp_set_auto_range', { venue: 'v4', id: String(V4_POS) }],
  ];
  for (const [tool, args] of tries) assert.ok(String((await call(client, tool, args)).error).includes(R4_CLOSED), `${tool} ${args.venue}`);
  assert.equal(s.signer.sent.length, 0);
  await client.close();
});

test('unfilled: goatlp_position shows a rule of the earlier contracts with its plain line', async () => {
  const s = setup();
  s.st.old.steward.set(V4_POS, ST_ON);
  s.st.old.stewardOwner.set(V4_POS, TEST_ACCOUNT);
  s.st.approved.set(`v4:${V4_POS}`, GOAT_V4_STEWARD_ENGINE_R3);
  const client = await connect(s.options);
  const r = await call(client, 'goatlp_position', { venue: 'v4', id: String(V4_POS) });
  const chain = r.chain as Record<string, Record<string, Record<string, unknown>>>;
  assert.equal(chain.earlierRules.autoRange.note, EARLIER_RULE);
  assert.equal(chain.earlierRules.autoRange.on, false);
  assert.equal(String(chain.rules.autoRange), `not checked: ${R4_CLOSED}`);
  assert.match(String(chain.permission.holder), /earlier contracts, no longer runs/);
  await client.close();
});

test('unfilled: a v4 auto-range rule on the earlier Steward is stopped there, with its permission', async () => {
  const s = setup();
  s.st.old.steward.set(V4_POS, ST_ON);
  s.st.old.stewardOwner.set(V4_POS, TEST_ACCOUNT);
  s.st.approved.set(`v4:${V4_POS}`, GOAT_V4_STEWARD_ENGINE_R3);
  const client = await connect(s.options);
  const plan = await call(client, 'goatlp_stop_automation', { venue: 'v4', id: String(V4_POS), kind: 'range' });
  assert.deepEqual(actions(plan), ['Clear the rule', 'Remove the permission']);
  const done = await call(client, 'goatlp_stop_automation', { venue: 'v4', id: String(V4_POS), kind: 'range', execute: true, planId: plan.planId });
  assert.equal(done.error, undefined, String(done.error));
  assert.equal(s.signer.sent[0].to, GOAT_V4_STEWARD_R3);
  assert.equal(fn(stewardAbi, s.signer.sent[0].data).functionName, 'clearConfig');
  assert.equal(s.signer.sent[1].to, POSM);
  assert.deepEqual(done.now, { ruleOn: 'not checked', earlierRuleOn: false, permission: 'none' });
  await client.close();
});

test('unfilled: a v3 auto-range rule on the earlier AutoRange is stopped, and its permission for all positions removed', async () => {
  const s = setup();
  s.st.old.ar.set(V3_POS, [102, 102, -120, 120, 1n << 56n, 1n << 56n, false, false, 27670116110564327n]);
  s.st.old.arOwner.set(V3_POS, TEST_ACCOUNT);
  s.st.forAll.add(`v3:${TEST_ACCOUNT.toLowerCase()}:${AUTO_RANGE_V3_R3.toLowerCase()}`);
  const client = await connect(s.options);
  const plan = await call(client, 'goatlp_stop_automation', { venue: 'v3', id: String(V3_POS), kind: 'range' });
  assert.deepEqual(actions(plan), ['Turn off auto-range', 'Remove the permission for all positions']);
  await call(client, 'goatlp_stop_automation', { venue: 'v3', id: String(V3_POS), kind: 'range', execute: true, planId: plan.planId });
  assert.equal(s.signer.sent[0].to, AUTO_RANGE_V3_R3);
  assert.deepEqual(fn(autoRangeAbi, s.signer.sent[0].data).args.slice(0, 2), [V3_POS, ZERO]);
  assert.equal(s.signer.sent[1].to, NPM);
  assert.deepEqual(fn(npmAbi, s.signer.sent[1].data).args, [AUTO_RANGE_V3_R3, false]);
  assert.equal(s.st.forAll.size, 0);
  await client.close();
});

test('unfilled: v4 auto-compound on the earlier contract: rule off and its unused messages cancelled; v3 auto-exit off; nothing left is said plainly', async () => {
  const s = setup();
  s.st.old.gac4.set(V4_POS, [true, false, false, 100, 86400, 0, 0n]);
  s.st.old.gac4Owner.set(V4_POS, TEST_ACCOUNT);
  const word = permitWord(GOAT_AUTO_COMPOUND_V4_R3, V4_POS);
  s.st.nonces.set(`${TEST_ACCOUNT.toLowerCase()}:${word}`, 0b1n);
  s.st.old.ae.set(V3_POS, [true, false, false, -221800, 887273, 1n << 56n, 1n << 56n, false, 27670116110564327n]);
  s.st.old.aeOwner.set(V3_POS, TEST_ACCOUNT);
  const client = await connect(s.options);
  const p = await call(client, 'goatlp_stop_automation', { venue: 'v4', id: String(V4_POS), kind: 'compound' });
  assert.deepEqual(actions(p), ['Turn off auto-compound', 'Cancel the signed messages']);
  await call(client, 'goatlp_stop_automation', { venue: 'v4', id: String(V4_POS), kind: 'compound', execute: true, planId: p.planId });
  assert.equal(s.signer.sent[0].to, GOAT_AUTO_COMPOUND_V4_R3);
  assert.equal((fn(gac4Abi, s.signer.sent[0].data).args[1] as { enabled: boolean }).enabled, false);
  const revoked = (fn(posmAbi, s.signer.sent[1].data).args[0] as Hex[]).map((d) => fn(posmAbi, d).args[0] as bigint);
  assert.ok(revoked.length > 0 && revoked.every((n) => n >> 8n >= word), 'in the earlier contract\'s nonce window');
  const e = await call(client, 'goatlp_stop_automation', { venue: 'v3', id: String(V3_POS), kind: 'exit' });
  assert.deepEqual(actions(e), ['Turn off auto-exit']);
  await call(client, 'goatlp_stop_automation', { venue: 'v3', id: String(V3_POS), kind: 'exit', execute: true, planId: e.planId });
  assert.equal(s.signer.sent[2].to, AUTO_EXIT_V3_R3);
  assert.equal((fn(autoExitAbi, s.signer.sent[2].data).args[1] as { isActive: boolean }).isActive, false);
  assert.match(String((await call(client, 'goatlp_stop_automation', { venue: 'v3', id: String(V3_POS), kind: 'compound' })).error), /nothing to stop/);
  await client.close();
});

test('unfilled: the decode check never lets the earlier contracts take a rule or a permission', () => {
  const R3_SPENDERS = { autoCompoundV3: GOAT_AUTO_COMPOUND_V3_R3, autoCompoundV4: GOAT_AUTO_COMPOUND_V4_R3, rangeExitV3: AUTO_RANGE_V3_R3, exitV3: AUTO_EXIT_V3_R3, rangeExitV4: GOAT_V4_STEWARD_ENGINE_R3 };
  const earlier = { targets: TARGETS_R3, gates: GATES_OK, spenders: R3_SPENDERS };
  const c = ctx('compound', 'v3', { gen: 'r3', earlier, spenders: R3_SPENDERS, gates: { ...GATES_OK, autoCompoundV3: { ok: false, reason: R4_CLOSED } } });
  const on = enc(gac3Abi, 'configToken', [P3.id, { enabled: true, swapEnabled: true, maxSlippageBps: 100, minInterval: 3600, lastRunAt: 0, minReward0: 0n, minReward1: 0n }]);
  const off = enc(gac3Abi, 'configToken', [P3.id, { enabled: false, swapEnabled: false, maxSlippageBps: 0, minInterval: 0, lastRunAt: 0, minReward0: 0n, minReward1: 0n }]);
  const run = (to: `0x${string}`, data: Hex, x = c) => assertAutomationTx({ to, data, value: 0n, chainId: 4663 }, x);
  assert.deepEqual(run(GOAT_AUTO_COMPOUND_V3_R3, on), { ok: false, rule: 'target', reason: 'the earlier contracts take no new rules' });
  assert.equal(run(GOAT_AUTO_COMPOUND_V3_R3, off).ok, true);
  assert.equal((run(GOAT_AUTO_COMPOUND_V3_R3, off, { ...c, gen: 'r4' }) as { rule?: string }).rule, 'pinned-code', 'a turn-on plan of r4 is closed');
  const grant = enc(npmAbi, 'approve', [GOAT_AUTO_COMPOUND_V3_R3, P3.id]);
  assert.equal((run(NPM, grant, { ...c, intent: 'allow' }) as { rule?: string }).rule, 'permission');
});

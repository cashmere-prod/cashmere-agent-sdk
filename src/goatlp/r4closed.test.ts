// A filled build with the auto-range review switch off (preload ./__fixtures__/r4-filled.ts): auto-exit and auto-compound are
// turned on on the r4 contracts, auto-range says why it is not offered and changes nothing, and stops reach both generations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gac3Abi, posmAbi, stewardAbi } from './abis';
import {
  AUTO_RANGE_OPEN, AUTO_RANGE_V3, GOAT_AUTO_COMPOUND_V3, GOAT_AUTO_COMPOUND_V3_R3, GOAT_V4_STEWARD, GOAT_V4_STEWARD_ENGINE, GOAT_V4_STEWARD_R3, NPM, POSM, R4_LABEL, R4_READY,
} from './constants';
import { EARLIER_RULE, RANGE_PORT_CLOSED } from './copy';
import { TEST_ACCOUNT, V3_POS, V4_POS } from './__fixtures__/kit';
import { actions, call, connect, fn, setup } from './__fixtures__/mcp';

const ST_ON = { mode: 1, triggerTicks: 102, slippageBps: 25, minInterval: 21600, budget: 20, lastRunAt: 0, flags: 0, lowerTrigger: 0, upperTrigger: 0, pairEpoch: 1, maxSwapFeePips: 10000 };

test('filled, review off: the build is ready and auto-range is closed', () => {
  assert.equal(R4_READY, true);
  assert.equal(R4_LABEL, 'r4-test');
  assert.equal(AUTO_RANGE_OPEN, false);
});

test('filled, review off: auto-range turn-on on both venues says why and sends nothing', async () => {
  const s = setup();
  const client = await connect(s.options);
  for (const venue of ['v3', 'v4']) {
    const r = await call(client, 'goatlp_set_auto_range', { venue, id: String(venue === 'v4' ? V4_POS : V3_POS) });
    assert.ok(String(r.error).includes(RANGE_PORT_CLOSED), venue);
  }
  // the permission for all positions already on (no allow step): still refused, by the plan and by the decode check
  s.st.forAll.add(`v4:${TEST_ACCOUNT.toLowerCase()}:${GOAT_V4_STEWARD_ENGINE.toLowerCase()}`);
  s.st.forAll.add(`v3:${TEST_ACCOUNT.toLowerCase()}:${AUTO_RANGE_V3.toLowerCase()}`);
  for (const venue of ['v3', 'v4']) {
    const r = await call(client, 'goatlp_set_auto_range', { venue, id: String(venue === 'v4' ? V4_POS : V3_POS) });
    assert.ok(String(r.error).includes(RANGE_PORT_CLOSED), `${venue}, permission on`);
  }
  assert.equal(s.signer.sent.length, 0);
  await client.close();
});

test('filled, review off: goatlp_position does not offer auto-range and gives its one plain reason; auto-exit is offered', async () => {
  const s = setup();
  const client = await connect(s.options);
  const r = await call(client, 'goatlp_position', { venue: 'v4', id: String(V4_POS) });
  const can = (r.chain as { canTurnOn: Record<string, { offered: boolean; why?: string }> }).canTurnOn;
  assert.equal(can.autoRange.offered, false);
  assert.ok(String(can.autoRange.why).includes(RANGE_PORT_CLOSED), String(can.autoRange.why));
  assert.equal(can.autoExit.offered, true, JSON.stringify(can.autoExit));
  await client.close();
});

test('filled, review off: v4 auto-exit is turned on on the r4 Steward with a one-position permission', async () => {
  const s = setup();
  const client = await connect(s.options);
  const args = { venue: 'v4', id: String(V4_POS), lower: {} };
  const plan = await call(client, 'goatlp_set_auto_exit', args);
  assert.equal(plan.error, undefined, String(plan.error));
  assert.deepEqual(actions(plan), ['Allow this position', 'Turn on']);
  await call(client, 'goatlp_set_auto_exit', { ...args, execute: true, planId: plan.planId });
  assert.deepEqual(s.signer.sent.map((t) => t.to), [POSM, GOAT_V4_STEWARD]);
  assert.deepEqual(fn(posmAbi, s.signer.sent[0].data).args, [GOAT_V4_STEWARD_ENGINE, V4_POS]);
  assert.equal(fn(stewardAbi, s.signer.sent[1].data).functionName, 'setExitConfig');
  await client.close();
});

test('filled, review off: v3 auto-compound goes to the r4 contract; an earlier rule of the same kind is named in one line', async () => {
  const s = setup();
  s.st.old.gac3.set(V3_POS, [true, true, 100, 3600, 0, 0n, 0n]);
  s.st.old.gac3Owner.set(V3_POS, TEST_ACCOUNT);
  const client = await connect(s.options);
  const plan = await call(client, 'goatlp_set_auto_compound', { venue: 'v3', id: String(V3_POS) });
  assert.equal(plan.error, undefined, String(plan.error));
  assert.ok((plan.notes as string[]).includes(`Auto-compound: ${EARLIER_RULE}`), JSON.stringify(plan.notes));
  await call(client, 'goatlp_set_auto_compound', { venue: 'v3', id: String(V3_POS), execute: true, planId: plan.planId });
  assert.deepEqual(s.signer.sent.map((t) => t.to), [NPM, GOAT_AUTO_COMPOUND_V3]);
  assert.equal((fn(gac3Abi, s.signer.sent[1].data).args[1] as { enabled: boolean }).enabled, true);
  assert.ok(s.signer.sent.every((t) => t.to !== GOAT_AUTO_COMPOUND_V3_R3), 'nothing is turned on at the earlier contract');
  await client.close();
});

test('filled, review off: a stop reaches the rule on r4 and on the earlier Steward, r4 first', async () => {
  const s = setup();
  s.st.steward.set(V4_POS, { ...ST_ON, budget: 255 });
  s.st.stewardOwner.set(V4_POS, TEST_ACCOUNT);
  s.st.old.steward.set(V4_POS, ST_ON);
  s.st.old.stewardOwner.set(V4_POS, TEST_ACCOUNT);
  const client = await connect(s.options);
  const plan = await call(client, 'goatlp_stop_automation', { venue: 'v4', id: String(V4_POS), kind: 'range' });
  assert.equal(plan.error, undefined, String(plan.error));
  assert.deepEqual(actions(plan), ['Clear the rule', 'Clear the rule']);
  assert.deepEqual(plan.removes, ['the auto-range rule', 'the auto-range rule (earlier contracts)']);
  const done = await call(client, 'goatlp_stop_automation', { venue: 'v4', id: String(V4_POS), kind: 'range', execute: true, planId: plan.planId });
  assert.equal(done.error, undefined, String(done.error));
  assert.deepEqual(s.signer.sent.map((t) => t.to), [GOAT_V4_STEWARD, GOAT_V4_STEWARD_R3]);
  assert.deepEqual(done.now, { ruleOn: false, earlierRuleOn: false, permission: 'none' });
  await client.close();
});

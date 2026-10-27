// The automation write tools through the MCP server, on the fake chain (transactions play onto it) with a recording signer
// and the API fixtures: the plan / execute flow, every refusal of the spec's guards, the v4 signed-message session and
// its hand-over to the keeper store, the stop plans, and the shared write queue. No network, no real key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  custom, decodeFunctionData, encodeErrorResult, parseTransaction, recoverTransactionAddress, recoverTypedDataAddress, toFunctionSelector,
  type Abi, type Address, type Hex,
} from 'viem';
import { isNotBroadcast, viemSigner } from './chain';
import { createCashmereMcpServer, type CashmereMcpServerOptions } from '../mcp/server';
import { GoatApi } from './api';
import { autoExitAbi, gac3Abi, gac4Abi, npmAbi, posmAbi, stewardAbi } from './abis';
import {
  AUTO_EXIT_V3, GOAT_AUTO_COMPOUND_V3, GOAT_AUTO_COMPOUND_V4, GOAT_V4_PAIR_REGISTRY, GOAT_V4_STEWARD, GOAT_V4_STEWARD_ENGINE, NPM, POSM,
} from './constants';
import { nonceOf, permitWord } from './permits';
import {
  FOREIGN_APP, NOW_SEC, OTHER, TEST_ACCOUNT, TEST_KEY, V3_POS, V4_POS, apiWorld, writeWorld, type FakeAnswer,
} from './__fixtures__/kit';

const ZERO = '0x0000000000000000000000000000000000000000';

function setup(o: { v4Range?: [number, number]; api?: Record<string, FakeAnswer | ((init: { method: string; headers: Record<string, string>; body?: string }) => FakeAnswer)>; options?: Partial<CashmereMcpServerOptions> } = {}) {
  const w = writeWorld({ v4Range: o.v4Range ?? [-199200, -198600] });
  const api = apiWorld({ 'POST /automation/permits': { status: 200, body: { ok: true } }, [`DELETE /automation/permits/${V4_POS}`]: { status: 200, body: { deleted: true } }, ...o.api });
  let clock = NOW_SEC * 1000;
  const goatApi = new GoatApi({ fetch: api.fetch, now: () => clock, sleep: async () => {} });
  const options: CashmereMcpServerOptions = {
    config: { evm: { privateKey: TEST_KEY } },
    goatlp: { deps: { api: goatApi, chain: w.chain, signer: w.signer, now: () => clock } },
    ...o.options,
  };
  return { ...w, api, options, tick: (ms: number) => { clock += ms; } };
}

async function connect(options: CashmereMcpServerOptions): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createCashmereMcpServer(options).connect(serverTransport);
  const client = new Client({ name: 'goatlp-write-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

async function call(c: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await c.callTool({ name, arguments: args });
  const [content] = r.content as { type: string; text: string }[];
  if (r.isError) return { error: content.text };
  return JSON.parse(content.text) as Record<string, unknown>;
}

const fn = (abi: readonly unknown[], data: Hex) => (decodeFunctionData({ abi: abi as Abi, data }) as { functionName: string; args: readonly unknown[] });
const NEVER = ['setApprovalForAll(address,bool)', 'permitForAll(address,address,bool,uint256,uint256,bytes)', 'transferFrom(address,address,uint256)',
  'safeTransferFrom(address,address,uint256)', 'safeTransferFrom(address,address,uint256,bytes)'].map((s) => toFunctionSelector(`function ${s}`));

test('the write tools are listed only with an EVM key outside read-only mode, destructive and asking for the user', async () => {
  const s = setup();
  const client = await connect(s.options);
  const { tools } = await client.listTools();
  for (const name of ['goatlp_add_liquidity', 'goatlp_set_auto_range', 'goatlp_set_auto_exit', 'goatlp_set_auto_compound', 'goatlp_stop_automation']) {
    const t = tools.find((x) => x.name === name)!;
    assert.ok(t, name);
    assert.equal(t.annotations?.readOnlyHint, false);
    assert.equal(t.annotations?.destructiveHint, true);
    assert.equal(t._meta?.['anthropic/requiresUserInteraction'], true);
    assert.match(t.description!, /without execute it returns a plan .* and sends nothing\. Show the plan to the user/);
    assert.ok(!/\b(safe|safety|verified|audit|earn)/i.test(t.description!), `${name} copy`);
  }
  assert.match(client.getInstructions()!, /Never execute a plan the user has not seen/);
  await client.close();
  for (const options of [{ ...s.options, readOnly: true }, { ...s.options, config: { sui: { privateKey: TEST_KEY } } }]) {
    const c = await connect(options);
    const names = (await c.listTools()).tools.map((t) => t.name);
    assert.ok(!names.some((n) => n.startsWith('goatlp_set') || n === 'goatlp_stop_automation' || n === 'goatlp_add_liquidity'), JSON.stringify(names));
    assert.match(c.getInstructions()!, /Goat LP write tools are off because/);
    await c.close();
  }
});

test('v4 auto-range: the plan sends nothing; execute with its planId sends exactly the planned transactions, once', async () => {
  const s = setup();
  const client = await connect(s.options);
  const args = { venue: 'v4', id: String(V4_POS) };
  const plan = await call(client, 'goatlp_set_auto_range', args);
  assert.equal(plan.error, undefined, String(plan.error));
  assert.match(String(plan.planId), /^[0-9a-f]{24}$/);
  assert.equal(s.signer.sent.length, 0, 'a plan sends nothing');
  const steps = plan.steps as Record<string, unknown>[];
  assert.deepEqual(steps.map((x) => x.action), ['Allow this position', 'Turn on']);
  assert.equal(steps[0].contract, 'Uniswap v4 PositionManager');
  assert.match(String(steps[0].call), /^approve\("GoatV4StewardEngine 0xD12D46c9d3B1FE463895A20daD19F3cae5584892", "4006316"\)$/);
  assert.equal(steps[1].contract, 'GoatV4Steward');
  assert.match(String(steps[0].simulation), /^ok/);
  const rule = plan.rule as Record<string, unknown>;
  assert.equal(rule.movesAllowed, 20);
  assert.equal(rule.maxPriceProtection, '0.25%', "the pool's hook entry caps price protection at 0.40%: the app's default under it");
  assert.equal(rule.atMostOneMoveEvery, '6 hours');
  assert.match(String(plan.fee), /^0\.15% of the amount moved, per move\.$/);
  assert.equal(plan.warning, 'Goat LP is experimental. Use small amounts.');

  const done = await call(client, 'goatlp_set_auto_range', { ...args, execute: true, planId: plan.planId });
  assert.equal(done.error, undefined, String(done.error));
  assert.equal(done.executed, true);
  assert.equal(s.signer.sent.length, 2);
  const [a, b] = s.signer.sent;
  assert.equal(a.to, POSM);
  assert.deepEqual(fn(posmAbi, a.data).args, [GOAT_V4_STEWARD_ENGINE, V4_POS]);
  assert.equal(b.to, GOAT_V4_STEWARD);
  const p = fn(stewardAbi, b.data);
  assert.equal(p.functionName, 'setRangeConfig');
  assert.deepEqual(p.args[1], { triggerTicks: 102, slippageBps: 25, minInterval: 21600, budget: 20, standing: false, maxSwapFeePips: 10000 });
  assert.ok(s.signer.sent.every((t) => t.value === 0n));
  assert.equal(((done.now as Record<string, Record<string, unknown>>).rule).on, true);
  assert.ok((done.steps as { txHash?: string; explorer?: string }[]).every((x) => x.txHash && x.explorer?.startsWith('https://robin.etherscan.io/tx/')));
  // every transaction was simulated from the wallet right before it was sent
  assert.ok(s.chain.simulated.filter((x) => x.from === TEST_ACCOUNT).length >= 4);

  const again = await call(client, 'goatlp_set_auto_range', { ...args, execute: true, planId: plan.planId });
  assert.match(String(again.error), /already executed/);
  assert.equal(s.signer.sent.length, 2);
  await client.close();
});

test('execute needs the planId of a plan made with the same inputs, within 10 minutes, and the same plan on fresh reads', async () => {
  const s = setup();
  const client = await connect(s.options);
  const args = { venue: 'v4', id: String(V4_POS) };
  assert.match(String((await call(client, 'goatlp_set_auto_range', { ...args, execute: true })).error), /needs the planId/);
  const plan = await call(client, 'goatlp_set_auto_range', args);
  assert.match(String((await call(client, 'goatlp_set_auto_range', { ...args, triggerTicks: 150, execute: true, planId: plan.planId })).error), /inputs differ/);
  assert.match(String((await call(client, 'goatlp_set_auto_exit', { ...args, lower: {}, execute: true, planId: plan.planId })).error), /belongs to goatlp_set_auto_range/);
  assert.match(String((await call(client, 'goatlp_set_auto_range', { ...args, execute: true, planId: 'a'.repeat(24) })).error), /unknown or expired/);
  const p2 = await call(client, 'goatlp_set_auto_range', args);
  s.tick(10 * 60 * 1000 + 1);
  assert.match(String((await call(client, 'goatlp_set_auto_range', { ...args, execute: true, planId: p2.planId })).error), /expired/);
  // the chain changed between the plan and the execute: the plan is not the same any more
  const p3 = await call(client, 'goatlp_set_auto_range', args);
  s.st.approved.set(`v4:${V4_POS}`, GOAT_V4_STEWARD_ENGINE);
  assert.match(String((await call(client, 'goatlp_set_auto_range', { ...args, execute: true, planId: p3.planId })).error), /no longer the same/);
  assert.equal(s.signer.sent.length, 0);
  await client.close();
});

test('guards: chain id, pinned code (before the plan and right before sending), the pinned engine address', async () => {
  const args = { venue: 'v4', id: String(V4_POS) };
  const s = setup();
  s.chain.id = 1;
  let client = await connect(s.options);
  assert.match(String((await call(client, 'goatlp_set_auto_range', args)).error), /not Robinhood Chain \(4663\)/);
  await client.close();

  const s2 = setup();
  s2.chain.codeHashes.set(GOAT_V4_STEWARD.toLowerCase(), `0x${'12'.repeat(32)}` as Hex);
  client = await connect(s2.options);
  assert.match(String((await call(client, 'goatlp_set_auto_range', args)).error), /GoatV4Steward at 0xBb64.* does not match the build pinned in this package/);
  await client.close();

  const s3 = setup();
  s3.chain.on(GOAT_V4_STEWARD, 'ENGINE', OTHER);
  client = await connect(s3.options);
  assert.match(String((await call(client, 'goatlp_set_auto_range', args)).error), /names an unexpected engine address/);
  await client.close();

  // the engine's code changes after the plan was shown: the rebuild refuses before anything is signed
  const s4 = setup();
  client = await connect(s4.options);
  const plan = await call(client, 'goatlp_set_auto_range', args);
  s4.chain.codeHashes.set(GOAT_V4_STEWARD_ENGINE.toLowerCase(), `0x${'34'.repeat(32)}` as Hex);
  assert.match(String((await call(client, 'goatlp_set_auto_range', { ...args, execute: true, planId: plan.planId })).error), /GoatV4StewardEngine .*does not match/);
  assert.equal(s4.signer.sent.length, 0);
  await client.close();
});

test('guards: a simulation revert refuses the plan; one right before a later step stops there and says what was done', async () => {
  const args = { venue: 'v4', id: String(V4_POS) };
  const s = setup();
  s.chain.simulate = () => { throw Object.assign(new Error('execution reverted'), { data: encodeErrorResult({ abi: stewardAbi as Abi, errorName: 'PoolNotAllowed' }) }); };
  let client = await connect(s.options);
  assert.match(String((await call(client, 'goatlp_set_auto_range', args)).error), /step 1 \(Allow this position\) would revert: Automation is not offered for this pool\. \(PoolNotAllowed\)/);
  await client.close();

  const s2 = setup();
  client = await connect(s2.options);
  const plan = await call(client, 'goatlp_set_auto_range', args);
  s2.chain.simulate = (tx) => { if (tx.to === GOAT_V4_STEWARD) throw Object.assign(new Error('execution reverted'), { data: encodeErrorResult({ abi: stewardAbi as Abi, errorName: 'ModePaused' }) }); return '0x'; };
  const r = await call(client, 'goatlp_set_auto_range', { ...args, execute: true, planId: plan.planId });
  assert.match(String(r.error), /^Not sent: step 2 \(Turn on\) would revert: Paused for everyone right now\..* Done before it: step 1 \(Allow this position\) 0x[0-9a-f]{64}\./);
  assert.equal(s2.signer.sent.length, 1);
  await client.close();
});

test('guards: the signer must own the position; another app\'s approval is never replaced; one automation per position (v3: one approved address)', async () => {
  const s = setup();
  s.st.owner.set(`v4:${V4_POS}`, OTHER);
  s.st.approved.set(`v3:${V3_POS}`, FOREIGN_APP);
  const client = await connect(s.options);
  assert.match(String((await call(client, 'goatlp_set_auto_range', { venue: 'v4', id: String(V4_POS) })).error), /does not own this position on chain\. It belongs to 0x0{38}aa/);
  assert.match(String((await call(client, 'goatlp_set_auto_exit', { venue: 'v3', id: String(V3_POS), lower: {} })).error), /another app \(0x0{38}bb\) is allowed to manage this position\. .* never changes another app's approval/);
  s.st.approved.delete(`v3:${V3_POS}`);
  // auto-compound on the v3 position: auto-exit can't take its one approved address
  s.st.gac3.set(V3_POS, [true, true, 100, 3600, 0, 0n, 0n]);
  s.st.gac3Owner.set(V3_POS, TEST_ACCOUNT);
  s.st.approved.set(`v3:${V3_POS}`, GOAT_AUTO_COMPOUND_V3);
  const second = await call(client, 'goatlp_set_auto_exit', { venue: 'v3', id: String(V3_POS), lower: {} });
  assert.match(String(second.error), /Auto-exit is not offered for this position: Both use this position's own permission, and a v3 position has one\./);
  assert.equal(s.signer.sent.length, 0);
  await client.close();
});

test('guards: pools and hooks only from the registry and the reviewed-hook pins, with the app\'s reason', async () => {
  const s = setup();
  s.chain.on(GOAT_V4_PAIR_REGISTRY, 'hookEntry', { codehash: `0x${'00'.repeat(32)}`, pinnedFee: 0, maxSlippageBps: 0, kind: 0, requiredBits: 0 });
  let client = await connect(s.options);
  assert.match(String((await call(client, 'goatlp_set_auto_range', { venue: 'v4', id: String(V4_POS) })).error), /Auto-range is not offered for this position: Automation is not offered for this pool\./);
  await client.close();
  const s2 = setup();
  s2.chain.codeHashes.set('0x06a889870c8f83640d6816319f72e2aa579b6080', `0x${'56'.repeat(32)}` as Hex);
  client = await connect(s2.options);
  assert.match(String((await call(client, 'goatlp_set_auto_exit', { venue: 'v4', id: String(V4_POS), upper: {} })).error), /Hook not reviewed\./);
  assert.match(String((await call(client, 'goatlp_set_auto_compound', { venue: 'v4', id: String(V4_POS) })).error), /Hook not reviewed\./);
  await client.close();
  const s3 = setup();
  s3.chain.on(GOAT_V4_PAIR_REGISTRY, 'entryOf', () => { throw new Error('reverted: PoolNotAllowed()'); });
  client = await connect(s3.options);
  assert.match(String((await call(client, 'goatlp_set_auto_range', { venue: 'v4', id: String(V4_POS) })).error), /no reliable price reference/);
  await client.close();
});

test('values are checked against the contracts\' bounds, never clamped', async () => {
  const s = setup();
  const client = await connect(s.options);
  const id = String(V4_POS);
  assert.match(String((await call(client, 'goatlp_set_auto_range', { venue: 'v4', id, triggerTicks: 101 })).error), /Set the trigger at least 1\.03% past the range/);
  assert.match(String((await call(client, 'goatlp_set_auto_range', { venue: 'v4', id, maxPriceProtectionBps: 50 })).error), /Price protection must be between 0\.10% and 0\.40%/);
  assert.match(String((await call(client, 'goatlp_set_auto_exit', { venue: 'v4', id, lower: { tick: -199250 } })).error), /Set the lower exit at least 1\.03% below the range/);
  assert.match(String((await call(client, 'goatlp_set_auto_exit', { venue: 'v4', id })).error), /Turn on at least one exit side/);
  const r = await client.callTool({ name: 'goatlp_set_auto_compound', arguments: { venue: 'v4', id, runsToSign: 31 } });
  assert.equal(r.isError, true, '31 signed messages are refused by the schema');
  const h = await client.callTool({ name: 'goatlp_set_auto_compound', arguments: { venue: 'v4', id, horizonDays: 91 } });
  assert.equal(h.isError, true, 'more than 90 days is refused by the schema');
  assert.match(String((await call(client, 'goatlp_set_auto_compound', { venue: 'v4', id, signMore: true })).error), /not on for this position/);
  assert.equal(s.signer.sent.length, 0);
  await client.close();
});

test('v4 auto-compound: one signing session of N Permit messages, checked and signed, then the rule, then the hand-over to the keeper store', async () => {
  const s = setup();
  const client = await connect(s.options);
  const args = { venue: 'v4', id: String(V4_POS) };
  const plan = await call(client, 'goatlp_set_auto_compound', args);
  assert.equal(plan.error, undefined, String(plan.error));
  const steps = plan.steps as Record<string, unknown>[];
  assert.deepEqual(steps.map((x) => x.type), ['signatures', 'transaction', 'hand-over']);
  const word = permitWord(GOAT_AUTO_COMPOUND_V4, V4_POS);
  assert.equal(steps[0].count, 12);
  assert.equal(steps[0].nonceWord, word.toString());
  assert.equal(steps[0].validUntil, new Date((NOW_SEC + 30 * 86_400) * 1000).toISOString());
  assert.match(String(plan.fee), /^10% of the fees it adds back \(or sends to the wallet\)\. Cashmere pays the gas\.$/);
  assert.equal((plan.rule as Record<string, unknown>).atMostOnceEvery, '1 day', '30 days over 12 runs, rounded down to a preset');
  assert.equal(s.signer.signed.length, 0, 'the plan signs nothing');

  const done = await call(client, 'goatlp_set_auto_compound', { ...args, execute: true, planId: plan.planId });
  assert.equal(done.error, undefined, String(done.error));
  assert.equal(s.signer.signed.length, 12);
  for (const [i, td] of s.signer.signed.entries()) {
    assert.deepEqual(td.domain, { name: 'Uniswap v4 Positions NFT', chainId: 4663, verifyingContract: POSM });
    assert.equal(td.primaryType, 'Permit');
    assert.deepEqual(td.message, { spender: GOAT_AUTO_COMPOUND_V4, tokenId: V4_POS, nonce: nonceOf(word, i), deadline: BigInt(NOW_SEC + 30 * 86_400) });
  }
  assert.equal(s.signer.sent.length, 1);
  const c = fn(gac4Abi, s.signer.sent[0].data);
  assert.equal(s.signer.sent[0].to, GOAT_AUTO_COMPOUND_V4);
  assert.deepEqual(c.args[1], { enabled: true, claimOnly: false, allowStandingApproval: false, maxSlippageBps: 110, minInterval: 86400, lastRunAt: 0, minLiquidityDelta: 0n },
    "with no input, the price protection the pool's hook needs (its 0.60% fee + 0.5%) instead of the 1% default");
  const posts = s.api.requests.filter((r) => r.method === 'POST');
  assert.equal(posts.length, 1, 'one POST per session');
  assert.equal(posts[0].url, 'https://api.cashmere.exchange/automation/permits');
  const body = JSON.parse(posts[0].body!) as { owner: string; tokenId: string; word: string; bits: number[]; deadline: string; signatures: { nonce: string; signature: Hex }[] };
  assert.equal(body.owner, TEST_ACCOUNT);
  assert.equal(body.tokenId, String(V4_POS));
  assert.equal(body.word, word.toString());
  assert.deepEqual(body.bits, [...Array(12).keys()]);
  assert.equal(body.deadline, String(NOW_SEC + 30 * 86_400));
  const signer = await recoverTypedDataAddress({ ...s.signer.signed[3], signature: body.signatures[3].signature } as never);
  assert.equal(signer, TEST_ACCOUNT, 'the posted signature is the signed message');
  assert.equal((done.steps as Record<string, unknown>[])[2].handedOver, true);
  await client.close();
});

test('v4 auto-compound: the keeper store answering 429 is waited once; a store that refuses leaves the rule on with a clear note', async () => {
  let posts = 0;
  const s = setup({ api: { 'POST /automation/permits': () => (++posts === 1 ? { status: 429, headers: { 'retry-after': '2' } } : { status: 200, body: { ok: true } }) } });
  let client = await connect(s.options);
  let plan = await call(client, 'goatlp_set_auto_compound', { venue: 'v4', id: String(V4_POS), runsToSign: 4, horizonDays: 7 });
  let done = await call(client, 'goatlp_set_auto_compound', { venue: 'v4', id: String(V4_POS), runsToSign: 4, horizonDays: 7, execute: true, planId: plan.planId });
  assert.equal((done.steps as Record<string, unknown>[])[2].handedOver, true);
  assert.equal(posts, 2);
  await client.close();

  const s2 = setup({ api: { 'POST /automation/permits': { status: 503, body: { error: 'store down' } } } });
  client = await connect(s2.options);
  plan = await call(client, 'goatlp_set_auto_compound', { venue: 'v4', id: String(V4_POS) });
  done = await call(client, 'goatlp_set_auto_compound', { venue: 'v4', id: String(V4_POS), execute: true, planId: plan.planId });
  const last = (done.steps as Record<string, unknown>[])[2];
  assert.equal(last.handedOver, false);
  assert.match(String(last.note), /signMore: true/);
  await client.close();
});

test('v3 auto-compound and v3 auto-exit: allow this position, then the rule', async () => {
  const s = setup();
  const client = await connect(s.options);
  const plan = await call(client, 'goatlp_set_auto_compound', { venue: 'v3', id: String(V3_POS) });
  assert.deepEqual((plan.steps as Record<string, unknown>[]).map((x) => x.action), ['Allow this position', 'Turn on']);
  await call(client, 'goatlp_set_auto_compound', { venue: 'v3', id: String(V3_POS), execute: true, planId: plan.planId });
  assert.deepEqual(s.signer.sent.map((t) => t.to), [NPM, GOAT_AUTO_COMPOUND_V3]);
  assert.deepEqual(fn(npmAbi, s.signer.sent[0].data).args, [GOAT_AUTO_COMPOUND_V3, V3_POS]);
  assert.deepEqual(fn(gac3Abi, s.signer.sent[1].data).args[1], { enabled: true, swapEnabled: true, maxSlippageBps: 100, minInterval: 3600, lastRunAt: 0, minReward0: 0n, minReward1: 0n });
  // a second automation on the same v3 position is refused
  assert.match(String((await call(client, 'goatlp_set_auto_range', { venue: 'v3', id: String(V3_POS) })).error), /a v3 position has one/);
  // a change of the rule that is on is one "save" transaction
  const change = await call(client, 'goatlp_set_auto_compound', { venue: 'v3', id: String(V3_POS), maxPriceProtectionBps: 200 });
  assert.deepEqual((change.steps as Record<string, unknown>[]).map((x) => x.action), ['Save changes']);
  await client.close();
});

test('stop: v4 auto-range clears the rule and removes the engine permission; v4 auto-compound cancels every unused signed message', async () => {
  const s = setup();
  const client = await connect(s.options);
  s.st.steward.set(V4_POS, { mode: 1, triggerTicks: 102, slippageBps: 25, minInterval: 21600, budget: 20, lastRunAt: 0, flags: 0, lowerTrigger: 0, upperTrigger: 0, pairEpoch: 1, maxSwapFeePips: 10000 });
  s.st.stewardOwner.set(V4_POS, TEST_ACCOUNT);
  s.st.approved.set(`v4:${V4_POS}`, GOAT_V4_STEWARD_ENGINE);
  const plan = await call(client, 'goatlp_stop_automation', { venue: 'v4', id: String(V4_POS), kind: 'range' });
  assert.deepEqual((plan.steps as Record<string, unknown>[]).map((x) => x.action), ['Clear the rule', 'Remove the permission']);
  const done = await call(client, 'goatlp_stop_automation', { venue: 'v4', id: String(V4_POS), kind: 'range', execute: true, planId: plan.planId });
  assert.equal(done.error, undefined, String(done.error));
  assert.equal(fn(stewardAbi, s.signer.sent[0].data).functionName, 'clearConfig');
  const inner = (fn(posmAbi, s.signer.sent[1].data).args[0] as Hex[]).map((d) => fn(posmAbi, d));
  assert.deepEqual(inner.map((x) => [x.functionName, ...x.args]), [['approve', ZERO, V4_POS]]);
  assert.deepEqual(done.now, { ruleOn: false, permission: 'none' });

  // auto-compound with a session the store knows: bits 0..5 signed, 0 and 1 used by runs
  const word = permitWord(GOAT_AUTO_COMPOUND_V4, V4_POS);
  s.st.gac4.set(V4_POS, [true, false, false, 100, 86400, 0, 0n]);
  s.st.gac4Owner.set(V4_POS, TEST_ACCOUNT);
  s.st.nonces.set(`${TEST_ACCOUNT.toLowerCase()}:${word}`, 0b11n);
  s.api.requests.length = 0;
  const stored = setup({ api: { [`/automation/permits/${V4_POS}`]: { body: { sessions: [{ word: word.toString(), size: 6, deadline: String(NOW_SEC + 86_400) }] } } } });
  Object.assign(stored.st, s.st);
  const c2 = await connect(stored.options);
  const p2 = await call(c2, 'goatlp_stop_automation', { venue: 'v4', id: String(V4_POS), kind: 'compound' });
  assert.deepEqual((p2.steps as Record<string, unknown>[]).map((x) => x.action), ['Turn off auto-compound', 'Cancel the signed messages', 'Ask the keeper store to drop the signed messages']);
  const d2 = await call(c2, 'goatlp_stop_automation', { venue: 'v4', id: String(V4_POS), kind: 'compound', execute: true, planId: p2.planId });
  assert.equal(d2.error, undefined, String(d2.error));
  const revoked = (fn(posmAbi, stored.signer.sent[1].data).args[0] as Hex[]).map((d) => fn(posmAbi, d).args[0]);
  assert.deepEqual(revoked, [2, 3, 4, 5].map((b) => nonceOf(word, b)), 'only the unused messages (a used one would revert the multicall)');
  assert.deepEqual(fn(gac4Abi, stored.signer.sent[0].data).args[1], { enabled: false, claimOnly: false, allowStandingApproval: false, maxSlippageBps: 0, minInterval: 0, lastRunAt: 0, minLiquidityDelta: 0n });
  assert.equal(stored.api.requests.filter((r) => r.method === 'DELETE').length, 1);
  await client.close();
  await c2.close();
});

test("stop: another app's approval is left alone; nothing to stop is said plainly", async () => {
  const s = setup();
  const client = await connect(s.options);
  s.st.ae.set(V3_POS, [true, false, false, -221800, 887273, 18446744073709551n, 18446744073709551n, false, 27670116110564327n]);
  s.st.aeOwner.set(V3_POS, TEST_ACCOUNT);
  s.st.approved.set(`v3:${V3_POS}`, FOREIGN_APP);
  const plan = await call(client, 'goatlp_stop_automation', { venue: 'v3', id: String(V3_POS), kind: 'exit' });
  assert.deepEqual((plan.steps as Record<string, unknown>[]).map((x) => x.action), ['Turn off auto-exit']);
  assert.match(String(plan.leftAlone), /another app's approval \(0x0{38}bb\) is not touched/);
  await call(client, 'goatlp_stop_automation', { venue: 'v3', id: String(V3_POS), kind: 'exit', execute: true, planId: plan.planId });
  assert.equal(s.signer.sent.length, 1);
  assert.equal(s.signer.sent[0].to, AUTO_EXIT_V3);
  assert.equal((fn(autoExitAbi, s.signer.sent[0].data).args[1] as { isActive: boolean }).isActive, false);
  assert.equal(s.st.approved.get(`v3:${V3_POS}`), FOREIGN_APP);
  assert.match(String((await call(client, 'goatlp_stop_automation', { venue: 'v3', id: String(V3_POS), kind: 'range' })).error), /nothing to stop/);
  await client.close();
});

test('never a permission for all positions, an NFT transfer or ETH value in anything the tools send', async () => {
  const s = setup();
  const client = await connect(s.options);
  for (const [tool, args] of [
    ['goatlp_set_auto_exit', { venue: 'v4', id: String(V4_POS), lower: {}, upper: { swap: true } }],
    ['goatlp_stop_automation', { venue: 'v4', id: String(V4_POS), kind: 'exit' }],
    ['goatlp_set_auto_compound', { venue: 'v3', id: String(V3_POS) }],
    ['goatlp_stop_automation', { venue: 'v3', id: String(V3_POS), kind: 'compound' }],
  ] as const) {
    const plan = await call(client, tool, args);
    assert.equal(plan.error, undefined, `${tool}: ${plan.error}`);
    const done = await call(client, tool, { ...args, execute: true, planId: plan.planId });
    assert.equal(done.error, undefined, `${tool}: ${done.error}`);
  }
  assert.ok(s.signer.sent.length >= 6);
  for (const t of s.signer.sent) {
    assert.equal(t.value, 0n);
    assert.ok(!NEVER.includes(t.data.slice(0, 10) as Hex), t.data.slice(0, 10));
    if (t.to === POSM && fn(posmAbi, t.data).functionName === 'multicall') {
      for (const d of fn(posmAbi, t.data).args[0] as Hex[]) assert.ok(!NEVER.includes(d.slice(0, 10) as Hex));
    }
  }
  await client.close();
});

test('errors never carry the private key, and execute calls share the one write queue', async () => {
  const s = setup();
  s.signer.sendTransaction = async () => { throw new Error(`signer refused with key ${TEST_KEY}`); };
  const client = await connect(s.options);
  const plan = await call(client, 'goatlp_set_auto_exit', { venue: 'v4', id: String(V4_POS), lower: {} });
  const r = await client.callTool({ name: 'goatlp_set_auto_exit', arguments: { venue: 'v4', id: String(V4_POS), lower: {}, execute: true, planId: plan.planId } });
  const text = (r.content as { text: string }[])[0].text;
  assert.equal(r.isError, true);
  assert.equal(text.includes(TEST_KEY.slice(2)), false);
  assert.match(text, /signer refused with key \[redacted\]/);
  await client.close();

  const q = setup();
  const order: string[] = [];
  const send = q.signer.sendTransaction.bind(q.signer);
  q.signer.sendTransaction = async (tx) => { order.push(`start ${tx.to}`); await new Promise((res) => setTimeout(res, 10)); const h = await send(tx); order.push(`end ${tx.to}`); return h; };
  const c2 = await connect(q.options);
  const pa = await call(c2, 'goatlp_set_auto_exit', { venue: 'v4', id: String(V4_POS), lower: {} });
  const pb = await call(c2, 'goatlp_set_auto_compound', { venue: 'v3', id: String(V3_POS) });
  await Promise.all([
    call(c2, 'goatlp_set_auto_exit', { venue: 'v4', id: String(V4_POS), lower: {}, execute: true, planId: pa.planId }),
    call(c2, 'goatlp_set_auto_compound', { venue: 'v3', id: String(V3_POS), execute: true, planId: pb.planId }),
  ]);
  assert.deepEqual(order.map((x) => x.split(' ')[0]), ['start', 'end', 'start', 'end', 'start', 'end', 'start', 'end'], 'one transaction at a time');
  await c2.close();
});

// ------------------------------------------------------------------ the keeper's size limit, the served switches, stop details

const statusWith = (pairs: unknown[]) => ({ body: { version: 1, updatedAt: NOW_SEC - 60, positions: [], pairs: { version: 1, rows: pairs } }, headers: { 'cache-control': 'public, max-age=30' } });
const ethUsdgRow = (state: 'limited' | 'waiting') => ({ venue: 'v4', token0: ZERO, token1: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', state, maxRunUsd: state === 'limited' ? 5000 : 0, reason: 'price-check-depth', eta: null });
const SIZE_LINE = "Larger automatic moves wait until this pair's price check is deeper. Smaller ones still run. The exit without a swap is not affected.";

test("the keeper's size limit: a limited pair shows its line in auto-range and swap-exit plans; a waiting pair refuses them, withdraw only goes through", async () => {
  const s = setup({ api: { '/automation/status': statusWith([ethUsdgRow('limited')]) } });
  let client = await connect(s.options);
  const id = String(V4_POS);
  const range = await call(client, 'goatlp_set_auto_range', { venue: 'v4', id });
  assert.ok((range.notes as string[]).includes(SIZE_LINE), JSON.stringify(range.notes));
  const swapExit = await call(client, 'goatlp_set_auto_exit', { venue: 'v4', id, upper: { swap: true } });
  assert.ok((swapExit.notes as string[]).includes(SIZE_LINE));
  const withdraw = await call(client, 'goatlp_set_auto_exit', { venue: 'v4', id, upper: {} });
  assert.ok(!((withdraw.notes as string[] | undefined) ?? []).includes(SIZE_LINE), 'a withdraw-only exit is not affected');
  await client.close();

  const w = setup({ api: { '/automation/status': statusWith([ethUsdgRow('waiting')]) } });
  client = await connect(w.options);
  assert.equal((await call(client, 'goatlp_set_auto_range', { venue: 'v4', id })).error, "Not planned: Auto-range is not offered for this position: Auto-range isn't offered on this pair right now. Exits without a swap work.");
  assert.equal((await call(client, 'goatlp_set_auto_exit', { venue: 'v4', id, lower: { swap: true } })).error, 'Not planned: Swap exits on this pair are paused right now. Withdraw only would act right away.');
  const ok = await call(client, 'goatlp_set_auto_exit', { venue: 'v4', id, lower: { swap: false } });
  assert.equal(ok.error, undefined, String(ok.error));
  assert.equal(w.signer.sent.length, 0);
  // the read tool says it too
  const pos = await call(client, 'goatlp_position', { venue: 'v4', id });
  const can = (pos.chain as Record<string, Record<string, Record<string, unknown>>>).canTurnOn;
  assert.equal(can.autoRange.offered, false);
  assert.equal(can.autoRange.why, "Auto-range isn't offered on this pair right now. Exits without a swap work.");
  await client.close();
});

test('while /v2/automation/policy cannot be read, nothing is turned on; a stop still works', async () => {
  let client: Client;
  const u = setup({ api: { '/v2/automation/policy': { status: 503, body: { error: 'down' } } } });
  u.st.steward.set(V4_POS, { mode: 1, triggerTicks: 102, slippageBps: 25, minInterval: 21600, budget: 20, lastRunAt: 0, flags: 0, lowerTrigger: 0, upperTrigger: 0, pairEpoch: 1, maxSwapFeePips: 10000 });
  u.st.stewardOwner.set(V4_POS, TEST_ACCOUNT);
  client = await connect(u.options);
  assert.match(String((await call(client, 'goatlp_set_auto_compound', { venue: 'v3', id: String(V3_POS) })).error), /couldn't read the automation policy/);
  const stop = await call(client, 'goatlp_stop_automation', { venue: 'v4', id: String(V4_POS), kind: 'range' });
  assert.equal(stop.error, undefined, String(stop.error));
  await client.close();
});

test('stop: an approval for all positions to the automation is reported as still on, and never changed', async () => {
  const s = setup();
  s.st.steward.set(V4_POS, { mode: 2, triggerTicks: 0, slippageBps: 25, minInterval: 0, budget: 0, lastRunAt: 0, flags: 1, lowerTrigger: -199500, upperTrigger: 0, pairEpoch: 1, maxSwapFeePips: 10000 });
  s.st.stewardOwner.set(V4_POS, TEST_ACCOUNT);
  s.st.forAll.add(`v4:${TEST_ACCOUNT.toLowerCase()}:${GOAT_V4_STEWARD_ENGINE.toLowerCase()}`);
  const client = await connect(s.options);
  const plan = await call(client, 'goatlp_stop_automation', { venue: 'v4', id: String(V4_POS), kind: 'exit' });
  assert.match(String(plan.allowForAll), /^An approval for all positions to GoatV4StewardEngine \(0xD12D46c9d3B1FE463895A20daD19F3cae5584892\) is still on\. This tool never changes it; it can be removed in the Goat LP app\.$/);
  await call(client, 'goatlp_stop_automation', { venue: 'v4', id: String(V4_POS), kind: 'exit', execute: true, planId: plan.planId });
  assert.ok(s.signer.sent.length >= 1);
  assert.ok(s.signer.sent.every((t) => !NEVER.includes(t.data.slice(0, 10) as Hex)), 'setApprovalForAll is never sent');
  assert.ok(s.st.forAll.size === 1, 'still on');
  await client.close();
});

test('stop of v4 auto-compound cancels the union of the keeper store, this server\'s record and the chain when they disagree', async () => {
  const word = permitWord(GOAT_AUTO_COMPOUND_V4, V4_POS);
  // the store holds what it was handed: nothing before the turn-on, then the session of this server (they agree)
  let held: unknown[] = [];
  const s = setup({ api: { [`/automation/permits/${V4_POS}`]: () => ({ body: { sessions: held }, headers: { 'cache-control': 'no-store' } }) } });
  const client = await connect(s.options);
  const args = { venue: 'v4', id: String(V4_POS), runsToSign: 4, horizonDays: 7 };
  const on = await call(client, 'goatlp_set_auto_compound', args);
  assert.equal(on.error, undefined, String(on.error));
  const done = await call(client, 'goatlp_set_auto_compound', { ...args, execute: true, planId: on.planId });
  assert.equal(done.error, undefined, String(done.error));
  held = [{ word: word.toString(), size: 4, deadline: String(NOW_SEC + 7 * 86_400) }];
  // one run used the first message; the chain also shows the next word in use, which no record has
  const me = TEST_ACCOUNT.toLowerCase();
  s.st.nonces.set(`${me}:${word}`, 0b1n);
  s.st.nonces.set(`${me}:${word + 1n}`, 0b1n);
  const plan = await call(client, 'goatlp_stop_automation', { venue: 'v4', id: String(V4_POS), kind: 'compound' });
  assert.equal(plan.error, undefined, String(plan.error));
  assert.ok((plan.removes as string[]).some((r) => /do not agree: every unused message any of them shows is cancelled \(62\)/.test(r)), JSON.stringify(plan.removes));
  const sentBefore = s.signer.sent.length;
  await call(client, 'goatlp_stop_automation', { venue: 'v4', id: String(V4_POS), kind: 'compound', execute: true, planId: plan.planId });
  const revoked = (fn(posmAbi, s.signer.sent[sentBefore + 1].data).args[0] as Hex[]).map((d) => fn(posmAbi, d).args[0] as bigint);
  const want = [...[1, 2, 3].map((b) => nonceOf(word, b)), ...Array.from({ length: 29 }, (_, i) => nonceOf(word + 1n, i + 1)), ...Array.from({ length: 30 }, (_, i) => nonceOf(word + 2n, i))];
  assert.deepEqual(revoked, want);
  await client.close();
});

test('stop of v4 auto-compound asks the keeper store to drop the messages only once the chain shows the stop; a "kept" answer is reported, not an error', async () => {
  const word = permitWord(GOAT_AUTO_COMPOUND_V4, V4_POS);
  const sessions = { body: { sessions: [{ word: word.toString(), size: 6, deadline: String(NOW_SEC + 86_400) }] }, headers: { 'cache-control': 'no-store' } };
  const on = (st: ReturnType<typeof setup>['st']) => { st.gac4.set(V4_POS, [true, false, false, 100, 86400, 0, 0n]); st.gac4Owner.set(V4_POS, TEST_ACCOUNT); };
  let askedAfter = -1;
  const s = setup({ api: { [`/automation/permits/${V4_POS}`]: sessions, [`DELETE /automation/permits/${V4_POS}`]: () => { askedAfter = s.signer.sent.length; return { status: 200, body: { deleted: false, reason: 'rule-on' } }; } } });
  on(s.st);
  let client = await connect(s.options);
  let plan = await call(client, 'goatlp_stop_automation', { venue: 'v4', id: String(V4_POS), kind: 'compound' });
  let done = await call(client, 'goatlp_stop_automation', { venue: 'v4', id: String(V4_POS), kind: 'compound', execute: true, planId: plan.planId });
  assert.equal(done.error, undefined, String(done.error));
  assert.equal(askedAfter, 2, 'after the rule is off and the messages are cancelled on chain');
  assert.deepEqual((done.steps as Record<string, unknown>[])[2], { step: 3, action: 'Ask the keeper store to drop the signed messages', storeCleared: false, note: 'The keeper store keeps the record until the chain shows the stop.' });
  await client.close();

  // a transaction that fails stops the plan: the store is not asked
  const r = setup({ api: { [`/automation/permits/${V4_POS}`]: sessions } });
  on(r.st);
  r.chain.receiptStatus = () => (r.signer.sent.length === 2 ? 'reverted' : 'success');
  client = await connect(r.options);
  plan = await call(client, 'goatlp_stop_automation', { venue: 'v4', id: String(V4_POS), kind: 'compound' });
  done = await call(client, 'goatlp_stop_automation', { venue: 'v4', id: String(V4_POS), kind: 'compound', execute: true, planId: plan.planId });
  assert.match(String(done.error), /Step 2 \(Cancel the signed messages\): The transaction failed on chain/);
  assert.equal(r.api.requests.filter((x) => x.method === 'DELETE').length, 0);
  await client.close();

  // confirmed, but the chain does not show the stop yet: the store is not asked either
  const t = setup({ api: { [`/automation/permits/${V4_POS}`]: sessions } });
  on(t.st);
  t.signer.onSend = () => {};
  client = await connect(t.options);
  plan = await call(client, 'goatlp_stop_automation', { venue: 'v4', id: String(V4_POS), kind: 'compound' });
  done = await call(client, 'goatlp_stop_automation', { venue: 'v4', id: String(V4_POS), kind: 'compound', execute: true, planId: plan.planId });
  assert.equal(t.api.requests.filter((x) => x.method === 'DELETE').length, 0);
  assert.equal((done.steps as Record<string, unknown>[])[2].note, 'The keeper store keeps the record until the chain shows the stop.');
  // the store confirms: cleared
  const d = setup({ api: { [`/automation/permits/${V4_POS}`]: sessions } });
  on(d.st);
  const c2 = await connect(d.options);
  plan = await call(c2, 'goatlp_stop_automation', { venue: 'v4', id: String(V4_POS), kind: 'compound' });
  done = await call(c2, 'goatlp_stop_automation', { venue: 'v4', id: String(V4_POS), kind: 'compound', execute: true, planId: plan.planId });
  assert.equal((done.steps as Record<string, unknown>[])[2].storeCleared, true);
  await client.close();
  await c2.close();
});

test('the signer prepares and signs in the process, then hands the raw transaction to the RPC; a failure before the hand-over is "not sent"', async () => {
  const calls: string[] = [];
  let raw: Hex | null = null;
  let failEstimate = false;
  let failBroadcast = false;
  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      calls.push(method);
      switch (method) {
        case 'eth_chainId': return '0x1237';
        case 'eth_getTransactionCount': return '0x7';
        case 'eth_estimateGas': if (failEstimate) throw new Error('execution reverted'); return '0x5208';
        case 'eth_maxPriorityFeePerGas': return '0x1';
        case 'eth_gasPrice': return '0x2';
        case 'eth_getBlockByNumber': return { number: '0x10', hash: `0x${'11'.repeat(32)}`, baseFeePerGas: '0x1', timestamp: '0x1', transactions: [], gasLimit: '0x1c9c380', gasUsed: '0x0' };
        case 'eth_sendRawTransaction':
          if (failBroadcast) throw new Error('the RPC timed out');
          raw = (params as Hex[])[0];
          return `0x${'22'.repeat(32)}`;
        default: throw new Error(`unexpected ${method}`);
      }
    },
  });
  const signer = viemSigner(TEST_KEY, 'https://rpc.invalid', transport);
  const hash = await signer.sendTransaction({ to: POSM, data: '0x1234', value: 5n });
  assert.equal(hash, `0x${'22'.repeat(32)}`);
  const tx = parseTransaction(raw!);
  assert.deepEqual([tx.chainId, tx.nonce, tx.to?.toLowerCase(), tx.data, tx.value], [4663, 7, POSM.toLowerCase(), '0x1234', 5n]);
  assert.equal(await recoverTransactionAddress({ serializedTransaction: raw! as never }), TEST_ACCOUNT);
  // a failure while preparing: nothing reached the RPC
  failEstimate = true;
  const before = calls.filter((c) => c === 'eth_sendRawTransaction').length;
  await assert.rejects(signer.sendTransaction({ to: POSM, data: '0x1234', value: 0n }), (e: unknown) => isNotBroadcast(e));
  assert.equal(calls.filter((c) => c === 'eth_sendRawTransaction').length, before);
  // a failure while handing it over: the outcome is unknown
  failEstimate = false;
  failBroadcast = true;
  await assert.rejects(signer.sendTransaction({ to: POSM, data: '0x1234', value: 0n }), (e: unknown) => !isNotBroadcast(e));
});

test('every write refuses while the position managers use another pool manager or factory; a pass is kept, a failed read is not', async () => {
  const s = setup();
  s.chain.on(POSM, 'poolManager', OTHER);
  let client = await connect(s.options);
  for (const [tool, args] of [
    ['goatlp_add_liquidity', { venue: 'v3', id: String(V3_POS), amount0: '1' }],
    ['goatlp_set_auto_range', { venue: 'v4', id: String(V4_POS) }],
    ['goatlp_stop_automation', { venue: 'v3', id: String(V3_POS), kind: 'compound' }],
  ] as const) {
    assert.equal((await call(client, tool, args)).error, 'Not planned: the Uniswap v4 PositionManager uses the pool manager 0x00000000000000000000000000000000000000aa, not 0x8366a39CC670B4001A1121B8F6A443A643e40951 as pinned in this package.', tool);
    assert.equal((await call(client, tool, { ...args, execute: true, planId: 'a'.repeat(24) })).error?.toString().startsWith('Not sent: the Uniswap v4 PositionManager uses the pool manager'), true, tool);
  }
  await client.close();
  const f = setup();
  f.chain.on(NPM, 'factory', OTHER);
  client = await connect(f.options);
  assert.match(String((await call(client, 'goatlp_set_auto_range', { venue: 'v4', id: String(V4_POS) })).error), /the Uniswap v3 NonfungiblePositionManager uses the factory 0x0{38}aa, not 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA/);
  await client.close();
  // a failed read refuses and is read again next time; a pass is not read again
  const r = setup();
  let fail = true;
  r.chain.on(POSM, 'poolManager', () => { if (fail) throw new Error('rpc down'); return '0x8366a39CC670B4001A1121B8F6A443A643e40951'; });
  client = await connect(r.options);
  assert.match(String((await call(client, 'goatlp_set_auto_range', { venue: 'v4', id: String(V4_POS) })).error), /couldn't read the pool manager and the factory/);
  fail = false;
  assert.equal((await call(client, 'goatlp_set_auto_range', { venue: 'v4', id: String(V4_POS) })).error, undefined);
  await call(client, 'goatlp_set_auto_exit', { venue: 'v4', id: String(V4_POS), lower: {} });
  assert.equal(r.chain.reads.filter((x) => x.endsWith(':poolmanager') || x.endsWith(':poolManager')).length, 2, 'the failed read and the pass; nothing after');
  assert.equal(r.signer.sent.length, 0);
  await client.close();
});

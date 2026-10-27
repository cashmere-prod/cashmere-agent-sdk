// The four read tools through the MCP server, on the fake chain and the API fixtures (trimmed real answers): what they
// return, that they are always listed (read-only mode included), and that a chain or RPC error never shows the RPC URL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createCashmereMcpServer, type CashmereMcpServerOptions } from '../mcp/server';
import { GoatApi } from './api';
import { GOAT_V4_STEWARD, GOAT_V4_STEWARD_ENGINE } from './constants';
import { API_OWNER, ETH_USDG_V4, NOW_SEC, TEST_KEY, V3_POS, V4_POS, apiWorld, goatWorld, v4Info } from './__fixtures__/kit';

async function connect(options: CashmereMcpServerOptions): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createCashmereMcpServer(options).connect(serverTransport);
  const client = new Client({ name: 'goatlp-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

function world(o: { readOnly?: boolean; key?: boolean } = {}) {
  const w = goatWorld();
  const api = apiWorld();
  const goatApi = new GoatApi({ fetch: api.fetch, now: () => NOW_SEC * 1000, sleep: async () => {} });
  const options: CashmereMcpServerOptions = {
    config: o.key ? { evm: { privateKey: TEST_KEY } } : {},
    readOnly: o.readOnly,
    goatlp: { rpcUrl: 'https://rpc.example/v2/secret-api-key-123456', deps: { api: goatApi, chain: w.chain, now: () => NOW_SEC * 1000 } },
  };
  return { ...w, api, options };
}

const call = async (c: Client, name: string, args: Record<string, unknown>) => {
  const r = await c.callTool({ name, arguments: args });
  const [content] = r.content as { type: string; text: string }[];
  if (r.isError) return { error: content.text } as Record<string, unknown>;
  return JSON.parse(content.text) as Record<string, unknown>;
};

test('the read tools are listed read-only, with or without a key, and in read-only mode', async () => {
  for (const o of [{}, { key: true }, { key: true, readOnly: true }]) {
    const client = await connect(world(o).options);
    const { tools } = await client.listTools();
    for (const name of ['goatlp_pools', 'goatlp_pool', 'goatlp_positions', 'goatlp_position']) {
      const t = tools.find((x) => x.name === name);
      assert.ok(t, `${name} listed`);
      assert.equal(t!.annotations?.readOnlyHint, true);
      assert.equal(t!.annotations?.destructiveHint, false);
    }
    assert.match(client.getInstructions()!, /Goat LP is experimental\. Use small amounts\./);
    await client.close();
  }
});

test('goatlp_pools: APR, TVL, volume, fee tier and venue from the API, and the automations each pool offers, read on chain', async () => {
  const w = world();
  const client = await connect(w.options);
  const r = await call(client, 'goatlp_pools', {});
  const pools = r.pools as Record<string, unknown>[];
  assert.equal(pools.length, 3);
  const v4 = pools[0];
  assert.equal(v4.venue, 'v4');
  assert.equal(v4.pair, 'ETH/USDG');
  assert.equal(v4.feeTier, 'dynamic');
  assert.equal(v4.hook, '0x06a889870c8f83640d6816319f72e2aa579b6080');
  assert.equal(v4.tvlUsd, 20314063.1);
  assert.equal(v4.feeAprPct, 63.01);
  assert.equal(v4.aprPct, 63.01);
  assert.deepEqual(v4.automation, {
    autoCompound: { offered: true, notes: ["This pool's hook charges its own swap fee. Set price protection to at least 1.10%."] },
    autoRange: { offered: true, notes: ['Reviewed hook: its fee is capped at 0.60% and checked on every run; price protection here is at most 0.40%.'] },
    autoExit: { offered: true, notes: ['Reviewed hook: its fee is capped at 0.60% and checked on every run; price protection here is at most 0.40%.'] },
  });
  assert.equal(pools[2].feeTier, '0.05%');
  assert.deepEqual((pools[2].automation as Record<string, { offered: boolean }>).autoRange, { offered: true });
  // one discover-pools request, with the honest User-Agent and a small page
  const req = w.api.requests.filter((x) => x.url.includes('/v2/discover-pools'));
  assert.equal(req.length, 1);
  assert.match(req[0].url, /sort-by=tvl&sort-dir=desc&limit=20/);
  assert.match(req[0].headers['user-agent'], /^cashmere-agent-sdk\/\d+\.\d+\.\d+$/);
  // filters run on the cached list
  const v3 = await call(client, 'goatlp_pools', { venue: 'v3', automation: false });
  assert.deepEqual((v3.pools as { venue: string }[]).map((p) => p.venue), ['v3', 'v3']);
  const big = await call(client, 'goatlp_pools', { minTvlUsd: 10_000_000, automation: false });
  assert.equal((big.pools as unknown[]).length, 2);
  const sym = await call(client, 'goatlp_pools', { token: 'nvda', automation: false });
  assert.deepEqual(sym.pools, []);
  assert.match(String(sym.searched), /top 100 pools by tvl/);
  const byToken = await call(client, 'goatlp_pools', { token: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', automation: false });
  assert.equal((byToken.pools as unknown[]).length, 3);
  await client.close();
});

test('goatlp_pool: price both ways, ranges with ticks, APR breakdown, the hook review and why an automation is (not) offered', async () => {
  const w = world();
  const client = await connect(w.options);
  const r = await call(client, 'goatlp_pool', { venue: 'v4', pool: ETH_USDG_V4 });
  assert.equal(r.pair, 'ETH/USDG');
  assert.deepEqual(r.price, { tick: -198873, sqrtPriceX96: '3807521895024586155628242', token1PerToken0: 2309.54, token0PerToken1: 0.000432986 });
  const ranges = r.ranges as { label: string; tickLower: number; tickUpper: number }[];
  assert.deepEqual(ranges.map((x) => x.label), ['±1%', '±5%', '±10%', '±20%', 'full range']);
  assert.ok(ranges.every((x) => x.tickLower % 10 === 0 && x.tickUpper % 10 === 0 && x.tickLower <= -198873 && x.tickUpper > -198873));
  assert.deepEqual(r.last24h, { volumeUsd: 38283122.2, feesUsd: 34009.72, aprPct: 63.43, feeAprPct: 63.43, rewardsAprPct: 0, feeAprGrossPct: 61.11 });
  const hook = r.hook as Record<string, unknown>;
  assert.equal(hook.forAutoRangeAndExit, 'reviewed');
  assert.equal(hook.forAutoCompound, 'reviewed');
  assert.deepEqual(hook.registryEntry, { maxPriceProtection: '0.40%', exitOnly: false, feeCap: '0.60%' });
  const auto = r.automation as Record<string, Record<string, unknown>>;
  assert.equal(auto.autoRange.offered, true);
  assert.equal(auto.autoRange.closestTriggerTicks, 102);
  assert.equal(auto.autoRange.minWidthTicks, 400);
  assert.equal(auto.autoRange.maxPriceProtection, '0.40%');
  assert.deepEqual(r.automationFees, {
    autoCompound: '10% of the fees it adds back (or sends to the wallet). Cashmere pays the gas.',
    autoRange: '0.15% of the amount moved, per move.',
    autoExit: '0.15%, once, when it closes the position.',
  });
  // the same pool with the registry entry gone: auto-range and auto-exit say why
  w.chain.on('0x92f449da205552Eadbb51C05888EEDE1657B4048', 'hookEntry', { codehash: `0x${'00'.repeat(32)}`, pinnedFee: 0, maxSlippageBps: 0, kind: 0, requiredBits: 0 });
  const r2 = await call(client, 'goatlp_pool', { venue: 'v4', pool: ETH_USDG_V4 });
  assert.deepEqual((r2.automation as Record<string, Record<string, unknown>>).autoRange.why, 'Automation is not offered for this pool.');
  await client.close();
});

test('goatlp_positions: the configured wallet by default, rules read on chain, the keeper status; an owner is needed in read-only mode', async () => {
  const w = world();
  w.st.steward.set(V4_POS, { mode: 1, triggerTicks: 102, slippageBps: 40, minInterval: 21600, budget: 20, lastRunAt: 0, flags: 0, lowerTrigger: 0, upperTrigger: 0, pairEpoch: 1, maxSwapFeePips: 10000 });
  w.st.stewardOwner.set(V4_POS, API_OWNER);
  w.st.approved.set(`v4:${V4_POS}`, GOAT_V4_STEWARD_ENGINE);
  const client = await connect(w.options);
  const none = await call(client, 'goatlp_positions', {});
  assert.match(String(none.error), /Pass the owner address/);
  const r = await call(client, 'goatlp_positions', { owner: API_OWNER });
  const ps = r.positions as Record<string, unknown>[];
  assert.deepEqual(ps.map((p) => `${p.venue}:${p.id}`), [`v4:${V4_POS}`, `v3:${V3_POS}`]);
  assert.equal(ps[0].pair, 'ETH/USDG');
  assert.equal(ps[0].inRange, true);
  assert.equal(ps[0].valueUsd, 5656.21);
  assert.deepEqual(ps[0].automation, {
    autoCompound: { on: false }, autoRange: { on: true, keeper: 'Watching: the keeper runs the rule when it is due.' }, autoExit: { on: false },
  });
  assert.deepEqual(ps[1].automation, { autoCompound: { on: false }, autoRange: { on: false }, autoExit: { on: false } });
  assert.equal(r.nextCursor, null);
  await client.close();
});

test('goatlp_position: cash flows, the rule in plain fields, the permission holder, and what could be turned on', async () => {
  const w = world();
  w.st.steward.set(V4_POS, { mode: 1, triggerTicks: 102, slippageBps: 40, minInterval: 21600, budget: 18, lastRunAt: 0, flags: 0, lowerTrigger: 0, upperTrigger: 0, pairEpoch: 1, maxSwapFeePips: 10000 });
  w.st.stewardOwner.set(V4_POS, API_OWNER);
  w.st.approved.set(`v4:${V4_POS}`, GOAT_V4_STEWARD_ENGINE);
  const client = await connect(w.options);
  const r = await call(client, 'goatlp_position', { venue: 'v4', id: String(V4_POS) });
  assert.equal(r.pair, 'ETH/USDG');
  assert.ok((r.cashFlows as { type: string }[]).some((c) => c.type === 'deposits'));
  const chain = r.chain as Record<string, unknown>;
  assert.equal(chain.owner, API_OWNER);
  assert.deepEqual(chain.permission, { address: GOAT_V4_STEWARD_ENGINE, holder: 'GoatV4StewardEngine' });
  const range = (chain.rules as Record<string, Record<string, unknown>>).autoRange;
  assert.equal(range.on, true);
  assert.equal(range.triggerTicks, 102);
  assert.equal(range.movesLeft, 18);
  assert.equal(range.movesBelowTick, -198960 - 102);
  assert.equal(range.atMostOneMoveEvery, '6 hours');
  const can = chain.canTurnOn as Record<string, Record<string, unknown>>;
  // this real position is 310 ticks wide, under the 400-tick floor of auto-range on v4
  assert.equal(can.autoRange.offered, false);
  assert.match(String(can.autoRange.why), /too narrow for auto-range\. It needs at least 4\.08% between min and max/);
  assert.equal(can.autoCompound.offered, false);
  assert.match(String(can.autoCompound.why), /Auto-range already puts the fees back/);
  assert.match(String(chain.canTurnOnNote), /no wallet configured/);
  void GOAT_V4_STEWARD; void v4Info;
  await client.close();
});

test('a chain error inside a result never shows the RPC URL', async () => {
  const w = world();
  w.chain.chainId = async () => { throw new Error('HTTP request failed. URL: https://rpc.example/v2/secret-api-key-123456 Status: 500'); };
  const client = await connect(w.options);
  const r = await client.callTool({ name: 'goatlp_pool', arguments: { venue: 'v4', pool: ETH_USDG_V4 } });
  const text = (r.content as { text: string }[])[0].text;
  assert.equal(text.includes('secret-api-key'), false);
  assert.match(text, /Could not read Robinhood Chain right now \(HTTP request failed\. URL: \[redacted\]/);
  await client.close();
});

test('arguments are checked before anything is read', async () => {
  const w = world();
  const client = await connect(w.options);
  for (const [name, args] of [['goatlp_pool', { venue: 'v5', pool: ETH_USDG_V4 }], ['goatlp_pool', { venue: 'v4', pool: '0x12' }], ['goatlp_positions', { owner: '0xabc' }], ['goatlp_position', { venue: 'v4', id: '1e5' }], ['goatlp_pools', { limit: 500 }]] as const) {
    const r = await client.callTool({ name, arguments: args as Record<string, unknown> });
    assert.equal(r.isError, true, `${name} ${JSON.stringify(args)}`);
  }
  assert.equal(w.api.requests.length, 0);
  await client.close();
});

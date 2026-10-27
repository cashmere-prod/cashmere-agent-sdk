// The api.cashmere.exchange client: the honest User-Agent, the max-age cache and ETag revalidation, one request at a time
// per zone, the per-minute budget, 429 handling (wait Retry-After once, then a clear refusal) and the path checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { GoatApi, maxAgeOf, retryAfterSec, routes, USER_AGENT } from './api';
import { fakeFetch, fixture } from './__fixtures__/kit';

const { version } = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version: string };
const DISCOVER = routes.discover({ sortBy: 'tvl', limit: 5 });

function client(routesMap: Parameters<typeof fakeFetch>[0], o: { now?: () => number } = {}) {
  const f = fakeFetch(routesMap);
  const slept: number[] = [];
  const api = new GoatApi({ fetch: f.fetch, now: o.now, sleep: async (ms) => { slept.push(ms); }, maxBudgetWaitMs: 0 });
  return { api, requests: f.requests, slept };
}

test('sends the honest User-Agent of this package version, never a browser one', async () => {
  const { api, requests } = client({ [DISCOVER]: { body: fixture('discover-pools.json') } });
  await api.get(DISCOVER, 'discover');
  assert.equal(USER_AGENT, `cashmere-agent-sdk/${version}`);
  assert.equal(requests[0].headers['user-agent'], `cashmere-agent-sdk/${version}`);
  assert.equal(requests[0].headers.accept, 'application/json');
  assert.equal(requests[0].url, `https://api.cashmere.exchange${DISCOVER}`);
});

test('a response is kept for its max-age, then revalidated with If-None-Match; a 304 keeps the cached body', async () => {
  let now = 1_000_000;
  let calls = 0;
  const body = fixture('discover-pools.json');
  const { api, requests } = client({
    [DISCOVER]: (init) => {
      calls++;
      if (init.headers['if-none-match'] === 'W/"abc"') return { status: 304, headers: { 'cache-control': 'public, max-age=300' } };
      return { body, headers: { 'cache-control': 'public, max-age=300, stale-while-revalidate=600', etag: 'W/"abc"' } };
    },
  }, { now: () => now });
  const a = await api.get(DISCOVER, 'discover');
  now += 299_000;
  const b = await api.get(DISCOVER, 'discover');
  assert.equal(calls, 1, 'served from the cache inside max-age');
  assert.deepEqual(a, b);
  now += 2_000;
  const c = await api.get(DISCOVER, 'discover');
  assert.equal(calls, 2);
  assert.equal(requests[1].headers['if-none-match'], 'W/"abc"');
  assert.deepEqual(c, body, '304: the cached body');
  now += 100_000;
  await api.get(DISCOVER, 'discover');
  assert.equal(calls, 2, 'the 304 renewed the max-age');
});

test('no-store answers are never cached', async () => {
  let calls = 0;
  const path = routes.permitsOf(4006316n);
  const { api } = client({ [path]: () => { calls++; return { body: { sessions: [] }, headers: { 'cache-control': 'no-store' } }; } });
  await api.get(path, 'other');
  await api.get(path, 'other');
  assert.equal(calls, 2);
  assert.equal(maxAgeOf('no-store'), null);
  assert.equal(maxAgeOf('public, max-age=2'), 2);
  assert.equal(maxAgeOf(null), null);
});

test('429: waits the Retry-After once and tries again', async () => {
  let calls = 0;
  const { api, slept } = client({ [DISCOVER]: () => (++calls === 1 ? { status: 429, headers: { 'retry-after': '7' } } : { body: { data: [] }, headers: { 'cache-control': 'max-age=300' } }) });
  assert.deepEqual(await api.get(DISCOVER, 'discover'), { data: [] });
  assert.equal(calls, 2);
  assert.deepEqual(slept, [7000]);
});

test('429 twice: gives up with a clear message after one wait, with no third request', async () => {
  let calls = 0;
  const { api, slept } = client({ [DISCOVER]: () => { calls++; return { status: 429, headers: { 'retry-after': '3' } }; } });
  await assert.rejects(api.get(DISCOVER, 'discover'), /limiting requests from this IP \(discover, HTTP 429\)\. Try again in 3 s/);
  assert.equal(calls, 2);
  assert.deepEqual(slept, [3000]);
});

test('429 with a long Retry-After gives up at once', async () => {
  let calls = 0;
  const { api, slept } = client({ [DISCOVER]: () => { calls++; return { status: 429, headers: { 'retry-after': '600' } }; } });
  await assert.rejects(api.get(DISCOVER, 'discover'), /Try again in 600 s/);
  assert.equal(calls, 1);
  assert.deepEqual(slept, []);
  assert.equal(retryAfterSec('Tue, 27 Oct 2026 09:12:00 GMT', Date.parse('Tue, 27 Oct 2026 09:11:50 GMT')), 10);
  assert.equal(retryAfterSec(null, 0), null);
});

test('one request at a time per zone: no parallel bursts', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const f = fakeFetch({});
  const api = new GoatApi({
    fetch: async (url, init) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return f.fetch(url, init);
    },
    sleep: async () => {},
  });
  const paths = [1, 2, 3, 4].map((i) => routes.position('v4', BigInt(i)));
  await Promise.allSettled(paths.map((p) => api.get(p, 'position')));
  assert.equal(maxInFlight, 1);
});

test('stays under the per-minute budget of a zone: the 7th discover-pools request in a minute is refused without being sent', async () => {
  let calls = 0;
  const { api } = client({ '/v2/discover-pools': () => { calls++; return { body: { data: [] } }; } });
  for (let i = 0; i < 6; i++) await api.get(routes.discover({ sortBy: 'tvl', limit: 5, offset: i }), 'discover');
  await assert.rejects(api.get(routes.discover({ sortBy: 'tvl', limit: 5, offset: 9 }), 'discover'), /made 6 requests to api\.cashmere\.exchange \(discover\) in the last minute/);
  assert.equal(calls, 6);
});

test('an error status reports the API message; a network failure does not leak the URL query', async () => {
  const path = routes.position('v3', 1n);
  const { api } = client({ [path]: { status: 404, body: { success: false, error: 'position not found' } } });
  await assert.rejects(api.get(path, 'position'), /answered \/v2\/positions\/robinhood\/uniswapv3\/1 with position not found/);
  const down = new GoatApi({ fetch: async () => { throw new Error('ECONNREFUSED'); }, sleep: async () => {} });
  await assert.rejects(down.get(DISCOVER, 'discover'), /Could not reach api\.cashmere\.exchange \(\/v2\/discover-pools\)/);
});

test('path parts are checked before a URL is built', () => {
  assert.throws(() => routes.pool('v4', '0x1234'), /32-byte pool id/);
  assert.throws(() => routes.pool('v3', `0x${'1'.repeat(64)}`), /20-byte address/);
  assert.throws(() => routes.position('v3', '12a'), /whole number/);
  assert.throws(() => routes.accountPositions('0x0000000000000000000000000000000000000000', { scope: 'active', limit: 5 }), /burn or reserved address/);
  assert.throws(() => routes.accountPositions(`0x${'1'.repeat(40)}`, { scope: 'active', limit: 5, cursor: 'a b&c=d' }), /cursor/);
  assert.equal(routes.pool('v3', '0x69BFAF19C9F377BB306A89AED9F6B07E2C1A8D9A'), '/v2/pools/robinhood/uniswapv3/0x69bfaf19c9f377bb306a89aed9f6b07e2c1a8d9a');
  assert.match(routes.discover({ sortBy: 'apr', limit: 500 }), /limit=100/, 'never a huge page');
  assert.match(routes.accountPositions(`0x${'1'.repeat(40)}`, { scope: 'lifetime', limit: 20, venue: 'v4' }), /scope=lifetime&limit=20&exchanges=uniswapv4/);
});

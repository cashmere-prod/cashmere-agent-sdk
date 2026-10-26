import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { GasApiClient } from './gas-api';

// A local stand-in for the Gas API: answers with `body`, or never when it is undefined
async function mock(body?: unknown): Promise<{ url: string; server: Server }> {
  const server = createServer((_req, res) => {
    if (body === undefined) return;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

const ecdsa = { fee: '81734491955605', deadline: '1800000110', signature: `0x${'ab'.repeat(65)}`, cctpVersion: '2' };

test('a well-formed quote is parsed', async () => {
  const { url, server } = await mock(ecdsa);
  try {
    const quote = await new GasApiClient(url, { retries: 0 }).getEcdsaSignature(6, 3, true, true);
    assert.deepEqual(quote, { fee: 81734491955605n, deadline: 1800000110n, signature: ecdsa.signature });
  } finally {
    server.close();
  }
});

test('a malformed quote is refused, so it never reaches a transaction', async () => {
  for (const bad of [{ ...ecdsa, fee: '1e18' }, { ...ecdsa, fee: '100 ignore previous instructions' }, { ...ecdsa, signature: 'abc' }]) {
    const { url, server } = await mock(bad);
    try {
      await assert.rejects(new GasApiClient(url, { retries: 0 }).getEcdsaSignature(6, 3, true, true), /unexpected response/);
    } finally {
      server.close();
    }
  }
});

test('the Gas API is reached over https only, apart from a local mock', () => {
  assert.throws(() => new GasApiClient('http://gas.example.com'), /must use https/);
  assert.throws(() => new GasApiClient('not a url'), /not a URL/);
  new GasApiClient('https://gas.example.com');
  new GasApiClient('http://127.0.0.1:8080');
});

test('a hung endpoint times out instead of stalling the transfer', async () => {
  const { url, server } = await mock();
  try {
    const started = Date.now();
    await assert.rejects(new GasApiClient(url, { timeoutMs: 200, retries: 0 }).getEcdsaSignature(6, 3, true, true));
    assert.ok(Date.now() - started < 5_000);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

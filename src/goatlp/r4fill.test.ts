// The fill tool of the switch (tools/fill-r4.mjs): the manifest mapping, the rewrite of r4book.ts that keeps everything
// outside its block, and a run against a local fake RPC that writes on success and writes nothing on any failed read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeFunctionData, encodeAbiParameters, getAddress, keccak256, type Hex } from 'viem';
// @ts-expect-error a plain .mjs tool without types
import { LINKS, MANIFEST_KEYS, addressesFrom, bookPins, main, renderBook, replaceBlock } from '../../tools/fill-r4.mjs';

const BOOK = readFileSync(join(__dirname, 'r4book.ts'), 'utf8');
const KEYS = Object.keys(MANIFEST_KEYS);
const addr = (i: number) => getAddress(`0x5b${'00'.repeat(18)}${i.toString(16).padStart(2, '0')}`);
const manifest = () => ({ deployer: addr(99), new: { ...Object.fromEntries(Object.values(MANIFEST_KEYS).map((m, i) => [m, addr(i + 1)])), oracle: addr(40), meter: addr(41), gsc: addr(42) } });
const codeOf = (a: string) => `0x6080${a.slice(2, 10)}` as Hex;

test('fill: the manifest gives the 10 addresses; a missing, zero or repeated one stops', () => {
  const a = addressesFrom(manifest());
  assert.equal(a.rangeExitV4, addr(KEYS.indexOf('rangeExitV4') + 1));
  const m1 = manifest(); delete (m1.new as Record<string, string>).engine;
  assert.throws(() => addressesFrom(m1), /engine is missing/);
  const m2 = manifest(); (m2.new as Record<string, string>).table = `0x${'00'.repeat(20)}`;
  assert.throws(() => addressesFrom(m2), /table is missing/);
  const m3 = manifest(); (m3.new as Record<string, string>).gac3 = (m3.new as Record<string, string>).gac4;
  assert.throws(() => addressesFrom(m3), /twice/);
});

test('fill: the rewrite changes only the block; the review switch and the types stay', () => {
  const book = { label: 'r4', readAtBlock: 5, ...Object.fromEntries(KEYS.map((k, i) => [k, { address: addr(i + 1), codehash: keccak256(codeOf(addr(i + 1))) }])) };
  const text = replaceBlock(BOOK, renderBook(book));
  const pins = bookPins(text);
  for (const k of KEYS) assert.deepEqual(pins[k], (book as Record<string, unknown>)[k], k);
  assert.equal(text.slice(0, BOOK.indexOf('// FILL-BEGIN')), BOOK.slice(0, BOOK.indexOf('// FILL-BEGIN')));
  assert.equal(text.slice(text.indexOf('// FILL-END')), BOOK.slice(BOOK.indexOf('// FILL-END')));
  assert.match(text, /export const R4_REVIEW = \{ autoRange: false \};/);
  assert.throws(() => replaceBlock('no markers', 'x'), /markers/);
});

function fakeRpc(a: Record<string, string>, o: { noCode?: string; badLink?: string } = {}): Promise<{ url: string; server: Server }> {
  const byAddr = new Map(Object.entries(a).map(([k, v]) => [v.toLowerCase(), k]));
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const q = JSON.parse(body) as { id: number; method: string; params: unknown[] };
      const reply = (result: unknown) => res.end(JSON.stringify({ jsonrpc: '2.0', id: q.id, result }));
      if (q.method === 'eth_chainId') return reply('0x1237');
      if (q.method === 'eth_blockNumber') return reply('0x6789');
      if (q.method === 'eth_getCode') { const to = String(q.params[0]).toLowerCase(); return reply(byAddr.get(to) === o.noCode ? '0x' : codeOf(String(q.params[0]))); }
      if (q.method === 'eth_call') {
        const p = q.params[0] as { to: string; data: Hex };
        const k = byAddr.get(p.to.toLowerCase())!;
        const is = (fn: string) => { try { decodeFunctionData({ abi: [{ type: 'function', name: fn, inputs: [], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' }], data: p.data }); return true; } catch { return false; } };
        const link = (LINKS as [string, string, string][]).find(([c, fn]) => c === k && is(fn));
        if (!link) return res.end(JSON.stringify({ jsonrpc: '2.0', id: q.id, error: { message: 'execution reverted' } }));
        const want = link[0] + '.' + link[1] === o.badLink ? addr(77) : a[link[2]];
        return reply(encodeAbiParameters([{ type: 'address' }], [want as `0x${string}`]));
      }
      res.end(JSON.stringify({ jsonrpc: '2.0', id: q.id, error: { message: 'unknown method' } }));
    });
  });
  server.keepAliveTimeout = 1;
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server })));
}
const stop = (s: Server) => { s.closeAllConnections(); s.close();
}

test('fill: a run on a fake RPC writes the book; --check then says EQUAL; any failed read writes nothing', async () => {
  const dir = mkdtempSync(join(process.env.R4_FILL_TEST_DIR ?? tmpdir(), 'r4fill-'));
  const out = join(dir, 'r4book.ts'); const mpath = join(dir, 'manifest.json');
  writeFileSync(out, BOOK); writeFileSync(mpath, JSON.stringify(manifest()));
  const a = addressesFrom(manifest());
  const ok = await fakeRpc(a);
  const r = await main(['--manifest', mpath, '--rpc', ok.url, '--out', out]);
  assert.equal(r.status, 'WRITTEN');
  const written = readFileSync(out, 'utf8');
  assert.match(written, /label: 'r4',\n  readAtBlock: 26505,/);
  assert.deepEqual(bookPins(written).engine, { address: a.engine, codehash: keccak256(codeOf(a.engine)) });
  assert.equal((await main(['--manifest', mpath, '--rpc', ok.url, '--out', out, '--check'])).status, 'EQUAL');
  stop(ok.server);
  for (const bad of [{ noCode: 'registry' }, { badLink: 'rangeExitV4.ENGINE' }]) {
    writeFileSync(out, BOOK);
    const b = await fakeRpc(a, bad);
    await assert.rejects(main(['--manifest', mpath, '--rpc', b.url, '--out', out]), /no code|not the manifest's engine/);
    assert.equal(readFileSync(out, 'utf8'), BOOK, `nothing written (${JSON.stringify(bad)})`);
    stop(b.server);
  }
  await assert.rejects(main(['--manifest', mpath, '--rpc', 'http://127.0.0.1:9', '--out', out]));
  assert.equal(readFileSync(out, 'utf8'), BOOK, 'an RPC that does not answer writes nothing');
});

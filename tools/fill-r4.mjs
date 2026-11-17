#!/usr/bin/env node
// Fill the r4 Goat LP values of src/goatlp/r4book.ts at the switch, from the deploy manifest and the chain.
//   node tools/fill-r4.mjs --manifest <deploy manifest.json> --rpc <read-only RPC URL> [--out <r4book.ts>] [--check]
// The manifest's `new` object names the 13 deployed contracts (the runbook's batches/manifest.json shape); the 10 the
// agent tools use are read here. For each: the runtime code is read and hashed (no code = stop), and the addresses the
// contracts name in their immutables must equal the manifest (engine, registry, compoundor, price anchor, pair table).
// Any failed or unexpected read stops the tool and writes nothing. --check compares the file with the chain and writes
// nothing (exit 0 = EQUAL). No key, no transaction: reads only.
import { readFileSync, writeFileSync } from 'node:fs';
import { decodeFunctionResult, encodeFunctionData, getAddress, keccak256 } from 'viem';

export const MANIFEST_KEYS = {
  autoCompoundV3: 'gac3', autoCompoundV4: 'gac4', rangeExitV3: 'autoRange', exitV3: 'autoExit', rangeExitV4: 'steward',
  engine: 'engine', compoundorV4: 'gv4c', registry: 'registry', pairTable: 'table', priceAnchor: 'anchor',
};
const BOOK_KEYS = Object.keys(MANIFEST_KEYS);
const view = (name) => [{ type: 'function', name, inputs: [], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' }];
/** [contract key, view, the key its answer must equal] */
export const LINKS = [
  ['rangeExitV4', 'ENGINE', 'engine'], ['rangeExitV4', 'REGISTRY', 'registry'], ['autoCompoundV4', 'compoundor', 'compoundorV4'],
  ['compoundorV4', 'priceAnchor', 'priceAnchor'], ['autoCompoundV3', 'priceAnchor', 'priceAnchor'],
  ['rangeExitV3', 'pairTable', 'pairTable'], ['exitV3', 'pairTable', 'pairTable'],
];

/** The 10 addresses from a manifest object, checksummed; throws on a missing, malformed or zero entry. Pure. */
export function addressesFrom(manifest) {
  const n = manifest && typeof manifest === 'object' ? manifest.new : null;
  if (!n || typeof n !== 'object') throw new Error('manifest has no "new" object');
  const out = {};
  for (const k of BOOK_KEYS) {
    const a = n[MANIFEST_KEYS[k]];
    if (typeof a !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(a) || /^0x0{40}$/i.test(a)) throw new Error(`manifest entry ${MANIFEST_KEYS[k]} is missing or not an address`);
    out[k] = getAddress(a);
  }
  if (new Set(Object.values(out).map((a) => a.toLowerCase())).size !== BOOK_KEYS.length) throw new Error('manifest names one address twice');
  return out;
}

/** The FILL block text for a book. Pure. */
export function renderBook(book) {
  const lines = ['// FILL-BEGIN (tools/fill-r4.mjs replaces the lines up to FILL-END)', 'export const R4_BOOK: R4Book = {',
    `  label: '${book.label}',`, `  readAtBlock: ${book.readAtBlock},`];
  for (const k of BOOK_KEYS) lines.push(`  ${k}: { address: '${book[k].address}', codehash: '${book[k].codehash}' },`);
  lines.push('};', '// FILL-END');
  return lines.join('\n');
}

/** Replace the FILL block of r4book.ts text. Pure; throws when the markers are not there exactly once. */
export function replaceBlock(text, block) {
  const a = text.indexOf('// FILL-BEGIN'); const b = text.indexOf('// FILL-END');
  if (a < 0 || b < a || text.indexOf('// FILL-BEGIN', a + 1) >= 0 || text.indexOf('// FILL-END', b + 1) >= 0) throw new Error('r4book.ts markers not found exactly once');
  return text.slice(0, a) + block + text.slice(b + '// FILL-END'.length);
}

async function rpc(url, method, params, id) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
  if (!r.ok) throw new Error(`${method}: HTTP ${r.status}`);
  const j = await r.json();
  if (j.error || j.result === undefined || j.result === null) throw new Error(`${method}: ${j.error ? j.error.message ?? 'error' : 'no result'}`);
  return j.result;
}

/** Read the book from the chain: code hashes, the links, the block. Throws on any failed or unexpected read. */
export async function readBook(url, addrs) {
  const chainId = await rpc(url, 'eth_chainId', [], 1);
  if (Number(BigInt(chainId)) !== 4663) throw new Error(`the RPC is on chain ${Number(BigInt(chainId))}, not 4663`);
  const block = await rpc(url, 'eth_blockNumber', [], 2);
  const tag = block;
  const book = { label: 'r4', readAtBlock: Number(BigInt(block)) };
  let id = 10;
  for (const k of BOOK_KEYS) {
    const code = await rpc(url, 'eth_getCode', [addrs[k], tag], id++);
    if (typeof code !== 'string' || !/^0x[0-9a-fA-F]+$/.test(code) || code === '0x') throw new Error(`${k} has no code at ${addrs[k]}`);
    book[k] = { address: addrs[k], codehash: keccak256(code) };
  }
  for (const [k, fn, want] of LINKS) {
    const abi = view(fn);
    const res = await rpc(url, 'eth_call', [{ to: addrs[k], data: encodeFunctionData({ abi, functionName: fn }) }, tag], id++);
    const got = decodeFunctionResult({ abi, functionName: fn, data: res });
    if (getAddress(got) !== addrs[want]) throw new Error(`${k}.${fn}() is ${got}, not the manifest's ${want} ${addrs[want]}`);
  }
  return book;
}

/** The pins of a written book (address and hash per key), for --check. Pure. */
export function bookPins(text) {
  const out = {};
  for (const k of BOOK_KEYS) {
    const m = text.match(new RegExp(`\\n  ${k}: \\{ address: '(0x[0-9a-fA-F]{40})', codehash: '(0x[0-9a-fA-F]{64})' \\},`));
    out[k] = m ? { address: m[1], codehash: m[2] } : null;
  }
  return out;
}

export async function main(argv) {
  const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const manifestPath = arg('--manifest'); const url = arg('--rpc');
  const out = arg('--out') ?? new URL('../src/goatlp/r4book.ts', import.meta.url).pathname;
  if (!manifestPath || !url) throw new Error('usage: fill-r4.mjs --manifest <file> --rpc <url> [--out <r4book.ts>] [--check]');
  const addrs = addressesFrom(JSON.parse(readFileSync(manifestPath, 'utf8')));
  const book = await readBook(url, addrs);
  const text = readFileSync(out, 'utf8');
  if (argv.includes('--check')) {
    const have = bookPins(text);
    const diff = BOOK_KEYS.filter((k) => !have[k] || have[k].address !== book[k].address || have[k].codehash !== book[k].codehash);
    return diff.length ? { status: 'DIFF', keys: diff } : { status: 'EQUAL', block: book.readAtBlock };
  }
  writeFileSync(out, replaceBlock(text, renderBook(book)));
  return { status: 'WRITTEN', block: book.readAtBlock, file: out };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((r) => {
    console.log(r.status === 'DIFF' ? `DIFF ${r.keys.join(',')}` : r.status === 'EQUAL' ? `EQUAL at block ${r.block}` : `WRITTEN ${r.file} at block ${r.block}`);
    process.exit(r.status === 'DIFF' ? 1 : 0);
  }, (e) => { console.error(`STOP: ${e.message}; nothing written`); process.exit(1); });
}

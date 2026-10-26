import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { createSolanaSigner } from './solana';

// A throwaway key, generated per run
const keypair = Keypair.generate();
const json = JSON.stringify(Array.from(keypair.secretKey));

test('base58 and JSON-array keys sign for the same wallet', () => {
  assert.equal(createSolanaSigner(bs58.encode(keypair.secretKey)).keypair.publicKey.toBase58(), keypair.publicKey.toBase58());
  assert.equal(createSolanaSigner(json).keypair.publicKey.toBase58(), keypair.publicKey.toBase58());
});

test('a malformed JSON-array key is refused without echoing part of it', () => {
  // A stray character in the middle: JSON.parse would quote the text around it
  const broken = json.slice(0, 40) + 'x' + json.slice(40);
  assert.throws(() => createSolanaSigner(broken), (err: Error) => {
    assert.equal(err.message, 'Solana private key is not a valid JSON byte array');
    return true;
  });
});

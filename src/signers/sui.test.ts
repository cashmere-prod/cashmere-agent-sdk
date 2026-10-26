import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1';
import { createSuiSigner } from './sui';

// A throwaway key, generated per run
const keypair = Ed25519Keypair.generate();
const address = keypair.toSuiAddress();
const suiprivkey = keypair.getSecretKey();
const hex = Buffer.from(decodeSuiPrivateKey(suiprivkey).secretKey).toString('hex');

const REFUSED = 'Sui private key is not a valid ed25519 suiprivkey';

test('a suiprivkey, as Sui wallets export it, signs for the same address as its hex form', () => {
  assert.ok(suiprivkey.startsWith('suiprivkey1'));
  assert.equal(createSuiSigner(suiprivkey).keypair.toSuiAddress(), address);
  assert.equal(createSuiSigner(hex).keypair.toSuiAddress(), address);
  assert.equal(createSuiSigner(`0x${hex}`).keypair.toSuiAddress(), address);
});

test('a malformed or non-ed25519 suiprivkey is refused without echoing it', () => {
  // One character changed: the bech32 checksum no longer matches
  const typo = suiprivkey.slice(0, -1) + (suiprivkey.endsWith('q') ? 'p' : 'q');
  const secp256k1 = Secp256k1Keypair.generate().getSecretKey();

  for (const key of [typo, secp256k1]) {
    assert.throws(() => createSuiSigner(key), (err: Error) => {
      assert.equal(err.message, REFUSED);
      return true;
    });
  }
});

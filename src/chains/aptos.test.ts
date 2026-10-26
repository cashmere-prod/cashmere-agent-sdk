import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AptosConfig, Network, generateTransactionPayload } from '@aptos-labs/ts-sdk';
import { APTOS_TRANSFER_MODULE } from '../constants';
import { aptosTransferPayload } from './aptos';

const params = {
  dstDomain: 6,
  amount: 1_000_000n,
  recipient: `0x${'11'.repeat(32)}`,
  solanaOwner: `0x${'00'.repeat(32)}`,
  isNative: false,
  fee: '190000',
  deadline: '1793005550',
  signature: new Uint8Array(64).fill(7),
};
const v2 = { maxFee: 0n, minFinalityThreshold: 2000 };

test('V1 calls transfer_outer with its ten arguments', () => {
  const payload = aptosTransferPayload(params);
  assert.equal(payload.function, `${APTOS_TRANSFER_MODULE}::transfer::transfer_outer`);
  assert.equal(payload.functionArguments.length, 10);
  assert.equal(payload.functionArguments[5], '190000');
  assert.deepEqual(payload.functionArguments[9], Array.from(params.signature));
});

test('V2 calls transfer_v2_outer with max_fee and min_finality_threshold before the signature', () => {
  const payload = aptosTransferPayload({ ...params, v2 });
  assert.equal(payload.function, `${APTOS_TRANSFER_MODULE}::transfer::transfer_v2_outer`);
  assert.equal(payload.functionArguments.length, 12);
  // the relayer reads the fee at index 5
  assert.equal(payload.functionArguments[5], '190000');
  assert.equal(payload.functionArguments[9], '0');
  assert.equal(payload.functionArguments[10], 2000);
  assert.deepEqual(payload.functionArguments[11], Array.from(params.signature));
});

test('with the fee in APT the native amount is the fee', () => {
  const payload = aptosTransferPayload({ ...params, isNative: true, fee: '1234', v2 });
  assert.equal(payload.functionArguments[1], '1234');
  assert.equal(payload.functionArguments[8], true);
});

// Serializes the payloads against the mainnet module ABI, which throws on a missing or mistyped argument
test('payloads serialize against the on-chain ABI', { skip: !process.env.CASHMERE_LIVE && 'set CASHMERE_LIVE=1' }, async () => {
  const aptosConfig = new AptosConfig({ network: Network.MAINNET });
  for (const payload of [aptosTransferPayload(params), aptosTransferPayload({ ...params, v2 })]) {
    await generateTransactionPayload({ ...payload, aptosConfig });
  }
});

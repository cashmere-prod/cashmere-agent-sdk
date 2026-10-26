import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePrivateKey } from 'viem/accounts';
import { DEFAULT_RPC_URLS, EVM_CHAIN_IDS } from '../constants';
import { createEvmSigner } from './evm';

// A throwaway key, generated per run. Building the clients reaches no network.
const key = generatePrivateKey();

test('Arc gets its chain id and default RPC, with USDC as the gas token', () => {
  const { walletClient, publicClient } = createEvmSigner(key, 'arc');
  assert.equal(walletClient.chain.id, EVM_CHAIN_IDS.arc);
  assert.deepEqual(walletClient.chain.nativeCurrency, { name: 'USDC', symbol: 'USDC', decimals: 18 });
  assert.equal((publicClient.transport as { url?: string }).url, DEFAULT_RPC_URLS.arc);
});

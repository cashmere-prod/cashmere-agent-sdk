import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicClient, encodePacked, erc20Abi, getAddress, http, keccak256, parseAbi, recoverAddress } from 'viem';
import { CASHMERE_CCTP_ADDRESSES, CCTP_DOMAINS, DEFAULT_RPC_URLS, EVM_CHAIN_IDS, USDC_ADDRESSES } from '../constants';
import { GasApiClient } from '../gas-api';
import { checkQuote } from '../utils/quote';

const CASHMERE_ABI = parseAbi([
  'function localDomain() view returns (uint32)',
  'function usdc() view returns (address)',
  'function state() view returns (address signer, uint32 nonce, uint32 maxUSDCGasDrop, uint16 feeBP, bool reentrancyLock, bool paused, uint128 maxNativeGasDrop, uint128 lastFeeWithdrawTimestamp)',
]);

const live = { skip: !process.env.CASHMERE_LIVE && 'set CASHMERE_LIVE=1' };

// Read-only: the Arc constants against the chain, and the signature a transferV2 there would check
test('the Arc contract matches the constants and accepts Gas API quotes', live, async () => {
  const client = createPublicClient({ transport: http(DEFAULT_RPC_URLS.arc) });
  const address = CASHMERE_CCTP_ADDRESSES.arc!;
  const usdc = USDC_ADDRESSES.arc as `0x${string}`;

  assert.equal(await client.getChainId(), EVM_CHAIN_IDS.arc);
  assert.equal(await client.readContract({ address, abi: CASHMERE_ABI, functionName: 'localDomain' }), CCTP_DOMAINS.arc);
  assert.equal(await client.readContract({ address, abi: CASHMERE_ABI, functionName: 'usdc' }), getAddress(usdc));
  assert.equal(await client.readContract({ address: usdc, abi: erc20Abi, functionName: 'decimals' }), 6);

  // transferV2 recovers state().signer from keccak256(localDomain, destinationDomain, fee, deadline, isNative, 2)
  const [signer] = await client.readContract({ address, abi: CASHMERE_ABI, functionName: 'state' });
  const dstDomain = CCTP_DOMAINS.base;
  const quote = await new GasApiClient().getEcdsaSignature(CCTP_DOMAINS.arc, dstDomain, true, true);
  checkQuote(quote, { from: 'arc', dstDomain, amount: 1_000_000n, isNative: true });
  const hash = keccak256(encodePacked(
    ['uint32', 'uint32', 'uint128', 'uint64', 'bool', 'uint8'],
    [CCTP_DOMAINS.arc, dstDomain, quote.fee, quote.deadline, true, 2],
  ));
  assert.equal(await recoverAddress({ hash, signature: quote.signature }), signer);
});

test('Circle quotes no Fast fee from Arc, which is why routing sends it over V2 Norm', live, async () => {
  const fast = await new GasApiClient().getBurnFee(CCTP_DOMAINS.arc, CCTP_DOMAINS.base, 1000);
  assert.equal(fast.finalityThreshold, 1000);
  assert.equal(fast.minimumFee, 0, 'Circle now charges for Fast from Arc: revisit V2_FAST_UNSUPPORTED_SOURCES in routing.ts');
});

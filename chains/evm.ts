import { erc20Abi, type Account, type PublicClient, type WalletClient, type Chain, type Transport } from 'viem';
import type { EvmNetwork, FeeMode } from '../types';
import { GasApiClient } from '../gas-api';
import { createEvmSigner } from '../signers/evm';
import { CASHMERE_CCTP_ADDRESSES, CCTP_DOMAINS, USDC_ADDRESSES, EXPLORER_URLS, EVM_CHAIN_IDS } from '../constants';
import { calculateMaxFee } from '../utils/fee';
import { assertFeeWithinBounds, assertDeadlineFresh } from '../utils/quote';
import { getThreshold } from '../utils/routing';
import type { CctpVersion } from '../types';

const CASHMERE_ABI = [
  {
    inputs: [{ components: [
      { name: 'amount', type: 'uint64' },
      { name: 'fee', type: 'uint128' },
      { name: 'deadline', type: 'uint64' },
      { name: 'gasDropAmount', type: 'uint128' },
      { name: 'destinationDomain', type: 'uint32' },
      { name: 'recipient', type: 'bytes32' },
      { name: 'solanaOwner', type: 'bytes32' },
      { name: 'isNative', type: 'bool' },
      { name: 'signature', type: 'bytes' },
    ], name: '_params', type: 'tuple' }],
    name: 'transfer',
    outputs: [],
    stateMutability: 'payable',
    type: 'function',
  },
  {
    inputs: [{ components: [
      { name: 'amount', type: 'uint64' },
      { name: 'maxFee', type: 'uint256' },
      { name: 'fee', type: 'uint128' },
      { name: 'deadline', type: 'uint64' },
      { name: 'gasDropAmount', type: 'uint128' },
      { name: 'destinationDomain', type: 'uint32' },
      { name: 'minFinalityThreshold', type: 'uint32' },
      { name: 'recipient', type: 'bytes32' },
      { name: 'solanaOwner', type: 'bytes32' },
      { name: 'isNative', type: 'bool' },
      { name: 'hookData', type: 'bytes' },
      { name: 'signature', type: 'bytes' },
    ], name: '_params', type: 'tuple' }],
    name: 'transferV2',
    outputs: [],
    stateMutability: 'payable',
    type: 'function',
  },
] as const;

export async function evmTransfer(opts: {
  privateKey: string;
  rpcUrl?: string;
  srcNetwork: EvmNetwork;
  dstDomain: number;
  amount: bigint;
  recipient: `0x${string}`;
  solanaOwner: `0x${string}`;
  version: CctpVersion;
  feeMode: FeeMode;
  maxFee?: string;
  gasApiClient: GasApiClient;
}): Promise<{ txHash: string; explorerUrl: string }> {
  const {
    privateKey, rpcUrl, srcNetwork, dstDomain, amount,
    recipient, solanaOwner, version, feeMode, maxFee, gasApiClient,
  } = opts;

  const contractAddress = CASHMERE_CCTP_ADDRESSES[srcNetwork];
  if (!contractAddress) throw new Error(`No CashmereCCTP deployed on ${srcNetwork}`);

  const usdcAddress = USDC_ADDRESSES[srcNetwork] as `0x${string}`;
  if (!usdcAddress) throw new Error(`No USDC address for ${srcNetwork}`);

  const srcDomain = CCTP_DOMAINS[srcNetwork];
  const isV2 = version !== 'v1';
  const isNative = feeMode === 'native';

  const { account, walletClient, publicClient } = createEvmSigner(privateKey, srcNetwork, rpcUrl);

  const { fee, deadline, signature } = await gasApiClient.getEcdsaSignature(
    srcDomain, dstDomain, isV2, isNative,
  );

  // The quote decides how much native value leaves the wallet and how long the
  // authorization stays valid, so both are checked against caller intent before signing.
  assertFeeWithinBounds({ fee, amount, isNative, chain: 'evm', maxFee });
  assertDeadlineFresh(deadline);

  const msgValue = isNative ? fee : 0n;

  // In stable mode the contract pulls the fee in USDC on top of the bridged amount, so the
  // allowance has to cover both or the transfer reverts after the approval has been paid for.
  const requiredAllowance = isNative ? amount : amount + fee;

  // Approve USDC if needed
  const allowance = await publicClient.readContract({
    address: usdcAddress,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [account.address, contractAddress],
  });

  if (allowance < requiredAllowance) {
    const approveHash = await walletClient.writeContract({
      address: usdcAddress,
      abi: erc20Abi,
      functionName: 'approve',
      args: [contractAddress, requiredAllowance],
    });
    const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveHash });
    if (approveReceipt.status !== 'success') {
      throw new Error(`USDC approval reverted: ${approveHash}`);
    }
  }

  let txHash: `0x${string}`;

  if (!isV2) {
    txHash = await walletClient.writeContract({
      address: contractAddress,
      abi: CASHMERE_ABI,
      functionName: 'transfer',
      args: [{
        amount,
        fee,
        deadline,
        gasDropAmount: 0n,
        destinationDomain: dstDomain,
        recipient,
        solanaOwner,
        isNative,
        signature,
      }],
      value: msgValue,
    });
  } else {
    const threshold = getThreshold(version);
    const burnFee = await gasApiClient.getBurnFee(srcDomain, dstDomain, threshold);
    const maxFee = calculateMaxFee(amount, burnFee.minimumFee);

    txHash = await walletClient.writeContract({
      address: contractAddress,
      abi: CASHMERE_ABI,
      functionName: 'transferV2',
      args: [{
        amount,
        maxFee,
        fee,
        deadline,
        gasDropAmount: 0n,
        destinationDomain: dstDomain,
        minFinalityThreshold: threshold,
        recipient,
        solanaOwner,
        isNative,
        // Empty calldata, not a single zero byte: a destination that branches on
        // `hookData.length` would treat `0x00` as a malformed hook.
        hookData: '0x',
        signature,
      }],
      value: msgValue,
    });
  }

  // The transfer is only reported as done once it has actually executed. Returning the
  // hash before confirmation makes a reverted burn look successful, and an agent loop
  // that trusts that will either report a bridge that never happened or re-issue it.
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== 'success') {
    throw new Error(`Transfer reverted on ${srcNetwork}: ${txHash}`);
  }

  const explorerBase = EXPLORER_URLS[srcNetwork] ?? '';
  return {
    txHash,
    explorerUrl: `${explorerBase}/tx/${txHash}`,
  };
}

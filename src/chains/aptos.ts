import type { InputEntryFunctionData } from '@aptos-labs/ts-sdk';
import type { CctpVersion, FeeMode } from '../types';
import { GasApiClient } from '../gas-api';
import { createAptosSigner } from '../signers/aptos';
import { getThreshold } from '../utils/routing';
import { calculateMaxFee } from '../utils/fee';
import { CCTP_DOMAINS, APTOS_TRANSFER_MODULE } from '../constants';

export interface AptosTransferPayloadParams {
  dstDomain: number;
  amount: bigint;
  recipient: string;
  solanaOwner: string;
  isNative: boolean;
  fee: string;
  deadline: string;
  signature: Uint8Array;
  // CCTP V2 burn params; without them the payload calls the V1 `transfer_outer`
  v2?: { maxFee: bigint; minFinalityThreshold: number };
}

// `transfer_v2_outer` takes the arguments of `transfer_outer` plus max_fee and min_finality_threshold right
// before the signature, so the fee stays at index 5, where the relayer reads it.
export function aptosTransferPayload(params: AptosTransferPayloadParams): InputEntryFunctionData {
  const { dstDomain, amount, recipient, solanaOwner, isNative, fee, deadline, signature, v2 } = params;

  return {
    function: `${APTOS_TRANSFER_MODULE}::transfer::${v2 ? 'transfer_v2_outer' : 'transfer_outer'}`,
    typeArguments: [],
    functionArguments: [
      amount.toString(),
      isNative ? BigInt(fee).toString() : '0',
      dstDomain,
      recipient,
      solanaOwner,
      fee,
      deadline,
      '0',
      isNative,
      ...(v2 ? [v2.maxFee.toString(), v2.minFinalityThreshold] : []),
      Array.from(signature),
    ],
  };
}

export async function aptosTransfer(opts: {
  privateKey: string;
  rpcUrl?: string;
  dstDomain: number;
  amount: bigint;
  recipient: string;
  solanaOwner: string;
  version: CctpVersion;
  feeMode: FeeMode;
  gasApiClient: GasApiClient;
}): Promise<{ txHash: string; explorerUrl: string }> {
  const {
    privateKey, rpcUrl, dstDomain, amount,
    recipient, solanaOwner, version, feeMode, gasApiClient,
  } = opts;

  const isNative = feeMode === 'native';
  const isV2 = version !== 'v1';
  const { account, client } = createAptosSigner(privateKey, rpcUrl);

  const sigData = await gasApiClient.getEd25519Signature(
    CCTP_DOMAINS.aptos, dstDomain, isNative, isV2 ? 2 : undefined,
  );

  let v2: AptosTransferPayloadParams['v2'];
  if (isV2) {
    const threshold = getThreshold(version);
    const burnFee = await gasApiClient.getBurnFee(CCTP_DOMAINS.aptos, dstDomain, threshold);
    v2 = { maxFee: calculateMaxFee(amount, burnFee.minimumFee), minFinalityThreshold: threshold };
  }

  const transaction = await client.transaction.build.simple({
    sender: account.accountAddress.toString(),
    data: aptosTransferPayload({
      dstDomain,
      amount,
      recipient,
      solanaOwner,
      isNative,
      fee: sigData.fee,
      deadline: sigData.deadline,
      signature: sigData.signature,
      v2,
    }),
  });

  const pendingTx = await client.signAndSubmitTransaction({
    signer: account,
    transaction,
  });

  const result = await client.waitForTransaction({
    transactionHash: pendingTx.hash,
  });

  if ('success' in result && !result.success) {
    throw new Error(`Aptos transfer ${pendingTx.hash} failed: ${result.vm_status}`);
  }

  return {
    txHash: pendingTx.hash,
    explorerUrl: `https://aptoscan.com/transaction/${pendingTx.hash}?network=mainnet`,
  };
}

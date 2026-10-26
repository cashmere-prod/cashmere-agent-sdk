import type { FeeMode } from '../types';
import { GasApiClient } from '../gas-api';
import { createAptosSigner } from '../signers/aptos';
import { CCTP_DOMAINS, APTOS_TRANSFER_MODULE, EXPLORER_URLS } from '../constants';
import { assertFeeWithinBounds, assertDeadlineFresh } from '../utils/quote';

export async function aptosTransfer(opts: {
  privateKey: string;
  rpcUrl?: string;
  dstDomain: number;
  amount: bigint;
  recipient: string;
  solanaOwner: string;
  feeMode: FeeMode;
  maxFee?: string;
  gasApiClient: GasApiClient;
}): Promise<{ txHash: string; explorerUrl: string }> {
  const {
    privateKey, rpcUrl, dstDomain, amount,
    recipient, solanaOwner, feeMode, maxFee, gasApiClient,
  } = opts;

  const isNative = feeMode === 'native';
  const { account, client } = createAptosSigner(privateKey, rpcUrl);

  const sigData = await gasApiClient.getEd25519Signature(
    CCTP_DOMAINS.aptos, dstDomain, isNative,
  );

  // A substituted destination domain would burn the USDC toward a chain the recipient
  // address was never encoded for.
  if (sigData.destinationDomain !== dstDomain) {
    throw new Error(
      `Gas API returned destinationDomain ${sigData.destinationDomain} but the requested ` +
      `route is domain ${dstDomain}; refusing to bridge`,
    );
  }

  assertFeeWithinBounds({
    fee: BigInt(sigData.fee),
    amount,
    isNative,
    chain: 'aptos',
    maxFee,
  });
  assertDeadlineFresh(BigInt(sigData.deadline));

  const transaction = await client.transaction.build.simple({
    sender: account.accountAddress.toString(),
    data: {
      function: `${APTOS_TRANSFER_MODULE}::transfer::transfer_outer`,
      typeArguments: [],
      functionArguments: [
        amount.toString(),
        isNative ? BigInt(sigData.fee).toString() : '0',
        dstDomain,
        recipient,
        solanaOwner,
        sigData.fee,
        sigData.deadline,
        '0',
        isNative,
        Array.from(sigData.signature),
      ],
    },
  });

  const pendingTx = await client.signAndSubmitTransaction({
    signer: account,
    transaction,
  });

  const result = await client.waitForTransaction({
    transactionHash: pendingTx.hash,
  });

  // `waitForTransaction` resolves for reverted transactions too, so the execution status
  // is what decides whether this counts as a completed bridge.
  if (!result.success) {
    throw new Error(
      `Transfer failed on Aptos: ${pendingTx.hash} (${result.vm_status})`,
    );
  }

  return {
    txHash: pendingTx.hash,
    explorerUrl: `https://aptoscan.com/transaction/${pendingTx.hash}?network=mainnet`,
  };
}

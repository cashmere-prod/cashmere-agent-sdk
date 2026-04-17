import type { FeeMode } from '../types';
import { GasApiClient } from '../gas-api';
import { createAptosSigner } from '../signers/aptos';
import { CCTP_DOMAINS, APTOS_TRANSFER_MODULE, EXPLORER_URLS } from '../constants';

export async function aptosTransfer(opts: {
  privateKey: string;
  rpcUrl?: string;
  dstDomain: number;
  amount: bigint;
  recipient: string;
  solanaOwner: string;
  feeMode: FeeMode;
  gasApiClient: GasApiClient;
}): Promise<{ txHash: string; explorerUrl: string }> {
  const {
    privateKey, rpcUrl, dstDomain, amount,
    recipient, solanaOwner, feeMode, gasApiClient,
  } = opts;

  const isNative = feeMode === 'native';
  const { account, client } = createAptosSigner(privateKey, rpcUrl);

  const sigData = await gasApiClient.getEd25519Signature(
    CCTP_DOMAINS.aptos, dstDomain, isNative,
  );

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

  return {
    txHash: pendingTx.hash,
    explorerUrl: `https://aptoscan.com/transaction/${pendingTx.hash}?network=mainnet`,
  };
}

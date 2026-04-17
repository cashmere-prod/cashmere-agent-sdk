import { Transaction, coinWithBalance } from '@mysten/sui/transactions';
import { SUI_CLOCK_OBJECT_ID } from '@mysten/sui/utils';
import type { FeeMode } from '../types';
import { GasApiClient } from '../gas-api';
import { createSuiSigner } from '../signers/sui';
import {
  CCTP_DOMAINS,
  SUI_CASHMERE_PACKAGE,
  SUI_CASHMERE_CONFIG,
  SUI_TMM_PACKAGE,
  SUI_MT_STATE,
  SUI_TMM_STATE,
  SUI_USDC_TREASURY,
  SUI_USDC_TYPE,
  SUI_DENY_LIST,
} from '../constants';

export async function suiTransfer(opts: {
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
  const { keypair, client } = createSuiSigner(privateKey, rpcUrl);

  const sigData = await gasApiClient.getEd25519Signature(
    CCTP_DOMAINS.sui, dstDomain, isNative,
  );

  const senderAddress = keypair.toSuiAddress();
  const tx = new Transaction();

  const cashmerePkg = `${SUI_CASHMERE_PACKAGE}::transfer`;
  const authStruct = `${cashmerePkg}::Auth`;

  const usdcCoin = coinWithBalance({
    type: SUI_USDC_TYPE,
    balance: amount,
  });

  const nativeCoin = tx.splitCoins(tx.gas, [
    tx.pure.u64(isNative ? BigInt(sigData.fee).toString() : '0'),
  ]);

  // Step 1: Cashmere prepare
  const [ticket, depositInfo] = tx.moveCall({
    target: `${cashmerePkg}::prepare_deposit_for_burn_ticket`,
    typeArguments: [SUI_USDC_TYPE],
    arguments: [
      usdcCoin,
      nativeCoin,
      tx.pure.u32(dstDomain),
      tx.pure.address(recipient),
      tx.pure.address(solanaOwner),
      tx.pure.u64(sigData.fee),
      tx.pure.u64(sigData.deadline),
      tx.pure.u64('0'),
      tx.pure.bool(isNative),
      tx.pure.vector('u8', Array.from(sigData.signature)),
      tx.object(SUI_CASHMERE_CONFIG),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });

  // Step 2: Circle burn
  const [burnMessage, message] = tx.moveCall({
    target: `${SUI_TMM_PACKAGE}::deposit_for_burn::deposit_for_burn_with_package_auth`,
    typeArguments: [SUI_USDC_TYPE, authStruct],
    arguments: [
      ticket,
      tx.object(SUI_TMM_STATE),
      tx.object(SUI_MT_STATE),
      tx.object(SUI_DENY_LIST),
      tx.object(SUI_USDC_TREASURY),
    ],
  });

  // Step 3: Cashmere finalize
  tx.moveCall({
    target: `${cashmerePkg}::post_deposit_for_burn`,
    arguments: [
      burnMessage,
      message,
      depositInfo,
      tx.object(SUI_CASHMERE_CONFIG),
    ],
  });

  tx.setSenderIfNotSet(senderAddress);

  const result = await client.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
  });

  const digest = result.digest;

  return {
    txHash: digest,
    explorerUrl: `https://suiscan.xyz/mainnet/tx/${digest}`,
  };
}

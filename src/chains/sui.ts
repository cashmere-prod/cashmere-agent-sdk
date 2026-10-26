import { Transaction, coinWithBalance } from '@mysten/sui/transactions';
import { SUI_CLOCK_OBJECT_ID } from '@mysten/sui/utils';
import type { CctpVersion, FeeMode } from '../types';
import { GasApiClient } from '../gas-api';
import { createSuiSigner } from '../signers/sui';
import { getThreshold } from '../utils/routing';
import { calculateMaxFee } from '../utils/fee';
import {
  CCTP_DOMAINS,
  SUI_CASHMERE_PACKAGE,
  SUI_CASHMERE_PACKAGE_V2,
  SUI_CASHMERE_CONFIG,
  SUI_TMM_PACKAGE,
  SUI_MT_STATE,
  SUI_TMM_STATE,
  SUI_TMM_V2_PACKAGE,
  SUI_TMM_V2_STATE,
  SUI_MT_V2_STATE,
  SUI_USDC_HANDLER_PACKAGE,
  SUI_USDC_HANDLER_STATE,
  SUI_USDC_TREASURY,
  SUI_USDC_TYPE,
  SUI_DENY_LIST,
} from '../constants';

export interface SuiTransferTxParams {
  sender: string;
  dstDomain: number;
  amount: bigint;
  recipient: string;
  solanaOwner: string;
  isNative: boolean;
  fee: string;
  deadline: string;
  signature: Uint8Array;
  // CCTP V2 burn params; without them the transaction uses the V1 flow
  v2?: { maxFee: bigint; minFinalityThreshold: number };
}

// Builds the transfer transaction. V1: Cashmere ticket, Circle V1 burn, Cashmere post-burn event.
// V2: Circle's package-auth flow, in which Cashmere takes its fee and returns a ticket, TokenMessengerMinter V2
// turns it into a burn receipt, the USDC handler burns the coin and `complete_burn` sends the message. The
// ticket, the receipt and the completion ticket can't be stored or dropped, so the calls go in one transaction.
export function buildSuiTransferTx(params: SuiTransferTxParams): Transaction {
  const { sender, dstDomain, amount, recipient, solanaOwner, isNative, fee, deadline, signature, v2 } = params;

  const tx = new Transaction();
  const authStruct = `${SUI_CASHMERE_PACKAGE}::transfer::Auth`;

  const usdcCoin = coinWithBalance({
    type: SUI_USDC_TYPE,
    balance: amount,
  });

  const nativeCoin = tx.splitCoins(tx.gas, [
    tx.pure.u64(isNative ? BigInt(fee).toString() : '0'),
  ]);

  if (v2) {
    const tmmState = tx.object(SUI_TMM_V2_STATE);

    // Step 1: Cashmere takes its fee and returns the burn ticket
    const [ticket] = tx.moveCall({
      target: `${SUI_CASHMERE_PACKAGE_V2}::transfer::prepare_deposit_for_burn_v2`,
      arguments: [
        usdcCoin,
        nativeCoin,
        tx.pure.u32(dstDomain),
        tx.pure.address(recipient),
        tx.pure.address(solanaOwner),
        tx.pure.u64(fee),
        tx.pure.u64(deadline),
        tx.pure.u64('0'),
        tx.pure.bool(isNative),
        tx.pure.u256(v2.maxFee),
        tx.pure.u32(v2.minFinalityThreshold),
        tx.pure.vector('u8', Array.from(signature)),
        tx.object(SUI_CASHMERE_CONFIG),
        tx.object(SUI_CLOCK_OBJECT_ID),
      ],
    });

    // Step 2: Circle V2 turns the ticket into a burn receipt
    const [burnReceipt, burnCoin] = tx.moveCall({
      target: `${SUI_TMM_V2_PACKAGE}::deposit_for_burn::deposit_for_burn_with_package_auth`,
      typeArguments: [SUI_USDC_TYPE, authStruct],
      arguments: [ticket, tmmState],
    });

    // Step 3: the USDC handler burns the coin
    const [completeBurnTicket] = tx.moveCall({
      target: `${SUI_USDC_HANDLER_PACKAGE}::handler::burn`,
      arguments: [
        tx.object(SUI_USDC_HANDLER_STATE),
        burnReceipt,
        burnCoin,
        tx.object(SUI_DENY_LIST),
        tx.object(SUI_USDC_TREASURY),
      ],
    });

    // Step 4: Circle V2 sends the message
    tx.moveCall({
      target: `${SUI_TMM_V2_PACKAGE}::deposit_for_burn::complete_burn`,
      typeArguments: [SUI_USDC_TYPE, `${SUI_USDC_HANDLER_PACKAGE}::handler::Auth`],
      arguments: [completeBurnTicket, tmmState, tx.object(SUI_MT_V2_STATE)],
    });
  } else {
    const cashmerePkg = `${SUI_CASHMERE_PACKAGE}::transfer`;

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
        tx.pure.u64(fee),
        tx.pure.u64(deadline),
        tx.pure.u64('0'),
        tx.pure.bool(isNative),
        tx.pure.vector('u8', Array.from(signature)),
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
  }

  tx.setSender(sender);
  return tx;
}

export async function suiTransfer(opts: {
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
  const { keypair, client } = createSuiSigner(privateKey, rpcUrl);

  const sigData = await gasApiClient.getEd25519Signature(
    CCTP_DOMAINS.sui, dstDomain, isNative, isV2 ? 2 : undefined,
  );

  let v2: SuiTransferTxParams['v2'];
  if (isV2) {
    const threshold = getThreshold(version);
    const burnFee = await gasApiClient.getBurnFee(CCTP_DOMAINS.sui, dstDomain, threshold);
    v2 = { maxFee: calculateMaxFee(amount, burnFee.minimumFee), minFinalityThreshold: threshold };
  }

  const tx = buildSuiTransferTx({
    sender: keypair.toSuiAddress(),
    dstDomain,
    amount,
    recipient,
    solanaOwner,
    isNative,
    fee: sigData.fee,
    deadline: sigData.deadline,
    signature: sigData.signature,
    v2,
  });

  const result = await client.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
  });

  if (result.$kind === 'FailedTransaction') {
    const failed = result.FailedTransaction;
    throw new Error(`Sui transfer ${failed.digest} failed: ${failed.status.error?.message ?? 'unknown error'}`);
  }

  const digest = result.Transaction.digest;

  return {
    txHash: digest,
    explorerUrl: `https://suiscan.xyz/mainnet/tx/${digest}`,
  };
}

import {
  PublicKey,
  Keypair,
  Ed25519Program,
  ComputeBudgetProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Program, BN, utils } from '@coral-xyz/anchor';
import type { FeeMode, CctpVersion } from '../types';
import { GasApiClient } from '../gas-api';
import { createSolanaSigner } from '../signers/solana';
import {
  CCTP_DOMAINS,
  SOLANA_CASHMERE_PROGRAM_ID,
  SOLANA_USDC_MINT,
  SOLANA_ADDRESS_LOOKUP_TABLE,
  SOLANA_MESSAGE_TRANSMITTER_V1,
  SOLANA_TOKEN_MESSENGER_MINTER_V1,
  SOLANA_MESSAGE_TRANSMITTER_V2,
  SOLANA_TOKEN_MESSENGER_MINTER_V2,
} from '../constants';
import { toByteArray } from '../utils/address';
import { calculateMaxFee } from '../utils/fee';
import { getThreshold } from '../utils/routing';
import idl from './cashmere_cctp_idl.json';

function findPda(
  label: string,
  programId: PublicKey,
  extraSeeds?: (string | Buffer | PublicKey)[],
): PublicKey {
  const seeds: Buffer[] = [Buffer.from(utils.bytes.utf8.encode(label))];
  if (extraSeeds) {
    for (const s of extraSeeds) {
      if (typeof s === 'string') seeds.push(Buffer.from(utils.bytes.utf8.encode(s)));
      else if (Buffer.isBuffer(s)) seeds.push(s);
      else seeds.push(s.toBuffer() as Buffer);
    }
  }
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

export async function solanaTransfer(opts: {
  privateKey: string;
  rpcUrl?: string;
  dstDomain: number;
  amount: bigint;
  recipient: number[];
  solanaOwner: number[];
  version: CctpVersion;
  feeMode: FeeMode;
  gasApiClient: GasApiClient;
}): Promise<{ txHash: string; explorerUrl: string }> {
  const {
    privateKey, rpcUrl, dstDomain, amount,
    recipient, solanaOwner, version, feeMode, gasApiClient,
  } = opts;

  const isV2 = version !== 'v1';
  const isNative = feeMode === 'native';
  const { keypair, connection } = createSolanaSigner(privateKey, rpcUrl);

  const programId = new PublicKey(SOLANA_CASHMERE_PROGRAM_ID);
  const usdcMint = new PublicKey(SOLANA_USDC_MINT);
  const mtProgram = new PublicKey(isV2 ? SOLANA_MESSAGE_TRANSMITTER_V2 : SOLANA_MESSAGE_TRANSMITTER_V1);
  const tmmProgram = new PublicKey(isV2 ? SOLANA_TOKEN_MESSENGER_MINTER_V2 : SOLANA_TOKEN_MESSENGER_MINTER_V1);

  const program = new Program(idl as any, { connection });

  const [tokenAccount] = PublicKey.findProgramAddressSync(
    [keypair.publicKey.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), usdcMint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  const configPda = findPda('config', programId);
  const custodianPda = findPda('emitter', programId);
  const remoteTokenMessenger = findPda('remote_token_messenger', tmmProgram, [dstDomain.toString()]);

  const configAccount = await connection.getAccountInfo(configPda);
  if (!configAccount) throw new Error('Cashmere config account not found on Solana');
  const config: any = program.coder.accounts.decode('config', configAccount.data);

  const sigData = await gasApiClient.getEd25519Signature(
    CCTP_DOMAINS.solana, dstDomain, isNative, isV2 ? 2 : 1,
  );

  const signatureIx = Ed25519Program.createInstructionWithPublicKey({
    publicKey: sigData.publicKey,
    message: sigData.message,
    signature: sigData.signature,
  });

  const cctpMessageSigner = new Keypair();

  let transferIx;
  if (!isV2) {
    transferIx = await (program.methods as any)
      .transfer(
        new BN(amount.toString()),
        sigData.destinationDomain,
        recipient,
        solanaOwner,
        new BN(sigData.fee),
        new BN(sigData.deadline),
        new BN(0),
        isNative,
      )
      .accounts({
        ownerTokenAccount: tokenAccount,
        feeCollectorSolAccount: config.feeCollectorSol,
        feeCollectorUsdcAccount: config.feeCollectorUsdc,
        gasDropCollectorSolAccount: config.gasDropCollectorSol,
        gasDropCollectorUsdcAccount: config.gasDropCollectorUsdc,
        owner: keypair.publicKey,
        remoteTokenMessenger,
        burnSource: tokenAccount,
        messageSentEventData: cctpMessageSigner.publicKey,
      })
      .instruction();
  } else {
    const threshold = getThreshold(version);
    const burnFee = await gasApiClient.getBurnFee(CCTP_DOMAINS.solana, dstDomain, threshold);
    const maxFee = calculateMaxFee(amount, burnFee.minimumFee);

    transferIx = await (program.methods as any)
      .transferV2(
        new BN(amount.toString()),
        sigData.destinationDomain,
        recipient,
        solanaOwner,
        new BN(sigData.fee),
        new BN(sigData.deadline),
        new BN(0),
        isNative,
        new BN(maxFee.toString()),
        new BN(threshold),
      )
      .accounts({
        ownerTokenAccount: tokenAccount,
        feeCollectorSolAccount: config.feeCollectorSol,
        feeCollectorUsdcAccount: config.feeCollectorUsdc,
        gasDropCollectorSolAccount: config.gasDropCollectorSol,
        gasDropCollectorUsdcAccount: config.gasDropCollectorUsdc,
        owner: keypair.publicKey,
        remoteTokenMessenger,
        burnSource: tokenAccount,
        messageSentEventData: cctpMessageSigner.publicKey,
        tokenMessengerMinterProgram: tmmProgram,
        messageTransmitterProgram: mtProgram,
      })
      .instruction();
  }

  const computeIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 160_000 });

  const lookupTableResult = await connection.getAddressLookupTable(
    new PublicKey(SOLANA_ADDRESS_LOOKUP_TABLE),
  );
  const lookupTable = lookupTableResult.value;
  if (!lookupTable) throw new Error('Address lookup table not found');

  const blockhash = await connection.getLatestBlockhash('finalized');
  const tx = new VersionedTransaction(
    new TransactionMessage({
      recentBlockhash: blockhash.blockhash,
      payerKey: keypair.publicKey,
      instructions: [computeIx, signatureIx, transferIx],
    }).compileToV0Message([lookupTable]),
  );

  tx.sign([keypair, cctpMessageSigner]);

  const txHash = await connection.sendTransaction(tx);

  return {
    txHash,
    explorerUrl: `https://solscan.io/tx/${txHash}`,
  };
}

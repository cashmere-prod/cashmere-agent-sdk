import { PublicKey } from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { SOLANA_USDC_MINT } from '../constants';

export function toBytes32Hex(address: string): `0x${string}` {
  const clean = address.startsWith('0x') ? address.slice(2) : address;
  return `0x${clean.padStart(64, '0')}` as `0x${string}`;
}

export function toByteArray(hex: string): number[] {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const padded = clean.padStart(64, '0');
  const arr: number[] = [];
  for (let i = 0; i < padded.length; i += 2) {
    arr.push(parseInt(padded.substring(i, i + 2), 16));
  }
  return arr;
}

export function getSolanaRecipientAndOwner(walletAddress: string): {
  recipient: `0x${string}`;
  solanaOwner: `0x${string}`;
} {
  const walletPubkey = new PublicKey(walletAddress);
  const usdcMint = new PublicKey(SOLANA_USDC_MINT);

  const [ata] = PublicKey.findProgramAddressSync(
    [walletPubkey.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), usdcMint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  return {
    recipient: toBytes32Hex(Buffer.from(ata.toBytes()).toString('hex')),
    solanaOwner: toBytes32Hex(Buffer.from(walletPubkey.toBytes()).toString('hex')),
  };
}

export const ZERO_BYTES32: `0x${string}` = `0x${'0'.repeat(64)}` as `0x${string}`;

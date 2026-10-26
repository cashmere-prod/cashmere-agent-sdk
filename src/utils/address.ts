import { PublicKey } from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { isAddress } from 'viem';
import type { Network } from '../types';
import { SOLANA_USDC_MINT, USDC_ADDRESSES, isEvmNetwork } from '../constants';

// Why `recipient` can't receive USDC on `to`, or undefined when it can. CCTP takes any 32 bytes, so an address in
// another chain's format would not fail: the USDC would arrive at an account nobody controls.
export function recipientError(to: Network, recipient: string): string | undefined {
  if (Object.values(USDC_ADDRESSES).some(usdc => usdc.toLowerCase() === recipient.toLowerCase())) {
    return 'the recipient is the USDC token itself, not a wallet';
  }

  if (isEvmNetwork(to)) {
    if (!isAddress(recipient)) return `a ${to} recipient is a 0x address of 40 hex characters, with a valid checksum if mixed-case`;
    if (/^0x0{40}$/.test(recipient)) return 'the recipient is the zero address';
    return undefined;
  }

  if (to === 'solana') {
    let key: PublicKey;
    try {
      key = new PublicKey(recipient);
    } catch {
      return 'a solana recipient is a base58 wallet address';
    }
    // USDC goes to the token account the SDK derives from the wallet; a token account or other program address
    // given here would get a token account of its own that no key can spend from
    if (key.toBase58() !== recipient || !PublicKey.isOnCurve(key.toBytes())) {
      return 'a solana recipient is the wallet (owner) address, not a token account or program address';
    }
    return undefined;
  }

  if (!/^0x[0-9a-fA-F]{64}$/.test(recipient)) {
    return `a ${to} recipient is a 0x address of 64 hex characters; an EVM address can't receive on ${to}`;
  }
  // Aptos and Sui addresses are hashes, so 12 leading zero bytes mean an EVM address padded to 32 bytes
  if (/^0x0{24}/.test(recipient)) {
    return `this is an EVM address padded to 32 bytes, which no ${to} account owns; ask for the recipient's ${to} address`;
  }
  return undefined;
}

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

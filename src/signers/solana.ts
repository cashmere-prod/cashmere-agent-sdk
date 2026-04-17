import { Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { SOLANA_DEFAULT_RPC } from '../constants';

export function createSolanaSigner(
  privateKey: string,
  rpcUrl?: string,
): { keypair: Keypair; connection: Connection } {
  let secretKey: Uint8Array;

  if (privateKey.startsWith('[')) {
    secretKey = new Uint8Array(JSON.parse(privateKey));
  } else if (privateKey.startsWith('0x')) {
    secretKey = new Uint8Array(Buffer.from(privateKey.slice(2), 'hex'));
  } else {
    try {
      secretKey = bs58.decode(privateKey);
    } catch {
      secretKey = new Uint8Array(Buffer.from(privateKey, 'hex'));
    }
  }

  const keypair = Keypair.fromSecretKey(secretKey);
  const connection = new Connection(rpcUrl ?? SOLANA_DEFAULT_RPC, 'confirmed');

  return { keypair, connection };
}

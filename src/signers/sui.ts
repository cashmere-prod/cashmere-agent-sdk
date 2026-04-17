import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

export function createSuiSigner(
  privateKey: string,
  rpcUrl?: string,
): { keypair: Ed25519Keypair; client: SuiClient } {
  const clean = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey;
  const secretKey = Buffer.from(clean, 'hex');
  const keypair = Ed25519Keypair.fromSecretKey(secretKey);

  const client = new SuiClient({ url: rpcUrl ?? getFullnodeUrl('mainnet') });

  return { keypair, client };
}

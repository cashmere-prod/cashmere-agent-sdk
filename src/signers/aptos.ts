import {
  Aptos,
  AptosConfig,
  Network,
  Ed25519PrivateKey,
  Account,
} from '@aptos-labs/ts-sdk';
import { APTOS_DEFAULT_RPC } from '../constants';

export function createAptosSigner(
  privateKey: string,
  rpcUrl?: string,
): { account: Account; client: Aptos } {
  let clean = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey;

  // Aptos CLI generates 64-byte keys (private + public concatenated).
  // Ed25519PrivateKey expects 32 bytes -- take only the first half if 64 bytes given.
  if (clean.length === 128) {
    clean = clean.slice(0, 64);
  }

  const key = new Ed25519PrivateKey(clean);
  const account = Account.fromPrivateKey({ privateKey: key });

  const config = new AptosConfig({
    network: Network.MAINNET,
    fullnode: rpcUrl ?? APTOS_DEFAULT_RPC,
  });
  const client = new Aptos(config);

  return { account, client };
}

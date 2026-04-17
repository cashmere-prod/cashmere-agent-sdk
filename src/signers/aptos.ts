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
  const clean = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey;
  const key = new Ed25519PrivateKey(clean);
  const account = Account.fromPrivateKey({ privateKey: key });

  const config = new AptosConfig({
    network: Network.MAINNET,
    fullnode: rpcUrl ?? APTOS_DEFAULT_RPC,
  });
  const client = new Aptos(config);

  return { account, client };
}

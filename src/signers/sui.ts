import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SUI_DEFAULT_GRPC } from '../constants';

export function createSuiSigner(
  privateKey: string,
  rpcUrl?: string,
): { keypair: Ed25519Keypair; client: SuiGrpcClient } {
  const clean = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey;
  const secretKey = Buffer.from(clean, 'hex');
  const keypair = Ed25519Keypair.fromSecretKey(secretKey);

  // rpcUrl is a gRPC endpoint: Sui fullnodes no longer serve JSON-RPC
  const client = new SuiGrpcClient({ network: 'mainnet', baseUrl: rpcUrl ?? SUI_DEFAULT_GRPC });

  return { keypair, client };
}

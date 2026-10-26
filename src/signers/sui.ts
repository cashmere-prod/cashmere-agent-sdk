import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SUI_DEFAULT_GRPC } from '../constants';

// Sui wallets (Slush, Sui Wallet, `sui keytool export`) export keys as bech32 `suiprivkey1...`; raw keys are hex
function suiKeypair(privateKey: string): Ed25519Keypair {
  if (privateKey.startsWith('suiprivkey')) {
    try {
      return Ed25519Keypair.fromSecretKey(privateKey);
    } catch {
      // The library's message repeats the key it could not decode
      throw new Error('Sui private key is not a valid ed25519 suiprivkey');
    }
  }
  const clean = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey;
  return Ed25519Keypair.fromSecretKey(Buffer.from(clean, 'hex'));
}

export function createSuiSigner(
  privateKey: string,
  rpcUrl?: string,
): { keypair: Ed25519Keypair; client: SuiGrpcClient } {
  const keypair = suiKeypair(privateKey);

  // rpcUrl is a gRPC endpoint: Sui fullnodes no longer serve JSON-RPC
  const client = new SuiGrpcClient({ network: 'mainnet', baseUrl: rpcUrl ?? SUI_DEFAULT_GRPC });

  return { keypair, client };
}

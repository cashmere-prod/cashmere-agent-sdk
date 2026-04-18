export type EvmNetwork =
  | 'ethereum' | 'avalanche' | 'polygon' | 'arbitrum' | 'optimism'
  | 'base' | 'unichain' | 'linea' | 'worldchain' | 'sei'
  | 'sonic' | 'hyperevm' | 'monad';

export type NonEvmNetwork = 'solana' | 'aptos' | 'sui';

export type Network = EvmNetwork | NonEvmNetwork;

export type CctpVersion = 'v1' | 'v2-fast' | 'v2-norm';
export type FeeMode = 'native' | 'stable';

export interface TransferParams {
  from: Network;
  to: Network;
  amount: string;
  recipient: string;
  version?: CctpVersion;
  feeMode?: FeeMode;
}

export interface TransferResult {
  txHash: string;
  explorerUrl: string;
  version: CctpVersion;
  from: Network;
  to: Network;
}

export interface EvmSignerConfig {
  privateKey: string;
  rpcUrl?: string;
}

export interface SolanaSignerConfig {
  privateKey: string;
  rpcUrl?: string;
}

export interface AptosSignerConfig {
  privateKey: string;
  rpcUrl?: string;
}

export interface SuiSignerConfig {
  privateKey: string;
  rpcUrl?: string;
}

export interface CashmereCCTPConfig {
  evm?: EvmSignerConfig;
  solana?: SolanaSignerConfig;
  aptos?: AptosSignerConfig;
  sui?: SuiSignerConfig;
  gasApiUrl?: string;
}

export interface EcdsaSignatureResponse {
  fee: string;
  deadline: string;
  signature: string;
  cctpVersion: string;
}

export interface Ed25519SignatureResponse {
  signature: string;
  message: string;
  publicKey: string;
  destinationDomain: string;
  fee: string;
  deadline: string;
}

export interface BurnFeeResponse {
  finalityThreshold: number;
  minimumFee: number;
}

export interface SimulateParams {
  from: Network;
  to: Network;
  amount: string;
  version?: CctpVersion;
  feeMode?: FeeMode;
}

export interface SimulateResult {
  supported: boolean;
  version: CctpVersion;
  from: Network;
  to: Network;
  estimatedDuration: string;
  estimatedFee: {
    cashmere: string;
    circleBurnBps: number | null;
  };
}

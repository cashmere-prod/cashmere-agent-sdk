import type {
  CashmereCCTPConfig,
  TransferParams,
  TransferResult,
  SimulateParams,
  SimulateResult,
  Network,
  EvmNetwork,
  FeeMode,
} from './types';
import { GasApiClient } from './gas-api';
import {
  CCTP_DOMAINS, isEvmNetwork,
  DURATION_V1, DURATION_V2_FAST, DURATION_V2_NORM,
} from './constants';
import { resolveVersion, getThreshold } from './utils/routing';
import { toBytes32Hex, getSolanaRecipientAndOwner, ZERO_BYTES32, toByteArray } from './utils/address';
import { evmTransfer } from './chains/evm';
import { solanaTransfer } from './chains/solana';
import { aptosTransfer } from './chains/aptos';
import { suiTransfer } from './chains/sui';
import { parseUnits } from 'viem';

export class CashmereCCTP {
  private config: CashmereCCTPConfig;
  private gasApi: GasApiClient;

  constructor(config: CashmereCCTPConfig) {
    this.config = config;
    this.gasApi = new GasApiClient(config.gasApiUrl);
  }

  async transfer(params: TransferParams): Promise<TransferResult> {
    const { from, to, amount, recipient } = params;

    if (from === to) throw new Error(`Cannot transfer to the same chain: ${from}`);
    if (!recipient || recipient.length === 0) throw new Error('Recipient address is required');

    const parsed = Number(amount);
    if (!amount || isNaN(parsed) || parsed <= 0) {
      throw new Error(`Invalid amount: "${amount}" -- must be a positive number`);
    }

    const feeMode: FeeMode = params.feeMode ?? 'native';
    const version = resolveVersion(from, to, params.version);
    const dstDomain = CCTP_DOMAINS[to];
    const amountRaw = parseUnits(amount, 6);

    let recipientBytes32: `0x${string}`;
    let solanaOwnerBytes32: `0x${string}`;

    if (to === 'solana') {
      const { recipient: r, solanaOwner: o } = getSolanaRecipientAndOwner(recipient);
      recipientBytes32 = r;
      solanaOwnerBytes32 = o;
    } else {
      recipientBytes32 = toBytes32Hex(recipient);
      solanaOwnerBytes32 = ZERO_BYTES32;
    }

    let partial: { txHash: string; explorerUrl: string };

    if (isEvmNetwork(from)) {
      if (!this.config.evm) throw new Error('EVM signer config not provided');
      partial = await evmTransfer({
        privateKey: this.config.evm.privateKey,
        rpcUrl: this.config.evm.rpcUrl,
        srcNetwork: from,
        dstDomain,
        amount: amountRaw,
        recipient: recipientBytes32,
        solanaOwner: solanaOwnerBytes32,
        version,
        feeMode,
        gasApiClient: this.gasApi,
      });
    } else if (from === 'solana') {
      if (!this.config.solana) throw new Error('Solana signer config not provided');
      partial = await solanaTransfer({
        privateKey: this.config.solana.privateKey,
        rpcUrl: this.config.solana.rpcUrl,
        dstDomain,
        amount: amountRaw,
        recipient: toByteArray(recipientBytes32),
        solanaOwner: toByteArray(solanaOwnerBytes32),
        version,
        feeMode,
        gasApiClient: this.gasApi,
      });
    } else if (from === 'aptos') {
      if (!this.config.aptos) throw new Error('Aptos signer config not provided');
      partial = await aptosTransfer({
        privateKey: this.config.aptos.privateKey,
        rpcUrl: this.config.aptos.rpcUrl,
        dstDomain,
        amount: amountRaw,
        recipient: recipientBytes32,
        solanaOwner: solanaOwnerBytes32,
        feeMode,
        gasApiClient: this.gasApi,
      });
    } else if (from === 'sui') {
      if (!this.config.sui) throw new Error('Sui signer config not provided');
      partial = await suiTransfer({
        privateKey: this.config.sui.privateKey,
        rpcUrl: this.config.sui.rpcUrl,
        dstDomain,
        amount: amountRaw,
        recipient: recipientBytes32,
        solanaOwner: solanaOwnerBytes32,
        feeMode,
        gasApiClient: this.gasApi,
      });
    } else {
      throw new Error(`Unsupported source network: ${from}`);
    }

    return { ...partial, version, from, to };
  }

  async simulate(params: SimulateParams): Promise<SimulateResult> {
    const { from, to, amount } = params;

    if (from === to) {
      return { supported: false, version: 'v1', from, to, estimatedDuration: 'N/A', estimatedFee: { cashmere: '0', circleBurnBps: null } };
    }

    let version: import('./types').CctpVersion;
    try {
      version = resolveVersion(from, to, params.version);
    } catch {
      return { supported: false, version: 'v1', from, to, estimatedDuration: 'N/A', estimatedFee: { cashmere: '0', circleBurnBps: null } };
    }

    const durationMap = version === 'v2-fast' ? DURATION_V2_FAST
      : version === 'v2-norm' ? DURATION_V2_NORM
      : DURATION_V1;
    const estimatedDuration = durationMap[from] ?? '~15 minutes';

    let cashmereFee = '0';
    let circleBurnBps: number | null = null;
    const srcDomain = CCTP_DOMAINS[from];
    const dstDomain = CCTP_DOMAINS[to];
    const isNative = (params.feeMode ?? 'native') === 'native';
    const isV2 = version !== 'v1';

    try {
      if (isEvmNetwork(from)) {
        const sig = await this.gasApi.getEcdsaSignature(srcDomain, dstDomain, isV2, isNative);
        cashmereFee = isNative
          ? `${sig.fee} wei (native)`
          : `${Number(sig.fee) / 1e6} USDC`;
      } else {
        const sig = await this.gasApi.getEd25519Signature(srcDomain, dstDomain, isNative, isV2 ? 2 : 1);
        cashmereFee = isNative
          ? `${sig.fee} (native smallest unit)`
          : `${Number(sig.fee) / 1e6} USDC`;
      }

      if (isV2) {
        const threshold = getThreshold(version);
        const burnFee = await this.gasApi.getBurnFee(srcDomain, dstDomain, threshold);
        circleBurnBps = burnFee.minimumFee;
      }
    } catch {
      cashmereFee = 'unable to fetch';
    }

    return {
      supported: true,
      version,
      from,
      to,
      estimatedDuration,
      estimatedFee: { cashmere: cashmereFee, circleBurnBps },
    };
  }
}

// Re-export types and utilities
export type {
  CashmereCCTPConfig,
  TransferParams,
  TransferResult,
  SimulateParams,
  SimulateResult,
  Network,
  EvmNetwork,
  NonEvmNetwork,
  CctpVersion,
  FeeMode,
} from './types';

export { CCTP_DOMAINS, CASHMERE_CCTP_ADDRESSES, USDC_ADDRESSES, EXPLORER_URLS, ALL_NETWORKS, isEvmNetwork } from './constants';
export { isV1Supported, isV2Supported, isV2FastSupported, isV2NormSupported, resolveVersion } from './utils/routing';
export { GasApiClient } from './gas-api';
export { bridgeToolSchema, simulateToolSchema } from './tool-schema';

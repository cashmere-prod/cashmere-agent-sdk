import {
  createWalletClient,
  createPublicClient,
  http,
  type Account,
  type PublicClient,
  type WalletClient,
  type Chain,
  type Transport,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  mainnet, avalanche, polygon, arbitrum, optimism,
  base, linea,
} from 'viem/chains';
import type { EvmNetwork } from '../types';
import { EVM_CHAIN_IDS, DEFAULT_RPC_URLS } from '../constants';

const KNOWN_CHAINS: Partial<Record<EvmNetwork, Chain>> = {
  ethereum: mainnet,
  avalanche,
  polygon,
  arbitrum,
  optimism,
  base,
  linea,
};

function buildChain(network: EvmNetwork, rpcUrl: string): Chain {
  const known = KNOWN_CHAINS[network];
  if (known) return known;

  return {
    id: EVM_CHAIN_IDS[network],
    name: network,
    nativeCurrency: { name: network, symbol: network.toUpperCase(), decimals: 18 },
    rpcUrls: {
      default: { http: [rpcUrl] },
    },
  } as Chain;
}

export function createEvmSigner(
  privateKey: string,
  network: EvmNetwork,
  rpcUrl?: string,
): {
  account: Account;
  walletClient: WalletClient<Transport, Chain, Account>;
  publicClient: PublicClient<Transport, Chain>;
} {
  const key = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  const account = privateKeyToAccount(key as `0x${string}`);
  const resolvedRpc = rpcUrl ?? DEFAULT_RPC_URLS[network];
  const chain = buildChain(network, resolvedRpc);
  const transport = http(resolvedRpc);

  const walletClient = createWalletClient({
    account,
    chain,
    transport,
  });

  const publicClient = createPublicClient({
    chain,
    transport,
  });

  return { account, walletClient, publicClient };
}

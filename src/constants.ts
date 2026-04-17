import type { Network, EvmNetwork } from './types';

export const GAS_API_URL = 'https://gas.cashmere.exchange';

export const CCTP_DOMAINS: Record<Network, number> = {
  ethereum: 0,
  avalanche: 1,
  optimism: 2,
  arbitrum: 3,
  solana: 5,
  base: 6,
  polygon: 7,
  sui: 8,
  aptos: 9,
  unichain: 10,
  linea: 11,
  sonic: 13,
  worldchain: 14,
  monad: 15,
  sei: 16,
  hyperevm: 19,
};

export const EVM_CHAIN_IDS: Record<EvmNetwork, number> = {
  ethereum: 1,
  avalanche: 43114,
  polygon: 137,
  arbitrum: 42161,
  optimism: 10,
  base: 8453,
  unichain: 130,
  linea: 59144,
  worldchain: 480,
  sei: 1329,
  sonic: 146,
  hyperevm: 999,
  monad: 143,
};

export const CASHMERE_CCTP_ADDRESSES: Partial<Record<EvmNetwork, `0x${string}`>> = {
  ethereum:   '0xD156fFB54871F4562744d6Be5d6321B5BffCa3B6',
  avalanche:  '0xD156fFB54871F4562744d6Be5d6321B5BffCa3B6',
  polygon:    '0xD156fFB54871F4562744d6Be5d6321B5BffCa3B6',
  arbitrum:   '0x3412ef459221d1581a08dcD56Ee55B8FaeBf5eEA',
  optimism:   '0xD156fFB54871F4562744d6Be5d6321B5BffCa3B6',
  base:       '0xD156fFB54871F4562744d6Be5d6321B5BffCa3B6',
  unichain:   '0xd002a7172Ac6f90657FCb918B3f7e36372a4bA80',
  linea:      '0xD156fFB54871F4562744d6Be5d6321B5BffCa3B6',
  worldchain: '0xD156fFB54871F4562744d6Be5d6321B5BffCa3B6',
  sei:        '0xD156fFB54871F4562744d6Be5d6321B5BffCa3B6',
  sonic:      '0xD156fFB54871F4562744d6Be5d6321B5BffCa3B6',
  hyperevm:   '0x15b2810232ec96ff083ca6d8b785cb930d241d83',
  monad:      '0xD156fFB54871F4562744d6Be5d6321B5BffCa3B6',
};

export const USDC_ADDRESSES: Partial<Record<Network, string>> = {
  ethereum:   '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  avalanche:  '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
  polygon:    '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  arbitrum:   '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  optimism:   '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  base:       '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  unichain:   '0x078D782b760474a361dDA0AF3839290b0EF57AD6',
  linea:      '0x176211869cA2b568f2A7D4EE941E073a821EE1ff',
  worldchain: '0x79A02482A880bCe3F13E09da970dC34dB4cD24D1',
  sei:        '0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392',
  sonic:      '0x29219dd400f2Bf60E5a23d13Be72B486D4038894',
  hyperevm:   '0xb88339CB7199b77E23DB6E890353E22632Ba630f',
  monad:      '0x754704Bc059F8C67012fEd69BC8A327a5aafb603',
  solana:     'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  aptos:      '0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b',
  sui:        '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
};

export const EXPLORER_URLS: Partial<Record<Network, string>> = {
  ethereum:   'https://etherscan.io',
  avalanche:  'https://snowtrace.io',
  polygon:    'https://polygonscan.com',
  arbitrum:   'https://arbiscan.io',
  optimism:   'https://optimistic.etherscan.io',
  base:       'https://basescan.org',
  unichain:   'https://uniscan.xyz',
  linea:      'https://lineascan.build',
  worldchain: 'https://worldscan.org',
  sei:        'https://seitrace.com',
  sonic:      'https://sonicscan.org',
  hyperevm:   'https://hyperevmscan.io',
  monad:      'https://monadvision.com',
  solana:     'https://solscan.io',
  aptos:      'https://aptoscan.com',
  sui:        'https://suiscan.xyz',
};

// Solana program IDs
export const SOLANA_CASHMERE_PROGRAM_ID = '5RsvKL6LFq6yEFiAXEwgYHAN3aLFypeB4AaafdeDnHqM';
export const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const SOLANA_ADDRESS_LOOKUP_TABLE = '865YCTTsymGpBjLMTvjd3T3RCGT8yvxnAHhyKZqRFfLi';
export const SOLANA_MESSAGE_TRANSMITTER_V1 = 'CCTPmbSD7gX1bxKPAmg77w8oFzNFpaQiQUWD43TKaecd';
export const SOLANA_TOKEN_MESSENGER_MINTER_V1 = 'CCTPiPYPc6AsJuwueEnWgSgucamXDZwBd53dQ11YiKX3';
export const SOLANA_MESSAGE_TRANSMITTER_V2 = 'CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC';
export const SOLANA_TOKEN_MESSENGER_MINTER_V2 = 'CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe';

// Aptos
export const APTOS_TRANSFER_MODULE = '0xe49afb1896889e3e1dd7bcbb9e31d1df8221899d3d368e98588ac6b4d84b136d';

// Sui
export const SUI_CASHMERE_PACKAGE = '0xdf37112aacb7d3535f7b3b754b9a7b9fa1a6b3a756288dc734522c603c6f11a4';
export const SUI_CASHMERE_CONFIG = '0x5f1b2e205777713f44a99894d98e1e66e33dc11ff88e50108c94ee79b7ea3d67';
export const SUI_TMM_PACKAGE = '0x2aa6c5d56376c371f88a6cc42e852824994993cb9bab8d3e6450cbe3cb32b94e';
export const SUI_MT_STATE = '0xf68268c3d9b1df3215f2439400c1c4ea08ac4ef4bb7d6f3ca6a2a239e17510af';
export const SUI_TMM_STATE = '0x45993eecc0382f37419864992c12faee2238f5cfe22b98ad3bf455baf65c8a2f';
export const SUI_USDC_TREASURY = '0x57d6725e7a8b49a7b2a612f6bd66ab5f39fc95332ca48be421c3229d514a6de7';
export const SUI_USDC_TYPE = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
export const SUI_DENY_LIST = '0x403';

export const DEFAULT_RPC_URLS: Record<EvmNetwork, string> = {
  ethereum:   'https://ethereum-rpc.publicnode.com',
  arbitrum:   'https://arb1.arbitrum.io/rpc',
  avalanche:  'https://1rpc.io/avax/c',
  polygon:    'https://polygon.drpc.org',
  base:       'https://mainnet.base.org',
  optimism:   'https://gateway.tenderly.co/public/optimism',
  linea:      'https://1rpc.io/linea',
  unichain:   'https://unichain-rpc.publicnode.com',
  worldchain: 'https://worldchain-mainnet.g.alchemy.com/public',
  sei:        'https://sei.drpc.org',
  sonic:      'https://sonic.api.pocket.network',
  hyperevm:   'https://rpc.hyperliquid.xyz/evm',
  monad:      'https://rpc3.monad.xyz',
};

export const SOLANA_DEFAULT_RPC = 'https://api.mainnet-beta.solana.com';
export const APTOS_DEFAULT_RPC = 'https://api.mainnet.aptoslabs.com/v1';

export const EVM_NETWORKS: EvmNetwork[] = [
  'ethereum', 'avalanche', 'polygon', 'arbitrum', 'optimism',
  'base', 'unichain', 'linea', 'worldchain', 'sei',
  'sonic', 'hyperevm', 'monad',
];

export function isEvmNetwork(network: Network): network is EvmNetwork {
  return EVM_NETWORKS.includes(network as EvmNetwork);
}

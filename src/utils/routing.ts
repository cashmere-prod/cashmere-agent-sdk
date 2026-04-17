import type { Network, CctpVersion } from '../types';
import { isEvmNetwork } from '../constants';

const V1_UNSUPPORTED: Network[] = [
  'linea', 'worldchain', 'sei', 'sonic', 'hyperevm', 'monad',
];

const V2_FAST_UNSUPPORTED_SOURCES: Network[] = [
  'avalanche', 'sei', 'sonic', 'polygon', 'solana', 'hyperevm', 'monad',
];

export function isV1Supported(from: Network, to: Network): boolean {
  if (V1_UNSUPPORTED.includes(from) || V1_UNSUPPORTED.includes(to)) return false;

  const fromEvm = isEvmNetwork(from);
  const toEvm = isEvmNetwork(to);

  if (fromEvm && toEvm) return true;
  if (fromEvm && to === 'solana') return true;
  if (from === 'solana' && toEvm) return true;
  if (fromEvm && (to === 'aptos' || to === 'sui')) return true;
  if ((from === 'aptos' || from === 'sui') && toEvm) return true;

  const nonEvmPairs: [Network, Network][] = [
    ['aptos', 'solana'], ['solana', 'aptos'],
    ['aptos', 'sui'], ['sui', 'aptos'],
    ['sui', 'solana'], ['solana', 'sui'],
  ];
  return nonEvmPairs.some(([a, b]) => a === from && b === to);
}

export function isV2Supported(from: Network, to: Network): boolean {
  const fromEvm = isEvmNetwork(from);
  const toEvm = isEvmNetwork(to);

  return (
    (fromEvm && toEvm) ||
    (fromEvm && to === 'solana') ||
    (from === 'solana' && toEvm)
  );
}

export function isV2FastSupported(from: Network, to: Network): boolean {
  return isV2Supported(from, to) && !V2_FAST_UNSUPPORTED_SOURCES.includes(from);
}

export function isV2NormSupported(from: Network, to: Network): boolean {
  return isV2Supported(from, to);
}

export function resolveVersion(from: Network, to: Network, requested?: CctpVersion): CctpVersion {
  if (requested === 'v2-fast' && isV2FastSupported(from, to)) return 'v2-fast';
  if (requested === 'v2-norm' && isV2NormSupported(from, to)) return 'v2-norm';
  if (requested === 'v1' && isV1Supported(from, to)) return 'v1';

  if (isV2FastSupported(from, to)) return 'v2-fast';
  if (isV2NormSupported(from, to)) return 'v2-norm';
  if (isV1Supported(from, to)) return 'v1';

  throw new Error(`No CCTP version supported for ${from} -> ${to}`);
}

export function getThreshold(version: CctpVersion): number {
  switch (version) {
    case 'v2-fast': return 1000;
    case 'v2-norm': return 2000;
    case 'v1': return 0;
  }
}

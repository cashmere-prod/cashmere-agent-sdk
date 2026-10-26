import type { Network } from '../types';

// The Gas API's fee is paid as quoted, as the transaction's native value or out of the USDC, and only the quote's
// signer limits it. These caps refuse a wrong or hostile quote before anything is signed. They sit about 200 times
// above the quotes of Oct 2026 (about $0.25, so roughly $50), in the source chain's smallest native unit.
const ETH = 20_000_000_000_000_000n; // 0.02 ETH
const E18 = 1_000_000_000_000_000_000n;
export const MAX_NATIVE_FEE: Record<Network, bigint> = {
  ethereum: ETH, arbitrum: ETH, optimism: ETH, base: ETH, unichain: ETH, linea: ETH, worldchain: ETH,
  avalanche: 5n * E18,          // 5 AVAX
  polygon: 500n * E18,          // 500 POL
  sonic: 1_000n * E18,          // 1,000 S
  monad: 2_000n * E18,          // 2,000 MON
  sei: 1_000n * E18,            // 1,000 SEI
  hyperevm: E18 / 2n,           // 0.5 HYPE
  solana: 500_000_000n,         // 0.5 SOL, in lamports
  aptos: 6_000_000_000n,        // 60 APT, in octas
  sui: 50_000_000_000n,         // 50 SUI, in MIST
};

// 10 USDC, against 0.19 USDC quoted in Oct 2026
export const MAX_STABLE_FEE = 10_000_000n;

// Quotes expire about two minutes out
const MAX_DEADLINE_AHEAD_SECONDS = 3_600;
const CLOCK_SKEW_SECONDS = 60;

// Refuses a Gas API quote that doesn't match the request or is out of bounds. Everything here runs before signing,
// so the messages say "Not sent".
export function checkQuote(
  quote: { fee: bigint; deadline: bigint; destinationDomain?: number },
  request: { from: Network; dstDomain: number; amount: bigint; isNative: boolean },
  now = Math.floor(Date.now() / 1000),
): void {
  const { fee, deadline, destinationDomain } = quote;
  const { from, dstDomain, amount, isNative } = request;

  if (destinationDomain !== undefined && destinationDomain !== dstDomain) {
    throw new Error(`Not sent: the Gas API quote is for CCTP domain ${destinationDomain}, not the requested ${dstDomain}`);
  }
  if (isNative && fee > MAX_NATIVE_FEE[from]) {
    throw new Error(`Not sent: the Gas API quoted a native fee of ${fee} on ${from}, above the SDK's cap of ${MAX_NATIVE_FEE[from]}`);
  }
  if (!isNative && (fee > MAX_STABLE_FEE || fee >= amount)) {
    throw new Error(`Not sent: the Gas API quoted a USDC fee of ${fee} (6 decimals) for an amount of ${amount}`);
  }
  if (deadline < BigInt(now - CLOCK_SKEW_SECONDS)) {
    throw new Error('Not sent: the Gas API quote has already expired');
  }
  if (deadline > BigInt(now + MAX_DEADLINE_AHEAD_SECONDS)) {
    throw new Error('Not sent: the Gas API quote expires more than an hour from now');
  }
}

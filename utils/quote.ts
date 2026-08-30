import { MAX_DEADLINE_SKEW_SECONDS } from '../constants';

/**
 * Default ceilings on the native-token fee the quote service is allowed to charge, in the
 * smallest unit of each chain's native asset.
 *
 * These are safety rails, not price estimates. The gas API returns a `fee` that the SDK
 * forwards as `msg.value` (or its equivalent), so without a bound a wrong or hostile
 * response can drain the signer's entire native balance in a transaction the caller
 * believes has a fixed, small cost. Callers who legitimately need a larger fee pass an
 * explicit `maxFee` on `TransferParams`.
 */
export const DEFAULT_MAX_NATIVE_FEE = {
  /// 0.1 of an 18-decimal EVM native token.
  evm: 100_000_000_000_000_000n,
  /// 1 SOL, in lamports.
  solana: 1_000_000_000n,
  /// 1 APT, in octas.
  aptos: 100_000_000n,
  /// 1 SUI, in MIST.
  sui: 1_000_000_000n,
} as const;

export type NativeFeeChain = keyof typeof DEFAULT_MAX_NATIVE_FEE;

/**
 * Rejects a quote whose fee exceeds what the caller agreed to pay.
 *
 * `isNative` selects the unit the fee is denominated in: the chain's native asset, or
 * USDC taken out of the transfer itself. In the USDC case the fee is additionally required
 * to be strictly below the amount, because a fee equal to the amount leaves nothing to
 * bridge and the contracts reject that with a less obvious error.
 */
export function assertFeeWithinBounds(opts: {
  fee: bigint;
  amount: bigint;
  isNative: boolean;
  chain: NativeFeeChain;
  maxFee?: string;
}): void {
  const { fee, amount, isNative, chain, maxFee } = opts;

  if (fee < 0n) {
    throw new Error(`Gas API returned a negative fee: ${fee}`);
  }

  if (maxFee !== undefined) {
    let bound: bigint;
    try {
      bound = BigInt(maxFee);
    } catch {
      throw new Error(`Invalid maxFee: "${maxFee}" must be an integer string`);
    }
    if (fee > bound) {
      throw new Error(
        `Refusing to bridge: quoted fee ${fee} exceeds the maxFee of ${bound} you specified`,
      );
    }
    return;
  }

  if (isNative) {
    const bound = DEFAULT_MAX_NATIVE_FEE[chain];
    if (fee > bound) {
      throw new Error(
        `Refusing to bridge: quoted native fee ${fee} exceeds the built-in safety cap of ` +
        `${bound} for ${chain}. Pass an explicit maxFee if this is expected.`,
      );
    }
    return;
  }

  if (fee >= amount) {
    throw new Error(
      `Refusing to bridge: quoted USDC fee ${fee} is not less than the transfer amount ${amount}`,
    );
  }
}

/**
 * Rejects a `deadline` that has already passed or that sits implausibly far in the future.
 *
 * An expired deadline means a guaranteed on-chain revert, so failing here saves the gas.
 * An over-long one is reported because the deadline is the only expiry on the signed quote.
 */
export function assertDeadlineFresh(deadline: bigint): void {
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (deadline <= now) {
    throw new Error(
      `Gas API returned an expired deadline (${deadline}, now ${now}); the quote would revert`,
    );
  }
  if (deadline - now > BigInt(MAX_DEADLINE_SKEW_SECONDS)) {
    throw new Error(
      `Gas API returned a deadline ${deadline - now}s in the future, which exceeds the ` +
      `${MAX_DEADLINE_SKEW_SECONDS}s limit this SDK accepts`,
    );
  }
}

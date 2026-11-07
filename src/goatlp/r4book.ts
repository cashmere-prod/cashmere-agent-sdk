// The Goat LP contracts of November 2026 (release r4): each one's address and runtime code hash.
// Every value here is a placeholder (all zero) until the switch. `tools/fill-r4.mjs` writes the deployed values into this
// file from the deploy manifest and the chain, and writes nothing when any read fails. While one value is a placeholder,
// the tools turn no rule on; reads and stops work on the earlier contracts (./constants.ts, R3_PINS).
// This file imports nothing, so the fill tool can rewrite it alone.

export interface R4Entry { address: `0x${string}`; codehash: `0x${string}` }

export interface R4Book {
  /** 'r4-unfilled' until the fill tool runs; then 'r4' and the block the values were read at */
  label: string;
  readAtBlock: number;
  autoCompoundV3: R4Entry;
  autoCompoundV4: R4Entry;
  rangeExitV3: R4Entry;
  exitV3: R4Entry;
  rangeExitV4: R4Entry;
  engine: R4Entry;
  compoundorV4: R4Entry;
  registry: R4Entry;
  pairTable: R4Entry;
  priceAnchor: R4Entry;
}

const Z: `0x${string}` = '0x0000000000000000000000000000000000000000';
const ZH: `0x${string}` = '0x0000000000000000000000000000000000000000000000000000000000000000';

// FILL-BEGIN (tools/fill-r4.mjs replaces the lines up to FILL-END)
export const R4_BOOK: R4Book = {
  label: 'r4-unfilled',
  readAtBlock: 0,
  autoCompoundV3: { address: Z, codehash: ZH },
  autoCompoundV4: { address: Z, codehash: ZH },
  rangeExitV3: { address: Z, codehash: ZH },
  exitV3: { address: Z, codehash: ZH },
  rangeExitV4: { address: Z, codehash: ZH },
  engine: { address: Z, codehash: ZH },
  compoundorV4: { address: Z, codehash: ZH },
  registry: { address: Z, codehash: ZH },
  pairTable: { address: Z, codehash: ZH },
  priceAnchor: { address: Z, codehash: ZH },
};
// FILL-END

/**
 * Review switches, kept outside the fill block: the fill tool never changes them.
 * autoRange: the agent tools' auto-range on r4 (a permission for all positions, no move limit). false until that port is
 * reviewed: an automation is offered whole or not at all. Stops of auto-range rules are open either way.
 */
export const R4_REVIEW = { autoRange: false };

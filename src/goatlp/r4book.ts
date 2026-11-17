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
  label: 'r4',
  readAtBlock: 113318274,
  autoCompoundV3: { address: '0x677690f3Fe316dea300e42434c50aca25F8C2223', codehash: '0xee9bfecaa6fa45fe5eac82b6234199333290d94b8d9559e6d36e45656ed47dfd' },
  autoCompoundV4: { address: '0x3aEE50cf7e605C77FD8FE26e5BAF3B090819D840', codehash: '0x92bc6b3c79c59addb7ca655879a10d4ff1b2b8cbc79af98651b9cdd3148c6921' },
  rangeExitV3: { address: '0x6D31b7399126732426fAb7ee2fF5e20cF6E95Fd3', codehash: '0xfe84d1b9b597d248a3154af72395b8d88f233cfc28bbd8b70fd76cb8443f5701' },
  exitV3: { address: '0xA5CC5A1F3Ba1Ed949EdAfEAdD021d0d0F7B670CC', codehash: '0x2b0f47c159516c7013c404e9929fdc2a5c9eee1ae2bde6b49f94061fa479122e' },
  rangeExitV4: { address: '0x64eFB4C6b95c0AaEd09F85f0918B22eBa51E4F08', codehash: '0xe6fc8920408143afb99de83360133b95956e8ec33d4bbc5369a1cbac92a026f3' },
  engine: { address: '0xE772E4dFE436F14F3Bec6733Dc29A47A2741DDB2', codehash: '0x931fc993123b24ecfd8d681c0188f0442698a76efaac8c626a5bb53052d6b3a1' },
  compoundorV4: { address: '0x98658FA3fe09195eD7b6F838D2627F2e840B8D50', codehash: '0xe595e7e1555bbae735d61381d6b90c0f5b906ab1a5e55488989ebad61b6ce8e1' },
  registry: { address: '0xa5685AF166e3529FEd41419ae26c02AA3Ac929e9', codehash: '0xbf33fcd7b6f085b08dafc548d9d4bf864437cf8be06608c204991c92a0afeba9' },
  pairTable: { address: '0x6a56E90e9d5d63fFFA024BEcfe9e43B610591160', codehash: '0x2bece25ddcc947d2d63b1c29448eb2fd74ba306ef95b9ed88960efab26f723c1' },
  priceAnchor: { address: '0x3cdcD4F72Fa74721953e4D94C4f571D623235e55', codehash: '0x62c3a818de9575e8c50dce7bf70aed7eb7cb2d4d4fd17b63bd0b49e32c18bb1b' },
};
// FILL-END

/**
 * Review switches, kept outside the fill block: the fill tool never changes them.
 * autoRange: the agent tools' auto-range on r4 (a permission for all positions, no move limit). false until that port is
 * reviewed: an automation is offered whole or not at all. Stops of auto-range rules are open either way.
 */
export const R4_REVIEW = { autoRange: false };

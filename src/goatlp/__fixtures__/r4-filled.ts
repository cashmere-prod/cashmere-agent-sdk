// Test preload: fills the r4 book with test addresses and code hashes before any module reads it (node --import), so a test
// file sees a filled build. Auto-range stays closed (its review switch is off), as in the first filled release.
import { getAddress, keccak256, toHex } from 'viem';
import { R4_BOOK, type R4Book } from '../r4book';

const KEYS = ['autoCompoundV3', 'autoCompoundV4', 'rangeExitV3', 'exitV3', 'rangeExitV4', 'engine', 'compoundorV4', 'registry', 'pairTable', 'priceAnchor'] as const;
export const TEST_R4: Record<(typeof KEYS)[number], { address: `0x${string}`; codehash: `0x${string}` }> = Object.fromEntries(KEYS.map((k, i) => [k, {
  address: getAddress(`0x4a${'00'.repeat(18)}${(i + 1).toString(16).padStart(2, '0')}`),
  codehash: keccak256(toHex(`r4-test-${k}`)),
}])) as never;

const book = R4_BOOK as R4Book;
book.label = 'r4-test';
book.readAtBlock = 1;
for (const k of KEYS) book[k] = TEST_R4[k];

// Test preload: puts every r4 value back to its placeholder (all zero) before any module reads it (node --import), so a
// test file sees the build as published before the switch, whatever values src/goatlp/r4book.ts carries now.
import { R4_BOOK, type R4Book } from '../r4book';

const Z: `0x${string}` = '0x0000000000000000000000000000000000000000';
const ZH: `0x${string}` = '0x0000000000000000000000000000000000000000000000000000000000000000';
const KEYS = ['autoCompoundV3', 'autoCompoundV4', 'rangeExitV3', 'exitV3', 'rangeExitV4', 'engine', 'compoundorV4', 'registry', 'pairTable', 'priceAnchor'] as const;

const book = R4_BOOK as R4Book;
book.label = 'r4-unfilled';
book.readAtBlock = 0;
for (const k of KEYS) book[k] = { address: Z, codehash: ZH };

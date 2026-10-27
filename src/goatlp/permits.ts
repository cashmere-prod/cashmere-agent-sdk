// v4 auto-compound signed messages. One EIP-712 `Permit(address spender,uint256 tokenId,uint256 nonce,uint256 deadline)` on
// the Uniswap v4 position NFT per run, spender GoatAutoCompoundV4, deadline at most 90 days away.
//
// Nonces: a position's messages live in its own window of nonce words, base = permitWord(GoatAutoCompoundV4, tokenId) and the
// 15 words after it. Each signing session takes a fresh word (bitmap 0 on chain and not used by a recorded session) and signs
// bits 0..N-1 of it (N <= 30). So "signed and unused" is always bits 0..size-1 of each session word minus the used bits, and a
// stop can cancel exactly those, even when the keeper store and the local record are both gone (the scan fallback below).
import { domainSeparator, encodeAbiParameters, keccak256, type Address, type Hex, type TypedDataDomain } from 'viem';
import { PERMIT_TYPES, POSM_DOMAIN_NAME } from './abis';
import { GOAT_CHAIN_ID, MAX_RUNS_PER_SESSION, POSM, SESSION_WORDS_MAX } from './constants';

/** The nonce-word rule every Goat LP app follows, so a stop finds every message: word = uint248(keccak(tag, spender, id)) */
export const PERMIT_NONCE_TAG = 'goat.permit.v1';

export function permitWord(spender: Address, tokenId: bigint): bigint {
  return BigInt(keccak256(encodeAbiParameters(
    [{ type: 'string' }, { type: 'address' }, { type: 'uint256' }], [PERMIT_NONCE_TAG, spender, tokenId],
  ))) >> 8n;
}

export interface PermitMessage { spender: Address; tokenId: bigint; nonce: bigint; deadline: bigint }
export interface PermitTypedData {
  domain: { name: string; chainId: number; verifyingContract: Address };
  types: typeof PERMIT_TYPES;
  primaryType: 'Permit';
  message: PermitMessage;
}

export const POSM_DOMAIN = Object.freeze({ name: POSM_DOMAIN_NAME, chainId: GOAT_CHAIN_ID, verifyingContract: POSM });
/** The domain separator the position NFT must report on chain before anything is signed */
export const expectedDomainSeparator = (): Hex => domainSeparator({ domain: POSM_DOMAIN as TypedDataDomain });

export function permitTypedData(m: PermitMessage): PermitTypedData {
  return { domain: { ...POSM_DOMAIN }, types: PERMIT_TYPES, primaryType: 'Permit', message: { ...m } };
}

export const nonceOf = (word: bigint, bit: number): bigint => (word << 8n) | BigInt(bit);
/** Is `word` inside the position's window: base .. base + 15? */
export const isSessionWord = (base: bigint, word: bigint): boolean => word >= base && word < base + BigInt(SESSION_WORDS_MAX);
/** Only the sessions whose word is inside the window (a store answer cannot steer what is signed or cancelled) */
export const ownSessions = <T extends { word: bigint }>(base: bigint, sessions: readonly T[]): T[] => sessions.filter((s) => isSessionWord(base, s.word));
export const isUsed = (bitmap: bigint, bit: number): boolean => ((bitmap >> BigInt(bit)) & 1n) === 1n;

/** The nonces of one session: bits 0..count-1 of its word. */
export function sessionNonces(word: bigint, count: number): bigint[] {
  if (!Number.isInteger(count) || count < 1 || count > MAX_RUNS_PER_SESSION) throw new Error('session size out of range');
  return Array.from({ length: count }, (_, b) => nonceOf(word, b));
}

/** The first fresh word: bitmap 0 and not used by a recorded session (`bitmaps[k]` = nonces(owner, base + k)). */
export function pickFreshWord(base: bigint, bitmaps: readonly bigint[], recordedWords: readonly bigint[]): bigint | null {
  const taken = new Set(recordedWords.map(String));
  for (let k = 0; k < bitmaps.length; k++) {
    const w = base + BigInt(k);
    if (bitmaps[k] === 0n && !taken.has(String(w))) return w;
  }
  return null;
}

export type ReadNonces = (owner: Address, word: bigint) => Promise<bigint>;

/** The session word of a new signing session (reads the window from the base upward). */
export async function allocateSessionWord(read: ReadNonces, x: { owner: Address; gac4: Address; tokenId: bigint; recordedWords?: readonly bigint[] }): Promise<bigint> {
  const base = permitWord(x.gac4, x.tokenId);
  const bitmaps: bigint[] = [];
  for (let k = 0; k < SESSION_WORDS_MAX; k++) {
    bitmaps.push(await read(x.owner, base + BigInt(k)));
    const w = pickFreshWord(base, bitmaps, x.recordedWords ?? []);
    if (w !== null) return w;
  }
  throw new Error('No free signing slot is left for this position: stop auto-compound first to cancel the old signed messages.');
}

export interface SessionRecord { word: bigint; size: number; deadline: bigint }

/** Signed and unused messages of the given sessions that have not expired. */
export function unusedCount(sessions: readonly SessionRecord[], bitmapOf: (w: bigint) => bigint, nowSec: number): number {
  let n = 0;
  for (const s of sessions) {
    if (s.deadline <= BigInt(nowSec)) continue;
    const bm = bitmapOf(s.word);
    for (let b = 0; b < s.size; b++) if (!isUsed(bm, b)) n++;
  }
  return n;
}

/**
 * The nonces a stop cancels: every unused bit below each session's size. Without any session record (`fallbackWords`), every
 * word from the base up to and including the first all-zero word counts as a session of 30. Used bits are skipped (cancelling
 * one would revert the whole multicall); a word outside the window is never included.
 */
export function revokeSet(x: { base: bigint; sessions: readonly SessionRecord[]; bitmaps: ReadonlyMap<string, bigint>; fallbackWords?: readonly bigint[] }): bigint[] {
  const out: bigint[] = [];
  const seen = new Set<string>();
  const add = (word: bigint, size: number) => {
    if (!isSessionWord(x.base, word) || seen.has(String(word))) return;
    seen.add(String(word));
    const bm = x.bitmaps.get(String(word)) ?? 0n;
    for (let b = 0; b < Math.min(size, MAX_RUNS_PER_SESSION); b++) if (!isUsed(bm, b)) out.push(nonceOf(word, b));
  };
  const own = ownSessions(x.base, x.sessions);
  for (const s of own) add(s.word, s.size);
  if (!own.length) for (const w of x.fallbackWords ?? []) add(w, MAX_RUNS_PER_SESSION);
  return out;
}

/** The scan fallback: base, base + 1, ... up to and including the first all-zero word. */
export async function scanSessionWords(read: ReadNonces, x: { owner: Address; gac4: Address; tokenId: bigint }): Promise<{ words: bigint[]; bitmaps: Map<string, bigint> }> {
  const base = permitWord(x.gac4, x.tokenId);
  const words: bigint[] = [];
  const bitmaps = new Map<string, bigint>();
  for (let k = 0; k < SESSION_WORDS_MAX; k++) {
    const w = base + BigInt(k);
    const bm = await read(x.owner, w);
    words.push(w);
    bitmaps.set(String(w), bm);
    if (bm === 0n) break;
  }
  return { words, bitmaps };
}

/** In-memory record of the sessions this server signed (no signature bytes), per owner and position. */
export class SessionLog {
  private byKey = new Map<string, SessionRecord[]>();
  private key = (owner: Address, id: bigint) => `${owner.toLowerCase()}:${id.toString()}`;
  list(owner: Address, id: bigint): SessionRecord[] { return [...(this.byKey.get(this.key(owner, id)) ?? [])]; }
  add(owner: Address, id: bigint, rec: SessionRecord): void {
    const all = this.list(owner, id).filter((r) => r.word !== rec.word);
    all.push(rec);
    this.byKey.set(this.key(owner, id), all);
  }
  clear(owner: Address, id: bigint): void { this.byKey.delete(this.key(owner, id)); }
}

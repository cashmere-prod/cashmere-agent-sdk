// The keeper's two public surfaces on api.cashmere.exchange:
//  - /automation/status: a static status file (cached 30 s). Rows of a file older than 10 minutes are ignored, and raw keeper
//    text is never passed on: only known status keys and short reason and advice keys are kept. Its `pairs` rows give the
//    keeper's size limit per pair (larger runs wait until the pair's price check is deeper), from a fresh file only.
//  - /automation/permits: the store of v4 auto-compound signed messages. A session is handed over only for a position the
//    signer owns, only for spender GoatAutoCompoundV4 and only inside the position's nonce window; one session per POST.
import type { Address, Hex } from 'viem';
import { MAX_RUNS_PER_SESSION } from './constants';
import { routes, type GoatApi } from './api';
import { isSessionWord, permitWord } from './permits';
import type { Kind, Venue } from './types';

export const KEEPER_STATUS_MAX_AGE_SEC = 600;
const KEY_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

export type KeeperStatusKey = 'ok' | 'waiting-fees' | 'on-hold' | 'paused' | 'needs-approval' | 'advice' | 'queued' | 'preparing' | 'cap-exceeded' | 'unknown';
export interface KeeperPositionStatus {
  tokenId: string;
  status: KeeperStatusKey;
  reasonKey?: string;
  nextCheckAt?: number;
  adviceKey?: string;
  holdUntil?: number;
  etaSec?: number;
  venue?: Venue;
  kind?: Kind;
}

const STATUS_MAP: Readonly<Record<string, KeeperStatusKey>> = {
  ok: 'ok', watching: 'ok', ready: 'ok', ran: 'ok', active: 'ok',
  'waiting-fees': 'waiting-fees', 'below-gas': 'waiting-fees', unprofitable: 'waiting-fees',
  'on-hold': 'on-hold', hold: 'on-hold', backoff: 'on-hold', 'owner-hold': 'on-hold', 'pool-quarantined': 'on-hold',
  paused: 'paused', 'market-closed': 'paused', 'calendar-edge': 'paused', 'sr-catching-up': 'paused', 'swaps-paused': 'paused',
  'xprice-blocked': 'paused', 'token-stopped': 'paused', 'hook-stop': 'paused', 'lane-stopped': 'paused', 'exit-only': 'paused',
  queued: 'queued', 'capacity-limited': 'queued',
  'sr-stale': 'preparing', 'oracle-warming': 'preparing',
  'cap-exceeded': 'cap-exceeded',
  'needs-approval': 'needs-approval', advice: 'advice',
};
/** Raw statuses that also carry a fixed advice for swap exits (switch to withdraw only) */
const ADVICE_OF: Readonly<Record<string, string>> = { 'cap-exceeded': 'swap-too-large', 'exit-only': 'swaps-closed' };

/** Plain words for the advice keys this package knows (other keys are not shown) */
export const KEEPER_ADVICE_TEXT: Readonly<Record<string, string>> = {
  'swap-too-large': 'The swap exit is too large for this pool near its level. Switching it to withdraw only (swap: false) would act right away.',
  'pair-capacity': 'The swap exit is too large for this pool near its level. Switching it to withdraw only (swap: false) would act right away.',
  'swaps-closed': 'Swaps for this pair are closed right now. Switching the exit to withdraw only (swap: false) would act right away.',
};

/** Plain words for each status key */
export const KEEPER_STATUS_TEXT: Readonly<Record<KeeperStatusKey, string>> = {
  ok: 'Watching: the keeper runs the rule when it is due.',
  'waiting-fees': 'On. Waiting for more fees to build up before the next run.',
  'on-hold': 'The keeper is holding this rule for now and tries again later.',
  paused: 'Paused right now. The keeper tries again later.',
  'needs-approval': 'The rule cannot run: its permission was removed or replaced.',
  advice: 'The keeper has a suggestion for this rule.',
  queued: "Queued: this pair's hourly swap limit is in use.",
  preparing: 'The keeper is preparing the price check.',
  'cap-exceeded': "This position is larger than this pair's swap limit allows for one run.",
  unknown: 'The keeper reported a state this package does not know.',
};

/** One status row, normalised (unknown keys become 'unknown'; free text is dropped). */
export function normaliseStatus(x: unknown): KeeperPositionStatus | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  const rawId = o.tokenId ?? o.id;
  const id = typeof rawId === 'string' || typeof rawId === 'number' ? String(rawId) : null;
  if (!id || !/^[0-9]{1,78}$/.test(id)) return null;
  const raw = typeof o.status === 'string' ? o.status : '';
  const key = (k: unknown) => (typeof k === 'string' && KEY_RE.test(k) ? k : undefined);
  const sec = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined);
  const out: KeeperPositionStatus = { tokenId: id, status: STATUS_MAP[raw] ?? 'unknown' };
  const reasonKey = key(o.reason) ?? (KEY_RE.test(raw) ? raw : undefined);
  if (reasonKey) out.reasonKey = reasonKey;
  const adviceKey = key(o.advice) ?? ADVICE_OF[raw];
  if (adviceKey) out.adviceKey = adviceKey;
  const nextCheckAt = sec(o.nextCheckAt);
  if (nextCheckAt) out.nextCheckAt = nextCheckAt;
  const holdUntil = sec(o.holdUntil);
  if (holdUntil) out.holdUntil = holdUntil;
  const eta = sec(o.etaSeconds) ?? sec(o.etaSec);
  if (eta !== undefined) out.etaSec = eta;
  if (o.venue === 'v3' || o.venue === 'v4') out.venue = o.venue;
  if (o.kind === 'compound' || o.kind === 'range' || o.kind === 'exit') out.kind = o.kind;
  return out;
}

export type KeeperFileState = 'fresh' | 'stale' | 'failed';
/** One `pairs` row: the keeper's size limit of a pair on a venue ('waiting': no swap run fits, maxRunUsd 0) */
export interface KeeperPairRow { venue: Venue; token0: string; token1: string; state: 'limited' | 'waiting'; maxRunUsd: number; reason: string; eta: number | null }
export interface KeeperStatusFile { state: KeeperFileState; updatedAt: number | null; rows: KeeperPositionStatus[]; pairs: KeeperPairRow[] }

const PAIR_ADDR_RE = /^0x[0-9a-f]{40}$/;
const PAIR_KEY_RE = /^[a-z0-9-]+$/;

/** One pairs row, checked (venue v3 / v4; token0 < token1 as lower-case addresses; state limited / waiting; maxRunUsd a whole
 *  number >= 0 and 0 while waiting; reason a key; eta unix seconds or null). A bad row is null. */
export function pairRowOf(x: unknown): KeeperPairRow | null {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  if (o.venue !== 'v3' && o.venue !== 'v4') return null;
  const t0 = o.token0, t1 = o.token1;
  if (typeof t0 !== 'string' || typeof t1 !== 'string' || !PAIR_ADDR_RE.test(t0) || !PAIR_ADDR_RE.test(t1) || !(t0 < t1)) return null;
  if (o.state !== 'limited' && o.state !== 'waiting') return null;
  const m = o.maxRunUsd;
  if (typeof m !== 'number' || !Number.isSafeInteger(m) || m < 0 || (o.state === 'waiting' && m !== 0)) return null;
  if (typeof o.reason !== 'string' || !PAIR_KEY_RE.test(o.reason)) return null;
  const eta = o.eta;
  if (eta !== null && !(typeof eta === 'number' && Number.isSafeInteger(eta) && eta >= 0)) return null;
  return { venue: o.venue, token0: t0, token1: t1, state: o.state, maxRunUsd: m, reason: o.reason, eta: eta as number | null };
}

/** The valid rows of the file's `pairs` section (version 1), one per venue and pair (the first wins); [] when absent */
export function pairRowsOf(data: unknown): KeeperPairRow[] {
  const p = data && typeof data === 'object' ? (data as Record<string, unknown>).pairs : undefined;
  if (!p || typeof p !== 'object' || (p as Record<string, unknown>).version !== 1) return [];
  const rows = (p as Record<string, unknown>).rows;
  if (!Array.isArray(rows)) return [];
  const out: KeeperPairRow[] = [];
  const seen = new Set<string>();
  for (const x of rows) {
    const r = pairRowOf(x);
    if (!r) continue;
    const k = `${r.venue}:${r.token0}:${r.token1}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

/** The size limit of a pool's pair (token order does not matter), or null when the keeper names none */
export function sizeLimitOf(file: KeeperStatusFile, venue: Venue, tokenA: string, tokenB: string): { state: 'limited' | 'waiting'; maxRunUsd: number; eta: number | null } | null {
  const [a, b] = [tokenA.toLowerCase(), tokenB.toLowerCase()].sort();
  const r = file.pairs.find((p) => p.venue === venue && p.token0 === a && p.token1 === b);
  return r ? { state: r.state, maxRunUsd: r.maxRunUsd, eta: r.eta } : null;
}

/** The rows of a status body judged at `nowSec`; a body more than 10 minutes old (or ahead) gives no rows. */
export function statusFileOf(data: unknown, nowSec: number): KeeperStatusFile {
  const none = (state: KeeperFileState, updatedAt: number | null): KeeperStatusFile => ({ state, updatedAt, rows: [], pairs: [] });
  if (!data || typeof data !== 'object' || Array.isArray(data)) return none('failed', null);
  const o = data as Record<string, unknown>;
  const at = typeof o.updatedAt === 'number' && Number.isFinite(o.updatedAt) ? o.updatedAt : null;
  if (at === null || at - nowSec > KEEPER_STATUS_MAX_AGE_SEC) return none('failed', null);
  if (nowSec - at > KEEPER_STATUS_MAX_AGE_SEC) return none('stale', at);
  const raw = Array.isArray(o.positions) ? o.positions : o.positions && typeof o.positions === 'object' ? Object.values(o.positions as Record<string, unknown>) : null;
  if (!raw) return none('failed', null);
  return { state: 'fresh', updatedAt: at, rows: raw.map(normaliseStatus).filter((r): r is KeeperPositionStatus => r !== null), pairs: pairRowsOf(data) };
}

/** The status file (one GET, cached by the API client). Never throws: a failed read is state 'failed'. */
export async function readKeeperStatus(api: GoatApi, nowSec: number): Promise<KeeperStatusFile> {
  try {
    return statusFileOf(await api.get<unknown>(routes.automationStatus(), 'other'), nowSec);
  } catch {
    return { state: 'failed', updatedAt: null, rows: [], pairs: [] };
  }
}

/** The row of one rule: the row of that kind first (with its venue, then without), then a row without a kind. */
export function keeperStatusOf(file: KeeperStatusFile, id: bigint, venue: Venue, kind: Kind): KeeperPositionStatus | null {
  const sid = id.toString();
  const rows = file.rows.filter((r) => r.tokenId === sid && (r.venue === undefined || r.venue === venue));
  return rows.find((r) => r.kind === kind && r.venue === venue) ?? rows.find((r) => r.kind === kind) ?? rows.find((r) => r.kind === undefined) ?? null;
}

// ------------------------------------------------------------------ signed-message store

export interface SignedRun { nonce: bigint; signature: Hex }
export interface SignedSession { word: bigint; deadline: bigint; signatures: SignedRun[] }

export interface StoredSessions { sessions: { word: bigint; size: number; deadline: bigint }[]; rows: number }

/** The sessions the store holds for a position (no signature bytes come back); null = the store did not answer. */
export async function listStoredSessions(api: GoatApi, tokenId: bigint): Promise<StoredSessions | null> {
  let data: unknown;
  try { data = await api.get<unknown>(routes.permitsOf(tokenId), 'other'); } catch { return null; }
  const arr = data && typeof data === 'object' ? (data as { sessions?: unknown }).sessions : undefined;
  if (!Array.isArray(arr)) return null;
  const sessions: StoredSessions['sessions'] = [];
  for (const s of arr) {
    try {
      const o = s as Record<string, unknown>;
      const size = Number(o.size);
      if (!Number.isInteger(size) || size < 1 || size > MAX_RUNS_PER_SESSION) continue;
      sessions.push({ word: BigInt(String(o.word)), size, deadline: BigInt(String(o.deadline)) });
    } catch { /* a malformed row is skipped */ }
  }
  return { sessions, rows: arr.length };
}

/** Why a session must not be handed over, or null when it may */
export function handOverRefusal(x: { owner: Address; ownerOnChain: Address | null; gac4: Address; spender: Address; tokenId: bigint; session: SignedSession; nowSec: number }): string | null {
  if (!x.ownerOnChain || x.ownerOnChain.toLowerCase() !== x.owner.toLowerCase()) return 'the signer does not own this position';
  if (x.spender.toLowerCase() !== x.gac4.toLowerCase()) return 'the spender is not GoatAutoCompoundV4';
  if (!isSessionWord(permitWord(x.gac4, x.tokenId), x.session.word)) return "the session word is outside this position's nonce window";
  if (!x.session.signatures.length || x.session.signatures.length > MAX_RUNS_PER_SESSION) return 'a session holds 1 to 30 signed messages';
  if (x.session.deadline <= BigInt(x.nowSec)) return 'the session has expired';
  const bits = x.session.signatures.map((s) => s.nonce);
  for (let i = 0; i < bits.length; i++) if (bits[i] !== ((x.session.word << 8n) | BigInt(i))) return 'the session is not bits 0..N-1 of its word';
  return null;
}

/** The POST body of one session: decimal strings, as the store expects */
export function sessionBody(owner: Address, tokenId: bigint, s: SignedSession): Record<string, unknown> {
  return {
    owner, tokenId: tokenId.toString(), word: s.word.toString(), bits: s.signatures.map((_, i) => i), deadline: s.deadline.toString(),
    signatures: s.signatures.map((x) => ({ nonce: x.nonce.toString(), signature: x.signature })),
  };
}

/** Hand every signed session to the store, one POST each (every session is posted, even after a failed one). true only
 *  when all were accepted; false also when nothing was held. */
export async function handOverSessions(sessions: readonly SignedSession[], post: (s: SignedSession) => Promise<boolean>): Promise<boolean> {
  const held = sessions.filter((s) => s.signatures.length > 0);
  if (!held.length) return false;
  let ok = true;
  for (const s of held) {
    const posted = await Promise.resolve().then(() => post(s)).catch(() => false);
    ok = ok && posted;
  }
  return ok;
}

/** POST one session (the API client waits a 429's Retry-After once) */
export async function postSession(api: GoatApi, owner: Address, tokenId: bigint, s: SignedSession): Promise<boolean> {
  try {
    await api.send('POST', routes.permits(), 'keeper-write', sessionBody(owner, tokenId, s));
    return true;
  } catch {
    return false;
  }
}

export type DropAnswer = { dropped: true } | { dropped: false; kept: true; reason: string } | { dropped: false; kept: false };

/** Ask the store to drop a position's sessions, once the stop is confirmed on chain */
export async function dropStoredSessions(api: GoatApi, tokenId: bigint): Promise<DropAnswer> {
  let r: unknown;
  try { r = await api.send<unknown>('DELETE', routes.permitsOf(tokenId), 'keeper-write'); } catch { return { dropped: false, kept: false }; }
  const o = r && typeof r === 'object' ? (r as Record<string, unknown>) : {};
  if (o.deleted === true) return { dropped: true };
  if (o.deleted === false && (o.reason === 'rule-on' || o.reason === 'changed')) return { dropped: false, kept: true, reason: o.reason };
  return { dropped: false, kept: false };
}

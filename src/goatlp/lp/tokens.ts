// The token checks of a deposit, as the app's (fail closed):
//  - a token that carries the symbol of an official Robinhood stock token at another address is a copy: no deposit. The
//    official list decides by address, never by symbol; the API's ticker_collision flag refuses as well.
//  - a token measured to keep a cut, or to fail, when it moves in or out of the pool: no deposit (it cannot settle exactly).
import { RED_LIST_TOKENS, transferBlocked } from '../hooks';
import type { Venue } from '../types';
import { STOCK_TOKENS } from './refData';

const lc = (s: string) => s.toLowerCase();
const isZero = (a: string) => /^0x0{40}$/i.test(a);

/** Official stock token by symbol (upper case) -> address */
const OFFICIAL_BY_SYMBOL: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  for (const [a, s] of Object.entries(STOCK_TOKENS)) if (!m.has(s.toUpperCase())) m.set(s.toUpperCase(), a);
  return m;
})();

/** The symbol as shown, without control or format characters (a copy may pad or disguise it) */
const cleanSymbol = (s: string | null | undefined) => (s ?? '').replace(/[\p{Cc}\p{Cf}]/gu, '').trim();

/** The official token a symbol copies, or null (an official token itself, or a symbol of no stock token) */
export function copiedStockToken(address: string, symbol: string | null | undefined): { address: string; symbol: string } | null {
  if (!address || STOCK_TOKENS[lc(address)]) return null;
  const s = cleanSymbol(symbol).toUpperCase();
  if (!s) return null;
  const official = OFFICIAL_BY_SYMBOL.get(s) ?? OFFICIAL_BY_SYMBOL.get(s.replace(/[^A-Z0-9.]/g, ''));
  if (!official || official === lc(address)) return null;
  return { address: official, symbol: STOCK_TOKENS[official] };
}

export interface DepositToken {
  address: string;
  /** the symbol read on chain (null when the read failed) */
  symbol: string | null;
  /** the API's symbol and ticker_collision flag, when the API answered */
  apiSymbol?: string | null;
  tickerCollision?: boolean | null;
}

export const BLOCKED_TITLE = 'New deposits blocked in this pool';

/** Why no deposit goes into this pair at this venue, or null */
export function depositTokenRefusal(venue: Venue, tokens: readonly [DepositToken, DepositToken]): string | null {
  const name = (t: DepositToken) => cleanSymbol(t.symbol) || cleanSymbol(t.apiSymbol) || `${t.address.slice(0, 6)}...${t.address.slice(-4)}`;
  for (const t of tokens) {
    if (isZero(t.address)) continue;
    if (t.tickerCollision === true || copiedStockToken(t.address, t.symbol) || copiedStockToken(t.address, t.apiSymbol)) {
      return `${BLOCKED_TITLE}: ${name(t)} copies the ticker of an official stock token.`;
    }
  }
  for (const t of tokens) {
    if (isZero(t.address)) continue;
    if (RED_LIST_TOKENS.includes(lc(t.address)) || transferBlocked(t.address, venue)) {
      return `${BLOCKED_TITLE}: ${name(t)} takes a fee or fails when it moves in or out of this pool, so a deposit cannot settle exactly.`;
    }
  }
  return null;
}

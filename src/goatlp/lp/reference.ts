// The deposit's price check, as the app's: the pool price against Chainlink, when both tokens have a fresh Chainlink USD feed
// on Robinhood Chain (native ETH counts as WETH). More than 5% apart refuses the deposit; more than 1% is shown in the plan
// for the user to acknowledge; without a reference the plan says the deposit uses the pool price. A feed is fresh when its
// last update is at most 25 hours old and the round is complete.
import type { Address } from 'viem';
import type { GoatChain, McCall } from '../chain';
import { WETH } from '../constants';
import { CHAINLINK_FEEDS, type FeedRow } from './refData';
import { isqrt, MAX_SQRT_RATIO, MIN_SQRT_RATIO } from './tickMath';

const Q96 = 1n << 96n;
export const P1_ACK_PCT = 1;
export const P1_REFUSE_PCT = 5;
export const FEED_FRESH_SEC = 25 * 3600;

const isZero = (a: string) => /^0x0{40}$/i.test(a);
const lc = (s: string) => s.toLowerCase();
const BY_TOKEN: ReadonlyMap<string, FeedRow> = new Map(CHAINLINK_FEEDS.map((r) => [lc(r.token), r]));

/** The feed row of a token (native ETH as WETH), or null */
export function feedOf(token: string): FeedRow | null {
  return BY_TOKEN.get(lc(isZero(token) ? WETH : token)) ?? null;
}

const aggregatorAbi = [
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8' }] },
  { type: 'function', name: 'latestRoundData', stateMutability: 'view', inputs: [],
    outputs: [{ name: 'roundId', type: 'uint80' }, { name: 'answer', type: 'int256' }, { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' }, { name: 'answeredInRound', type: 'uint80' }] },
] as const;

/** sqrtPriceX96 of token A in token B from two USD answers (raw units: tdA, tdB are the token decimals) */
export function chainlinkSqrtPriceX96(ansA: bigint, decA: number, ansB: bigint, decB: number, tdA: number, tdB: number): bigint | null {
  if (ansA <= 0n || ansB <= 0n) return null;
  let a = ansA, b = ansB;
  if (decA > decB) b *= 10n ** BigInt(decA - decB);
  else if (decB > decA) a *= 10n ** BigInt(decB - decA);
  const num = a * 10n ** BigInt(tdB);
  const den = b * 10n ** BigInt(tdA);
  if (num === 0n || den === 0n) return null;
  const root = isqrt((num << 192n) / den);
  if (root < MIN_SQRT_RATIO || root >= MAX_SQRT_RATIO) return null;
  return root;
}

type Round = readonly [bigint, bigint, bigint, bigint, bigint];
export const feedFresh = (rd: Round, nowSec: number): boolean =>
  rd[1] > 0n && rd[3] !== 0n && rd[4] >= rd[0] && rd[3] <= BigInt(nowSec) && BigInt(nowSec) - rd[3] <= BigInt(FEED_FRESH_SEC);

/**
 * The Chainlink price of the pool (token1 per token0, raw units, as a sqrtPriceX96), or null when a token has no feed, a read
 * fails or a feed is not fresh. `decimals` are the pool tokens' decimals (18 for native ETH, priced by the WETH feed).
 */
export async function chainlinkPoolSqrtPrice(chain: GoatChain, token0: Address, token1: Address, decimals: readonly [number, number], nowSec: number): Promise<bigint | null> {
  const f0 = feedOf(token0), f1 = feedOf(token1);
  if (!f0 || !f1) return null;
  const calls: McCall[] = [f0, f1].flatMap((f) => [
    { address: f.feed, abi: aggregatorAbi, functionName: 'latestRoundData' },
    { address: f.feed, abi: aggregatorAbi, functionName: 'decimals' },
  ]);
  try {
    const r = await chain.multicall(calls);
    if (r.some((x) => x.status !== 'success')) return null;
    const v = r.map((x) => (x as { result: unknown }).result);
    const [rd0, dec0, rd1, dec1] = [v[0] as Round, Number(v[1]), v[2] as Round, Number(v[3])];
    if (!feedFresh(rd0, nowSec) || !feedFresh(rd1, nowSec)) return null;
    return chainlinkSqrtPriceX96(rd0[1], dec0, rd1[1], dec1, decimals[0], decimals[1]);
  } catch {
    return null;
  }
}

/** Signed deviation of the pool price from the reference, percent (+ = the pool above the reference) */
export function priceDeviationPct(poolSqrtX96: bigint, refSqrtX96: bigint): number {
  if (poolSqrtX96 <= 0n || refSqrtX96 <= 0n) return NaN;
  const r = Number((poolSqrtX96 * Q96) / refSqrtX96) / Number(Q96);
  return (r * r - 1) * 100;
}

export interface PriceCheck {
  kind: 'ok' | 'ack' | 'refuse' | 'none';
  /** rounded to 0.01 %, null without a reference */
  deviationPct: number | null;
  /** the line the plan shows */
  detail: string;
  /** what the user acknowledges (kind ack), or why the deposit is refused (kind refuse) */
  text: string | null;
}

/** The decision for one deposit: the pool price against the Chainlink price (null = no reference) */
export function priceCheck(poolSqrtX96: bigint, refSqrtX96: bigint | null): PriceCheck {
  if (!refSqrtX96) return { kind: 'none', deviationPct: null, detail: 'No Chainlink price for this pair; the deposit uses the pool price.', text: null };
  const raw = priceDeviationPct(poolSqrtX96, refSqrtX96);
  if (!Number.isFinite(raw)) return { kind: 'refuse', deviationPct: null, detail: 'Pool price vs Chainlink: unknown', text: 'The pool price could not be read.' };
  const d = Math.round(Math.abs(raw) * 100) / 100;
  const dText = `${d.toFixed(2)}%`;
  const detail = `Pool price vs Chainlink: ${raw >= 0 ? '+' : '-'}${dText}`;
  if (d > P1_REFUSE_PCT) return { kind: 'refuse', deviationPct: d, detail, text: `The pool price is ${dText} from Chainlink, above Goat LP's ${P1_REFUSE_PCT}% limit for deposits.` };
  if (d > P1_ACK_PCT) return { kind: 'ack', deviationPct: d, detail, text: `the pool price is ${dText} from Chainlink` };
  return { kind: 'ok', deviationPct: d, detail, text: null };
}

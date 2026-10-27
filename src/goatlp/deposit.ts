// Plans of goatlp_add_liquidity: open a position (mint) or add to one the wallet owns (increase), on Uniswap v3 or v4 on
// Robinhood Chain, with the token amounts as given and no swap. As the app's deposit:
//  - the pool, the position, the token addresses and decimals are read on chain; a v4 pool key from the API is used only
//    once its hash equals the pool id;
//  - v4: pools without a hook only (the app checks a hooked pool's swap cost first; this tool does not offer them yet);
//  - the token checks (./lp/tokens.ts) and the Chainlink price check (./lp/reference.ts);
//  - sizing from the pool price and the range (./lp/sizing.ts), and the wallet's balances must cover it;
//  - exact approvals: v3 token -> position manager; v4 token -> Permit2, then Permit2 -> v4 position manager for 30 minutes;
//  - the optional USD caps, valued with the API's token prices (a missing price refuses when a cap is set).
// The plan keeps the pool price it was sized at; the execute refuses before sending anything when the price has since
// moved past the deposit's price limit, and every transaction is simulated again right before it is signed.
import { encodeAbiParameters, encodeFunctionData, formatUnits, keccak256, parseUnits, toEventSelector, type Address, type Hex } from 'viem';
import { erc20Abi, npmAbi, permit2Abi, poolManagerAbi, posmAbi, v3FactoryAbi, v3PoolAbi } from './abis';
import { checkPoolId, routes } from './api';
import { checkPins, type McCall, type McRes, type TxReceipt } from './chain';
import {
  DEPOSIT_SLIPPAGE_DEFAULT_BPS, GOAT_CHAIN_ID, LP_DEADLINE_SEC, NPM, PERMIT2, PERMIT2_TTL_SEC, POOL_MANAGER, POSM, V3_FACTORY, WETH,
  ZERO_ADDRESS, pinOf, type PinKey,
} from './constants';
import { VENUE_NAME, WRONG_OWNER_NOW } from './copy';
import type { GoatLpContext } from './context';
import { BURNED_RE, decodePositionInfo, poolIdOf } from './facts';
import { encodeV4Increase, encodeV4Mint, modifyLiquiditiesData, v3IncreaseData, v3MintData, v3WithEthData, type PoolKey } from './lp/encode';
import { alignTick, fullRange, maxUsableTick, minUsableTick, rangeAroundPrice, tickToPrice, type TickRange } from './lp/liquidity';
import { chainlinkPoolSqrtPrice, priceCheck } from './lp/reference';
import { bandEnds, otherSideAmount, sizeDeposit } from './lp/sizing';
import { depositTokenRefusal, type DepositToken } from './lp/tokens';
import { assertLpTx, type LpPlanned } from './lpGuard';
import type { BuiltPlan, PlanBasis, TxStep } from './plans';
import { sig } from './read';
import type { ApiPoolDetail } from './apiTypes';
import type { Venue } from './types';

export interface AddLiquidityInput {
  venue: Venue;
  /** add to this position (the wallet must own it) */
  id?: string;
  /** open a new position in this pool (v3: the pool address; v4: the pool id) */
  pool?: string;
  tickLower?: number;
  tickUpper?: number;
  /** the new range this many percent below and above the pool price */
  rangePct?: number;
  fullRange?: boolean;
  /** human units of token0 and token1 (one may be left out: it is computed from the pool price) */
  amount0?: string;
  amount1?: string;
  /** v3: the price move the minimums allow, in bps */
  slippageBps?: number;
  /** v3: pay the WETH side with ETH */
  payWithEth?: boolean;
}

/** USD the add-liquidity deposits sent, or may have sent, while the server runs */
export interface DepositLedger { totalUsd: number }

/** Least ETH kept for gas when a deposit pays ETH */
export const ETH_GAS_RESERVE_WEI = 2_000_000_000_000_000n;
export const HOOKED_V4_TEXT = 'Deposits into v4 pools with a hook are not offered by this tool yet: the app checks such a pool\'s swap cost before a deposit. Use the Goat LP app for this pool.';

const lc = (s: string) => s.toLowerCase();
const eq = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && lc(a) === lc(b);
const isZero = (a: string | null | undefined) => !a || /^0x0{40}$/i.test(a);
const DYNAMIC_FEE = 0x800000;
const POOLS_SLOT = 6n;
function refuse(msg: string): never { throw new Error(`Not planned: ${msg}`); }

// ------------------------------------------------------------------ chain reads

interface PoolRead {
  currencies: [Address, Address];
  fee: number;
  tickSpacing: number;
  /** v3: the pool address; v4: the key and the pool id */
  pool?: Address;
  key?: PoolKey;
  poolId?: Hex;
  /** increase: the position */
  tokenId?: bigint;
  range?: TickRange;
  liquidity?: bigint;
}

const okResult = <T>(r: McRes | undefined): T | undefined => (r && r.status === 'success' ? (r.result as T) : undefined);

async function v4Slot0(ctx: GoatLpContext, poolId: Hex): Promise<{ sqrtPriceX96: bigint; tick: number }> {
  const slot = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [poolId, POOLS_SLOT]));
  const word = BigInt(await ctx.chain.read<Hex>({ address: POOL_MANAGER, abi: poolManagerAbi, functionName: 'extsload', args: [slot] }));
  let tick = Number((word >> 160n) & 0xffffffn);
  if (tick >= 0x800000) tick -= 0x1000000;
  return { sqrtPriceX96: word & ((1n << 160n) - 1n), tick };
}

async function v3Slot0(ctx: GoatLpContext, pool: Address): Promise<{ sqrtPriceX96: bigint; tick: number }> {
  const s = await ctx.chain.read<readonly [bigint, number]>({ address: pool, abi: v3PoolAbi, functionName: 'slot0' });
  return { sqrtPriceX96: s[0], tick: Number(s[1]) };
}

/** The position's owner must be the wallet; a burned id is said plainly */
function ownerCheck(r: McRes | undefined, venue: Venue, id: bigint, wallet: Address): void {
  if (!r || r.status !== 'success') {
    const e = (r as { error?: { message?: string; shortMessage?: string } } | undefined)?.error;
    refuse(BURNED_RE.test(`${e?.shortMessage ?? ''} ${e?.message ?? ''}`) ? `${VENUE_NAME[venue]} position #${id} does not exist (or was burned).` : "couldn't read the owner of this position on chain.");
  }
  const o = r.result as Address;
  if (!eq(o, wallet)) refuse(`${WRONG_OWNER_NOW} It belongs to ${o}.`);
}

async function readPool(ctx: GoatLpContext, input: AddLiquidityInput, wallet: Address): Promise<PoolRead> {
  if (input.venue === 'v3') {
    let pool: Address; let t0: Address; let t1: Address; let fee: number; let extra: Partial<PoolRead> = {};
    if (input.id !== undefined) {
      const id = BigInt(input.id);
      const [own, pos] = await ctx.chain.multicall([
        { address: NPM, abi: npmAbi, functionName: 'ownerOf', args: [id] },
        { address: NPM, abi: npmAbi, functionName: 'positions', args: [id] },
      ]);
      ownerCheck(own, 'v3', id, wallet);
      const p = okResult<readonly unknown[]>(pos);
      if (!p) refuse("couldn't read this position on chain.");
      [t0, t1, fee] = [p[2] as Address, p[3] as Address, Number(p[4])];
      extra = { tokenId: id, range: { tickLower: Number(p[5]), tickUpper: Number(p[6]) }, liquidity: p[7] as bigint };
      pool = await ctx.chain.read<Address>({ address: V3_FACTORY, abi: v3FactoryAbi, functionName: 'getPool', args: [t0, t1, fee] });
      if (isZero(pool)) refuse("couldn't find this position's pool on chain.");
    } else {
      pool = input.pool as Address;
      const r = await ctx.chain.multicall(['token0', 'token1', 'fee'].map((functionName) => ({ address: pool, abi: v3PoolAbi, functionName })));
      const [a, b, f] = r.map((x) => okResult<unknown>(x));
      if (a === undefined || b === undefined || f === undefined) refuse('this address is not a Uniswap v3 pool on Robinhood Chain.');
      [t0, t1, fee] = [a as Address, b as Address, Number(f)];
      const listed = await ctx.chain.read<Address>({ address: V3_FACTORY, abi: v3FactoryAbi, functionName: 'getPool', args: [t0, t1, fee] });
      if (!eq(listed, pool)) refuse('this address is not a pool of the Uniswap v3 factory on Robinhood Chain.');
    }
    const tickSpacing = Number(await ctx.chain.read<number>({ address: pool, abi: v3PoolAbi, functionName: 'tickSpacing' }));
    return { currencies: [t0, t1], fee, tickSpacing, pool, ...extra };
  }
  let key: PoolKey; let extra: Partial<PoolRead> = {};
  if (input.id !== undefined) {
    const id = BigInt(input.id);
    const [own, info, liq] = await ctx.chain.multicall([
      { address: POSM, abi: posmAbi, functionName: 'ownerOf', args: [id] },
      { address: POSM, abi: posmAbi, functionName: 'getPoolAndPositionInfo', args: [id] },
      { address: POSM, abi: posmAbi, functionName: 'getPositionLiquidity', args: [id] },
    ]);
    ownerCheck(own, 'v4', id, wallet);
    const pi = okResult<readonly [PoolKey, bigint]>(info);
    if (!pi) refuse("couldn't read this position on chain.");
    const k = pi[0];
    key = { currency0: k.currency0, currency1: k.currency1, fee: Number(k.fee), tickSpacing: Number(k.tickSpacing), hooks: k.hooks };
    const t = decodePositionInfo(BigInt(pi[1]));
    extra = { tokenId: id, range: { tickLower: t.tickLower, tickUpper: t.tickUpper }, liquidity: okResult<bigint>(liq) };
  } else {
    let d: ApiPoolDetail;
    try { d = await ctx.api.get<ApiPoolDetail>(routes.pool('v4', input.pool!), 'other'); } catch (e) {
      refuse(`couldn't read this pool's key from the API (${(e as Error).message}).`);
    }
    key = { currency0: d.token0 as Address, currency1: d.token1 as Address, fee: Number(d.fee_tier), tickSpacing: Number(d.tick_spacing), hooks: (d.hooks ?? ZERO_ADDRESS) as Address };
  }
  const poolId = poolIdOf(key);
  if (input.pool !== undefined && lc(poolId) !== lc(input.pool)) refuse("the pool key the API gives does not hash to this pool id.");
  return { currencies: [key.currency0, key.currency1], fee: key.fee, tickSpacing: key.tickSpacing, key, poolId, ...extra };
}

interface TokenRead { address: Address; native: boolean; decimals: number; symbol: string | null }

async function readTokens(ctx: GoatLpContext, currencies: readonly [Address, Address]): Promise<[TokenRead, TokenRead]> {
  const calls: McCall[] = [];
  for (const c of currencies) if (!isZero(c)) calls.push({ address: c, abi: erc20Abi, functionName: 'decimals' }, { address: c, abi: erc20Abi, functionName: 'symbol' });
  const r = await ctx.chain.multicall(calls);
  let k = 0;
  return currencies.map((c) => {
    if (isZero(c)) return { address: c, native: true, decimals: 18, symbol: 'ETH' };
    const dec = okResult<number>(r[k++]); const sym = okResult<string>(r[k++]);
    if (dec === undefined) refuse(`couldn't read the decimals of ${c} on chain.`);
    return { address: c, native: false, decimals: Number(dec), symbol: typeof sym === 'string' ? sym : null };
  }) as [TokenRead, TokenRead];
}

interface PriceRow { usd: number | null; symbol: string | null; tickerCollision: boolean | null }

/** USD prices and the ticker-collision flags from the API; null entries when it does not answer */
async function apiPrices(ctx: GoatLpContext, venue: Venue, currencies: readonly [Address, Address]): Promise<[PriceRow, PriceRow]> {
  const none: PriceRow = { usd: null, symbol: null, tickerCollision: null };
  try {
    const body = await ctx.api.get<Record<string, unknown>>(routes.tokenPrices(venue, [...currencies]), 'other');
    const map = ((body as { data?: unknown }).data ?? body) as Record<string, { price?: unknown; prices?: { usd?: unknown }; symbol?: unknown; ticker_collision?: unknown }>;
    return currencies.map((c) => {
      const e = map[lc(c)] ?? map[c];
      if (!e) return none;
      const raw = typeof e.prices?.usd === 'number' ? e.prices.usd : e.price;
      const usd = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : null;
      return { usd, symbol: typeof e.symbol === 'string' ? e.symbol : null, tickerCollision: typeof e.ticker_collision === 'boolean' ? e.ticker_collision : null };
    }) as [PriceRow, PriceRow];
  } catch {
    return [none, none];
  }
}

// ------------------------------------------------------------------ inputs

function parseAmount(text: string, t: TokenRead): bigint {
  const s = text.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) refuse(`the ${t.symbol ?? 'token'} amount must be a plain decimal number, such as 1.5.`);
  if ((s.split('.')[1] ?? '').length > t.decimals) refuse(`${t.symbol ?? 'the token'} has ${t.decimals} decimals; the amount has more.`);
  return parseUnits(s, t.decimals);
}

function rangeOf(input: AddLiquidityInput, tick: number, spacing: number): TickRange {
  if (input.fullRange) return fullRange(spacing);
  if (input.rangePct !== undefined) {
    if (!(input.rangePct > 0 && input.rangePct < 100)) refuse('rangePct must be above 0 and below 100.');
    return rangeAroundPrice(tick, spacing, input.rangePct, input.rangePct);
  }
  const tl = input.tickLower, tu = input.tickUpper;
  if (tl === undefined || tu === undefined) refuse('give both tickLower and tickUpper.');
  if (tl % spacing !== 0 || tu % spacing !== 0) {
    refuse(`ticks must be multiples of the pool's tick spacing (${spacing}), such as ${alignTick(tl, spacing, 'floor')} and ${alignTick(tu, spacing, 'ceil')}.`);
  }
  if (tl < minUsableTick(spacing) || tu > maxUsableTick(spacing)) refuse(`ticks must be between ${minUsableTick(spacing)} and ${maxUsableTick(spacing)} in this pool.`);
  if (tl >= tu) refuse('tickLower must be below tickUpper.');
  return { tickLower: tl, tickUpper: tu };
}

/** The side of the pool that is WETH, or null unless exactly one is (and none is native ETH) */
function wethSideOf(c: readonly [Address, Address]): 0 | 1 | null {
  if (isZero(c[0]) || isZero(c[1])) return null;
  const w0 = eq(c[0], WETH), w1 = eq(c[1], WETH);
  return w0 === w1 ? null : w0 ? 0 : 1;
}

/** Is the current price inside the deposit's price limit around the plan's price? */
export function insideLimit(venue: Venue, planSqrt: bigint, nowSqrt: bigint, bps: bigint): boolean {
  if (venue === 'v4') {
    const pips = bps * 100n;
    return nowSqrt >= (planSqrt * (2_000_000n - pips)) / 2_000_000n && nowSqrt <= (planSqrt * (2_000_000n + pips)) / 2_000_000n;
  }
  const { lo, hi } = bandEnds(planSqrt, bps);
  return nowSqrt >= lo && nowSqrt <= hi;
}

// ------------------------------------------------------------------ the plan

const fmt = (x: bigint, t: TokenRead) => `${formatUnits(x, t.decimals)} ${t.symbol ?? t.address}`;
const pct = (bps: bigint) => `${(Number(bps) / 100).toFixed(2)}%`;

export async function planAddLiquidity(ctx: GoatLpContext, input: AddLiquidityInput, basis: PlanBasis, ledger: DepositLedger): Promise<BuiltPlan> {
  const signer = ctx.signer;
  if (!signer) refuse('this server has no wallet configured.');
  const wallet = signer.address;
  const { venue } = input;
  if (input.pool !== undefined) {
    try { input = { ...input, pool: checkPoolId(venue, input.pool) }; } catch (e) { refuse((e as Error).message); }
  }
  const isIncrease = input.id !== undefined;
  if (isIncrease === (input.pool !== undefined)) refuse('give either id (add to a position the wallet owns) or pool (open a new position).');
  const rangeForms = [input.tickLower !== undefined || input.tickUpper !== undefined, input.rangePct !== undefined, input.fullRange === true].filter(Boolean).length;
  if (isIncrease && rangeForms > 0) refuse('a position keeps its range: give no range with id.');
  if (!isIncrease && rangeForms !== 1) refuse('give the new range as tickLower and tickUpper, as rangePct, or as fullRange: true (exactly one of them).');
  if (input.amount0 === undefined && input.amount1 === undefined) refuse('give amount0, amount1 or both.');
  if (venue === 'v4' && input.payWithEth) refuse('payWithEth is for v3 pools with WETH; on v4, a pool of native ETH takes ETH directly.');
  if (venue === 'v4' && input.slippageBps !== undefined) refuse('slippageBps applies to v3; a v4 deposit uses the app\'s price band (shown in the plan).');
  const slip = BigInt(input.slippageBps ?? DEPOSIT_SLIPPAGE_DEFAULT_BPS);

  // the chain and the contracts this deposit uses
  const chainId = await ctx.chain.chainId();
  if (chainId !== GOAT_CHAIN_ID) refuse(`the RPC is on chain ${chainId}, not Robinhood Chain (4663).`);
  const pinKeys: PinKey[] = venue === 'v3' ? ['npm', 'v3Factory'] : ['posm', 'permit2', 'poolManager'];
  const pins = await checkPins(ctx.chain, pinKeys);
  const bad = Object.values(pins).find((p) => !p.ok);
  if (bad) refuse(bad.reason);

  // the pool (and the position), read on chain
  const pr = await readPool(ctx, input, wallet);
  if (venue === 'v4') {
    if (!isZero(pr.key!.hooks)) refuse(HOOKED_V4_TEXT);
    if (pr.fee === DYNAMIC_FEE) refuse('this pool has a dynamic fee; deposits into it are not offered by this tool.');
    if (pr.fee === 0) refuse('this pool pays LPs no swap fees.');
  }
  const cur = venue === 'v4' ? await v4Slot0(ctx, pr.poolId!) : await v3Slot0(ctx, pr.pool!);
  if (cur.sqrtPriceX96 === 0n) refuse('this pool has no price yet (it is not initialized).');
  // the plan's price: now when planning; at execute, the price the plan was sized at
  const planned = basis.sqrtPriceX96 !== undefined;
  const sqrtP = planned ? BigInt(basis.sqrtPriceX96 as string) : cur.sqrtPriceX96;
  const tick = planned ? Number(basis.tick) : cur.tick;

  // the tokens: decimals and symbols on chain, the token checks, the API prices
  const [tokens, prices] = await Promise.all([readTokens(ctx, pr.currencies), apiPrices(ctx, venue, pr.currencies)]);
  const dt = (i: 0 | 1): DepositToken => ({ address: tokens[i].address, symbol: tokens[i].symbol, apiSymbol: prices[i].symbol, tickerCollision: prices[i].tickerCollision });
  const blocked = depositTokenRefusal(venue, [dt(0), dt(1)]);
  if (blocked) refuse(blocked);
  const [t0, t1] = tokens;

  // the range and the amounts
  const range = isIncrease ? pr.range! : rangeOf(input, tick, pr.tickSpacing);
  let in0 = input.amount0 !== undefined ? parseAmount(input.amount0, t0) : undefined;
  let in1 = input.amount1 !== undefined ? parseAmount(input.amount1, t1) : undefined;
  const matched = in0 === undefined ? 'amount0' : in1 === undefined ? 'amount1' : null;
  if (in0 === undefined) in0 = otherSideAmount(sqrtP, range, 1, in1!);
  if (in1 === undefined) in1 = otherSideAmount(sqrtP, range, 0, in0);
  if (in0 <= 0n && in1 <= 0n) refuse('give an amount above zero.');
  const ethSide = venue === 'v3' && input.payWithEth ? wethSideOf(pr.currencies) : null;
  if (venue === 'v3' && input.payWithEth && ethSide === null) refuse('this pool has no WETH side to pay with ETH.');

  const z = sizeDeposit(sqrtP, range, in0, in1, slip);
  let need: [bigint, bigint]; let add: [bigint, bigint]; let mins: [bigint, bigint] | null = null;
  if (venue === 'v4') {
    if (z.v4.liquidity <= 0n) refuse('the amounts are too small to add liquidity to this range.');
    need = [z.v4.amount0Max, z.v4.amount1Max]; add = [z.v4.add0, z.v4.add1];
  } else {
    need = [z.v3.amount0Desired, z.v3.amount1Desired]; add = need; mins = [z.v3.amount0Min, z.v3.amount1Min];
    if (need[0] <= 0n && need[1] <= 0n) refuse('these amounts add no liquidity to this range (check which token the range needs).');
  }
  if (ethSide !== null && need[ethSide] <= 0n) refuse('these amounts need no WETH, so there is nothing to pay with ETH.');
  const native = venue === 'v4' && isZero(pr.currencies[0]);
  const value = venue === 'v4' ? (native ? need[0] : 0n) : ethSide !== null ? need[ethSide] : 0n;
  const limitBps = venue === 'v4' ? z.v4.bandBps : slip;
  if (planned && !insideLimit(venue, sqrtP, cur.sqrtPriceX96, limitBps)) {
    refuse(`the pool price moved past the deposit's price limit (${pct(limitBps)}) since the plan. Call without execute for a new plan and show it to the user.`);
  }

  // the pool price against Chainlink (the current price)
  const ref = await chainlinkPoolSqrtPrice(ctx.chain, pr.currencies[0], pr.currencies[1], [t0.decimals, t1.decimals], await ctx.chain.blockTimestamp());
  const pc = priceCheck(cur.sqrtPriceX96, ref);
  if (pc.kind === 'refuse') refuse(pc.text!);
  const acks = pc.kind === 'ack' ? [pc.text!] : [];

  // the wallet covers it
  const paysEth = (i: 0 | 1) => tokens[i].native || ethSide === i;
  const balanceCalls: McCall[] = [];
  for (const i of [0, 1] as const) if (need[i] > 0n && !paysEth(i)) balanceCalls.push({ address: tokens[i].address, abi: erc20Abi, functionName: 'balanceOf', args: [wallet] });
  const [balRes, ethBal] = await Promise.all([ctx.chain.multicall(balanceCalls), value > 0n ? ctx.chain.balance(wallet) : Promise.resolve(0n)]);
  let k = 0;
  for (const i of [0, 1] as const) {
    if (need[i] <= 0n) continue;
    const t = tokens[i];
    const bal = paysEth(i) ? ethBal : okResult<bigint>(balRes[k++]);
    if (bal === undefined) refuse(`couldn't read the wallet's ${t.symbol ?? t.address} balance.`);
    const sym = paysEth(i) ? 'ETH' : t.symbol ?? t.address;
    if (bal < need[i]) refuse(`not enough ${sym}: the deposit needs up to ${formatUnits(need[i], t.decimals)}, the wallet has ${formatUnits(bal, t.decimals)}.`);
    if (paysEth(i) && bal < need[i] + ETH_GAS_RESERVE_WEI) refuse('keep about 0.002 ETH for gas: lower the ETH amount.');
  }

  // the USD value and the caps
  const usdParts = [0, 1].map((i) => (need[i] > 0n ? (prices[i].usd === null ? null : Number(formatUnits(need[i], tokens[i].decimals)) * prices[i].usd!) : 0));
  const missing = [0, 1].find((i) => usdParts[i] === null);
  const valueUsd = missing === undefined ? (usdParts as number[]).reduce((a, b) => a + b, 0) : null;
  const usdText = (x: number) => x.toFixed(2);
  const { maxDepositUsd, maxTotalUsd } = ctx.settings;
  if ((maxDepositUsd !== undefined || maxTotalUsd !== undefined) && valueUsd === null) {
    const t = tokens[missing!];
    refuse(`the USD price of ${t.symbol ?? t.address} is not available, so the deposit limits (${maxDepositUsd !== undefined ? 'CASHMERE_GOATLP_MAX_DEPOSIT_USD' : 'CASHMERE_GOATLP_MAX_TOTAL_USD'}) cannot be checked.`);
  }
  if (maxDepositUsd !== undefined && valueUsd! > maxDepositUsd) {
    refuse(`this deposit is worth about ${usdText(valueUsd!)} USD, above the limit of ${maxDepositUsd} USD per deposit (CASHMERE_GOATLP_MAX_DEPOSIT_USD).`);
  }
  if (maxTotalUsd !== undefined && ledger.totalUsd + valueUsd! > maxTotalUsd) {
    refuse(`this server has deposited about ${usdText(ledger.totalUsd)} USD; ${usdText(valueUsd!)} more would pass its total limit of ${maxTotalUsd} USD (CASHMERE_GOATLP_MAX_TOTAL_USD).`);
  }

  // approvals: exact amounts, only where the current allowance is short
  const nowSec = basis.nowSec;
  const deadline = BigInt(nowSec + LP_DEADLINE_SEC);
  const expiration = nowSec + PERMIT2_TTL_SEC;
  const approvals: { token: Address; spender: Address; amount: bigint }[] = [];
  const permit2: { token: Address; amount: bigint; expiration: number }[] = [];
  const reads: McCall[] = [];
  const sides = ([0, 1] as const).filter((i) => need[i] > 0n && !paysEth(i));
  for (const i of sides) {
    reads.push({ address: tokens[i].address, abi: erc20Abi, functionName: 'allowance', args: [wallet, venue === 'v3' ? NPM : PERMIT2] });
    if (venue === 'v4') reads.push({ address: PERMIT2, abi: permit2Abi, functionName: 'allowance', args: [wallet, tokens[i].address, POSM] });
  }
  const allow = await ctx.chain.multicall(reads);
  k = 0;
  for (const i of sides) {
    const a = okResult<bigint>(allow[k++]);
    if (a === undefined) refuse(`couldn't read the wallet's ${tokens[i].symbol ?? tokens[i].address} allowance.`);
    if (a < need[i]) approvals.push({ token: tokens[i].address, spender: venue === 'v3' ? NPM : PERMIT2, amount: need[i] });
    if (venue === 'v4') {
      const p = okResult<readonly [bigint, number, number]>(allow[k++]);
      if (!p) refuse(`couldn't read the wallet's Permit2 allowance of ${tokens[i].symbol ?? tokens[i].address}.`);
      if (p[0] < need[i] || Number(p[1]) <= nowSec + LP_DEADLINE_SEC) permit2.push({ token: tokens[i].address, amount: need[i], expiration });
    }
  }

  // the deposit
  const owner = wallet;
  let data: Hex;
  if (venue === 'v3') {
    const m = mins!;
    const inner = isIncrease
      ? v3IncreaseData({ tokenId: pr.tokenId!, amount0Desired: need[0], amount1Desired: need[1], amount0Min: m[0], amount1Min: m[1], deadline })
      : v3MintData({ token0: pr.currencies[0], token1: pr.currencies[1], fee: pr.fee, tickLower: range.tickLower, tickUpper: range.tickUpper,
        amount0Desired: need[0], amount1Desired: need[1], amount0Min: m[0], amount1Min: m[1], recipient: owner, deadline });
    data = ethSide !== null ? v3WithEthData(inner) : inner;
  } else {
    const unlock = isIncrease
      ? encodeV4Increase(pr.tokenId!, z.v4.liquidity, need[0], need[1], pr.currencies[0], pr.currencies[1], owner)
      : encodeV4Mint(pr.key!, range.tickLower, range.tickUpper, z.v4.liquidity, need[0], need[1], owner);
    data = modifyLiquiditiesData(unlock, deadline);
  }
  const lp: Omit<LpPlanned, 'chainId' | 'nowSec'> = {
    venue, kind: isIncrease ? 'increase' : 'mint', account: wallet, currencies: pr.currencies, fee: pr.fee, key: pr.key,
    range, tokenId: pr.tokenId, approvals, permit2, ethSide, value,
  };

  const steps: TxStep[] = [];
  for (const a of approvals) {
    const t = tokens.find((x) => eq(x.address, a.token))!;
    const call = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [a.spender, a.amount] });
    steps.push(lpStep(ctx, lp, {
      label: `Allow ${t.symbol ?? t.address}`, to: a.token, data: call, value: 0n, pins: venue === 'v3' ? ['npm'] : ['permit2'],
      view: { contract: `${t.symbol ?? 'token'} (${t.address})`, call: `approve("${pinOf(a.spender)!.pin.name} ${a.spender}", "${a.amount}")`, amount: fmt(a.amount, t), note: 'exactly the amount of this deposit' },
      verify: async () => ((await ctx.chain.read<bigint>({ address: a.token, abi: erc20Abi, functionName: 'allowance', args: [wallet, a.spender] })) >= a.amount ? null : NOT_SEEN),
    }));
  }
  for (const p of permit2) {
    const t = tokens.find((x) => eq(x.address, p.token))!;
    const call = encodeFunctionData({ abi: permit2Abi, functionName: 'approve', args: [p.token, POSM, p.amount, p.expiration] });
    steps.push(lpStep(ctx, lp, {
      label: `Allow ${t.symbol ?? t.address} through Permit2`, to: PERMIT2, data: call, value: 0n, pins: ['permit2', 'posm'],
      view: { contract: `Permit2 (${PERMIT2})`, call: `approve("${t.address}", "Uniswap v4 PositionManager ${POSM}", "${p.amount}", ${p.expiration})`,
        amount: fmt(p.amount, t), expires: new Date(p.expiration * 1000).toISOString(), note: 'exactly the amount of this deposit, for 30 minutes' },
      verify: async () => {
        const r = await ctx.chain.read<readonly [bigint, number, number]>({ address: PERMIT2, abi: permit2Abi, functionName: 'allowance', args: [wallet, p.token, POSM] });
        return r[0] >= p.amount && Number(r[1]) === p.expiration ? null : NOT_SEEN;
      },
    }));
  }
  let newId: bigint | null = null;
  const nft = venue === 'v3' ? NPM : POSM;
  const depositPins: PinKey[] = venue === 'v3' ? ['npm', 'v3Factory'] : ['posm', 'permit2', 'poolManager'];
  const liquidityNow = async (): Promise<bigint> => (venue === 'v3'
    ? ((await ctx.chain.read<readonly unknown[]>({ address: NPM, abi: npmAbi, functionName: 'positions', args: [pr.tokenId!] }))[7] as bigint)
    : ctx.chain.read<bigint>({ address: POSM, abi: posmAbi, functionName: 'getPositionLiquidity', args: [pr.tokenId!] }));
  steps.push(lpStep(ctx, lp, {
    label: isIncrease ? 'Add liquidity' : 'Open the position', to: nft, data, value, pins: depositPins,
    view: {
      contract: `${pinOf(nft)!.pin.name} (${nft})`,
      call: venue === 'v3'
        ? `${ethSide !== null ? 'multicall([' : ''}${isIncrease ? 'increaseLiquidity' : 'mint'}(...)${ethSide !== null ? ', refundETH()])' : ''}`
        : `modifyLiquidities([${isIncrease ? 'INCREASE_LIQUIDITY, CLOSE_CURRENCY, CLOSE_CURRENCY' : 'MINT_POSITION, SETTLE_PAIR'}${native ? ', SWEEP(ETH to the wallet)' : ''}], deadline ${deadline})`,
      ...(value > 0n ? { ethSent: `${formatUnits(value, 18)} ETH (unused ETH comes back in the same transaction)` } : {}),
      deadline: new Date(Number(deadline) * 1000).toISOString(),
    },
    ownerCheck: isIncrease ? { venue, id: pr.tokenId! } : undefined,
    onSend: () => { if (valueUsd !== null) ledger.totalUsd += valueUsd; },
    onRevert: () => { if (valueUsd !== null) ledger.totalUsd -= valueUsd; },
    after: (r) => { newId = isIncrease ? null : mintedId(r, nft, wallet); },
    verify: async () => {
      if (isIncrease) return (await liquidityNow()) > (pr.liquidity ?? 0n) ? null : NOT_SEEN;
      if (newId === null) return 'the new position id was not found in the receipt; check goatlp_positions';
      const o = await ctx.chain.read<Address>({ address: nft, abi: venue === 'v3' ? npmAbi : posmAbi, functionName: 'ownerOf', args: [newId] });
      return eq(o, wallet) ? null : NOT_SEEN;
    },
  }));

  const price = (t: number) => sig(tickToPrice(t, t0.decimals, t1.decimals));
  const symOr = (t: TokenRead) => t.symbol ?? t.address;
  const view: Record<string, unknown> = {
    action: isIncrease ? `add to ${VENUE_NAME[venue]} position #${pr.tokenId}` : `open a new ${VENUE_NAME[venue]} position`,
    pool: {
      venue, ...(venue === 'v3' ? { address: pr.pool } : { poolId: pr.poolId, hooks: 'none' }), feeTier: `${pr.fee / 10_000}%`,
      tokens: tokens.map((t, i) => ({ [`token${i}`]: t.native ? 'ETH (native)' : t.address, symbol: t.symbol, decimals: t.decimals })),
    },
    price: { [`${symOr(t1)} per ${symOr(t0)}`]: price(tick), tick },
    range: {
      tickLower: range.tickLower, tickUpper: range.tickUpper, priceLower: price(range.tickLower), priceUpper: price(range.tickUpper),
      inRange: tick >= range.tickLower && tick < range.tickUpper,
    },
    amounts: {
      given: [fmt(in0, t0), fmt(in1, t1)],
      ...(matched ? { matchedAtPoolPrice: matched } : {}),
      usesAtMost: [fmt(need[0], t0), fmt(need[1], t1)],
      expectedToAdd: [fmt(add[0], t0), fmt(add[1], t1)],
      ...(mins ? { minimums: [fmt(mins[0], t0), fmt(mins[1], t1)] } : {}),
      staysInWallet: [fmt(in0 > need[0] ? in0 - need[0] : 0n, t0), fmt(in1 > need[1] ? in1 - need[1] : 0n, t1)],
    },
    priceLimit: venue === 'v4'
      ? `goes through while the price stays within ${pct(limitBps)} of the plan's price; past that it reverts before anything is added (only gas is spent)`
      : `the minimums allow a ${pct(limitBps)} price move; past that the deposit reverts (only gas is spent)`,
    valueUsd: valueUsd === null ? null : Math.round(valueUsd * 100) / 100,
    priceCheck: pc.detail,
    ...(acks.length ? { acknowledge: acks.map((a) => `I understand that ${a}.`) } : {}),
    ...(maxDepositUsd !== undefined || maxTotalUsd !== undefined ? {
      limits: {
        ...(maxDepositUsd !== undefined ? { perDepositUsd: maxDepositUsd } : {}),
        ...(maxTotalUsd !== undefined ? { totalUsd: maxTotalUsd, depositedSoFarUsd: Math.round(ledger.totalUsd * 100) / 100 } : {}),
      },
    } : {}),
    notes: [
      'No swap: the deposit uses the two tokens as they are; what the range does not need stays in the wallet.',
      venue === 'v3' ? 'Approvals go to the Uniswap v3 position manager, for exactly this deposit.' : 'Approvals go to Permit2 and, through it, to the Uniswap v4 position manager for 30 minutes, for exactly this deposit.',
    ],
  };
  return {
    tool: 'goatlp_add_liquidity', view, steps,
    basis: { sqrtPriceX96: sqrtP.toString(), tick },
    fingerprintExtra: acks.length ? `ack:${acks.length}` : '',
    readBack: async () => (isIncrease
      ? { position: { venue, id: pr.tokenId!.toString(), liquidity: (await liquidityNow()).toString() } }
      : { newPosition: newId === null ? null : { venue, id: (newId as bigint).toString() } }),
  };
}

const NOT_SEEN = 'the chain does not show the expected result yet; check again in a moment';
const TRANSFER_TOPIC = toEventSelector('event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)');

/** The id of the position NFT minted to the wallet, from the receipt's Transfer(0x0 -> wallet) of the position manager */
function mintedId(r: TxReceipt, nft: Address, wallet: Address): bigint | null {
  for (const l of r.logs ?? []) {
    if (!eq(l.address, nft) || l.topics.length !== 4 || lc(l.topics[0]) !== lc(TRANSFER_TOPIC)) continue;
    if (BigInt(l.topics[1]) !== 0n || BigInt(l.topics[2]) !== BigInt(wallet)) continue;
    return BigInt(l.topics[3]);
  }
  return null;
}

interface LpStepIn {
  label: string; to: Address; data: Hex; value: bigint; pins: PinKey[];
  view: Record<string, unknown>;
  ownerCheck?: { venue: Venue; id: bigint };
  verify: () => Promise<string | null>;
  onSend?: () => void; onRevert?: () => void; after?: (r: TxReceipt) => void;
}

/** A deposit transaction with its checks right before signing: chain id, pins, the owner, the decode check */
function lpStep(ctx: GoatLpContext, lp: Omit<LpPlanned, 'chainId' | 'nowSec'>, s: LpStepIn): TxStep {
  return {
    kind: 'tx', label: s.label, to: s.to, data: s.data, value: s.value,
    view: { type: 'transaction', ...s.view, to: s.to, value: `${formatUnits(s.value, 18)} ETH` },
    verify: s.verify, onSend: s.onSend, onRevert: s.onRevert, after: s.after,
    precheck: async () => {
      const chainId = await ctx.chain.chainId();
      const pins = await checkPins(ctx.chain, s.pins);
      const badPin = Object.values(pins).find((p) => !p.ok);
      if (badPin) return badPin.reason;
      if (s.ownerCheck) {
        const nft = s.ownerCheck.venue === 'v3' ? { address: NPM, abi: npmAbi } : { address: POSM, abi: posmAbi };
        const o = await ctx.chain.read<Address>({ ...nft, functionName: 'ownerOf', args: [s.ownerCheck.id] } as McCall).catch(() => null);
        if (!eq(o, ctx.signer!.address)) return WRONG_OWNER_NOW;
      }
      const v = assertLpTx({ to: s.to, data: s.data, value: s.value, chainId }, { ...lp, chainId, nowSec: ctx.nowSec() });
      return v.ok ? null : `${v.reason} (${v.rule})`;
    },
  };
}

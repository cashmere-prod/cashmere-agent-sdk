// The decode check of every goatlp_add_liquidity transaction, run on the exact bytes right before they are signed. It
// knows only these shapes and refuses anything else:
//  - token.approve(spender, amount): a pool token, spender the v3 position manager (v3) or Permit2 (v4), the exact amount
//    the plan showed (never an unlimited allowance);
//  - Permit2.approve(token, v4 position manager, amount, expiration): the exact amount, expiring within 30 minutes;
//  - v3: mint / increaseLiquidity, or multicall([mint | increaseLiquidity, refundETH()]) when the WETH side is paid with ETH;
//  - v4: modifyLiquidities with exactly MINT_POSITION + SETTLE_PAIR or INCREASE_LIQUIDITY + CLOSE_CURRENCY x2, plus
//    SWEEP(ETH, wallet) in a pool of native ETH.
// The position goes to the wallet, the pool, range and amounts are the plan's, minimums never exceed the amounts, the
// deadline is in the future and within 30 minutes, and ETH is sent only where the plan pays ETH. Never setApprovalForAll, permitForAll,
// a transfer of anything, or a call to any other contract.
import { decodeAbiParameters, decodeFunctionData, toFunctionSelector, type Address, type Hex } from 'viem';
import { erc20Abi, npmAbi, permit2Abi, posmAbi } from './abis';
import { GOAT_CHAIN_ID, LP_MAX_DEADLINE_SEC, NPM, PERMIT2, PERMIT2_TTL_SEC, POSM, WETH } from './constants';
import { Actions, decodeUnlockData, REFUND_ETH, V4_PARAMS, type PoolKey, type V3IncreaseParams, type V3MintParams } from './lp/encode';
import type { TickRange } from './lp/liquidity';
import type { Venue } from './types';

export interface LpPlanned {
  venue: Venue;
  kind: 'mint' | 'increase';
  account: Address;
  /** the RPC's chain id, read right before signing */
  chainId: number;
  nowSec: number;
  /** the pool's currencies read on chain (v4: 0x0 is native ETH) */
  currencies: readonly [Address, Address];
  /** v3: the pool fee */
  fee?: number;
  /** v4: the pool key read on chain */
  key?: PoolKey;
  /** mint: the range of the new position */
  range?: TickRange;
  /** increase: the position */
  tokenId?: bigint;
  /** the exact token approvals of the plan */
  approvals: readonly { token: Address; spender: Address; amount: bigint }[];
  /** the exact Permit2 allowances of the plan (v4) */
  permit2: readonly { token: Address; amount: bigint; expiration: number }[];
  /** v3: the side whose WETH is paid with ETH */
  ethSide: 0 | 1 | null;
  /** the ETH value of the deposit */
  value: bigint;
  /** the amounts the deposit may take: v3 the desired amounts, v4 the maxima */
  need: readonly [bigint, bigint];
}

export type LpVerdict = { ok: true } | { ok: false; rule: string; reason: string };

const OK: LpVerdict = { ok: true };
const no = (rule: string, reason: string): LpVerdict => ({ ok: false, rule, reason });
const lc = (s: string) => s.toLowerCase();
const eq = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && lc(a) === lc(b);
const isZero = (a: string) => /^0x0{40}$/i.test(a);
const MAX_U160 = (1n << 160n) - 1n;

/** Selectors refused on any target, whatever the plan says */
const NEVER: ReadonlySet<string> = new Set([
  'setApprovalForAll(address,bool)', 'permitForAll(address,address,bool,uint256,uint256,bytes)', 'transfer(address,uint256)',
  'transferFrom(address,address,uint256)', 'safeTransferFrom(address,address,uint256)', 'safeTransferFrom(address,address,uint256,bytes)',
  'increaseAllowance(address,uint256)',
].map((s) => toFunctionSelector(`function ${s}`)));

function deadlineOk(deadline: bigint, nowSec: number): boolean {
  const now = BigInt(Math.floor(nowSec));
  return deadline > now && deadline <= now + BigInt(LP_MAX_DEADLINE_SEC);
}

/** The verdict on one add-liquidity transaction */
export function assertLpTx(tx: { to: Address; data: Hex; value: bigint; chainId: number }, x: LpPlanned): LpVerdict {
  if (tx.chainId !== GOAT_CHAIN_ID || x.chainId !== GOAT_CHAIN_ID) return no('chain', `the RPC is on chain ${x.chainId}, not Robinhood Chain (4663)`);
  const selector = tx.data.slice(0, 10).toLowerCase();
  if (NEVER.has(selector)) return no('function', 'a permission for all positions or a transfer is never sent');
  if (eq(tx.to, PERMIT2)) return checkPermit2(tx, x);
  if (x.currencies.some((c) => !isZero(c) && eq(c, tx.to))) return checkApprove(tx, x);
  if (x.venue === 'v3') return eq(tx.to, NPM) ? checkV3(tx, x) : no('target', `${tx.to} is not a contract this deposit uses`);
  return eq(tx.to, POSM) ? checkV4(tx, x) : no('target', `${tx.to} is not a contract this deposit uses`);
}

function checkApprove(tx: { to: Address; data: Hex; value: bigint }, x: LpPlanned): LpVerdict {
  if (tx.value !== 0n) return no('no-value', 'an approval carries no ETH');
  let d: { functionName: string; args: readonly unknown[] };
  try { d = decodeFunctionData({ abi: erc20Abi, data: tx.data }) as typeof d; } catch { return no('function', 'only approve is called on a token'); }
  if (d.functionName !== 'approve') return no('function', 'only approve is called on a token');
  const [spender, amount] = d.args as [Address, bigint];
  const want = x.venue === 'v3' ? NPM : PERMIT2;
  if (!eq(spender, want)) return no('approval', `a token is approved only for ${x.venue === 'v3' ? 'the Uniswap v3 position manager' : 'Permit2'}`);
  if (amount >= MAX_U160) return no('approval', 'an unlimited allowance is never given');
  const planned = x.approvals.find((a) => eq(a.token, tx.to) && eq(a.spender, spender));
  if (!planned || planned.amount !== amount || amount <= 0n) return no('approval', 'the allowance is not the exact amount of the plan');
  return OK;
}

function checkPermit2(tx: { to: Address; data: Hex; value: bigint }, x: LpPlanned): LpVerdict {
  if (x.venue !== 'v4') return no('target', 'Permit2 is used for v4 deposits only');
  if (tx.value !== 0n) return no('no-value', 'an approval carries no ETH');
  let d: { functionName: string; args: readonly unknown[] };
  try { d = decodeFunctionData({ abi: permit2Abi, data: tx.data }) as typeof d; } catch { return no('function', 'only Permit2.approve is called'); }
  if (d.functionName !== 'approve') return no('function', 'only Permit2.approve is called');
  const [token, spender, amount, expiration] = d.args as [Address, Address, bigint, number];
  if (!x.currencies.some((c) => !isZero(c) && eq(c, token))) return no('permit2', 'the allowance is for a token outside this pool');
  if (!eq(spender, POSM)) return no('permit2', 'the Permit2 allowance goes only to the Uniswap v4 position manager');
  if (amount >= MAX_U160) return no('permit2', 'an unlimited allowance is never given');
  const now = Math.floor(x.nowSec);
  if (!(Number(expiration) > now && Number(expiration) <= now + PERMIT2_TTL_SEC)) return no('permit2', 'the Permit2 allowance must expire within 30 minutes');
  const planned = x.permit2.find((p) => eq(p.token, token));
  if (!planned || planned.amount !== amount || planned.expiration !== Number(expiration) || amount <= 0n) return no('permit2', 'the allowance is not the exact amount of the plan');
  return OK;
}

type Call = { functionName: string; args: readonly unknown[] };
const decodeNpm = (data: Hex): Call | null => { try { return decodeFunctionData({ abi: npmAbi, data }) as unknown as Call; } catch { return null; } };

function checkV3(tx: { to: Address; data: Hex; value: bigint }, x: LpPlanned): LpVerdict {
  const top = decodeNpm(tx.data);
  if (!top) return no('function', 'the position-manager call does not decode');
  let inner: Call | null = top;
  if (x.ethSide !== null) {
    if (top.functionName !== 'multicall') return no('eth', 'paying with ETH is one multicall of the deposit and refundETH');
    const items = top.args[0] as readonly Hex[];
    if (items.length !== 2 || lc(items[1]) !== REFUND_ETH) return no('eth', 'unused ETH must come back: refundETH() must be the last call');
    if (!eq(x.currencies[x.ethSide], WETH)) return no('eth', 'only the WETH side of a pool can be paid with ETH');
    inner = decodeNpm(items[0]);
    if (!inner) return no('function', 'the deposit inside the multicall does not decode');
  } else if (tx.value !== 0n) {
    return no('value', 'this deposit carries no ETH');
  }
  let desired: [bigint, bigint]; let mins: [bigint, bigint]; let deadline: bigint;
  if (x.kind === 'mint') {
    if (inner.functionName !== 'mint') return no('function', 'expected mint');
    const m = (inner.args as readonly [V3MintParams])[0];
    if (!eq(m.recipient, x.account)) return no('recipient', 'the new position would not go to the wallet');
    if (!eq(m.token0, x.currencies[0]) || !eq(m.token1, x.currencies[1]) || Number(m.fee) !== x.fee) return no('pool', 'the mint targets a different pool');
    if (!x.range || Number(m.tickLower) !== x.range.tickLower || Number(m.tickUpper) !== x.range.tickUpper) return no('range', 'the mint range differs from the plan');
    desired = [m.amount0Desired, m.amount1Desired]; mins = [m.amount0Min, m.amount1Min]; deadline = m.deadline;
    if ((desired[0] > 0n && mins[0] <= 0n) || (desired[1] > 0n && mins[1] <= 0n)) return no('minimums', 'a minimum must be above zero for a token the mint uses');
  } else {
    if (inner.functionName !== 'increaseLiquidity') return no('function', 'expected increaseLiquidity');
    const p = (inner.args as readonly [V3IncreaseParams])[0];
    if (x.tokenId === undefined || p.tokenId !== x.tokenId) return no('position', 'wrong position id');
    desired = [p.amount0Desired, p.amount1Desired]; mins = [p.amount0Min, p.amount1Min]; deadline = p.deadline;
  }
  if (desired[0] !== x.need[0] || desired[1] !== x.need[1]) return no('amounts', 'the deposit amounts differ from the plan');
  if (mins[0] > desired[0] || mins[1] > desired[1]) return no('minimums', 'a minimum above the amount');
  if (!deadlineOk(deadline, x.nowSec)) return no('deadline', 'the deadline must be in the future and within 30 minutes');
  if (x.ethSide !== null) {
    if (tx.value <= 0n || tx.value !== desired[x.ethSide] || tx.value !== x.value) return no('value', 'the ETH sent must equal the WETH amount of the deposit');
  }
  return OK;
}

function checkV4(tx: { to: Address; data: Hex; value: bigint }, x: LpPlanned): LpVerdict {
  let top: Call;
  try { top = decodeFunctionData({ abi: posmAbi, data: tx.data }) as unknown as Call; } catch { return no('function', 'the position-manager call does not decode'); }
  if (top.functionName !== 'modifyLiquidities') return no('function', 'only modifyLiquidities is used on the v4 position manager');
  const [unlock, deadline] = top.args as [Hex, bigint];
  if (!deadlineOk(deadline, x.nowSec)) return no('deadline', 'the deadline must be in the future and within 30 minutes');
  if (!x.key) return no('pool', 'the pool key is unknown');
  let actions: number[]; let params: Hex[];
  try { ({ actions, params } = decodeUnlockData(unlock)); } catch { return no('actions', 'the actions do not decode'); }
  const native = isZero(x.key.currency0) || isZero(x.key.currency1);
  const want: number[] = x.kind === 'mint' ? [Actions.MINT_POSITION, Actions.SETTLE_PAIR] : [Actions.INCREASE_LIQUIDITY, Actions.CLOSE_CURRENCY, Actions.CLOSE_CURRENCY];
  if (native) want.push(Actions.SWEEP);
  if (actions.length !== want.length || actions.some((a, i) => a !== want[i])) return no('actions', `unexpected actions (${actions.join(', ')})`);
  try {
    let max0: bigint;
    if (x.kind === 'mint') {
      const m = decodeAbiParameters(V4_PARAMS.mint, params[0]);
      const k = m[0] as PoolKey;
      if (!eq(k.currency0, x.key.currency0) || !eq(k.currency1, x.key.currency1) || Number(k.fee) !== x.key.fee
        || Number(k.tickSpacing) !== x.key.tickSpacing || !eq(k.hooks, x.key.hooks)) return no('pool', 'the mint targets a different pool');
      if (!x.range || Number(m[1]) !== x.range.tickLower || Number(m[2]) !== x.range.tickUpper) return no('range', 'the mint range differs from the plan');
      if ((m[3] as bigint) <= 0n) return no('actions', 'the mint adds no liquidity');
      if (!eq(m[6] as Address, x.account)) return no('recipient', 'the new position would not go to the wallet');
      if (m[7] !== '0x') return no('hook-data', 'unexpected hook data');
      if (m[4] !== x.need[0] || m[5] !== x.need[1]) return no('amounts', 'the deposit amounts differ from the plan');
      max0 = m[4] as bigint;
      const [s0, s1] = decodeAbiParameters(V4_PARAMS.settlePair, params[1]);
      if (!eq(s0, x.key.currency0) || !eq(s1, x.key.currency1)) return no('actions', 'SETTLE_PAIR names other tokens than the pool');
    } else {
      const p = decodeAbiParameters(V4_PARAMS.increase, params[0]);
      if (x.tokenId === undefined || p[0] !== x.tokenId) return no('position', 'wrong position id');
      if ((p[1] as bigint) <= 0n) return no('actions', 'the increase adds no liquidity');
      if (p[4] !== '0x') return no('hook-data', 'unexpected hook data');
      if (p[2] !== x.need[0] || p[3] !== x.need[1]) return no('amounts', 'the deposit amounts differ from the plan');
      max0 = p[2] as bigint;
      const [c0] = decodeAbiParameters(V4_PARAMS.close, params[1]);
      const [c1] = decodeAbiParameters(V4_PARAMS.close, params[2]);
      if (!eq(c0, x.key.currency0) || !eq(c1, x.key.currency1)) return no('actions', 'CLOSE_CURRENCY names other tokens than the pool');
    }
    if (native) {
      const [cur, to] = decodeAbiParameters(V4_PARAMS.sweep, params[params.length - 1]);
      if (!isZero(cur)) return no('actions', 'the leftover sweep must be ETH');
      if (!eq(to, x.account)) return no('recipient', 'leftover ETH would not come back to the wallet');
      if (tx.value !== max0 || tx.value !== x.value) return no('value', 'the ETH sent must equal the ETH maximum of the deposit');
    } else if (tx.value !== 0n) {
      return no('value', 'ETH sent to a pool without native ETH');
    }
  } catch {
    return no('actions', 'the action parameters do not decode');
  }
  return OK;
}

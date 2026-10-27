// The deposit calls of the two position managers, as the app builds them (no swap, no helper contract):
//  - v3 NonfungiblePositionManager: mint(params) / increaseLiquidity(params); paying the WETH side with ETH:
//    multicall([mint | increaseLiquidity, refundETH()]) with value = the WETH side's desired amount (refundETH last, so
//    unused ETH comes back in the same transaction).
//  - v4 PositionManager.modifyLiquidities(unlockData, deadline):
//    mint:     MINT_POSITION(key, range, L, max0, max1, owner, no hook data) + SETTLE_PAIR(c0, c1)
//    increase: INCREASE_LIQUIDITY(id, L, max0, max1, no hook data) + CLOSE_CURRENCY(c0) + CLOSE_CURRENCY(c1)
//    plus SWEEP(ETH, owner) in a pool of native ETH, so leftover ETH comes back to the owner in the same call.
//    The increase closes each currency instead of SETTLE_PAIR: it pays what is owed, or takes a fee credit that is larger.
import { decodeAbiParameters, encodeAbiParameters, encodeFunctionData, encodePacked, type Address, type Hex } from 'viem';
import { npmAbi, posmAbi } from '../abis';

/** v4-periphery action numbers */
export const Actions = {
  INCREASE_LIQUIDITY: 0x00, DECREASE_LIQUIDITY: 0x01, MINT_POSITION: 0x02, BURN_POSITION: 0x03,
  INCREASE_LIQUIDITY_FROM_DELTAS: 0x04, MINT_POSITION_FROM_DELTAS: 0x05,
  SWAP_EXACT_IN_SINGLE: 0x06, SWAP_EXACT_IN: 0x07, SWAP_EXACT_OUT_SINGLE: 0x08, SWAP_EXACT_OUT: 0x09, DONATE: 0x0a,
  SETTLE: 0x0b, SETTLE_ALL: 0x0c, SETTLE_PAIR: 0x0d, TAKE: 0x0e, TAKE_ALL: 0x0f, TAKE_PORTION: 0x10, TAKE_PAIR: 0x11,
  CLOSE_CURRENCY: 0x12, CLEAR_OR_TAKE: 0x13, SWEEP: 0x14, WRAP: 0x15, UNWRAP: 0x16,
} as const;

export interface PoolKey { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }

const ZERO = '0x0000000000000000000000000000000000000000' as Address;
const isZero = (a: string) => /^0x0{40}$/i.test(a);

const poolKeyComponents = [
  { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' },
] as const;

/** Parameter types of the actions the deposits use */
export const V4_PARAMS = {
  increase: [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'bytes' }],
  mint: [
    { type: 'tuple', components: poolKeyComponents }, { type: 'int24' }, { type: 'int24' }, { type: 'uint256' },
    { type: 'uint128' }, { type: 'uint128' }, { type: 'address' }, { type: 'bytes' },
  ],
  settlePair: [{ type: 'address' }, { type: 'address' }],
  close: [{ type: 'address' }],
  sweep: [{ type: 'address' }, { type: 'address' }],
} as const;

export function unlockData(actions: readonly number[], params: readonly Hex[]): Hex {
  if (actions.length !== params.length) throw new Error('actions and params differ in length');
  const packed = encodePacked(actions.map(() => 'uint8'), actions as number[]);
  return encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [packed, params as Hex[]]);
}

/** unlockData -> (actions, params); throws on malformed data */
export function decodeUnlockData(data: Hex): { actions: number[]; params: Hex[] } {
  const [packed, params] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], data);
  const s = packed.slice(2);
  const actions: number[] = [];
  for (let i = 0; i < s.length; i += 2) actions.push(parseInt(s.slice(i, i + 2), 16));
  if (actions.length !== params.length) throw new Error('actions and params differ in length');
  return { actions, params: [...params] };
}

/** A new v4 position paid from the wallet (Permit2 for tokens, msg.value for native ETH) */
export function encodeV4Mint(key: PoolKey, tickLower: number, tickUpper: number, liquidity: bigint, amount0Max: bigint, amount1Max: bigint, owner: Address): Hex {
  if (/^0x0{39}[0-2]$/i.test(owner)) throw new Error('the owner must be the wallet address');
  const actions: number[] = [Actions.MINT_POSITION, Actions.SETTLE_PAIR];
  const params: Hex[] = [
    encodeAbiParameters(V4_PARAMS.mint, [key, tickLower, tickUpper, liquidity, amount0Max, amount1Max, owner, '0x']),
    encodeAbiParameters(V4_PARAMS.settlePair, [key.currency0, key.currency1]),
  ];
  if (isZero(key.currency0) || isZero(key.currency1)) { actions.push(Actions.SWEEP); params.push(encodeAbiParameters(V4_PARAMS.sweep, [ZERO, owner])); }
  return unlockData(actions, params);
}

/** More liquidity for an existing v4 position */
export function encodeV4Increase(tokenId: bigint, liquidity: bigint, amount0Max: bigint, amount1Max: bigint, currency0: Address, currency1: Address, recipient: Address): Hex {
  if (!recipient || /^0x0{39}[0-2]$/i.test(recipient)) throw new Error('the recipient must be the wallet address');
  const actions: number[] = [Actions.INCREASE_LIQUIDITY, Actions.CLOSE_CURRENCY, Actions.CLOSE_CURRENCY];
  const params: Hex[] = [
    encodeAbiParameters(V4_PARAMS.increase, [tokenId, liquidity, amount0Max, amount1Max, '0x']),
    encodeAbiParameters(V4_PARAMS.close, [currency0]),
    encodeAbiParameters(V4_PARAMS.close, [currency1]),
  ];
  if (isZero(currency0) || isZero(currency1)) { actions.push(Actions.SWEEP); params.push(encodeAbiParameters(V4_PARAMS.sweep, [ZERO, recipient])); }
  return unlockData(actions, params);
}

export const modifyLiquiditiesData = (unlock: Hex, deadline: bigint): Hex =>
  encodeFunctionData({ abi: posmAbi, functionName: 'modifyLiquidities', args: [unlock, deadline] });

// ------------------------------------------------------------------ v3

export interface V3MintParams {
  token0: Address; token1: Address; fee: number; tickLower: number; tickUpper: number;
  amount0Desired: bigint; amount1Desired: bigint; amount0Min: bigint; amount1Min: bigint; recipient: Address; deadline: bigint;
}
export interface V3IncreaseParams {
  tokenId: bigint; amount0Desired: bigint; amount1Desired: bigint; amount0Min: bigint; amount1Min: bigint; deadline: bigint;
}

/** PeripheryPayments.refundETH() (no arguments) */
export const REFUND_ETH: Hex = '0x12210e8a';

export const v3MintData = (p: V3MintParams): Hex => encodeFunctionData({ abi: npmAbi, functionName: 'mint', args: [p] });
export const v3IncreaseData = (p: V3IncreaseParams): Hex => encodeFunctionData({ abi: npmAbi, functionName: 'increaseLiquidity', args: [p] });
/** A v3 deposit whose WETH side is paid with ETH: [deposit, refundETH()] in one multicall */
export const v3WithEthData = (deposit: Hex): Hex => encodeFunctionData({ abi: npmAbi, functionName: 'multicall', args: [[deposit, REFUND_ETH]] });

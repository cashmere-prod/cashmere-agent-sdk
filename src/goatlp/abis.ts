// Uniswap, ERC-20, Permit2 and Multicall interfaces used by the Goat LP tools, the EIP-712 Permit type of the v4 position
// NFT, and the function lists the decode checks refuse. The Goat LP contracts' own interfaces are in ./contractAbis.ts.
import type { Abi } from 'viem';
import {
  autoExitAbi, autoExitRefusedAbi, autoRangeAbi, autoRangeRefusedAbi, gac3Abi, gac3RefusedAbi, gac4Abi, gac4RefusedAbi, gv4cAbi,
  pairTableAbi, priceAnchorAbi, registryAbi, stewardAbi, stewardRefusedAbi,
} from './contractAbis';
import type { ContractKey } from './types';

export {
  autoExitAbi, autoExitRefusedAbi, autoRangeAbi, autoRangeRefusedAbi, gac3Abi, gac3RefusedAbi, gac4Abi, gac4RefusedAbi, gv4cAbi,
  pairTableAbi, priceAnchorAbi, registryAbi, stewardAbi, stewardRefusedAbi,
};

/** EIP-712 domain of the Uniswap v4 position NFT: name, chainId and verifyingContract, no version */
export const POSM_DOMAIN_NAME = 'Uniswap v4 Positions NFT';
export const PERMIT_TYPES = {
  Permit: [
    { name: 'spender', type: 'address' }, { name: 'tokenId', type: 'uint256' },
    { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
  ],
} as const;

const poolKeyComponents = [
  { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' },
] as const;

/** Uniswap v4 PositionManager: the approval slot, unordered nonces, multicall, permit (simulated only), liquidity entry */
export const posmAbi = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'id', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'getApproved', stateMutability: 'view', inputs: [{ name: 'id', type: 'uint256' }], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ name: 'id', type: 'uint256' }], outputs: [{ name: 'owner', type: 'address' }] },
  { type: 'function', name: 'nonces', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'word', type: 'uint256' }], outputs: [{ name: 'bitmap', type: 'uint256' }] },
  { type: 'function', name: 'revokeNonce', stateMutability: 'payable', inputs: [{ name: 'nonce', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'multicall', stateMutability: 'payable', inputs: [{ name: 'data', type: 'bytes[]' }], outputs: [{ name: 'results', type: 'bytes[]' }] },
  { type: 'function', name: 'permit', stateMutability: 'payable',
    inputs: [{ name: 'spender', type: 'address' }, { name: 'tokenId', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'signature', type: 'bytes' }], outputs: [] },
  { type: 'function', name: 'DOMAIN_SEPARATOR', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'bytes32' }] },
  { type: 'function', name: 'getPositionLiquidity', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ name: 'liquidity', type: 'uint128' }] },
  { type: 'function', name: 'getPoolAndPositionInfo', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: 'poolKey', type: 'tuple', components: poolKeyComponents }, { name: 'info', type: 'uint256' }] },
  { type: 'function', name: 'nextTokenId', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'modifyLiquidities', stateMutability: 'payable', inputs: [{ name: 'unlockData', type: 'bytes' }, { name: 'deadline', type: 'uint256' }], outputs: [] },
] as const;

/** Uniswap v3 NonfungiblePositionManager: the approval slot, the position, mint / increase, multicall, refundETH */
export const npmAbi = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'tokenId', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'getApproved', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ name: 'owner', type: 'address' }] },
  { type: 'function', name: 'positions', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [
      { name: 'nonce', type: 'uint96' }, { name: 'operator', type: 'address' }, { name: 'token0', type: 'address' }, { name: 'token1', type: 'address' },
      { name: 'fee', type: 'uint24' }, { name: 'tickLower', type: 'int24' }, { name: 'tickUpper', type: 'int24' }, { name: 'liquidity', type: 'uint128' },
      { name: 'feeGrowthInside0LastX128', type: 'uint256' }, { name: 'feeGrowthInside1LastX128', type: 'uint256' },
      { name: 'tokensOwed0', type: 'uint128' }, { name: 'tokensOwed1', type: 'uint128' }] },
  { type: 'function', name: 'mint', stateMutability: 'payable',
    inputs: [{ name: 'params', type: 'tuple', components: [
      { name: 'token0', type: 'address' }, { name: 'token1', type: 'address' }, { name: 'fee', type: 'uint24' },
      { name: 'tickLower', type: 'int24' }, { name: 'tickUpper', type: 'int24' },
      { name: 'amount0Desired', type: 'uint256' }, { name: 'amount1Desired', type: 'uint256' },
      { name: 'amount0Min', type: 'uint256' }, { name: 'amount1Min', type: 'uint256' },
      { name: 'recipient', type: 'address' }, { name: 'deadline', type: 'uint256' }] }],
    outputs: [{ name: 'tokenId', type: 'uint256' }, { name: 'liquidity', type: 'uint128' }, { name: 'amount0', type: 'uint256' }, { name: 'amount1', type: 'uint256' }] },
  { type: 'function', name: 'increaseLiquidity', stateMutability: 'payable',
    inputs: [{ name: 'params', type: 'tuple', components: [
      { name: 'tokenId', type: 'uint256' }, { name: 'amount0Desired', type: 'uint256' }, { name: 'amount1Desired', type: 'uint256' },
      { name: 'amount0Min', type: 'uint256' }, { name: 'amount1Min', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] }],
    outputs: [{ name: 'liquidity', type: 'uint128' }, { name: 'amount0', type: 'uint256' }, { name: 'amount1', type: 'uint256' }] },
  { type: 'function', name: 'multicall', stateMutability: 'payable', inputs: [{ name: 'data', type: 'bytes[]' }], outputs: [{ name: 'results', type: 'bytes[]' }] },
  { type: 'function', name: 'refundETH', stateMutability: 'payable', inputs: [], outputs: [] },
  { type: 'function', name: 'factory', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
] as const;

/** Refused on both position managers: selectors only, never encoded by a builder */
export const nftRefusedAbi = [
  { type: 'function', name: 'setApprovalForAll', stateMutability: 'nonpayable', inputs: [{ name: 'operator', type: 'address' }, { name: 'approved', type: 'bool' }], outputs: [] },
  { type: 'function', name: 'permitForAll', stateMutability: 'payable',
    inputs: [{ name: 'owner', type: 'address' }, { name: 'operator', type: 'address' }, { name: 'approved', type: 'bool' }, { name: 'deadline', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'signature', type: 'bytes' }], outputs: [] },
  { type: 'function', name: 'transferFrom', stateMutability: 'payable', inputs: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'id', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'safeTransferFrom', stateMutability: 'payable', inputs: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'id', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'safeTransferFrom', stateMutability: 'payable', inputs: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'id', type: 'uint256' }, { name: 'data', type: 'bytes' }], outputs: [] },
  { type: 'function', name: 'permit', stateMutability: 'payable',
    inputs: [{ name: 'spender', type: 'address' }, { name: 'tokenId', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'v', type: 'uint8' }, { name: 'r', type: 'bytes32' }, { name: 's', type: 'bytes32' }], outputs: [] },
  { type: 'function', name: 'collect', stateMutability: 'payable',
    inputs: [{ name: 'params', type: 'tuple', components: [{ name: 'tokenId', type: 'uint256' }, { name: 'recipient', type: 'address' }, { name: 'amount0Max', type: 'uint128' }, { name: 'amount1Max', type: 'uint128' }] }], outputs: [] },
  { type: 'function', name: 'decreaseLiquidity', stateMutability: 'payable',
    inputs: [{ name: 'params', type: 'tuple', components: [{ name: 'tokenId', type: 'uint256' }, { name: 'liquidity', type: 'uint128' }, { name: 'amount0Min', type: 'uint256' }, { name: 'amount1Min', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] }], outputs: [] },
  { type: 'function', name: 'burn', stateMutability: 'payable', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [] },
] as const;

export const erc20Abi = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] },
] as const;

/** Refused on any token: only an exact approve is ever sent to a token */
export const erc20RefusedAbi = [
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'transferFrom', stateMutability: 'nonpayable', inputs: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'increaseAllowance', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'added', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
] as const;

/** Permit2 allowance surface: approve(token, spender, uint160 amount, uint48 expiration) and the allowance read */
export const permit2Abi = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable',
    inputs: [{ name: 'token', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }], outputs: [] },
  { type: 'function', name: 'allowance', stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }, { name: 'token', type: 'address' }, { name: 'spender', type: 'address' }],
    outputs: [{ name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }] },
] as const;

export const v3FactoryAbi = [
  { type: 'function', name: 'getPool', stateMutability: 'view',
    inputs: [{ name: 'tokenA', type: 'address' }, { name: 'tokenB', type: 'address' }, { name: 'fee', type: 'uint24' }], outputs: [{ name: 'pool', type: 'address' }] },
] as const;

export const v3PoolAbi = [
  { type: 'function', name: 'slot0', stateMutability: 'view', inputs: [],
    outputs: [{ name: 'sqrtPriceX96', type: 'uint160' }, { name: 'tick', type: 'int24' }, { name: 'observationIndex', type: 'uint16' },
      { name: 'observationCardinality', type: 'uint16' }, { name: 'observationCardinalityNext', type: 'uint16' }, { name: 'feeProtocol', type: 'uint8' }, { name: 'unlocked', type: 'bool' }] },
  { type: 'function', name: 'token0', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'token1', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'fee', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint24' }] },
  { type: 'function', name: 'tickSpacing', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'int24' }] },
] as const;

/** The v4 PoolManager's raw storage read (slot0 of a pool lives at keccak(poolId, 6)) */
export const poolManagerAbi = [
  { type: 'function', name: 'extsload', stateMutability: 'view', inputs: [{ name: 'slot', type: 'bytes32' }], outputs: [{ name: '', type: 'bytes32' }] },
] as const;

/** ABI of each automation contract (owner writes and reads) */
export const CONTRACT_ABI: Readonly<Record<ContractKey, Abi>> = {
  autoCompoundV3: gac3Abi as unknown as Abi,
  autoCompoundV4: gac4Abi as unknown as Abi,
  rangeExitV3: autoRangeAbi as unknown as Abi,
  exitV3: autoExitAbi as unknown as Abi,
  rangeExitV4: stewardAbi as unknown as Abi,
};
/** Keeper-only entry points of each automation contract (always refused) */
export const CONTRACT_REFUSED_ABI: Readonly<Record<ContractKey, Abi>> = {
  autoCompoundV3: gac3RefusedAbi as unknown as Abi,
  autoCompoundV4: gac4RefusedAbi as unknown as Abi,
  rangeExitV3: autoRangeRefusedAbi as unknown as Abi,
  exitV3: autoExitRefusedAbi as unknown as Abi,
  rangeExitV4: stewardRefusedAbi as unknown as Abi,
};

/** Every custom error of the Goat LP contracts, for naming a revert */
export const GOAT_ERROR_ABIS: readonly Abi[] = [
  gac3Abi, gac4Abi, gv4cAbi, stewardAbi, registryAbi, autoRangeAbi, autoExitAbi, pairTableAbi, priceAnchorAbi,
  [{ type: 'error', name: 'NothingToCompound', inputs: [] }],
].map((a) => (a as unknown as Abi).filter((x) => x.type === 'error') as Abi);

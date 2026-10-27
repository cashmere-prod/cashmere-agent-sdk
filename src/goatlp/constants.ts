// Goat LP on Robinhood Chain: chain facts, the contract addresses (the same list as the Goat LP contracts page of the
// Cashmere docs), the runtime code hash each contract must have, and the limits and defaults the automation tools use.
// Every address a Goat LP transaction is sent to, or that is given a permission, is in PINS: the tools refuse anything else.
import type { Address, Hex } from 'viem';

export const GOAT_CHAIN_ID = 4663;
export const GOAT_CHAIN_NAME = 'Robinhood Chain';
export const DEFAULT_ROBINHOOD_RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';
export const EXPLORER_URL = 'https://robin.etherscan.io';
export const GOAT_API_BASE = 'https://api.cashmere.exchange';

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;

// Uniswap and shared contracts on Robinhood Chain
export const NPM: Address = '0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3';
export const POSM: Address = '0x58daec3116aae6D93017bAAea7749052E8a04fA7';
export const POOL_MANAGER: Address = '0x8366a39CC670B4001A1121B8F6A443A643e40951';
export const PERMIT2: Address = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
export const V3_FACTORY: Address = '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA';
export const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11';
export const WETH: Address = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
export const USDG: Address = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
/** Revert Finance's helper contracts: never a target or an argument of a Goat LP tool transaction */
export const V3UTILS: Address = '0x98eC492942090364AC0736Ef1A741AE6C92ec790';
export const V4UTILS: Address = '0xd322Dc8F96004d2A92a2ae821b99D25eBB2a3EA4';

// Goat LP contracts
export const GOAT_AUTO_COMPOUND_V3: Address = '0x4A036a2d8FD1d2C0110A9d775ae269fFE6Ea8390';
export const GOAT_AUTO_COMPOUND_V4: Address = '0xb0d066E7E9B21c3AbDCe9b26A767155F48Ed0500';
export const AUTO_RANGE_V3: Address = '0xF0436e6B378e7d4b1Fb17860673C091A32Fb19cD';
export const AUTO_EXIT_V3: Address = '0xe337A443237a9eA7ED3b0610F70c24c040438161';
export const GOAT_V4_STEWARD: Address = '0xBb6494D891bd9cCCf11ADd32FD61Afe246164b3d';
export const GOAT_V4_STEWARD_ENGINE: Address = '0xD12D46c9d3B1FE463895A20daD19F3cae5584892';
export const GOAT_V4_COMPOUNDOR: Address = '0x307db4605691Ca81bAe9DD162de6F8De319224f5';
export const GOAT_V4_PAIR_REGISTRY: Address = '0x92f449da205552Eadbb51C05888EEDE1657B4048';
export const GOAT_PAIR_TABLE: Address = '0xbBF00DD403BFf43400ed3D32a29cF4eC580026De';
export const GOAT_PRICE_ANCHOR: Address = '0x5799d99837d2736C6506AD5EE0727968B708A566';
/** Every Goat LP fee goes here: each fee-taking contract's recipient must be this address before a rule is turned on */
export const GOAT_TREASURY: Address = '0x2bf95e5f307FB84e19851865193a14DaB01A561F';

export type PinKey =
  | 'autoCompoundV3' | 'autoCompoundV4' | 'rangeExitV3' | 'exitV3' | 'rangeExitV4' | 'engine' | 'compoundorV4'
  | 'registry' | 'pairTable' | 'priceAnchor' | 'npm' | 'posm' | 'permit2' | 'multicall3' | 'poolManager' | 'v3Factory';

export interface Pin { name: string; address: Address; codehash: Hex }

/**
 * keccak256 of each contract's runtime code. None of these contracts is upgradeable, so the code at the address never
 * changes; a different hash means a different contract, and every Goat LP write refuses it.
 */
export const PINS: Readonly<Record<PinKey, Pin>> = Object.freeze({
  autoCompoundV3: { name: 'GoatAutoCompoundV3', address: GOAT_AUTO_COMPOUND_V3, codehash: '0xbf1e59d6b9f135a1346aceba4398a7c1e3661a97341f9df6b67cf2b5330afd4c' },
  autoCompoundV4: { name: 'GoatAutoCompoundV4', address: GOAT_AUTO_COMPOUND_V4, codehash: '0x0b660907898545cf88e21a93f49e652823a61d960865d5fcae68751c6984d943' },
  rangeExitV3: { name: 'AutoRange', address: AUTO_RANGE_V3, codehash: '0x2b03dbe475892b15a3b52d23440dbd3b175264d8e0d20344e38fcf009e0b299e' },
  exitV3: { name: 'AutoExit', address: AUTO_EXIT_V3, codehash: '0x07e14f677d27248b020a8ea4321cbd703aca9e396931d87942af6c11f0e5f9ed' },
  rangeExitV4: { name: 'GoatV4Steward', address: GOAT_V4_STEWARD, codehash: '0x85de7acc0e65faa88a37ef742e6ad40181c523d3dbac7f976b03ed5b1160d125' },
  engine: { name: 'GoatV4StewardEngine', address: GOAT_V4_STEWARD_ENGINE, codehash: '0xc662bd8f36221591573e4e61a709795292c59dc2bb62a25e948a1aee7a3fd57d' },
  compoundorV4: { name: 'GoatV4Compoundor', address: GOAT_V4_COMPOUNDOR, codehash: '0x96eb7bdfe19e3b6c08aa37a3dba255cf4d0772fc3c89c68502f214286104f387' },
  registry: { name: 'GoatV4PairRegistry', address: GOAT_V4_PAIR_REGISTRY, codehash: '0xafb923c0ef7b8fe378726a7d389627ee3d69dd1beb8f1d2c5dab20742352983f' },
  pairTable: { name: 'GoatPairTable', address: GOAT_PAIR_TABLE, codehash: '0x8226503348a3ca70bc7352691400e7e8109eba06d2c3ad1991df686c033b7979' },
  priceAnchor: { name: 'GoatPriceAnchor', address: GOAT_PRICE_ANCHOR, codehash: '0x0b4ce9f6c9b7d4448fc1a5f2570ec2fe6223922d7852ea62a4941175f20321c9' },
  npm: { name: 'Uniswap v3 NonfungiblePositionManager', address: NPM, codehash: '0x0a493d1af3d0f25fed8efa205244ebee14114267a08647fc38c515c7cd6ead4f' },
  posm: { name: 'Uniswap v4 PositionManager', address: POSM, codehash: '0xc873e135dc9aaec88489cfbad146b4cb49d6a32e0d80326377784b7ba17670b2' },
  permit2: { name: 'Permit2', address: PERMIT2, codehash: '0x5208783f52488f7d3493e5e38311ab707c1d75457fe472a19b0b4d57d66a7fca' },
  multicall3: { name: 'Multicall3', address: MULTICALL3, codehash: '0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891' },
  poolManager: { name: 'Uniswap v4 PoolManager', address: POOL_MANAGER, codehash: '0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626' },
  v3Factory: { name: 'Uniswap v3 Factory', address: V3_FACTORY, codehash: '0xec72b1abd1f2faee020cfea9c646bd8994f9fb389054f6e574f103a895091739' },
});

/** The pin of an address, or null when the address is not one of the pinned contracts. */
export function pinOf(address: string | null | undefined): { key: PinKey; pin: Pin } | null {
  if (!address) return null;
  const a = address.toLowerCase();
  for (const [key, pin] of Object.entries(PINS) as [PinKey, Pin][]) if (pin.address.toLowerCase() === a) return { key, pin };
  return null;
}

// ------------------------------------------------------------------ automation limits and defaults

export const HOUR = 3600;
export const DAY = 86_400;

/** Fees shown until the live value is read from the contract: auto-compound 10%, auto-range and auto-exit 0.15% */
export const PLANNED_FEES = { compoundBps: 1000, rangeBps: 15, exitBps: 15 } as const;

/** Auto-compound "at most once every": 1 hour, the contracts' floor */
export const COMPOUND_INTERVAL_DEFAULT = HOUR;
export const COMPOUND_INTERVAL_PRESETS: readonly number[] = [HOUR, 6 * HOUR, 12 * HOUR, DAY, 7 * DAY];
export const COMPOUND_SLIP_DEFAULT_BPS = 100;

/** v4 auto-compound signed messages: one per run, at most 30 per signing session (one nonce word), at most 90 days */
export const RUNS_TO_SIGN_DEFAULT = 12;
export const HORIZON_DEFAULT_DAYS = 30;
export const HORIZON_MAX_DAYS = 90;
export const HORIZON_MAX_SEC = HORIZON_MAX_DAYS * DAY;
export const MAX_RUNS_PER_SESSION = 30;
/** Nonce words one position can ever sign in: its base word and the next 15 */
export const SESSION_WORDS_MAX = 16;
/** A position under the minimum size signs 4 runs for 90 days */
export const SMALL_RUNS_TO_SIGN = 4;
export const SMALL_HORIZON_DAYS = 90;

/** v4 auto-range: "at most one move every", default 6 hours */
export const RANGE_INTERVAL_DEFAULT = 6 * HOUR;
/** auto-range / auto-exit price protection default 0.50% */
export const RANGE_SLIP_DEFAULT_BPS = 50;
/** highest pool fee accepted for the swap inside a move, default 1% (10,000 pips) */
export const MAX_SWAP_FEE_DEFAULT_PIPS = 10_000;
/** auto-range is not offered under this position value (USD) unless the served policy gives another figure */
export const RANGE_MIN_MOVABLE_USD = 50;
/** moves a v4 auto-range rule may make before it asks to be saved again */
export const STEWARD_BUDGET = 20;
/** suggested auto-exit level: 5% beyond the range edge */
export const EXIT_DEFAULT_OFFSET_PCT = 5;
export const RUN_DEADLINE_SEC = 300;

/** What the contracts themselves refuse */
export const BOUNDS = {
  gac3: { maxSlippageBps: 500, minInterval: HOUR },
  gac4: { maxSlippageBps: 2000, minInterval: HOUR },
  steward: {
    maxTriggerTicks: 20_000, minSlippageBps: 10, hookFreeMaxSlippageBps: 100, minInterval: HOUR, maxInterval: 30 * DAY,
    maxBudget: 20, maxSwapFeePips: 100_000, minWidthTicks: 400,
  },
  tick: { min: -887_272, max: 887_272 },
} as const;

/** Steward modes and exit flags */
export const ST_MODE = { NONE: 0, RECENTER: 1, EXIT: 2 } as const;
export const ST_FLAG = { LOWER_ON: 1, UPPER_ON: 2, SWAP_ON_LOWER: 4, SWAP_ON_UPPER: 8, STANDING: 16 } as const;
/** v4 registry price-source kinds: every listed kind except 0 gives the pair a price source */
export const PRICE_SOURCE_KINDS: ReadonlySet<number> = new Set([1, 2, 3, 4, 5, 6]);
export const hasPriceSource = (srcKind: number): boolean => PRICE_SOURCE_KINDS.has(Number(srcKind));
/** Registry kinds of a pair priced without Chainlink */
export const NC_SRC_KINDS: ReadonlySet<number> = new Set([3, 4, 5]);
/** "No metering" value of a swap cap */
export const CAP_UNLIMITED = (1n << 128n) - 1n;

// ------------------------------------------------------------------ add liquidity

/** The longest deadline of a position-manager transaction */
export const LP_MAX_DEADLINE_SEC = 1800;
/** Deadline the add-liquidity plan uses: 20 minutes after the plan is made (the plan itself lasts 10) */
export const LP_DEADLINE_SEC = 1200;
/** Permit2 allowance to the v4 position manager: exact amount, 30 minutes */
export const PERMIT2_TTL_SEC = 1800;
export const DEPOSIT_SLIPPAGE_DEFAULT_BPS = 100;
export const DEPOSIT_SLIPPAGE_MIN_BPS = 1;
export const DEPOSIT_SLIPPAGE_MAX_BPS = 300;

/** How long a plan can be executed after it was made */
export const PLAN_TTL_MS = 10 * 60 * 1000;

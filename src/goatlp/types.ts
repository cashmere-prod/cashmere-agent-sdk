// Shared shapes of the Goat LP tools: automation kinds and venues, rule drafts, on-chain rule reads, pool and position
// facts, eligibility verdicts and the calls the builders produce. Token ids are bigint inside the package.
import type { Abi, Address, Hex } from 'viem';

export type Kind = 'compound' | 'range' | 'exit';
export type Venue = 'v3' | 'v4';
export const KINDS: readonly Kind[] = ['compound', 'range', 'exit'];

/** The five automation contracts */
export type ContractKey = 'autoCompoundV3' | 'autoCompoundV4' | 'rangeExitV3' | 'exitV3' | 'rangeExitV4';

/** Whether a contract may be used now: its address is pinned and its live code hash equals the pin */
export interface ContractGate { ok: boolean; reason: string }
export type ContractGates = Readonly<Record<ContractKey, ContractGate>>;

// ------------------------------------------------------------------ rule drafts (inputs -> builders)

export type CompoundMode = 'addBack' | 'claim';

export interface CompoundV3Draft { kind: 'compound'; venue: 'v3'; swapEnabled: boolean; maxSlippageBps: number; minInterval: number }
export interface CompoundV4Draft {
  kind: 'compound'; venue: 'v4'; mode: CompoundMode;
  maxSlippageBps: number; minInterval: number;
  /** signed messages to sign now (1..30) and how many days they last (1..90) */
  runsToSign: number; horizonDays: number;
}
export interface RangeV4Draft { kind: 'range'; venue: 'v4'; triggerTicks: number; slippageBps: number; minInterval: number; maxSwapFeePips: number }
export interface RangeV3Draft { kind: 'range'; venue: 'v3'; triggerTicks: number; widthTicks: number; slippageBps: number }
export interface ExitSide { on: boolean; tick: number; swap: boolean }
export interface ExitV4Draft { kind: 'exit'; venue: 'v4'; lower: ExitSide; upper: ExitSide; slippageBps: number; maxSwapFeePips: number }
export interface ExitV3Draft { kind: 'exit'; venue: 'v3'; lower: ExitSide; upper: ExitSide; slippageBps: number }
export type RuleDraft = CompoundV3Draft | CompoundV4Draft | RangeV4Draft | RangeV3Draft | ExitV4Draft | ExitV3Draft;

// ------------------------------------------------------------------ on-chain rule reads

export interface Gac3Config { enabled: boolean; swapEnabled: boolean; maxSlippageBps: number; minInterval: number; lastRunAt: number; minReward0: bigint; minReward1: bigint }
export interface Gac4Config { enabled: boolean; claimOnly: boolean; allowStandingApproval: boolean; maxSlippageBps: number; minInterval: number; lastRunAt: number; minLiquidityDelta: bigint }
/** Steward rule: mode 0 none, 1 auto-range, 2 auto-exit */
export interface StewardConfig {
  mode: number; triggerTicks: number; slippageBps: number; minInterval: number; budget: number; lastRunAt: number; flags: number;
  lowerTrigger: number; upperTrigger: number; pairEpoch: number; maxSwapFeePips: number;
}
export interface ArConfig { lowerTickLimit: number; upperTickLimit: number; lowerTickDelta: number; upperTickDelta: number; token0SlippageX64: bigint; token1SlippageX64: bigint; onlyFees: boolean; autoCompound: boolean; maxRewardX64: bigint }
export interface AeConfig { isActive: boolean; token0Swap: boolean; token1Swap: boolean; token0TriggerTick: number; token1TriggerTick: number; token0SlippageX64: bigint; token1SlippageX64: bigint; onlyFees: boolean; maxRewardX64: bigint }

export type RuleRead =
  | { kind: 'compound'; venue: 'v3'; on: boolean; owner: Address | null; cfg: Gac3Config }
  | { kind: 'compound'; venue: 'v4'; on: boolean; owner: Address | null; cfg: Gac4Config }
  | { kind: 'range'; venue: 'v4'; on: boolean; owner: Address | null; cfg: StewardConfig }
  | { kind: 'exit'; venue: 'v4'; on: boolean; owner: Address | null; cfg: StewardConfig }
  | { kind: 'range'; venue: 'v3'; on: boolean; owner: Address | null; cfg: ArConfig }
  | { kind: 'exit'; venue: 'v3'; on: boolean; owner: Address | null; cfg: AeConfig };

/** A value whose read failed is 'unknown' (never taken as off) */
export type Maybe<T> = T | 'unknown';

// ------------------------------------------------------------------ facts

/** Pool-level facts. A field left undefined was not read. */
export interface PoolFacts {
  venue: Venue;
  token0: Address;
  token1: Address;
  symbols?: [string, string];
  /** fee in pips (v4 0x800000 = dynamic fee) */
  fee: number;
  tickSpacing: number;
  /** v4: the pool key's hook (zero address = none) */
  hooks?: Address;
  poolId?: Hex;
  /** v3 pool address */
  pool?: Address;
  /** compound price source: Chainlink for both tokens, or a deep anchor pool; selfAnchor = this v3 pool is the anchor */
  compoundAnchor?: Maybe<{ chainlinkBoth: boolean; anchorPool: boolean; selfAnchor?: boolean }>;
  /** v4 registry entry of the pair (listed = the pair and this pool are listed; pairListed = the pair alone) */
  v4Entry?: Maybe<{ listed: boolean; srcKind: number; gate: number; swapsOpen: boolean; budgeted: boolean; pairListed?: boolean }>;
  /** v4 registry hook entry of this pool (null = none) */
  hookEntry?: Maybe<{ kind: number; maxSlippageBps: number; exitOnly: boolean; taxBps: number; feeCapPips: number } | null>;
  /** keccak256 of the hook's code (null = no code) */
  hookCodeHash?: Maybe<Hex | null>;
  /** GoatAutoCompoundV4's reviewed code hash for the hook (null = not on its list) */
  gac4HookPin?: Maybe<Hex | null>;
  /** v3 pair table coverage of the pair and fee tier */
  v3Coverage?: Maybe<{ pairListed: boolean; feeCovered: boolean; swapsOpen: boolean; gate: number; baseGate?: number; nc?: boolean; ncGate?: number; ncBaseGate?: number }>;
  /** the registry refuses this pool (red list) */
  redListed?: Maybe<boolean>;
  /** a token keeps a cut on transfer */
  transferTax?: Maybe<boolean>;
  /** the pair's swap caps per input token (raw units) */
  swapCaps?: Maybe<{ cap0: bigint; cap1: bigint }>;
  /** the keeper's drift key of a pair priced without Chainlink */
  ncKey?: string;
}

export interface PositionFacts {
  id: bigint;
  venue: Venue;
  owner: Maybe<Address>;
  /** ownerOf reverted with "not minted": the NFT was burned */
  burned?: boolean;
  liquidity: Maybe<bigint>;
  tickLower: number;
  tickUpper: number;
  tickSpacing: number;
  /** v4: the position has a subscriber */
  subscriber?: Maybe<boolean>;
  /** getApproved(id); null = none */
  approved?: Maybe<Address | null>;
  rules?: Partial<Record<Kind, Maybe<RuleRead | null>>>;
  /** v4 Steward previewTrigger(id) */
  preview?: Maybe<{ ready: boolean; upperSide: boolean; reason: Hex }>;
  /** v3 positions(): the pool tokens and fee; v4: the pool key */
  token0?: Address;
  token1?: Address;
  fee?: number;
  hooks?: Address;
}

export interface ContractFacts {
  paused?: Partial<Record<ContractKey, Maybe<boolean>>>;
  /** Steward paused-modes bitmask (1 auto-range, 2 auto-exit, 4 swaps) */
  stewardPausedModes?: Maybe<number>;
  stewardRetired?: Maybe<boolean>;
  /** live fees in bps */
  feesBps?: Partial<Record<Kind, Partial<Record<Venue, number>>>>;
  /** raw live v3 fees (the v3 rules carry them byte for byte) */
  feesX64?: { rangeFeeX64?: bigint; exitFeeX64?: bigint };
  /** the fee recipient equals the treasury, per contract */
  treasuryOk?: Partial<Record<ContractKey, Maybe<boolean>>>;
  /** spenders: GoatAutoCompoundV3, AutoRange, AutoExit, GoatAutoCompoundV4 and the Steward's ENGINE() */
  spenders?: Partial<Record<ContractKey, Address>>;
}

// ------------------------------------------------------------------ eligibility

export type Level = 'block' | 'limit' | 'info';
export type EligCode =
  | 'NOT_LIVE' | 'NOT_OWNER' | 'EMPTY' | 'SUBSCRIBER' | 'ONE_AT_A_TIME' | 'FULL_RANGE' | 'TOO_NARROW'
  | 'NO_PRICE_REFERENCE' | 'SWAPS_CLOSED' | 'UNREVIEWED_HOOK' | 'HOOK_RETURN_DELTA' | 'HOOK_NO_NEW_DEPOSITS' | 'RED_LISTED'
  | 'TRANSFER_TAX_TOKEN' | 'TAXED_POOL' | 'DYNAMIC_FEE_NO_HOOK' | 'UNLISTED_POOL' | 'REVIEWED_HOOK' | 'SMALL_POSITION'
  | 'PAUSED' | 'RETIRED' | 'UNKNOWN' | 'SELF_ANCHOR' | 'HOOK_CUT' | 'HOOK_CLAIM_ONLY' | 'HOOK_SLIP_HINT' | 'USABLE_SIZE'
  | 'NO_PRICE_CHECK';
export interface Line { code: EligCode; level: Level; text: string; why?: string }
export interface KindLimits {
  exitWithdrawOnly?: boolean;
  minWidthTicks?: number;
  gateTicks?: number;
  maxSlippageBps?: number;
  maxSwapFeeEditable?: boolean;
  poolFeePips?: number;
  /** v4 auto-compound: the pool's hook only allows sending fees to the wallet */
  claimOnly?: boolean;
  swapCaps?: { cap0: bigint; cap1: bigint };
}
export interface KindVerdict { live: boolean; offered: boolean; lines: Line[]; limits: KindLimits }
export interface PoolVerdict { venue: Venue; kinds: Record<Kind, KindVerdict> }

// ------------------------------------------------------------------ calls

export type AutoCallKind = 'approve' | 'remove-permission' | 'config' | 'disable' | 'clear' | 'revoke-multicall';
/** One transaction. `data` is the exact encoded bytes the decode check sees. */
export interface AutoCall {
  kind: AutoCallKind;
  label: string;
  to: Address;
  abi: Abi | readonly unknown[];
  functionName: string;
  args: readonly unknown[];
  data: Hex;
  /** always 0 for automation */
  value: bigint;
  contract: ContractKey | 'npm' | 'posm';
  tokenId: bigint;
}
export type BuildResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/** One step of an automation plan: a transaction, or a batch of signed messages (v4 auto-compound) */
export interface AutoStep {
  key: 'allow' | 'sign' | 'turn-on' | 'save' | 'stop' | 'revoke';
  label: string;
  calls: AutoCall[];
  sign?: { count: number; deadline: bigint };
}

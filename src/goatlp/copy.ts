// Plain-English messages of the Goat LP tools: why an automation is not offered, why a value is refused, and what a
// contract error means. One idea per line, no promise of returns.
import type { Kind, Venue } from './types';

export const KIND_NAME: Readonly<Record<Kind, string>> = { compound: 'Auto-compound', range: 'Auto-range', exit: 'Auto-exit' };
export const VENUE_NAME: Readonly<Record<Venue, string>> = { v3: 'Uniswap v3', v4: 'Uniswap v4' };

export const PAUSED_LINE = 'Paused right now. The keeper tries again later.';
export const PAUSED_ALL_LINE = 'Paused for everyone right now. Your position is not affected; withdraw and collect still work. The keeper tries again later.';

/** Why an automation is not offered (or offered with a limit) for a pool or position */
export const ELIG = {
  NOT_LIVE: 'This automation cannot be used right now: its contract does not match the build pinned in this package.',
  POLICY_UNREAD: "couldn't read the automation policy from api.cashmere.exchange (/v2/automation/policy); try again in a moment.",
  THIN_POOL: 'Auto-compound is not offered for this pair here: its pools on this venue are too small.',
  SIZE_LIMITED: "Larger automatic moves wait until this pair's price check is deeper. Smaller ones still run. The exit without a swap is not affected.",
  SIZE_WAITING_RANGE: "Auto-range isn't offered on this pair right now. Exits without a swap work.",
  SIZE_WAITING_EXIT: 'Swap exits on this pair are paused right now. Withdraw only would act right away.',
  NOT_OWNER: 'The configured wallet does not own this position.',
  EMPTY: 'This position is empty.',
  SUBSCRIBER: 'This position is linked to another app (a subscriber). Unlink it first.',
  FULL_RANGE: 'A full-range position never leaves its range, so there is nothing to trigger.',
  TOO_NARROW_V4: (minPct: string) => `This range is too narrow for auto-range. It needs at least ${minPct} between min and max.`,
  TOO_NARROW_V3: (minPct: string) => `Pick a new width of at least ${minPct}.`,
  NO_PRICE_REFERENCE: 'This pair has no reliable price reference, so automation is not offered.',
  SWAPS_CLOSED: 'Swaps for this pair are closed right now, so auto-range and swap exits are not offered.',
  SWAPS_CLOSED_EXIT: 'Swaps for this pair are closed right now. Auto-exit (withdraw only) is available.',
  UNREVIEWED_HOOK_BLOCK: 'Hook not reviewed. Automation runs only on pools without a hook or with a reviewed hook.',
  HOOK_RETURN_DELTA: "This pool's hook can change what a withdrawal returns, so automation is not offered.",
  HOOK_RETURN_DELTA_COMPOUND: "This pool's hook takes part of every deposit, so fees can't be added back here.",
  HOOK_NO_NEW_DEPOSITS: "Automation can't open new positions in this pool, so auto-range is not offered. Auto-exit is available.",
  RED_LISTED: 'Automation is not offered for this pool.',
  TRANSFER_TAX_TOKEN: "One of these tokens keeps a cut when it moves, so auto-range and swap exits can't run here. Withdraw-only exits are available.",
  TRANSFER_TAX_TOKEN_BLOCK: "One of these tokens keeps a cut when it moves, so automation can't run here.",
  TAXED_POOL: (pct: string) => `This pool charges a fixed swap tax of ${pct}. Automation includes it in its price checks.`,
  DYNAMIC_FEE_NO_HOOK: 'Automation is not offered for this pool type.',
  UNLISTED_POOL: 'Only withdraw-only exits are available in this pool.',
  UNLISTED_POOL_BLOCK: 'Automation is not offered for this pool.',
  REVIEWED_HOOK: (feePct: string, slipPct: string) => `Reviewed hook: its fee is capped at ${feePct} and checked on every run; price protection here is at most ${slipPct}.`,
  SMALL_RANGE: (usd: string, exitWorks: boolean) => `Positions under about ${usd} are too small for the keeper to move.${exitWorks ? ' Auto-exit still works.' : ''}`,
  SMALL_WAIT: 'Too small for the keeper to move at this size. The rule stays on.',
  SMALL_COMPOUND: 'Small position: runs wait until enough fees build up, so they can be far apart.',
  SELF_ANCHOR: "In this pool the price check uses the pool's own 30-minute average.",
  HOOK_CUT: (pct: string) => `This pool's hook keeps up to ${pct} of the requested swap; the total cost is still capped by the price protection.`,
  HOOK_CLAIM_ONLY: "Send fees to the wallet only: swaps in this pool need signed quotes, so fees can't be added back here.",
  HOOK_NO_LP_FEE: 'LPs get no swap fee in this pool, so there is nothing to compound.',
  HOOK_SLIP: (pct: string) => `This pool's hook charges its own swap fee. Set price protection to at least ${pct}.`,
  HOOK_SLIP_GENERIC: "This pool's hook charges its own swap fee. Set price protection at least 0.5% above it.",
  USABLE_RANGE: (usd: string | null) => `This position is larger than auto-range can move on this pair${usd ? ` (about ${usd} per side)` : ''}, so auto-range is not offered for it. Auto-exit still works.`,
  USABLE_EXIT: (usd: string | null) => `A swap exit this large is above this pair's limit${usd ? ` (about ${usd})` : ''}. Withdraw only would act right away.`,
  PAUSED: PAUSED_ALL_LINE,
  RETIRED: 'This automation version is closed to new runs.',
  UNKNOWN: "Couldn't check this on chain. Try again.",
  NO_PRICE_CHECK: "Auto-range and swap exits aren't offered on this pair yet. Exits without a swap work.",
  WALLET_CANNOT_SIGN: "The configured wallet can't sign the messages auto-compound uses on Uniswap v4, so this tool cannot turn it on.",
} as const;

/** The reason a second automation is refused on a position (one rule per position) */
export function oneAtATimeText(active: Kind, kind: Kind, venue: Venue): string {
  if (active === 'range') {
    if (kind === 'compound') return 'Auto-range already puts the fees back into the position at each move, so auto-compound is part of it.';
    return venue === 'v4' ? 'A v4 position holds one rule: auto-range or auto-exit.' : 'Each auto-range move gives the position a new ID. An auto-exit would stay on the old ID and stop working.';
  }
  if (active === 'exit') {
    if (kind === 'range') return venue === 'v4' ? 'A v4 position holds one rule: auto-range or auto-exit.' : 'Each auto-range move gives the position a new ID. The auto-exit would stay on the old ID and stop working.';
    return venue === 'v3' ? "Both use this position's own permission, and a v3 position has one." : 'This position already runs an auto-exit. Stop it first with goatlp_stop_automation.';
  }
  return venue === 'v3' ? "Both use this position's own permission, and a v3 position has one. Stop auto-compound first with goatlp_stop_automation."
    : 'This position already runs auto-compound. Stop it first with goatlp_stop_automation.';
}

/** Value checks of the rule settings (the contracts' own bounds) */
export const INVALID = {
  compoundSlipV4: 'Price protection must be between 0.01% and 20% (1 to 2000 bps).',
  compoundSlipV3: 'Price protection must be between 0.01% and 5% (1 to 500 bps).',
  interval: 'Choose at least 1 hour between compounds.',
  rangeInterval: 'Choose between 1 hour and 30 days between moves.',
  rangeSlip: (maxPct: string) => `Price protection must be between 0.10% and ${maxPct}.`,
  trigger: (minPct: string) => `Set the trigger at least ${minPct} past the range.`,
  triggerMax: 'Set the trigger at most about 2x past the range (20,000 ticks).',
  swapFee: (poolPct: string) => `The max swap fee must be between the pool fee (${poolPct}) and 10%.`,
  width: (minPct: string) => `The new range must be at least ${minPct} wide.`,
  widthStep: "The new width must line up with the pool's tick spacing.",
  exitNoSide: 'Turn on at least one exit side (lower or upper).',
  exitLower: (pct: string) => `Set the lower exit at least ${pct} below the range.`,
  exitUpper: (pct: string) => `Set the upper exit at least ${pct} above the range.`,
  exitSwapNeedsSide: 'A swap on one side needs that side turned on.',
  exitSwapNotOffered: 'Swapping is not offered for this pair. Choose withdraw only.',
  runs: 'Choose between 1 and 30 signed messages.',
  horizon: 'The signed messages may last at most 90 days.',
} as const;

/** Step labels of a plan */
export const STEP = {
  allow: 'Allow this position',
  sign: (n: number) => `Sign ${n} runs (free, no gas)`,
  turnOn: 'Turn on',
  save: 'Save changes',
  post: 'Hand the signed messages to the keeper',
} as const;

/** Contract custom errors mapped to plain text */
export const ERROR_TEXT: Readonly<Record<string, string>> = {
  NotPositionOwner: ELIG.NOT_OWNER, NotTokenOwner: ELIG.NOT_OWNER, NotConfigOwnerOrTokenOwner: ELIG.NOT_OWNER, Unauthorized: ELIG.NOT_OWNER,
  HasSubscriber: ELIG.SUBSCRIBER,
  ForeignApproval: "Another app is allowed to manage this position, so auto-compound can't run.",
  NoLiquidity: ELIG.EMPTY, EmptyPosition: ELIG.EMPTY,
  SlippageTooHigh: INVALID.compoundSlipV4, SlippageZero: INVALID.compoundSlipV4,
  IntervalTooShort: INVALID.interval,
  Paused: PAUSED_ALL_LINE, ModePaused: PAUSED_ALL_LINE,
  IsRetired: ELIG.RETIRED,
  BadConfig: 'One of the settings is outside what this pool allows.',
  InvalidConfig: 'One of the settings is outside what this pool allows.',
  PoolNotAllowed: ELIG.UNLISTED_POOL_BLOCK, ExitOnlyPair: ELIG.NO_PRICE_REFERENCE, SwapsOff: ELIG.SWAPS_CLOSED,
  InvalidPool: ELIG.NO_PRICE_REFERENCE, NotSupportedFeeTier: ELIG.NO_PRICE_REFERENCE,
  TooSoon: 'Too soon since the last run.',
  PairChanged: "This pair's automation settings changed. Save the rule again.",
  BudgetExhausted: 'The rule used all its moves. Save it again to renew it.',
  HookNotReviewed: ELIG.UNREVIEWED_HOOK_BLOCK, HookNotListable: ELIG.UNREVIEWED_HOOK_BLOCK,
  NothingToCompound: 'There are no fees to add back right now.',
};

export const WRONG_OWNER_NOW = 'The configured wallet does not own this position on chain.';
export const TX_FAILED = 'The transaction failed on chain. Nothing changed by it.';
export const VERIFY_FAILED = 'The transaction went through, but the chain does not show the expected result yet. Check the position again in a moment.';
export const LIMITS_UNREAD = "Couldn't read this pair's limits on chain. Nothing was planned.";

/** bps -> "0.15%" / "10%" */
export function pctOfBps(bps: number): string {
  const v = bps / 100;
  return `${Number.isInteger(v) ? v.toFixed(0) : v.toFixed(2)}%`;
}
/** ticks -> the price distance they mean ("1.01%") */
export function pctOfTicks(ticks: number): string {
  return `${((Math.pow(1.0001, ticks) - 1) * 100).toFixed(2)}%`;
}
/** pips (1e-6) -> "0.30%" */
export function pctOfPips(pips: number): string {
  return `${(pips / 10_000).toFixed(2)}%`;
}

// Transaction builders of the automation tools. Each returns an AutoCall (exact encoded bytes, value 0) or the list of
// problems with the inputs; nothing is ever clamped. The decode check (./guard.ts) re-checks the final bytes.
//  - Permissions: only approve(spender, tokenId) on the venue's position manager, for one position. Never a permission
//    for all positions, never permitForAll.
//  - Turn on: [allow (skipped when already allowed to the right spender), turn on]; v4 auto-compound: [sign N, turn on].
//  - Stop: v3 = [rule off, approve(0) if this automation holds the permission];
//          v4 auto-range / auto-exit = [clearConfig, multicall(approve(0)) if the engine holds the permission];
//          v4 auto-compound = [rule off, multicall(revokeNonce for every signed and unused message, approve(0) if held)].
//    Only a permission held by this automation's own spender is removed; another app's approval is left alone.
import { encodeFunctionData, type Abi, type Address, type Hex } from 'viem';
import { NPM, POSM, RUN_DEADLINE_SEC, ST_FLAG, STEWARD_BUDGET, ZERO_ADDRESS } from './constants';
import { autoExitAbi, autoRangeAbi, gac3Abi, gac4Abi, npmAbi, posmAbi, stewardAbi } from './abis';
import { STEP } from './copy';
import type {
  AutoCall, AutoCallKind, AutoStep, BuildResult, CompoundV3Draft, CompoundV4Draft, ContractKey, ExitV3Draft, ExitV4Draft, Kind,
  RangeV3Draft, RangeV4Draft, Venue,
} from './types';
import {
  V3_EXIT_OFF_HIGH, V3_EXIT_OFF_LOW, bpsToX64, validateAe, validateAr, validateExitV4, validateGac3, validateGac4, validateRangeV4,
  type AeCfgIn, type ArCfgIn, type ExitParamsIn, type Gac3CfgIn, type Gac4CfgIn, type PoolCtx, type RangeParamsIn,
} from './validate';

export const ok = <T>(value: T): BuildResult<T> => ({ ok: true, value });
export const fail = <T>(errors: string[]): BuildResult<T> => ({ ok: false, errors });
export const eqAddr = (a: string | null | undefined, b: string | null | undefined): boolean => !!a && !!b && a.toLowerCase() === b.toLowerCase();
export const isZeroAddr = (a: string | null | undefined): boolean => !a || /^0x0{40}$/i.test(a);

export function mkCall(x: {
  kind: AutoCallKind; label: string; to: Address; abi: Abi | readonly unknown[]; functionName: string; args: readonly unknown[];
  contract: ContractKey | 'npm' | 'posm'; tokenId: bigint;
}): AutoCall {
  const data = encodeFunctionData({ abi: x.abi as Abi, functionName: x.functionName, args: x.args as unknown[] });
  return { ...x, data, value: 0n };
}

/** Which contract runs (kind, venue). v4 auto-range and auto-exit share the Steward. */
export function contractFor(kind: Kind, venue: Venue): ContractKey {
  if (kind === 'compound') return venue === 'v4' ? 'autoCompoundV4' : 'autoCompoundV3';
  if (venue === 'v4') return 'rangeExitV4';
  return kind === 'range' ? 'rangeExitV3' : 'exitV3';
}

// ------------------------------------------------------------------ permissions

/** The spenders of the automation contracts: GoatAutoCompoundV3, AutoRange, AutoExit and the Steward's ENGINE(). */
export type Spenders = Partial<Record<ContractKey, Address>>;

/** The address a position is allowed to for (kind, venue). v4 auto-compound runs on signed messages: no permission. */
export function spenderFor(kind: Kind, venue: Venue, spenders: Spenders): Address | null {
  if (kind === 'compound' && venue === 'v4') return null;
  return spenders[contractFor(kind, venue)] ?? null;
}

/** Is `a` one of the Goat LP spenders? */
export function isGoatSpender(a: Address | null | undefined, spenders: Spenders): ContractKey | null {
  if (!a || isZeroAddr(a)) return null;
  for (const [k, v] of Object.entries(spenders) as [ContractKey, Address][]) if (eqAddr(a, v)) return k;
  return null;
}

const nft = (venue: Venue) => (venue === 'v4'
  ? { to: POSM, abi: posmAbi, contract: 'posm' as const }
  : { to: NPM, abi: npmAbi, contract: 'npm' as const });

/** "Allow this position": approve(spender, id) to the Goat spender of (kind, venue). */
export function allowPosition(x: { kind: Kind; venue: Venue; tokenId: bigint; spenders: Spenders }): BuildResult<AutoCall> {
  const spender = spenderFor(x.kind, x.venue, x.spenders);
  if (!spender) return fail(['No Goat LP spender for this automation (v4 auto-compound uses signed messages, not a permission).']);
  const n = nft(x.venue);
  return ok(mkCall({ kind: 'approve', label: STEP.allow, to: n.to, abi: n.abi, functionName: 'approve', args: [spender, x.tokenId], contract: n.contract, tokenId: x.tokenId }));
}

// ------------------------------------------------------------------ auto-compound

export function gac3Cfg(d: CompoundV3Draft): Gac3CfgIn {
  return { enabled: true, swapEnabled: d.swapEnabled, maxSlippageBps: d.maxSlippageBps, minInterval: d.minInterval, lastRunAt: 0, minReward0: 0n, minReward1: 0n };
}
export const GAC3_OFF: Gac3CfgIn = Object.freeze({ enabled: false, swapEnabled: false, maxSlippageBps: 0, minInterval: 0, lastRunAt: 0, minReward0: 0n, minReward1: 0n });

export function gac4Cfg(d: CompoundV4Draft): Gac4CfgIn {
  return { enabled: true, claimOnly: d.mode === 'claim', allowStandingApproval: false, maxSlippageBps: d.maxSlippageBps, minInterval: d.minInterval, lastRunAt: 0, minLiquidityDelta: 0n };
}
export const GAC4_OFF: Gac4CfgIn = Object.freeze({ enabled: false, claimOnly: false, allowStandingApproval: false, maxSlippageBps: 0, minInterval: 0, lastRunAt: 0, minLiquidityDelta: 0n });

const cfgNum = <T extends { lastRunAt: number | bigint }>(c: T) => ({ ...c, lastRunAt: Number(c.lastRunAt) });

export function v3CompoundEnable(x: { tokenId: bigint; draft: CompoundV3Draft; gac3: Address; change?: boolean }): BuildResult<AutoCall> {
  const c = gac3Cfg(x.draft);
  const e = validateGac3(c);
  if (e.length) return fail(e);
  return ok(mkCall({ kind: 'config', label: x.change ? STEP.save : STEP.turnOn, to: x.gac3, abi: gac3Abi, functionName: 'configToken', args: [x.tokenId, cfgNum(c)], contract: 'autoCompoundV3', tokenId: x.tokenId }));
}
export function v3CompoundDisable(x: { tokenId: bigint; gac3: Address }): AutoCall {
  return mkCall({ kind: 'disable', label: 'Turn off auto-compound', to: x.gac3, abi: gac3Abi, functionName: 'configToken', args: [x.tokenId, cfgNum(GAC3_OFF)], contract: 'autoCompoundV3', tokenId: x.tokenId });
}

export function v4CompoundEnable(x: { tokenId: bigint; draft: CompoundV4Draft; gac4: Address; change?: boolean }): BuildResult<AutoCall> {
  const c = gac4Cfg(x.draft);
  const e = validateGac4(c);
  if (e.length) return fail(e);
  return ok(mkCall({ kind: 'config', label: x.change ? STEP.save : STEP.turnOn, to: x.gac4, abi: gac4Abi, functionName: 'configToken', args: [x.tokenId, cfgNum(c)], contract: 'autoCompoundV4', tokenId: x.tokenId }));
}
export function v4CompoundDisable(x: { tokenId: bigint; gac4: Address }): AutoCall {
  return mkCall({ kind: 'disable', label: 'Turn off auto-compound', to: x.gac4, abi: gac4Abi, functionName: 'configToken', args: [x.tokenId, cfgNum(GAC4_OFF)], contract: 'autoCompoundV4', tokenId: x.tokenId });
}

// ------------------------------------------------------------------ v3 auto-range / auto-exit

/** The v3 auto-range rule: width W centred on the price, the same trigger on both sides, the live fee as the agreed fee. */
export function arCfg(d: RangeV3Draft, rangeFeeX64: bigint): ArCfgIn {
  const ld = -Math.floor(d.widthTicks / 2);
  const ud = ld + d.widthTicks;
  const s = bpsToX64(d.slippageBps);
  return {
    lowerTickLimit: d.triggerTicks, upperTickLimit: d.triggerTicks, lowerTickDelta: ld, upperTickDelta: ud,
    token0SlippageX64: s, token1SlippageX64: s, onlyFees: false, autoCompound: false, maxRewardX64: rangeFeeX64,
  };
}
export const AR_OFF: ArCfgIn = Object.freeze({
  lowerTickLimit: 0, upperTickLimit: 0, lowerTickDelta: 0, upperTickDelta: 0, token0SlippageX64: 0n, token1SlippageX64: 0n,
  onlyFees: false, autoCompound: false, maxRewardX64: 0n,
});

/** A width rounded up to the pool's tick spacing, so a preset never lands under the minimum. */
export function alignWidth(widthTicks: number, tickSpacing: number): number {
  const ts = tickSpacing > 0 ? tickSpacing : 1;
  return Math.ceil(widthTicks / ts) * ts;
}

export function v3RangeEnable(x: { tokenId: bigint; draft: RangeV3Draft; autoRange: Address; gate: number; tickSpacing: number; rangeFeeX64: bigint; change?: boolean }): BuildResult<AutoCall> {
  const c = arCfg(x.draft, x.rangeFeeX64);
  const e = validateAr(c, { gate: x.gate, tickSpacing: x.tickSpacing, rangeFeeX64: x.rangeFeeX64 });
  if (e.length) return fail(e);
  return ok(mkCall({ kind: 'config', label: x.change ? STEP.save : STEP.turnOn, to: x.autoRange, abi: autoRangeAbi, functionName: 'configToken', args: [x.tokenId, ZERO_ADDRESS, c], contract: 'rangeExitV3', tokenId: x.tokenId }));
}
export function v3RangeDisable(x: { tokenId: bigint; autoRange: Address }): AutoCall {
  return mkCall({ kind: 'disable', label: 'Turn off auto-range', to: x.autoRange, abi: autoRangeAbi, functionName: 'configToken', args: [x.tokenId, ZERO_ADDRESS, AR_OFF], contract: 'rangeExitV3', tokenId: x.tokenId });
}

export function aeCfg(d: ExitV3Draft, exitFeeX64: bigint): AeCfgIn {
  const s = bpsToX64(d.slippageBps);
  return {
    isActive: true, token0Swap: d.lower.on && d.lower.swap, token1Swap: d.upper.on && d.upper.swap,
    token0TriggerTick: d.lower.on ? d.lower.tick : V3_EXIT_OFF_LOW, token1TriggerTick: d.upper.on ? d.upper.tick : V3_EXIT_OFF_HIGH,
    token0SlippageX64: s, token1SlippageX64: s, onlyFees: false, maxRewardX64: exitFeeX64,
  };
}
export const AE_OFF: AeCfgIn = Object.freeze({
  isActive: false, token0Swap: false, token1Swap: false, token0TriggerTick: V3_EXIT_OFF_LOW, token1TriggerTick: V3_EXIT_OFF_HIGH,
  token0SlippageX64: 0n, token1SlippageX64: 0n, onlyFees: false, maxRewardX64: 0n,
});

export function v3ExitEnable(x: { tokenId: bigint; draft: ExitV3Draft; autoExit: Address; gate: number; tickLower: number; tickUpper: number; swapAllowed: boolean; exitFeeX64: bigint; change?: boolean }): BuildResult<AutoCall> {
  const c = aeCfg(x.draft, x.exitFeeX64);
  const e = validateAe(c, { gate: x.gate, tickLower: x.tickLower, tickUpper: x.tickUpper, swapAllowed: x.swapAllowed, exitFeeX64: x.exitFeeX64 });
  if (e.length) return fail(e);
  return ok(mkCall({ kind: 'config', label: x.change ? STEP.save : STEP.turnOn, to: x.autoExit, abi: autoExitAbi, functionName: 'configToken', args: [x.tokenId, c], contract: 'exitV3', tokenId: x.tokenId }));
}
export function v3ExitDisable(x: { tokenId: bigint; autoExit: Address }): AutoCall {
  return mkCall({ kind: 'disable', label: 'Turn off auto-exit', to: x.autoExit, abi: autoExitAbi, functionName: 'configToken', args: [x.tokenId, AE_OFF], contract: 'exitV3', tokenId: x.tokenId });
}

// ------------------------------------------------------------------ v4 Steward

/** The v4 auto-range rule: 20 moves, this position only. */
export function rangeParams(d: RangeV4Draft): RangeParamsIn {
  return { triggerTicks: d.triggerTicks, slippageBps: d.slippageBps, minInterval: d.minInterval, budget: STEWARD_BUDGET, standing: false, maxSwapFeePips: d.maxSwapFeePips };
}

export function exitParams(d: ExitV4Draft): ExitParamsIn {
  const F = ST_FLAG;
  let flags = 0;
  if (d.lower.on) flags |= F.LOWER_ON;
  if (d.upper.on) flags |= F.UPPER_ON;
  if (d.lower.on && d.lower.swap) flags |= F.SWAP_ON_LOWER;
  if (d.upper.on && d.upper.swap) flags |= F.SWAP_ON_UPPER;
  const swap = (flags & (F.SWAP_ON_LOWER | F.SWAP_ON_UPPER)) !== 0;
  return {
    flags, lowerTrigger: d.lower.on ? d.lower.tick : 0, upperTrigger: d.upper.on ? d.upper.tick : 0,
    slippageBps: d.slippageBps, maxSwapFeePips: swap ? d.maxSwapFeePips : 0,
  };
}

export function setRange(x: { tokenId: bigint; draft: RangeV4Draft; steward: Address; pool: PoolCtx; widthTicks: number; change?: boolean }): BuildResult<AutoCall> {
  const p = rangeParams(x.draft);
  const e = validateRangeV4(p, { ...x.pool, widthTicks: x.widthTicks });
  if (e.length) return fail(e);
  return ok(mkCall({ kind: 'config', label: x.change ? STEP.save : STEP.turnOn, to: x.steward, abi: stewardAbi, functionName: 'setRangeConfig', args: [x.tokenId, p], contract: 'rangeExitV4', tokenId: x.tokenId }));
}

export function setExit(x: { tokenId: bigint; draft: ExitV4Draft; steward: Address; pool: PoolCtx; tickLower: number; tickUpper: number; swapAllowed: boolean; change?: boolean }): BuildResult<AutoCall> {
  const p = exitParams(x.draft);
  const e = validateExitV4(p, { ...x.pool, tickLower: x.tickLower, tickUpper: x.tickUpper, swapAllowed: x.swapAllowed });
  if (e.length) return fail(e);
  return ok(mkCall({ kind: 'config', label: x.change ? STEP.save : STEP.turnOn, to: x.steward, abi: stewardAbi, functionName: 'setExitConfig', args: [x.tokenId, p], contract: 'rangeExitV4', tokenId: x.tokenId }));
}

export function clearRule(x: { tokenId: bigint; steward: Address }): AutoCall {
  return mkCall({ kind: 'clear', label: 'Clear the rule', to: x.steward, abi: stewardAbi, functionName: 'clearConfig', args: [x.tokenId], contract: 'rangeExitV4', tokenId: x.tokenId });
}

/** The owner's own "move now" call (not offered by the tools; kept for the decode check's run rule). */
export function runNow(x: { tokenId: bigint; steward: Address; nowSec: number }): AutoCall {
  const deadline = BigInt(Math.floor(x.nowSec) + RUN_DEADLINE_SEC);
  return mkCall({ kind: 'config', label: 'Move now', to: x.steward, abi: stewardAbi, functionName: 'run', args: [x.tokenId, deadline], contract: 'rangeExitV4', tokenId: x.tokenId });
}

// ------------------------------------------------------------------ stop and turn-on step plans

export interface StopFacts {
  tokenId: bigint;
  targets: Partial<Record<ContractKey, Address>>;
  spenders: Spenders;
  /** getApproved(id) now */
  approved: Address | null;
  /** v4 auto-compound: every signed and unused nonce (permits.revokeSet) */
  revokeNonces?: readonly bigint[];
  /** skip the rule-off step when the rule is already off (only the permission is left) */
  ruleOn?: boolean;
}

/** The permission-removal step of a stop, or null when there is nothing to remove. */
export function revokeCall(kind: Kind, venue: Venue, f: StopFacts): AutoCall | null {
  const spender = kind === 'compound' && venue === 'v4' ? f.spenders.autoCompoundV4 ?? null : spenderFor(kind, venue, f.spenders);
  const approvedHere = !!spender && eqAddr(f.approved, spender);
  if (venue === 'v4') {
    const inner: Hex[] = [];
    const nonces = kind === 'compound' ? f.revokeNonces ?? [] : [];
    for (const nn of nonces) inner.push(encodeFunctionData({ abi: posmAbi, functionName: 'revokeNonce', args: [nn] }));
    if (approvedHere) inner.push(encodeFunctionData({ abi: posmAbi, functionName: 'approve', args: [ZERO_ADDRESS, f.tokenId] }));
    if (!inner.length) return null;
    const label = approvedHere && nonces.length ? 'Cancel the signed messages and remove the permission'
      : approvedHere ? 'Remove the permission' : 'Cancel the signed messages';
    return mkCall({ kind: 'revoke-multicall', label, to: POSM, abi: posmAbi, functionName: 'multicall', args: [inner], contract: 'posm', tokenId: f.tokenId });
  }
  if (!approvedHere) return null;
  return mkCall({ kind: 'remove-permission', label: 'Remove the permission', to: NPM, abi: npmAbi, functionName: 'approve', args: [ZERO_ADDRESS, f.tokenId], contract: 'npm', tokenId: f.tokenId });
}

/** The ordered stop calls of (kind, venue). */
export function stopPlan(kind: Kind, venue: Venue, f: StopFacts): BuildResult<AutoCall[]> {
  const out: AutoCall[] = [];
  const to = f.targets[contractFor(kind, venue)];
  if (f.ruleOn !== false) {
    if (!to) return fail(['The automation contract is not known.']);
    if (kind === 'compound') out.push(venue === 'v4' ? v4CompoundDisable({ tokenId: f.tokenId, gac4: to }) : v3CompoundDisable({ tokenId: f.tokenId, gac3: to }));
    else if (venue === 'v4') out.push(clearRule({ tokenId: f.tokenId, steward: to }));
    else out.push(kind === 'range' ? v3RangeDisable({ tokenId: f.tokenId, autoRange: to }) : v3ExitDisable({ tokenId: f.tokenId, autoExit: to }));
  }
  const r = revokeCall(kind, venue, f);
  if (r) out.push(r);
  return ok(out);
}

/**
 * The steps of a turn-on: [allow (skipped when the position is already allowed to the right spender), turn on]; v4
 * auto-compound: [sign N, turn on]; `change` = a saved rule is edited: [save] only.
 */
export function turnOnSteps(x: {
  kind: Kind; venue: Venue; tokenId: bigint; spenders: Spenders; approved: Address | null; turnOn: AutoCall; change?: boolean;
  sign?: { count: number; deadline: bigint };
}): BuildResult<AutoStep[]> {
  if (x.change) return ok([{ key: 'save', label: STEP.save, calls: [{ ...x.turnOn, label: STEP.save }] }]);
  const steps: AutoStep[] = [];
  if (x.kind === 'compound' && x.venue === 'v4') {
    if (!x.sign) return fail(['Auto-compound on v4 needs the number of runs and the end date of the signed messages.']);
    steps.push({ key: 'sign', label: STEP.sign(x.sign.count), calls: [], sign: x.sign });
  } else {
    const spender = spenderFor(x.kind, x.venue, x.spenders);
    if (!spender) return fail(['No Goat LP spender for this automation.']);
    if (!eqAddr(x.approved, spender)) {
      const a = allowPosition({ kind: x.kind, venue: x.venue, tokenId: x.tokenId, spenders: x.spenders });
      if (!a.ok) return a;
      steps.push({ key: 'allow', label: a.value.label, calls: [a.value] });
    }
  }
  steps.push({ key: 'turn-on', label: STEP.turnOn, calls: [x.turnOn] });
  return ok(steps);
}

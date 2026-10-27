// The decode check of the automation tools. Every transaction and every message is checked on its final bytes right before
// it is signed; a refusal names its rule:
//  helper-contract  `to` is never one of Revert Finance's helper contracts, and no decoded address argument names one.
//  chain            chain 4663 (the RPC's chain and the request's).
//  target           `to` is a pinned Goat LP automation contract or a Uniswap position manager of the right venue.
//  pinned-code      nothing is sent to an automation whose contracts do not match their pinned code hashes.
//  function         an allowlist of functions per target: setApprovalForAll, permitForAll, transfers and keeper-only entry
//                   points are refused.
//  position         the tokenId argument is the planned position, ownerOf(id), read right before, is the signer, and the
//                   call is for the automation that was planned.
//  permission       approve(spender, id): spender 0x0 or the Goat LP spender of (kind, venue); approve(0) only over a Goat LP
//                   permission, never over another app's approval.
//  multicall        position-manager multicall: only revokeNonce(n) of this position's own signed messages (inside its nonce
//                   window) and approve(0, id); nothing else.
//  rule-values      the decoded rule passes the builders' validators again.
//  rule-limits      no permission for all positions, at most 20 moves, no fee-only modes, an agreed fee no higher than the
//                   live fee.
//  fee-recipient    the fee recipient of the fee-taking contract is the Goat LP treasury before a rule is turned on or allowed.
//  one-automation   one automation per position: turning on kind K is refused while another kind is on, or while a rule slot
//                   could not be read.
//  run-deadline     run(id, deadline): 0 < deadline - now <= 300 s and a successful simulation within the last 30 s.
//  no-value         automation calls carry no ETH.
//  signed-message   a signed message is only the Permit of the v4 position NFT on 4663 (domain equal to the on-chain
//                   separator), for spender GoatAutoCompoundV4, this position, a nonce of this signing session and a deadline
//                   at most 90 days away.
import { decodeFunctionData, domainSeparator, type Abi, type Address, type Hex, type TypedDataDomain } from 'viem';
import {
  CONTRACT_ABI, CONTRACT_REFUSED_ABI, PERMIT_TYPES, POSM_DOMAIN_NAME, nftRefusedAbi, npmAbi, posmAbi,
} from './abis';
import {
  GOAT_CHAIN_ID, HORIZON_MAX_SEC, MAX_RUNS_PER_SESSION, NPM, POSM, RUN_DEADLINE_SEC, SESSION_WORDS_MAX, ST_FLAG, STEWARD_BUDGET,
  V3UTILS, V4UTILS,
} from './constants';
import { AE_OFF, AR_OFF, GAC3_OFF, GAC4_OFF, contractFor, isGoatSpender, spenderFor, type Spenders } from './calldata';
import { permitWord } from './permits';
import type { ContractGates, ContractKey, Kind, Venue } from './types';
import {
  validateAe, validateAr, validateExitV4, validateGac3, validateGac4, validateRangeV4, type AeCfgIn, type ArCfgIn, type ExitParamsIn,
  type Gac3CfgIn, type Gac4CfgIn, type PoolCtx, type RangeParamsIn,
} from './validate';

export type Check = { ok: true } | { ok: false; rule: string; reason: string };
const OK: Check = { ok: true };
const no = (rule: string, reason: string): Check => ({ ok: false, rule, reason });
const eq = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const isZero = (a: string | null | undefined) => !!a && /^0x0{40}$/i.test(a);
const REFUSED_HELPERS: readonly Address[] = [V3UTILS, V4UTILS];

export type GuardIntent = 'turn-on' | 'change' | 'stop' | 'remove' | 'allow' | 'run';

export interface GuardCtx {
  /** the chain id the RPC reports */
  chainId: number | undefined;
  /** the signer */
  account: Address;
  /** the planned position */
  tokenId: bigint;
  /** ownerOf(id) read right before signing; undefined = not read, refused */
  ownerOnChain: Address | null | undefined;
  kind: Kind;
  venue: Venue;
  intent: GuardIntent;
  /** the code-hash check of each automation */
  gates: ContractGates;
  /** the pinned addresses of the automation contracts */
  targets: Partial<Record<ContractKey, Address>>;
  spenders: Spenders;
  /** getApproved(id) right now */
  currentApproved?: Address | null;
  /** pool facts for re-checking the rule */
  pool?: PoolCtx & { tickLower: number; tickUpper: number; swapAllowed: boolean };
  /** live v3 fees */
  liveFees?: { rangeFeeX64?: bigint; exitFeeX64?: bigint };
  /** fee recipient == treasury, per contract */
  treasuryOk?: Partial<Record<ContractKey, boolean>>;
  /** kinds with a rule on for this id; 'unknown' = a rule slot could not be read */
  activeKinds?: readonly Kind[] | 'unknown';
  /** revokeNonce values a stop may send */
  revokeAllowed?: readonly bigint[];
  nowSec: number;
  /** when the run simulation last succeeded */
  simulatedOkAtMs?: number;
  nowMs?: number;
}

export interface AutomationTx { to: Address; data: Hex; value?: bigint; chainId?: number }
export interface DecodedAutomationCall { contract: ContractKey | 'npm' | 'posm'; functionName: string; args: readonly unknown[] }
export type AutomationVerdict = { ok: true; call: DecodedAutomationCall } | { ok: false; rule: string; reason: string };

const ALLOWED: Readonly<Record<ContractKey | 'npm' | 'posm', readonly string[]>> = {
  autoCompoundV3: ['configToken'],
  autoCompoundV4: ['configToken'],
  rangeExitV4: ['setRangeConfig', 'setExitConfig', 'clearConfig', 'run'],
  rangeExitV3: ['configToken'],
  exitV3: ['configToken'],
  npm: ['approve'],
  posm: ['approve', 'multicall'],
};

function targetOf(to: Address, ctx: GuardCtx): ContractKey | 'npm' | 'posm' | null {
  if (eq(to, NPM)) return 'npm';
  if (eq(to, POSM)) return 'posm';
  for (const [k, a] of Object.entries(ctx.targets) as [ContractKey, Address][]) if (eq(a, to)) return k;
  return null;
}

function decode(contract: ContractKey | 'npm' | 'posm', data: Hex): { functionName: string; args: readonly unknown[]; refused: boolean } | null {
  const abis: Abi[] = contract === 'npm' ? [npmAbi as unknown as Abi, nftRefusedAbi as unknown as Abi]
    : contract === 'posm' ? [posmAbi as unknown as Abi, nftRefusedAbi as unknown as Abi]
      : [CONTRACT_ABI[contract], CONTRACT_REFUSED_ABI[contract], nftRefusedAbi as unknown as Abi];
  for (const [i, abi] of abis.entries()) {
    try {
      const d = decodeFunctionData({ abi, data });
      return { functionName: d.functionName, args: (d.args ?? []) as readonly unknown[], refused: i > 0 };
    } catch { /* next */ }
  }
  return null;
}

/** every address in the decoded arguments (deep) */
export function addressesIn(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)) out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => addressesIn(x, out));
  else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach((x) => addressesIn(x, out));
  return out;
}

const n = (x: unknown) => Number(x as number | bigint);

function tokenIdArg(fn: string, args: readonly unknown[]): bigint | null {
  if (fn === 'approve') return args[1] as bigint;
  if (['configToken', 'setRangeConfig', 'setExitConfig', 'clearConfig', 'run'].includes(fn)) return args[0] as bigint;
  return null;
}

function sameAs(a: object, b: object): boolean {
  return Object.keys(b).every((k) => String((a as Record<string, unknown>)[k]) === String((b as Record<string, unknown>)[k]));
}

/** rule-values and rule-limits on a decoded rule call */
function checkConfig(contract: ContractKey, fn: string, args: readonly unknown[], ctx: GuardCtx): Check {
  if (contract === 'autoCompoundV3') {
    const c = args[1] as Gac3CfgIn;
    if (!c.enabled) return sameAs(c, GAC3_OFF) ? OK : no('rule-values', 'an auto-compound rule that is off must be all zero');
    const e = validateGac3({ ...c, lastRunAt: n(c.lastRunAt) });
    return e.length ? no('rule-values', e[0]) : OK;
  }
  if (contract === 'autoCompoundV4') {
    const c = args[1] as Gac4CfgIn;
    if (!c.enabled) return sameAs(c, GAC4_OFF) ? OK : no('rule-values', 'an auto-compound rule that is off must be all zero');
    if (c.allowStandingApproval) return no('rule-limits', 'the per-run approval mode is never used');
    const e = validateGac4({ ...c, lastRunAt: n(c.lastRunAt) });
    return e.length ? no('rule-values', e[0]) : OK;
  }
  if (contract === 'rangeExitV4') {
    if (fn === 'clearConfig' || fn === 'run') return OK;
    if (fn === 'setRangeConfig') {
      const p = args[1] as RangeParamsIn;
      if (p.standing !== false) return no('rule-limits', 'the permission for all positions is never used');
      if (n(p.budget) > STEWARD_BUDGET) return no('rule-limits', 'more than 20 moves');
      if (!ctx.pool) return no('rule-values', 'the pool facts were not read');
      const e = validateRangeV4({ ...p, triggerTicks: n(p.triggerTicks), slippageBps: n(p.slippageBps), minInterval: n(p.minInterval), budget: n(p.budget), maxSwapFeePips: n(p.maxSwapFeePips) },
        { ...ctx.pool, widthTicks: ctx.pool.tickUpper - ctx.pool.tickLower });
      return e.length ? no('rule-values', e[0]) : OK;
    }
    if (fn === 'setExitConfig') {
      const p = args[1] as ExitParamsIn;
      if ((n(p.flags) & ST_FLAG.STANDING) !== 0) return no('rule-limits', 'the permission for all positions is never used');
      if (!ctx.pool) return no('rule-values', 'the pool facts were not read');
      const e = validateExitV4({ flags: n(p.flags), lowerTrigger: n(p.lowerTrigger), upperTrigger: n(p.upperTrigger), slippageBps: n(p.slippageBps), maxSwapFeePips: n(p.maxSwapFeePips) }, ctx.pool);
      return e.length ? no('rule-values', e[0]) : OK;
    }
  }
  if (contract === 'rangeExitV3') {
    if (!isZero(args[1] as string)) return no('rule-values', 'the vault argument must be zero');
    const c = args[2] as ArCfgIn;
    if (c.onlyFees || c.autoCompound) return no('rule-limits', 'the fee-only and combined compound modes must be off');
    if (ctx.liveFees?.rangeFeeX64 !== undefined && c.maxRewardX64 > ctx.liveFees.rangeFeeX64) return no('rule-limits', 'the agreed fee is above the live auto-range fee');
    if (c.lowerTickDelta === c.upperTickDelta) return sameAs(c, AR_OFF) ? OK : no('rule-values', 'turning off sends an all-zero rule');
    if (!ctx.pool || ctx.liveFees?.rangeFeeX64 === undefined) return no('rule-values', 'the pool facts or the live fee were not read');
    const e = validateAr({ ...c, lowerTickLimit: n(c.lowerTickLimit), upperTickLimit: n(c.upperTickLimit), lowerTickDelta: n(c.lowerTickDelta), upperTickDelta: n(c.upperTickDelta) },
      { gate: ctx.pool.gate, tickSpacing: ctx.pool.tickSpacing, rangeFeeX64: ctx.liveFees.rangeFeeX64 });
    return e.length ? no('rule-values', e[0]) : OK;
  }
  if (contract === 'exitV3') {
    const c = args[1] as AeCfgIn;
    if (c.onlyFees) return no('rule-limits', 'the fee-only mode must be off');
    if (ctx.liveFees?.exitFeeX64 !== undefined && c.maxRewardX64 > ctx.liveFees.exitFeeX64) return no('rule-limits', 'the agreed fee is above the live auto-exit fee');
    if (!c.isActive) return sameAs(c, AE_OFF) ? OK : no('rule-values', 'an exit rule that is off must have the off shape');
    if (!ctx.pool || ctx.liveFees?.exitFeeX64 === undefined) return no('rule-values', 'the pool facts or the live fee were not read');
    const e = validateAe({ ...c, token0TriggerTick: n(c.token0TriggerTick), token1TriggerTick: n(c.token1TriggerTick) },
      { gate: ctx.pool.gate, tickLower: ctx.pool.tickLower, tickUpper: ctx.pool.tickUpper, swapAllowed: ctx.pool.swapAllowed, exitFeeX64: ctx.liveFees.exitFeeX64 });
    return e.length ? no('rule-values', e[0]) : OK;
  }
  return no('function', `unexpected call ${fn}`);
}

/** Is this decoded call turning a rule on (rather than off, clearing it or running it)? */
function turnsOn(contract: ContractKey, fn: string, args: readonly unknown[]): boolean {
  if (contract === 'autoCompoundV3' || contract === 'autoCompoundV4') return !!(args[1] as { enabled: boolean }).enabled;
  if (contract === 'rangeExitV4') return fn === 'setRangeConfig' || fn === 'setExitConfig';
  if (contract === 'rangeExitV3') { const c = args[2] as ArCfgIn; return c.lowerTickDelta !== c.upperTickDelta; }
  if (contract === 'exitV3') return !!(args[1] as AeCfgIn).isActive;
  return false;
}
/** The kind a rule call is about (Steward: by function) */
function kindOfCall(contract: ContractKey, fn: string, fallback: Kind): Kind {
  if (contract === 'autoCompoundV3' || contract === 'autoCompoundV4') return 'compound';
  if (contract === 'rangeExitV3') return 'range';
  if (contract === 'exitV3') return 'exit';
  if (fn === 'setRangeConfig') return 'range';
  if (fn === 'setExitConfig') return 'exit';
  return fallback;
}

/** one-automation: why another kind blocks this one, or null */
function otherActive(ctx: GuardCtx, kind: Kind): string | null {
  if (ctx.activeKinds === 'unknown') return 'the other automation rules of this position could not be read';
  return (ctx.activeKinds ?? []).some((a) => a !== kind) ? 'another automation is on for this position' : null;
}

/** The decode check on one transaction's final bytes. */
export function assertAutomationTx(tx: AutomationTx, ctx: GuardCtx): AutomationVerdict {
  const fail = (rule: string, reason: string): AutomationVerdict => ({ ok: false, rule, reason });
  if (REFUSED_HELPERS.some((h) => eq(h, tx.to))) return fail('helper-contract', 'this contract is never used by the Goat LP tools');
  if ((tx.value ?? 0n) !== 0n) return fail('no-value', 'automation calls never send value');
  if (ctx.chainId !== GOAT_CHAIN_ID || (tx.chainId !== undefined && tx.chainId !== GOAT_CHAIN_ID)) return fail('chain', 'not on Robinhood Chain (4663)');
  const gateKey = contractFor(ctx.kind, ctx.venue);
  if (!ctx.gates[gateKey]?.ok) return fail('pinned-code', ctx.gates[gateKey]?.reason ?? 'the automation contract was not checked');
  const target = targetOf(tx.to, ctx);
  if (!target) return fail('target', 'not a Goat LP automation contract or a Uniswap position manager');
  if (target !== 'npm' && target !== 'posm' && !ctx.gates[target]?.ok) return fail('target', 'the contract code does not match the pinned build');
  const d = decode(target, tx.data);
  if (!d) return fail('function', 'the call could not be decoded');
  if (d.refused || !ALLOWED[target].includes(d.functionName)) return fail('function', `${d.functionName} is never sent by the Goat LP tools`);
  if (addressesIn(d.args).some((a) => REFUSED_HELPERS.some((h) => eq(h, a)))) return fail('helper-contract', 'an argument names a refused contract');
  if ((target === 'npm' && ctx.venue !== 'v3') || (target === 'posm' && ctx.venue !== 'v4')) return fail('target', 'wrong position manager for this venue');
  if (target !== 'npm' && target !== 'posm') {
    const expect: ContractKey[] = ctx.venue === 'v4' ? ['autoCompoundV4', 'rangeExitV4'] : ['autoCompoundV3', 'rangeExitV3', 'exitV3'];
    if (!expect.includes(target)) return fail('target', 'wrong contract for this venue');
  }
  if (d.functionName !== 'multicall') {
    const id = tokenIdArg(d.functionName, d.args);
    if (id === null || id !== ctx.tokenId) return fail('position', 'the call is for another position');
  }
  if (!ctx.ownerOnChain || !eq(ctx.ownerOnChain, ctx.account)) return fail('position', 'the signer does not own this position on chain');
  if (d.functionName === 'approve') {
    const spender = d.args[0] as Address;
    if (isZero(spender)) {
      if (!isGoatSpender(ctx.currentApproved ?? null, ctx.spenders)) return fail('permission', "only a Goat LP permission is removed; another app's approval is left alone");
    } else {
      const want = spenderFor(ctx.kind, ctx.venue, ctx.spenders);
      if (!want || !eq(want, spender)) return fail('permission', ctx.kind === 'compound' && ctx.venue === 'v4'
        ? 'auto-compound on v4 gives no permission' : 'the permission goes to the wrong contract');
      const c = contractFor(ctx.kind, ctx.venue);
      if (ctx.treasuryOk?.[c] !== true) return fail('fee-recipient', 'the fee recipient is not the Goat LP treasury');
      const other = otherActive(ctx, ctx.kind);
      if (other) return fail('one-automation', other);
    }
  }
  if (d.functionName === 'multicall') {
    const inner = d.args[0] as readonly Hex[];
    if (!inner.length) return fail('multicall', 'empty multicall');
    const allowed = new Set((ctx.revokeAllowed ?? []).map(String));
    // the nonce window of this position, from the check's own inputs (never from the list handed in)
    const spender = ctx.spenders.autoCompoundV4;
    const base = spender ? permitWord(spender, ctx.tokenId) : null;
    for (const data of inner) {
      let x: { functionName: string; args?: readonly unknown[] };
      try { x = decodeFunctionData({ abi: posmAbi as unknown as Abi, data }) as typeof x; } catch { return fail('multicall', 'unknown inner call'); }
      if (x.functionName === 'revokeNonce') {
        const nn = x.args?.[0];
        if (ctx.kind !== 'compound' || typeof nn !== 'bigint' || !allowed.has(String(nn))) return fail('multicall', "a cancelled nonce is not one of this position's signed messages");
        const word = nn >> 8n;
        const bit = Number(nn & 255n);
        if (base === null || word < base || word >= base + BigInt(SESSION_WORDS_MAX) || bit >= MAX_RUNS_PER_SESSION) {
          return fail('multicall', "a cancelled nonce is outside this position's signing window");
        }
      } else if (x.functionName === 'approve') {
        if (!isZero(x.args?.[0] as string) || (x.args?.[1] as bigint) !== ctx.tokenId) return fail('multicall', 'only approve(0, this position) may sit in the multicall');
        if (!isGoatSpender(ctx.currentApproved ?? null, ctx.spenders)) return fail('multicall', "only a Goat LP permission is removed; another app's approval is left alone");
      } else return fail('multicall', `${x.functionName} is not allowed in the multicall`);
    }
  }
  if (target !== 'npm' && target !== 'posm') {
    const cfg = checkConfig(target, d.functionName, d.args, ctx);
    if (!cfg.ok) return fail(cfg.rule, cfg.reason);
    if (turnsOn(target, d.functionName, d.args)) {
      if (ctx.treasuryOk?.[target] !== true) return fail('fee-recipient', 'the fee recipient is not the Goat LP treasury');
      const k = kindOfCall(target, d.functionName, ctx.kind);
      if (k !== ctx.kind) return fail('position', 'the call is for another automation than the one planned');
      const other = otherActive(ctx, k);
      if (other) return fail('one-automation', other);
    }
    if (d.functionName === 'run') {
      const deadline = d.args[1] as bigint;
      const left = deadline - BigInt(Math.floor(ctx.nowSec));
      if (left <= 0n || left > BigInt(RUN_DEADLINE_SEC)) return fail('run-deadline', 'the run deadline must be within 5 minutes');
      const nowMs = ctx.nowMs ?? ctx.nowSec * 1000;
      if (ctx.simulatedOkAtMs === undefined || nowMs - ctx.simulatedOkAtMs > 30_000 || nowMs < ctx.simulatedOkAtMs) return fail('run-deadline', 'the run was not simulated in the last 30 seconds');
    }
  }
  return { ok: true, call: { contract: target, functionName: d.functionName, args: d.args } };
}

// ------------------------------------------------------------------ signed messages

export interface TypedDataCtx {
  chainId: number | undefined;
  gac4: Address;
  tokenId: bigint;
  /** nonces of this signing session */
  allowedNonces: readonly bigint[];
  /** the position NFT's DOMAIN_SEPARATOR() read on chain */
  onchainDomainSeparator: Hex | null | undefined;
  nowSec: number;
  /** the pinned GoatAutoCompoundV4 (must equal the spender) */
  gac4Target: Address | null;
  /** the code-hash check of GoatAutoCompoundV4 passed */
  gateOk: boolean;
  /** the signer owns the position (read right before) */
  ownerOk: boolean;
}

export interface TypedDataLike {
  domain: object;
  types: { readonly [k: string]: readonly { readonly name: string; readonly type: string }[] };
  primaryType: string;
  message: object;
}

/** The signed-message check (with chain, position and pinned-code) on one typed-data request. */
export function checkAutomationTypedData(td: TypedDataLike, ctx: TypedDataCtx): Check {
  if (ctx.chainId !== GOAT_CHAIN_ID) return no('chain', 'not on Robinhood Chain (4663)');
  if (!ctx.gateOk) return no('pinned-code', 'GoatAutoCompoundV4 does not match the pinned build');
  if (!ctx.ownerOk) return no('position', 'the signer does not own this position on chain');
  const dom = td.domain as Record<string, unknown>;
  const keys = Object.keys(dom).sort().join(',');
  if (keys !== 'chainId,name,verifyingContract') return no('signed-message', 'unexpected domain fields');
  if (dom.name !== POSM_DOMAIN_NAME || Number(dom.chainId) !== GOAT_CHAIN_ID || !eq(dom.verifyingContract as string, POSM)) return no('signed-message', 'the message is not for the Uniswap v4 position NFT on 4663');
  let sep: Hex;
  try { sep = domainSeparator({ domain: dom as TypedDataDomain }); } catch { return no('signed-message', 'bad domain'); }
  if (!ctx.onchainDomainSeparator || sep.toLowerCase() !== ctx.onchainDomainSeparator.toLowerCase()) return no('signed-message', 'the domain does not match the position NFT on chain');
  if (td.primaryType !== 'Permit') return no('signed-message', 'only the per-run Permit message is signed');
  const want = PERMIT_TYPES.Permit;
  const got = td.types.Permit;
  if (!got || got.length !== want.length || got.some((f, i) => f.name !== want[i].name || f.type !== want[i].type)) return no('signed-message', 'unexpected message type');
  if (Object.keys(td.types).some((t) => t !== 'Permit' && t !== 'EIP712Domain')) return no('signed-message', 'unexpected extra types');
  const m = td.message as { spender?: string; tokenId?: bigint; nonce?: bigint; deadline?: bigint };
  if (!ctx.gac4Target || !eq(ctx.gac4, ctx.gac4Target) || !eq(m.spender, ctx.gac4)) return no('signed-message', 'the spender must be GoatAutoCompoundV4');
  if (m.tokenId !== ctx.tokenId) return no('signed-message', 'the message is for another position');
  if (typeof m.nonce !== 'bigint' || !ctx.allowedNonces.some((x) => x === m.nonce)) return no('signed-message', 'the nonce is not from this signing session');
  const base = permitWord(ctx.gac4, ctx.tokenId);
  const word = m.nonce >> 8n;
  if (word < base || word >= base + BigInt(SESSION_WORDS_MAX) || Number(m.nonce & 255n) >= MAX_RUNS_PER_SESSION) return no('signed-message', "the nonce is outside this position's signing window");
  if (typeof m.deadline !== 'bigint' || m.deadline <= BigInt(Math.floor(ctx.nowSec)) || m.deadline > BigInt(Math.floor(ctx.nowSec) + HORIZON_MAX_SEC)) return no('signed-message', 'the end date must be within 90 days');
  return OK;
}

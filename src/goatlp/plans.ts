// The two-step flow of every Goat LP write tool. Without `execute: true` a tool returns a plan (every transaction and
// signature in order, with what it does, and the result of simulating it) and a planId; nothing is sent. With
// `execute: true` and that planId (single use, valid for 10 minutes, the same inputs) the tool builds the plan again from
// fresh chain reads, checks that it is the same plan, and only then sends it, one step at a time. The rebuild keeps the
// plan's basis (its clock, and for a deposit the pool price it was sized at), so a price that moved inside the deposit's
// limits does not change the plan; every check still reads the chain again.
//   transaction: fresh reads and the decode check -> eth_call simulation (refused on revert) -> send -> receipt -> read-back
//   signatures:  the signed-message check on every message -> sign (the signatures stay in memory)
//   hand-over:   the signed messages go to the keeper store
import { decodeErrorResult, keccak256, stringToHex, type Abi, type Address, type Hex } from 'viem';
import { GOAT_ERROR_ABIS } from './abis';
import { addressUrl, isNotBroadcast, txUrl, type GoatChain, type GoatSigner, type TxReceipt } from './chain';
import { PLAN_TTL_MS } from './constants';
import { ERROR_TEXT, TX_FAILED } from './copy';

export interface TxStep {
  kind: 'tx';
  label: string;
  to: Address;
  data: Hex;
  value: bigint;
  /** what the agent shows the user */
  view: Record<string, unknown>;
  /** fresh reads and the decode check, right before sending: a refusal text, or null */
  precheck: () => Promise<string | null>;
  /** read-back after the receipt: what is not as expected, or null */
  verify?: () => Promise<string | null>;
  /** right before the transaction is signed and sent (bookkeeping such as the add-liquidity total) */
  onSend?: () => void;
  /** after a send that failed before the transaction left the wallet (nothing reached the chain) */
  onNotSent?: () => void;
  /** after a receipt that says the transaction reverted */
  onRevert?: () => void;
  /** after a confirmed receipt */
  after?: (receipt: TxReceipt) => void;
}
export interface WorkStep {
  kind: 'sign' | 'post';
  label: string;
  view: Record<string, unknown>;
  /** the fingerprint part of this step (what it will sign or send) */
  key: string;
  run: () => Promise<Record<string, unknown>>;
}
export type PlanStep = TxStep | WorkStep;

export interface BuiltPlan {
  tool: string;
  /** what the plan shows besides its steps (position, rule, fees, notes) */
  view: Record<string, unknown>;
  steps: PlanStep[];
  /** run once every step is done: the state read back from the chain */
  readBack?: () => Promise<Record<string, unknown>>;
  /** what the rebuild at execute keeps from this plan besides its clock (a deposit: the pool price it was sized at) */
  basis?: Record<string, unknown>;
  /** more of the plan's identity than its steps (such as what the user must acknowledge) */
  fingerprintExtra?: string;
  /** what the agent must do next instead of the usual "confirm, then execute" (a plan that cannot be executed as it is) */
  next?: string;
}

/** The plan's clock (unix seconds) and what else the rebuild keeps */
export interface PlanBasis { nowSec: number; [key: string]: unknown }

/** A plan's identity: the exact transactions, what each signing or hand-over step covers, and the extra text */
export function fingerprintOf(steps: readonly PlanStep[], extra = ''): Hex {
  const parts = steps.map((s) => (s.kind === 'tx' ? `tx|${s.to.toLowerCase()}|${s.data.toLowerCase()}|${s.value}` : `${s.kind}|${s.key}`));
  if (extra) parts.push(`extra|${extra}`);
  return keccak256(stringToHex(parts.join('\n')));
}

interface PlanRecord { id: string; tool: string; inputKey: string; createdAtMs: number; basis: PlanBasis; fingerprint: Hex; used: boolean }

/** Canonical JSON of the inputs (keys sorted, undefined dropped), the plan's "same inputs" test */
export function inputKeyOf(input: Record<string, unknown>): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => [k, norm((v as Record<string, unknown>)[k])]));
    return typeof v === 'bigint' ? v.toString() : v;
  };
  const { execute: _e, planId: _p, ...rest } = input;
  return JSON.stringify(norm(rest));
}

export class PlanStore {
  private plans = new Map<string, PlanRecord>();
  constructor(private readonly now: () => number) {}

  create(tool: string, inputKey: string, basis: PlanBasis, fingerprint: Hex): PlanRecord {
    for (const [k, p] of this.plans) if (this.now() - p.createdAtMs > PLAN_TTL_MS) this.plans.delete(k);
    const id = keccak256(stringToHex(`${tool}|${inputKey}|${this.now()}|${Math.random()}`)).slice(2, 26);
    const rec: PlanRecord = { id, tool, inputKey, createdAtMs: this.now(), basis, fingerprint, used: false };
    this.plans.set(id, rec);
    return rec;
  }

  /** The plan to execute: known, unused, not expired, for this tool and these inputs. Marked used at once. */
  take(id: string, tool: string, inputKey: string): PlanRecord {
    const p = this.plans.get(id);
    if (!p) throw new Error('Not sent: this planId is unknown or expired. Call the tool without execute to get a new plan and show it to the user.');
    if (p.tool !== tool) throw new Error(`Not sent: this planId belongs to ${p.tool}.`);
    if (p.used) throw new Error('Not sent: this plan was already executed. Call the tool without execute to get a new plan.');
    if (this.now() - p.createdAtMs > PLAN_TTL_MS) { this.plans.delete(id); throw new Error('Not sent: this plan expired (plans last 10 minutes). Call the tool without execute to get a new plan and show it to the user.'); }
    if (p.inputKey !== inputKey) throw new Error('Not sent: the inputs differ from the ones this plan was made with. Call the tool without execute to get a new plan for these inputs.');
    p.used = true;
    return p;
  }

  expiresAt(p: PlanRecord): string { return new Date(p.createdAtMs + PLAN_TTL_MS).toISOString(); }
}

/** Plain text of a revert or a wallet error: a known contract error by name, else a short line */
export function revertText(e: unknown): string {
  const data = revertDataOf(e);
  if (data) {
    for (const abi of GOAT_ERROR_ABIS) {
      try { const d = decodeErrorResult({ abi: abi as Abi, data }); return ERROR_TEXT[d.errorName] ? `${ERROR_TEXT[d.errorName]} (${d.errorName})` : `The contract refused it (${d.errorName}).`; } catch { /* next */ }
    }
  }
  const m = (e as { shortMessage?: string; message?: string })?.shortMessage ?? (e as Error)?.message ?? String(e);
  return m.split('\n')[0].slice(0, 240);
}

function revertDataOf(e: unknown): Hex | null {
  let cur: unknown = e;
  for (let i = 0; i < 6 && cur; i++) {
    const d = (cur as { data?: unknown }).data;
    if (typeof d === 'string' && /^0x[0-9a-fA-F]{8,}$/.test(d)) return d as Hex;
    if (d && typeof d === 'object' && typeof (d as { data?: unknown }).data === 'string') return (d as { data: Hex }).data;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

/** Simulate a transaction from the signer: null when it would go through, else why it would revert */
export async function simulate(chain: GoatChain, from: Address, s: Pick<TxStep, 'to' | 'data' | 'value'>): Promise<string | null> {
  try { await chain.call({ from, to: s.to, data: s.data, value: s.value }); return null; } catch (e) { return revertText(e); }
}

/** Plan-time simulation of each transaction: the first must go through; a later one that needs an earlier step first is
 *  simulated again right before it is sent. */
export async function planSimulation(chain: GoatChain, from: Address, steps: readonly PlanStep[]): Promise<void> {
  let firstTx = -1;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.kind !== 'tx') continue;
    const why = await simulate(chain, from, s);
    if (firstTx < 0) {
      firstTx = i;
      if (why) throw new Error(`Not planned: step ${i + 1} (${s.label}) would revert: ${why}`);
      s.view.simulation = 'ok: it goes through as of the latest block';
    } else {
      s.view.simulation = why ? `runs after step ${firstTx + 1}; simulated again right before it is sent` : 'ok: it goes through as of the latest block';
    }
  }
}

/** Send a plan's steps in order. On a failure the error says what was already done. */
export async function executeSteps(chain: GoatChain, signer: GoatSigner, steps: readonly PlanStep[], signal?: AbortSignal): Promise<Record<string, unknown>[]> {
  const done: Record<string, unknown>[] = [];
  const doneText = () => (done.length ? ` Done before it: ${done.map((d) => `step ${d.step} (${d.action})${d.txHash ? ` ${d.txHash}` : ''}`).join('; ')}.` : ' Nothing was sent.');
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const step = i + 1;
    if (signal?.aborted) throw new Error(`Stopped before step ${step}: the request was cancelled.${doneText()}`);
    if (s.kind !== 'tx') {
      let r: Record<string, unknown>;
      try { r = await s.run(); } catch (e) { throw new Error(`Step ${step} (${s.label}) failed: ${(e as Error).message}${doneText()}`); }
      done.push({ step, action: s.label, ...r });
      continue;
    }
    const refused = await s.precheck();
    if (refused) throw new Error(`Not sent: step ${step} (${s.label}) was refused before signing: ${refused}${doneText()}`);
    const why = await simulate(chain, signer.address, s);
    if (why) throw new Error(`Not sent: step ${step} (${s.label}) would revert: ${why}${doneText()}`);
    let hash: Hex;
    s.onSend?.();
    try { hash = await signer.sendTransaction({ to: s.to, data: s.data, value: s.value }); } catch (e) {
      const why = revertText(e).replace(/\.?$/, '.');
      if (isNotBroadcast(e)) {
        s.onNotSent?.();
        throw new Error(`Step ${step} (${s.label}) was not sent: ${why}${doneText()}`);
      }
      // the RPC may have taken it: the outcome is unknown
      throw new Error(`Step ${step} (${s.label}) may have been sent: ${why} Check the wallet on the explorer (${addressUrl(signer.address)}) before trying again.${doneText()}`);
    }
    let receipt: TxReceipt;
    try { receipt = await chain.waitReceipt(hash); } catch (e) {
      throw new Error(`Step ${step} (${s.label}) was sent (${hash}, ${txUrl(hash)}) but its receipt could not be read: ${revertText(e)}. Check it on the explorer before trying again.${doneText()}`);
    }
    if (receipt.status !== 'success') {
      s.onRevert?.();
      throw new Error(`Step ${step} (${s.label}): ${TX_FAILED} ${hash} (${txUrl(hash)}).${doneText()}`);
    }
    s.after?.(receipt);
    const problem = s.verify ? await s.verify().catch((e: unknown) => `the read-back failed: ${revertText(e)}`) : null;
    done.push({ step, action: s.label, txHash: hash, explorer: txUrl(hash), status: 'confirmed', ...(problem ? { readBack: problem } : {}) });
  }
  return done;
}

// The positions of one r4 auto-range rule. A move that runs in pieces leaves the rule on the old position until it is
// empty, and copies it to the position the pieces go to (the link `pieceDest(old)`); when the link no longer holds, a new
// position is made and the link moves on, so an earlier one keeps its own copy. Stop and Change reach all of them in one
// transaction (v4 clearConfigs / setRangeConfigs, v3 configTokens).
// The list, read at the click: this position; the link chain from it (pieceDest, at most 8 steps); and every position of the
// wallet in the same pool whose rule equals this rule (the contract's own test of a link: the same rule, the same pool,
// the same owner; the v4 fields less lastRunAt and budget). A read that fails is unknown, never empty: `complete` is then
// false and the plan says so.
import type { Address } from 'viem';
import { autoRangeAbi, npmAbi, posmAbi, stewardAbi } from './abis';
import { routes } from './api';
import type { ApiPositionsResponse } from './apiTypes';
import type { GoatChain } from './chain';
import { NPM, POSM } from './constants';
import type { GoatApi } from './api';
import { loadPositionFacts, type GoatEnv } from './facts';
import type { ArConfig, PositionFacts, RuleRead, StewardConfig, Venue } from './types';

const eq = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
export const FAMILY_MAX_HOPS = 8;
export const FAMILY_MAX_IDS = 40;

export interface RuleFamily {
  /** this position first, then the others; at most FAMILY_MAX_IDS */
  ids: bigint[];
  /** pieceDest(this position) is set: a move of this rule runs in pieces now */
  moving: boolean;
  /** every read ran; false = the list may miss a position */
  complete: boolean;
}

/** Do two r4 range rules carry the same rule (the contract's link test)? Pure. */
export function sameRule(venue: Venue, a: RuleRead, b: RuleRead): boolean {
  if (a.kind !== 'range' || b.kind !== 'range' || a.venue !== venue || b.venue !== venue) return false;
  if (venue === 'v3') {
    const x = a.cfg as ArConfig; const y = b.cfg as ArConfig;
    return (Object.keys(x) as (keyof ArConfig)[]).every((k) => String(x[k]) === String(y[k]));
  }
  const x = a.cfg as StewardConfig; const y = b.cfg as StewardConfig;
  return (Object.keys(x) as (keyof StewardConfig)[]).filter((k) => k !== 'lastRunAt' && k !== 'budget').every((k) => String(x[k]) === String(y[k]));
}

const ruleOwnedBy = (f: PositionFacts, owner: Address): RuleRead | null => {
  const r = f.rules?.range;
  if (!r || r === 'unknown' || !r.on || !eq(r.owner, owner) || f.owner === 'unknown' || !eq(f.owner, owner)) return null;
  return r;
};

/** The positions of the r4 auto-range rule on `id` (held and owned by `owner`). `rule` = the rule read on `id`. */
export async function rangeFamily(x: {
  chain: GoatChain; api: GoatApi; env: Pick<GoatEnv, 'gates' | 'targets'>; venue: Venue; id: bigint; owner: Address; rule: RuleRead; pool: string | null;
}): Promise<RuleFamily> {
  const { chain, env, venue, id, owner, rule } = x;
  const target = venue === 'v4' ? env.targets.rangeExitV4 : env.targets.rangeExitV3;
  const abi = venue === 'v4' ? stewardAbi : autoRangeAbi;
  const ids: bigint[] = [id];
  const seen = new Set([String(id)]);
  let complete = true;
  let moving = false;
  const add = (f: PositionFacts) => {
    if (seen.has(String(f.id)) || ids.length >= FAMILY_MAX_IDS) return;
    const r = ruleOwnedBy(f, owner);
    if (r && sameRule(venue, rule, r)) { ids.push(f.id); seen.add(String(f.id)); }
  };
  // the link chain
  let cur = id;
  for (let hop = 0; hop < FAMILY_MAX_HOPS; hop++) {
    let dest: bigint;
    try { dest = BigInt(await chain.read<bigint>({ address: target, abi, functionName: 'pieceDest', args: [cur] })); } catch { complete = false; break; }
    if (dest === 0n) break;
    if (hop === 0) moving = true;
    if (seen.has(String(dest))) break;
    const [f] = await loadPositionFacts(chain, [{ id: dest, venue }], env);
    if (f.owner === 'unknown' || f.rules?.range === 'unknown') { complete = false; break; }
    add(f);
    cur = dest;
  }
  // the wallet's other positions in the same pool with the same rule
  if (!x.pool) complete = false;
  else {
    try {
      const body = await x.api.get<ApiPositionsResponse>(routes.accountPositions(owner, { scope: 'active', limit: 50, venue }), 'account');
      const rows = (body.data ?? []).filter((p) => !p.exited && eq(p.pool, x.pool) && !seen.has(String(p.nft_id)));
      if (body.pagination?.has_next || body.pagination?.next_cursor) complete = false;
      const facts = rows.length ? await loadPositionFacts(chain, rows.map((p) => ({ id: BigInt(p.nft_id), venue })), env) : [];
      for (const f of facts) {
        if (f.owner === 'unknown' || f.rules?.range === 'unknown') { complete = false; continue; }
        add(f);
      }
    } catch { complete = false; }
  }
  return { ids, moving, complete };
}

/** Is every listed position still held by `owner`? (read right before a batch is signed; a failed read is a no) */
export async function heldByAll(chain: GoatChain, venue: Venue, ids: readonly bigint[], owner: Address): Promise<boolean> {
  const nft = venue === 'v4' ? { address: POSM, abi: posmAbi } : { address: NPM, abi: npmAbi };
  const res = await chain.multicall(ids.map((id) => ({ ...nft, functionName: 'ownerOf', args: [id] }))).catch(() => null);
  return !!res && res.length === ids.length && res.every((r) => r.status === 'success' && eq(r.result as string, owner));
}

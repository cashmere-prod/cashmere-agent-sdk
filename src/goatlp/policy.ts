// The served automation policy (GET /v2/automation/policy, cached for its max-age): the keeper's minimum position size, and
// the switches it may carry. An automation switched off there (false for its venue and kind) is off for these tools too;
// a policy without switches changes nothing. The write tools refuse to turn anything on while the policy cannot be read.
import { routes, type GoatApi } from './api';
import { RANGE_MIN_MOVABLE_USD } from './constants';
import type { Kind, Venue } from './types';

export type Switches = Partial<Record<Venue, Partial<Record<Kind, boolean>>>>;

const VENUES: readonly Venue[] = ['v3', 'v4'];
const KINDS: readonly Kind[] = ['compound', 'range', 'exit'];
const obj = (x: unknown): Record<string, unknown> | null => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : null);

/** The switches of a policy body: `live` or `enabled` (also under `automation`), by venue then kind, kind then venue,
 *  "kind_venue" / "venue_kind" / "venue:kind" keys, or a kind alone for both venues. Only booleans count. */
export function switchesOf(policy: unknown): Switches {
  const out: Switches = {};
  const p = obj(policy);
  if (!p) return out;
  const maps = [p.live, p.enabled, obj(p.automation)?.live, obj(p.automation)?.enabled].map(obj).filter((m): m is Record<string, unknown> => m !== null);
  for (const m of maps) {
    for (const v of VENUES) {
      for (const k of KINDS) {
        const cands = [obj(m[v])?.[k], obj(m[k])?.[v], m[`${k}_${v}`], m[`${v}_${k}`], m[`${v}:${k}`], m[k]];
        const b = cands.find((c) => typeof c === 'boolean') as boolean | undefined;
        if (b === undefined) continue;
        const row = (out[v] ??= {});
        // a switch that is off anywhere stays off
        row[k] = row[k] === false ? false : b;
      }
    }
  }
  return out;
}

export interface Policy { minUsd: number; switches: Switches }

/** The policy, or null when it could not be read */
export async function readPolicy(api: GoatApi): Promise<Policy | null> {
  try {
    const p = await api.get<Record<string, unknown>>(routes.automationPolicy(), 'other');
    const v = obj(obj(p)?.keeper)?.min_position_display_usd;
    return { minUsd: typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : RANGE_MIN_MOVABLE_USD, switches: switchesOf(p) };
  } catch {
    return null;
  }
}

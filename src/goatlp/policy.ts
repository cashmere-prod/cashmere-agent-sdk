// The served automation policy (GET /v2/automation/policy, cached for its max-age): the keeper's minimum position size.
// The write tools refuse to turn anything on while the policy cannot be read; a stop never needs it.
// The API serves no on/off switch for the automations yet.
import { routes, type GoatApi } from './api';
import { RANGE_MIN_MOVABLE_USD } from './constants';

const obj = (x: unknown): Record<string, unknown> | null => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : null);

export interface Policy { minUsd: number }

/** The policy, or null when it could not be read */
export async function readPolicy(api: GoatApi): Promise<Policy | null> {
  try {
    const p = await api.get<Record<string, unknown>>(routes.automationPolicy(), 'other');
    const v = obj(obj(p)?.keeper)?.min_position_display_usd;
    return { minUsd: typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : RANGE_MIN_MOVABLE_USD };
  } catch {
    return null;
  }
}

import type { Network, CctpVersion } from '../types';
import { ALL_NETWORKS, DURATION_V1, DURATION_V2_FAST, DURATION_V2_NORM } from '../constants';
import { resolveVersion } from './routing';

export interface SupportedRoutes {
  from: Network;
  // Destinations that share the versions below
  destinations: Network[];
  // Versions the SDK sends these routes over; a requested version outside this list falls back to `defaultVersion`
  versions: CctpVersion[];
  defaultVersion: CctpVersion;
  estimatedDuration: Partial<Record<CctpVersion, string>>;
}

const VERSIONS: CctpVersion[] = ['v2-fast', 'v2-norm', 'v1'];
const DURATIONS = { 'v2-fast': DURATION_V2_FAST, 'v2-norm': DURATION_V2_NORM, v1: DURATION_V1 };

// Routes grouped by source chain, from the rules in routing.ts
export function getSupportedRoutes(filter: { from?: Network; to?: Network } = {}): SupportedRoutes[] {
  const routes: SupportedRoutes[] = [];

  for (const from of ALL_NETWORKS) {
    if (filter.from && filter.from !== from) continue;

    for (const to of ALL_NETWORKS) {
      if (to === from || (filter.to && filter.to !== to)) continue;

      let defaultVersion: CctpVersion;
      try {
        defaultVersion = resolveVersion(from, to);
      } catch {
        continue;
      }
      const versions = VERSIONS.filter(v => resolveVersion(from, to, v) === v);

      const group = routes.find(r =>
        r.from === from && r.defaultVersion === defaultVersion && r.versions.join() === versions.join());
      if (group) {
        group.destinations.push(to);
      } else {
        routes.push({
          from,
          destinations: [to],
          versions,
          defaultVersion,
          estimatedDuration: Object.fromEntries(versions.map(v => [v, DURATIONS[v][from] ?? '~15 minutes'])),
        });
      }
    }
  }

  return routes;
}

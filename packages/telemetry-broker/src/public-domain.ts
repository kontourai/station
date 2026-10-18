import { STATION_DAILY_FIELDS } from '@kontourai/station-contracts/product-telemetry';

// Seven scalar counts plus at most 5 surfaces, 8 engines and 20 plugins = 40.
// These profile/adoption fields exclude counters, friction and customization.
export const PUBLIC_FIELDS = [
  'channel',
  'version',
  'platform',
  'arch',
  'surfaces_today',
  'engines_used_today',
  'first_active_this_week',
  'first_active_this_month',
  'distribution',
  'public_plugins_enabled',
];
export const PUBLIC_SENSITIVITY = PUBLIC_FIELDS.reduce((sum, field) => {
  const rule = STATION_DAILY_FIELDS[field as keyof typeof STATION_DAILY_FIELDS];
  return sum + ('arrayMax' in rule ? rule.arrayMax : 1);
}, 0);
export const PUBLIC_COUNT_EPSILON = 1 / (7 * PUBLIC_SENSITIVITY);

export function publicDomain(
  config: { registry_ids: string[]; release_versions: string[] }[],
): [string, string][] {
  const registry = [...new Set(config.flatMap((c) => c.registry_ids))];
  const versions = [...new Set(config.flatMap((c) => c.release_versions))];
  return PUBLIC_FIELDS.flatMap((dimension): [string, string][] => {
    let values: readonly string[];
    if (dimension === 'version') values = [...versions, 'custom'];
    else if (dimension === 'distribution')
      values = [...registry, 'none', 'custom'];
    else if (dimension === 'public_plugins_enabled')
      values = [...registry, 'none'];
    else {
      const rule =
        STATION_DAILY_FIELDS[dimension as keyof typeof STATION_DAILY_FIELDS];
      values = Array.isArray(rule.domain) ? rule.domain : ['false', 'true'];
      if ('arrayMax' in rule) values = [...values, 'none'];
    }
    return [...new Set(values)].sort().map((value) => [dimension, value]);
  }).sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv));
}

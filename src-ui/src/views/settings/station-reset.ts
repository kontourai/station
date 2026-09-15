/**
 * What "Reset Station settings" actually clears.
 *
 * The button used to send `updateConfig({})`. An empty body sanitizes to an
 * empty accepted set and `updateAppConfig({})` merges nothing, so the dialog
 * promised "reset all settings to factory defaults" and the request was a
 * no-op. A reset has to name the keys it clears, and `null` is the PUT
 * layer's documented clear signal (`sanitizeAppConfigUpdate`), so the delta
 * is `{ key: null }` for every key that is honestly clearable.
 *
 * The candidate list is DERIVED from what the Settings page renders at
 * Station and Defaults scope, then filtered through the registry itself, so
 * it cannot drift into a second hand-written inventory:
 *
 * - `required` keys (`defaultModel`, `invokeModel`, `structureModel`) are
 *   excluded: the sanitizer refuses `null` for them and would reject the
 *   whole request.
 * - `nullable` keys (`builtinAgentEngineConnectionId`) are excluded: `null`
 *   there is a distinct STORED value ("explicitly Station", sticky), not a
 *   clear — see `mergeAppConfigUpdate` and `NULLABLE_APP_CONFIG_KEYS`.
 * - `logLevel` is excluded: `PUT /config/app` refuses it outright; it is
 *   written through the revisioned `/api/config/app/log-level` endpoint.
 *   Its registry entry declares no `defaultValue`, so there is no factory
 *   value to restore it to — resetting it is deliberately out of scope and
 *   the dialog does not claim otherwise.
 * - `PRIVACY_PRESERVED_KEYS` are excluded: see below — restoring their
 *   default would undo an opt-out rather than restore a neutral value.
 * - `userFacing: false` keys never render, so they are never candidates.
 * - `firstRun` is not rendered anywhere and the route refuses it as well.
 */
import type {
  SettingDefinition,
  SettingProvenanceEntry,
} from '@kontourai/station-contracts/settings-registry';
import { USER_FACING_APP_SETTINGS_REGISTRY } from '@kontourai/station-contracts/settings-registry';
import type { AppConfig } from '../../types';
import { STATION_CONFIG_KEYS } from './StationConfigSection';

/**
 * The Defaults-scope fields `AgentDefaultsSection` renders. `defaultModel` is
 * rendered there too and is deliberately absent: it is a registry `required`
 * key, and the filter below would drop it anyway — listing it here would only
 * suggest the exclusion is accidental.
 */
const DEFAULTS_RENDERED_KEYS: readonly (keyof AppConfig)[] = [
  'systemPrompt',
  'region',
  'templateVariables',
];

/** Written through its own revisioned endpoint; `PUT /config/app` refuses it. */
const SEPARATELY_WRITTEN_KEYS: ReadonlySet<keyof AppConfig> = new Set([
  'logLevel',
]);

/**
 * Settings whose factory default is MORE permissive than an opt-out, so
 * "restore the default" and "undo the person's choice" are the same act.
 *
 * `telemetryEnabled` defaults to `true`. A stored `false` is the only
 * artifact of someone turning telemetry off, and clearing it would turn it
 * back on — a reset silently widening what leaves this Station. The toggle
 * stays where it is (Station configuration, and the telemetry disclosure);
 * the dialog says a reset does not touch it.
 */
const PRIVACY_PRESERVED_KEYS: ReadonlySet<keyof AppConfig> = new Set([
  'telemetryEnabled',
]);

const REGISTRY_BY_KEY: ReadonlyMap<keyof AppConfig, SettingDefinition> =
  new Map(
    USER_FACING_APP_SETTINGS_REGISTRY.map((definition) => [
      definition.key,
      definition,
    ]),
  );

/**
 * Every rendered Station/Defaults key this Station can honestly clear, in the
 * order the page renders them.
 */
export const RESETTABLE_STATION_SETTING_KEYS: readonly (keyof AppConfig)[] = [
  ...STATION_CONFIG_KEYS,
  ...DEFAULTS_RENDERED_KEYS,
].filter((key) => {
  const definition = REGISTRY_BY_KEY.get(key);
  if (!definition) return false;
  if (definition.required) return false;
  if (definition.nullable) return false;
  if (PRIVACY_PRESERVED_KEYS.has(key)) return false;
  return !SEPARATELY_WRITTEN_KEYS.has(key);
});

export interface StationResetPlan {
  /** Keys that currently hold a stored value and would be cleared. */
  keys: (keyof AppConfig)[];
  /** Their registry labels, for the confirmation copy. */
  labels: string[];
  /** The `PUT /config/app` body. Empty when there is nothing to clear. */
  delta: Partial<AppConfig>;
}

/**
 * Which resettable keys are actually stored right now.
 *
 * `source === 'file'` is the only provenance that means "somebody stored
 * this" — `default` and `env` describe values that are already the factory
 * resolution, and clearing them would change nothing while implying it did.
 */
export function buildStationResetPlan(
  provenance: Record<string, SettingProvenanceEntry> | undefined,
): StationResetPlan {
  const keys = RESETTABLE_STATION_SETTING_KEYS.filter(
    (key) => provenance?.[key as string]?.source === 'file',
  );
  return {
    keys,
    labels: keys.map(
      (key) => REGISTRY_BY_KEY.get(key)?.label ?? (key as string),
    ),
    delta: Object.fromEntries(
      keys.map((key) => [key, null]),
    ) as Partial<AppConfig>,
  };
}

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
 * it cannot drift into a second hand-written inventory. The inventory is the
 * SETTINGS CATALOG — the one list that says which rows the page renders and
 * what each one writes — rather than any single section's key list (#2182).
 * It used to be `StationConfigSection`'s own `STATION_CONFIG_KEYS` plus a
 * hand-written defaults list, which tied "what a reset clears" to "what one
 * card happens to render": splitting that card across several cards would
 * have shrunk the reset silently, since the dialog names only the keys that
 * are actually stored and a shorter list still reads as plausible.
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
  DeviceSettingDefinition,
  DeviceSettings,
} from '@kontourai/station-contracts/device-settings';
import {
  DEVICE_SETTINGS_REGISTRY,
  PREFERENCE_DEVICE_KEYS,
} from '@kontourai/station-contracts/device-settings';
import type {
  SettingDefinition,
  SettingProvenanceEntry,
} from '@kontourai/station-contracts/settings-registry';
import { USER_FACING_APP_SETTINGS_REGISTRY } from '@kontourai/station-contracts/settings-registry';
import type { AppConfig } from '../../types';
import { SETTINGS_CATALOG } from './settings-catalog';

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
 * stays where it is (the Telemetry section, beside the disclosure);
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
 * Every Settings row that writes the Station document, in catalog order.
 *
 * That is also the order the page renders them, and the dialog's label list
 * is the reason it has to be: a reader compares the names in the
 * confirmation against the rows they were just looking at. The agreement is
 * not automatic — it holds because `SettingsView` mounts its sections in
 * `SETTINGS_SECTIONS` order and each section renders its rows in catalog
 * order. Both halves are asserted against the DOM in
 * `settings-catalog-completeness.test.tsx` ("the page body mounts its
 * sections in the order the nav lists them" and "the reset key order is the
 * order those rows appear on the page") rather than restated here, because
 * this sentence was true, then briefly false when #2182 mounted two new
 * cards out of order, and nothing said so.
 *
 * A row's FIRST config key, matching what `scripts/gen-settings-registry.ts`
 * publishes as the row's key: a row with several keys is one control over one
 * primary value. `scope` is the row's own declared write authority
 * (`settings-catalog.ts`), so device rows and derived status readings drop out
 * here rather than having to be listed as exclusions.
 */
const RENDERED_STATION_SETTING_KEYS: readonly (keyof AppConfig)[] = [
  ...new Set(
    SETTINGS_CATALOG.filter(
      (entry) => entry.scope === 'station' || entry.scope === 'defaults',
    ).flatMap((entry) => entry.configKeys?.slice(0, 1) ?? []),
  ),
] as (keyof AppConfig)[];

/**
 * Every rendered Station/Defaults key this Station can honestly clear, in the
 * order the page renders them.
 */
export const RESETTABLE_STATION_SETTING_KEYS: readonly (keyof AppConfig)[] =
  RENDERED_STATION_SETTING_KEYS.filter((key) => {
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

/**
 * What "Restore device defaults" would actually change (epic #2144 slice 6
 * item F).
 *
 * Candidates are `PREFERENCE_DEVICE_KEYS` — the settings somebody CHOSE.
 * `DIRECT_MANIPULATION_DEVICE_KEYS` (dock size, region arrangement, panel
 * open state, first-run progress) are excluded at the contracts layer, and
 * `device-settings.test.ts` asserts every registered key is in exactly one
 * of the two, so a new device setting cannot land unclassified.
 *
 * Only keys whose CURRENT value differs from the registry default are
 * listed: the confirmation names what changes, and clearing a key that
 * already holds its default changes nothing while implying it did. This
 * mirrors `buildStationResetPlan`'s `source === 'file'` filter, with the
 * device store's own resolved snapshot standing in for provenance — it has
 * none, because it never round-trips to a server.
 *
 * `undefined` for a key reads as "not stored", i.e. equal to the default:
 * the live store folds defaults in, so `undefined` only appears for a
 * partial snapshot and must not be reported as a difference.
 */
export interface DeviceResetPlan {
  /** Preference keys currently holding something other than their default. */
  keys: (keyof DeviceSettings)[];
  /** Their registry labels, for the confirmation copy. */
  labels: string[];
}

const DEVICE_REGISTRY_BY_KEY: ReadonlyMap<
  keyof DeviceSettings,
  DeviceSettingDefinition
> = new Map(
  DEVICE_SETTINGS_REGISTRY.map((definition) => [
    definition.key,
    definition as DeviceSettingDefinition,
  ]),
);

/**
 * Structural equality for a stored device value against its registry
 * default. Needed because half the preference keys are composites
 * (`featureSettings`, `shortcutOverrides`, `modelPickerPreferences`,
 * `sidebarSections`) where `===` is false for every snapshot, which would
 * report every device as having changed everything.
 *
 * Key ORDER is deliberately not significant, and arrays are compared
 * positionally (`modelPickerPreferences.order` is a real sequence).
 */
function sameDeviceValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length)
      return false;
    return a.every((entry, index) => sameDeviceValue(entry, b[index]));
  }
  if (
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    a === null ||
    b === null
  ) {
    return false;
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (!sameDeviceValue(left[key], right[key])) return false;
  }
  return true;
}

export function buildDeviceResetPlan(
  settings: Partial<DeviceSettings> | undefined,
): DeviceResetPlan {
  const keys = (PREFERENCE_DEVICE_KEYS as readonly (keyof DeviceSettings)[])
    .filter((key) => DEVICE_REGISTRY_BY_KEY.has(key))
    .filter((key) => {
      const value = settings?.[key];
      if (value === undefined) return false;
      return !sameDeviceValue(
        value,
        DEVICE_REGISTRY_BY_KEY.get(key)?.defaultValue,
      );
    });
  return {
    keys,
    labels: keys.map(
      (key) => DEVICE_REGISTRY_BY_KEY.get(key)?.label ?? (key as string),
    ),
  };
}

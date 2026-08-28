import type { DeviceSettings } from '@kontourai/station-contracts/device-settings';
import {
  DEVICE_SETTINGS_REGISTRY,
  extractPriorDeviceSettingsRoot,
} from '@kontourai/station-contracts/device-settings';
import { APP_SETTINGS_REGISTRY } from '@kontourai/station-contracts/settings-registry';
import {
  type DeviceSettingsEnvelope,
  deviceSettingsStore,
  parsePriorValue,
} from '../../lib/device-settings-store';
import type { AppConfig } from '../../types';
import { matchingSettingsRows } from './settings-search';

/**
 * archive#settings-revamp: the hardcoded SECTION_TERMS keyword map
 * that used to back `isSettingsSectionVisible` is retired in favor of
 * `settings-search.ts`'s registry-driven index (APP_SETTINGS_REGISTRY +
 * DEVICE_SETTINGS_REGISTRY labels/descriptions) — see that module. A small
 * manual term list survives ONLY for leaf sections with no registry entries
 * of their own (My knowledge store, host runtime, keyboard shortcuts).
 */
export function getSettingsValidation(config: AppConfig): {
  errors: Record<string, string>;
  warnings: Record<string, string>;
  isValid: boolean;
} {
  const errors: Record<string, string> = {};
  if (config.region && !/^[a-z]{2}(-[a-z]+-\d+)?$/.test(config.region)) {
    errors.region = 'Invalid region format (e.g. us-east-1)';
  }
  if ((config.systemPrompt || '').length > 10000) {
    errors.systemPrompt = 'Exceeds 10,000 character limit';
  }
  for (const variable of config.templateVariables || []) {
    if (!variable.key.trim()) {
      errors.templateVars = 'Variable names cannot be empty';
      break;
    }
    if (/\s/.test(variable.key)) {
      errors.templateVars = 'Variable names cannot contain spaces';
      break;
    }
  }

  const warnings: Record<string, string> = {};
  for (const variable of config.templateVariables || []) {
    if (variable.type === 'static' && !variable.value?.trim()) {
      warnings.templateVarValues =
        'Static variables with empty values will resolve to blank';
      break;
    }
  }

  return {
    errors,
    warnings,
    isValid: Object.keys(errors).length === 0,
  };
}

export function isSettingsSectionVisible(
  id: string,
  searchQuery: string,
): boolean {
  if (!searchQuery.trim()) return true;
  const section = id.replace(/^section-/, '');
  return matchingSettingsRows(searchQuery).some(
    (entry) => entry.section === section,
  );
}

/**
 * Registry-driven pick of `config`'s S1/S2 (`APP_SETTINGS_REGISTRY`) keys —
 * used for both the export payload's `station` field and a parsed import
 * file's returned `serverConfig`, so a file can never carry (out) a raw
 * config spread or an internal, never-persisted field
 * (`mcpUiFrameOrigin`/`managedChatOrchestration` — archive#980/archive#1194 — are
 * never in the registry, so they are never picked here either way).
 */
function sanitizeStationConfig(raw: unknown): Partial<AppConfig> {
  if (!raw || typeof raw !== 'object') return {};
  const record = raw as Record<string, unknown>;
  const station: Partial<AppConfig> = {};
  for (const definition of APP_SETTINGS_REGISTRY) {
    const key = definition.key as string;
    if (Object.hasOwn(record, key)) {
      (station as Record<string, unknown>)[key] = record[key];
    }
  }
  return station;
}

/**
 * archive#1359's own shared root key (`station.device-settings`) — converged in
 * slice 3 onto the registry-driven envelope's `shortcutOverrides`/
 * `modelPickerPreferences` entries (see `device-settings.ts`'s
 * `priorRead`). An OLD export file (from the coexistence window between
 * archive#1359 and this slice) can still carry this root's raw JSON string, either
 * as the v2 payload's `sharedDeviceRoot` field or nested inside an earlier
 * file's `_localStorage` map — both are migrated through this helper rather
 * than written back verbatim, so the shared root itself never resurfaces in
 * localStorage after an import.
 */
const SHARED_PRIOR_DEVICE_SETTINGS_KEY = 'station.device-settings';

function migrateSharedDeviceRoot(raw: unknown): Partial<DeviceSettings> {
  if (typeof raw !== 'string' || raw.length === 0) return {};
  try {
    return extractPriorDeviceSettingsRoot(JSON.parse(raw));
  } catch {
    return {};
  }
}

export interface SettingsExportPayloadV2 {
  version: 2;
  /** Registry-driven S1/S2 config (`APP_SETTINGS_REGISTRY` keys only). */
  station: Partial<AppConfig>;
  /** The full device-settings envelope (archive#settings-revamp slices 2-3) — now the sole owner of every device-scope field, including the archive#1359-era shortcut/model-picker preferences. */
  device: DeviceSettingsEnvelope;
}

export function buildSettingsExportPayload(
  config: AppConfig,
): SettingsExportPayloadV2 {
  return {
    version: 2,
    station: sanitizeStationConfig(config),
    device: deviceSettingsStore.getEnvelope(),
  };
}

/**
 * Lookup from a pre-unification raw localStorage key to the device setting
 * it now maps to — used to import the prior export shape
 * (`{...config, _localStorage: {4 keys}}`). Excludes `priorRead`-bearing
 * definitions (`shortcutOverrides`/`modelPickerPreferences`): those share
 * `SHARED_PRIOR_DEVICE_SETTINGS_KEY` and are migrated via
 * `migrateSharedDeviceRoot` instead of this per-key raw-string path. Also
 * excludes definitions with no `priorStorageKey` at all (archive#settings-
 * revamp: a setting that was never persisted pre-unification) —
 * there is no prior raw string for those to map from.
 */
const PRIOR_KEY_TO_DEFINITION = new Map(
  DEVICE_SETTINGS_REGISTRY.filter(
    (definition) => !definition.priorRead && definition.priorStorageKey,
  ).map((definition) => [definition.priorStorageKey as string, definition]),
);

export interface ParsedSettingsImport {
  serverConfig: Partial<AppConfig>;
  /**
   * Registered device-setting keys present in the file whose value failed
   * descriptor validation and were dropped rather than imported (archive#
   * settings-revamp). Empty when nothing was
   * dropped (including every non-v2 / no-`device`-field file, which never
   * calls `importEnvelope` at all).
   */
  droppedDeviceKeys: (keyof DeviceSettings)[];
}

/**
 * Throws `DeviceSettingsImportVersionError` (re-exported from
 * `device-settings-store.ts`) when the file's device envelope was exported
 * by a newer Station than this one understands — callers (`SettingsView.tsx`)
 * surface that message instead of a generic "Invalid settings file".
 */
export async function parseImportedSettingsFile(
  file: File,
): Promise<ParsedSettingsImport> {
  const text = await file.text();
  const imported: unknown = JSON.parse(text);

  if (!imported || typeof imported !== 'object' || Array.isArray(imported)) {
    return { serverConfig: {}, droppedDeviceKeys: [] };
  }
  const record = imported as Record<string, unknown>;

  if (record.version === 2) {
    let droppedDeviceKeys: (keyof DeviceSettings)[] = [];
    if (record.device && typeof record.device === 'object') {
      // Deliberately not caught here — a future-version envelope must
      // surface as an error to the caller, not fail silently.
      ({ droppedKeys: droppedDeviceKeys } = deviceSettingsStore.importEnvelope(
        record.device,
      ));
    }
    // An OLD export (from the archive#1359/slice-2 coexistence window) can still
    // carry the shared root verbatim in `sharedDeviceRoot` — migrate its
    // fields onto the envelope's own entries instead of writing the raw
    // root back to localStorage (archive#settings-revamp archive#1359
    // convergence: the envelope is now the sole home for those fields).
    const priorPartial = migrateSharedDeviceRoot(
      (record as { sharedDeviceRoot?: unknown }).sharedDeviceRoot,
    );
    if (Object.keys(priorPartial).length > 0) {
      deviceSettingsStore.merge(priorPartial);
    }
    return {
      serverConfig: sanitizeStationConfig(record.station),
      droppedDeviceKeys,
    };
  }

  // Prior format: `{...config, _localStorage: {4 keys}}`. Map each
  // `_localStorage` entry through the matching registry entry's
  // `priorStorageKey`, parsed the same way the store's own one-time
  // migration parses it (already descriptor-safe by construction — see
  // `parsePriorValue` — so this path never produces an invalid value to
  // drop); a key with no matching registry entry is ignored (there is no
  // destination for it anymore).
  const { _localStorage, ...serverConfigRaw } = record;
  if (_localStorage && typeof _localStorage === 'object') {
    const partial: Partial<DeviceSettings> = {};
    for (const [priorKey, raw] of Object.entries(
      _localStorage as Record<string, unknown>,
    )) {
      if (typeof raw !== 'string') continue;
      // A prior export from a archive#1359-era build can carry the shared
      // `station.device-settings` root inside `_localStorage` — migrate its
      // fields into the same partial being assembled below rather than
      // writing the raw root back to localStorage.
      if (priorKey === SHARED_PRIOR_DEVICE_SETTINGS_KEY) {
        Object.assign(partial, migrateSharedDeviceRoot(raw));
        continue;
      }
      const definition = PRIOR_KEY_TO_DEFINITION.get(priorKey);
      if (!definition) continue;
      (partial as Record<string, unknown>)[definition.key] = parsePriorValue(
        definition.descriptor,
        raw,
        definition.defaultValue,
      );
    }
    if (Object.keys(partial).length > 0) deviceSettingsStore.merge(partial);
  }

  return {
    serverConfig: sanitizeStationConfig(serverConfigRaw),
    droppedDeviceKeys: [],
  };
}

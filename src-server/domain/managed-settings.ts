/**
 * Managed settings (#4517): the `settings` entries of the machine's managed
 * policy (#4515), applied to this process's view of `AppConfig`.
 *
 * Precedence, highest first: managed lock > project > Station > environment
 * > managed default > built-in default. Two rules follow from it.
 *
 * - **Readers see managed values.** Most server code reads raw `AppConfig`,
 *   so the overlay is applied where `AppConfig` is loaded
 *   (`loadAppConfigFile`). A lock replaces whatever is stored; a default
 *   fills a key only when nothing closer decided it (no stored decision and
 *   no environment value the setting's own validator accepts).
 * - **Policy values are never written.** The mutation path reads the stored
 *   file raw and writes only what a caller changed, so removing the policy
 *   and restarting restores the user's own values. A change to a locked
 *   key's stored value is refused with {@link ManagedSettingLockedError}.
 *
 * The policy is fixed for the process lifetime: the entrypoint loads it once
 * and `StationRuntime` installs it here, so every `ConfigLoader` in the
 * process (including the ones plugin routes build on demand) sees the same
 * policy without each caller threading it through.
 */

import { isDeepStrictEqual } from 'node:util';
import type { AppConfig } from '@kontourai/station-contracts/config';
import {
  type ManagedPolicySettingEntry,
  type ManagedPolicySummary,
  managedPolicyDenial,
  managedSettingsSchemaError,
  projectFieldsMaskedByLocks,
  withoutLockedProjectFields,
} from '@kontourai/station-contracts/managed-policy';
import { APP_SETTINGS_REGISTRY } from '@kontourai/station-contracts/settings-registry';
import {
  type LoadedManagedPolicy,
  ManagedPolicyInvalidError,
} from '@kontourai/station-shared/managed-policy';
import {
  isConfigurableLogLevel,
  setManagedLogLevelLock,
} from '../utils/logger.js';
import {
  isSeededAppConfigValue,
  SEEDED_APP_CONFIG_KEYS,
} from './app-config-seed.js';
import { resolveSettingEnvironment } from './settings-environment.js';
import { isStoredValue } from './settings-registry-server.js';

export interface ManagedAppSettings {
  summary: ManagedPolicySummary;
  /** Keyed by registry key; the policy parser admitted only those. */
  entries: ReadonlyMap<string, ManagedPolicySettingEntry>;
}

const REGISTRY_BY_KEY = new Map(
  APP_SETTINGS_REGISTRY.map((definition) => [
    definition.key as string,
    definition,
  ]),
);
const SEEDED_KEY_SET: ReadonlySet<string> = new Set(SEEDED_APP_CONFIG_KEYS);

let installed: ManagedAppSettings | null = null;

/** The managed settings of a loaded policy, or null when it manages none. */
export function managedAppSettingsOf(
  loaded: LoadedManagedPolicy | null,
): ManagedAppSettings | null {
  const settings = loaded?.document.settings;
  if (!loaded || !settings || Object.keys(settings).length === 0) return null;
  return {
    summary: loaded.summary,
    entries: new Map(Object.entries(settings)),
  };
}

/**
 * Make `loaded`'s settings this process's managed settings. Called by
 * `StationRuntime` with the policy the entrypoint loaded; null clears them.
 */
export function installManagedAppSettings(
  loaded: LoadedManagedPolicy | null,
): void {
  installed = managedAppSettingsOf(loaded);
  // The logger resolves its level from `STATION_LOG_LEVEL` before any config
  // is read, so a lock has to reach it directly to outrank the variable.
  const logLevel = lockedManagedSetting('logLevel')?.value;
  setManagedLogLevelLock(
    isConfigurableLogLevel(logLevel) ? logLevel : undefined,
  );
}

/** The keys the installed (or given) policy locks. */
export function lockedManagedSettingKeys(
  managed: ManagedAppSettings | null = installed,
): string[] {
  if (!managed) return [];
  return [...managed.entries]
    .filter(([, entry]) => entry.locked)
    .map(([key]) => key);
}

export function installedManagedAppSettings(): ManagedAppSettings | null {
  return installed;
}

/** The locked entry for `key`, if the policy fixes it. */
export function lockedManagedSetting(
  key: string,
  managed: ManagedAppSettings | null = installed,
): ManagedPolicySettingEntry | undefined {
  const entry = managed?.entries.get(key);
  return entry?.locked ? entry : undefined;
}

/**
 * Whether this Station's stored config carries a decision for `key`. A value
 * byte-equal to its loader-written seed is not one: the loader wrote it, and
 * the resolver and provenance already report it as the built-in default.
 */
export function hasStationDecision(stored: object, key: string): boolean {
  const value: unknown = Reflect.get(stored, key);
  if (!isStoredValue(value)) return false;
  return !(
    SEEDED_KEY_SET.has(key) &&
    isSeededAppConfigValue(
      key as (typeof SEEDED_APP_CONFIG_KEYS)[number],
      value,
    )
  );
}

/**
 * Environment variables a setting's real consumer reads that the registry
 * does not declare as its `envFallback`. A managed default sits below the
 * environment, so it must not fill a key one of these supplies; a lock
 * outranks them, which each consumer applies itself (the logger through
 * {@link installManagedAppSettings}; the terminal resolver tries the
 * configured shell before `SHELL`).
 *
 * The telemetry settings also read environment variables; the policy parser
 * refuses them (`MANAGED_POLICY_UNMANAGEABLE_SETTINGS`).
 */
const UNDECLARED_ENVIRONMENT_READERS: Readonly<
  Record<string, (environment: Record<string, string | undefined>) => boolean>
> = {
  // `utils/logger.ts` `envLogLevelOverride`: a valid level only.
  logLevel: (environment) =>
    isConfigurableLogLevel(environment.STATION_LOG_LEVEL),
  // `services/terminal/terminal-shells.ts`: `SHELL`, then `COMSPEC` on
  // Windows, after the configured shell.
  terminalShell: (environment) =>
    Boolean(
      environment.SHELL ||
        (process.platform === 'win32' && environment.COMSPEC),
    ),
};

/** Whether the environment supplies `key` (set and accepted by its reader). */
function environmentSupplies(
  key: string,
  environment: Record<string, string | undefined>,
): boolean {
  if (UNDECLARED_ENVIRONMENT_READERS[key]?.(environment)) return true;
  const definition = REGISTRY_BY_KEY.get(key);
  if (!definition?.envFallback) return false;
  const resolved = resolveSettingEnvironment(definition, environment);
  return resolved.envVar !== undefined && resolved.value !== undefined;
}

/**
 * Whether a managed default supplies `key`: there is one, and nothing above
 * it in the chain (a Station decision or an accepted environment value)
 * does. Project overrides sit above it too; callers resolving for a project
 * check those first.
 */
export function managedDefaultApplies(
  key: string,
  stored: object,
  managed: ManagedAppSettings | null = installed,
  environment: Record<string, string | undefined> = process.env,
): boolean {
  const entry = managed?.entries.get(key);
  if (!entry || entry.locked) return false;
  return (
    !hasStationDecision(stored, key) && !environmentSupplies(key, environment)
  );
}

/**
 * The config every reader sees: `stored` with locked values in place and
 * managed defaults filling the keys nothing closer decided. Returns `stored`
 * itself when no policy manages a setting. Never mutates `stored`.
 */
export function overlayManagedAppSettings<T extends object = AppConfig>(
  stored: T,
  managed: ManagedAppSettings | null = installed,
  environment: Record<string, string | undefined> = process.env,
): T {
  if (!managed) return stored;
  const effective: T = { ...stored };
  for (const [key, entry] of managed.entries) {
    if (
      entry.locked ||
      managedDefaultApplies(key, stored, managed, environment)
    )
      Reflect.set(effective, key, structuredClone(entry.value));
  }
  return effective;
}

/**
 * A write tried to change a setting the policy locks. The message is the one
 * sentence every surface uses: "<Organization>'s policy manages this
 * setting." followed by where to get help.
 */
export class ManagedSettingLockedError extends Error {
  readonly code = 'managed_setting_locked';
  constructor(
    readonly key: string,
    readonly summary: ManagedPolicySummary,
  ) {
    super(managedPolicyDenial(summary, 'this setting'));
    this.name = 'ManagedSettingLockedError';
  }
}

/**
 * Refuse a change to the STORED value of a locked key. Compared on the raw
 * file contents, before and after the merge: a caller that spreads the
 * stored config back unchanged writes nothing new and is not refused, and a
 * write that would change or clear the user's hidden value is.
 */
export function assertLockedSettingsUnchanged(
  before: object,
  after: object,
  managed: ManagedAppSettings | null = installed,
): void {
  if (!managed) return;
  for (const [key, entry] of managed.entries) {
    if (!entry.locked) continue;
    const previous: unknown = Reflect.get(before, key);
    const next: unknown = Reflect.get(after, key);
    if (!isDeepStrictEqual(previous, next))
      throw new ManagedSettingLockedError(key, managed.summary);
  }
}

/**
 * Split a settings update into what may proceed and the refusal for the
 * first locked key it would change. A value equal to the locked value is dropped rather than
 * refused: the effective value already is that, and persisting it would
 * write a policy value into the user's file.
 */
export function withoutLockedNoOps<T extends Record<string, unknown>>(
  updates: T,
  managed: ManagedAppSettings | null = installed,
): { updates: T; refused?: ManagedSettingLockedError } {
  if (!managed) return { updates };
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(updates)) {
    const locked = lockedManagedSetting(key, managed);
    if (!locked) {
      kept[key] = value;
      continue;
    }
    if (isDeepStrictEqual(value, locked.value)) continue;
    return {
      updates,
      refused: new ManagedSettingLockedError(key, managed.summary),
    };
  }
  return { updates: kept as T };
}

/**
 * The project record as readers see it: every field a locked setting hides
 * is removed (`MANAGED_SETTING_PROJECT_FIELDS`: the model and provider as a
 * pair, the approval default with its selection), because a lock outranks a
 * project's choice. The stored record is untouched, so the override returns
 * when the policy is removed.
 */
export function withoutLockedProjectOverrides<P extends object>(
  project: P,
  managed: ManagedAppSettings | null = installed,
): P {
  if (!managed) return project;
  return withoutLockedProjectFields(project, lockedManagedSettingKeys(managed));
}

/** A value a project form sends for a field it saw hidden: "no choice". */
function isAbsentProjectValue(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && value.trim().length === 0)
  );
}

/**
 * A project write with the managed policy's locks applied. For each field a
 * lock hides, compared with the stored record (`existing`, absent on
 * create):
 *
 * - sending "no choice" (`null`, `''`) or the stored value is dropped from
 *   the update, so the stored record keeps its value: readers were shown
 *   the field as absent, and a form that saves an unrelated change sends it
 *   back that way;
 * - any other value is refused with {@link ManagedSettingLockedError}.
 */
export function projectUpdatesWithoutLockedFields<T extends object>(
  updates: T,
  existing: object = {},
  managed: ManagedAppSettings | null = installed,
): T {
  if (!managed) return updates;
  let kept: T | undefined;
  for (const [field, key] of projectFieldsMaskedByLocks(
    lockedManagedSettingKeys(managed),
  )) {
    if (!Object.hasOwn(updates, field)) continue;
    const requested: unknown = Reflect.get(updates, field);
    if (
      !isAbsentProjectValue(requested) &&
      !isDeepStrictEqual(requested, Reflect.get(existing, field))
    )
      throw new ManagedSettingLockedError(key, managed.summary);
    kept ??= { ...updates };
    Reflect.deleteProperty(kept, field);
  }
  return kept ?? updates;
}

/**
 * The 403 body every route sends for {@link ManagedSettingLockedError}:
 * the code, the key, and the sentence composed from the loaded policy's
 * summary (organization and support link are the policy's own public text,
 * not a caught message, so they need no redaction).
 */
export function managedSettingRefusalBody(error: ManagedSettingLockedError): {
  success: false;
  code: 'managed_setting_locked';
  key: string;
  error: string;
} {
  return {
    success: false,
    code: error.code,
    key: error.key,
    error: managedPolicyDenial(error.summary, 'this setting'),
  };
}

/**
 * Startup check for what the contract parser cannot see: each managed
 * value against the settings file schema (`managedSettingsSchemaError`, the
 * same check `station policy check` runs). A failure refuses startup with
 * the policy marker.
 */
export function assertManagedSettingsValid(
  loaded: LoadedManagedPolicy | null,
  validateAppConfig: (config: unknown) => void,
): void {
  if (!loaded) return;
  const problem = managedSettingsSchemaError(
    loaded.document.settings,
    validateAppConfig,
  );
  if (problem)
    throw new ManagedPolicyInvalidError(
      loaded.source.location,
      `a managed setting does not match the settings schema (${problem})`,
    );
}

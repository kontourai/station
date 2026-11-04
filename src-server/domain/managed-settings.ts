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
} from '@kontourai/station-contracts/managed-policy';
import type { ProjectConfig } from '@kontourai/station-contracts/project';
import {
  PROJECT_OVERRIDE_FIELD_ALIASES,
  type ProjectOverridableAppSettingKey,
} from '@kontourai/station-contracts/project-settings-overrides';
import { APP_SETTINGS_REGISTRY } from '@kontourai/station-contracts/settings-registry';
import {
  type LoadedManagedPolicy,
  ManagedPolicyInvalidError,
} from '@kontourai/station-shared/managed-policy';
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
export function hasStationDecision(stored: AppConfig, key: string): boolean {
  const value = (stored as unknown as Record<string, unknown>)[key];
  if (!isStoredValue(value)) return false;
  return !(
    SEEDED_KEY_SET.has(key) &&
    isSeededAppConfigValue(
      key as (typeof SEEDED_APP_CONFIG_KEYS)[number],
      value,
    )
  );
}

/** Whether the environment supplies `key` (set and accepted by its validator). */
function environmentSupplies(
  key: string,
  environment: Record<string, string | undefined>,
): boolean {
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
  stored: AppConfig,
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
export function overlayManagedAppSettings(
  stored: AppConfig,
  managed: ManagedAppSettings | null = installed,
  environment: Record<string, string | undefined> = process.env,
): AppConfig {
  if (!managed) return stored;
  const effective: Record<string, unknown> = { ...stored };
  for (const [key, entry] of managed.entries) {
    if (
      entry.locked ||
      managedDefaultApplies(key, stored, managed, environment)
    )
      effective[key] = structuredClone(entry.value);
  }
  return effective as unknown as AppConfig;
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
    summary: ManagedPolicySummary,
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
  before: AppConfig,
  after: AppConfig,
  managed: ManagedAppSettings | null = installed,
): void {
  if (!managed) return;
  for (const [key, entry] of managed.entries) {
    if (!entry.locked) continue;
    const previous = (before as unknown as Record<string, unknown>)[key];
    const next = (after as unknown as Record<string, unknown>)[key];
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
 * The project record as readers see it: a locked setting's override field is
 * removed, because a lock outranks a project's choice. The stored record is
 * untouched, so the override returns when the policy is removed.
 */
export function withoutLockedProjectOverrides<
  P extends Partial<Pick<ProjectConfig, ProjectOverrideField>>,
>(project: P, managed: ManagedAppSettings | null = installed): P {
  if (!managed) return project;
  let masked: P | undefined;
  for (const [key, field] of Object.entries(PROJECT_OVERRIDE_FIELD_ALIASES)) {
    if (!lockedManagedSetting(key, managed)) continue;
    if ((project as Record<string, unknown>)[field] === undefined) continue;
    masked ??= { ...project };
    delete (masked as Record<string, unknown>)[field];
  }
  return masked ?? project;
}

type ProjectOverrideField =
  (typeof PROJECT_OVERRIDE_FIELD_ALIASES)[ProjectOverridableAppSettingKey];

/**
 * Refuse a project write that would change a locked setting's override
 * field. Compared with the stored record (`existing`, absent on create), so
 * resending the stored value passes; setting, changing or dropping it is
 * refused, as for this Station's own file. Reads hide the field instead
 * (see {@link withoutLockedProjectOverrides}).
 */
export function assertProjectOverridesUnlocked(
  updates: Record<string, unknown>,
  existing: Record<string, unknown> = {},
  managed: ManagedAppSettings | null = installed,
): void {
  if (!managed) return;
  for (const [key, field] of Object.entries(PROJECT_OVERRIDE_FIELD_ALIASES)) {
    if (!lockedManagedSetting(key, managed)) continue;
    if (!Object.hasOwn(updates, field)) continue;
    // `null` drops an override, which is a change only when one is stored.
    if (isDeepStrictEqual(updates[field] ?? undefined, existing[field]))
      continue;
    throw new ManagedSettingLockedError(key, managed.summary);
  }
}

/**
 * Startup check for what the contract parser cannot see: a composite
 * value's structure (and the cross-field rules `validateAppConfig` applies)
 * lives in the settings file schema, which belongs to the server. Every
 * managed value is run through the same validator a stored config passes
 * on load, on top of the seed's required fields so only managed values can
 * fail it. A failure refuses startup with the policy marker.
 */
export function assertManagedSettingsValid(
  loaded: LoadedManagedPolicy | null,
  validateAppConfig: (config: unknown) => void,
  seed: Record<string, unknown>,
): void {
  const managed = managedAppSettingsOf(loaded);
  if (!loaded || !managed) return;
  const probe: Record<string, unknown> = { ...seed };
  for (const [key, entry] of managed.entries) probe[key] = entry.value;
  try {
    validateAppConfig(probe);
  } catch (error) {
    throw new ManagedPolicyInvalidError(
      loaded.source.location,
      `a managed setting does not match the settings schema (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

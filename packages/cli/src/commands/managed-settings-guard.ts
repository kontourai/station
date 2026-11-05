import { isDeepStrictEqual } from 'node:util';
import { hasAppConfigStationDecision } from '@kontourai/station-contracts/config';
import { managedPolicyDenial } from '@kontourai/station-contracts/managed-policy';
import {
  type LoadedManagedPolicy,
  ManagedPolicyInvalidError,
} from '@kontourai/station-shared/managed-policy';
import { loadInstalledManagedPolicyChecked } from './app-config-schema.js';

/**
 * #4517: the CLI commands that write `config/app.json` directly
 * (`config set --offline`, `registry <url>`, `import`) bypass the server, so
 * they apply the managed policy's locks themselves, from the same installed
 * policy the server loads at startup.
 *
 * Returns `updates` without the locked keys whose value already is the
 * locked one: nothing needs writing for them, and a policy value must never
 * go into the user's file. Throws the sentence every surface uses for any
 * other write to a locked key, and refuses outright when the installed
 * policy cannot be used, because what it locks cannot be known.
 */
/** The installed policy, or a refusal naming what could not be done. */
function loadPolicyOffline(
  load: () => LoadedManagedPolicy | null,
  refusal: string,
): LoadedManagedPolicy | null {
  try {
    return load();
  } catch (error) {
    if (error instanceof ManagedPolicyInvalidError)
      throw new Error(`${error.message} ${refusal}`);
    throw error;
  }
}

export function withoutManagedNoOpsOffline<T extends Record<string, unknown>>(
  updates: T,
  load: () => LoadedManagedPolicy | null = loadInstalledManagedPolicyChecked,
): T {
  const loaded = loadPolicyOffline(
    load,
    'Settings cannot be changed offline until it is fixed.',
  );
  const settings = loaded?.document.settings;
  if (!loaded || !settings) return updates;
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(updates)) {
    const entry = Object.hasOwn(settings, key) ? settings[key] : undefined;
    if (!entry?.locked) {
      kept[key] = value;
      continue;
    }
    if (isDeepStrictEqual(value, entry.value)) continue;
    throw new Error(managedPolicyDenial(loaded.summary, 'this setting'));
  }
  return kept as T;
}

/**
 * #4517: what an offline reader of `config/app.json` acts on (`config get
 * --offline`, the `station registry` catalog read): the stored file with the
 * installed policy's locks in place and its defaults filling keys the file
 * leaves unset. The file is not changed.
 *
 * Unlike the server overlay, a default is not checked against environment
 * variables: these readers never read one for a setting. An installed policy
 * that cannot be used is refused, as the server refuses to start with it.
 */
export function effectiveAppConfigOffline<T extends Record<string, unknown>>(
  stored: T,
  load: () => LoadedManagedPolicy | null = loadInstalledManagedPolicyChecked,
): T {
  const settings = loadPolicyOffline(
    load,
    'Station settings cannot be read offline until it is fixed.',
  )?.document.settings;
  if (!settings) return stored;
  const effective: Record<string, unknown> = { ...stored };
  // The server's own predicate: an explicit `null` is a decision and a
  // loader-written seed is not (#4517 round 2).
  for (const [key, entry] of Object.entries(settings))
    if (entry.locked || !hasAppConfigStationDecision(stored, key))
      effective[key] = structuredClone(entry.value);
  return effective as T;
}

/** The installed policy's lock on `key`, if it has one. */
export function lockedSettingOffline(
  key: string,
  load: () => LoadedManagedPolicy | null = loadInstalledManagedPolicyChecked,
): { value: unknown } | undefined {
  const settings = loadPolicyOffline(
    load,
    'Station settings cannot be read offline until it is fixed.',
  )?.document.settings;
  const entry =
    settings && Object.hasOwn(settings, key) ? settings[key] : undefined;
  return entry?.locked ? { value: entry.value } : undefined;
}

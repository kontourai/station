import { isDeepStrictEqual } from 'node:util';
import { managedPolicyDenial } from '@kontourai/station-contracts/managed-policy';
import {
  type LoadedManagedPolicy,
  loadInstalledManagedPolicy,
  ManagedPolicyInvalidError,
} from '@kontourai/station-shared/managed-policy';

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
export function withoutManagedNoOpsOffline<T extends Record<string, unknown>>(
  updates: T,
  load: () => LoadedManagedPolicy | null = loadInstalledManagedPolicy,
): T {
  let loaded: LoadedManagedPolicy | null;
  try {
    loaded = load();
  } catch (error) {
    if (error instanceof ManagedPolicyInvalidError)
      throw new Error(
        `${error.message} Settings cannot be changed offline until it is fixed.`,
      );
    throw error;
  }
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

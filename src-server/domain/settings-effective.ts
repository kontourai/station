/**
 * Epic #2144 slice 2 — the server-side answer to "what value is actually in
 * effect for this setting, and who decided it?"
 *
 * Separate from `buildAppConfigProvenance` on purpose. Provenance answers the
 * question for EVERY key at once, for a whole `GET /config/app` response;
 * this answers it for ONE key and returns the value alongside the source, so
 * a caller deciding what to DO with a setting gets both from one place
 * instead of reading the value from one structure and its origin from
 * another.
 *
 * It deliberately reuses `isStoredValue` and the registry's own
 * `acceptsSettingValue` rather than re-deriving "absent" or "the environment
 * counts here". A second definition of absent is how a surface ends up
 * naming a source for a value no resolver uses (archive#1557).
 *
 * No UI consumer yet — slice 3 renders the badges.
 */

import type { AppConfig } from '@kontourai/station-contracts/config';
import type { ProjectSettingsOverrides } from '@kontourai/station-contracts/project-settings-overrides';
import {
  APP_SETTINGS_REGISTRY,
  acceptsSettingValue,
} from '@kontourai/station-contracts/settings-registry';
import {
  isSeededAppConfigValue,
  SEEDED_APP_CONFIG_KEYS,
} from './app-config-seed.js';
import { isStoredValue } from './settings-registry-server.js';

/**
 * Who decided the value.
 *
 * `'station'` rather than `'file'`: the provenance vocabulary names the KIND
 * of origin and needs a separate `scope` to say which document, while this
 * resolver is answering about one key in one place and can name the decider
 * directly. `'default'` covers both the registry default and a loader-written
 * seed — a factory value nobody chose.
 */
export type EffectiveSettingSource = 'default' | 'station' | 'project' | 'env';

export interface EffectiveAppSetting {
  value: unknown;
  source: EffectiveSettingSource;
  /** Which env var supplied it, for `source: 'env'` only. */
  envVar?: string;
}

const SEEDED_KEY_SET: ReadonlySet<string> = new Set(SEEDED_APP_CONFIG_KEYS);

const REGISTRY_BY_KEY = new Map(
  APP_SETTINGS_REGISTRY.map((definition) => [
    definition.key as string,
    definition,
  ]),
);

/**
 * Resolves one registered setting through the full chain:
 * project override -> this Station's stored config -> a declared
 * `envFallback` the field's own validator accepts -> the registry default.
 *
 * Returns `undefined` for a key that is not registered — there is no honest
 * answer for a key with no declaration, and inventing `{ value: undefined,
 * source: 'default' }` would report a default that does not exist.
 *
 * A stored value byte-equal to its loader-written seed resolves as
 * `'default'`, matching `buildAppConfigProvenance`: `config/app.json` keeps
 * no record that the loader wrote it, and calling it a Station decision makes
 * a reset list values the operator never set.
 */
export function resolveEffectiveAppSetting(
  key: string,
  input: {
    config: AppConfig;
    projectOverrides?: ProjectSettingsOverrides;
  },
): EffectiveAppSetting | undefined {
  const definition = REGISTRY_BY_KEY.get(key);
  if (!definition) return undefined;

  const override = (input.projectOverrides as Record<string, unknown>)?.[key];
  if (isStoredValue(override)) {
    return { value: override, source: 'project' };
  }

  const stored = (input.config as Record<string, unknown>)[key];
  if (isStoredValue(stored)) {
    return SEEDED_KEY_SET.has(key) &&
      isSeededAppConfigValue(
        key as (typeof SEEDED_APP_CONFIG_KEYS)[number],
        stored,
      )
      ? { value: stored, source: 'default' }
      : { value: stored, source: 'station' };
  }

  const envFallback = definition.envFallback;
  if (envFallback) {
    const raw = process.env[envFallback];
    // Same two-part test the provenance builder applies: set, and ACCEPTED
    // by this field's validator. Naming the environment for a value the
    // resolver discards as malformed is the claim-without-a-derivation this
    // whole seam exists to prevent.
    if (isStoredValue(raw) && acceptsSettingValue(definition, raw!.trim())) {
      return { value: raw!.trim(), source: 'env', envVar: envFallback };
    }
  }

  return { value: definition.defaultValue, source: 'default' };
}

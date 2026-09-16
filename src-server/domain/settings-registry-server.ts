/**
 * Server-side application of the settings registry
 * (`packages/contracts/src/settings-registry.ts`): re-exports the typed
 * sanitizer that `PUT /config/app` runs updates through, and builds the
 * provenance map that `GET /config/app` uses to tell a client where each
 * value came from.
 *
 * Station#settings-revamp slice 1 — see
 * `docs/design/settings-architecture.md` §4. `sanitizeAppConfigUpdate`
 * itself moved to `@kontourai/station-contracts/settings-registry` in
 * slice 6 (§6, closing archive#175): it had no genuine server-only dependency, and
 * living in `packages/contracts` lets `station config set`'s `--offline`
 * path (`packages/cli/src/commands/config.ts`) run the exact same
 * validation instead of forking a second copy. Re-exported here unchanged
 * so this module's existing importers (the route, its tests) don't need to
 * change.
 */

import type { AppConfig } from '@kontourai/station-contracts/config';
import type { ProjectSettingsOverrides } from '@kontourai/station-contracts/project-settings-overrides';
import {
  APP_SETTINGS_REGISTRY,
  acceptsSettingValue,
  type SettingProvenanceEntry,
  type SettingProvenanceSource,
} from '@kontourai/station-contracts/settings-registry';
import {
  isSeededAppConfigValue,
  SEEDED_APP_CONFIG_KEYS,
} from './app-config-seed.js';

export {
  type SanitizeAppConfigUpdateResult,
  sanitizeAppConfigUpdate,
} from '@kontourai/station-contracts/settings-registry';

// `SettingProvenanceSource`/`SettingProvenanceEntry` moved to
// `@kontourai/station-contracts/settings-registry` in slice 3 so the SDK and
// UI can share them without depending on server-side domain code — re-export
// here so existing server-side importers of this module don't need to
// change.
export type { SettingProvenanceEntry, SettingProvenanceSource };

/**
 * Whether a value is a DECISION rather than the absence of one.
 *
 * archive#1557 review fix (M4): the resolvers trim and treat a whitespace-only
 * string as absent. Provenance used a bare truthiness test, so `AWS_REGION="  "`
 * made Settings report "Set by operator: AWS_REGION" for a value the resolver
 * discards — the surface re-deriving "absent" for itself, which is the entire
 * thing the shared resolver exists to stop.
 *
 * Exported for `settings-effective.ts` (#2144 slice 2). An effective-value
 * resolver and a provenance builder that disagreed about what "absent" means
 * would report a source for a value the other one discards, which is the
 * defect this predicate was written to fix in the first place.
 */
export function isStoredValue(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

const SEEDED_KEY_SET: ReadonlySet<string> = new Set(SEEDED_APP_CONFIG_KEYS);

function isSeededKey(
  key: string,
): key is (typeof SEEDED_APP_CONFIG_KEYS)[number] {
  return SEEDED_KEY_SET.has(key);
}

/**
 * Builds per-field provenance for `GET /config/app`: `'file'` for every key
 * carrying a stored VALUE in the loaded config (see {@link isStoredValue} —
 * a whitespace-only string is the absence of a decision, not one), `'env'` for keys the route injected at read
 * time (`opts.injected` maps the injected key to the env var that produced
 * it, e.g. `mcpUiFrameOrigin` → `MCP_UI_FRAME_PORT`), and `'default'` for
 * every registered key that is absent from the loaded config AND declares a
 * `defaultValue` (docs/design/settings-architecture.md §4 promises
 * `default | file | env`). A registered key with no `defaultValue` and no
 * file/env source simply has no provenance entry — there is nothing honest
 * to report.
 *
 * One exception to "stored means `'file'`": the loader SEEDS several keys
 * into `config/app.json` itself (`app-config-seed.ts`), and the file keeps
 * no record that it did. A loaded value byte-equal to its seed is reported
 * as `'default'` — it is the factory value written for the operator, not a
 * decision — which is what lets a reset reach "nothing is stored" instead of
 * naming the same re-seeded keys on every read.
 *
 * archive#1557: provenance now reports where the value ACTUALLY comes from
 * rather than which env vars happen to be set. A stored value is `'file'`
 * whatever the environment says, because the resolvers read the stored value
 * first; a registered key that is absent from the config and declares an
 * `envFallback` that is set reports `'env'` naming that var, because the var
 * is then what the resolver returns. The old `envOverrideActive` flag said
 * the opposite of both — that a set env var made the stored value inert —
 * and the UI disabled the control on it.
 */
export function buildAppConfigProvenance(
  config: AppConfig,
  opts: {
    injected: Record<string, string>;
    /**
     * The overrides a PROJECT carries, when the caller named one
     * (`GET /config/app?project=<slug>`). Absent means no project was named,
     * and the output is byte-identical to what it was before #2144 slice 2 —
     * no `scope` field anywhere. A read that was not asked about a project
     * has no project to attribute a value to, and stamping every file entry
     * `scope: 'station'` regardless would be a claim the caller never asked
     * for and cannot act on.
     */
    projectOverrides?: ProjectSettingsOverrides;
  },
): Record<string, SettingProvenanceEntry> {
  const provenance: Record<string, SettingProvenanceEntry> = {};
  const projectOverrides = opts.projectOverrides;

  for (const key of Object.keys(config)) {
    const value = config[key as keyof AppConfig];
    if (!isStoredValue(value)) continue;
    // A value the LOADER wrote is not a decision the operator made, and
    // `config/app.json` records no difference between the two — see
    // `app-config-seed.ts`. Reporting the seed as `'file'` made "Reset
    // Station settings" list the seeded prompt and variables among the
    // values it would clear, clear them, and find them re-seeded (and listed
    // again) on the very next read.
    if (isSeededKey(key) && isSeededAppConfigValue(key, value)) {
      provenance[key] = { source: 'default' };
      continue;
    }
    provenance[key] = projectOverrides
      ? { source: 'file', scope: 'station' }
      : { source: 'file' };
  }

  for (const [key, envVar] of Object.entries(opts.injected)) {
    provenance[key] = { source: 'env', envVar };
  }

  for (const definition of APP_SETTINGS_REGISTRY) {
    const key = definition.key as string;
    if (key in provenance) continue;
    const envFallback = definition.envFallback;
    const envValue = process.env[envFallback ?? ''];
    // Naming the environment as the source is a claim that the environment's
    // value is what applies. It only is when the field's own validator would
    // accept it — `AWS_REGION=US-EAST-1` is discarded by the Bedrock resolver
    // as malformed, and a badge reading "Set by operator: AWS_REGION" over a
    // value nothing uses is this cluster's whole defect, reproduced live
    // during the round-2 boot check (archive#1557).
    if (
      envFallback &&
      isStoredValue(envValue) &&
      acceptsSettingValue(definition, (envValue as string).trim())
    ) {
      provenance[key] = { source: 'env', envVar: envFallback };
      continue;
    }
    if (definition.defaultValue === undefined) continue;
    provenance[key] = { source: 'default' };
  }

  // The project record is the innermost stored document, so it supersedes
  // whatever the Station file, the environment, or a registry default would
  // have reported. Placed last for that reason, and unconditional on what
  // came before: `readProjectOverrides` has already dropped absent and blank
  // fields, so anything still here is a decision someone made.
  //
  // None of `PROJECT_OVERRIDABLE_APP_SETTING_KEYS` declares an `envFallback`
  // today, so this never silently reverses an env-sourced value; the
  // registry test in `packages/contracts` pins that, because the day one
  // does, this precedence needs deciding rather than inheriting.
  for (const key of Object.keys(projectOverrides ?? {})) {
    provenance[key] = { source: 'file', scope: 'project' };
  }

  return provenance;
}

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
import {
  APP_SETTINGS_REGISTRY,
  acceptsSettingValue,
  type SettingProvenanceEntry,
  type SettingProvenanceSource,
} from '@kontourai/station-contracts/settings-registry';

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
 */
function isStoredValue(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
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
  opts: { injected: Record<string, string> },
): Record<string, SettingProvenanceEntry> {
  const provenance: Record<string, SettingProvenanceEntry> = {};

  for (const key of Object.keys(config)) {
    if (!isStoredValue(config[key as keyof AppConfig])) continue;
    provenance[key] = { source: 'file' };
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

  return provenance;
}

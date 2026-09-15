import type { AppConfig } from './config.js';
import type { ProjectConfig } from './project.js';

/**
 * Epic #2144 slice 2 — which Station settings a PROJECT is allowed to
 * override, and how the project record spells each one.
 *
 * Three keys on day one (owner decision). The list is deliberately a closed
 * `as const` rather than "every key the project record happens to carry": a
 * project record has fields that were never settings (`agents`, `topK`,
 * `knowledgeNamespaces`), and a settings surface that derived the overridable
 * set from the record's shape would present them as Station settings the
 * moment someone added one.
 *
 * Domain shapes only — no reads, no I/O. The server resolves effective values
 * in `src-server/domain/settings-effective.ts`; the route that reports
 * per-field provenance is `GET /config/app?project=<slug>`.
 */
export const PROJECT_OVERRIDABLE_APP_SETTING_KEYS = [
  'defaultModel',
  'defaultLLMProvider',
  'defaultWorkspaceIsolation',
] as const;

export type ProjectOverridableAppSettingKey =
  (typeof PROJECT_OVERRIDABLE_APP_SETTING_KEYS)[number];

/**
 * The overrides a project may carry, typed FROM `AppConfig` rather than from
 * the project record. That direction is the point: an override is a value for
 * a Station setting, so its type has to be the setting's type. If
 * `AppConfig.defaultWorkspaceIsolation` ever widens, this widens with it
 * instead of drifting into a second, looser definition of the same field.
 */
export type ProjectSettingsOverrides = Partial<
  Pick<AppConfig, ProjectOverridableAppSettingKey>
>;

/**
 * Compile-time completeness check, in both directions: every key in the list
 * is an `AppConfig` key (so `Pick` above cannot silently produce `never`),
 * and every key of `ProjectSettingsOverrides` is in the list. Keep this —
 * it is the drift guard, not dead code.
 */
const _assertOverridableKeysAreAppConfigKeys =
  PROJECT_OVERRIDABLE_APP_SETTING_KEYS satisfies readonly (keyof AppConfig)[];
void _assertOverridableKeysAreAppConfigKeys;

type KeysMatch<A extends string, B extends string> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false;

const _assertOverridesCoverTheList: KeysMatch<
  keyof ProjectSettingsOverrides,
  ProjectOverridableAppSettingKey
> = true;
void _assertOverridesCoverTheList;

/**
 * The project-record field each overridable setting is stored under.
 *
 * `defaultLLMProvider` is the one that differs: the Station setting has been
 * `defaultLLMProvider` since before projects carried a model connection at
 * all, and the project record spells the same thing `defaultProviderId`
 * (`ProjectConfig`, and `projectSchema` in
 * `src-server/domain/file-storage-schemas.ts`). Neither name is being
 * renamed here — a rename on either side is a stored-data migration, and this
 * slice is not that. The alias is the seam where the two names meet, declared
 * once so no caller re-derives it.
 *
 * The two names describe ONE setting at two scopes, not two settings that
 * happen to rhyme: `ProviderService.resolveProviderAndModel`
 * (`src-server/services/connections/provider-service.ts:283-320`) reads the
 * project's `defaultProviderId`/`defaultModel` pair first and
 * `AppConfig.defaultLLMProvider`/`AppConfig.defaultModel` as its own
 * fallback, in one resolver. (The Bedrock read at
 * `src-server/routes/connections/bedrock.ts` is a second consumer of the Station
 * value, not the only one — recorded here so the next reader does not repeat
 * the search that makes it look like two unrelated fields.)
 */
export const PROJECT_OVERRIDE_FIELD_ALIASES = {
  defaultModel: 'defaultModel',
  defaultLLMProvider: 'defaultProviderId',
  defaultWorkspaceIsolation: 'defaultWorkspaceIsolation',
} as const satisfies Record<
  ProjectOverridableAppSettingKey,
  keyof ProjectConfig
>;

/**
 * The model connection and the model it names are resolved TOGETHER or not at
 * all.
 *
 * `ProviderService.resolveProviderAndModel`
 * (`src-server/services/connections/provider-service.ts:283`) takes the
 * project branch only for `project?.defaultProviderId && project.defaultModel`
 * — a project carrying one without the other falls through to the Station
 * pair entire. So a half-pair is not a half-override; it is no override, and
 * reporting either half as `scope: 'project'` would name the project as the
 * source of a value the resolver never reads.
 *
 * `defaultWorkspaceIsolation` is deliberately NOT in this group: it resolves
 * on its own (`resolveWorkspaceIsolationMode`) and has nothing to be atomic
 * with.
 */
const ATOMIC_MODEL_PAIR = ['defaultModel', 'defaultLLMProvider'] as const;

/**
 * The overrides a project record actually carries, keyed by SETTING key.
 *
 * Absent and empty-string fields are both omitted: a project whose
 * `defaultProviderId` is `''` has not overridden anything, and reporting it
 * as an override would make a surface name the project as the source of a
 * value the resolvers discard. This mirrors `isStoredValue` in
 * `src-server/domain/settings-registry-server.ts` — the same "a decision, not
 * the absence of one" test provenance already applies to the Station file.
 *
 * The model pair is additionally all-or-nothing; see {@link ATOMIC_MODEL_PAIR}.
 */
export function readProjectOverrides(
  project: Pick<ProjectConfig, ProjectOverrideRecordField> | undefined,
): ProjectSettingsOverrides {
  const overrides: Record<string, unknown> = {};
  if (!project) return overrides;
  for (const key of PROJECT_OVERRIDABLE_APP_SETTING_KEYS) {
    const value = (project as Record<string, unknown>)[
      PROJECT_OVERRIDE_FIELD_ALIASES[key]
    ];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim().length === 0) continue;
    overrides[key] = value;
  }
  if (ATOMIC_MODEL_PAIR.some((key) => overrides[key] === undefined)) {
    for (const key of ATOMIC_MODEL_PAIR) delete overrides[key];
  }
  return overrides as ProjectSettingsOverrides;
}

/** The project-record fields `readProjectOverrides` reads, and nothing else. */
export type ProjectOverrideRecordField =
  (typeof PROJECT_OVERRIDE_FIELD_ALIASES)[ProjectOverridableAppSettingKey];

/**
 * The same fields as values, for the write path: `PUT /projects/:slug`
 * accepts `null` on each of these to mean "drop this override", and
 * `updateProject` deletes rather than stores it. Derived from the alias map
 * so the read side and the write side cannot come to name different fields.
 */
export const PROJECT_OVERRIDE_RECORD_FIELDS = Object.values(
  PROJECT_OVERRIDE_FIELD_ALIASES,
) as readonly ProjectOverrideRecordField[];

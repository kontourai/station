/**
 * Epic #2144 slice 3 — the project-override draft Settings holds beside its
 * Station draft, and the `PUT /api/projects/:slug` body it turns into.
 *
 * Separate from `SettingsView` because two rules live here that a render
 * function should not be re-deriving: the SETTING key a row edits is not the
 * field a project record stores it under
 * (`PROJECT_OVERRIDE_FIELD_ALIASES` — `defaultLLMProvider` is
 * `defaultProviderId` on the record), and the model pair is resolved together
 * or not at all, so a half-pair has to be written away rather than left
 * behind as an override no resolver reads.
 */

import type { ProjectConfig } from '@kontourai/station-contracts/project';
import {
  PROJECT_OVERRIDE_FIELD_ALIASES,
  type ProjectOverridableAppSettingKey,
  type ProjectOverrideRecordField,
  type ProjectSettingsOverrides,
  readProjectOverrides,
} from '@kontourai/station-contracts/project-settings-overrides';

/**
 * What the page has changed since it read the project, keyed by SETTING key.
 *
 * `null` is a real member, not an absence: it is "drop this override", which
 * is what "Reset to inherited" means and what the route's own `null` does.
 * A key absent from the draft has not been touched at all — the difference
 * between those two is the difference between resetting a setting and
 * leaving it alone, so they cannot share a spelling.
 */
export type ProjectOverrideDraft = Partial<
  Record<ProjectOverridableAppSettingKey, unknown>
>;

/** The model pair, which `readProjectOverrides` accepts only whole. */
const MODEL_PAIR = [
  'defaultModel',
  'defaultLLMProvider',
] as const satisfies readonly ProjectOverridableAppSettingKey[];

function isStoredOverride(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

/**
 * The override value a row should render: the draft's when the page has
 * touched the key, otherwise the project's stored one.
 *
 * `undefined` means "this project overrides nothing here", so the caller
 * falls back to the Station value — and a drafted `null` produces exactly
 * that, which is what makes a pending reset visible before it is saved.
 */
export function effectiveOverrideValue(
  key: ProjectOverridableAppSettingKey,
  draft: ProjectOverrideDraft,
  savedOverrides: ProjectSettingsOverrides,
): unknown {
  const drafted = Object.hasOwn(draft, key)
    ? draft[key]
    : (savedOverrides as Record<string, unknown>)[key];
  return drafted === null ? undefined : drafted;
}

/** The draft entries that differ from what the project already stores. */
export function projectOverrideDelta(
  draft: ProjectOverrideDraft,
  savedOverrides: ProjectSettingsOverrides,
): ProjectOverrideDraft {
  const delta: ProjectOverrideDraft = {};
  for (const [key, value] of Object.entries(draft) as [
    ProjectOverridableAppSettingKey,
    unknown,
  ][]) {
    const saved = (savedOverrides as Record<string, unknown>)[key];
    // Both "no stored override" spellings compare equal: a draft that says
    // `null` for a key the project never had is not a change, and treating it
    // as one would arm Save over a request that writes nothing.
    const normalizedSaved = isStoredOverride(saved) ? saved : null;
    const normalizedDraft = isStoredOverride(value) ? value : null;
    if (normalizedSaved !== normalizedDraft) delta[key] = value;
  }
  return delta;
}

/**
 * The `PUT /api/projects/:slug` body for a delta, keyed by RECORD field.
 *
 * Every value the caller did not supply becomes `null`, which the route
 * documents as "drop this override" — never omitted, because `JSON.stringify`
 * drops an `undefined` and an omitted field leaves the stored value in place,
 * turning a reset into a no-op (the same trap `buildProjectSavePayload`
 * records for the workspace picker).
 *
 * The model pair is enforced ON THE RESULT, not on the delta: a save that
 * leaves the project holding only one half has produced no override at all
 * (`readProjectOverrides`), so the other half is dropped too rather than
 * stored as a value nothing reads.
 */
export function buildProjectOverrideUpdate(
  delta: ProjectOverrideDraft,
  savedOverrides: ProjectSettingsOverrides,
): Partial<Record<ProjectOverrideRecordField, unknown>> {
  const resolved: Record<string, unknown> = { ...savedOverrides };
  for (const [key, value] of Object.entries(delta)) resolved[key] = value;

  const touched = new Set(Object.keys(delta));
  if (
    MODEL_PAIR.some((key) => touched.has(key)) &&
    MODEL_PAIR.some((key) => !isStoredOverride(resolved[key]))
  ) {
    for (const key of MODEL_PAIR) touched.add(key);
    for (const key of MODEL_PAIR) resolved[key] = null;
  }

  const update: Partial<Record<ProjectOverrideRecordField, unknown>> = {};
  for (const key of touched as Set<ProjectOverridableAppSettingKey>) {
    const value = resolved[key];
    update[PROJECT_OVERRIDE_FIELD_ALIASES[key]] = isStoredOverride(value)
      ? value
      : null;
  }
  return update;
}

/** The overrides a fetched project record carries, or none for no project. */
export function savedOverridesFor(
  project: ProjectConfig | undefined,
): ProjectSettingsOverrides {
  return readProjectOverrides(project);
}

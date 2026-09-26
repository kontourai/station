/**
 * Canonical skills / registry-skills fetchers (#167 Wave 1). Shared by the
 * SDK's `skills.ts` hooks (thin wrappers for the list/install operations
 * named in the audit), the CLI's `skills`/`registry skills` verbs, and
 * `station-control-catalog-tools.ts`'s `list_skills`/`list_registry_skills`/
 * `install_skill` tools.
 *
 * `fetchInstalledSkills` (`/api/skills`) and `fetchSystemSkills`
 * (`/api/system/skills`) are kept as two separate named fetchers, not
 * unified into one — this is the second of the two named route divergences
 * the #167 plan explicitly does not reconcile (see the plan's "Plan"
 * section and the audit's §3 Stop-short risks).
 */

import { apiErrorMessage } from './api-error-message';
import { type ClientRequestOptions, getJson, mutateJson } from './http';
export interface SkillsEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

/**
 * `GET /api/skills` — the CLI's `skills list` route
 * (`packages/cli/src/commands/core.ts`, `resourceSpecs.skills.collectionPath`).
 * No SDK hook calls this route today (the SDK's `useSkillsQuery` calls
 * `fetchSystemSkills` below instead) — added here for Wave 2A's CLI
 * migration.
 */
export async function fetchInstalledSkills(
  apiBase: string,
  opts?: ClientRequestOptions,
): Promise<unknown> {
  const response = await getJson(`${apiBase}/api/skills`, opts);
  const result = (await response.json()) as SkillsEnvelope<unknown>;
  if (!result.success) {
    throw new Error(
      apiErrorMessage(result, `Request failed with HTTP ${response.status}`),
    );
  }
  return result.data;
}

/**
 * `GET /api/system/skills` — used by the SDK's `useSkillsQuery` hook and by
 * station-control's `list_skills` tool.
 */
export async function fetchSystemSkills(
  apiBase: string,
  opts?: ClientRequestOptions,
): Promise<any[]> {
  const response = await getJson(`${apiBase}/api/system/skills`, opts);
  const result = (await response.json()) as SkillsEnvelope<any[]>;
  if (!result.success) {
    throw new Error(result.error);
  }
  return result.data ?? [];
}

/**
 * `GET /api/registry/skills` — used by the SDK's `useRegistrySkillsQuery`
 * hook, the CLI's `registry skills list` verb, and station-control's
 * `list_registry_skills` tool.
 */
export async function fetchRegistrySkills(
  apiBase: string,
  opts?: ClientRequestOptions,
): Promise<any[]> {
  const response = await getJson(`${apiBase}/api/registry/skills`, opts);
  const result = (await response.json()) as SkillsEnvelope<any[]>;
  if (!result.success) {
    throw new Error(result.error);
  }
  return result.data ?? [];
}

/**
 * `POST /api/registry/skills/install` — used by the SDK's
 * `useInstallSkillMutation` (which returns the *whole* envelope, not just
 * `.data` — preserved here), the CLI's `registry skills install` verb, and
 * station-control's `install_skill` tool.
 */
export async function installRegistrySkill(
  apiBase: string,
  id: string,
  opts?: ClientRequestOptions,
): Promise<SkillsEnvelope<unknown>> {
  const response = await mutateJson(
    `${apiBase}/api/registry/skills/install`,
    'POST',
    opts,
    { id },
  );
  const result = (await response.json()) as SkillsEnvelope<unknown>;
  if (!result.success) {
    throw new Error(result.message || 'Install failed');
  }
  return result;
}

/**
 * Counters a skill's usage carries — the same shape the server's `SkillStats`
 * declares, so one formatter reads both.
 */
export interface SkillUsageStats {
  runs: number;
  successes: number;
  failures: number;
  qualityScore: number | null;
  lastRunAt?: string;
  lastOutcomeAt?: string;
}

export interface SkillUsageResult {
  name: string;
  stats: SkillUsageStats;
}

export interface SkillImportFile {
  filename: string;
  content: string;
}

export interface SkillImportResultRow {
  filename: string;
  success: boolean;
  name?: string;
  error?: string;
}

export interface SkillImportResult {
  imported: number;
  results: SkillImportResultRow[];
}

/**
 * `GET /api/skills/:nameOrLegacyId` — one skill's full record, INCLUDING its
 * body. The listing deliberately omits bodies, so every consumer that needs the
 * text (the editor, and the slash handler expanding a `/command`) reads it
 * here, through one fetcher rather than one inline fetch each.
 */
export async function fetchSkillDetail(
  apiBase: string,
  nameOrLegacyId: string,
  opts?: ClientRequestOptions,
): Promise<any> {
  const response = await getJson(
    `${apiBase}${skillPath(nameOrLegacyId)}`,
    opts,
  );
  const result = (await response.json()) as SkillsEnvelope<any>;
  if (!result.success) {
    throw new Error(apiErrorMessage(result, 'Failed to load skill'));
  }
  return result.data;
}

function skillPath(nameOrLegacyId: string, action?: 'run' | 'outcome'): string {
  const encoded = encodeURIComponent(nameOrLegacyId);
  return action ? `/api/skills/${encoded}/${action}` : `/api/skills/${encoded}`;
}

/** `POST /api/skills/:name/run` — count one use of a skill. */
export async function trackSkillRun(
  apiBase: string,
  nameOrLegacyId: string,
  opts?: ClientRequestOptions,
): Promise<SkillUsageResult> {
  const response = await mutateJson(
    `${apiBase}${skillPath(nameOrLegacyId, 'run')}`,
    'POST',
    opts,
  );
  const result = (await response.json()) as SkillsEnvelope<SkillUsageResult>;
  if (!result.success || !result.data) {
    throw new Error(
      apiErrorMessage(result, `Request failed with HTTP ${response.status}`),
    );
  }
  return result.data;
}

/** `POST /api/skills/:name/outcome` — record how a skill's run turned out. */
export async function recordSkillOutcome(
  apiBase: string,
  nameOrLegacyId: string,
  outcome: 'success' | 'failure',
  opts?: ClientRequestOptions,
): Promise<SkillUsageResult> {
  const response = await mutateJson(
    `${apiBase}${skillPath(nameOrLegacyId, 'outcome')}`,
    'POST',
    opts,
    { outcome },
  );
  const result = (await response.json()) as SkillsEnvelope<SkillUsageResult>;
  if (!result.success || !result.data) {
    throw new Error(
      apiErrorMessage(result, `Request failed with HTTP ${response.status}`),
    );
  }
  return result.data;
}

/**
 * `POST /api/skills/import` — import markdown files as local skills in ONE
 * request. The per-file rows come back whether or not every file landed, so a
 * partial import is visible rather than being N independent unreported POSTs.
 */
export async function importSkills(
  apiBase: string,
  files: SkillImportFile[],
  opts?: ClientRequestOptions,
): Promise<SkillImportResult> {
  const response = await mutateJson(
    `${apiBase}/api/skills/import`,
    'POST',
    opts,
    { files },
  );
  const result = (await response.json()) as SkillsEnvelope<SkillImportResult>;
  if (!result.success || !result.data) {
    throw new Error(
      apiErrorMessage(result, `Request failed with HTTP ${response.status}`),
    );
  }
  return result.data;
}

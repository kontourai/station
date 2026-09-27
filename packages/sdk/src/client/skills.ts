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

import type {
  SkillCommand,
  SkillVariable,
} from '@kontourai/station-contracts/catalog';
import { envelopeError } from './api-error-message';
import { type ClientRequestOptions, getJson, mutateJson } from './http';
export interface SkillsEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

/**
 * The parsed envelope. A failure whose body is not JSON (a proxy's HTML 502)
 * still throws the envelope helper's `StationHttpError` with the status it
 * arrived under (#2708); an unreadable 2xx is a protocol failure and rethrows
 * the parse error, as it always did.
 */
async function readSkillsEnvelope<T>(
  response: Response,
): Promise<SkillsEnvelope<T>> {
  try {
    return (await response.json()) as SkillsEnvelope<T>;
  } catch (error) {
    if (!response.ok) {
      throw envelopeError(
        response,
        undefined,
        `Request failed with HTTP ${response.status}`,
      );
    }
    throw error;
  }
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
  const result = await readSkillsEnvelope<unknown>(response);
  if (!result.success) {
    throw envelopeError(
      response,
      result,
      `Request failed with HTTP ${response.status}`,
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
  const result = await readSkillsEnvelope<any[]>(response);
  if (!result.success) {
    throw envelopeError(
      response,
      result,
      `Request failed with HTTP ${response.status}`,
    );
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
  const result = await readSkillsEnvelope<any[]>(response);
  if (!result.success) {
    throw envelopeError(
      response,
      result,
      `Request failed with HTTP ${response.status}`,
    );
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
  const result = await readSkillsEnvelope<unknown>(response);
  if (!result.success) {
    throw envelopeError(response, result, 'Install failed');
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
  const result = await readSkillsEnvelope<any>(response);
  if (!result.success) {
    throw envelopeError(response, result, 'Failed to load skill');
  }
  return result.data;
}

/** The fields a local skill is written with (`localSkillSchema`). */
export interface LocalSkillInput {
  name: string;
  body: string;
  description?: string;
  category?: string;
  tags?: string[];
  agent?: string;
  global?: boolean;
  command?: SkillCommand;
  variables?: SkillVariable[];
}

/** A partial rewrite of a local skill (`localSkillUpdateSchema`). */
export type LocalSkillUpdate = Partial<Omit<LocalSkillInput, 'name'>>;

/**
 * `POST /api/skills/local` — write a new local skill. Returns the whole
 * envelope, as `useCreateLocalSkillMutation` always has. A refusal throws the
 * envelope helper's `StationHttpError` (#2708), so the editor can show the
 * server's validation reason from its `details`.
 */
export async function createLocalSkill(
  apiBase: string,
  input: LocalSkillInput,
  opts?: ClientRequestOptions,
): Promise<SkillsEnvelope<unknown>> {
  const response = await mutateJson(
    `${apiBase}/api/skills/local`,
    'POST',
    opts,
    input,
  );
  const result = await readSkillsEnvelope<unknown>(response);
  if (!result.success) {
    throw envelopeError(response, result, 'Create failed');
  }
  return result;
}

/** `PUT /api/skills/:name` — rewrite a local skill; the envelope, as above. */
export async function updateLocalSkill(
  apiBase: string,
  name: string,
  updates: LocalSkillUpdate,
  opts?: ClientRequestOptions,
): Promise<SkillsEnvelope<unknown>> {
  const response = await mutateJson(
    `${apiBase}${skillPath(name)}`,
    'PUT',
    opts,
    updates,
  );
  const result = await readSkillsEnvelope<unknown>(response);
  if (!result.success) {
    throw envelopeError(response, result, 'Update failed');
  }
  return result;
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
  const result = await readSkillsEnvelope<SkillUsageResult>(response);
  if (!result.success || !result.data) {
    throw envelopeError(
      response,
      result,
      `Request failed with HTTP ${response.status}`,
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
  const result = await readSkillsEnvelope<SkillUsageResult>(response);
  if (!result.success || !result.data) {
    throw envelopeError(
      response,
      result,
      `Request failed with HTTP ${response.status}`,
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
  const result = await readSkillsEnvelope<SkillImportResult>(response);
  if (!result.success || !result.data) {
    throw envelopeError(
      response,
      result,
      `Request failed with HTTP ${response.status}`,
    );
  }
  return result.data;
}

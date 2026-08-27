/**
 * Console `OperatingState` fetch + board-intent execution (roadmap #586,
 * part of epic #580, S6). `OperatingState` is re-exported directly from
 * `@kontourai/console-core` (the same published type the server-side
 * `OperatingStateService` derives and `@kontourai/console-ui`'s `BoardView`
 * consumes) rather than a second drifting shape on the SDK surface — the
 * same discipline `workItems.ts` uses for its provider VM types.
 */
import type { OperatingState } from '@kontourai/console-core';
import { useMutation } from '@tanstack/react-query';
import { _getApiBase } from '../api';
import { apiErrorMessage } from '../api-core';
import { authenticatedFetch } from '../client/http';
import { type QueryConfig, useApiQuery } from '../query-core';

export type { OperatingState };

interface ApiResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

async function readApiResult<T>(response: Response): Promise<T> {
  const result = (await response.json()) as ApiResult<T>;
  if (!response.ok || !result.success || result.data === undefined) {
    throw new Error(apiErrorMessage(result, `HTTP ${response.status}`));
  }
  return result.data;
}

export async function fetchOperatingState(
  projectSlug: string,
): Promise<OperatingState> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(
    `${apiBase}/api/projects/${encodeURIComponent(projectSlug)}/operating-state`,
  );
  return readApiResult<OperatingState>(response);
}

export function useOperatingStateQuery(
  projectSlug: string | null | undefined,
  config?: QueryConfig<OperatingState>,
) {
  return useApiQuery<OperatingState>(
    ['operating-state', projectSlug ?? ''],
    () => fetchOperatingState(projectSlug!),
    {
      ...config,
      enabled: !!projectSlug && (config?.enabled ?? true),
      staleTime: config?.staleTime ?? 10_000,
      refetchInterval: config?.refetchInterval ?? 15_000,
    },
  );
}

export interface BoardAvailability {
  hasBuilderRun: boolean;
}

export async function fetchBoardAvailability(
  projectSlug: string,
): Promise<BoardAvailability> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(
    `${apiBase}/api/projects/${encodeURIComponent(projectSlug)}/operating-state/availability`,
  );
  return readApiResult<BoardAvailability>(response);
}

export function useBoardAvailabilityQuery(
  projectSlug: string | null | undefined,
  config?: QueryConfig<BoardAvailability>,
) {
  return useApiQuery<BoardAvailability>(
    ['board-availability', projectSlug ?? 'none'],
    () => fetchBoardAvailability(projectSlug as string),
    { ...config, enabled: Boolean(projectSlug) && (config?.enabled ?? true) },
  );
}

// ── Board intent execution (the S5 descriptor-resolution seam, wired from
// the board's onIntent in S6) ──────────────────────────────────────────

export interface ConsoleBoardIntentSubjectRef {
  product?: string;
  kind?: string;
  id?: string;
  label?: string;
  name?: string;
}

/** Structural mirror of `@kontourai/console-ui`'s `ConsoleIntent` — the SDK
 * does not depend on console-ui (a UI-layer package), so this is the
 * minimal shape the server-side resolver actually reads. */
export interface ConsoleBoardIntentInput {
  id: string;
  kind: string;
  label?: string;
  readOnly?: boolean;
  authority?: { product?: string; command?: string };
  subjectRefs?: ConsoleBoardIntentSubjectRef[];
}

export interface ConsoleBoardIntentResult {
  bound: boolean;
  executed: boolean;
  reason?: string;
}

export async function postBoardIntent(input: {
  projectSlug: string;
  intent: ConsoleBoardIntentInput;
  /** Strict consent flag — the server only ever executes a confirmation-
   * requiring binding when this is the literal boolean `true`. */
  consent?: boolean;
}): Promise<ConsoleBoardIntentResult> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(
    `${apiBase}/api/projects/${encodeURIComponent(input.projectSlug)}/operating-state/intent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent: input.intent, consent: input.consent }),
    },
  );
  return readApiResult<ConsoleBoardIntentResult>(response);
}

export function useConsoleBoardIntentMutation() {
  return useMutation({ mutationFn: postBoardIntent });
}

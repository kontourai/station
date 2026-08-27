import type {
  ContinueSessionStarterLaunchInput,
  ContinueSessionStarterLaunchResult,
  ScheduledCheckStarterLaunchInput,
  ScheduledCheckStarterLaunchResult,
  StarterInspectionCandidate,
  StarterInspectionId,
  StarterInspectionLaunchInput,
  StarterInspectionLaunchResult,
  StarterWorkBindInput,
  StarterWorkBindOutcome,
  StarterWorkCatalogEntry,
  StarterWorkObservation,
  StarterWorkStatus,
  StartTaskStarterLaunchInput,
  StartTaskStarterLaunchResult,
} from '@kontourai/station-contracts/starter-work';
import { apiErrorMessage } from './client/api-error-message';
import { authenticatedFetch } from './client/http';
import {
  type QueryConfig,
  resolveApiBase,
  useApiMutation,
  useApiQuery,
} from './query-core';
import {
  AdoptSessionError,
  isProvablyNotSent,
} from './query-domains/chatRuntimeOrchestration';

type ApiResult<T> = {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
  details?: { formErrors?: unknown; fieldErrors?: unknown };
};

export class ScheduledCheckStarterResponseError extends Error {
  readonly retryable = true;
  readonly cause?: unknown;
  constructor(
    readonly operationId: string,
    cause?: unknown,
  ) {
    super(
      'Station may have admitted the scheduled check, but its exact receipt could not be read. Retry only with the same operation identity.',
    );
    this.name = 'ScheduledCheckStarterResponseError';
    if (cause !== undefined) this.cause = cause;
  }
}
async function result<T>(response: Response): Promise<T> {
  const body = (await response.json()) as ApiResult<T>;
  if (!response.ok || !body.success || body.data === undefined)
    throw new Error(apiErrorMessage(body, `HTTP ${response.status}`));
  return body.data;
}

export async function listStarterWork(
  apiBase?: string,
): Promise<StarterWorkCatalogEntry[]> {
  return result(
    await authenticatedFetch(
      `${await resolveApiBase(apiBase)}/api/starter-work`,
    ),
  );
}
export async function getStarterWork(
  starterId: string,
  apiBase?: string,
): Promise<StarterWorkStatus> {
  return result(
    await authenticatedFetch(
      `${await resolveApiBase(apiBase)}/api/starter-work/${encodeURIComponent(starterId)}`,
    ),
  );
}
export function useStarterWorkQuery(
  starterId: string,
  config?: QueryConfig<StarterWorkStatus>,
) {
  return useApiQuery(
    ['starter-work', starterId],
    () => getStarterWork(starterId),
    {
      staleTime: config?.staleTime ?? 15_000,
      gcTime: config?.gcTime,
      enabled: config?.enabled ?? starterId.length > 0,
    },
  );
}
export async function getStarterInspectionCandidate(
  starterId: StarterInspectionId,
  apiBase?: string,
): Promise<StarterInspectionCandidate> {
  return result(
    await authenticatedFetch(
      `${await resolveApiBase(apiBase)}/api/starter-work/${encodeURIComponent(starterId)}/candidate`,
    ),
  );
}
export function useStarterInspectionCandidateQuery(
  starterId: StarterInspectionId,
  config?: QueryConfig<StarterInspectionCandidate>,
) {
  return useApiQuery(
    ['starter-work', starterId, 'candidate'],
    () => getStarterInspectionCandidate(starterId),
    {
      staleTime: config?.staleTime ?? 5_000,
      gcTime: config?.gcTime,
      enabled: config?.enabled ?? true,
    },
  );
}
export async function bindStarterWork(
  input: StarterWorkBindInput & { apiBase?: string },
): Promise<StarterWorkBindOutcome> {
  const { apiBase, ...body } = input;
  return result<StarterWorkBindOutcome>(
    await authenticatedFetch(
      `${await resolveApiBase(apiBase)}/api/starter-work/bind`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    ),
  );
}
export async function launchStartTaskStarter(
  input: StartTaskStarterLaunchInput & { apiBase?: string },
): Promise<StartTaskStarterLaunchResult> {
  const { apiBase, ...body } = input;
  return result(
    await authenticatedFetch(
      `${await resolveApiBase(apiBase)}/api/starter-work/launch`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    ),
  );
}
export async function launchContinueSessionStarter(
  input: ContinueSessionStarterLaunchInput & { apiBase?: string },
): Promise<ContinueSessionStarterLaunchResult> {
  const { apiBase, ...body } = input;
  const response = await authenticatedFetch(
    `${await resolveApiBase(apiBase)}/api/starter-work/launch`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  let parsed: ApiResult<ContinueSessionStarterLaunchResult>;
  try {
    parsed = (await response.json()) as typeof parsed;
  } catch (error) {
    if (response.ok)
      throw new AdoptSessionError({
        failureClass: 'uncertain-no-response',
        message:
          'Station accepted the continuation request but its confirmation could not be read.',
        retryable: true,
        cause: error,
      });
    throw error;
  }
  if (!response.ok || !parsed.success)
    throw new Error(apiErrorMessage(parsed, `HTTP ${response.status}`));
  if (parsed.data === undefined)
    throw new AdoptSessionError({
      failureClass: 'uncertain-no-response',
      message:
        'Station accepted the continuation request without a readable outcome.',
      retryable: true,
    });
  return parsed.data;
}
export async function launchStarterInspection(
  input: StarterInspectionLaunchInput & { apiBase?: string },
): Promise<StarterInspectionLaunchResult> {
  const { apiBase, ...body } = input;
  return result(
    await authenticatedFetch(
      `${await resolveApiBase(apiBase)}/api/starter-work/launch`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    ),
  );
}
export async function launchScheduledCheckStarter(
  input: ScheduledCheckStarterLaunchInput & { apiBase?: string },
): Promise<ScheduledCheckStarterLaunchResult> {
  const { apiBase, ...body } = input;
  let response: Response;
  try {
    response = await authenticatedFetch(
      `${await resolveApiBase(apiBase)}/api/starter-work/launch`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
  } catch (error) {
    if (isProvablyNotSent(error)) throw error;
    throw new ScheduledCheckStarterResponseError(input.operationId, error);
  }
  let parsed: ApiResult<ScheduledCheckStarterLaunchResult>;
  try {
    parsed = (await response.json()) as typeof parsed;
  } catch (error) {
    if (response.ok)
      throw new ScheduledCheckStarterResponseError(input.operationId, error);
    throw error;
  }
  if (!response.ok || !parsed.success)
    throw new Error(apiErrorMessage(parsed, `HTTP ${response.status}`));
  if (parsed.data === undefined)
    throw new ScheduledCheckStarterResponseError(input.operationId);
  return parsed.data;
}
export async function observeStarterWork(
  starterId: string,
  apiBase?: string,
): Promise<StarterWorkObservation> {
  return result(
    await authenticatedFetch(
      `${await resolveApiBase(apiBase)}/api/starter-work/${encodeURIComponent(starterId)}/observation`,
    ),
  );
}
export function useStarterWorkObservationQuery(
  starterId: string,
  config?: QueryConfig<StarterWorkObservation>,
) {
  return useApiQuery(
    ['starter-work', starterId, 'observation'],
    () => observeStarterWork(starterId),
    {
      staleTime: config?.staleTime ?? 5_000,
      gcTime: config?.gcTime,
      enabled: config?.enabled ?? starterId.length > 0,
    },
  );
}
export function useLaunchStartTaskStarterMutation() {
  return useApiMutation(launchStartTaskStarter, {
    invalidateKeys: [['starter-work'], ['tasks']],
  });
}
export function useLaunchStarterInspectionMutation() {
  return useApiMutation(launchStarterInspection, {
    invalidateKeys: [['starter-work']],
  });
}
export function useLaunchScheduledCheckStarterMutation() {
  return useApiMutation(launchScheduledCheckStarter, {
    invalidateKeys: [['starter-work'], ['scheduler'], ['runs']],
  });
}
export async function clearStarterWorkBinding(
  starterId: string,
  apiBase?: string,
): Promise<StarterWorkStatus> {
  return result(
    await authenticatedFetch(
      `${await resolveApiBase(apiBase)}/api/starter-work/${encodeURIComponent(starterId)}/binding`,
      { method: 'DELETE' },
    ),
  );
}

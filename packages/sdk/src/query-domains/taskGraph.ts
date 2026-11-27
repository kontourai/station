import type {
  RelationGraphLink,
  SessionRelations,
  TaskClaimStatus,
  TaskCreateInput,
  TaskDispatchInput,
  TaskDispatchResult,
  TaskGraph,
  TaskRecord,
  TaskReferenceInput,
  TaskReferenceKind,
  TaskStatus,
  TaskTurnReference,
  TaskTurnReferenceInput,
  TaskUserInputReference,
  TaskUserInputReferenceInput,
  TaskUserInputReferenceProjection,
  TaskWorkspaceBinding,
} from '@kontourai/station-contracts';
import type { TaskWorkChatPresentation } from '@kontourai/station-contracts/task-graph';
import type { TaskPullRequestFactsProjection } from '@kontourai/station-contracts/task-lane';
import type {
  TaskLatestReportPresentation,
  TaskMemoryAttention,
} from '@kontourai/station-contracts/task-memory';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getTaskAnswerSupportCards,
  type TaskAnswerSupportStandingWithCard,
} from '../client/answer-support';
import {
  envelopeErrorCode,
  envelopeErrorMessage,
  getJson,
  readEnvelopeOrThrow,
  readJsonBody,
} from '../client/http';
import { rethrowDeadline } from '../client/request-deadline';
import {
  type AttachTaskUserInputReferenceInput,
  attachTaskUserInputReference as attachTaskUserInputReferenceClient,
  getTaskUserInputReferences,
} from '../client/task-user-input-references';
import {
  type ApiRequestScope,
  isApiRequestScope,
  type MutationOptions,
  type QueryConfig,
  resolveApiBase,
  useApiMutation,
  useApiQuery,
  useApiQueryRefetchingInvalidatedOnMount,
} from '../query-core';
import { taskQueries } from '../queryFactories';
import { mapConversationMessages } from './chatRuntimeStream';
import type { ConversationMessage } from './chatRuntimeTypes';

export type {
  RelationGraphLink,
  SessionRelations,
  TaskClaimStatus,
  TaskCreateInput,
  TaskDispatchInput,
  TaskDispatchResult,
  TaskGraph,
  TaskRecord,
  TaskReferenceInput,
  TaskReferenceKind,
  TaskStatus,
  TaskTurnReference,
  TaskTurnReferenceInput,
  TaskUserInputReference,
  TaskUserInputReferenceInput,
  TaskUserInputReferenceProjection,
  TaskWorkspaceBinding,
};

/**
 * A Task-owned turn link re-resolved at read time. An unavailable entry
 * contains no source tuple or answer data, so a missing and unauthorized
 * source remain indistinguishable to SDK consumers.
 */
export type TaskTurnReferenceProjection =
  | {
      id: string;
      state: 'available';
      sessionId: string;
      turnId: string;
      answer: ConversationMessage;
      /** Server-projected standing/card only; SDK does not derive Surface semantics. */
      support: TaskAnswerSupportStandingWithCard;
    }
  | { state: 'unavailable' };

export type { TaskAnswerSupportStandingWithCard };

export type CreateTaskUserInputReferenceInput =
  AttachTaskUserInputReferenceInput & {
    taskId: string;
    apiBase?: string;
  };

export type TaskDestinationQueryConfig = QueryConfig<TaskRecord[]> & {
  /** Captured host authority for the native execution-result destination picker. */
  requestScope?: ApiRequestScope;
};

export class TaskDestinationRequestError extends Error {
  constructor() {
    super('Task destinations unavailable');
    this.name = 'TaskDestinationRequestError';
  }
}

/**
 * Reads through the canonical envelope reader, so a refusal keeps its status
 * and `code` and a body that is not JSON (a proxy's error page, an empty
 * body) reports the status instead of a parse exception.
 */
async function readApiResult<T>(response: Response): Promise<T> {
  const data = await readEnvelopeOrThrow<T>(response);
  if (data === undefined) throw new Error('Task response is missing data');
  return data;
}

export async function fetchTasks(
  input: {
    projectId?: string;
    apiBase?: string;
    requestScope?: ApiRequestScope;
    signal?: AbortSignal;
  } = {},
): Promise<TaskListRecord[]> {
  const params = new URLSearchParams();
  if (input.projectId) params.set('projectId', input.projectId);
  const query = params.toString();
  if (input.requestScope) {
    if (!isApiRequestScope(input.requestScope))
      throw new TaskDestinationRequestError();
    try {
      const response = await getJson(
        `${input.requestScope.apiBase}/api/tasks${query ? `?${query}` : ''}`,
        { signal: input.signal, requestScope: input.requestScope },
      );
      return await readApiResult<TaskListRecord[]>(response);
    } catch (error) {
      if (input.signal?.aborted) throw error;
      throw new TaskDestinationRequestError();
    }
  }
  const resolvedApiBase = await resolveApiBase(input.apiBase);
  const response = await authenticatedFetch(
    `${resolvedApiBase}/api/tasks${query ? `?${query}` : ''}`,
  );
  return readApiResult<TaskListRecord[]>(response);
}

/**
 * A Tasks-list row: the Task, (#4003) its open Task-memory question count
 * when it has any, which Home and the inbox read for "Needs you", and
 * (#5064) its summary's first line, which the Project Overview prints.
 */
export type TaskListRecord = TaskRecord &
  Partial<TaskMemoryAttention> &
  TaskLatestReportPresentation &
  TaskWorkChatPresentation;

/**
 * Derived Task lanes: the provider's current facts for each pull request kept
 * on a Project's live Tasks (`GET /api/tasks/pull-request-facts`). `null`
 * when the host answers a plain 404: a Station older than this read, whose
 * board then claims nothing about pull requests. A 404 carrying
 * `request_principal_changed` is lost standing, and is thrown as an error.
 */
export async function fetchTaskPullRequestFacts(
  projectId: string,
  apiBase?: string,
  taskId?: string,
): Promise<TaskPullRequestFactsProjection | null> {
  const resolvedApiBase = await resolveApiBase(apiBase);
  const query = new URLSearchParams({ projectId });
  if (taskId) query.set('taskId', taskId);
  const response = await authenticatedFetch(
    `${resolvedApiBase}/api/tasks/pull-request-facts?${query}`,
  );
  if (response.status === 404) {
    const body = await readJsonBody(response);
    if (envelopeErrorCode(body) !== 'request_principal_changed') return null;
    throw new Error(envelopeErrorMessage(body, 'Request failed with HTTP 404'));
  }
  return readApiResult<TaskPullRequestFactsProjection>(response);
}

/**
 * The board's pull request facts. Provider reads are slow and rate-limited,
 * so it refreshes every two minutes and on focus, never retries a failure,
 * and keeps the last answer when a refresh fails.
 */
export function useTaskPullRequestFactsQuery(
  projectId: string | undefined,
  config: { enabled?: boolean; taskId?: string } = {},
) {
  return useApiQuery(
    taskQueries.pullRequestFacts(projectId ?? '', config.taskId).queryKey,
    () => fetchTaskPullRequestFacts(projectId ?? '', undefined, config.taskId),
    {
      enabled: Boolean(projectId) && (config.enabled ?? true),
      staleTime: taskQueries.pullRequestFacts(projectId ?? '', config.taskId)
        .staleTime,
      refetchInterval: 120_000,
      refetchOnWindowFocus: true,
      retry: false,
    },
  );
}

export async function fetchTask(
  taskId: string,
  apiBase?: string,
): Promise<TaskRecord> {
  const resolvedApiBase = await resolveApiBase(apiBase);
  const response = await authenticatedFetch(
    `${resolvedApiBase}/api/tasks/${encodeURIComponent(taskId)}`,
  );
  return readApiResult<TaskRecord>(response);
}

type TaskMutationDestination = {
  apiBase?: string;
  requestScope?: ApiRequestScope;
};

export async function createTask({
  apiBase,
  requestScope,
  ...body
}: TaskCreateInput & TaskMutationDestination): Promise<TaskRecord> {
  const resolvedApiBase =
    requestScope?.apiBase ?? (await resolveApiBase(apiBase));
  const response = await authenticatedFetch(`${resolvedApiBase}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...(requestScope === undefined ? {} : { requestScope }),
  });
  return readApiResult<TaskRecord>(response);
}

export type CreateTaskReferenceInput = TaskReferenceInput &
  TaskMutationDestination & { taskId: string };

export async function createTaskReference({
  apiBase,
  requestScope,
  taskId,
  ...body
}: CreateTaskReferenceInput): Promise<RelationGraphLink> {
  const resolvedApiBase =
    requestScope?.apiBase ?? (await resolveApiBase(apiBase));
  const response = await authenticatedFetch(
    `${resolvedApiBase}/api/tasks/${encodeURIComponent(taskId)}/references`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ...(requestScope === undefined ? {} : { requestScope }),
    },
  );
  return readApiResult<RelationGraphLink>(response);
}

export async function updateTaskStatus(input: {
  taskId: string;
  status: TaskStatus;
  apiBase?: string;
}): Promise<TaskRecord> {
  const resolvedApiBase = await resolveApiBase(input.apiBase);
  const response = await authenticatedFetch(
    `${resolvedApiBase}/api/tasks/${encodeURIComponent(input.taskId)}/status`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: input.status }),
    },
  );
  return readApiResult<TaskRecord>(response);
}

/** A host older than the Overview's reopen answers its route 404. */
export class TaskOverviewReopenUnsupportedError extends Error {
  constructor() {
    super('This Station cannot reopen Tasks from the Overview yet.');
    this.name = 'TaskOverviewReopenUnsupportedError';
  }
}

/**
 * #5064: reopen a Task the Project Overview auto-resolved. The host restarts
 * its quiet clock; the Task returns to the group its facts place it in.
 */
export async function reopenTaskOnOverview(input: {
  taskId: string;
  apiBase?: string;
}): Promise<TaskRecord> {
  const resolvedApiBase = await resolveApiBase(input.apiBase);
  const response = await authenticatedFetch(
    `${resolvedApiBase}/api/tasks/${encodeURIComponent(input.taskId)}/overview-reopen`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    },
  );
  // An older host has no such route. A refusal it does send carries an
  // envelope, which `readApiResult` reports as itself.
  if (response.status === 404 && !(await hasEnvelope(response.clone())))
    throw new TaskOverviewReopenUnsupportedError();
  return readApiResult<TaskRecord>(response);
}

async function hasEnvelope(response: Response): Promise<boolean> {
  try {
    const body: unknown = await response.json();
    return typeof body === 'object' && body !== null && 'success' in body;
  } catch (error) {
    rethrowDeadline(error);
    return false;
  }
}

export function useReopenTaskOnOverviewMutation() {
  return useApiMutation(reopenTaskOnOverview, {
    invalidateKeys: [['tasks']],
  });
}

export async function dispatchTask(input: {
  taskId: string;
  dispatch?: TaskDispatchInput;
  apiBase?: string;
}): Promise<TaskDispatchResult> {
  const resolvedApiBase = await resolveApiBase(input.apiBase);
  const response = await authenticatedFetch(
    `${resolvedApiBase}/api/tasks/${encodeURIComponent(input.taskId)}/dispatch`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input.dispatch ?? {}),
    },
  );
  return readApiResult<TaskDispatchResult>(response);
}

export async function fetchTaskGraph(
  taskId: string,
  apiBase?: string,
): Promise<TaskGraph> {
  const resolvedApiBase = await resolveApiBase(apiBase);
  const response = await authenticatedFetch(
    `${resolvedApiBase}/api/tasks/${encodeURIComponent(taskId)}/graph`,
  );
  return readApiResult<TaskGraph>(response);
}

export async function fetchTaskTurnReferences(
  taskId: string,
  apiBase?: string,
): Promise<TaskTurnReferenceProjection[]> {
  const resolvedApiBase = await resolveApiBase(apiBase);
  const data = await getTaskAnswerSupportCards<
    Parameters<typeof mapConversationMessages>[0][number]
  >(resolvedApiBase, taskId);
  return data.map((reference) => {
    if (reference.state === 'unavailable') return reference;
    const [answer] = mapConversationMessages([reference.answer]);
    // The route emits exactly one assistant answer for every available
    // reference. Retain the fail-closed projection in case a mixed-version
    // server violates that wire contract rather than inventing an answer.
    if (!answer) return { state: 'unavailable' };
    return {
      id: reference.id,
      state: 'available',
      sessionId: reference.sessionId,
      turnId: reference.turnId,
      answer,
      support: reference.support,
    };
  });
}

export async function fetchTaskUserInputReferences(
  taskId: string,
  apiBase?: string,
): Promise<TaskUserInputReferenceProjection[]> {
  return getTaskUserInputReferences(await resolveApiBase(apiBase), taskId);
}

export async function createTaskUserInputReference(
  input: CreateTaskUserInputReferenceInput,
): Promise<RelationGraphLink> {
  const { taskId, apiBase, ...reference } = input;
  return attachTaskUserInputReferenceClient(
    await resolveApiBase(apiBase),
    taskId,
    reference,
  );
}

export async function fetchSessionRelations(
  sessionId: string,
  apiBase?: string,
): Promise<SessionRelations> {
  const resolvedApiBase = await resolveApiBase(apiBase);
  const response = await authenticatedFetch(
    `${resolvedApiBase}/api/tasks/sessions/${encodeURIComponent(
      sessionId,
    )}/relations`,
  );
  return readApiResult<SessionRelations>(response);
}

export async function fetchTaskClaim(
  taskId: string,
  apiBase?: string,
): Promise<TaskClaimStatus> {
  const resolvedApiBase = await resolveApiBase(apiBase);
  const response = await authenticatedFetch(
    `${resolvedApiBase}/api/tasks/${encodeURIComponent(taskId)}/claim`,
  );
  return readApiResult<TaskClaimStatus>(response);
}

export function useTasksQuery(
  projectId?: string,
  config?: TaskDestinationQueryConfig,
) {
  const scoped = isApiRequestScope(config?.requestScope);
  const query = useApiQueryRefetchingInvalidatedOnMount(
    taskQueries.list(projectId, config?.requestScope).queryKey,
    (signal) =>
      fetchTasks({
        projectId,
        signal,
        ...(scoped ? { requestScope: config?.requestScope } : {}),
      }),
    {
      staleTime:
        config?.staleTime ??
        taskQueries.list(projectId, config?.requestScope).staleTime,
      gcTime: config?.gcTime,
      refetchInterval: config?.refetchInterval,
      enabled: config?.requestScope
        ? scoped && (config.enabled ?? true)
        : config?.enabled,
      refetchOnMount: scoped
        ? (config?.refetchOnMount ?? 'always')
        : config?.refetchOnMount,
      retry: scoped ? false : config?.retry,
      cancelWhenInactive: scoped
        ? (config?.cancelWhenInactive ?? true)
        : config?.cancelWhenInactive,
    },
  );
  if (!scoped) return query;
  const protectedError =
    query.error instanceof TaskDestinationRequestError
      ? query.error
      : undefined;
  return {
    ...query,
    error: protectedError ?? query.error,
    data:
      !protectedError &&
      query.isFetchedAfterMount &&
      query.status === 'success' &&
      !query.isFetching
        ? query.data
        : undefined,
    isLoading:
      !protectedError &&
      (!query.isFetchedAfterMount || query.isLoading || query.isFetching),
  };
}

export function useTaskQuery(taskId: string, config?: QueryConfig<TaskRecord>) {
  return useApiQuery(
    taskQueries.task(taskId).queryKey,
    () => fetchTask(taskId),
    {
      staleTime: config?.staleTime ?? taskQueries.task(taskId).staleTime,
      gcTime: config?.gcTime,
      enabled: config?.enabled ?? taskId.length > 0,
    },
  );
}

export function useTaskGraphQuery(
  taskId: string,
  config?: QueryConfig<TaskGraph>,
) {
  return useApiQuery(
    taskQueries.graph(taskId).queryKey,
    () => fetchTaskGraph(taskId),
    {
      staleTime: config?.staleTime ?? taskQueries.graph(taskId).staleTime,
      gcTime: config?.gcTime,
      enabled: config?.enabled ?? taskId.length > 0,
    },
  );
}

export function useTaskTurnReferencesQuery(
  taskId: string,
  config?: QueryConfig<TaskTurnReferenceProjection[]>,
) {
  const query = useApiQuery(
    taskQueries.turnReferences(taskId).queryKey,
    () => fetchTaskTurnReferences(taskId),
    {
      staleTime:
        config?.staleTime ?? taskQueries.turnReferences(taskId).staleTime,
      gcTime: config?.gcTime,
      enabled: config?.enabled ?? taskId.length > 0,
      // The endpoint reauthorizes every stored tuple. Do that again when a
      // Task workspace is reopened instead of trusting a previous user's
      // cached authorized answer under the app-wide cache-first default.
      refetchOnMount: config?.refetchOnMount ?? 'always',
    },
  );
  // A cached successful response was authorized under a prior mount. While
  // this protected endpoint reauthorizes it, do not leave its answer text in
  // the Task view as if the new observer had been granted the same access.
  return {
    ...query,
    // `isFetching` is false for an offline/paused mount. A cached answer is
    // still protected until THIS observer completes authorization, including
    // an error/paused outcome, so use the observer-local post-mount fact.
    data:
      query.isFetchedAfterMount &&
      query.status === 'success' &&
      !query.isFetching
        ? query.data
        : undefined,
    isLoading:
      !query.isFetchedAfterMount || query.isLoading || query.isFetching,
  };
}

function invalidateTaskLists(
  client: ReturnType<typeof useQueryClient>,
  scope?: ApiRequestScope,
): void {
  if (!scope) {
    client.invalidateQueries({ queryKey: ['tasks'] });
    return;
  }
  client.invalidateQueries({
    queryKey: ['tasks'],
    predicate: ({ queryKey }) =>
      queryKey[2] === scope.apiBase && queryKey[3] === scope.authorityKey,
  });
  client.invalidateQueries({
    queryKey: ['tasks'],
    predicate: ({ queryKey }) => queryKey.length === 2,
  });
}

function invalidateTaskReferenceScope(
  client: ReturnType<typeof useQueryClient>,
  taskId: string,
  scope?: ApiRequestScope,
): void {
  invalidateTaskLists(client, scope);
  for (const queryKey of [
    taskQueries.task(taskId).queryKey,
    taskQueries.graph(taskId).queryKey,
    taskQueries.claim(taskId).queryKey,
    taskQueries.turnReferences(taskId).queryKey,
    taskQueries.userInputReferences(taskId).queryKey,
  ]) {
    client.invalidateQueries({
      queryKey,
      exact: true,
      ...(scope ? { refetchType: 'none' } : {}),
    });
  }
}

export function useSessionRelationsQuery(
  sessionId: string,
  config?: QueryConfig<SessionRelations>,
) {
  return useApiQuery(
    taskQueries.sessionRelations(sessionId).queryKey,
    () => fetchSessionRelations(sessionId),
    {
      staleTime:
        config?.staleTime ?? taskQueries.sessionRelations(sessionId).staleTime,
      gcTime: config?.gcTime,
      enabled: config?.enabled ?? sessionId.length > 0,
    },
  );
}

export function useTaskClaimQuery(
  taskId: string,
  config?: QueryConfig<TaskClaimStatus>,
) {
  return useApiQuery(
    taskQueries.claim(taskId).queryKey,
    () => fetchTaskClaim(taskId),
    {
      staleTime: config?.staleTime ?? taskQueries.claim(taskId).staleTime,
      gcTime: config?.gcTime,
      enabled: config?.enabled ?? taskId.length > 0,
    },
  );
}

export function useCreateTaskMutation() {
  const queryClient = useQueryClient();
  return useApiMutation(createTask, {
    onSuccess: (_data, variables) =>
      invalidateTaskLists(queryClient, variables.requestScope),
  });
}

export function useCreateTaskReferenceMutation(
  options?: MutationOptions<RelationGraphLink, CreateTaskReferenceInput>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createTaskReference,
    onSuccess: (data, variables) => {
      invalidateTaskReferenceScope(
        queryClient,
        variables.taskId,
        variables.requestScope,
      );
      options?.onSuccess?.(data, variables);
    },
    onError: (error, variables) => {
      options?.onError?.(error as Error, variables);
    },
  });
}

export function useUpdateTaskStatusMutation() {
  const client = useQueryClient();
  return useApiMutation(updateTaskStatus, {
    invalidateKeys: [['tasks']],
    onSuccess: (_data, { taskId }) => {
      for (const queryKey of [
        taskQueries.task(taskId).queryKey,
        taskQueries.graph(taskId).queryKey,
        taskQueries.claim(taskId).queryKey,
      ])
        client.invalidateQueries({ queryKey, exact: true });
    },
  });
}

export function useDispatchTaskMutation() {
  const client = useQueryClient();
  return useApiMutation(dispatchTask, {
    invalidateKeys: [['tasks']],
    onSuccess: (_data, { taskId }) => {
      for (const queryKey of [
        taskQueries.task(taskId).queryKey,
        taskQueries.graph(taskId).queryKey,
        taskQueries.claim(taskId).queryKey,
      ])
        client.invalidateQueries({ queryKey, exact: true });
    },
  });
}

import { authenticatedFetch } from '../client/http';

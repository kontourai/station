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
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getTaskAnswerSupportCards,
  type TaskAnswerSupportStandingWithCard,
} from '../client/answer-support';
import { getJson } from '../client/http';
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

export async function fetchTasks(
  input: {
    projectId?: string;
    apiBase?: string;
    requestScope?: ApiRequestScope;
    signal?: AbortSignal;
  } = {},
): Promise<TaskRecord[]> {
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
      return await readApiResult<TaskRecord[]>(response);
    } catch (error) {
      if (input.signal?.aborted) throw error;
      throw new TaskDestinationRequestError();
    }
  }
  const resolvedApiBase = await resolveApiBase(input.apiBase);
  const response = await authenticatedFetch(
    `${resolvedApiBase}/api/tasks${query ? `?${query}` : ''}`,
  );
  return readApiResult<TaskRecord[]>(response);
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

export async function createTask(
  input: TaskCreateInput & { apiBase?: string },
): Promise<TaskRecord> {
  const resolvedApiBase = await resolveApiBase(input.apiBase);
  const { apiBase: _apiBase, ...body } = input;
  const response = await authenticatedFetch(`${resolvedApiBase}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return readApiResult<TaskRecord>(response);
}

export type CreateTaskReferenceInput = TaskReferenceInput & {
  taskId: string;
  apiBase?: string;
};

export async function createTaskReference(
  input: CreateTaskReferenceInput,
): Promise<RelationGraphLink> {
  const resolvedApiBase = await resolveApiBase(input.apiBase);
  const { taskId, apiBase: _apiBase, ...body } = input;
  const response = await authenticatedFetch(
    `${resolvedApiBase}/api/tasks/${encodeURIComponent(taskId)}/references`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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
  const query = useApiQuery(
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

function invalidateTaskReferenceScope(
  client: ReturnType<typeof useQueryClient>,
  taskId: string,
): void {
  for (const queryKey of [
    taskQueries.list().queryKey,
    taskQueries.task(taskId).queryKey,
    taskQueries.graph(taskId).queryKey,
    taskQueries.turnReferences(taskId).queryKey,
    taskQueries.userInputReferences(taskId).queryKey,
  ]) {
    client.invalidateQueries({ queryKey, exact: true });
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
  return useApiMutation(createTask, {
    invalidateKeys: [taskQueries.list().queryKey],
  });
}

export function useCreateTaskReferenceMutation(
  options?: MutationOptions<RelationGraphLink, CreateTaskReferenceInput>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createTaskReference,
    onSuccess: (data, variables) => {
      invalidateTaskReferenceScope(queryClient, variables.taskId);
      options?.onSuccess?.(data, variables);
    },
    onError: (error, variables) => {
      options?.onError?.(error as Error, variables);
    },
  });
}

export function useUpdateTaskStatusMutation() {
  return useApiMutation(updateTaskStatus, {
    invalidateKeys: [taskQueries.list().queryKey],
  });
}

export function useDispatchTaskMutation() {
  return useApiMutation(dispatchTask, {
    invalidateKeys: [taskQueries.list().queryKey],
  });
}

import { apiErrorMessage } from '../api-core';
import { authenticatedFetch } from '../client/http';

import {
  isMobileDeviceHostId,
  type MobileDeviceSession,
} from '@kontourai/station-contracts/mobile-device';
import type {
  TaskCapture,
  TaskReviewArtifactKind,
  TaskReviewCreateCaptureRequest,
  TaskReviewCreateThreadRequest,
  TaskReviewItem,
  TaskReviewReopenRequest,
  TaskReviewReplyRequest,
  TaskReviewResolveRequest,
  TaskReviewResponse,
  TaskReviewRevision,
  TaskReviewSendRequest,
  TaskReviewSendResponse,
  TaskReviewThreadView,
  TaskReviewView,
} from '@kontourai/station-contracts/task-review';
import {
  parseTaskDeviceRecordingJob,
  type TaskDeviceRecordingJob,
} from '@kontourai/station-contracts/task-review';
import {
  isWalkthroughId,
  parseWalkthrough,
  WALKTHROUGH_LIMITS,
  type Walkthrough,
} from '@kontourai/station-contracts/walkthrough';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect, useId, useMemo } from 'react';
import { _getApiBase } from '../api';
import {
  type ApiRequestScope,
  authenticatedFetch,
  getJson,
  mutateJson,
  readJsonBody,
  StationHttpError,
} from '../client/http';
import { type QueryConfig, useApiMutation } from '../query-core';

export type {
  TaskReviewArtifactKind,
  TaskReviewCreateThreadRequest,
  TaskReviewItem,
  TaskReviewReopenRequest,
  TaskReviewReplyRequest,
  TaskReviewResolveRequest,
  TaskReviewThreadSummary,
  TaskReviewThreadView,
  TaskReviewView,
} from '@kontourai/station-contracts/task-review';
export { TASK_REVIEW_OPENING_PREVIEW_CHARS } from '@kontourai/station-contracts/task-review';

export const taskReviewQueryKey = (taskId: string) =>
  ['task-review', taskId] as const;
const path = async (taskId: string, suffix = '') =>
  `${await _getApiBase()}/api/tasks/${encodeURIComponent(taskId)}/review${suffix}`;
async function result<T>(response: Response): Promise<T> {
  const body = (await readJsonBody(response)) as
    | TaskReviewResponse<T>
    | undefined;
  if (
    !body ||
    typeof body.success !== 'boolean' ||
    (body.success ? !('data' in body) : typeof body.error !== 'string')
  )
    throw new StationHttpError(
      response.status,
      'Invalid Task review response.',
    );
  if (response.ok && body.success) return body.data;
  throw new StationHttpError(
    response.status,
    body.success ? 'Task review request failed.' : body.error,
    body.success ? undefined : { code: body.code },
  );
}
export const taskReviewItemQueryKey = (
  taskId: string,
  kind: TaskReviewArtifactKind,
  id: string,
  revision?: TaskReviewRevision,
) => ['task-review-item', taskId, kind, id, revision] as const;
export async function fetchTaskReviewItem(
  taskId: string,
  kind: TaskReviewArtifactKind,
  id: string,
  signal?: AbortSignal,
): Promise<TaskReviewItem> {
  return result<TaskReviewItem>(
    await authenticatedFetch(
      await path(
        taskId,
        `/items/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`,
      ),
      { signal },
    ),
  );
}
export function useTaskReviewItemQuery(
  taskId: string,
  kind: TaskReviewArtifactKind,
  id: string,
  config?: Omit<
    QueryConfig<TaskReviewItem>,
    'refetchInterval' | 'refetchIntervalForError'
  > & { revision?: TaskReviewRevision },
) {
  const { revision, ...queryConfig } = config ?? {};
  return useQuery({
    ...queryConfig,
    queryKey: taskReviewItemQueryKey(taskId, kind, id, revision),
    queryFn: ({ signal }) => fetchTaskReviewItem(taskId, kind, id, signal),
    enabled: taskId.length > 0 && id.length > 0 && (config?.enabled ?? true),
    refetchInterval: false,
  });
}

/** Supply the summary's event count and current revision to refresh an expanded card. */
export const taskReviewThreadQueryKey = (
  taskId: string,
  threadId: string,
  eventCount?: number,
  revision?: TaskReviewRevision,
) => ['task-review-thread', taskId, threadId, eventCount, revision] as const;
export async function fetchTaskReviewThread(
  taskId: string,
  threadId: string,
  signal?: AbortSignal,
): Promise<{ thread: TaskReviewThreadView }> {
  return result(
    await authenticatedFetch(
      await path(taskId, `/threads/${encodeURIComponent(threadId)}`),
      { signal },
    ),
  );
}
export function useTaskReviewThreadQuery(
  taskId: string,
  threadId: string,
  config?: Omit<
    QueryConfig<{ thread: TaskReviewThreadView }>,
    'refetchInterval' | 'refetchIntervalForError'
  > & { eventCount?: number; revision?: TaskReviewRevision },
) {
  const { eventCount, revision, ...queryConfig } = config ?? {};
  return useQuery({
    ...queryConfig,
    queryKey: taskReviewThreadQueryKey(taskId, threadId, eventCount, revision),
    queryFn: ({ signal }) => fetchTaskReviewThread(taskId, threadId, signal),
    enabled:
      taskId.length > 0 && threadId.length > 0 && (config?.enabled ?? true),
    refetchInterval: false,
  });
}

export async function fetchTaskReview(
  taskId: string,
  signal?: AbortSignal,
): Promise<TaskReviewView> {
  return result<TaskReviewView>(
    await authenticatedFetch(await path(taskId), { signal }),
  );
}
async function mutate(
  taskId: string,
  suffix: string,
  input: unknown,
): Promise<{ thread: TaskReviewThreadView }> {
  return result<{ thread: TaskReviewThreadView }>(
    await authenticatedFetch(await path(taskId, suffix), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  );
}
export function useTaskReviewQuery(
  taskId: string,
  options?: Omit<
    QueryConfig<TaskReviewView>,
    'refetchInterval' | 'refetchIntervalForError'
  > & { poll?: boolean },
) {
  const { poll = false, ...config } = options ?? {};
  return useQuery({
    ...config,
    queryKey: taskReviewQueryKey(taskId),
    queryFn: ({ signal }) => fetchTaskReview(taskId, signal),
    enabled: taskId.length > 0 && (config.enabled ?? true),
    staleTime: config.staleTime ?? 5 * 60 * 1000,
    // The caller enables poll only while its Review tab is visible (R5).
    refetchInterval: (query) =>
      poll &&
      query.state.status !== 'error' &&
      query.state.data?.threads.some(
        (thread) =>
          thread.status === 'available' && thread.baseState === 'sent',
      )
        ? 3000
        : false,
  });
}
export function useCreateReviewThreadMutation(taskId: string) {
  return useApiMutation(
    (input: TaskReviewCreateThreadRequest) => mutate(taskId, '/threads', input),
    {
      invalidateKeys: [
        [...taskReviewQueryKey(taskId)],
        ['task-review-thread', taskId],
      ],
    },
  );
}
export function useReplyReviewThreadMutation(taskId: string) {
  return useApiMutation(
    (input: TaskReviewReplyRequest & { threadId: string }) => {
      const { threadId, ...body } = input;
      return mutate(
        taskId,
        `/threads/${encodeURIComponent(threadId)}/replies`,
        body,
      );
    },
    {
      invalidateKeys: [
        [...taskReviewQueryKey(taskId)],
        ['task-review-thread', taskId],
      ],
    },
  );
}
export function useResolveReviewThreadMutation(taskId: string) {
  return useApiMutation(
    (input: TaskReviewResolveRequest & { threadId: string }) => {
      const { threadId, ...body } = input;
      return mutate(
        taskId,
        `/threads/${encodeURIComponent(threadId)}/resolve`,
        body,
      );
    },
    {
      invalidateKeys: [
        [...taskReviewQueryKey(taskId)],
        ['task-review-thread', taskId],
      ],
    },
  );
}
export function useReopenReviewThreadMutation(taskId: string) {
  return useApiMutation(
    (input: TaskReviewReopenRequest & { threadId: string }) => {
      const { threadId, ...body } = input;
      return mutate(
        taskId,
        `/threads/${encodeURIComponent(threadId)}/reopen`,
        body,
      );
    },
    {
      invalidateKeys: [
        [...taskReviewQueryKey(taskId)],
        ['task-review-thread', taskId],
      ],
    },
  );
}

/** A live Browser session the person may capture in the Task's Project. */
export interface TaskCaptureBrowserSession {
  browserSessionId: string;
  url: string;
  viewport: {
    width: number;
    height: number;
    deviceScaleFactor: number;
    mobile?: boolean;
  };
}
export async function fetchTaskCaptureSessions(
  taskId: string,
  signal?: AbortSignal,
): Promise<{ sessions: TaskCaptureBrowserSession[] }> {
  return result(
    await authenticatedFetch(await path(taskId, '/capture-sessions'), {
      signal,
    }),
  );
}
export function useTaskCaptureSessionsQuery(
  taskId: string,
  options?: QueryConfig<{ sessions: TaskCaptureBrowserSession[] }>,
) {
  return useQuery({
    ...options,
    queryKey: ['task-capture-sessions', taskId],
    queryFn: ({ signal }) => fetchTaskCaptureSessions(taskId, signal),
    enabled: taskId.length > 0 && (options?.enabled ?? true),
  });
}
export function useCaptureToTaskMutation(taskId: string) {
  return useApiMutation(
    async (
      input: TaskReviewCreateCaptureRequest,
    ): Promise<{ capture: TaskCapture }> =>
      result(
        await authenticatedFetch(await path(taskId, '/captures'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        }),
      ),
    { invalidateKeys: [[...taskReviewQueryKey(taskId)]] },
  );
}
export type TaskCaptureDeviceSession = MobileDeviceSession & {
  sourceSessionId: string;
};
export async function fetchTaskDeviceCaptureSessions(
  taskId: string,
  projectSlug: string,
  signal?: AbortSignal,
) {
  const data = await result<{ sessions: unknown }>(
    await authenticatedFetch(
      await path(
        taskId,
        `/device-capture-sessions?projectSlug=${encodeURIComponent(projectSlug)}`,
      ),
      { signal },
    ),
  );
  if (
    !data ||
    !Array.isArray(data.sessions) ||
    data.sessions.length > 200 ||
    !data.sessions.every((value) => {
      if (!value || typeof value !== 'object') return false;
      const row = value as Record<string, unknown>;
      return (
        isMobileDeviceHostId(row.hostId) &&
        (row.platform === 'ios' || row.platform === 'android') &&
        typeof row.sessionId === 'string' &&
        row.sessionId.length > 0 &&
        row.sessionId.length <= 80 &&
        row.sourceSessionId === `${row.hostId}:${row.sessionId}` &&
        typeof row.deviceId === 'string' &&
        row.deviceId.length > 0 &&
        row.deviceId.length <= 256 &&
        typeof row.surfaceId === 'string' &&
        row.surfaceId.length > 0 &&
        typeof row.name === 'string' &&
        typeof row.runtime === 'string' &&
        typeof row.openedAt === 'string'
      );
    })
  )
    throw new StationHttpError(200, 'Invalid Device capture sessions.');
  return data as { sessions: TaskCaptureDeviceSession[] };
}
export function useTaskDeviceCaptureSessionsQuery(
  taskId: string,
  projectSlug: string | null,
  options?: QueryConfig<{ sessions: TaskCaptureDeviceSession[] }>,
) {
  return useQuery({
    ...options,
    queryKey: ['task-device-capture-sessions', taskId, projectSlug],
    queryFn: ({ signal }) =>
      fetchTaskDeviceCaptureSessions(taskId, projectSlug!, signal),
    enabled: !!taskId && !!projectSlug && (options?.enabled ?? true),
  });
}
export function useCaptureDeviceToTaskMutation(
  taskId: string,
  projectSlug: string | null,
) {
  return useApiMutation(
    async (
      input: TaskReviewCreateCaptureRequest,
    ): Promise<{ capture: TaskCapture }> => {
      if (!projectSlug) throw new Error('Project is required');
      return result(
        await authenticatedFetch(
          await path(
            taskId,
            `/device-captures?projectSlug=${encodeURIComponent(projectSlug)}`,
          ),
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(input),
          },
        ),
      );
    },
    { invalidateKeys: [[...taskReviewQueryKey(taskId)]] },
  );
}

function deviceRecordingPath(
  scope: ApiRequestScope,
  taskId: string,
  projectSlug: string,
  suffix = '',
) {
  return `${scope.apiBase}/api/tasks/${encodeURIComponent(taskId)}/review/device-recordings${suffix}?projectSlug=${encodeURIComponent(projectSlug)}`;
}
async function recordingJob(
  response: Response,
): Promise<TaskDeviceRecordingJob> {
  const job = parseTaskDeviceRecordingJob(await result<unknown>(response));
  if (!job) throw new Error('Invalid Device recording response.');
  return job;
}
export function useStartDeviceRecordingMutation(scope: ApiRequestScope) {
  return useMutation({
    mutationFn: async (input: {
      taskId: string;
      sourceSessionId: string;
      durationMs: number;
      projectSlug: string;
    }) =>
      recordingJob(
        await mutateJson(
          deviceRecordingPath(scope, input.taskId, input.projectSlug),
          'POST',
          { requestScope: scope },
          {
            sourceSessionId: input.sourceSessionId,
            durationMs: input.durationMs,
          },
        ),
      ),
  });
}
export function useDeviceRecordingQuery(
  scope: ApiRequestScope,
  projectSlug: string,
  taskId: string | null,
  jobId: string | null,
) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: [
      'device-recording',
      scope.apiBase,
      scope.authorityKey,
      projectSlug,
      taskId,
      jobId,
    ],
    queryFn: async ({ signal }) => {
      if (!taskId || !jobId)
        throw new Error('Recording identity is unavailable.');
      return recordingJob(
        await getJson(
          deviceRecordingPath(
            scope,
            taskId,
            projectSlug,
            `/${encodeURIComponent(jobId)}`,
          ),
          { requestScope: scope, signal },
        ),
      );
    },
    enabled: !!taskId && !!jobId,
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.state === 'completed' ||
      query.state.data?.state === 'failed' ||
      query.state.error
        ? false
        : 1000,
  });
  useEffect(() => {
    if (query.data?.state === 'completed' && taskId)
      void queryClient.invalidateQueries({
        queryKey: [
          'task-walkthroughs',
          scope.apiBase,
          scope.authorityKey,
          taskId,
        ],
      });
  }, [
    query.data?.state,
    queryClient,
    scope.apiBase,
    scope.authorityKey,
    taskId,
  ]);
  return query;
}
export function useStopDeviceRecordingMutation(scope: ApiRequestScope) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      taskId: string;
      jobId: string;
      projectSlug: string;
    }) =>
      recordingJob(
        await mutateJson(
          deviceRecordingPath(
            scope,
            input.taskId,
            input.projectSlug,
            `/${encodeURIComponent(input.jobId)}/stop`,
          ),
          'POST',
          { requestScope: scope },
        ),
      ),
    onSuccess: (job, input) => {
      queryClient.setQueryData(
        [
          'device-recording',
          scope.apiBase,
          scope.authorityKey,
          input.projectSlug,
          input.taskId,
          input.jobId,
        ],
        job,
      );
    },
  });
}
export async function fetchTaskCaptureContent(
  taskId: string,
  captureId: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const response = await authenticatedFetch(
    await path(taskId, `/captures/${encodeURIComponent(captureId)}/content`),
    { signal },
  );
  if (!response.ok) await result<never>(response);
  return response.blob();
}

const TASK_WALKTHROUGH_PAGE_SIZE = 5;
type TaskWalkthroughPage = { items: Walkthrough[]; nextCursor?: string };
type TaskWalkthroughScope = {
  requestScope: ApiRequestScope;
  taskCreatedAt: string;
};

const taskWalkthroughPath = (scope: ApiRequestScope, taskId: string) =>
  `${scope.apiBase}/api/tasks/${encodeURIComponent(taskId)}/review/walkthroughs`;

export async function fetchTaskWalkthroughPage(
  taskId: string,
  scope: ApiRequestScope,
  cursor?: string,
  signal?: AbortSignal,
): Promise<TaskWalkthroughPage> {
  const query = new URLSearchParams({
    limit: String(TASK_WALKTHROUGH_PAGE_SIZE),
    deviceIdentity: '1',
  });
  if (cursor) query.set('cursor', cursor);
  const page = await result<{ items: unknown; nextCursor?: unknown }>(
    await getJson(`${taskWalkthroughPath(scope, taskId)}?${query}`, {
      requestScope: scope,
      signal,
      maxResponseBytes:
        TASK_WALKTHROUGH_PAGE_SIZE * WALKTHROUGH_LIMITS.manifestBytes + 4096,
    }),
  );
  if (
    !Array.isArray(page.items) ||
    page.items.length > TASK_WALKTHROUGH_PAGE_SIZE ||
    (page.nextCursor !== undefined && !isWalkthroughId(page.nextCursor))
  )
    throw new Error('Invalid Task Walkthrough page.');
  const items = page.items.map(parseWalkthrough);
  if (items.some((item) => !item.source.commit || !item.source.recording))
    throw new Error('Invalid Task Walkthrough recording.');
  return { items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
}

export function useTaskWalkthroughsQuery(
  taskId: string,
  scope: TaskWalkthroughScope,
) {
  return useInfiniteQuery({
    queryKey: [
      'task-walkthroughs',
      scope.requestScope.apiBase,
      scope.requestScope.authorityKey,
      taskId,
      scope.taskCreatedAt,
    ],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      fetchTaskWalkthroughPage(taskId, scope.requestScope, pageParam, signal),
    getNextPageParam: (page) => page.nextCursor,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

export function useTaskWalkthroughVideoQuery(
  taskId: string,
  clip: Walkthrough,
  scope: TaskWalkthroughScope,
) {
  const observerId = useId();
  const client = useQueryClient();
  const queryKey = useMemo(
    () =>
      [
        'task-walkthrough-video',
        scope.requestScope.apiBase,
        scope.requestScope.authorityKey,
        taskId,
        scope.taskCreatedAt,
        clip.id,
        clip.source.recording?.digest,
        observerId,
      ] as const,
    [
      scope.requestScope.apiBase,
      scope.requestScope.authorityKey,
      taskId,
      scope.taskCreatedAt,
      clip.id,
      clip.source.recording?.digest,
      observerId,
    ],
  );
  const lease = useMemo(
    () => ({ active: false, controller: new AbortController(), queryKey }),
    [queryKey],
  );
  useEffect(() => {
    lease.active = true;
    return () => {
      lease.active = false;
      // StrictMode replays effects synchronously; a real unmount retires this read.
      queueMicrotask(() => {
        if (lease.active) return;
        lease.controller.abort();
        client.removeQueries({ queryKey: lease.queryKey, exact: true });
      });
    };
  }, [client, lease]);
  return useQuery({
    queryKey,
    queryFn: async () => {
      const recording = clip.source.recording;
      if (!recording)
        throw new Error('Task Walkthrough recording unavailable.');
      const response = await getJson(
        `${taskWalkthroughPath(scope.requestScope, taskId)}/${encodeURIComponent(clip.id)}/video`,
        {
          requestScope: scope.requestScope,
          signal: lease.controller.signal,
          maxResponseBytes: recording.byteLength,
        },
      );
      if (!response.ok) await result<never>(response);
      const video = await response.blob();
      if (
        video.size !== recording.byteLength ||
        video.type !== recording.mediaType
      )
        throw new Error('Invalid Task Walkthrough video.');
      return video;
    },
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
}
export type {
  TaskCapture,
  TaskReviewCreateCaptureRequest,
} from '@kontourai/station-contracts/task-review';

export function useSendReviewThreadsMutation(taskId: string) {
  return useApiMutation(
    async (input: TaskReviewSendRequest) =>
      result<Extract<TaskReviewSendResponse, { success: true }>['data']>(
        await authenticatedFetch(await path(taskId, '/send'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        }),
      ),
    {
      invalidateKeys: [
        [...taskReviewQueryKey(taskId)],
        ['task-review-thread', taskId],
      ],
    },
  );
}

import type { MemberProjectView } from '@kontourai/station-contracts/project';
import type {
  ProjectSharedTaskDocument,
  ProjectSharedTaskHistory,
  ProjectSharedTaskPublication,
  ProjectSharedTaskSummary,
} from '@kontourai/station-contracts/project-shared-task';
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { taskHistoryReadDenied } from '../../components/conversation/task-history-policy';
import type { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';

/**
 * Read the exact shared-work summaries published for a member Project. The
 * authority scope is supplied by the page-detail capture and reused for both
 * cache identity and SDK dispatch.
 */
export function useScopedMemberProjectSharedTasksQuery(
  project: Pick<MemberProjectView, 'id' | 'slug'>,
  requestScope: ReturnType<typeof useHostRequestAuthorityScope>,
) {
  const queryClient = useQueryClient();
  const apiBase = requestScope?.apiBase ?? 'unavailable';
  const authorityKey = requestScope?.authorityKey ?? 'unavailable';
  const queryKey = useMemo(
    () =>
      [
        'member-project-shared-work',
        apiBase,
        authorityKey,
        project.id,
        project.slug,
      ] as const,
    [apiBase, authorityKey, project.id, project.slug],
  );
  const scopeIsCurrent = Boolean(requestScope?.isCurrent());
  const query = useQuery<ProjectSharedTaskSummary[]>({
    queryKey,
    queryFn: async ({ signal }) => {
      const captured = requestScope;
      if (!captured?.isCurrent())
        throw new Error('Access to this Station is unavailable.');
      const { listProjectSharedTasks } = await import(
        '@kontourai/station-sdk/project-shared-tasks'
      );
      const values = await listProjectSharedTasks(
        captured.apiBase,
        project.slug,
        {
          requestScope: captured,
          requireCredential: captured.requiresEnrolledCredential ?? true,
          signal,
          timeoutMs: 15_000,
          maxResponseBytes: 1024 * 1024,
        },
      );
      if (!captured.isCurrent())
        throw new Error('Your access to this Station changed.');
      if (
        values.some(
          (value) =>
            value.project.localProjectId !== project.id ||
            value.project.localProjectSlug !== project.slug,
        )
      )
        throw new Error('Shared work returned a different Project scope.');
      return values;
    },
    enabled: Boolean(
      project.id && project.slug && requestScope && scopeIsCurrent,
    ),
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    gcTime: 0,
  });

  useEffect(
    () => () => {
      void queryClient.cancelQueries({ queryKey, exact: true });
      void queryClient.removeQueries({ queryKey, exact: true });
    },
    [queryClient, queryKey],
  );
  return query;
}

function sameSharedProjectTask(
  actual: ProjectSharedTaskSummary,
  expected: ProjectSharedTaskSummary,
): boolean {
  return (
    actual.shareId === expected.shareId &&
    actual.project.stationId === expected.project.stationId &&
    actual.project.localProjectId === expected.project.localProjectId &&
    actual.project.localProjectSlug === expected.project.localProjectSlug &&
    actual.project.portableProjectId === expected.project.portableProjectId &&
    actual.task.id === expected.task.id &&
    actual.task.createdAt === expected.task.createdAt
  );
}

/** Read only the supported shared-work leaves under the page's captured scope. */
export function useScopedMemberProjectSharedTaskDetails(
  project: Pick<MemberProjectView, 'id' | 'slug'>,
  sharedTask: ProjectSharedTaskSummary,
  requestScope: ReturnType<typeof useHostRequestAuthorityScope>,
) {
  const client = useQueryClient();
  const apiBase = requestScope?.apiBase ?? 'unavailable';
  const authorityKey = requestScope?.authorityKey ?? 'unavailable';
  const key = useMemo(
    () =>
      [
        'member-project-shared-work-item',
        apiBase,
        authorityKey,
        project.id,
        project.slug,
        sharedTask.shareId,
        sharedTask.task.id,
        sharedTask.task.createdAt,
      ] as const,
    [
      apiBase,
      authorityKey,
      project.id,
      project.slug,
      sharedTask.shareId,
      sharedTask.task.createdAt,
      sharedTask.task.id,
    ],
  );
  const scopeIsCurrent = Boolean(requestScope?.isCurrent());
  const requestEnabled = Boolean(
    project.id &&
      project.slug &&
      sharedTask.shareId &&
      requestScope &&
      scopeIsCurrent,
  );
  const publication = useQuery<ProjectSharedTaskPublication>({
    queryKey: [...key, 'publication'],
    queryFn: async ({ signal }) => {
      const captured = requestScope;
      if (!captured?.isCurrent())
        throw new Error('Access to this Station is unavailable.');
      const { getProjectSharedTaskPublication } = await import(
        '@kontourai/station-sdk/project-shared-tasks'
      );
      signal.throwIfAborted();
      if (!captured.isCurrent())
        throw new Error('Your access to this Station changed.');
      const value = await getProjectSharedTaskPublication(
        captured.apiBase,
        project.slug,
        sharedTask.task.id,
        {
          requestScope: captured,
          requireCredential: captured.requiresEnrolledCredential ?? true,
          signal,
          timeoutMs: 15_000,
          maxResponseBytes: 64 * 1024,
        },
      );
      if (!captured.isCurrent())
        throw new Error('Your access to this Station changed.');
      if (
        value.kind === 'shared'
          ? !sameSharedProjectTask(value.publication, sharedTask)
          : value.project.stationId !== sharedTask.project.stationId ||
            value.project.localProjectId !== project.id ||
            value.project.localProjectSlug !== project.slug ||
            value.task.id !== sharedTask.task.id ||
            value.task.createdAt !== sharedTask.task.createdAt
      )
        throw new Error(
          'Shared publication returned a different Project scope.',
        );
      return value;
    },
    enabled: requestEnabled,
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
  const publicationIsCurrent = Boolean(
    requestEnabled &&
      publication.isSuccess &&
      !publication.isFetching &&
      publication.data?.kind === 'shared' &&
      sameSharedProjectTask(publication.data.publication, sharedTask),
  );
  const sharedDetailsEnabled = requestEnabled && publicationIsCurrent;
  const requirePublication = () => {
    const state = client.getQueryState<ProjectSharedTaskPublication>([
      ...key,
      'publication',
    ]);
    if (
      !requestScope?.isCurrent() ||
      state?.status !== 'success' ||
      state.fetchStatus !== 'idle' ||
      state.data?.kind !== 'shared' ||
      !sameSharedProjectTask(state.data.publication, sharedTask)
    )
      throw new Error('The shared publication is no longer current.');
  };
  const history = useInfiniteQuery({
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page: ProjectSharedTaskHistory) =>
      page.kind === 'available' && page.hasMore ? page.nextCursor : undefined,
    queryKey: [...key, 'history'],
    queryFn: async ({ signal, pageParam }) => {
      requirePublication();
      const captured = requestScope;
      if (!captured?.isCurrent())
        throw new Error('Access to this Station is unavailable.');
      const { readProjectSharedTaskHistory } = await import(
        '@kontourai/station-sdk/project-shared-tasks'
      );
      signal.throwIfAborted();
      if (!captured.isCurrent())
        throw new Error('Your access to this Station changed.');
      const value = await readProjectSharedTaskHistory(
        captured.apiBase,
        project.slug,
        sharedTask.task.id,
        {
          ...(pageParam ? { cursor: pageParam } : {}),
          requestScope: captured,
          requireCredential: captured.requiresEnrolledCredential ?? true,
          signal,
          timeoutMs: 15_000,
          maxResponseBytes: 1024 * 1024,
        },
      );
      if (!captured.isCurrent())
        throw new Error('Your access to this Station changed.');
      requirePublication();
      return value;
    },
    enabled: sharedDetailsEnabled,
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
  const document = useQuery<ProjectSharedTaskDocument>({
    queryKey: [...key, 'document'],
    queryFn: async ({ signal }) => {
      const captured = requestScope;
      if (!captured?.isCurrent())
        throw new Error('Access to this Station is unavailable.');
      const { readProjectSharedTaskDocument } = await import(
        '@kontourai/station-sdk/project-shared-tasks'
      );
      signal.throwIfAborted();
      if (!captured.isCurrent())
        throw new Error('Your access to this Station changed.');
      const value = await readProjectSharedTaskDocument(
        captured.apiBase,
        project.slug,
        sharedTask.task.id,
        {
          requestScope: captured,
          requireCredential: captured.requiresEnrolledCredential ?? true,
          signal,
          timeoutMs: 15_000,
          maxResponseBytes: 1024 * 1024,
        },
      );
      if (!captured.isCurrent())
        throw new Error('Your access to this Station changed.');
      if (
        value.kind === 'snapshot' &&
        (value.project.id !== project.id ||
          value.project.slug !== project.slug ||
          value.task.id !== sharedTask.task.id ||
          value.task.createdAt !== sharedTask.task.createdAt)
      )
        throw new Error('Shared document returned a different Project scope.');
      return value;
    },
    enabled: sharedDetailsEnabled,
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });

  const readDenied = taskHistoryReadDenied(history.error);
  useEffect(() => {
    if (publicationIsCurrent && !readDenied) return;
    const queryKey = [...key, 'history'];
    void client.cancelQueries({ queryKey });
    client.removeQueries({ queryKey });
  }, [client, key, publicationIsCurrent, readDenied]);
  return {
    publication,
    publicationIsCurrent,
    history: { ...history, readDenied },
    document,
  };
}

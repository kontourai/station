import {
  type ProjectTaskRoomBrowserLiveSnapshot,
  parseProjectTaskRoomBrowserLiveSnapshot,
} from '@kontourai/station-contracts/project-task-room-browser';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';
import { _getApiBase } from '../api';
import {
  appendProjectTaskRoomHumanMessage,
  commandProjectTaskRoomLive,
  discoverProjectTaskRoom,
  fetchProjectTaskRoomDocument,
  fetchProjectTaskRoomHistory,
  type ProjectTaskRoomLiveCommand,
  parseAuthoritativeProjectTaskRoomDocumentEvent,
  parseProjectTaskRoomDocumentResponse,
  planProjectTaskRoomEdit,
  submitProjectTaskRoomBatch,
  subscribeProjectTaskRoomEvents,
} from '../client/project-task-rooms';
import { projectTaskRoomQueries } from '../queryFactories';

let taskRoomConnectionSequence = 0;

export type { ProjectTaskRoomBrowserLiveSnapshot } from '@kontourai/station-contracts/project-task-room-browser';
export {
  appendProjectTaskRoomHumanMessage,
  commandProjectTaskRoomLive,
  discoverProjectTaskRoom,
  fetchProjectTaskRoomDocument,
  fetchProjectTaskRoomHistory,
  type ProjectTaskRoomBatchResult,
  type ProjectTaskRoomCapabilities,
  type ProjectTaskRoomDiscovery,
  type ProjectTaskRoomDocument,
  type ProjectTaskRoomEditPlan,
  type ProjectTaskRoomLiveCommand,
  type ProjectTaskRoomLiveResult,
  ProjectTaskRoomProtocolError,
  type ProjectTaskRoomSseEvent,
  planProjectTaskRoomEdit,
  submitProjectTaskRoomBatch,
  subscribeProjectTaskRoomEvents,
} from '../client/project-task-rooms';
export { projectTaskRoomQueries } from '../queryFactories';

type ProjectTaskRoomDocumentSnapshot = Extract<
  import('../client/project-task-rooms').ProjectTaskRoomDocument,
  { readonly kind: 'snapshot' | 'delta' }
>;

/** The small cache seam the settled-edit authority decision needs. */
export interface ProjectTaskRoomDocumentCache {
  setQueryData(
    queryKey: readonly unknown[],
    updater: (current: unknown) => unknown,
  ): unknown;
}

export type ProjectTaskRoomCommittedSettlement = {
  readonly kind: 'committed';
  readonly revision: string;
  readonly text: string;
};

function isDocumentSnapshot(
  value: unknown,
): value is ProjectTaskRoomDocumentSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const record = value as Record<string, unknown>;
    const { kind, revision, text } = record;
    return !!(
      (kind === 'snapshot' || kind === 'delta') &&
      typeof revision === 'string' &&
      revision.length > 0 &&
      typeof text === 'string'
    );
  } catch {
    return false;
  }
}

/**
 * Resolves a committed edit against the canonical document cache without
 * inventing an order for opaque revisions. The identity captured before the
 * mutation is the sole authority for replacing a still-unchanged cache entry.
 */
export function adoptCommittedProjectTaskRoomDocument(
  cache: ProjectTaskRoomDocumentCache,
  taskId: string,
  observed: object,
  settlement: ProjectTaskRoomCommittedSettlement,
): ProjectTaskRoomDocumentSnapshot | undefined {
  let adoption: ProjectTaskRoomDocumentSnapshot | undefined;
  cache.setQueryData(
    projectTaskRoomQueries.document(taskId).queryKey,
    (current) => {
      if (current === observed) {
        adoption = {
          kind: 'snapshot',
          revision: settlement.revision,
          text: settlement.text,
        };
        return adoption;
      }
      if (isDocumentSnapshot(current)) adoption = current;
      return current;
    },
  );
  return adoption;
}

export function useProjectTaskRoomDiscoveryQuery(taskId: string) {
  return useQuery({
    queryKey: projectTaskRoomQueries.discovery(taskId).queryKey,
    enabled: taskId.length > 0,
    queryFn: async () => discoverProjectTaskRoom(await _getApiBase(), taskId),
    staleTime: 10_000,
  });
}
export function useProjectTaskRoomHistoryQuery(taskId: string) {
  return useInfiniteQuery({
    queryKey: projectTaskRoomQueries.history(taskId).queryKey,
    enabled: taskId.length > 0,
    initialPageParam: { cursor: undefined as string | undefined },
    queryFn: async ({ pageParam }) =>
      fetchProjectTaskRoomHistory(await _getApiBase(), taskId, pageParam),
    getNextPageParam: (page) =>
      page.kind === 'available' && page.hasMore
        ? page.nextCursor
          ? { cursor: page.nextCursor }
          : undefined
        : page.kind === 'gap'
          ? { cursor: page.resumeCursor }
          : undefined,
    staleTime: 0,
  });
}
export function useProjectTaskRoomDocumentQuery(taskId: string) {
  return useQuery({
    queryKey: projectTaskRoomQueries.document(taskId).queryKey,
    enabled: taskId.length > 0,
    queryFn: async ({ signal }) =>
      fetchProjectTaskRoomDocument(await _getApiBase(), taskId, undefined, {
        signal,
      }),
    staleTime: 0,
  });
}
export function useAppendProjectTaskRoomHumanMessageMutation(taskId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      proposalId: string;
      text: string;
      occurredAt?: string;
    }) =>
      appendProjectTaskRoomHumanMessage(await _getApiBase(), {
        taskId,
        ...input,
      }),
    onSuccess: () =>
      client.invalidateQueries({
        queryKey: projectTaskRoomQueries.history(taskId).queryKey,
      }),
  });
}
export function usePlanProjectTaskRoomEditMutation(taskId: string) {
  return useMutation({
    mutationFn: async (input: {
      intentId: string;
      desiredText: string;
      selection: { anchor: number; focus: number };
    }) => planProjectTaskRoomEdit(await _getApiBase(), taskId, input),
  });
}
export function useSubmitProjectTaskRoomBatchMutation(taskId: string) {
  return useMutation({
    mutationFn: async (input: { intentId: string; intentDigest: string }) =>
      submitProjectTaskRoomBatch(await _getApiBase(), taskId, input),
  });
}
export function useCommandProjectTaskRoomLiveMutation(taskId: string) {
  return useMutation({
    mutationFn: async (command: ProjectTaskRoomLiveCommand) =>
      commandProjectTaskRoomLive(await _getApiBase(), taskId, command),
  });
}

function cancelProjectTaskRoomDocumentQuery(
  client: ReturnType<typeof useQueryClient>,
  taskId: string,
) {
  return client.cancelQueries(
    { queryKey: projectTaskRoomQueries.document(taskId).queryKey, exact: true },
    { revert: false, silent: true },
  );
}

export async function refetchAuthoritativeProjectTaskRoomDocument(
  client: ReturnType<typeof useQueryClient>,
  taskId: string,
) {
  const queryKey = projectTaskRoomQueries.document(taskId).queryKey;
  await cancelProjectTaskRoomDocumentQuery(client, taskId);
  return client.fetchQuery({
    queryKey,
    staleTime: 0,
    queryFn: async ({ signal }) =>
      fetchProjectTaskRoomDocument(await _getApiBase(), taskId, undefined, {
        headers: { 'Cache-Control': 'no-cache' },
        signal,
      }),
  });
}
/** Ephemeral live state is delivered to the caller; durable queries are only invalidated. */
export function useProjectTaskRoomStream(
  taskId: string,
  callbacks?: {
    onRoom?(value: ProjectTaskRoomBrowserLiveSnapshot): void;
    onDocument?(value: unknown): void;
    /** Parsed ordered document suitable for immediate host-owned application. */
    onAuthoritativeDocument?(value: ProjectTaskRoomDocumentSnapshot): void;
    onTerminal?(): void;
    onCheckpoint?(id: string): void;
    onConnectionCreated?(id: string): void;
    onConnectionClosed?(id: string): void;
  },
  connectionGeneration = 0,
) {
  const client = useQueryClient();
  const callbackRef = useRef(callbacks);
  const connectionRef = useRef<
    ReturnType<typeof subscribeProjectTaskRoomEvents> | undefined
  >(undefined);
  callbackRef.current = callbacks;
  useEffect(() => {
    // Hosts may rotate the one stream instance without changing Task identity.
    void connectionGeneration;
    if (!taskId) return;
    let closed = false;
    let connection:
      | ReturnType<typeof subscribeProjectTaskRoomEvents>
      | undefined;
    void _getApiBase().then((base) => {
      if (closed) return;
      connection = subscribeProjectTaskRoomEvents(base, taskId, {
        onCheckpoint: (id) => callbackRef.current?.onCheckpoint?.(id),
        onEvent: (event) => {
          if (closed) return;
          if (event.kind === 'document') {
            callbackRef.current?.onDocument?.(event.value);
            const document = parseAuthoritativeProjectTaskRoomDocumentEvent(
              event.value,
            );
            if (document?.kind === 'snapshot' || document?.kind === 'delta')
              callbackRef.current?.onAuthoritativeDocument?.(document);
            if (document?.kind === 'gap')
              void refetchAuthoritativeProjectTaskRoomDocument(
                client,
                taskId,
              ).catch(() => {});
            else if (
              document?.kind === 'snapshot' ||
              document?.kind === 'delta'
            ) {
              void cancelProjectTaskRoomDocumentQuery(client, taskId).catch(
                () => {},
              );
              client.setQueryData(
                projectTaskRoomQueries.document(taskId).queryKey,
                document,
              );
            } else
              void client.invalidateQueries({
                queryKey: projectTaskRoomQueries.document(taskId).queryKey,
              });
          } else if (event.kind === 'room') {
            const live = parseProjectTaskRoomBrowserLiveSnapshot(event.value);
            if (live?.scope.taskId === taskId)
              callbackRef.current?.onRoom?.(live);
            else
              void client.invalidateQueries({
                queryKey: projectTaskRoomQueries.history(taskId).queryKey,
              });
          } else if (event.kind === 'snapshot') {
            const live = parseProjectTaskRoomBrowserLiveSnapshot(event.value);
            if (live?.scope.taskId === taskId)
              callbackRef.current?.onRoom?.(live);
            let document:
              | ReturnType<typeof parseProjectTaskRoomDocumentResponse>
              | undefined;
            try {
              document = parseProjectTaskRoomDocumentResponse(
                event.value && typeof event.value === 'object'
                  ? (event.value as { document?: unknown }).document
                  : undefined,
              );
            } catch {
              // Unknown snapshot document shapes remain a cache invalidation,
              // never an optimistic cache write.
            }
            if (document?.kind === 'snapshot' || document?.kind === 'delta')
              callbackRef.current?.onAuthoritativeDocument?.(document);
            if (document) callbackRef.current?.onDocument?.(document);
            void client.invalidateQueries({
              queryKey: projectTaskRoomQueries.discovery(taskId).queryKey,
            });
            void client.invalidateQueries({
              queryKey: projectTaskRoomQueries.history(taskId).queryKey,
            });
            if (document?.kind === 'snapshot' || document?.kind === 'delta')
              client.setQueryData(
                projectTaskRoomQueries.document(taskId).queryKey,
                document,
              );
            else
              void refetchAuthoritativeProjectTaskRoomDocument(client, taskId);
          } else callbackRef.current?.onTerminal?.();
        },
      });
      const connectionId = `${taskId}:${++taskRoomConnectionSequence}`;
      let notifiedClosed = false;
      const notifyClosed = () => {
        if (notifiedClosed) return;
        notifiedClosed = true;
        callbackRef.current?.onConnectionClosed?.(connectionId);
      };
      callbackRef.current?.onConnectionCreated?.(connectionId);
      void connection.completed.finally(notifyClosed);
      connectionRef.current = connection;
    });
    return () => {
      closed = true;
      connection?.close();
      if (connectionRef.current === connection)
        connectionRef.current = undefined;
    };
  }, [client, connectionGeneration, taskId]);
  return useCallback(() => connectionRef.current?.restart(), []);
}

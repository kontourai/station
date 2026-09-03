import { PROJECT_TASK_ROOM_LIVE_HEARTBEAT_INTERVAL_MS } from '@kontourai/station-contracts/project-task-room-browser';
import {
  type ProjectTaskRoomBrowserLiveSnapshot,
  type ProjectTaskRoomDocument,
  type ProjectTaskRoomLiveCommand,
  type ProjectTaskRoomLiveResult,
  useCommandProjectTaskRoomLiveMutation,
  useProjectTaskRoomDiscoveryQuery,
  useProjectTaskRoomStream,
} from '@kontourai/station-sdk/project-task-rooms';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  browserEpochMs,
  emitReconnectCheckpointPerformanceMark,
  emitReconnectStrategyPerformanceMark,
  INTERACTIVE_WORKSPACE_STREAM_RESTART_EVENT,
  registerInteractiveWorkspaceTaskRoomListener,
} from '../performance/interactive-workspace-performance-hooks';

type RoomContextValue = {
  taskId: string;
  discovery: ReturnType<typeof useProjectTaskRoomDiscoveryQuery>;
  stream: 'connecting' | 'live' | 'terminal';
  live?: ProjectTaskRoomBrowserLiveSnapshot;
  ownActorId?: string;
  command(
    command: ProjectTaskRoomLiveCommand,
  ): Promise<ProjectTaskRoomLiveResult>;
  commandPending: boolean;
  subscribeDocument(
    listener: (document: AuthoritativeRoomDocument) => void,
  ): () => void;
};
type AuthoritativeRoomDocument = Extract<
  ProjectTaskRoomDocument,
  { kind: 'snapshot' | 'delta' }
>;
const ProjectTaskRoomContext = createContext<
  ReadonlyMap<string, RoomContextValue>
>(new Map());
const WORKING_REVISION = /^swsr-v1:[0-9a-f]{64}$/;

function reconnectDocument(
  value: unknown,
):
  | { kind: 'delta' | 'snapshot'; revision: string }
  | { kind: 'gap' }
  | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      Object.values(descriptors).some(
        (descriptor) => descriptor.get || descriptor.set,
      )
    )
      return;
    const kind = descriptors.kind?.value;
    const keys = Object.keys(descriptors);
    if (
      (kind === 'delta' || kind === 'snapshot') &&
      keys.length === 3 &&
      keys.every((key) => ['kind', 'revision', 'diagnostic'].includes(key)) &&
      descriptors.diagnostic?.value === true &&
      typeof descriptors.revision?.value === 'string' &&
      WORKING_REVISION.test(descriptors.revision.value)
    )
      return { kind, revision: descriptors.revision.value };
    if (
      kind === 'gap' &&
      keys.length === 3 &&
      keys.every((key) => ['kind', 'floor', 'diagnostic'].includes(key)) &&
      descriptors.diagnostic?.value === true &&
      typeof descriptors.floor?.value === 'string' &&
      WORKING_REVISION.test(descriptors.floor.value)
    )
      return { kind: 'gap' };
  } catch {}
}

/** One task owns one live subscription; panes share its capability truth. */
export function ProjectTaskRoomProvider({
  taskId,
  children,
}: {
  taskId: string;
  children: ReactNode;
}) {
  const parent = useContext(ProjectTaskRoomContext);
  const discovery = useProjectTaskRoomDiscoveryQuery(taskId);
  const mutation = useCommandProjectTaskRoomLiveMutation(taskId);
  const [stream, setStream] =
    useState<RoomContextValue['stream']>('connecting');
  const [live, setLive] = useState<ProjectTaskRoomBrowserLiveSnapshot>();
  const [ownActorId, setOwnActorId] = useState<string>();
  const streamRef = useRef(stream);
  const liveGenerationRef = useRef<string | undefined>(undefined);
  const terminalGenerationRef = useRef<string | undefined>(undefined);
  const commandPendingRef = useRef(mutation.isPending);
  const heartbeatPendingRef = useRef(false);
  const connectionDiagnostics = useRef(new Map<string, () => void>());
  const documentListeners = useRef(
    new Set<(document: AuthoritativeRoomDocument) => void>(),
  );
  streamRef.current = stream;
  liveGenerationRef.current = live?.generation;
  commandPendingRef.current = mutation.isPending;
  const restartStream = useProjectTaskRoomStream(
    taskId,
    {
      onCheckpoint: (id) => {
        if (
          (import.meta.env.MODE === 'test' ||
            import.meta.env.VITE_STATION_INTERACTIVE_WORKSPACE_PERFORMANCE ===
              '1') &&
          WORKING_REVISION.test(id)
        )
          emitReconnectCheckpointPerformanceMark({
            taskId,
            id,
            receivedEpochMs: browserEpochMs(),
          });
      },
      onConnectionCreated: (id) => {
        if (!performanceDiagnosticsEnabled()) return;
        connectionDiagnostics.current.set(
          id,
          registerInteractiveWorkspaceTaskRoomListener(`sse:${id}`),
        );
      },
      onConnectionClosed: (id) => {
        connectionDiagnostics.current.get(id)?.();
        connectionDiagnostics.current.delete(id);
      },
      onRoom: (snapshot) => {
        const terminalGeneration = terminalGenerationRef.current;
        if (
          streamRef.current === 'terminal' &&
          (!terminalGeneration || terminalGeneration === snapshot.generation)
        )
          return;
        streamRef.current = 'live';
        setStream('live');
        setLive(snapshot);
        liveGenerationRef.current = snapshot.generation;
        terminalGenerationRef.current = undefined;
        setOwnActorId(snapshot.viewerActorId);
      },
      onDocument: (value) => {
        if (streamRef.current !== 'terminal') setStream('live');
        if (
          import.meta.env.MODE !== 'test' &&
          import.meta.env.VITE_STATION_INTERACTIVE_WORKSPACE_PERFORMANCE !== '1'
        )
          return;
        const document = reconnectDocument(value);
        if (!document) return;
        emitReconnectStrategyPerformanceMark({
          taskId,
          strategy: document.kind,
          ...('revision' in document ? { revision: document.revision } : {}),
          receivedEpochMs: browserEpochMs(),
        });
      },
      onAuthoritativeDocument: (document) => {
        if (streamRef.current === 'terminal') return;
        for (const listener of documentListeners.current) listener(document);
      },
      onTerminal: () => {
        terminalGenerationRef.current = liveGenerationRef.current;
        streamRef.current = 'terminal';
        setStream('terminal');
        setLive(undefined);
      },
    },
    0,
  );
  useEffect(
    () => () => {
      for (const unregister of connectionDiagnostics.current.values())
        unregister();
      connectionDiagnostics.current.clear();
    },
    [],
  );
  useEffect(() => {
    if (
      import.meta.env.MODE !== 'test' &&
      import.meta.env.VITE_STATION_INTERACTIVE_WORKSPACE_PERFORMANCE !== '1'
    )
      return;
    const restart = (event: Event) => {
      if (event instanceof CustomEvent && event.detail === taskId)
        restartStream();
    };
    window.addEventListener(
      INTERACTIVE_WORKSPACE_STREAM_RESTART_EVENT,
      restart,
    );
    const unregister = registerInteractiveWorkspaceTaskRoomListener(
      `${taskId}:stream-restart`,
    );
    return () => {
      window.removeEventListener(
        INTERACTIVE_WORKSPACE_STREAM_RESTART_EVENT,
        restart,
      );
      unregister();
    };
  }, [restartStream, taskId]);
  const command = useCallback(
    (value: ProjectTaskRoomLiveCommand) => mutation.mutateAsync(value),
    [mutation.mutateAsync],
  );
  const subscribeDocument = useCallback(
    (listener: (document: AuthoritativeRoomDocument) => void) => {
      documentListeners.current.add(listener);
      return () => documentListeners.current.delete(listener);
    },
    [],
  );
  const ownParticipant = ownActorId
    ? live?.participants.some(
        (participant) => participant.actor.actorId === ownActorId,
      )
    : false;
  useEffect(() => {
    if (stream !== 'live' || !ownParticipant) return;
    const timer = window.setInterval(() => {
      if (
        streamRef.current !== 'live' ||
        commandPendingRef.current ||
        heartbeatPendingRef.current
      )
        return;
      heartbeatPendingRef.current = true;
      void Promise.resolve(mutation.mutateAsync({ command: 'heartbeat' }))
        .catch(() => {
          // The authoritative SSE terminal/result owns availability copy.
        })
        .finally(() => {
          heartbeatPendingRef.current = false;
        });
    }, PROJECT_TASK_ROOM_LIVE_HEARTBEAT_INTERVAL_MS);
    const unregister = performanceDiagnosticsEnabled()
      ? registerInteractiveWorkspaceTaskRoomListener(
          `${taskId}:heartbeat-timer`,
        )
      : undefined;
    return () => {
      window.clearInterval(timer);
      unregister?.();
    };
  }, [mutation.mutateAsync, ownParticipant, stream, taskId]);
  const value = useMemo(() => {
    const rooms = new Map(parent);
    rooms.set(taskId, {
      taskId,
      discovery,
      stream,
      live,
      ...(ownActorId ? { ownActorId } : {}),
      command,
      commandPending: mutation.isPending,
      subscribeDocument,
    });
    return rooms;
  }, [
    command,
    discovery,
    live,
    mutation.isPending,
    ownActorId,
    parent,
    stream,
    subscribeDocument,
    taskId,
  ]);
  return (
    <ProjectTaskRoomContext.Provider value={value}>
      {children}
    </ProjectTaskRoomContext.Provider>
  );
}

function performanceDiagnosticsEnabled(): boolean {
  return (
    import.meta.env.MODE === 'test' ||
    import.meta.env.VITE_STATION_INTERACTIVE_WORKSPACE_PERFORMANCE === '1'
  );
}
export function useProjectTaskRoomContext(taskId: string) {
  return useContext(ProjectTaskRoomContext).get(taskId);
}

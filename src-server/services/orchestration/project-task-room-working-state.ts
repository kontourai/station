/** Private worker-backed persistence for one SharedWorkingState document. */
import { Worker } from 'node:worker_threads';
import type {
  TextDocumentOperation,
  WorkingStateSnapshot,
} from '../../domain/shared-working-state.js';
import { DEFAULT_RETAINED_WORKING_STATE_OPERATIONS } from '../../domain/shared-working-state.js';

export interface ProjectTaskRoomWorkingState {
  read(input: {
    scope: { projectId: string; taskId: string; documentId: string };
    after?: string;
  }): Promise<WorkingProjection>;
  settle(input: {
    scope: { projectId: string; taskId: string; documentId: string };
    intentId: string;
    intentDigest: string;
    actorId: string;
    actorLabel?: string;
    actorKind?: 'human' | 'agent';
    publicationCorrelation?: {
      agentSessionId: string;
      runId: string;
    };
    publicationPrincipal?: {
      operatorId: string;
      deviceId: string;
      policyRevision: string;
    };
    epoch: number;
    operations: readonly TextDocumentOperation[];
    /** E2E/reference-only bulk replay seed; never emits immutable evidence. */
    suppressRevisionPublicationForDiagnostic?: true;
    /** Parent-owned authorization fence immediately before SQLite COMMIT. */
    beforeCommit?: () => Promise<boolean>;
  }): Promise<WorkingSettlement>;
  receipt(input: {
    scope: { projectId: string; taskId: string; documentId: string };
    intentId: string;
    intentDigest: string;
  }): Promise<WorkingSettlement | { kind: 'missing' }>;
  readRevisionPublication(input: {
    scope: { projectId: string; taskId: string; documentId: string };
  }): Promise<RevisionPublicationRead>;
  markRevisionPublication(input: {
    scope: { projectId: string; taskId: string; documentId: string };
    intentId: string;
    evidenceRevision: string;
  }): Promise<'marked' | 'duplicate' | 'conflict' | 'unavailable'>;
  removeRevisionPublication(input: {
    scope: { projectId: string; taskId: string; documentId: string };
    intentId: string;
    evidenceRevision: string;
  }): Promise<'removed' | 'missing' | 'conflict' | 'unavailable'>;
  recovery(input: {
    scope: { projectId: string; taskId: string; documentId: string };
    generation: string;
    value: unknown;
  }): Promise<'stored' | 'unavailable'>;
  readRecovery(input: {
    scope: { projectId: string; taskId: string; documentId: string };
  }): Promise<
    | { kind: 'available'; generation: string; value: unknown }
    | { kind: 'unavailable' }
  >;
  agentLifecycle(input: {
    scope: { projectId: string; taskId: string; documentId: string };
    intentId: string;
    value: unknown;
  }): Promise<'stored' | 'unavailable'>;
  readAgentLifecycles(input: {
    scope: { projectId: string; taskId: string; documentId: string };
  }): Promise<readonly { intentId: string; value: unknown }[]>;
  removeAgentLifecycle(input: {
    scope: { projectId: string; taskId: string; documentId: string };
    intentId: string;
  }): Promise<'removed' | 'unavailable'>;
  privateSnapshot(input: {
    scope: { projectId: string; taskId: string; documentId: string };
  }): Promise<WorkingStateSnapshot | undefined>;
  /** Starts SQLite change detection only while at least one room stream needs it. */
  watch(listener: () => void): () => void;
  close(): Promise<void>;
}
export interface WorkingProjection {
  readonly kind: 'snapshot' | 'delta' | 'gap' | 'unavailable';
  readonly revision?: string;
  readonly text?: string;
  readonly floor?: string;
}
export interface WorkingSettlement {
  readonly kind:
    | 'committed'
    | 'duplicate'
    | 'conflict'
    | 'rejected'
    | 'unavailable';
  readonly revision?: string;
  readonly text?: string;
  readonly reason?: 'revision-publication-pending';
}

export interface RevisionPublication {
  readonly intentId: string;
  readonly scope: { projectId: string; taskId: string; documentId: string };
  readonly baseWorkingRevision: string;
  readonly workingRevision: string;
  readonly snapshot: WorkingStateSnapshot;
  readonly actorId: string;
  readonly actorLabel?: string;
  readonly actorKind: 'human' | 'agent';
  readonly principal: {
    readonly operatorId: string;
    readonly deviceId: string;
    readonly policyRevision: string;
  };
  readonly correlation: {
    projectId: string;
    taskId: string;
    agentSessionId?: string;
    runId?: string;
  };
  readonly parentEvidenceRevision?: string;
  readonly evidenceRevision?: string;
  readonly createdAt: string;
}

export type RevisionPublicationRead =
  | { readonly kind: 'available'; readonly publication: RevisionPublication }
  | { readonly kind: 'missing' | 'unavailable' };

export interface ProjectTaskRoomWorkingStateTestOptions {
  /** Test-only worker source for terminal/timeout ownership proofs. */
  workerSourceUrl?: URL;
  /** Test-only bound; production uses the room worker response budget. */
  responseTimeoutMs?: number;
  /** Test-only retained revision window; production uses the domain default. */
  maxRetainedOperations?: number;
  /** Test/reference-only working snapshot allowance; publication stays 512 KiB. */
  maxWorkingSnapshotBytes?: number;
}

const WORKER_RESPONSE_TIMEOUT_MS = 5_000;

export function createProjectTaskRoomWorkingState(
  databasePath: string,
  options: ProjectTaskRoomWorkingStateTestOptions = {},
): ProjectTaskRoomWorkingState {
  const source =
    options.workerSourceUrl ??
    new URL(
      import.meta.url.endsWith('.ts')
        ? './project-task-room-working-state-worker.ts'
        : './project-task-room-working-state-worker.js',
      import.meta.url,
    );
  const responseTimeoutMs =
    options.responseTimeoutMs ?? WORKER_RESPONSE_TIMEOUT_MS;
  const maxRetainedOperations =
    options.maxRetainedOperations ?? DEFAULT_RETAINED_WORKING_STATE_OPERATIONS;
  if (!Number.isSafeInteger(maxRetainedOperations) || maxRetainedOperations < 1)
    throw new Error('room working-state retained-operation limit is malformed');
  const maxWorkingSnapshotBytes = options.maxWorkingSnapshotBytes ?? 512 * 1024;
  if (
    !Number.isSafeInteger(maxWorkingSnapshotBytes) ||
    maxWorkingSnapshotBytes < 512 * 1024 ||
    maxWorkingSnapshotBytes > 16 * 1024 * 1024
  )
    throw new Error('room working-state snapshot limit is malformed');
  const worker = new Worker(source, {
    workerData: {
      databasePath,
      maxRetainedOperations,
      maxWorkingSnapshotBytes,
    },
    ...(source.pathname.endsWith('.ts')
      ? { execArgv: ['--import', 'tsx'] }
      : {}),
  });
  let closed = false;
  let terminal = false;
  let closeSettlement: Promise<void> | undefined;
  let sequence = 0;
  const pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      timer: ReturnType<typeof setTimeout>;
      beforeCommit?: () => Promise<boolean>;
    }
  >();
  const watchers = new Set<() => void>();
  const fail = () => {
    terminal = true;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.resolve({ kind: 'unavailable' });
    }
    pending.clear();
  };
  worker.on('message', (value: any) => {
    if (value?.type === 'changed') {
      for (const watcher of watchers) {
        try {
          watcher();
        } catch {}
      }
      return;
    }
    if (value?.type === 'before-commit' && Number.isSafeInteger(value.id)) {
      const entry = pending.get(value.id);
      void Promise.resolve(entry?.beforeCommit?.() ?? true)
        .then((allowed) => {
          if (!closed && !terminal)
            worker.postMessage({
              type: 'before-commit-result',
              id: value.id,
              allowed: allowed === true,
            });
        })
        .catch(() => {
          if (!closed && !terminal)
            worker.postMessage({
              type: 'before-commit-result',
              id: value.id,
              allowed: false,
            });
        });
      return;
    }
    if (!value || !Number.isSafeInteger(value.id)) return fail();
    const entry = pending.get(value.id);
    if (entry) {
      pending.delete(value.id);
      clearTimeout(entry.timer);
      entry.resolve(value.result);
    }
  });
  worker.on('error', fail);
  worker.on('exit', fail);
  const request = <T>(
    value: unknown,
    beforeCommit?: () => Promise<boolean>,
  ): Promise<T> =>
    new Promise((resolve) => {
      if (closed || terminal) return resolve({ kind: 'unavailable' } as T);
      const id = ++sequence;
      const timer = setTimeout(() => {
        fail();
        void worker.terminate().catch(() => {});
      }, responseTimeoutMs);
      pending.set(id, { resolve, timer, beforeCommit });
      try {
        worker.postMessage({ id, value });
      } catch {
        fail();
      }
    });
  return Object.freeze({
    read: (input: Parameters<ProjectTaskRoomWorkingState['read']>[0]) =>
      request<WorkingProjection>({ type: 'read', ...input }),
    settle: (input: Parameters<ProjectTaskRoomWorkingState['settle']>[0]) => {
      const { beforeCommit, ...value } = input;
      return request<WorkingSettlement>(
        { type: 'settle', ...value },
        beforeCommit,
      );
    },
    receipt: (input: Parameters<ProjectTaskRoomWorkingState['receipt']>[0]) =>
      request<WorkingSettlement | { kind: 'missing' }>({
        type: 'receipt',
        ...input,
      }),
    readRevisionPublication: (
      input: Parameters<
        ProjectTaskRoomWorkingState['readRevisionPublication']
      >[0],
    ) =>
      request<RevisionPublicationRead>({
        type: 'read-revision-publication',
        ...input,
      }),
    markRevisionPublication: async (
      input: Parameters<
        ProjectTaskRoomWorkingState['markRevisionPublication']
      >[0],
    ) =>
      (
        await request<{
          kind: 'marked' | 'duplicate' | 'conflict' | 'unavailable';
        }>({ type: 'mark-revision-publication', ...input })
      ).kind,
    removeRevisionPublication: async (
      input: Parameters<
        ProjectTaskRoomWorkingState['removeRevisionPublication']
      >[0],
    ) =>
      (
        await request<{
          kind: 'removed' | 'missing' | 'conflict' | 'unavailable';
        }>({ type: 'remove-revision-publication', ...input })
      ).kind,
    recovery: async (
      input: Parameters<ProjectTaskRoomWorkingState['recovery']>[0],
    ) =>
      (
        await request<{ kind: 'stored' | 'unavailable' }>({
          type: 'recovery',
          ...input,
        })
      ).kind,
    readRecovery: (
      input: Parameters<ProjectTaskRoomWorkingState['readRecovery']>[0],
    ) =>
      request<
        | { kind: 'available'; generation: string; value: unknown }
        | { kind: 'unavailable' }
      >({ type: 'read-recovery', ...input }),
    agentLifecycle: async (
      input: Parameters<ProjectTaskRoomWorkingState['agentLifecycle']>[0],
    ) =>
      (
        await request<{ kind: 'stored' | 'unavailable' }>({
          type: 'agent-lifecycle',
          ...input,
        })
      ).kind,
    readAgentLifecycles: async (
      input: Parameters<ProjectTaskRoomWorkingState['readAgentLifecycles']>[0],
    ) => {
      const result = await request<{ kind: 'available'; values: unknown[] }>({
        type: 'read-agent-lifecycles',
        ...input,
      });
      return result?.kind === 'available' && Array.isArray(result.values)
        ? (result.values as readonly { intentId: string; value: unknown }[])
        : [];
    },
    removeAgentLifecycle: async (
      input: Parameters<ProjectTaskRoomWorkingState['removeAgentLifecycle']>[0],
    ) =>
      (
        await request<{ kind: 'removed' | 'unavailable' }>({
          type: 'remove-agent-lifecycle',
          ...input,
        })
      ).kind,
    privateSnapshot: (
      input: Parameters<ProjectTaskRoomWorkingState['privateSnapshot']>[0],
    ) =>
      request<WorkingStateSnapshot | undefined>({
        type: 'private-snapshot',
        ...input,
      }),
    watch: (listener: () => void) => {
      watchers.add(listener);
      // Establish the initial read boundary synchronously. A remote commit can
      // otherwise land before the worker receives its watch message and before
      // its first PRAGMA data_version sample.
      try {
        listener();
      } catch {}
      if (watchers.size === 1) worker.postMessage({ value: { type: 'watch' } });
      return () => {
        watchers.delete(listener);
        if (!watchers.size && !closed)
          worker.postMessage({ value: { type: 'unwatch' } });
      };
    },
    close: async () => {
      if (closeSettlement) return closeSettlement;
      closed = true;
      fail();
      closeSettlement = worker
        .terminate()
        .catch(() => undefined)
        .then(() => undefined);
      return closeSettlement;
    },
  });
}

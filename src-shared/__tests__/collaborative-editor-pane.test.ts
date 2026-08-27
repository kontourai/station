import { describe, expect, test, vi } from 'vitest';
import {
  createSharedWorkingState,
  SHARED_WORKING_STATE_SCHEMA_VERSION,
} from '../../src-server/domain/shared-working-state.js';
import {
  COLLABORATIVE_PRESENCE_TTL_MS,
  COLLABORATIVE_ROOM_SCHEMA_VERSION,
  type CollaborativeAuthorityAvailable,
  type CollaborativeCapabilities,
  type CollaborativeDocumentProjection,
  CollaborativeEditorPaneController,
  type CollaborativeOperation,
  type CollaborativePaneScope,
  type CollaborativeParticipant,
  type CollaborativeRoomUpdate,
  type CollaborativeSelection,
  createSharedWorkingStateProjectionAdapter,
  MAX_COLLABORATIVE_PARTICIPANTS,
} from '../collaborative-editor-pane.js';

const NOW = 10_000;
const scope: CollaborativePaneScope = {
  projectId: 'project-a',
  taskId: 'task-a',
  documentId: 'document-a',
};
const allCapabilities: CollaborativeCapabilities = {
  document: { read: true, write: true },
  room: { join: true, read: true, share: true, watch: true, follow: true },
};

function authority(
  capabilities: CollaborativeCapabilities = allCapabilities,
): CollaborativeAuthorityAvailable {
  return {
    state: 'AVAILABLE',
    authorityRevision: 'authority-1',
    actorId: 'human-a',
    scope,
    capabilities,
  };
}

function projection(
  text = 'base',
  workingStateRevision = 'working-revision-1',
): CollaborativeDocumentProjection {
  return { scope, text, workingStateRevision };
}

function insert(
  operationId: string,
  text: string,
  actorId = 'human-a',
  documentId = scope.documentId,
  after: string | null = null,
  parents: readonly string[] = [],
): CollaborativeOperation {
  return {
    schemaVersion: SHARED_WORKING_STATE_SCHEMA_VERSION,
    operationId,
    documentId,
    replicaId: `replica-${actorId}`,
    actor: {
      actorId,
      kind: actorId.startsWith('agent') ? 'agent' : 'human',
    },
    parents,
    authorizationEpoch: 1,
    kind: 'insert',
    after,
    text,
  };
}

function participant(
  actorId = 'agent-b',
  overrides: Partial<CollaborativeParticipant> = {},
): CollaborativeParticipant {
  return {
    actorId,
    kind: 'agent',
    label: actorId,
    surface: {
      state: 'shared-project-task',
      projectId: scope.projectId,
      taskId: scope.taskId,
    },
    expiresAt: NOW + 1_000,
    agentSessionId: `session-${actorId}`,
    runId: `run-${actorId}`,
    followableView: {
      paneId: `pane-${actorId}`,
      documentId: scope.documentId,
      workingStateRevision: 'working-revision-1',
      selection: { anchor: 1, focus: 2 },
      viewportAnchor: 1,
    },
    ...overrides,
  };
}

function roomUpdate(
  sequence: number,
  participants: readonly CollaborativeParticipant[] = [],
  overrides: Partial<CollaborativeRoomUpdate> = {},
): CollaborativeRoomUpdate {
  return {
    schemaVersion: COLLABORATIVE_ROOM_SCHEMA_VERSION,
    kind: 'snapshot',
    generation: 1,
    epoch: 'room-epoch-1',
    sequence,
    scope,
    connection: 'connected',
    participants,
    cursors: [],
    departedActorIds: [],
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function withTestDigest(value: unknown): unknown {
  if (
    value &&
    typeof value === 'object' &&
    (value as { outcome?: unknown }).outcome === 'planned' &&
    (value as { batch?: unknown }).batch &&
    typeof (value as { batch: { digest?: unknown } }).batch.digest !== 'string'
  ) {
    const result = value as { batch: Record<string, unknown> };
    return {
      ...result,
      batch: { ...result.batch, digest: 'a'.repeat(64) },
    };
  }
  return value;
}

function harness(
  options: {
    initialAuthority?: CollaborativeAuthorityAvailable;
    initialProjection?: CollaborativeDocumentProjection;
    transport?: (operation: CollaborativeOperation) => Promise<unknown>;
    applyAccepted?: (operation: CollaborativeOperation) => unknown;
    resync?: (signal: AbortSignal) => Promise<unknown>;
    resolveRevision?: (request: {
      evidenceRevisionId: string;
      scope: CollaborativePaneScope;
      correlationId: string;
      signal: AbortSignal;
    }) => Promise<unknown>;
    planEdit?: (input: unknown) => unknown;
    projectPending?: (input: unknown) => unknown;
    transformSelection?: (input: unknown) => unknown;
    cursorRate?: number;
    principal?: (input: {
      actorId: string;
      scope: CollaborativePaneScope;
      workingStateRevision: string;
    }) => unknown;
    synchronousRoomUpdate?: unknown;
    synchronousRoomUpdates?: readonly unknown[];
    targetProjection?: (input: {
      scope: CollaborativePaneScope;
      workingStateRevision: string;
    }) => unknown;
    roomStream?: () => unknown;
    closeThrows?: boolean;
    scheduleThrows?: boolean;
    onRequestSurfaceJoin?: () => unknown;
    onNavigate?: () => unknown;
  } = {},
) {
  let currentAuthority: unknown =
    options.initialAuthority ?? authority(allCapabilities);
  let currentProjection = options.initialProjection ?? projection();
  let roomListener: ((update: unknown) => void) | null = null;
  let editorSequence = 0;
  const optimisticText = new Map<string, string>();
  let currentNow = NOW;
  let scheduled:
    | { deadline: number; callback: () => void; canceled: boolean }
    | undefined;
  const subscribe = vi.fn((listener: (update: unknown) => void) => {
    roomListener = listener;
    if (options.synchronousRoomUpdate !== undefined)
      listener(options.synchronousRoomUpdate);
    for (const update of options.synchronousRoomUpdates ?? []) listener(update);
    return vi.fn(() => {
      roomListener = null;
      if (options.closeThrows) throw new Error('close failed');
    });
  });
  const submit = vi.fn(
    async (batch: {
      intentId: string;
      digest: string;
      operations: readonly CollaborativeOperation[];
    }) => {
      const raw = options.transport
        ? await options.transport(batch.operations[0]!)
        : {
            outcome: 'committed',
            operationId: batch.operations[0]?.operationId,
          };
      if (
        raw &&
        typeof raw === 'object' &&
        (raw as { outcome?: unknown }).outcome === 'committed'
      )
        return {
          outcome: 'accepted',
          intentId: batch.intentId,
          digest: batch.digest,
        };
      if (
        raw &&
        typeof raw === 'object' &&
        ['refused', 'indeterminate'].includes(
          String((raw as { outcome?: unknown }).outcome),
        )
      ) {
        const entry = raw as {
          outcome: 'refused' | 'indeterminate';
          reason?: string;
        };
        return {
          outcome: entry.outcome,
          intentId: batch.intentId,
          digest: batch.digest,
          reason: entry.reason ?? 'test outcome',
        };
      }
      return raw;
    },
  );
  const applyAccepted = vi.fn(
    options.applyAccepted ??
      ((operation: CollaborativeOperation) => ({
        outcome: 'applied',
        operationId: operation.operationId,
        operationDeferred: false,
        releasedOperationIds: [],
        projection: currentProjection,
      })),
  );
  const resync = vi.fn(
    options.resync ??
      (async () => ({ outcome: 'available', projection: currentProjection })),
  );
  const resolveRevision = vi.fn(
    options.resolveRevision ??
      (async () => ({ state: 'UNAVAILABLE', reason: 'not configured' })),
  );
  const navigate = vi.fn(
    options.onNavigate ?? (() => ({ outcome: 'accepted' })),
  );
  const requestSurfaceJoin = vi.fn(
    options.onRequestSurfaceJoin ?? (() => ({ outcome: 'accepted' })),
  );
  const share = vi.fn(() => ({ outcome: 'accepted' }));
  const publish = vi.fn(() => ({ outcome: 'accepted' }));
  const requestFreshSignals = vi.fn(() => ({ outcome: 'accepted' }));
  const controller = new CollaborativeEditorPaneController({
    paneId: 'pane-local',
    scope,
    localActorId: 'human-a',
    correlationId: 'correlation-a',
    authority: { current: () => currentAuthority },
    principalAuthority: {
      resolve:
        options.principal ??
        (({ actorId, scope: principalScope, workingStateRevision }) => ({
          state: 'AVAILABLE',
          actorId,
          kind: actorId.startsWith('agent') ? 'agent' : 'human',
          label: actorId,
          scope: principalScope,
          workingStateRevision,
          ...(actorId.startsWith('agent')
            ? {
                agentSessionId: `session-${actorId}`,
                runId: `run-${actorId}`,
              }
            : {}),
        })),
    },
    targetProjectionAuthority: {
      resolve:
        options.targetProjection ??
        (({ scope: targetScope, workingStateRevision }) => ({
          state: 'AVAILABLE',
          scope: targetScope,
          workingStateRevision,
          textLength: 10_000,
        })),
    },
    navigationCapabilityAuthority: {
      mint: ({ authorityRevision, actorId, scope: targetScope, reason }) => ({
        state: 'AVAILABLE',
        capability: `cap:${authorityRevision}:${actorId}:${targetScope.documentId}:${reason}`,
      }),
    },
    roomStreamAuthority: {
      current:
        options.roomStream ??
        (() => ({
          state: 'AVAILABLE',
          scope,
          generation: 1,
          epoch: 'room-epoch-1',
        })),
    },
    convergence: {
      projection: () => ({
        outcome: 'available',
        projection: currentProjection,
      }),
      applyAccepted,
      resync,
    },
    editing: {
      plan: (raw: unknown) => {
        const result = options.planEdit
          ? options.planEdit(raw)
          : (() => {
              const input = raw as {
                desiredText: string;
                selection: { anchor: number; focus: number };
              };
              const intentId = `intent-${++editorSequence}`;
              optimisticText.set(intentId, input.desiredText);
              return {
                outcome: 'planned',
                batch: {
                  intentId,
                  baseRevision: currentProjection.workingStateRevision,
                  operations: [
                    insert(
                      `local-${editorSequence}`,
                      input.desiredText || 'delete',
                    ),
                  ],
                  optimistic: {
                    text: input.desiredText,
                    workingStateRevision: `optimistic-${editorSequence}`,
                  },
                  selection: input.selection,
                },
              };
            })();
        return withTestDigest(result) as never;
      },
      projectPending: options.projectPending
        ? (input) => options.projectPending!(input) as never
        : (raw: unknown) => {
            const input = raw as {
              pending: readonly { intentId: string }[];
            };
            const last = input.pending.at(-1);
            return {
              outcome: 'projected',
              text: last
                ? (optimisticText.get(last.intentId) ?? currentProjection.text)
                : currentProjection.text,
              workingStateRevision: last
                ? `optimistic-${last.intentId}`
                : currentProjection.workingStateRevision,
            };
          },
      transformSelection: options.transformSelection
        ? (input) => options.transformSelection!(input) as never
        : (raw: unknown) => {
            const input = raw as {
              selection: { anchor: number; focus: number };
              pending: readonly { intentId: string }[];
            };
            const last = input.pending.at(-1);
            const text = last
              ? (optimisticText.get(last.intentId) ?? currentProjection.text)
              : currentProjection.text;
            return {
              outcome: 'projected',
              text,
              workingStateRevision: last
                ? `optimistic-${last.intentId}`
                : currentProjection.workingStateRevision,
              selection: input.selection,
            };
          },
    },
    transport: { submitBatch: submit },
    room: { subscribe, requestFreshSignals },
    cursorOutput: { maxPerSecond: options.cursorRate ?? 20, publish },
    host: { joinAndNavigate: navigate, requestSurfaceJoin, share },
    revisionResolver: { resolve: resolveRevision },
    now: () => currentNow,
    scheduler: {
      schedule: (delayMs, callback) => {
        if (options.scheduleThrows) throw new Error('schedule failed');
        const entry = {
          deadline: currentNow + delayMs,
          callback,
          canceled: false,
        };
        scheduled = entry;
        return () => {
          entry.canceled = true;
        };
      },
    },
  });
  return {
    controller,
    subscribe,
    submit,
    applyAccepted,
    resync,
    resolveRevision,
    navigate,
    requestSurfaceJoin,
    share,
    publish,
    requestFreshSignals,
    emitRoom: (update: unknown) => roomListener?.(update),
    setAuthority: (next: unknown) => {
      currentAuthority = next;
    },
    setProjection: (next: CollaborativeDocumentProjection) => {
      currentProjection = next;
    },
    pumpExpiry: () => {
      if (!scheduled || scheduled.canceled) return;
      currentNow = scheduled.deadline;
      const callback = scheduled.callback;
      scheduled = undefined;
      callback();
    },
  };
}

describe('CollaborativeEditorPaneController', () => {
  test('keeps duplicate deferred pending and settles more than 32 only from exact released IDs', () => {
    const ports = createSharedWorkingState({ scope });
    const adapter = createSharedWorkingStateProjectionAdapter({
      live: ports.live,
      recovery: ports.recovery,
    });
    let childSequence = 0;
    const childOptimistic = new Map<string, string>();
    const h = harness({
      initialProjection: {
        scope,
        text: '',
        workingStateRevision: ports.live.revision,
      },
      transport: () => new Promise(() => undefined),
      applyAccepted: (entry) => adapter.applyAccepted(entry),
      planEdit: (raw) => {
        const input = raw as {
          desiredText: string;
          currentText: string;
          selection: { anchor: number; focus: number };
        };
        const index = childSequence++;
        const intentId = `child-intent-${String(index).padStart(2, '0')}`;
        childOptimistic.set(intentId, input.desiredText);
        const operation = insert(
          `child-${String(index).padStart(2, '0')}`,
          String.fromCharCode(65 + (index % 26)),
          'human-a',
          scope.documentId,
          'root:0',
          ['root'],
        );
        return {
          outcome: 'planned',
          batch: {
            intentId,
            baseRevision: ports.live.revision,
            operations: [operation],
            optimistic: {
              text: input.desiredText,
              workingStateRevision: `optimistic-${index}`,
            },
            selection: input.selection,
          },
        };
      },
      projectPending: (raw) => {
        const pending = (raw as { pending: readonly { intentId: string }[] })
          .pending;
        const last = pending.at(-1);
        return {
          outcome: 'projected',
          text: last ? (childOptimistic.get(last.intentId) ?? '') : '',
          workingStateRevision: last
            ? `optimistic-${last.intentId}`
            : ports.live.revision,
        };
      },
    });
    const children: CollaborativeOperation[] = [];
    for (let index = 0; index < 40; index += 1) {
      h.controller.dispatch({
        type: 'local-input',
        text: `${h.controller.snapshot().displayText}x`,
        selection: { anchor: index + 1, focus: index + 1 },
      });
      const child = insert(
        `child-${String(index).padStart(2, '0')}`,
        String.fromCharCode(65 + (index % 26)),
        'human-a',
        scope.documentId,
        'root:0',
        ['root'],
      );
      children.push(child);
      h.controller.dispatch({ type: 'remote-accepted', operation: child });
    }
    expect(h.controller.snapshot().pendingIntents).toHaveLength(40);
    h.controller.dispatch({
      type: 'remote-accepted',
      operation: children[0],
    });
    expect(h.controller.snapshot().pendingIntents).toHaveLength(40);

    h.controller.dispatch({
      type: 'remote-accepted',
      operation: insert('root', 'R', 'agent-root'),
    });
    expect(h.controller.snapshot().pendingIntents).toHaveLength(0);
    expect(h.controller.snapshot().displayText).toBe(ports.live.text());
    expect(ports.live.text()).toHaveLength(41);
  });

  test('does not subscribe, project room data, resync, or restore without current read+room authority', async () => {
    const h = harness({
      initialAuthority: authority({
        ...allCapabilities,
        document: { read: false, write: false },
      }),
    });
    expect(h.subscribe).not.toHaveBeenCalled();
    h.controller.dispatch({
      type: 'room',
      update: roomUpdate(1, [participant()]),
    });
    h.controller.dispatch({ type: 'resync' });
    h.controller.dispatch({
      type: 'restore-evidence-revision',
      evidenceRevisionId: 'evidence-1',
    });
    await Promise.resolve();
    expect(h.controller.snapshot()).toMatchObject({
      mode: 'unavailable',
      participants: [],
      displayText: '',
    });
    expect(h.resync).not.toHaveBeenCalled();
    expect(h.resolveRevision).not.toHaveBeenCalled();
  });

  test('clears room projection on dynamic revocation while retaining read-only document truth', () => {
    const h = harness();
    h.emitRoom(roomUpdate(1, [participant()]));
    expect(h.controller.snapshot().participants).toHaveLength(1);
    h.setAuthority(
      authority({
        document: { read: true, write: false },
        room: {
          join: false,
          read: false,
          share: false,
          watch: false,
          follow: false,
        },
      }),
    );
    h.controller.dispatch({ type: 'authority-changed' });
    expect(h.controller.snapshot()).toMatchObject({
      mode: 'read-only',
      roomConnection: 'disconnected',
      participants: [],
      displayText: 'base',
    });
  });

  test('read revocation masks attribution and target identity and renewed room authority starts clean', () => {
    const h = harness();
    h.emitRoom(roomUpdate(1, [participant()]));
    h.controller.dispatch({ type: 'follow', actorId: 'agent-b' });
    h.controller.dispatch({
      type: 'remote-accepted',
      operation: insert('accepted-agent', 'x', 'agent-b'),
    });
    expect(h.controller.snapshot().acceptedAttributions).toHaveLength(1);
    h.setAuthority(
      authority({
        document: { read: false, write: false },
        room: allCapabilities.room,
      }),
    );
    h.controller.dispatch({ type: 'authority-changed' });
    expect(h.controller.snapshot()).toMatchObject({
      acceptedAttributions: [],
      participants: [],
      cursors: [],
      watch: { state: 'off' },
    });
    h.setAuthority(authority());
    h.controller.dispatch({ type: 'authority-changed' });
    expect(h.controller.snapshot()).toMatchObject({
      participants: [],
      watch: { state: 'off' },
    });
  });

  test('rejects a foreign shared Project/Task surface before exposure or follow', () => {
    const h = harness();
    h.emitRoom(
      roomUpdate(1, [
        participant('agent-b', {
          surface: {
            state: 'shared-project-task',
            projectId: 'foreign',
            taskId: scope.taskId,
          },
        }),
      ]),
    );
    expect(h.controller.snapshot()).toMatchObject({
      roomConnection: 'stale',
      participants: [],
    });
    h.controller.dispatch({ type: 'follow', actorId: 'agent-b' });
    expect(h.navigate).not.toHaveBeenCalled();
  });

  test('settles A/B refusals by exact operation ID and recomputes the overlay in intent order', async () => {
    const a = deferred<unknown>();
    const b = deferred<unknown>();
    const h = harness({
      transport: (operation) =>
        operation.operationId === 'local-1' ? a.promise : b.promise,
    });
    h.controller.dispatch({
      type: 'local-input',
      text: 'A',
      selection: { anchor: 1, focus: 1 },
    });
    h.controller.dispatch({
      type: 'local-input',
      text: 'B',
      selection: { anchor: 1, focus: 1 },
    });
    expect(h.controller.snapshot()).toMatchObject({
      displayText: 'B',
      pendingIntents: [{ intentId: 'intent-1' }, { intentId: 'intent-2' }],
    });
    b.resolve({
      outcome: 'refused',
      operationId: 'local-2',
      reason: 'B denied',
    });
    await vi.waitFor(() =>
      expect(h.controller.snapshot().pendingIntents).toHaveLength(1),
    );
    expect(h.controller.snapshot().displayText).toBe('A');
    a.resolve({
      outcome: 'refused',
      operationId: 'local-1',
      reason: 'A denied',
    });
    await vi.waitFor(() =>
      expect(h.controller.snapshot().pendingIntents).toHaveLength(0),
    );
    expect(h.controller.snapshot()).toMatchObject({
      displayText: 'base',
      mode: 'rejected-write',
      rejectedWrites: [
        {
          operationId: 'intent-1',
          reason: 'Operation was refused before projection.',
        },
        {
          operationId: 'intent-2',
          reason: 'Operation was refused before projection.',
        },
      ],
    });
  });

  test('retains one possible-effect batch and retries the identical atomic batch', async () => {
    const attempts: string[] = [];
    const remove = insert('batch-delete', 'delete');
    const add = insert('batch-insert', 'insert');
    const h = harness({
      planEdit: (raw) => {
        const input = raw as {
          desiredText: string;
          selection: { anchor: number; focus: number };
        };
        return {
          outcome: 'planned',
          batch: {
            intentId: 'batch-intent',
            baseRevision: 'working-revision-1',
            operations: [remove, add],
            optimistic: {
              text: input.desiredText,
              workingStateRevision: 'optimistic-batch',
            },
            selection: input.selection,
          },
        };
      },
      projectPending: () => ({
        outcome: 'projected',
        text: 'batch-preview',
        workingStateRevision: 'optimistic-batch',
      }),
      transport: async (operation) => {
        attempts.push(operation.operationId);
        return {
          outcome: 'indeterminate',
          operationId: operation.operationId,
          reason: 'postcommit unknown',
        };
      },
    });
    h.controller.dispatch({
      type: 'local-input',
      text: 'batch-preview',
      selection: { anchor: 2, focus: 2 },
    });
    await vi.waitFor(() =>
      expect(h.controller.snapshot().pendingIntents[0]).toMatchObject({
        intentId: 'batch-intent',
        operationCount: 2,
        states: {
          committedAwaitingProjection: 0,
          indeterminate: 2,
        },
      }),
    );
    h.controller.dispatch({
      type: 'retry-pending',
      intentId: 'batch-intent',
    });
    await vi.waitFor(() => expect(attempts).toHaveLength(2));
    expect(attempts).toEqual(['batch-delete', 'batch-delete']);
    expect(h.submit.mock.calls[0]?.[0]).toEqual(h.submit.mock.calls[1]?.[0]);
    h.controller.dispatch({ type: 'remote-accepted', operation: remove });
    expect(h.controller.snapshot().pendingIntents[0]).toMatchObject({
      states: { committedAwaitingProjection: 0, indeterminate: 1 },
    });
  });

  test('quarantines a refusal that contradicts a projected replacement member', async () => {
    const settlement = deferred<unknown>();
    const remove = insert('contradiction-delete', 'delete');
    const add = insert('contradiction-insert', 'insert');
    const h = harness({
      planEdit: (raw) => {
        const input = raw as {
          desiredText: string;
          selection: CollaborativeSelection;
        };
        return {
          outcome: 'planned',
          batch: {
            intentId: 'contradiction-intent',
            baseRevision: 'working-revision-1',
            operations: [remove, add],
            optimistic: {
              text: input.desiredText,
              workingStateRevision: 'optimistic-contradiction',
            },
            selection: input.selection,
          },
        };
      },
      transport: () => settlement.promise,
    });
    h.controller.dispatch({
      type: 'local-input',
      text: 'replacement',
      selection: { anchor: 2, focus: 2 },
    });
    await vi.waitFor(() => expect(h.submit).toHaveBeenCalledOnce());
    h.controller.dispatch({ type: 'remote-accepted', operation: remove });
    settlement.resolve({
      outcome: 'refused',
      operationId: remove.operationId,
      reason: 'contradictory refusal',
    });
    await vi.waitFor(() => expect(h.controller.snapshot().mode).toBe('stale'));
    expect(h.controller.snapshot().pendingIntents[0]).toMatchObject({
      states: { indeterminate: 1 },
    });
  });

  test('retains an all-projected replacement until its deferred batch response settles', async () => {
    const settlement = deferred<unknown>();
    const remove = insert('late-delete', 'delete');
    const add = insert('late-insert', 'insert');
    const h = harness({
      planEdit: (raw) => {
        const input = raw as {
          desiredText: string;
          selection: CollaborativeSelection;
        };
        return {
          outcome: 'planned',
          batch: {
            intentId: 'late-response-intent',
            baseRevision: 'working-revision-1',
            operations: [remove, add],
            optimistic: {
              text: input.desiredText,
              workingStateRevision: 'optimistic-late-response',
            },
            selection: input.selection,
          },
        };
      },
      transport: () => settlement.promise,
    });
    h.controller.dispatch({
      type: 'local-input',
      text: 'replacement',
      selection: { anchor: 2, focus: 2 },
    });
    await vi.waitFor(() => expect(h.submit).toHaveBeenCalledOnce());
    h.controller.dispatch({ type: 'remote-accepted', operation: remove });
    h.controller.dispatch({ type: 'remote-accepted', operation: add });
    expect(h.controller.snapshot().pendingIntents).toHaveLength(1);
    expect(h.submit).toHaveBeenCalledOnce();
    settlement.resolve({
      outcome: 'refused',
      operationId: remove.operationId,
      reason: 'late contradictory refusal',
    });
    await vi.waitFor(() => expect(h.controller.snapshot().mode).toBe('stale'));
    expect(h.controller.snapshot().pendingIntents).toHaveLength(1);
  });

  test('quarantines an accepted batch whose member is later rejected', async () => {
    const remove = insert('accepted-rejected-delete', 'delete');
    const add = insert('accepted-rejected-insert', 'insert');
    const h = harness({
      planEdit: (raw) => {
        const input = raw as {
          desiredText: string;
          selection: CollaborativeSelection;
        };
        return {
          outcome: 'planned',
          batch: {
            intentId: 'accepted-rejected-intent',
            baseRevision: 'working-revision-1',
            operations: [remove, add],
            optimistic: {
              text: input.desiredText,
              workingStateRevision: 'optimistic-accepted-rejected',
            },
            selection: input.selection,
          },
        };
      },
      applyAccepted: (operation) => ({
        outcome:
          operation.operationId === remove.operationId ? 'rejected' : 'applied',
        operationId: operation.operationId,
        ...(operation.operationId === remove.operationId
          ? { reason: 'operation rejected' }
          : { operationDeferred: false, releasedOperationIds: [] }),
        projection: projection(),
      }),
    });
    h.controller.dispatch({
      type: 'local-input',
      text: 'replacement',
      selection: { anchor: 2, focus: 2 },
    });
    await vi.waitFor(() =>
      expect(
        h.controller.snapshot().pendingIntents[0]?.states
          .committedAwaitingProjection,
      ).toBe(2),
    );
    h.controller.dispatch({ type: 'remote-accepted', operation: remove });
    expect(h.controller.snapshot().mode).toBe('stale');
    expect(h.controller.snapshot().pendingIntents).toHaveLength(1);
  });

  test('refuses an atomic batch without a delete-only committed replacement state', async () => {
    const remove = insert('refused-delete', 'delete');
    const submitted: string[] = [];
    const h = harness({
      planEdit: (raw) => {
        const input = raw as {
          desiredText: string;
          selection: { anchor: number; focus: number };
        };
        return {
          outcome: 'planned',
          batch: {
            intentId: 'refused-batch',
            baseRevision: 'working-revision-1',
            operations: [remove],
            optimistic: {
              text: input.desiredText,
              workingStateRevision: 'optimistic-refused',
            },
            selection: input.selection,
          },
        };
      },
      projectPending: (raw) => {
        const { pending } = raw as { pending: readonly unknown[] };
        return {
          outcome: 'projected',
          text: pending.length > 0 ? 'preview' : 'base',
          workingStateRevision: 'optimistic-refused',
        };
      },
      transport: async (operation) => {
        submitted.push(operation.operationId);
        return {
          outcome: 'refused',
          operationId: operation.operationId,
          reason: 'definite refusal',
        };
      },
    });
    h.controller.dispatch({
      type: 'local-input',
      text: 'preview',
      selection: { anchor: 2, focus: 2 },
    });
    await vi.waitFor(() => expect(h.submit).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(h.controller.snapshot().pendingIntents).toHaveLength(0),
    );
    expect(submitted).toEqual(['refused-delete']);
    expect(h.submit.mock.calls[0]?.[0]?.operations).toHaveLength(1);
    expect(h.controller.snapshot().displayText).toBe('base');
    expect(h.controller.snapshot().rejectedWrites[0]?.reason).toContain(
      'refused before projection',
    );
  });

  test('keeps unrelated pending and rejection truth across accepted remote operations', async () => {
    const local = deferred<unknown>();
    const h = harness({ transport: () => local.promise });
    h.controller.dispatch({
      type: 'local-input',
      text: 'draft',
      selection: { anchor: 2, focus: 2 },
    });
    h.setProjection(projection('remote', 'working-revision-2'));
    h.controller.dispatch({
      type: 'remote-accepted',
      operation: insert('remote-1', 'remote', 'agent-b'),
    });
    expect(h.controller.snapshot()).toMatchObject({
      displayText: 'draft',
      pendingIntents: [{ intentId: 'intent-1' }],
    });
    local.resolve({
      outcome: 'refused',
      operationId: 'local-1',
      reason: 'revoked',
    });
    await vi.waitFor(() =>
      expect(h.controller.snapshot().mode).toBe('rejected-write'),
    );
    h.setProjection(projection('new remote', 'working-revision-3'));
    h.controller.dispatch({
      type: 'remote-accepted',
      operation: insert('remote-2', 'new remote', 'agent-b'),
    });
    expect(h.controller.snapshot()).toMatchObject({
      displayText: 'new remote',
      mode: 'rejected-write',
      rejectedWrites: [
        {
          operationId: 'intent-1',
          reason: 'Operation was refused before projection.',
        },
      ],
    });
  });

  test('keeps a malformed/throwing convergence ingress retryable and handles wrong-document rejection', () => {
    let faults = true;
    const h = harness({
      applyAccepted: (operation) => {
        if (faults) throw new Error('offline');
        return {
          outcome: 'applied',
          operationId: operation.operationId,
          operationDeferred: false,
          releasedOperationIds: [],
          projection: projection('recovered', 'working-revision-2'),
        };
      },
    });
    const operation = insert('remote-retry', 'r', 'agent-b');
    h.controller.dispatch({ type: 'remote-accepted', operation });
    expect(h.controller.snapshot().mode).toBe('stale');
    faults = false;
    h.controller.dispatch({ type: 'remote-accepted', operation });
    expect(h.controller.snapshot().displayText).toBe('recovered');

    const wrong = harness({
      applyAccepted: (entry) => ({
        outcome: 'rejected',
        operationId: entry.operationId,
        reason: 'wrong_document',
        projection: projection(),
      }),
    });
    wrong.controller.dispatch({
      type: 'remote-accepted',
      operation: insert('wrong', 'x', 'agent-b', 'foreign-document'),
    });
    expect(wrong.controller.snapshot().lastUnavailable).toBe('wrong_document');
  });

  test('permits local solo read+write without a room join grant', async () => {
    const h = harness({
      initialAuthority: authority({
        document: { read: true, write: true },
        room: {
          join: false,
          read: false,
          share: false,
          watch: false,
          follow: false,
        },
      }),
    });
    expect(h.controller.snapshot().mode).toBe('solo');
    h.controller.dispatch({
      type: 'local-input',
      text: 'solo edit',
      selection: { anchor: 2, focus: 2 },
    });
    await vi.waitFor(() => expect(h.submit).toHaveBeenCalledOnce());
    expect(h.controller.snapshot()).toMatchObject({
      displayText: 'solo edit',
      mode: 'pending',
    });
    h.setProjection(projection('solo edit', 'working-solo-accepted'));
    h.controller.dispatch({
      type: 'remote-accepted',
      operation: insert('local-1', 'solo edit'),
    });
    expect(h.controller.snapshot()).toMatchObject({
      displayText: 'solo edit',
      pendingIntents: [],
      mode: 'solo',
    });
  });

  test('allows solo document resync without room authority', async () => {
    const h = harness({
      initialAuthority: authority({
        document: { read: true, write: true },
        room: {
          join: false,
          read: false,
          share: false,
          watch: false,
          follow: false,
        },
      }),
      resync: async () => ({
        outcome: 'available',
        projection: projection('solo synced', 'working-solo-2'),
      }),
    });
    h.controller.dispatch({ type: 'resync' });
    await vi.waitFor(() =>
      expect(h.controller.snapshot().displayText).toBe('solo synced'),
    );
    expect(h.controller.snapshot().mode).toBe('solo');
  });

  test('dynamic write revocation prevents new writes without discarding possible-effect intent', async () => {
    const unsettled = deferred<unknown>();
    const h = harness({ transport: () => unsettled.promise });
    h.controller.dispatch({
      type: 'local-input',
      text: 'possible',
      selection: { anchor: 2, focus: 2 },
    });
    await vi.waitFor(() => expect(h.submit).toHaveBeenCalledOnce());
    h.setAuthority(
      authority({ ...allCapabilities, document: { read: true, write: false } }),
    );
    h.controller.dispatch({ type: 'authority-changed' });
    h.controller.dispatch({
      type: 'local-input',
      text: 'blocked',
      selection: { anchor: 1, focus: 1 },
    });
    expect(h.submit).toHaveBeenCalledOnce();
    expect(h.controller.snapshot()).toMatchObject({
      mode: 'read-only',
      pendingIntents: [{ intentId: 'intent-1' }],
    });
  });

  test('keeps a synchronously revoked planned batch definitely uninvoked', async () => {
    const h = harness();
    h.controller.dispatch({
      type: 'local-input',
      text: 'never-sent',
      selection: { anchor: 2, focus: 2 },
    });
    h.setAuthority(
      authority({ ...allCapabilities, document: { read: true, write: false } }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(h.submit).not.toHaveBeenCalled();
    expect(h.controller.snapshot()).toMatchObject({
      pendingIntents: [],
      rejectedWrites: [
        expect.objectContaining({
          reason: expect.stringContaining('not invoked'),
        }),
      ],
    });
    expect(
      JSON.stringify(h.controller.snapshot().pendingIntents),
    ).not.toContain('possibleEffect');
    expect(
      JSON.stringify(h.controller.snapshot().pendingIntents),
    ).not.toContain('indeterminate');
  });

  test('never re-exposes a pending overlay when read is revoked before transport settlement', async () => {
    const settlement = deferred<unknown>();
    const h = harness({ transport: () => settlement.promise });
    h.controller.dispatch({
      type: 'local-input',
      text: 'private draft',
      selection: { anchor: 2, focus: 2 },
    });
    await vi.waitFor(() => expect(h.submit).toHaveBeenCalledOnce());
    h.setAuthority(
      authority({
        document: { read: false, write: false },
        room: allCapabilities.room,
      }),
    );
    h.controller.dispatch({ type: 'authority-changed' });
    settlement.resolve({
      outcome: 'indeterminate',
      operationId: 'local-1',
      reason: 'unknown',
    });
    await vi.waitFor(() =>
      expect(h.controller.snapshot()).toMatchObject({
        mode: 'unavailable',
        displayText: '',
        pendingIntents: [
          {
            intentId: 'intent-1',
            states: { indeterminate: 1 },
          },
        ],
      }),
    );
    const publicSnapshot = JSON.stringify(h.controller.snapshot());
    expect(publicSnapshot).not.toContain('private draft');
    expect(publicSnapshot).not.toContain('local-1');
    expect(publicSnapshot).not.toContain('base');
  });

  test('fences stale restore responses and verifies evidence ID, scope, correlation, and working revision', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const h = harness({
      resolveRevision: (request) =>
        request.evidenceRevisionId === 'evidence-old'
          ? first.promise
          : second.promise,
    });
    h.controller.dispatch({
      type: 'restore-evidence-revision',
      evidenceRevisionId: 'evidence-old',
    });
    h.controller.dispatch({
      type: 'restore-evidence-revision',
      evidenceRevisionId: 'evidence-new',
    });
    second.resolve({
      state: 'AVAILABLE',
      evidenceRevisionId: 'evidence-new',
      scope,
      correlationId: 'correlation-a',
      workingStateRevision: 'working-new',
      projection: projection('new', 'working-new'),
    });
    await vi.waitFor(() =>
      expect(h.controller.snapshot().displayText).toBe('new'),
    );
    first.resolve({
      state: 'AVAILABLE',
      evidenceRevisionId: 'evidence-old',
      scope,
      correlationId: 'correlation-a',
      workingStateRevision: 'working-old',
      projection: projection('old', 'working-old'),
    });
    await Promise.resolve();
    expect(h.controller.snapshot().displayText).toBe('new');

    const mismatch = harness({
      resolveRevision: async () => ({
        state: 'AVAILABLE',
        evidenceRevisionId: 'forged',
        scope,
        correlationId: 'correlation-a',
        workingStateRevision: 'working-x',
        projection: projection('forged', 'working-x'),
      }),
    });
    mismatch.controller.dispatch({
      type: 'restore-evidence-revision',
      evidenceRevisionId: 'evidence-x',
    });
    await vi.waitFor(() =>
      expect(mismatch.controller.snapshot().mode).toBe('stale'),
    );
    expect(mismatch.controller.snapshot().displayText).toBe('base');
  });

  test('models watch off/active/paused across movement, reconnect, omission, rejoin, departure, and switch', () => {
    const h = harness();
    h.emitRoom(roomUpdate(1, [participant('agent-a'), participant('agent-b')]));
    h.controller.dispatch({ type: 'follow', actorId: 'agent-a' });
    expect(h.controller.snapshot().watch).toMatchObject({
      state: 'active',
      targetActorId: 'agent-a',
      following: true,
    });
    expect(h.navigate).toHaveBeenLastCalledWith(
      expect.objectContaining({ reason: 'follow', targetActorId: 'agent-a' }),
    );

    h.emitRoom(
      roomUpdate(2, [], {
        kind: 'delta',
        connection: 'reconnecting',
      }),
    );
    expect(h.controller.snapshot().watch).toMatchObject({
      state: 'paused',
      reason: 'reconnecting',
    });
    h.emitRoom(roomUpdate(3, [participant('agent-a')]));
    expect(h.controller.snapshot().watch).toMatchObject({
      state: 'active',
      following: true,
    });
    h.emitRoom(
      roomUpdate(
        4,
        [
          participant('agent-a', {
            followableView: {
              ...participant('agent-a').followableView!,
              selection: { anchor: 2, focus: 3 },
              viewportAnchor: 2,
            },
          }),
        ],
        { kind: 'delta' },
      ),
    );
    expect(h.navigate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        reason: 'follow',
        view: expect.objectContaining({ selection: { anchor: 2, focus: 3 } }),
      }),
    );
    h.emitRoom(roomUpdate(5, []));
    expect(h.controller.snapshot().watch).toMatchObject({
      state: 'paused',
      reason: 'target-missing',
    });
    h.emitRoom(roomUpdate(6, [participant('agent-a'), participant('agent-b')]));
    h.controller.dispatch({ type: 'follow', actorId: 'agent-b' });
    expect(h.controller.snapshot().watch).toMatchObject({
      state: 'active',
      targetActorId: 'agent-b',
    });
    h.emitRoom(
      roomUpdate(7, [], {
        kind: 'delta',
        departedActorIds: ['agent-b'],
      }),
    );
    expect(h.controller.snapshot().watch).toMatchObject({
      state: 'paused',
      reason: 'departed',
    });
  });

  test('supports explicit unwatch and authority-bound cross-document follow without paths', () => {
    const h = harness();
    h.emitRoom(
      roomUpdate(1, [
        participant('agent-cross', {
          followableView: {
            ...participant('agent-cross').followableView!,
            documentId: 'document-b',
            workingStateRevision: 'working-document-b',
          },
        }),
      ]),
    );
    h.controller.dispatch({ type: 'follow', actorId: 'agent-cross' });
    expect(h.navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        targetActorId: 'agent-cross',
        capability: expect.stringContaining('authority-1'),
      }),
    );
    h.controller.dispatch({ type: 'stop-watch' });
    expect(h.controller.snapshot().watch).toEqual({ state: 'off' });
    expect(JSON.stringify(h.requestSurfaceJoin.mock.calls)).not.toContain(
      '/Users/',
    );
  });

  test('authorizes cross-document target movement before minting one host capability', () => {
    const h = harness({
      targetProjection: ({ scope: targetScope, workingStateRevision }) => ({
        state: 'AVAILABLE',
        scope: targetScope,
        workingStateRevision,
        textLength: targetScope.documentId === 'document-b' ? 100 : 4,
      }),
    });
    const cross = participant('agent-cross', {
      followableView: {
        paneId: 'pane-cross',
        documentId: 'document-b',
        workingStateRevision: 'working-b-1',
        selection: { anchor: 50, focus: 60 },
        viewportAnchor: 50,
      },
    });
    h.emitRoom(roomUpdate(1, [cross]));
    h.controller.dispatch({ type: 'follow', actorId: 'agent-cross' });
    expect(h.navigate).toHaveBeenCalledOnce();
    const invalidMovement = participant('agent-cross', {
      followableView: {
        ...cross.followableView!,
        selection: { anchor: 150, focus: 160 },
        viewportAnchor: 150,
      },
    });
    h.emitRoom(roomUpdate(2, [invalidMovement], { kind: 'delta' }));
    expect(h.controller.snapshot().lastUnavailable).toContain(
      'target projection',
    );
    expect(h.navigate).toHaveBeenCalledOnce();
  });

  test('does not activate watch when host rejects a revoked navigation capability', () => {
    const h = harness({
      onNavigate: () => ({
        outcome: 'unavailable',
        reason: 'capability revoked',
      }),
    });
    h.emitRoom(roomUpdate(1, [participant()]));
    h.controller.dispatch({ type: 'follow', actorId: 'agent-b' });
    expect(h.navigate).toHaveBeenCalledOnce();
    expect(h.controller.snapshot().watch).toEqual({ state: 'off' });
  });

  test('accepts reconnect sequence zero only through a new epoch snapshot and ignores retired epoch deltas', () => {
    let stream = { generation: 1, epoch: 'room-epoch-1' };
    const h = harness({
      roomStream: () => ({ state: 'AVAILABLE', scope, ...stream }),
    });
    h.emitRoom(roomUpdate(5, [participant('agent-a')]));
    stream = { generation: 2, epoch: 'room-epoch-2' };
    h.emitRoom(
      roomUpdate(0, [], {
        generation: 2,
        epoch: 'room-epoch-2',
        connection: 'reconnecting',
      }),
    );
    expect(h.controller.snapshot().roomConnection).toBe('reconnecting');
    h.emitRoom(
      roomUpdate(1, [participant('agent-b')], {
        generation: 2,
        epoch: 'room-epoch-2',
      }),
    );
    expect(h.controller.snapshot().participants[0]?.actorId).toBe('agent-b');
    h.emitRoom(
      roomUpdate(99, [participant('agent-a')], {
        kind: 'delta',
        epoch: 'room-epoch-1',
      }),
    );
    expect(
      h.controller.snapshot().participants.map((entry) => entry.actorId),
    ).toEqual(['agent-b']);
    for (let generation = 3; generation <= 10; generation += 1) {
      stream = { generation, epoch: `room-epoch-${generation}` };
      h.emitRoom(
        roomUpdate(0, [participant(`agent-${generation}`)], {
          generation,
          epoch: `room-epoch-${generation}`,
        }),
      );
    }
    h.emitRoom(
      roomUpdate(999, [participant('agent-old')], {
        generation: 1,
        epoch: 'room-epoch-1',
        kind: 'delta',
      }),
    );
    expect(h.controller.snapshot().participants[0]?.actorId).toBe('agent-10');
  });

  test('masks connected room projection when current stream authority becomes unavailable', () => {
    let available = true;
    const h = harness({
      roomStream: () =>
        available
          ? {
              state: 'AVAILABLE',
              scope,
              generation: 1,
              epoch: 'room-epoch-1',
            }
          : { state: 'UNAVAILABLE', reason: 'stream authority offline' },
    });
    h.emitRoom(roomUpdate(1, [participant()]));
    h.controller.dispatch({ type: 'follow', actorId: 'agent-b' });
    expect(h.controller.snapshot().roomConnection).toBe('connected');
    available = false;
    h.emitRoom(roomUpdate(2, [participant()], { kind: 'delta' }));
    expect(h.controller.snapshot()).toMatchObject({
      roomConnection: 'stale',
      participants: [],
      cursors: [],
      displayCursors: [],
      watch: { state: 'off' },
    });
  });

  test('rejects 64 plus 64 delta capacity atomically and expires quiet presence through the clock pump', () => {
    const h = harness();
    const first = Array.from({ length: 64 }, (_, index) =>
      participant(`agent-a-${index}`),
    );
    const second = Array.from({ length: 64 }, (_, index) =>
      participant(`agent-b-${index}`),
    );
    h.emitRoom(roomUpdate(1, first));
    h.emitRoom(roomUpdate(2, second, { kind: 'delta' }));
    expect(
      h.controller.snapshot().participants.map((entry) => entry.actorId),
    ).toEqual(first.map((entry) => entry.actorId));
    expect(h.controller.snapshot().lastUnavailable).toContain('capacity');
    const observed = vi.fn();
    h.controller.subscribe(observed);
    h.pumpExpiry();
    expect(h.controller.snapshot().participants).toEqual([]);
    expect(observed).toHaveBeenCalled();
  });

  test('rejects canonical principal kind equivocation transactionally', () => {
    let kind: 'agent' | 'human' = 'agent';
    const h = harness({
      principal: ({
        actorId,
        scope: principalScope,
        workingStateRevision,
      }) => ({
        state: 'AVAILABLE',
        actorId,
        kind,
        label: actorId,
        scope: principalScope,
        workingStateRevision,
        ...(kind === 'agent'
          ? { agentSessionId: 'session-a', runId: 'run-a' }
          : {}),
      }),
    });
    h.emitRoom(roomUpdate(1, [participant()]));
    kind = 'human';
    h.emitRoom(roomUpdate(2, [participant()], { kind: 'delta' }));
    expect(h.controller.snapshot().lastUnavailable).toContain('equivocated');
    expect(h.controller.snapshot().participants[0]?.kind).toBe('agent');
  });

  test('allows mutable agent run correlation while recorded accepted edits retain their exact run', () => {
    let runId = 'run-1';
    const h = harness({
      principal: ({
        actorId,
        scope: principalScope,
        workingStateRevision,
      }) => ({
        state: 'AVAILABLE',
        actorId,
        kind: 'agent',
        label: actorId,
        scope: principalScope,
        workingStateRevision,
        agentSessionId: 'session-a',
        runId,
      }),
    });
    h.emitRoom(roomUpdate(1, [participant()]));
    h.controller.dispatch({
      type: 'remote-accepted',
      operation: insert('accepted-run-1', 'x', 'agent-b'),
    });
    runId = 'run-2';
    h.emitRoom(roomUpdate(2, [participant()], { kind: 'delta' }));
    h.controller.dispatch({
      type: 'remote-accepted',
      operation: insert('accepted-run-2', 'y', 'agent-b'),
    });
    expect(h.controller.snapshot().participants[0]?.runId).toBe('run-2');
    expect(h.controller.snapshot().acceptedAttributions).toMatchObject([
      { operationId: 'accepted-run-1', runId: 'run-1' },
      { operationId: 'accepted-run-2', runId: 'run-2' },
    ]);
  });

  test('routes jump, separately-authorized surface join, share, and local follow exit through host intents', () => {
    const h = harness();
    h.emitRoom(
      roomUpdate(1, [
        participant('agent-a'),
        participant('agent-away', {
          surface: { state: 'authorized-unshared' },
          followableView: undefined,
        }),
      ]),
    );
    h.controller.dispatch({ type: 'jump', actorId: 'agent-a' });
    h.controller.dispatch({
      type: 'request-surface-join',
      actorId: 'agent-away',
    });
    h.controller.dispatch({ type: 'share-current' });
    expect(h.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'jump', targetActorId: 'agent-a' }),
    );
    expect(h.requestSurfaceJoin).toHaveBeenCalledTimes(1);
    expect(h.share).toHaveBeenCalledOnce();
    h.controller.dispatch({ type: 'follow', actorId: 'agent-a' });
    h.controller.dispatch({ type: 'local-interaction', kind: 'pointer' });
    expect(h.controller.snapshot().watch).toMatchObject({
      state: 'active',
      following: false,
    });
  });

  test('publishes outbound cursor only within authoritative length and declared rate ownership', () => {
    const h = harness();
    h.controller.dispatch({
      type: 'local-selection',
      selection: { anchor: 1, focus: 3 },
    });
    expect(h.publish).toHaveBeenCalledWith({
      schemaVersion: 1,
      scope,
      actorId: 'human-a',
      workingStateRevision: 'working-revision-1',
      selection: { anchor: 1, focus: 3 },
      expiresAt: NOW + COLLABORATIVE_PRESENCE_TTL_MS,
    });
    h.controller.dispatch({
      type: 'local-selection',
      selection: { anchor: 5, focus: 5 },
    });
    expect(h.publish).toHaveBeenCalledOnce();

    const overRate = harness({ cursorRate: 25 });
    for (let index = 0; index < 25; index += 1)
      overRate.controller.dispatch({
        type: 'local-selection',
        selection: { anchor: 1, focus: 2 },
      });
    expect(overRate.publish).toHaveBeenCalledTimes(20);
  });

  test('keeps share, join, watch, and follow capability decisions independent', () => {
    const shareOnly = harness({
      initialAuthority: authority({
        document: { read: true, write: true },
        room: {
          join: false,
          read: false,
          share: true,
          watch: false,
          follow: false,
        },
      }),
    });
    shareOnly.controller.dispatch({ type: 'share-current' });
    expect(shareOnly.share).toHaveBeenCalledOnce();
    expect(shareOnly.subscribe).not.toHaveBeenCalled();

    const followWithoutWatch = harness({
      initialAuthority: authority({
        ...allCapabilities,
        room: { ...allCapabilities.room, watch: false, follow: true },
      }),
    });
    followWithoutWatch.emitRoom(roomUpdate(1, [participant()]));
    followWithoutWatch.controller.dispatch({
      type: 'follow',
      actorId: 'agent-b',
    });
    expect(followWithoutWatch.navigate).toHaveBeenCalledOnce();
    followWithoutWatch.controller.dispatch({
      type: 'watch',
      actorId: 'agent-b',
    });
    expect(followWithoutWatch.controller.snapshot().watch).toMatchObject({
      state: 'active',
      following: true,
    });
  });

  test('rejects duplicate/invalid/oversized room arrays before unbounded examination', () => {
    const h = harness();
    h.emitRoom(roomUpdate(1, [participant('agent-a')]));
    expect(h.controller.snapshot().participants).toHaveLength(1);
    h.emitRoom(roomUpdate(2, [participant(), participant()]));
    expect(h.controller.snapshot().roomConnection).toBe('stale');
    expect(h.controller.snapshot().participants).toEqual([]);

    let examined = false;
    const huge = new Array(MAX_COLLABORATIVE_PARTICIPANTS + 1);
    Object.defineProperty(huge, '0', {
      get() {
        examined = true;
        throw new Error('must not examine');
      },
    });
    h.controller.dispatch({
      type: 'room',
      update: { ...roomUpdate(3), participants: huge },
    });
    expect(examined).toBe(false);
    expect(h.controller.snapshot().participants).toEqual([]);

    h.emitRoom(
      roomUpdate(4, [participant()], {
        cursors: [
          {
            actorId: 'agent-b',
            workingStateRevision: 'working-revision-1',
            selection: { anchor: 0, focus: 99 },
            expiresAt: NOW + 1_000,
          },
        ],
      }),
    );
    expect(h.controller.snapshot().roomConnection).toBe('stale');
  });

  test('makes throwing editor, malformed transport, and malformed authority total', async () => {
    const h = harness({ transport: async () => ({ outcome: 'wat' }) });
    h.controller.dispatch({
      type: 'local-input',
      text: 'draft',
      selection: { anchor: 1, focus: 1 },
    });
    await vi.waitFor(() =>
      expect(
        h.controller.snapshot().pendingIntents[0]?.states.indeterminate,
      ).toBe(1),
    );
    h.setAuthority({ state: 'AVAILABLE', actorId: 'wrong' });
    expect(() =>
      h.controller.dispatch({ type: 'authority-changed' }),
    ).not.toThrow();
    expect(h.controller.snapshot().mode).toBe('unavailable');

    const throwingEditor = harness({
      planEdit: () => {
        throw new Error('editor offline');
      },
    });
    expect(() =>
      throwingEditor.controller.dispatch({
        type: 'local-input',
        text: 'x',
        selection: { anchor: 1, focus: 1 },
      }),
    ).not.toThrow();
    expect(throwingEditor.controller.snapshot()).toMatchObject({
      mode: 'rejected-write',
      rejectedWrites: [
        expect.objectContaining({
          reason: 'Editing capability was unavailable.',
        }),
      ],
    });

    const malformedProjection = harness({
      projectPending: () => ({
        outcome: 'projected',
        text: 42,
        workingStateRevision: 'bad',
      }),
    });
    malformedProjection.controller.dispatch({
      type: 'local-input',
      text: 'x',
      selection: { anchor: 1, focus: 1 },
    });
    expect(malformedProjection.controller.snapshot().mode).toBe('stale');
  });

  test('fences nested mutation and every late callback after dispose while delegating metadata duplicate identity to #2889', async () => {
    const settlement = deferred<unknown>();
    let transported: CollaborativeOperation | undefined;
    const h = harness({
      transport: async (entry) => {
        transported = entry;
        return settlement.promise;
      },
    });
    h.controller.dispatch({
      type: 'local-input',
      text: 'draft',
      selection: { anchor: 1, focus: 1 },
    });
    await vi.waitFor(() => expect(transported).toBeTruthy());
    expect(() => {
      (transported!.actor as { actorId: string }).actorId = 'mutated-transport';
    }).toThrow();
    expect(h.controller.snapshot().pendingIntents[0]?.intentId).toBe(
      'intent-1',
    );
    const beforeDispose = h.controller.snapshot();
    h.controller.dispose();
    settlement.resolve({
      outcome: 'refused',
      operationId: 'local-1',
      reason: 'late',
    });
    await Promise.resolve();
    expect(h.controller.snapshot()).toEqual(beforeDispose);

    const settled = harness();
    const accepted = insert('settled-1', 'x', 'agent-a');
    settled.controller.dispatch({
      type: 'remote-accepted',
      operation: accepted,
    });
    expect(settled.applyAccepted).toHaveBeenCalledOnce();
    settled.controller.dispatch({
      type: 'remote-accepted',
      operation: accepted,
    });
    expect(settled.applyAccepted).toHaveBeenCalledTimes(2);
    const equivocated = structuredClone(accepted);
    (equivocated.actor as { displayLabel?: string }).displayLabel =
      'mutated nested attribution';
    settled.controller.dispatch({
      type: 'remote-accepted',
      operation: equivocated,
    });
    expect(settled.controller.snapshot().lastUnavailable ?? '').not.toContain(
      'reused',
    );
    expect(settled.applyAccepted).toHaveBeenCalledTimes(3);
  });

  test('bounds terminal rejection retention deterministically', async () => {
    const h = harness({
      transport: async (entry) => ({
        outcome: 'refused',
        operationId: entry.operationId,
        reason: `denied-${entry.operationId}`,
      }),
    });
    for (let index = 0; index < 70; index += 1) {
      h.controller.dispatch({
        type: 'local-input',
        text: `edit-${index}`,
        selection: { anchor: 1, focus: 1 },
      });
      await vi.waitFor(() =>
        expect(h.controller.snapshot().pendingIntents).toHaveLength(0),
      );
    }
    const rejections = h.controller.snapshot().rejectedWrites;
    expect(rejections).toHaveLength(64);
    expect(rejections[0]?.operationId).toBe('intent-7');
    expect(rejections.at(-1)?.operationId).toBe('intent-70');
  });

  test('subscribes once under synchronous room callback and contains hostile proxies and huge strings', () => {
    const synchronous = roomUpdate(0, [participant()]);
    const h = harness({ synchronousRoomUpdate: synchronous });
    expect(h.subscribe).toHaveBeenCalledOnce();
    expect(h.controller.snapshot().participants).toHaveLength(1);
    const close = h.subscribe.mock.results[0]?.value as ReturnType<
      typeof vi.fn
    >;
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('hostile getter');
        },
      },
    );
    expect(() =>
      h.controller.dispatch({ type: 'room', update: hostile }),
    ).not.toThrow();
    expect(() =>
      h.controller.dispatch({
        type: 'remote-accepted',
        operation: hostile as CollaborativeOperation,
      }),
    ).not.toThrow();
    h.controller.dispatch({
      type: 'local-input',
      text: 'x'.repeat(256 * 1024 + 1),
      selection: { anchor: 0, focus: 0 },
    });
    expect(h.controller.snapshot().rejectedWrites).not.toHaveLength(0);
    h.controller.dispose();
    h.controller.dispose();
    expect(close).toHaveBeenCalledOnce();
  });

  test('preserves ordered synchronous snapshot then delta and contains throwing schedule/close cleanup', () => {
    const snapshot = roomUpdate(0, [participant('agent-a')]);
    const delta = roomUpdate(1, [participant('agent-b')], { kind: 'delta' });
    const ordered = harness({ synchronousRoomUpdates: [snapshot, delta] });
    expect(ordered.subscribe).toHaveBeenCalledOnce();
    expect(
      ordered.controller.snapshot().participants.map((entry) => entry.actorId),
    ).toEqual(['agent-a', 'agent-b']);

    const throwing = harness({ scheduleThrows: true, closeThrows: true });
    expect(() =>
      throwing.emitRoom(roomUpdate(1, [participant()])),
    ).not.toThrow();
    expect(throwing.controller.snapshot().lastUnavailable).toContain(
      'scheduling',
    );
    expect(() => throwing.controller.dispose()).not.toThrow();
    expect(() => throwing.controller.dispose()).not.toThrow();
  });

  test('suppresses stale-revision cursor without leaking it into follow state', () => {
    const h = harness();
    h.emitRoom(
      roomUpdate(1, [participant()], {
        cursors: [
          {
            actorId: 'agent-b',
            workingStateRevision: 'working-stale',
            selection: { anchor: 1, focus: 2 },
            expiresAt: NOW + 1_000,
          },
        ],
      }),
    );
    expect(h.controller.snapshot().cursors).toEqual([]);

    h.emitRoom(
      roomUpdate(2, [participant()], {
        cursors: [
          {
            actorId: 'agent-b',
            workingStateRevision: 'working-revision-1',
            selection: { anchor: 1, focus: 2 },
            expiresAt: NOW + 1_000,
          },
        ],
      }),
    );
    h.controller.dispatch({ type: 'follow', actorId: 'agent-b' });
    expect(h.controller.snapshot().cursors).toHaveLength(1);
    h.setProjection(projection('next', 'working-revision-2'));
    h.controller.dispatch({
      type: 'remote-accepted',
      operation: insert('revision-transition', 'n', 'agent-b'),
    });
    expect(h.controller.snapshot().cursors).toEqual([]);
    expect(h.controller.snapshot().watch).toMatchObject({
      state: 'paused',
      reason: 'view-unavailable',
    });
    expect(h.requestFreshSignals).toHaveBeenCalledWith({
      scope,
      workingStateRevision: 'working-revision-2',
    });
  });

  test('rejects a document above the absolute UTF-8 bound before editor or transport work', () => {
    const h = harness();
    h.controller.dispatch({
      type: 'local-input',
      text: 'x'.repeat(256 * 1024 + 1),
      selection: { anchor: 0, focus: 0 },
    });
    expect(h.submit).not.toHaveBeenCalled();
    expect(h.controller.snapshot()).toMatchObject({
      mode: 'rejected-write',
      rejectedWrites: [
        expect.objectContaining({
          reason: 'The edit exceeds the pane safety bounds.',
        }),
      ],
    });
  });

  test('admits one planner batch at the declared delete-atom maximum end to end', async () => {
    const targets = Array.from({ length: 129 }, (_, index) => `seed:${index}`);
    const operation: CollaborativeOperation = {
      schemaVersion: 1,
      operationId: 'max-delete',
      documentId: scope.documentId,
      replicaId: 'replica-human-a',
      actor: { actorId: 'human-a', kind: 'human' },
      parents: [],
      authorizationEpoch: 1,
      kind: 'delete',
      target: targets,
    };
    const h = harness({
      planEdit: (raw) => {
        const input = raw as {
          desiredText: string;
          selection: { anchor: number; focus: number };
        };
        return {
          outcome: 'planned',
          batch: {
            intentId: 'max-delete-intent',
            baseRevision: 'working-revision-1',
            operations: [operation],
            optimistic: {
              text: input.desiredText,
              workingStateRevision: 'optimistic-max-delete',
            },
            selection: input.selection,
          },
        };
      },
      projectPending: () => ({
        outcome: 'projected',
        text: '',
        workingStateRevision: 'optimistic-max-delete',
      }),
    });
    h.controller.dispatch({
      type: 'local-input',
      text: '',
      selection: { anchor: 0, focus: 0 },
    });
    await vi.waitFor(() => expect(h.submit).toHaveBeenCalledOnce());
    expect(h.submit.mock.calls[0]?.[0]?.operations[0]).toMatchObject({
      operationId: 'max-delete',
      target: expect.arrayContaining(['seed:0', `seed:${targets.length - 1}`]),
    });
  });

  test('uses one abort generation across restore and resync and makes resolver throws stale', async () => {
    const restore = deferred<unknown>();
    const sync = deferred<unknown>();
    const h = harness({
      resolveRevision: () => restore.promise,
      resync: () => sync.promise,
    });
    h.controller.dispatch({
      type: 'restore-evidence-revision',
      evidenceRevisionId: 'evidence-old',
    });
    h.controller.dispatch({ type: 'resync' });
    sync.resolve({
      outcome: 'available',
      projection: projection('synced', 'working-synced'),
    });
    await vi.waitFor(() =>
      expect(h.controller.snapshot().displayText).toBe('synced'),
    );
    restore.resolve({
      state: 'AVAILABLE',
      evidenceRevisionId: 'evidence-old',
      scope,
      correlationId: 'correlation-a',
      workingStateRevision: 'working-old',
      projection: projection('old', 'working-old'),
    });
    await Promise.resolve();
    expect(h.controller.snapshot().displayText).toBe('synced');

    const throwing = harness({
      resolveRevision: async () => {
        throw new Error('resolver offline');
      },
    });
    throwing.controller.dispatch({
      type: 'restore-evidence-revision',
      evidenceRevisionId: 'evidence-x',
    });
    await vi.waitFor(() =>
      expect(throwing.controller.snapshot().mode).toBe('stale'),
    );
  });

  test('uses the direct #2889 adapter for reordered and duplicate convergence', () => {
    const ports = createSharedWorkingState({ scope });
    const adapter = createSharedWorkingStateProjectionAdapter({
      live: ports.live,
      recovery: ports.recovery,
      resync: async () => ({
        outcome: 'available',
        projection: {
          scope,
          text: ports.live.text(),
          workingStateRevision: ports.live.revision,
        },
      }),
    });
    const h = harness({
      initialProjection: {
        scope,
        text: '',
        workingStateRevision: ports.live.revision,
      },
      applyAccepted: (operation) => adapter.applyAccepted(operation),
    });
    const child = insert(
      'remote-child',
      'b',
      'agent-b',
      scope.documentId,
      'remote-root:0',
      ['remote-root'],
    );
    const root = insert('remote-root', 'a', 'agent-b');
    h.controller.dispatch({ type: 'remote-accepted', operation: child });
    h.controller.dispatch({ type: 'remote-accepted', operation: root });
    h.controller.dispatch({ type: 'remote-accepted', operation: root });
    expect(h.controller.snapshot().displayText).toBe('ab');
  });
});

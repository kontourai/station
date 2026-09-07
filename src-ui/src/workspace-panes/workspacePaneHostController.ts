import type {
  WorkspacePaneInstance,
  WorkspacePaneInstanceId,
} from '@kontourai/station-contracts/workspace-pane';
import type { WorkspacePaneAvailability } from '@kontourai/station-contracts/workspace-pane-availability';
import type {
  WorkspacePaneHostAction,
  WorkspacePaneHostDocumentV1,
} from '@kontourai/station-contracts/workspace-pane-host';
import { createWorkspacePaneHostBaselineDocument } from '@kontourai/station-contracts/workspace-pane-host';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { navigationStore } from '../contexts/navigation-store';
import {
  projectCompactWorkspacePaneHost,
  visibleWorkspacePaneHostInstanceIds,
} from './compactWorkspacePaneProjection';
import type {
  WorkspacePaneHostOpenPlacement,
  WorkspacePaneHostOpenPreparation,
} from './WorkspacePaneHostOpenContext';
import {
  workspacePaneHostAuthorityFingerprint,
  workspacePaneHostRevokedInstanceIds,
} from './workspacePaneHostAuthority';
import { workspacePaneHostTupleId } from './workspacePaneHostIdentity';
import {
  browserWorkspacePaneHostLockManager,
  type WorkspacePaneHostLockManager,
  type WorkspacePaneHostPersistenceStatus,
} from './workspacePaneHostLease';
import {
  readWorkspacePaneHostSelection,
  writeWorkspacePaneHostSelection,
} from './workspacePaneHostNavigation';
import {
  WORKSPACE_PANE_OPENED,
  type WorkspacePaneHostOpenOutcome,
  workspacePaneOpenRefused,
} from './workspacePaneHostOpenOutcome';
import {
  reduceWorkspacePaneHost,
  type WorkspacePaneHostState,
} from './workspacePaneHostReducer';
import { workspacePaneHostGroupContaining } from './workspacePaneHostReducerTree';
import { WorkspacePaneHostRuntime } from './workspacePaneHostRuntime';
import {
  hydrateWorkspacePaneHost,
  persistWorkspacePaneHost,
  registerLiveWorkspacePaneHostDocument,
  unregisterLiveWorkspacePaneHostDocument,
  type WorkspacePaneHostRestoredInstanceAdmission,
  type WorkspacePaneHostStorage,
  workspacePaneHostStorageKey,
} from './workspacePaneHostStorage';
import {
  closeWorkspacePaneHostDocument,
  initialWorkspacePaneHostState,
  prepareWorkspacePaneHostOpen,
} from './workspacePaneHostTransactions';
import {
  type WorkspacePaneOperationalEventContext,
  type WorkspacePaneOperationalEventSink,
  WorkspacePaneOperationalEventTracker,
} from './workspacePaneOperationalEvents';

export interface WorkspacePaneHostControllerOptions {
  document: WorkspacePaneHostDocumentV1;
  compact: boolean;
  runtime?: WorkspacePaneHostRuntime;
  storage?: WorkspacePaneHostStorage;
  lockManager?: WorkspacePaneHostLockManager | null;
  admitRestoredInstance?: WorkspacePaneHostRestoredInstanceAdmission;
  /** Refuses a new occurrence this host cannot render before persistence. */
  admitOpenInstance?(instance: WorkspacePaneInstance): boolean;
  onInstanceRemoved?(instance: WorkspacePaneInstance): void;
  onDocumentChange?(document: WorkspacePaneHostDocumentV1): void;
  operationalEventSink?: WorkspacePaneOperationalEventSink;
  operationalEventContext?(
    instance: WorkspacePaneInstance,
    document: WorkspacePaneHostDocumentV1,
  ): WorkspacePaneOperationalEventContext | null;
  operationalAvailability?(
    instance: WorkspacePaneInstance,
  ): WorkspacePaneAvailability | undefined;
}

export interface WorkspacePaneHostController {
  state: WorkspacePaneHostState;
  persistenceStatus: WorkspacePaneHostPersistenceStatus;
  canPersist: boolean;
  tabRefs: React.MutableRefObject<Map<string, HTMLButtonElement>>;
  closeConfirmation: {
    instanceId: WorkspacePaneInstanceId;
    reason: 'dirty' | 'pending';
  } | null;
  select(instanceId: WorkspacePaneInstanceId): void;
  focusExisting(instanceId: WorkspacePaneInstanceId): boolean;
  focusTab(groupId: string, instanceId: WorkspacePaneInstanceId): void;
  close(instanceId: WorkspacePaneInstanceId): Promise<void>;
  confirmClose(): Promise<void>;
  cancelClose(): void;
  resize(splitId: string, ratio: number): void;
  reorder(instanceId: WorkspacePaneInstanceId, toIndex: number): void;
  collapse(splitId: string, collapsed: 'first' | 'second' | undefined): void;
  maximize(instanceId: WorkspacePaneInstanceId | undefined): void;
  fail(instanceId: WorkspacePaneInstanceId): void;
  retry(instanceId: WorkspacePaneInstanceId): Promise<boolean>;
  /** Replaces the sole ambient-slot occupant through this host's persistence lease. */
  replace(instance: WorkspacePaneInstance): boolean;
  open(
    instance: WorkspacePaneInstance,
    preparation?: WorkspacePaneHostOpenPreparation,
    placement?: WorkspacePaneHostOpenPlacement,
  ): WorkspacePaneHostOpenOutcome;
}

/** Stateful controller: hydration, lifecycle and serial navigation never leak into the view tree. */
export function useWorkspacePaneHostController({
  document,
  compact,
  runtime,
  storage,
  lockManager,
  admitRestoredInstance,
  admitOpenInstance,
  onInstanceRemoved,
  onDocumentChange,
  operationalEventSink,
  operationalEventContext,
  operationalAvailability,
}: WorkspacePaneHostControllerOptions): WorkspacePaneHostController {
  const hostStorage = storage ?? window.localStorage;
  const resolvedLockManager =
    lockManager === undefined
      ? browserWorkspacePaneHostLockManager()
      : lockManager;
  const lockName = workspacePaneHostStorageKey(document.scope, document.id);
  const [state, dispatch] = useReducer(
    reduceWorkspacePaneHost,
    { document, admitRestoredInstance, storage: hostStorage },
    initialWorkspacePaneHostState,
  );
  const [closeConfirmation, setCloseConfirmation] =
    useState<WorkspacePaneHostController['closeConfirmation']>(null);
  const [authorityCleanupRevision, setAuthorityCleanupRevision] = useState(0);
  const [persistenceStatus, setPersistenceStatus] =
    useState<WorkspacePaneHostPersistenceStatus>('unavailable');
  const navigationSnapshot = useSyncExternalStore(
    navigationStore.subscribe,
    navigationStore.getSnapshot,
    navigationStore.getSnapshot,
  );
  const stateRef = useRef(state);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const pendingResize = useRef<{ splitId: string; ratio: number } | null>(null);
  const resizeFrame = useRef<number | null>(null);
  const authorityFingerprint = workspacePaneHostAuthorityFingerprint(document);
  const authorityFingerprintRef = useRef(authorityFingerprint);
  const documentRef = useRef(document);
  const restoredInstanceAdmissionRef = useRef(admitRestoredInstance);
  const openInstanceAdmissionRef = useRef(admitOpenInstance);
  const liveReferenceOwner = useRef(Symbol('workspace-pane-host'));
  const mountedRef = useRef(false);
  const persistenceStatusRef =
    useRef<WorkspacePaneHostPersistenceStatus>('unavailable');
  const operationalTrackerRef =
    useRef<WorkspacePaneOperationalEventTracker | null>(null);
  const availabilityRef = useRef(new Map<string, WorkspacePaneAvailability>());
  /** Last validated facts survive an authoritative catalog removal only long
   * enough to report its terminal, already-owned occurrence. */
  const lifecycleContextsRef = useRef(
    new Map<string, WorkspacePaneOperationalEventContext>(),
  );
  /**
   * The document-change notification's subject is the document, not the sink.
   * Holding the sink in a ref keeps a swapped handler current without making
   * the handler's identity a reason to notify — see the effect below.
   */
  const onDocumentChangeRef = useRef(onDocumentChange);
  /**
   * archive#3793: the same reasoning as `onDocumentChangeRef`, applied to the
   * observability callbacks the persistence lease closes over. The lease
   * effect's subjects are the storage, the lock name and the lock manager —
   * WHO is told about an event is not one of them. `operationalEventContext`
   * is an inline arrow at every call site (`ProjectLayoutRenderer.tsx` builds
   * it from the live pane catalog), so listing it made a new identity per
   * render a reason to abort the in-flight `navigator.locks.request` and ask
   * again — 8,276 effect entries in 5s were measured on the project-layout
   * route before #3781, each one re-hydrating the document from localStorage
   * (read + parse + structuredClone) and dispatching `restore` on grant.
   */
  const operationalEventContextRef = useRef(operationalEventContext);
  const operationalEventSinkRef = useRef(operationalEventSink);
  stateRef.current = state;
  documentRef.current = document;
  restoredInstanceAdmissionRef.current = admitRestoredInstance;
  openInstanceAdmissionRef.current = admitOpenInstance;
  onDocumentChangeRef.current = onDocumentChange;
  operationalEventContextRef.current = operationalEventContext;
  operationalEventSinkRef.current = operationalEventSink;
  /**
   * A stable sink identity for the tracker built under the lease: it forwards
   * to whichever sink is current, so a swapped sink is still honored without
   * the swap costing a lock re-election.
   */
  const leaseOperationalEventSink = useRef<WorkspacePaneOperationalEventSink>({
    emit: (event) => operationalEventSinkRef.current?.emit(event),
  }).current;

  const emitOperationalEvent = useCallback(
    (
      instance: WorkspacePaneInstance,
      name: Parameters<WorkspacePaneOperationalEventTracker['emit']>[1],
      closeReason?: 'user' | 'catalog-revoked',
    ) => {
      if (persistenceStatusRef.current !== 'owned') return;
      const context = operationalEventContextRef.current?.(
        instance,
        stateRef.current.document,
      );
      if (!context) return;
      operationalTrackerRef.current?.emit(
        context,
        name,
        undefined,
        undefined,
        closeReason,
      );
    },
    [],
  );

  const emitCapturedOperationalEvent = useCallback(
    (
      context: WorkspacePaneOperationalEventContext | undefined,
      name: Parameters<WorkspacePaneOperationalEventTracker['emit']>[1],
      closeReason?: 'user' | 'catalog-revoked',
    ) => {
      if (persistenceStatusRef.current !== 'owned' || !context) return;
      operationalTrackerRef.current?.emit(
        context,
        name,
        undefined,
        undefined,
        closeReason,
      );
    },
    [],
  );

  const hasPersistenceLease = useCallback(
    () => persistenceStatusRef.current === 'owned',
    [],
  );

  useLayoutEffect(() => {
    let active = true;
    let releaseLease: (() => void) | null = null;
    const waitAbortController = new AbortController();
    const setStatus = (status: WorkspacePaneHostPersistenceStatus) => {
      persistenceStatusRef.current = status;
      if (active) setPersistenceStatus(status);
    };
    if (!resolvedLockManager) {
      setStatus('unavailable');
      return () => {
        active = false;
      };
    }

    const acquireLease = async (lock: object | null) => {
      if (!lock || !active) return;

      // A prior tab may have written after this host's render and before
      // lock election. Restore again while holding the lease before this
      // tab can publish any document changes.
      const hydrated = hydrateWorkspacePaneHost(
        hostStorage,
        documentRef.current.scope,
        documentRef.current.id,
        documentRef.current.instances,
        restoredInstanceAdmissionRef.current,
      );
      const restored = hydrated.document ?? documentRef.current;
      stateRef.current = reduceWorkspacePaneHost(stateRef.current, {
        type: 'restore',
        document: restored,
      });
      dispatch({ type: 'restore', document: restored });
      if (
        !registerLiveWorkspacePaneHostDocument(
          hostStorage,
          liveReferenceOwner.current,
          restored,
        )
      ) {
        setStatus('unavailable');
        return;
      }
      setStatus('owned');
      operationalTrackerRef.current = new WorkspacePaneOperationalEventTracker(
        hostStorage,
        leaseOperationalEventSink,
      );
      if (hydrated.document) {
        for (const instance of restored.instances)
          emitOperationalEvent(instance, 'restored');
        const entry = performance.mark?.('station:perf:host-restored');
        window.dispatchEvent(
          new CustomEvent('station:perf:host-restored', {
            detail: entry?.startTime,
          }),
        );
      }
      await new Promise<void>((resolve) => {
        releaseLease = resolve;
      });
    };

    const queueLease = () =>
      resolvedLockManager
        .request(
          lockName,
          { mode: 'exclusive', signal: waitAbortController.signal },
          acquireLease,
        )
        .catch(() => {
          if (active && !waitAbortController.signal.aborted)
            setStatus('unavailable');
        });

    void resolvedLockManager
      .request(lockName, { mode: 'exclusive', ifAvailable: true }, (lock) => {
        if (lock) return acquireLease(lock);
        setStatus('contended');
        void queueLease();
      })
      .catch(() => {
        if (active) setStatus('unavailable');
      });

    return () => {
      active = false;
      persistenceStatusRef.current = 'unavailable';
      waitAbortController.abort();
      releaseLease?.();
    };
    // archive#3793: the lease's real subjects, and nothing else. The two
    // callbacks still listed are identity-stable by construction —
    // `emitOperationalEvent` closes over refs (`useCallback(…, [])`) and
    // `leaseOperationalEventSink` is a ref value — so neither can re-elect the
    // lease. Giving either one a live dependency again is what the
    // lease-request count test in `WorkspacePaneHost.test.tsx` catches.
  }, [
    emitOperationalEvent,
    hostStorage,
    leaseOperationalEventSink,
    lockName,
    resolvedLockManager,
  ]);

  useLayoutEffect(() => {
    registerLiveWorkspacePaneHostDocument(
      hostStorage,
      liveReferenceOwner.current,
      state.document,
    );
  }, [hostStorage, state.document]);
  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      unregisterLiveWorkspacePaneHostDocument(
        hostStorage,
        liveReferenceOwner.current,
      );
    };
  }, [hostStorage]);

  useLayoutEffect(() => {
    const live = new Set<string>();
    for (const instance of state.document.instances) {
      live.add(instance.instanceId);
      try {
        const context = operationalEventContext?.(instance, state.document);
        if (context)
          lifecycleContextsRef.current.set(instance.instanceId, context);
      } catch {
        // A catalog resolver is advisory to observability and cannot disturb
        // the local host lifecycle.
      }
    }
    for (const instanceId of lifecycleContextsRef.current.keys())
      if (!live.has(instanceId))
        lifecycleContextsRef.current.delete(instanceId);
  }, [operationalEventContext, state.document]);

  useLayoutEffect(() => {
    if (authorityFingerprintRef.current === authorityFingerprint) return;
    authorityFingerprintRef.current = authorityFingerprint;
    const authoritativeDocument = documentRef.current;

    const revoked = workspacePaneHostRevokedInstanceIds(
      stateRef.current.document.instances,
      authoritativeDocument.instances,
    );
    const revokedInstances = stateRef.current.document.instances.filter(
      (instance) => revoked.includes(instance.instanceId),
    );
    const revokedContexts = new Map(
      revokedInstances.flatMap((instance) => {
        const context = lifecycleContextsRef.current.get(instance.instanceId);
        return context ? [[instance.instanceId, context] as const] : [];
      }),
    );

    // This is deliberately a layout effect: React never paints the old host
    // document after an authoritative catalog replacement.
    setCloseConfirmation(null);
    const durablyPublished =
      persistenceStatus === 'owned' &&
      persistWorkspacePaneHost(hostStorage, authoritativeDocument);
    registerLiveWorkspacePaneHostDocument(
      hostStorage,
      liveReferenceOwner.current,
      authoritativeDocument,
    );
    stateRef.current = reduceWorkspacePaneHost(stateRef.current, {
      type: 'restore',
      document: authoritativeDocument,
    });
    dispatch({ type: 'restore', document: authoritativeDocument });
    writeWorkspacePaneHostSelection(
      authoritativeDocument,
      authoritativeDocument.activeInstanceId,
    );

    if (revoked.length === 0) return;
    if (!runtime) {
      for (const instance of revokedInstances) {
        if (!durablyPublished) continue;
        try {
          onInstanceRemoved?.(instance);
        } catch {
          /* cleanup callbacks are isolated per removed occurrence */
        }
        emitCapturedOperationalEvent(
          revokedContexts.get(instance.instanceId),
          'closed',
          'catalog-revoked',
        );
      }
      return;
    }
    void (async () => {
      const outcomes = await Promise.all(
        revokedInstances.map(
          async (instance) =>
            [instance, await runtime.revoke(instance.instanceId)] as const,
        ),
      );
      const retryInstances = outcomes
        .filter(([, outcome]) => outcome.status === 'error')
        .map(([instance]) => instance);
      // A failed dispose remains tombstoned; perform one bounded controller
      // retry and leave any remaining ownership on the runtime's explicit
      // retry path rather than silently forgetting it.
      if (retryInstances.length > 0) {
        await Promise.all(
          retryInstances.map((instance) =>
            runtime.retryRevokedCleanup(instance.instanceId),
          ),
        );
      }
      if (!mountedRef.current) return;
      registerLiveWorkspacePaneHostDocument(
        hostStorage,
        liveReferenceOwner.current,
        stateRef.current.document,
      );
      // The old callback is now disposed or tombstoned for explicit retry.
      // A later authority snapshot may already have re-admitted the same ID.
      for (const instance of revokedInstances) {
        const reauthorized = stateRef.current.document.instances.some(
          (candidate) => candidate.instanceId === instance.instanceId,
        );
        if (
          reauthorized ||
          !durablyPublished ||
          runtime.requiresCleanup(instance.instanceId) ||
          runtime.isRevoked(instance.instanceId)
        )
          continue;
        try {
          onInstanceRemoved?.(instance);
        } catch {
          /* cleanup callbacks are isolated per removed occurrence */
        }
        emitCapturedOperationalEvent(
          revokedContexts.get(instance.instanceId),
          'closed',
          'catalog-revoked',
        );
        lifecycleContextsRef.current.delete(instance.instanceId);
      }
      // A same-ID replacement may have rendered while the old callback was
      // tombstoned. Re-render after cleanup so it can register afresh.
      setAuthorityCleanupRevision((revision) => revision + 1);
    })();
  }, [
    authorityFingerprint,
    hostStorage,
    onInstanceRemoved,
    persistenceStatus,
    runtime,
    emitCapturedOperationalEvent,
  ]);

  useEffect(() => {
    void navigationSnapshot.activeWorkspacePane;
    const selected = readWorkspacePaneHostSelection(state.document);
    if (selected && selected !== state.document.activeInstanceId)
      dispatch({
        type: 'select',
        instanceId: selected as WorkspacePaneInstanceId,
      });
  }, [navigationSnapshot, state.document]);
  /**
   * Notify on a document change, never on a re-render. `onDocumentChange` used
   * to sit in this dependency list, so a consumer whose handler is rebuilt per
   * render — the ordinary shape for a handler that closes over render scope —
   * was re-announced a document that had not moved, once per render.
   * A consumer that answers by storing a freshly built value then closes the
   * circuit: notify -> setState -> render -> new handler identity -> notify.
   * archive#3781 measured that loop at ~1,300 notifications/second on the
   * project-layout route, 6,472 of 6,472 of them carrying an unchanged
   * instance list.
   */
  useEffect(() => {
    if (persistenceStatus === 'owned')
      onDocumentChangeRef.current?.(state.document);
  }, [persistenceStatus, state.document]);
  useEffect(() => {
    if (persistenceStatus !== 'owned' || !operationalAvailability) return;
    for (const instance of state.document.instances) {
      const next = operationalAvailability(instance);
      if (!next) continue;
      const context = operationalEventContext?.(instance, state.document);
      if (!context) continue;
      const previous = availabilityRef.current.get(instance.instanceId);
      operationalTrackerRef.current?.observeAvailability(
        context,
        previous,
        next,
      );
      availabilityRef.current.set(instance.instanceId, next);
    }
  }, [
    operationalAvailability,
    operationalEventContext,
    persistenceStatus,
    state.document,
  ]);
  useEffect(() => {
    if (persistenceStatus !== 'owned') return;
    try {
      persistWorkspacePaneHost(hostStorage, state.document);
    } catch {
      /* optional browser storage */
    }
  }, [hostStorage, persistenceStatus, state.document]);
  useEffect(() => {
    if (!runtime) return;
    const target = compact
      ? projectCompactWorkspacePaneHost(state.document).mountInstanceIds
      : visibleWorkspacePaneHostInstanceIds(state.document);
    void runtime.reconcileVisible(target, (transition) => {
      const instance = stateRef.current.document.instances.find(
        (candidate) => candidate.instanceId === transition.instanceId,
      );
      if (instance) emitOperationalEvent(instance, transition.kind);
    });
    runtime.setFocused(state.document.activeInstanceId);
  }, [compact, emitOperationalEvent, runtime, state.document]);
  useEffect(() => {
    if (!runtime || authorityCleanupRevision === 0) return;
    void runtime.reconcileVisible(
      compact
        ? projectCompactWorkspacePaneHost(state.document).mountInstanceIds
        : visibleWorkspacePaneHostInstanceIds(state.document),
    );
    runtime.setFocused(state.document.activeInstanceId);
  }, [authorityCleanupRevision, compact, runtime, state.document]);
  useEffect(
    () => () => {
      if (resizeFrame.current !== null)
        cancelAnimationFrame(resizeFrame.current);
    },
    [],
  );

  const focusTab = useCallback(
    (groupId: string, instanceId: WorkspacePaneInstanceId) => {
      requestAnimationFrame(() =>
        tabRefs.current
          .get(workspacePaneHostTupleId('ref', groupId, instanceId))
          ?.focus(),
      );
    },
    [],
  );
  const select = useCallback((instanceId: WorkspacePaneInstanceId) => {
    dispatch({ type: 'select', instanceId });
    writeWorkspacePaneHostSelection(stateRef.current.document, instanceId);
  }, []);
  const focusExisting = useCallback(
    (instanceId: WorkspacePaneInstanceId) => {
      const group = workspacePaneHostGroupContaining(
        stateRef.current.document.root,
        instanceId,
      );
      if (!group) return false;
      select(instanceId);
      focusTab(compact ? 'compact' : group.id, instanceId);
      return true;
    },
    [compact, focusTab, select],
  );
  const open = useCallback(
    (
      instance: WorkspacePaneInstance,
      preparation?: WorkspacePaneHostOpenPreparation,
      placement?: WorkspacePaneHostOpenPlacement,
    ) => {
      if (!hasPersistenceLease()) return workspacePaneOpenRefused('no-lease');
      if (
        openInstanceAdmissionRef.current &&
        !openInstanceAdmissionRef.current(instance)
      )
        return workspacePaneOpenRefused('refused');
      const action: Extract<
        WorkspacePaneHostAction,
        { type: 'add-existing-instance' } | { type: 'split' }
      > =
        placement?.type === 'split'
          ? { ...placement, instance }
          : {
              type: 'add-existing-instance',
              instance,
              ...(placement ? { targetGroupId: placement.targetGroupId } : {}),
            };
      const prepared = prepareWorkspacePaneHostOpen({
        state: stateRef.current,
        instance,
        storage: hostStorage,
        owner: liveReferenceOwner.current,
        preparation,
        action,
      });
      if (!prepared.ok) return workspacePaneOpenRefused(prepared.reason);
      stateRef.current = prepared.state;
      dispatch(action);
      writeWorkspacePaneHostSelection(
        prepared.state.document,
        instance.instanceId,
      );
      emitOperationalEvent(instance, 'opened');
      return WORKSPACE_PANE_OPENED;
    },
    [emitOperationalEvent, hasPersistenceLease, hostStorage],
  );
  const commitClose = useCallback(
    (
      instanceId: WorkspacePaneInstanceId,
      next: WorkspacePaneHostDocumentV1,
    ) => {
      if (!hasPersistenceLease()) return;
      const successor = next.activeInstanceId;
      const closed = stateRef.current.document.instances.find(
        (instance) => instance.instanceId === instanceId,
      );
      const group = workspacePaneHostGroupContaining(next.root, successor);
      const durablyPublished = persistWorkspacePaneHost(hostStorage, next);
      registerLiveWorkspacePaneHostDocument(
        hostStorage,
        liveReferenceOwner.current,
        next,
      );
      stateRef.current = { ...stateRef.current, document: next };
      dispatch({ type: 'close', instanceId });
      writeWorkspacePaneHostSelection(next, successor);
      if (closed && durablyPublished) {
        onInstanceRemoved?.(closed);
        emitOperationalEvent(closed, 'closed', 'user');
      }
      if (group) focusTab(compact ? 'compact' : group.id, successor);
    },
    [
      compact,
      emitOperationalEvent,
      focusTab,
      hasPersistenceLease,
      hostStorage,
      onInstanceRemoved,
    ],
  );
  const completeClose = useCallback(
    async (instanceId: WorkspacePaneInstanceId) => {
      // Recheck against live state after every asynchronous lifecycle boundary.
      // A user may have selected another tab while close arbitration was pending.
      if (
        !closeWorkspacePaneHostDocument(stateRef.current.document, instanceId)
      )
        return;
      if (runtime) {
        const disposed = await runtime.confirmClose(instanceId);
        if (disposed.status !== 'closed') return;
      }
      if (!hasPersistenceLease()) return;
      const next = closeWorkspacePaneHostDocument(
        stateRef.current.document,
        instanceId,
      );
      if (!next) return;
      commitClose(instanceId, next);
    },
    [commitClose, hasPersistenceLease, runtime],
  );
  const close = useCallback(
    async (instanceId: WorkspacePaneInstanceId) => {
      if (!hasPersistenceLease()) return;
      if (
        !closeWorkspacePaneHostDocument(stateRef.current.document, instanceId)
      )
        return;
      const decision = runtime
        ? await runtime.requestClose(instanceId)
        : { status: 'closed' as const };
      if (decision.status === 'confirm') {
        setCloseConfirmation({ instanceId, reason: decision.reason });
        return;
      }
      if (decision.status === 'closed') await completeClose(instanceId);
    },
    [completeClose, hasPersistenceLease, runtime],
  );
  const confirmClose = useCallback(async () => {
    if (!closeConfirmation) return;
    if (
      closeWorkspacePaneHostDocument(
        stateRef.current.document,
        closeConfirmation.instanceId,
      )
    )
      await completeClose(closeConfirmation.instanceId);
    setCloseConfirmation(null);
  }, [closeConfirmation, completeClose]);
  const resize = useCallback(
    (splitId: string, ratio: number) => {
      if (!hasPersistenceLease()) return;
      pendingResize.current = { splitId, ratio };
      if (resizeFrame.current !== null) return;
      resizeFrame.current = requestAnimationFrame(() => {
        resizeFrame.current = null;
        const pending = pendingResize.current;
        pendingResize.current = null;
        if (pending && hasPersistenceLease())
          dispatch({ type: 'resize', ...pending });
      });
    },
    [hasPersistenceLease],
  );
  const applyHostAction = useCallback(
    (
      action:
        | {
            type: 'reorder';
            instanceId: WorkspacePaneInstanceId;
            toIndex: number;
          }
        | {
            type: 'collapse';
            splitId: string;
            collapsed: 'first' | 'second' | undefined;
          }
        | {
            type: 'maximize';
            instanceId: WorkspacePaneInstanceId | undefined;
          },
    ) => {
      if (!hasPersistenceLease()) return;
      const next = reduceWorkspacePaneHost(stateRef.current, action);
      if (next === stateRef.current) return;
      stateRef.current = next;
      dispatch(action);
      writeWorkspacePaneHostSelection(
        next.document,
        next.document.activeInstanceId,
      );
    },
    [hasPersistenceLease],
  );
  const fail = useCallback(
    (instanceId: WorkspacePaneInstanceId) => {
      dispatch({ type: 'renderer-failed', instanceId, code: 'render-crash' });
      const instance = stateRef.current.document.instances.find(
        (candidate) => candidate.instanceId === instanceId,
      );
      if (instance) {
        const context = operationalEventContext?.(
          instance,
          stateRef.current.document,
        );
        if (!context) {
          void runtime?.fail(instanceId);
          return;
        }
        operationalTrackerRef.current?.emit(
          context,
          'render-failed',
          undefined,
          'render-failed',
        );
      }
      void runtime?.fail(instanceId);
    },
    [operationalEventContext, runtime],
  );
  const retry = useCallback(
    async (instanceId: WorkspacePaneInstanceId) => {
      if (!runtime) {
        dispatch({ type: 'renderer-retry', instanceId });
        return true;
      }
      if (!(await runtime.retry(instanceId))) return false;
      await runtime.reconcileVisible(
        compact
          ? projectCompactWorkspacePaneHost(stateRef.current.document)
              .mountInstanceIds
          : visibleWorkspacePaneHostInstanceIds(stateRef.current.document),
      );
      if (runtime.hasFailed(instanceId)) return false;
      dispatch({ type: 'renderer-retry', instanceId });
      runtime.setFocused(stateRef.current.document.activeInstanceId);
      return true;
    },
    [compact, runtime],
  );
  const replace = useCallback(
    (instance: WorkspacePaneInstance) => {
      if (!hasPersistenceLease()) return false;
      const next = createWorkspacePaneHostBaselineDocument(
        stateRef.current.document.id,
        stateRef.current.document.scope,
        [instance],
      );
      if (!next || !persistWorkspacePaneHost(hostStorage, next)) return false;
      registerLiveWorkspacePaneHostDocument(
        hostStorage,
        liveReferenceOwner.current,
        next,
      );
      stateRef.current = { ...stateRef.current, document: next };
      dispatch({ type: 'restore', document: next });
      writeWorkspacePaneHostSelection(next, instance.instanceId);
      return true;
    },
    [hasPersistenceLease, hostStorage],
  );
  return {
    state,
    persistenceStatus,
    canPersist: persistenceStatus === 'owned',
    tabRefs,
    closeConfirmation,
    select,
    focusExisting,
    focusTab,
    close,
    confirmClose,
    cancelClose: () => setCloseConfirmation(null),
    resize,
    reorder: (instanceId, toIndex) =>
      applyHostAction({ type: 'reorder', instanceId, toIndex }),
    collapse: (splitId, collapsed) =>
      applyHostAction({ type: 'collapse', splitId, collapsed }),
    maximize: (instanceId) => applyHostAction({ type: 'maximize', instanceId }),
    fail,
    retry,
    replace,
    open,
  };
}

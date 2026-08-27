/**
 * Versioned desired/observed Instance reconciliation Interface.
 *
 * Calls for the same instance are serialized by the production Adapter. A
 * deadline expiry is total: a start that may have reached its supervisor is
 * reported partial rather than rolled back speculatively. `reset-home` and
 * installation upgrade are deliberately absent from DesiredInstanceState.
 */
export const STATION_INSTANCE_STATE_VERSION = 1 as const;

export interface StationInstanceRef {
  readonly version: typeof STATION_INSTANCE_STATE_VERSION;
  readonly instanceId: string;
}

export type DesiredInstanceState =
  | {
      readonly version: typeof STATION_INSTANCE_STATE_VERSION;
      readonly kind: 'running';
    }
  | {
      readonly version: typeof STATION_INSTANCE_STATE_VERSION;
      readonly kind: 'stopped';
    };

/** Secret-free registry projection suitable for instance status rendering. */
export interface InstanceRegistryStatus {
  readonly port: number;
  readonly uiPort?: number;
  readonly type: 'service' | 'sidecar' | 'worktree' | 'inline';
  readonly checkout?: string;
  readonly channel?: string;
  readonly buildSha?: string;
  readonly builtAt?: string;
  readonly status?: string;
  readonly pid?: number;
  readonly startedAt?: string;
  readonly allowedOrigins: readonly string[];
}

/** Compatibility projection for the public `station service status` JSON. */
export interface InstanceManifestStatus {
  readonly allowedOrigins?: readonly string[];
  readonly host: string;
  readonly installedAt: string;
  readonly instanceId: string;
  readonly label?: string;
  readonly nodePath: string;
  readonly platform: 'darwin' | 'linux' | 'win32';
  readonly repoPath: string;
  readonly serverPort: number;
  readonly uiPort: number;
  readonly unitName?: string;
  readonly unitPath: string;
  readonly taskName?: string;
}

/** The platform status keeps its public keys while internal decisions use supervisor. */
export type InstanceUnitStatus = Readonly<
  Record<string, boolean | string | null>
> & {
  readonly active: boolean | null;
  readonly present: boolean;
  readonly error?: string | null;
};

/**
 * The complete observed state returned by the reconciler's inspection
 * Interface. Platform adapters translate their process-manager details here;
 * callers render this state but do not probe or reinterpret it.
 */
export interface InstanceState {
  readonly version: typeof STATION_INSTANCE_STATE_VERSION;
  readonly instance: StationInstanceRef;
  readonly manifest: 'present' | 'absent';
  readonly manifestDetails: InstanceManifestStatus | null;
  /** Manifest-derived policy is returned explicitly; raw manifest data is not. */
  readonly allowedOrigins: readonly string[];
  readonly registry: InstanceRegistryStatus | null;
  /** A platform registration without Station's manifest is an orphan. */
  readonly installation: 'managed' | 'orphaned' | 'absent';
  readonly supervisor: {
    readonly state: 'active' | 'inactive' | 'unknown';
    readonly present: boolean;
    readonly enabled: boolean | null;
    readonly linger: boolean | null;
    readonly error: string | null;
  };
  readonly unit: InstanceUnitStatus;
  readonly identity: {
    readonly state: 'healthy' | 'unhealthy' | 'absent';
    readonly healthy: boolean;
    readonly found: boolean;
    readonly instanceId: string;
    readonly bootId?: string;
    readonly sha?: string;
    readonly server: {
      readonly listening: boolean;
      readonly pid: number | null;
      readonly probe:
        | 'ok'
        | 'identity-mismatch'
        | 'http-auth-refused'
        | 'unreachable';
      readonly reachable: boolean;
    };
    readonly ui: {
      readonly listening: boolean;
      readonly pid: number | null;
      readonly probe:
        | 'ok'
        | 'identity-mismatch'
        | 'http-auth-refused'
        | 'unreachable';
      readonly reachable: boolean;
    };
  };
  /** Authenticated readiness is true only for the exact managed identity. */
  readonly ready: boolean;
  readonly ports: {
    readonly server: number | null;
    readonly ui: number | null;
  };
}

/** @deprecated Use the explicit InstanceState name. */
export type ObservedInstanceState = InstanceState;

export type ReconcileOutcome =
  | { kind: 'converged' | 'already-converged'; observed: InstanceState }
  | { kind: 'not-installed'; observed: InstanceState }
  | {
      kind: 'timed-out' | 'contended' | 'partial' | 'failed';
      reason: string;
      observed?: InstanceState;
    };

export interface StationInstanceReconciler {
  inspect(instance: StationInstanceRef): Promise<InstanceState>;
  reconcile(input: {
    instance: StationInstanceRef;
    desired: DesiredInstanceState;
    deadlineMs?: number;
  }): Promise<ReconcileOutcome>;
}

/** Private platform Adapter: launchd/systemd/Windows details do not escape. */
export interface StationInstancePlatformAdapter {
  /**
   * Cross-process instance lock supplied by the production filesystem Adapter.
   * It scopes one lifecycle instance only. An Adapter must not acquire a broad
   * home lock, and must honour the remaining deadline when it can block.
   */
  acquireInstanceLock?(
    instance: StationInstanceRef,
    options: { readonly timeoutMs?: number },
  ): () => void;
  inspect(
    instance: StationInstanceRef,
    signal?: AbortSignal,
  ): Promise<InstanceState>;
  start(instance: StationInstanceRef, signal?: AbortSignal): Promise<void>;
  stop(instance: StationInstanceRef, signal?: AbortSignal): Promise<void>;
  waitForRunning(
    instance: StationInstanceRef,
    deadlineMs?: number,
    signal?: AbortSignal,
  ): Promise<boolean>;
}

interface SharedOperation {
  desired: DesiredInstanceState['kind'];
  outcome: Promise<ReconcileOutcome>;
  settled: Promise<void>;
  progress: { actionStarted: boolean };
}

const sharedOperations = new Map<string, SharedOperation>();

interface ReconciliationDeadline {
  readonly deadlineAt: number | undefined;
  readonly expires: Promise<void>;
  readonly signal: AbortSignal | undefined;
  dispose(): void;
}

function createDeadline(
  deadlineMs: number | undefined,
): ReconciliationDeadline {
  if (deadlineMs === undefined) {
    return {
      deadlineAt: undefined,
      expires: new Promise<void>(() => {}),
      signal: undefined,
      dispose: () => {},
    };
  }
  const controller = new AbortController();
  let resolveExpiry!: () => void;
  const expires = new Promise<void>((resolve) => {
    resolveExpiry = resolve;
  });
  // Unlike AbortSignal.timeout(), this owned timer remains referenced. A CLI
  // process with only a never-settling Adapter must still reach its total
  // deadline outcome instead of exiting with an unsettled top-level await.
  const timer = setTimeout(() => {
    controller.abort(
      new DOMException('Reconciliation deadline expired', 'TimeoutError'),
    );
    resolveExpiry();
  }, deadlineMs);
  return {
    deadlineAt: performance.now() + deadlineMs,
    expires,
    signal: controller.signal,
    dispose: () => clearTimeout(timer),
  };
}

type DeadlineResult<T> =
  | { kind: 'value'; value: T; settled: Promise<void> }
  | { kind: 'timed-out'; settled: Promise<void> };

async function withinDeadline<T>(
  operation: () => Promise<T>,
  deadline: ReconciliationDeadline,
): Promise<DeadlineResult<T>> {
  if (deadline.signal?.aborted || deadlineExpired(deadline.deadlineAt))
    return { kind: 'timed-out', settled: Promise.resolve() };
  const pending = Promise.resolve().then(operation);
  const settled = pending.then(
    () => undefined,
    () => undefined,
  );
  if (!deadline.signal) {
    const value = await pending;
    return deadlineExpired(deadline.deadlineAt)
      ? { kind: 'timed-out', settled }
      : { kind: 'value', value, settled };
  }
  const result = await Promise.race([
    pending.then((value) => ({ kind: 'value' as const, value, settled })),
    deadline.expires.then(() => ({ kind: 'timed-out' as const, settled })),
  ]);
  return result.kind === 'value' && deadlineExpired(deadline.deadlineAt)
    ? { kind: 'timed-out', settled }
    : result;
}

function deadlineExpired(deadlineAt: number | undefined): boolean {
  return deadlineAt !== undefined && performance.now() >= deadlineAt;
}

function timedOutOutcome(actionStarted: boolean): ReconcileOutcome {
  return actionStarted
    ? {
        kind: 'partial',
        reason: 'Reconciliation deadline expired after action may have acted',
      }
    : {
        kind: 'timed-out',
        reason: 'Reconciliation deadline expired before action',
      };
}

function cleanupFailureOutcome(
  actionStarted: boolean,
  error: unknown,
): ReconcileOutcome {
  return {
    kind: actionStarted ? 'partial' : 'failed',
    reason: `Reconciliation lock release failed: ${error instanceof Error ? error.message : String(error)}`,
  };
}

class StationInstanceReconcilerImplementation
  implements StationInstanceReconciler
{
  constructor(private readonly platform: StationInstancePlatformAdapter) {}

  inspect(instance: StationInstanceRef): Promise<InstanceState> {
    return this.platform.inspect(instance);
  }

  async reconcile(input: {
    instance: StationInstanceRef;
    desired: DesiredInstanceState;
    deadlineMs?: number;
  }): Promise<ReconcileOutcome> {
    if (input.deadlineMs !== undefined && input.deadlineMs <= 0) {
      return {
        kind: 'timed-out',
        reason: 'Reconciliation deadline expired before action',
      };
    }
    const deadline = createDeadline(input.deadlineMs);
    const active = sharedOperations.get(input.instance.instanceId);
    if (active) {
      try {
        return active.desired === input.desired.kind
          ? await this.awaitActiveOutcome(active, deadline)
          : {
              kind: 'contended',
              reason: 'An opposing desired state is reconciling',
            };
      } finally {
        deadline.dispose();
      }
    }
    const progress = { actionStarted: false };
    const owned = this.reconcileOwned(input, progress, deadline);
    sharedOperations.set(input.instance.instanceId, {
      desired: input.desired.kind,
      outcome: owned.outcome,
      settled: owned.settled,
      progress,
    });
    void owned.settled.finally(() => {
      if (
        sharedOperations.get(input.instance.instanceId)?.settled ===
        owned.settled
      )
        sharedOperations.delete(input.instance.instanceId);
    });
    return owned.outcome.finally(() => deadline.dispose());
  }

  private async awaitActiveOutcome(
    active: SharedOperation,
    deadline: ReconciliationDeadline,
  ): Promise<ReconcileOutcome> {
    if (deadlineExpired(deadline.deadlineAt))
      return timedOutOutcome(active.progress.actionStarted);
    if (deadline.signal === undefined) return active.outcome;
    const result = await Promise.race([
      active.outcome.then((outcome) => ({ kind: 'value' as const, outcome })),
      deadline.expires.then(() => ({ kind: 'timed-out' as const })),
    ]);
    return result.kind === 'value' && !deadlineExpired(deadline.deadlineAt)
      ? result.outcome
      : timedOutOutcome(active.progress.actionStarted);
  }

  private reconcileOwned(
    input: {
      instance: StationInstanceRef;
      desired: DesiredInstanceState;
      deadlineMs?: number;
    },
    progress: { actionStarted: boolean },
    deadline: ReconciliationDeadline,
  ): { outcome: Promise<ReconcileOutcome>; settled: Promise<void> } {
    const { signal } = deadline;
    const remainingDeadlineMs = () =>
      deadline.deadlineAt === undefined
        ? undefined
        : Math.max(0, Math.ceil(deadline.deadlineAt - performance.now()));
    let release: (() => void) | undefined;
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    let actionStarted = false;
    let deferredSettlement: Promise<void> | undefined;
    const execute = async (): Promise<ReconcileOutcome> => {
      try {
        if (signal?.aborted || deadlineExpired(deadline.deadlineAt))
          return timedOutOutcome(false);
        try {
          release = this.platform.acquireInstanceLock?.(input.instance, {
            timeoutMs: remainingDeadlineMs(),
          });
        } catch (error) {
          if (signal?.aborted || deadlineExpired(deadline.deadlineAt))
            return timedOutOutcome(false);
          return {
            kind: 'contended',
            reason: error instanceof Error ? error.message : String(error),
          };
        }
        if (signal?.aborted || deadlineExpired(deadline.deadlineAt))
          return timedOutOutcome(false);
        const initial = await withinDeadline(
          () => this.platform.inspect(input.instance, signal),
          deadline,
        );
        if (initial.kind === 'timed-out')
          return {
            kind: 'timed-out',
            reason: 'Reconciliation deadline expired before action',
          };
        const before = initial.value;
        if (
          before.manifest === 'absent' &&
          before.installation === 'absent' &&
          before.supervisor.state === 'inactive' &&
          before.identity.state === 'absent'
        ) {
          return {
            kind: 'not-installed',
            observed: before,
          };
        }
        if (before.manifest === 'absent') {
          return {
            kind: 'failed',
            reason:
              'Station service manifest is absent but installation state is not coherently absent',
            observed: before,
          };
        }
        if (
          (input.desired.kind === 'running' &&
            before.supervisor.state === 'active' &&
            before.identity.state === 'healthy') ||
          (input.desired.kind === 'stopped' &&
            before.supervisor.state === 'inactive' &&
            before.identity.state === 'absent')
        )
          return { kind: 'already-converged', observed: before };
        if (input.desired.kind === 'running') {
          const started = await withinDeadline(() => {
            actionStarted = true;
            progress.actionStarted = true;
            return this.platform.start(input.instance, signal);
          }, deadline);
          if (started.kind === 'timed-out') {
            deferredSettlement = started.settled;
            return timedOutOutcome(actionStarted);
          }
          const ready = await withinDeadline(
            () =>
              this.platform.waitForRunning(
                input.instance,
                input.deadlineMs,
                signal,
              ),
            deadline,
          );
          if (ready.kind === 'timed-out' || !ready.value) {
            deferredSettlement = ready.settled;
            return {
              kind: 'partial',
              reason:
                'Station service did not become identity healthy after start',
            };
          }
        } else {
          const stopped = await withinDeadline(() => {
            actionStarted = true;
            progress.actionStarted = true;
            return this.platform.stop(input.instance, signal);
          }, deadline);
          if (stopped.kind === 'timed-out') {
            deferredSettlement = stopped.settled;
            return timedOutOutcome(actionStarted);
          }
        }
        const final = await withinDeadline(
          () => this.platform.inspect(input.instance, signal),
          deadline,
        );
        if (final.kind === 'timed-out') {
          deferredSettlement = final.settled;
          return timedOutOutcome(actionStarted);
        }
        const after = final.value;
        const converged =
          input.desired.kind === 'running'
            ? after.supervisor.state === 'active' &&
              after.identity.state === 'healthy'
            : after.supervisor.state === 'inactive' &&
              after.identity.state === 'absent';
        return converged
          ? { kind: 'converged', observed: after }
          : {
              kind: 'partial',
              reason:
                'Platform action completed without desired observed state',
              observed: after,
            };
      } catch (error) {
        return {
          kind: actionStarted ? 'partial' : 'failed',
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    };
    const outcome = (async (): Promise<ReconcileOutcome> => {
      const result = await execute();
      // A timed-out Adapter may still be executing an external action. Keep
      // both the shared and filesystem coordination until it settles, so a
      // second reconciler cannot issue an opposing action into uncertainty.
      if (deferredSettlement) {
        void deferredSettlement.finally(() => {
          try {
            release?.();
          } catch (error) {
            // The caller already has a partial outcome. Preserve that total
            // result and make delayed cleanup uncertainty visible to the
            // operator rather than silently treating it as converged.
            console.error(
              `Reconciliation lock release failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          settle();
        });
        return result;
      }
      try {
        release?.();
      } catch (error) {
        return cleanupFailureOutcome(actionStarted, error);
      } finally {
        settle();
      }
      return result;
    })();
    return { outcome, settled };
  }
}

export function createStationInstanceReconciler(
  platform: StationInstancePlatformAdapter,
): StationInstanceReconciler {
  return new StationInstanceReconcilerImplementation(platform);
}

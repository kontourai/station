import type { WorkspacePaneInstanceId } from '@kontourai/station-contracts/workspace-pane';

export type WorkspacePaneCloseReason = 'dirty' | 'pending';
export type WorkspacePaneBeforeCloseResult =
  | 'allow'
  | { confirm: WorkspacePaneCloseReason };

export interface WorkspacePaneRuntimeCallbacks {
  mount(): void | Promise<void>;
  suspend(): void | Promise<void>;
  resume(): void | Promise<void>;
  dispose(): void | Promise<void>;
  beforeClose?():
    | WorkspacePaneBeforeCloseResult
    | Promise<WorkspacePaneBeforeCloseResult>;
}

export type WorkspacePaneCloseDecision =
  | { status: 'closed' }
  | { status: 'confirm'; reason: WorkspacePaneCloseReason }
  | { status: 'missing' }
  | { status: 'error' };

/** Reported only after the corresponding renderer callback completed successfully. */
export type WorkspacePaneRuntimeTransition =
  | { kind: 'ready'; instanceId: WorkspacePaneInstanceId }
  | { kind: 'resumed'; instanceId: WorkspacePaneInstanceId }
  | { kind: 'suspended'; instanceId: WorkspacePaneInstanceId };
export type WorkspacePaneRuntimeTransitionObserver = (
  transition: WorkspacePaneRuntimeTransition,
) => void;

/** UI-local lifecycle owner. Its functions, mounted set, and failures never enter serial host persistence. */
export class WorkspacePaneHostRuntime {
  private readonly callbacks = new Map<string, WorkspacePaneRuntimeCallbacks>();
  private readonly mounted = new Set<string>();
  private readonly cleanupRequired = new Set<string>();
  private readonly failures = new Set<string>();
  /** A revoked occurrence cannot reach callbacks while its cleanup is pending. */
  private readonly revoked = new Set<string>();
  /** Mounted renderers may be visible together; focus is a separate identity. */
  private readonly visible = new Set<string>();
  /** Latest reconcile membership, tracked per occurrence rather than globally. */
  private readonly visibleTargets = new Map<string, boolean>();
  private active: string | null = null;
  private reconcileRevision = 0;
  private reconcileChain: Promise<void> = Promise.resolve();
  private readonly instanceChains = new Map<string, Promise<void>>();

  /** Prevent retry/failure/close from interleaving on the same renderer. */
  private async serialize<T>(
    instanceId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const prior = this.instanceChains.get(instanceId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = prior.then(
      () => gate,
      () => gate,
    );
    this.instanceChains.set(instanceId, queued);
    await prior.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.instanceChains.get(instanceId) === queued)
        this.instanceChains.delete(instanceId);
    }
  }

  register(
    instanceId: WorkspacePaneInstanceId,
    callbacks: WorkspacePaneRuntimeCallbacks,
  ): boolean {
    // Replacing a mounted callback would make the replacement resume a renderer
    // it never mounted. Callers must dispose/reset the existing registration first.
    if (this.callbacks.has(instanceId) || this.revoked.has(instanceId))
      return false;
    this.callbacks.set(instanceId, callbacks);
    this.failures.delete(instanceId);
    return true;
  }

  /** Renderer-owned close guard; kept out of persisted pane state. */
  setBeforeClose(
    instanceId: WorkspacePaneInstanceId,
    beforeClose: WorkspacePaneRuntimeCallbacks['beforeClose'],
  ): boolean {
    const callbacks = this.callbacks.get(instanceId);
    if (!callbacks) return false;
    callbacks.beforeClose = beforeClose;
    return true;
  }

  get activeInstanceId(): string | null {
    return this.active;
  }
  isMounted(instanceId: WorkspacePaneInstanceId): boolean {
    return this.mounted.has(instanceId);
  }
  hasFailed(instanceId: WorkspacePaneInstanceId): boolean {
    return this.failures.has(instanceId);
  }
  isRevoked(instanceId: WorkspacePaneInstanceId): boolean {
    return this.revoked.has(instanceId);
  }
  requiresCleanup(instanceId: WorkspacePaneInstanceId): boolean {
    return this.cleanupRequired.has(instanceId);
  }

  visibleInstanceIds(): readonly string[] {
    return [...this.visible];
  }

  /** Update navigation focus without suspending desktop siblings. */
  setFocused(instanceId: WorkspacePaneInstanceId): boolean {
    if (!this.callbacks.has(instanceId) || this.revoked.has(instanceId))
      return false;
    this.active = instanceId;
    return true;
  }

  /**
   * Reconciles renderer visibility independently from focus. Each callback is
   * isolated so a failed branch never tears down a healthy visible sibling.
   */
  async reconcileVisible(
    instanceIds: readonly WorkspacePaneInstanceId[],
    onTransition?: WorkspacePaneRuntimeTransitionObserver,
  ): Promise<ReadonlySet<string>> {
    const revision = ++this.reconcileRevision;
    const target = new Set<string>(
      instanceIds.filter(
        (instanceId) =>
          this.callbacks.has(instanceId) &&
          !this.failures.has(instanceId) &&
          !this.revoked.has(instanceId),
      ),
    );
    for (const instanceId of this.callbacks.keys())
      this.visibleTargets.set(instanceId, target.has(instanceId));
    const run = async () => {
      if (revision !== this.reconcileRevision) return;
      await this.reconcileTarget(target, revision, onTransition);
    };
    const queued = this.reconcileChain.then(run, run);
    this.reconcileChain = queued.then(
      () => undefined,
      () => undefined,
    );
    await queued;
    return new Set(this.visible);
  }

  private async reconcileTarget(
    target: ReadonlySet<string>,
    revision: number,
    onTransition?: WorkspacePaneRuntimeTransitionObserver,
  ): Promise<void> {
    for (const instanceId of [...this.visible]) {
      if (revision !== this.reconcileRevision) return;
      if (target.has(instanceId)) continue;
      await this.serialize(instanceId, async () => {
        const callbacks = this.callbacks.get(instanceId);
        try {
          await callbacks?.suspend();
          this.visible.delete(instanceId);
          onTransition?.({
            kind: 'suspended',
            instanceId: instanceId as WorkspacePaneInstanceId,
          });
        } catch {
          this.failures.add(instanceId);
          this.visibleTargets.set(instanceId, false);
          this.visible.delete(instanceId);
          if (this.active === instanceId) this.active = null;
        }
      });
    }
    for (const instanceId of target) {
      if (revision !== this.reconcileRevision) return;
      if (this.visible.has(instanceId)) continue;
      await this.serialize(instanceId, async () => {
        if (
          this.failures.has(instanceId) ||
          this.visible.has(instanceId) ||
          this.revoked.has(instanceId)
        )
          return;
        const callbacks = this.callbacks.get(instanceId);
        if (!callbacks) return;
        try {
          const wasMounted = this.mounted.has(instanceId);
          const mounted = wasMounted
            ? await this.resumeOwned(instanceId, callbacks)
            : await this.mountOwned(instanceId, callbacks);
          if (!mounted || !this.isLifecycleCurrent(instanceId, revision))
            return;
          this.visible.add(instanceId);
          onTransition?.({
            kind: wasMounted ? 'resumed' : 'ready',
            instanceId: instanceId as WorkspacePaneInstanceId,
          });
        } catch {
          await this.recordMountFailure(instanceId, callbacks);
        }
      });
    }
  }

  /** Clears only a local failure after any unresolved allocation is cleaned. */
  async retry(instanceId: WorkspacePaneInstanceId): Promise<boolean> {
    if (this.revoked.has(instanceId))
      return this.retryRevokedCleanup(instanceId);
    return this.serialize(instanceId, () => this.retryInternal(instanceId));
  }

  /** Retries only a tombstoned occurrence's retained cleanup ownership. */
  async retryRevokedCleanup(
    instanceId: WorkspacePaneInstanceId,
  ): Promise<boolean> {
    if (!this.revoked.has(instanceId)) return false;
    return this.serialize(instanceId, () =>
      this.disposeRevokedInternal(instanceId),
    );
  }

  private async retryInternal(
    instanceId: WorkspacePaneInstanceId,
  ): Promise<boolean> {
    const callbacks = this.callbacks.get(instanceId);
    if (!callbacks) return false;
    if (this.mounted.has(instanceId) || this.cleanupRequired.has(instanceId)) {
      try {
        await callbacks.dispose();
        this.mounted.delete(instanceId);
        this.cleanupRequired.delete(instanceId);
        this.visible.delete(instanceId);
      } catch {
        // A retry never forgets cleanup it failed to complete.
        this.failures.add(instanceId);
        return false;
      }
    }
    this.failures.delete(instanceId);
    return true;
  }

  async activate(instanceId: WorkspacePaneInstanceId): Promise<boolean> {
    return this.serialize(instanceId, () => this.activateInternal(instanceId));
  }

  private async activateInternal(
    instanceId: WorkspacePaneInstanceId,
  ): Promise<boolean> {
    const revision = this.reconcileRevision;
    const next = this.callbacks.get(instanceId);
    if (!next || this.failures.has(instanceId) || this.revoked.has(instanceId))
      return false;
    if (this.active === instanceId) return true;
    const previousId = this.active;
    const previous = previousId ? this.callbacks.get(previousId) : undefined;
    if (previous) {
      try {
        await previous.suspend();
        this.visible.delete(previousId!);
      } catch {
        this.failures.add(previousId!);
        this.active = null;
        return false;
      }
    }
    try {
      if (!this.isLifecycleCurrent(instanceId, revision)) {
        await this.restorePrevious(previousId, previous);
        return false;
      }
      const mounted = this.mounted.has(instanceId)
        ? await this.resumeOwned(instanceId, next)
        : await this.mountOwned(instanceId, next);
      if (!mounted || !this.isLifecycleCurrent(instanceId, revision)) {
        await this.restorePrevious(previousId, previous);
        return false;
      }
      this.active = instanceId;
      this.visible.add(instanceId);
      return true;
    } catch {
      await this.recordMountFailure(instanceId, next);
      // Roll back to the still-mounted prior renderer before exposing failure.
      await this.restorePrevious(previousId, previous);
      return false;
    }
  }

  async requestClose(
    instanceId: WorkspacePaneInstanceId,
  ): Promise<WorkspacePaneCloseDecision> {
    return this.serialize(instanceId, () =>
      this.requestCloseInternal(instanceId),
    );
  }

  private async requestCloseInternal(
    instanceId: WorkspacePaneInstanceId,
  ): Promise<WorkspacePaneCloseDecision> {
    if (this.revoked.has(instanceId)) return { status: 'missing' };
    const callbacks = this.callbacks.get(instanceId);
    if (!callbacks) return { status: 'missing' };
    let result: WorkspacePaneBeforeCloseResult;
    try {
      result = (await callbacks.beforeClose?.()) ?? 'allow';
    } catch {
      return { status: 'error' };
    }
    if (result !== 'allow')
      return { status: 'confirm', reason: result.confirm };
    // The controller validates its serial document transition before asking
    // the runtime to dispose. `closed` here means close is allowed, not that
    // the occurrence has already disappeared.
    return { status: 'closed' };
  }

  async confirmClose(
    instanceId: WorkspacePaneInstanceId,
  ): Promise<WorkspacePaneCloseDecision> {
    return this.serialize(instanceId, async () => {
      if (!this.callbacks.has(instanceId)) return { status: 'missing' };
      return (await this.disposeInternal(instanceId))
        ? { status: 'closed' }
        : { status: 'error' };
    });
  }

  /**
   * Makes a catalog-revoked occurrence unreachable before its asynchronous
   * disposal begins. A failed disposal retains the callback only for the
   * explicit retry path; it can never be focused, mounted, or replaced.
   */
  async revoke(
    instanceId: WorkspacePaneInstanceId,
  ): Promise<WorkspacePaneCloseDecision> {
    this.tombstone(instanceId);
    return this.serialize(instanceId, async () =>
      (await this.disposeRevokedInternal(instanceId))
        ? { status: 'closed' }
        : { status: 'error' },
    );
  }

  async fail(instanceId: WorkspacePaneInstanceId): Promise<void> {
    await this.serialize(instanceId, async () => {
      if (!this.revoked.has(instanceId)) await this.failInternal(instanceId);
    });
  }

  private async failInternal(
    instanceId: WorkspacePaneInstanceId,
  ): Promise<void> {
    this.failures.add(instanceId);
    this.visibleTargets.set(instanceId, false);
    this.visible.delete(instanceId);
    if (this.active === instanceId) this.active = null;
    // A failed renderer is isolated: never dispose/reset unrelated pane callbacks.
    const callbacks = this.callbacks.get(instanceId);
    if (
      callbacks &&
      (this.mounted.has(instanceId) || this.cleanupRequired.has(instanceId))
    ) {
      try {
        await callbacks.dispose();
        this.mounted.delete(instanceId);
        this.cleanupRequired.delete(instanceId);
      } catch {
        // Failure stays isolated and retryable; do not claim a mounted pane disposed.
      }
    }
  }

  private async recordMountFailure(
    instanceId: string,
    callbacks: WorkspacePaneRuntimeCallbacks,
  ): Promise<void> {
    this.visible.delete(instanceId);
    this.failures.add(instanceId);
    this.visibleTargets.set(instanceId, false);
    if (this.mounted.has(instanceId) || !this.cleanupRequired.has(instanceId))
      return;
    try {
      await callbacks.dispose();
      this.cleanupRequired.delete(instanceId);
    } catch {
      // Mount may have allocated before throwing. Retain cleanup ownership until
      // a later close/reset can dispose it successfully.
      this.cleanupRequired.add(instanceId);
    }
  }

  private async disposeInternal(
    instanceId: WorkspacePaneInstanceId,
  ): Promise<boolean> {
    const callbacks = this.callbacks.get(instanceId);
    if (!callbacks) return false;
    if (this.mounted.has(instanceId) || this.cleanupRequired.has(instanceId)) {
      try {
        await callbacks.dispose();
      } catch {
        this.failures.add(instanceId);
        this.visibleTargets.set(instanceId, false);
        return false;
      }
      this.mounted.delete(instanceId);
      this.cleanupRequired.delete(instanceId);
      this.visible.delete(instanceId);
    }
    this.callbacks.delete(instanceId);
    this.visibleTargets.delete(instanceId);
    this.failures.delete(instanceId);
    if (this.active === instanceId) this.active = null;
    return true;
  }

  private tombstone(instanceId: WorkspacePaneInstanceId): void {
    this.revoked.add(instanceId);
    this.visibleTargets.set(instanceId, false);
    this.visible.delete(instanceId);
    if (this.active === instanceId) this.active = null;
    // Prevent an already queued visibility pass from remounting the occurrence.
    this.reconcileRevision += 1;
  }

  /** A callback result may publish only while its exact lifecycle is current. */
  private isLifecycleCurrent(instanceId: string, revision: number): boolean {
    return (
      revision === this.reconcileRevision &&
      !this.revoked.has(instanceId) &&
      this.callbacks.has(instanceId)
    );
  }

  /** Claim cleanup before awaiting a mount that may allocate before resolving. */
  private async mountOwned(
    instanceId: string,
    callbacks: WorkspacePaneRuntimeCallbacks,
  ): Promise<boolean> {
    this.cleanupRequired.add(instanceId);
    try {
      await callbacks.mount();
      this.mounted.add(instanceId);
      this.cleanupRequired.delete(instanceId);
      return true;
    } catch {
      await this.recordMountFailure(instanceId, callbacks);
      return false;
    }
  }

  /** Resume retains the existing mount allocation; the caller validates after it settles. */
  private async resumeOwned(
    instanceId: string,
    callbacks: WorkspacePaneRuntimeCallbacks,
  ): Promise<boolean> {
    try {
      await callbacks.resume();
      return true;
    } catch {
      this.failures.add(instanceId);
      this.visibleTargets.set(instanceId, false);
      return false;
    }
  }

  private async restorePrevious(
    previousId: string | null,
    previous: WorkspacePaneRuntimeCallbacks | undefined,
  ): Promise<void> {
    if (!previousId || !previous) return;
    if (!this.isRollbackEligible(previousId)) {
      if (this.active === previousId) this.active = null;
      return;
    }
    try {
      await previous.resume();
      if (this.isRollbackEligible(previousId)) {
        this.active = previousId;
        this.visible.add(previousId);
      } else if (this.active === previousId) this.active = null;
    } catch {
      // Never report a renderer that failed rollback-resume as active.
      if (this.active === previousId) this.active = null;
      this.failures.add(previousId);
    }
  }

  /** A target-only invalidation cannot displace a still-admitted sibling. */
  private isRollbackEligible(instanceId: string): boolean {
    return (
      this.callbacks.has(instanceId) &&
      !this.revoked.has(instanceId) &&
      !this.failures.has(instanceId) &&
      this.visibleTargets.get(instanceId) !== false
    );
  }

  private async disposeRevokedInternal(
    instanceId: WorkspacePaneInstanceId,
  ): Promise<boolean> {
    const callbacks = this.callbacks.get(instanceId);
    if (!callbacks) {
      this.cleanupRequired.delete(instanceId);
      this.mounted.delete(instanceId);
      this.failures.delete(instanceId);
      this.visibleTargets.delete(instanceId);
      this.revoked.delete(instanceId);
      return true;
    }
    if (this.mounted.has(instanceId) || this.cleanupRequired.has(instanceId)) {
      try {
        await callbacks.dispose();
      } catch {
        // Retain sole cleanup ownership while the tombstone blocks all use.
        this.cleanupRequired.add(instanceId);
        this.failures.add(instanceId);
        return false;
      }
    }
    this.callbacks.delete(instanceId);
    this.visibleTargets.delete(instanceId);
    this.mounted.delete(instanceId);
    this.cleanupRequired.delete(instanceId);
    this.failures.delete(instanceId);
    this.visible.delete(instanceId);
    if (this.active === instanceId) this.active = null;
    // The old callback is gone, so a same-ID catalog replacement may register.
    this.revoked.delete(instanceId);
    return true;
  }
}

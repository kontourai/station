import { FOREGROUND_MESSAGE_INDETERMINATE_CODE } from '@kontourai/station-contracts/orchestration';
import {
  type CanonicalRuntimeEvent,
  isDeferredRetriableTurnError,
} from '@kontourai/station-contracts/runtime-events';
import type {
  SessionTurnBoundaryAuthority,
  SessionTurnBoundaryClaim,
} from './session-turn-boundary.js';
import { createInMemorySessionTurnBoundaryAuthority } from './session-turn-boundary.js';
import { WorkspaceExecutionBarrier } from './workspace-execution-barrier.js';

type ThreadState = {
  activeTurnIds: Set<string>;
  begunInvocationIds: Set<string>;
  terminalInvocationIds: string[];
  terminalTurnIds: string[];
  turnStartActive: boolean;
  lifecycleActive: boolean;
  turnWaiters: Array<() => void>;
  lifecycleWaiters: Array<() => void>;
};

const TERMINAL_TURN_MEMORY = 32;

/** Stable possible-effect error consumed by foreground route/SDK boundaries. */
export class SessionTurnStartIndeterminateError extends Error {
  readonly code = FOREGROUND_MESSAGE_INDETERMINATE_CODE;
  readonly outcome = 'indeterminate' as const;

  constructor() {
    super(
      'The provider turn may have started. Inspect the session; do not retry.',
    );
    this.name = 'SessionTurnStartIndeterminateError';
  }
}

/**
 * A lifecycle transition the boundary refused because a turn owns the Session
 * (`active-turn`) or another claim does (`busy`). Distinct from a failure of
 * the transition's own operation, which this never wraps.
 */
export class SessionLifecycleClaimRefusedError extends Error {
  readonly name = 'SessionLifecycleClaimRefusedError';

  constructor(
    readonly reason: 'active-turn' | 'busy',
    message: string,
  ) {
    super(message);
  }
}

/**
 * Owns local ordering and composes the durable provider boundary for one
 * orchestration thread. Distinct provider starts are serialized, while a
 * deduplicated caller can still join the winning dispatch outside this seam.
 */
export class SessionExecutionCoordinator {
  private readonly states = new Map<string, ThreadState>();
  private readonly pendingLifecycleReleases = new Map<
    string,
    () => { kind: string }
  >();

  constructor(
    private readonly boundaries: SessionTurnBoundaryAuthority = createInMemorySessionTurnBoundaryAuthority(),
    private readonly workspaces = new WorkspaceExecutionBarrier(),
  ) {}

  async runTurnStart<T>(
    threadId: string,
    operation: (claim: SessionTurnBoundaryClaim) => Promise<T>,
    workspaceKey?: string,
    preparedIntent = false,
  ): Promise<T> {
    if (workspaceKey)
      return this.workspaces.runTurnStart(
        workspaceKey,
        threadId,
        () => this.runThreadTurnStart(threadId, operation, preparedIntent),
        () => this.hasActiveTurn(threadId),
      );
    return this.runThreadTurnStart(threadId, operation, preparedIntent);
  }

  /** Uses the same local/workspace barriers while a guarded resume adopts its durable fence. */
  async runPreparedTurnStart<T>(
    threadId: string,
    operation: () => Promise<T>,
    workspaceKey?: string,
  ): Promise<T> {
    if (workspaceKey)
      return this.workspaces.runTurnStart(
        workspaceKey,
        threadId,
        () => this.runPreparedTurnStart(threadId, operation),
        () => this.hasActiveTurn(threadId),
      );
    await this.acquireTurnStart(threadId);
    try {
      if (!this.retryPendingLifecycleRelease(threadId))
        throw new Error('Prepared turn input is unavailable.');
      return await operation();
    } finally {
      this.releaseTurnStart(threadId);
    }
  }

  private async runThreadTurnStart<T>(
    threadId: string,
    operation: (claim: SessionTurnBoundaryClaim) => Promise<T>,
    preparedIntent: boolean,
  ): Promise<T> {
    await this.acquireTurnStart(threadId);
    let owned:
      | Extract<
          ReturnType<SessionTurnBoundaryAuthority['claim']>,
          { kind: 'owner' }
        >
      | undefined;
    try {
      if (!this.retryPendingLifecycleRelease(threadId)) {
        throw new Error(
          'Session lifecycle coordination is temporarily unavailable.',
        );
      }
      const claimed =
        preparedIntent && this.boundaries.reserve
          ? this.boundaries.reserve(threadId, new Date().toISOString())
          : this.boundaries.claim(threadId, new Date().toISOString());
      if (claimed.kind !== 'owner') {
        throw new Error(
          claimed.kind === 'busy'
            ? `Session already has a turn start in progress: ${threadId}`
            : 'Session turn coordination is temporarily unavailable.',
        );
      }
      owned = claimed;
      return await operation(owned.claim);
    } finally {
      // A pre-invocation/dedup path leaves the opaque claim prepared. The
      // one-way capability makes this a no-op once invocation or terminal
      // settlement has been chosen.
      owned?.claim.notInvoked();
      this.releaseTurnStart(threadId);
    }
  }

  runWorkspaceExclusive<T>(
    workspaceKey: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.workspaces.runExclusive(workspaceKey, operation);
  }

  async runLifecycleTransition<T>(
    threadId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    await this.acquireLifecycle(threadId);
    let owned:
      | Extract<
          ReturnType<SessionTurnBoundaryAuthority['claimLifecycle']>,
          { kind: 'owner' }
        >
      | undefined;
    try {
      if (!this.retryPendingLifecycleRelease(threadId)) {
        throw new Error(
          'Session lifecycle coordination is temporarily unavailable.',
        );
      }
      const claimed = this.boundaries.claimLifecycle(
        threadId,
        new Date().toISOString(),
      );
      if (claimed.kind === 'active-turn' || claimed.kind === 'busy') {
        throw new SessionLifecycleClaimRefusedError(
          claimed.kind,
          claimed.kind === 'active-turn'
            ? `Session has an active turn: ${threadId}`
            : `Session lifecycle transition is already in progress: ${threadId}`,
        );
      }
      if (claimed.kind !== 'owner') {
        throw new Error(
          'Session lifecycle coordination is temporarily unavailable.',
        );
      }
      owned = claimed;
      return await operation();
    } finally {
      if (owned) {
        const lifecycleOwner = owned;
        const release = () => lifecycleOwner.release();
        if (release().kind !== 'applied') {
          this.pendingLifecycleReleases.set(threadId, release);
        }
      }
      this.releaseLifecycle(threadId);
    }
  }

  /** Returns false when the exact terminal arrived before sendTurn resolved. */
  markTurnBegun(threadId: string, invocationId: string): void {
    this.state(threadId).begunInvocationIds.add(invocationId);
  }

  markTurnAccepted(
    threadId: string,
    turnId: string,
    invocationId?: string,
  ): boolean {
    const state = this.state(threadId);
    const key = JSON.stringify([turnId, invocationId ?? null]);
    if (invocationId) state.begunInvocationIds.delete(invocationId);
    if (
      invocationId
        ? state.terminalInvocationIds.includes(invocationId)
        : state.terminalTurnIds.includes(key)
    )
      return false;
    state.activeTurnIds.add(key);
    return true;
  }

  settleInvocation(threadId: string, invocationId: string): void {
    const state = this.states.get(threadId);
    if (!state) return;
    state.begunInvocationIds.delete(invocationId);
    for (const key of state.activeTurnIds)
      if (JSON.parse(key)[1] === invocationId) state.activeTurnIds.delete(key);
    this.deleteEmptyState(threadId, state);
  }

  invocationForTurn(threadId: string, turnId: string): string | undefined {
    const ids = [...(this.states.get(threadId)?.activeTurnIds ?? [])]
      .map((key) => JSON.parse(key) as [string | null, string | null])
      .filter(([native]) => native === turnId)
      .map(([, invocation]) => invocation);
    return ids.length === 1 && ids[0] !== null ? ids[0] : undefined;
  }

  ownsTurnEvent(event: CanonicalRuntimeEvent): boolean {
    const state = this.states.get(event.threadId);
    if (!state) return true;
    if (
      event.method === 'session.exited' ||
      (event.method === 'runtime.error' &&
        event.turnId === undefined &&
        event.invocationId === undefined)
    )
      return true;
    if (event.invocationId !== undefined)
      return (
        state.begunInvocationIds.has(event.invocationId) ||
        state.activeTurnIds.has(
          JSON.stringify([event.turnId ?? null, event.invocationId]),
        )
      );
    return (
      state.begunInvocationIds.size === 0 &&
      ![...state.activeTurnIds].some((key) => JSON.parse(key)[1] !== null)
    );
  }

  observe(event: CanonicalRuntimeEvent): void {
    const observed = this.boundaries.observe(event);
    if (observed.kind !== 'applied') return;
    const state = this.state(event.threadId);
    const key = JSON.stringify([
      event.turnId ?? null,
      event.invocationId ?? null,
    ]);
    if (event.method === 'turn.started' && event.turnId) {
      const known =
        state.begunInvocationIds.size > 0 ||
        [...state.activeTurnIds].some((key) => JSON.parse(key)[1] !== null);
      if (
        !known ||
        (event.invocationId &&
          (state.begunInvocationIds.has(event.invocationId) ||
            state.activeTurnIds.has(key)))
      ) {
        state.activeTurnIds.add(key);
      }
      return;
    }
    if (
      ![
        'turn.completed',
        'turn.aborted',
        'runtime.error',
        'session.exited',
      ].includes(event.method) ||
      isDeferredRetriableTurnError(event) ||
      (event.method === 'runtime.error' &&
        event.code === 'SESSION_START_INDETERMINATE') ||
      (event.method === 'turn.aborted' && event.recoveryTerminal === true)
    )
      return;
    if (
      event.invocationId === undefined &&
      state.turnStartActive &&
      state.begunInvocationIds.size === 0 &&
      state.activeTurnIds.has(key)
    ) {
      state.terminalTurnIds = [
        ...state.terminalTurnIds.filter((id) => id !== key),
        key,
      ].slice(-TERMINAL_TURN_MEMORY);
      state.activeTurnIds.delete(key);
    }
    const disposition = this.boundaries.hasPossibleEffect(event.threadId);
    if (disposition.kind !== 'available' || disposition.active) return;
    const sessionTerminal =
      event.method === 'session.exited' ||
      (event.method === 'runtime.error' &&
        event.turnId === undefined &&
        event.invocationId === undefined);
    const matched =
      state.activeTurnIds.has(key) ||
      (event.invocationId !== undefined &&
        state.begunInvocationIds.has(event.invocationId)) ||
      state.terminalTurnIds.includes(key);
    if (!sessionTerminal && !matched) return;
    if (sessionTerminal) {
      state.activeTurnIds.clear();
      state.begunInvocationIds.clear();
    } else {
      state.activeTurnIds.delete(key);
      if (
        event.invocationId &&
        state.begunInvocationIds.has(event.invocationId)
      ) {
        state.terminalInvocationIds = [
          ...state.terminalInvocationIds.filter(
            (id) => id !== event.invocationId,
          ),
          event.invocationId,
        ].slice(-TERMINAL_TURN_MEMORY);
        state.begunInvocationIds.delete(event.invocationId);
      } else if (!event.invocationId && state.turnStartActive) {
        state.terminalTurnIds = [
          ...state.terminalTurnIds.filter((id) => id !== key),
          key,
        ].slice(-TERMINAL_TURN_MEMORY);
      }
    }
    // The committed projection has disposed every durable effect on this thread.
    state.activeTurnIds.clear();
    state.begunInvocationIds.clear();
    this.workspaces.releaseThread(event.threadId);
    this.deleteEmptyState(event.threadId, state);
  }

  /** Threads this coordinator holds turn state for (#3851 idle check). */
  threadIdsWithTurnState(): string[] {
    return [...this.states.keys()];
  }

  hasActiveTurn(threadId: string): boolean {
    const state = this.states.get(threadId);
    if (
      (state?.activeTurnIds.size ?? 0) > 0 ||
      (state?.begunInvocationIds.size ?? 0) > 0
    )
      return true;
    const durable = this.boundaries.hasPossibleEffect(threadId);
    return durable.kind === 'unavailable' || durable.active;
  }

  private acquireTurnStart(threadId: string): Promise<void> {
    const state = this.state(threadId);
    if (
      !state.lifecycleActive &&
      !state.turnStartActive &&
      state.lifecycleWaiters.length === 0
    ) {
      state.turnStartActive = true;
      return Promise.resolve();
    }
    return new Promise((resolve) => state.turnWaiters.push(resolve));
  }

  private retryPendingLifecycleRelease(threadId: string): boolean {
    const pending = this.pendingLifecycleReleases.get(threadId);
    if (!pending) return true;
    if (pending().kind !== 'applied') return false;
    this.pendingLifecycleReleases.delete(threadId);
    return true;
  }

  private releaseTurnStart(threadId: string): void {
    const state = this.state(threadId);
    state.turnStartActive = false;
    state.terminalTurnIds = [];
    state.terminalInvocationIds = [];
    this.drain(threadId, state);
  }

  private acquireLifecycle(threadId: string): Promise<void> {
    const state = this.state(threadId);
    if (!state.lifecycleActive && !state.turnStartActive) {
      state.lifecycleActive = true;
      return Promise.resolve();
    }
    return new Promise((resolve) => state.lifecycleWaiters.push(resolve));
  }

  private releaseLifecycle(threadId: string): void {
    const state = this.state(threadId);
    state.lifecycleActive = false;
    this.drain(threadId, state);
  }

  private drain(threadId: string, state: ThreadState): void {
    if (state.lifecycleActive || state.turnStartActive) return;
    const lifecycle = state.lifecycleWaiters.shift();
    if (lifecycle) {
      state.lifecycleActive = true;
      lifecycle();
      return;
    }
    const turn = state.turnWaiters.shift();
    if (turn) {
      state.turnStartActive = true;
      turn();
      return;
    }
    this.deleteEmptyState(threadId, state);
  }

  private state(threadId: string): ThreadState {
    let state = this.states.get(threadId);
    if (!state) {
      state = {
        activeTurnIds: new Set(),
        begunInvocationIds: new Set(),
        terminalInvocationIds: [],
        terminalTurnIds: [],
        turnStartActive: false,
        lifecycleActive: false,
        turnWaiters: [],
        lifecycleWaiters: [],
      };
      this.states.set(threadId, state);
    }
    return state;
  }

  private deleteEmptyState(threadId: string, state: ThreadState): void {
    if (
      state.activeTurnIds.size === 0 &&
      state.begunInvocationIds.size === 0 &&
      state.terminalTurnIds.length === 0 &&
      !state.turnStartActive &&
      !state.lifecycleActive &&
      state.turnWaiters.length === 0 &&
      state.lifecycleWaiters.length === 0
    ) {
      this.states.delete(threadId);
    }
  }
}

import { FOREGROUND_MESSAGE_INDETERMINATE_CODE } from '@kontourai/station-contracts/orchestration';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import type {
  SessionTurnBoundaryAuthority,
  SessionTurnBoundaryClaim,
} from './session-turn-boundary.js';
import { createInMemorySessionTurnBoundaryAuthority } from './session-turn-boundary.js';

type ThreadState = {
  activeTurnIds: Set<string>;
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
  ) {}

  async runTurnStart<T>(
    threadId: string,
    operation: (claim: SessionTurnBoundaryClaim) => Promise<T>,
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
      const claimed = this.boundaries.claim(threadId, new Date().toISOString());
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
      if (claimed.kind !== 'owner') {
        throw new Error(
          claimed.kind === 'active-turn'
            ? `Session has an active turn: ${threadId}`
            : claimed.kind === 'busy'
              ? `Session lifecycle transition is already in progress: ${threadId}`
              : 'Session lifecycle coordination is temporarily unavailable.',
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
  markTurnAccepted(threadId: string, turnId: string): boolean {
    const state = this.state(threadId);
    if (state.terminalTurnIds.includes(turnId)) return false;
    state.activeTurnIds.add(turnId);
    return true;
  }

  forgetAcceptedTurn(threadId: string, turnId: string): void {
    const state = this.states.get(threadId);
    if (!state) return;
    state.activeTurnIds.delete(turnId);
    this.deleteEmptyState(threadId, state);
  }

  observe(event: CanonicalRuntimeEvent): void {
    this.boundaries.observe(event);
    if (event.method === 'turn.started' && event.turnId) {
      const state = this.state(event.threadId);
      state.terminalTurnIds = state.terminalTurnIds.filter(
        (turnId) => turnId !== event.turnId,
      );
      state.activeTurnIds.add(event.turnId);
      return;
    }
    if (
      event.method !== 'turn.completed' &&
      event.method !== 'turn.aborted' &&
      event.method !== 'runtime.error' &&
      event.method !== 'session.exited'
    ) {
      return;
    }
    const state = this.state(event.threadId);
    if ('turnId' in event && typeof event.turnId === 'string') {
      state.activeTurnIds.delete(event.turnId);
      if (state.turnStartActive) {
        state.terminalTurnIds = [
          ...state.terminalTurnIds.filter((turnId) => turnId !== event.turnId),
          event.turnId,
        ].slice(-TERMINAL_TURN_MEMORY);
      }
    } else {
      state.activeTurnIds.clear();
    }
    this.deleteEmptyState(event.threadId, state);
  }

  hasActiveTurn(threadId: string): boolean {
    if ((this.states.get(threadId)?.activeTurnIds.size ?? 0) > 0) return true;
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

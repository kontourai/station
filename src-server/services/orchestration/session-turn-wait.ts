import type { InvocationTerminalRead } from '@kontourai/monument';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import {
  advanceOpenTurnId,
  nextTurnIdentityAnchor,
  type TurnIdentityAnchor,
} from './session-lifecycle-service.js';
import type { InputlessTurnDisposition } from './session-turn-boundary.js';

/**
 * #3160: the wait behind `wait_session`.
 *
 * A wait only OBSERVES. Its timeout, its abort and its capacity refusal never
 * touch the Session: a wait that gives up leaves the Session's turn running.
 *
 * What it reads is the same durable fold the steer path uses
 * (`ACTIVE_TURN_FOLD_METHODS` through `advanceOpenTurnId`), so "a turn is open"
 * means the same thing here as it does to `steerTurn`. The in-memory
 * coordinator's view is added for `idle` only, because it knows a turn the
 * adapter accepted before its `turn.started` reached the log.
 */

export type SessionWaitUntil = 'turn-settled' | 'idle';

/** One persisted fold event of a Session, as the wait reads it. */
export interface SessionWaitFoldEvent {
  readonly sequence: number;
  readonly event: CanonicalRuntimeEvent;
}

export interface SessionTurnWaitPorts {
  /** The Session's lifecycle fold events, oldest first. */
  foldEvents(threadId: string): readonly SessionWaitFoldEvent[];
  /** The Session's newest event sequence (0 when it has none). */
  headSequence(threadId: string): number;
  /** Whether the live coordinator holds a turn the log has not shown yet. */
  coordinatorBusy(threadId: string): boolean;
  readInputlessTurnDisposition?(threadId: string): InputlessTurnDisposition;
  readInvocationTerminal?(
    threadId: string,
    invocationId: string,
    providerTurnId?: string,
  ): InvocationTerminalRead;
  /**
   * Call `listener` whenever an event is appended to this Session's log;
   * returns the unsubscribe. The wait re-reads the log on each call, so the
   * listener needs no payload.
   */
  subscribe(threadId: string, listener: () => void): () => void;
}

export interface SessionSettledTurn {
  readonly turnId?: string;
  readonly sequence: number;
  readonly invocationId?: string;
  readonly outcome: 'completed' | 'aborted' | 'error' | 'exited';
}

export interface SessionWaitState {
  /** `running` while a turn is open or in flight, else `idle`. */
  readonly state: 'running' | 'idle';
  readonly openTurnId?: string;
  /** The newest turn that settled after the cursor, if one did. */
  readonly settledTurn?: SessionSettledTurn;
  /** Pass this back as `afterEventCursor` to wait for what comes next. */
  readonly eventCursor: number;
}

const SETTLE_OUTCOME: Record<string, SessionSettledTurn['outcome']> = {
  'turn.completed': 'completed',
  'turn.aborted': 'aborted',
  'runtime.error': 'error',
  'session.exited': 'exited',
};

/**
 * Evaluate a wait against the log: whether it is satisfied, and what the
 * Session looks like.
 *
 * - `idle`: satisfied when no turn is open or in flight.
 * - `turn-settled`: satisfied when a turn settled (the fold went from a turn
 *   open to none) after `cursor`. The caller supplies the cursor; `idle`
 *   ignores it.
 */
export function evaluateSessionWait(
  ports: Pick<
    SessionTurnWaitPorts,
    | 'foldEvents'
    | 'headSequence'
    | 'coordinatorBusy'
    | 'readInvocationTerminal'
    | 'readInputlessTurnDisposition'
  >,
  threadId: string,
  until: SessionWaitUntil,
  cursor: number,
): { readonly satisfied: boolean; readonly view: SessionWaitState } {
  const events = ports.foldEvents(threadId);
  const head = Math.max(
    ports.headSequence(threadId),
    events.at(-1)?.sequence ?? 0,
  );
  let open: string | undefined;
  let invocationId: string | undefined;
  let anchor: TurnIdentityAnchor | undefined;
  let settled: SessionSettledTurn | undefined;
  for (const { sequence, event } of events) {
    const before = open;
    const nextAnchor = nextTurnIdentityAnchor(anchor, event);
    const retainedStart =
      event.method === 'turn.started' &&
      typeof anchor === 'object' &&
      nextAnchor === anchor;
    if (!retainedStart) open = advanceOpenTurnId(open, event, invocationId);
    let settledInvocation = invocationId;
    const ordinary =
      ['turn.completed', 'turn.aborted', 'runtime.error'].includes(
        event.method,
      ) &&
      (event.turnId !== undefined || event.invocationId !== undefined);
    if (
      before !== undefined &&
      ordinary &&
      (invocationId !== undefined || event.invocationId !== undefined)
    ) {
      const proofInvocation = invocationId ?? event.invocationId;
      const read =
        proofInvocation === undefined
          ? undefined
          : ports.readInvocationTerminal?.(threadId, proofInvocation, before);
      if (
        read?.kind === 'found' &&
        read.fact.terminalEventId === event.eventId
      ) {
        open = undefined;
        settledInvocation = read.fact.invocationId;
      } else open = before;
    }
    const canAcknowledge =
      settledInvocation !== undefined ||
      !ordinary ||
      ports.readInputlessTurnDisposition?.(threadId)?.kind === 'inputless';
    if (
      before !== undefined &&
      open === undefined &&
      sequence > cursor &&
      canAcknowledge
    ) {
      settled = {
        ...(before ? { turnId: before } : {}),
        ...(settledInvocation === undefined
          ? {}
          : { invocationId: settledInvocation }),
        sequence,
        outcome: SETTLE_OUTCOME[event.method] ?? 'completed',
      };
    }
    if (event.method === 'turn.started' && !retainedStart)
      invocationId = event.invocationId;
    else if (open === undefined) invocationId = undefined;
    anchor = nextAnchor;
  }
  const busy = open !== undefined || ports.coordinatorBusy(threadId);
  const view: SessionWaitState = {
    state: busy ? 'running' : 'idle',
    ...(open !== undefined ? { openTurnId: open } : {}),
    ...(settled ? { settledTurn: settled } : {}),
    eventCursor: head,
  };
  return {
    satisfied: until === 'idle' ? !busy : settled !== undefined,
    view,
  };
}

export type SessionWaitOutcome =
  | ({
      readonly kind: 'settled';
      /** `turn-settled` was asked for and no turn was running to wait on. */
      readonly alreadyIdle?: true;
    } & SessionWaitState)
  | ({ readonly kind: 'timeout' } & SessionWaitState)
  | { readonly kind: 'aborted' }
  | { readonly kind: 'capacity'; readonly scope: 'caller' | 'station' };

/** At most this many waits per calling Session, and this many in all. */
export const SESSION_WAIT_MAX_PER_CALLER = 4;
export const SESSION_WAIT_MAX_TOTAL = 256;
/** The longest one wait runs; MCP clients time a call out around a minute. */
export const SESSION_WAIT_MAX_TIMEOUT_MS = 50_000;

export class SessionTurnWaiter {
  private readonly perCaller = new Map<string, number>();
  private total = 0;

  constructor(
    private readonly ports: SessionTurnWaitPorts,
    private readonly limits: {
      perCaller: number;
      total: number;
    } = {
      perCaller: SESSION_WAIT_MAX_PER_CALLER,
      total: SESSION_WAIT_MAX_TOTAL,
    },
  ) {}

  /** The waits holding a slot right now (for tests and diagnostics). */
  get active(): number {
    return this.total;
  }

  async wait(request: {
    readonly callerSessionId: string;
    readonly threadId: string;
    readonly until: SessionWaitUntil;
    readonly timeoutMs: number;
    readonly afterEventCursor?: number;
    readonly signal?: AbortSignal;
  }): Promise<SessionWaitOutcome> {
    const held = this.perCaller.get(request.callerSessionId) ?? 0;
    if (held >= this.limits.perCaller)
      return { kind: 'capacity', scope: 'caller' };
    if (this.total >= this.limits.total)
      return { kind: 'capacity', scope: 'station' };
    if (request.signal?.aborted) return { kind: 'aborted' };
    this.perCaller.set(request.callerSessionId, held + 1);
    this.total += 1;
    try {
      return await this.run(request);
    } finally {
      this.total -= 1;
      const left = (this.perCaller.get(request.callerSessionId) ?? 1) - 1;
      if (left <= 0) this.perCaller.delete(request.callerSessionId);
      else this.perCaller.set(request.callerSessionId, left);
    }
  }

  private run(request: {
    readonly threadId: string;
    readonly until: SessionWaitUntil;
    readonly timeoutMs: number;
    readonly afterEventCursor?: number;
    readonly signal?: AbortSignal;
  }): Promise<SessionWaitOutcome> {
    const { threadId, until } = request;
    let cursor = request.afterEventCursor ?? 0;
    if (until === 'turn-settled' && request.afterEventCursor === undefined) {
      // No cursor: wait for the turn that is open NOW. Nothing open means
      // nothing to wait for, which is already settled.
      const now = evaluateSessionWait(this.ports, threadId, 'idle', 0);
      if (now.satisfied)
        return Promise.resolve({
          kind: 'settled',
          alreadyIdle: true,
          ...now.view,
        });
      cursor = now.view.eventCursor;
    }
    return new Promise<SessionWaitOutcome>((resolve) => {
      let finished = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let unsubscribe: (() => void) | undefined;
      const finish = (outcome: SessionWaitOutcome) => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        unsubscribe?.();
        request.signal?.removeEventListener('abort', onAbort);
        resolve(outcome);
      };
      const onAbort = () => finish({ kind: 'aborted' });
      const check = () => {
        if (finished) return;
        const { satisfied, view } = evaluateSessionWait(
          this.ports,
          threadId,
          until,
          cursor,
        );
        if (satisfied) finish({ kind: 'settled', ...view });
      };
      request.signal?.addEventListener('abort', onAbort, { once: true });
      // Subscribe BEFORE the first read, so an event landing between the two
      // is seen by one of them.
      unsubscribe = this.ports.subscribe(threadId, check);
      timer = setTimeout(() => {
        const { view } = evaluateSessionWait(
          this.ports,
          threadId,
          until,
          cursor,
        );
        finish({ kind: 'timeout', ...view });
      }, request.timeoutMs);
      check();
    });
  }
}

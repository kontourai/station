import {
  PROVIDER_FAILURE_RETRYABLE,
  type ProviderFailure,
  SESSION_START_INDETERMINATE_CODE,
} from '@kontourai/station-contracts/provider-failure';

export { SESSION_START_INDETERMINATE_CODE } from '@kontourai/station-contracts/provider-failure';

import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type {
  InvocationTerminalFact,
  InvocationTerminalRead,
  InvocationTerminalRetirement,
  OwnerIdentity,
  PreparedTurnIntent,
  PreparedTurnSettlement,
  TurnBoundaryRecord,
  TurnDedupRecord,
} from '@kontourai/monument';
import {
  decidePreparedTurnSettlement,
  decideTurnBoundaryAcceptInvocation,
  decideTurnBoundaryBeginInvocation,
  decideTurnBoundaryObserveTerminal,
  decideTurnBoundaryPrepare,
  decideTurnBoundaryRecordAccepted,
  decideTurnBoundaryRemove,
  decideTurnBoundaryTransition,
} from '@kontourai/monument';
import { findInvocationTerminal } from '@kontourai/monument/adapter';
import {
  type CanonicalRuntimeEvent,
  isDeferredRetriableTurnError,
} from '@kontourai/station-contracts/runtime-events';
import { SessionStartRefusedError } from '../../providers/adapter-shape.js';
import type { CapturedTurnIntent } from './prepared-turn-intent.js';
import type {
  RecoveryLedgerProcessIdentity,
  RecoveryOwner,
} from './recovery-ledger.js';
import type { TurnClaim } from './turn-deduplicator.js';

type BoundaryState =
  | 'lifecycle'
  | 'reserved'
  | 'prepared'
  | 'invoking'
  | 'accepted'
  | 'indeterminate'
  | 'settled';

export interface SessionTurnBoundaryRecord {
  purpose?: 'task-dispatch';
  createdSequence?: number | null;
  boundaryId: string;
  threadId: string;
  state: BoundaryState;
  providerTurnId?: string;
  ownerId: string;
  ownerPid: number;
  ownerBirth?: string;
  ownerIdentityKind: string;
  createdAt: string;
  updatedAt: string;
  intent?: PreparedTurnIntent;
  settlement?: PreparedTurnSettlement;
}

/** Unresolved provider acceptances are protected facts and are never pruned. */
export const SESSION_TURN_ACCEPTED_CAPACITY = 64;

/**
 * `session.exited.reason` for the sessions Station closes as it shuts down.
 * That exit does not end a turn still in flight: its boundary row stays for
 * the next boot, whose interrupted-turn recovery settles the turn exactly as
 * after a crash. Retiring it here left the turn with no terminal at all.
 * Only turn rows are kept ({@link SHUTDOWN_RETAINED_BOUNDARY_PREFIXES}): that
 * recovery settles nothing else, so a session start left unresolved still
 * retires on the exit, or it would hold the thread busy forever.
 */
export const ORCHESTRATION_SHUTDOWN_EXIT_REASON = 'orchestration_shutdown';

/**
 * #2324: the boundary id prefix of a turn the ENGINE opened on its own
 * (`isProviderTriggeredTurn`). Such a turn has no send, so no claim ever
 * prepares or invokes it; its row is recorded straight into `accepted` when
 * its `turn.started` is persisted, so a crash mid-turn leaves the same
 * durable fact a crashed user turn does. Identified by the id Station minted
 * (like `session-start-boundary:`), never by caller metadata.
 */
const PROVIDER_TURN_BOUNDARY_PREFIX = 'provider-turn-boundary:';

/** The id kind `preparedRecord` mints for a sent turn's row. */
const TURN_BOUNDARY_KIND = 'turn-boundary';
const TURN_BOUNDARY_PREFIX = `${TURN_BOUNDARY_KIND}:`;

/**
 * The turn rows a shutdown exit keeps for the next boot's interrupted-turn
 * recovery: a sent turn and one the engine opened itself. The same list is
 * the SQL clause of `SESSION_TURN_TERMINAL_RETIREMENT_PREDICATE`.
 */
export const SHUTDOWN_RETAINED_BOUNDARY_PREFIXES = [
  TURN_BOUNDARY_PREFIX,
  PROVIDER_TURN_BOUNDARY_PREFIX,
] as const;

export function isProviderTurnBoundary(record: {
  boundaryId: string;
}): boolean {
  return record.boundaryId.startsWith(PROVIDER_TURN_BOUNDARY_PREFIX);
}

export interface InvocationAcceptanceSnapshot {
  expected: TurnBoundaryRecord;
  expectedDedup?: TurnDedupRecord;
}

export type SessionTurnBoundaryTransition =
  | { kind: 'applied' }
  | { kind: 'busy' }
  | { kind: 'ambiguous' }
  | { kind: 'stale' }
  | { kind: 'unavailable' };

export type InputlessTurnDisposition =
  | { kind: 'inputless' }
  | { kind: 'unknown' };

export interface SessionTurnBoundaryCoordinator {
  readInputlessTurnDisposition?(threadId: string): InputlessTurnDisposition;
  resumePrepared?(input: {
    capture: CapturedTurnIntent;
    owner: OwnerIdentity;
    now: string;
    current: () => boolean;
  }):
    | {
        kind: 'applied';
        record: SessionTurnBoundaryRecord;
        turnClaim?: TurnClaim;
      }
    | { kind: 'stale' | 'unavailable' };
  create(
    record: SessionTurnBoundaryRecord & {
      state: 'lifecycle' | 'reserved' | 'prepared';
    },
  ): SessionTurnBoundaryTransition;
  prepareIntent?(input: {
    boundaryId: string;
    ownerId: string;
    capture: CapturedTurnIntent;
    claim?: TurnClaim;
    now: string;
  }): SessionTurnBoundaryTransition;
  acceptInvocation?(
    input: InvocationAcceptanceSnapshot & {
      providerTurnId: string;
      now: string;
    },
  ): SessionTurnBoundaryTransition;
  beginPrepared?(input: {
    boundaryId: string;
    ownerId: string;
    capture: CapturedTurnIntent;
    claim?: TurnClaim;
    now: string;
    current?: () => boolean;
  }): SessionTurnBoundaryTransition & { begun?: InvocationAcceptanceSnapshot };
  recordDefinitiveRefusal?(input: {
    boundaryId: string;
    boundary: { owner: OwnerIdentity; createdAt: string; updatedAt: string };
    preparedAt: string;
    capture: CapturedTurnIntent;
    claim?: TurnClaim;
    settlementId: string;
    now: string;
  }): SessionTurnBoundaryTransition;
  transition(input: {
    boundaryId: string;
    ownerId: string;
    from: BoundaryState[];
    to: 'invoking' | 'accepted' | 'indeterminate';
    now: string;
    providerTurnId?: string;
  }): SessionTurnBoundaryTransition;
  remove(input: {
    boundaryId: string;
    ownerId: string;
    from: BoundaryState[];
  }): SessionTurnBoundaryTransition;
  removeTerminal(input: {
    threadId: string;
    providerTurnId?: string;
    sessionTerminal: boolean;
    invocationId?: string;
    retire?: boolean;
    terminalCreatedAt: string;
    /** Session terminals use their persisted sequence; turn terminals retain timestamp ordering. */
    terminalEventId?: string;
    /** Rows whose id starts with one of these are kept; the rest retire. */
    retainBoundaryIdPrefixes?: readonly string[];
  }): SessionTurnBoundaryTransition;
  readInvocationTerminal?(
    threadId: string,
    invocationId: string,
    providerTurnId?: string,
  ): InvocationTerminalRead;
  hasPossibleEffect(threadId: string): boolean;
  active(): SessionTurnBoundaryRecord[];
  /**
   * #2324: records an `accepted` row with no preceding claim, for a turn the
   * engine opened itself. Never blocked by another invocation on the thread
   * (the engine did not ask), only by {@link SESSION_TURN_ACCEPTED_CAPACITY}.
   */
  recordAccepted(
    record: SessionTurnBoundaryRecord & {
      state: 'accepted';
      providerTurnId: string;
    },
  ): SessionTurnBoundaryTransition;
}

const activeOwners = new Set<string>();
const releasedOwners = new Set<string>();

export function releaseSessionTurnBoundaryOwner(ownerId: string): void {
  activeOwners.delete(ownerId);
  releasedOwners.add(ownerId);
}

function ownerIsLive(
  record: SessionTurnBoundaryRecord,
  processIdentity: RecoveryLedgerProcessIdentity,
): boolean {
  if (releasedOwners.has(record.ownerId)) return false;
  if (record.ownerPid === process.pid && activeOwners.has(record.ownerId)) {
    return true;
  }
  const observed = processIdentity.probe(record.ownerPid);
  if (observed.state === 'dead') return false;
  if (observed.state === 'unavailable') return true;
  return (
    record.ownerIdentityKind !== 'exact' ||
    !record.ownerBirth ||
    observed.identity.start === record.ownerBirth
  );
}

export interface SessionTurnBoundaryClaim {
  prepareIntent?(
    capture: CapturedTurnIntent,
    claim: TurnClaim | undefined,
    now: string,
  ): SessionTurnBoundaryTransition;
  beginInvocation(now: string): SessionTurnBoundaryTransition;
  recordDefinitiveRefusal?(now: string): SessionTurnBoundaryTransition;
  accepted(turnId: string, now: string): SessionTurnBoundaryTransition;
  terminalObserved(turnId: string): SessionTurnBoundaryTransition;
  notInvoked(): SessionTurnBoundaryTransition;
  indeterminate(now: string): SessionTurnBoundaryTransition;
}

/** Session creation has no provider turn ID. Its possible effect is still durable. */
export interface SessionStartBoundaryClaim {
  readonly threadId: string;
  beginInvocation(now: string): SessionTurnBoundaryTransition;
  started(): SessionTurnBoundaryTransition;
  notInvoked(): SessionTurnBoundaryTransition;
  indeterminate(now: string): SessionTurnBoundaryTransition;
  /**
   * The provider was invoked and DEFINITIVELY refused (a
   * `SessionStartRefusedError`): release the boundary instead of leaving it
   * `indeterminate`. Optional so a claim that cannot tell the difference stays
   * conservative: anything but `applied` is recorded as an indeterminate start.
   */
  refused?(): SessionTurnBoundaryTransition;
}

/** Terminate an engine message so the explanation that follows reads as its own sentence. */
function sentence(message: string): string {
  const trimmed = message.trim();
  if (!trimmed) return '';
  return /[.!?]$/.test(trimmed) ? `${trimmed} ` : `${trimmed}. `;
}

export class SessionStartIndeterminateError
  extends Error
  implements ProviderFailure
{
  readonly kind = 'indeterminate';
  readonly failurePhase = 'indeterminate';
  get retryable(): boolean {
    return PROVIDER_FAILURE_RETRYABLE[this.kind];
  }
  readonly code = SESSION_START_INDETERMINATE_CODE;
  constructor(cause?: unknown, reportedMessage?: string) {
    super(
      reportedMessage ??
        `${cause instanceof Error ? sentence(cause.message) : ''}Provider session creation may have completed. Inspect the session before retrying.`,
      { cause },
    );
    this.name = 'SessionStartIndeterminateError';
  }
}

/** Invoke only after policy/resource admission; retain uncertainty across restart. */
export async function runSessionStartWithBoundary<T>(
  authority: SessionTurnBoundaryAuthority,
  threadId: string,
  invoke: () => Promise<T>,
  admission?: SessionStartBoundaryClaim,
): Promise<T> {
  if (admission && admission.threadId !== threadId)
    throw new Error(
      'Session start admission does not match the requested session.',
    );
  const owned = admission
    ? { kind: 'owner' as const, claim: admission }
    : authority.claimSessionStart(threadId, new Date().toISOString());
  if (owned.kind !== 'owner')
    throw new Error(
      'Session start admission is unavailable; no provider call was made.',
    );
  if (
    owned.claim.beginInvocation(new Date().toISOString()).kind !== 'applied'
  ) {
    owned.claim.indeterminate(new Date().toISOString());
    throw new Error(
      'Session start admission is unavailable; no provider call was made.',
    );
  }
  let result: T;
  try {
    result = await invoke();
  } catch (error) {
    // A definitive refusal settles the start: the thread is not fenced behind
    // an inspection that has nothing to find. Anything the claim cannot confirm
    // releasing stays the conservative indeterminate start.
    if (
      error instanceof SessionStartRefusedError &&
      owned.claim.refused?.().kind === 'applied'
    )
      throw error;
    owned.claim.indeterminate(new Date().toISOString());
    throw new SessionStartIndeterminateError(error);
  }
  if (owned.claim.started().kind !== 'applied')
    throw new SessionStartIndeterminateError();
  return result;
}

export interface TaskDispatchBoundaryClaim {
  beginEffects(now: string): SessionTurnBoundaryTransition;
  settled(): SessionTurnBoundaryTransition;
  notInvoked(): SessionTurnBoundaryTransition;
  indeterminate(now: string): SessionTurnBoundaryTransition;
  readonly sessionStart: SessionStartBoundaryClaim;
}

export interface SessionTurnBoundaryAuthority {
  resumePrepared?(
    capture: CapturedTurnIntent,
    now: string,
    current: () => boolean,
  ):
    | { kind: 'owner'; claim: SessionTurnBoundaryClaim; turnClaim?: TurnClaim }
    | { kind: 'stale' | 'unavailable' };
  /** Boot composition supplies proof from graph, provider and publication owners. */
  recoverCompletedDispatch(
    threadId: string,
    verify: () => Promise<boolean>,
  ): Promise<SessionTurnBoundaryTransition>;

  claimTaskDispatch(
    threadId: string,
    now: string,
  ):
    | { kind: 'owner'; claim: TaskDispatchBoundaryClaim }
    | { kind: 'busy' | 'unavailable' };

  claimSessionStart(
    threadId: string,
    now: string,
  ):
    | { kind: 'owner'; claim: SessionStartBoundaryClaim }
    | { kind: 'busy' | 'unavailable' };
  claim(
    threadId: string,
    now: string,
  ):
    | { kind: 'owner'; claim: SessionTurnBoundaryClaim }
    | { kind: 'busy' }
    | { kind: 'unavailable' };
  /** Production sends reserve exclusivity until their final input is captured. */
  reserve?(
    threadId: string,
    now: string,
  ): ReturnType<SessionTurnBoundaryAuthority['claim']>;
  claimLifecycle(
    threadId: string,
    now: string,
  ):
    | { kind: 'owner'; release(): SessionTurnBoundaryTransition }
    | { kind: 'active-turn' }
    | { kind: 'busy' }
    | { kind: 'unavailable' };
  hasPossibleEffect(
    threadId: string,
  ): { kind: 'available'; active: boolean } | { kind: 'unavailable' };
  readInputlessTurnDisposition(threadId: string): InputlessTurnDisposition;
  retryPendingTransitions(): void;
  readInvocationTerminal(
    threadId: string,
    invocationId: string,
    providerTurnId?: string,
  ): InvocationTerminalRead;
  observe(event: CanonicalRuntimeEvent): SessionTurnBoundaryTransition;
  /**
   * #2324: the durable row for a turn the engine opened on its own. Retired
   * by that turn's terminal like any accepted turn; left behind by a crash,
   * it is closed at the next boot with the interrupted-turn banner a user
   * turn gets.
   *
   * #3561: two steps, so the caller writes the row inside the append of the
   * turn's `turn.started` and it commits or rolls back with that event.
   * Preparing retries pending transitions, which open transactions of their
   * own, so it runs BEFORE that append; `record` writes only the row and
   * joins the caller's open transaction. `record` reports a row it could not
   * write as `unavailable`, and throws only when the caller's transaction
   * itself was rolled back.
   */
  prepareProviderTurn(
    threadId: string,
    providerTurnId: string,
    now: string,
  ): { record(): SessionTurnBoundaryTransition };
  /**
   * archive#4080: `reconcile`'s existing dead-owner sweep already
   * flips a dead `invoking` owner to `indeterminate` — this surfaces THAT
   * same sweep's full dead-owner findings, additionally across `accepted`
   * (a deliberately protected fact this sweep never mutates on its own) and
   * any `indeterminate` row a prior pass already left unresolved. Every
   * record in `interrupted` is exactly "a turn was in flight when its
   * owning process died" — the label a caller may honestly banner from.
   * Read-only: the caller is the one that decides when a record is
   * consumed (closing it via the boundary's own removal transition).
   */
  reconcile(
    now: string,
  ):
    | { kind: 'available'; interrupted: SessionTurnBoundaryRecord[] }
    | { kind: 'unavailable' };
}

/**
 * Durable provider-invocation boundary for one session turn. The opaque claim
 * makes the pre-effect/invoking/accepted transitions one-way; lifecycle code
 * receives only a read capability and can never manufacture settlement.
 */
export function createSessionTurnBoundaryAuthority(options: {
  coordinator: SessionTurnBoundaryCoordinator;
  owner: RecoveryOwner;
  processIdentity: RecoveryLedgerProcessIdentity;
}): SessionTurnBoundaryAuthority {
  activeOwners.add(options.owner.id);

  const pendingTransitions = new Map<
    string,
    () => SessionTurnBoundaryTransition
  >();
  const retainUntilApplied = (
    boundaryId: string,
    operation: () => SessionTurnBoundaryTransition,
  ) => {
    const result = operation();
    if (result.kind === 'unavailable') {
      pendingTransitions.set(boundaryId, operation);
    } else {
      pendingTransitions.delete(boundaryId);
    }
    return result;
  };
  const retryPendingTransitions = () => {
    for (const [boundaryId, operation] of pendingTransitions) {
      const result = operation();
      if (result.kind !== 'unavailable') pendingTransitions.delete(boundaryId);
    }
  };
  const prepareProviderTurn = (
    threadId: string,
    providerTurnId: string,
    now: string,
  ): { record(): SessionTurnBoundaryTransition } => {
    retryPendingTransitions();
    return {
      // Not caught (#3561 review F1): inside a caller's append, a throw here
      // means the caller's transaction is gone, and the caller must fail. A
      // lost row alone is reported as `unavailable` by the coordinator.
      record: () =>
        options.coordinator.recordAccepted({
          boundaryId: `${PROVIDER_TURN_BOUNDARY_PREFIX}${randomUUID()}`,
          threadId,
          state: 'accepted',
          providerTurnId,
          ownerId: options.owner.id,
          ownerPid: options.owner.pid,
          ...(options.owner.identityKind === 'exact'
            ? { ownerBirth: options.owner.birth }
            : {}),
          ownerIdentityKind: options.owner.identityKind,
          createdAt: now,
          updatedAt: now,
        }),
    };
  };
  const reconcileDeadOwners = (
    now: string,
  ): { ok: boolean; interrupted: SessionTurnBoundaryRecord[] } => {
    const interrupted: SessionTurnBoundaryRecord[] = [];
    try {
      for (const record of options.coordinator.active()) {
        if (
          record.state === 'settled' ||
          ownerIsLive(record, options.processIdentity)
        )
          continue;
        if (record.state === 'prepared' && record.intent) continue;
        if (
          record.state === 'reserved' ||
          record.state === 'prepared' ||
          record.state === 'lifecycle'
        ) {
          const removed = options.coordinator.remove({
            boundaryId: record.boundaryId,
            ownerId: record.ownerId,
            from: [record.state],
          });
          if (removed.kind === 'unavailable') return { ok: false, interrupted };
        } else if (record.state === 'invoking') {
          const transitioned = options.coordinator.transition({
            boundaryId: record.boundaryId,
            ownerId: record.ownerId,
            from: ['invoking'],
            to: 'indeterminate',
            now,
          });
          if (transitioned.kind === 'unavailable') {
            return { ok: false, interrupted };
          }
          if (transitioned.kind === 'applied') {
            interrupted.push({
              ...record,
              state: 'indeterminate',
              updatedAt: now,
            });
          }
        } else if (
          record.state === 'accepted' ||
          record.state === 'indeterminate'
        ) {
          // `accepted` is a protected fact (never auto-pruned) and a prior
          // pass's `indeterminate` is never auto-revisited by anything else
          // — both are dead-owner findings this sweep only ever REPORTS,
          // never mutates. The caller closes them explicitly once consumed.
          interrupted.push({ ...record });
        }
      }
      return { ok: true, interrupted };
    } catch {
      return { ok: false, interrupted };
    }
  };

  const createWithRecovery = (
    record: SessionTurnBoundaryRecord & {
      state: 'lifecycle' | 'reserved' | 'prepared';
    },
  ) => {
    retryPendingTransitions();
    let created = options.coordinator.create(record);
    if (created.kind === 'busy' && reconcileDeadOwners(record.updatedAt).ok) {
      created = options.coordinator.create(record);
    }
    return created;
  };

  const preparedRecord = (threadId: string, now: string, prefix: string) => {
    const boundaryId = `${prefix}:${randomUUID()}`;
    return {
      boundaryId,
      threadId,
      state: 'prepared',
      ownerId: options.owner.id,
      ownerPid: options.owner.pid,
      ...(options.owner.identityKind === 'exact'
        ? { ownerBirth: options.owner.birth }
        : {}),
      ownerIdentityKind: options.owner.identityKind,
      createdAt: now,
      updatedAt: now,
    } as const;
  };

  const claimStart = (
    threadId: string,
    now: string,
    purpose?: 'task-dispatch',
  ): ReturnType<SessionTurnBoundaryAuthority['claimSessionStart']> => {
    const record = {
      ...preparedRecord(threadId, now, purpose ?? 'session-start-boundary'),
      ...(purpose ? { purpose } : {}),
    };
    const created = createWithRecovery(record);
    if (created.kind !== 'applied')
      return { kind: created.kind === 'busy' ? 'busy' : 'unavailable' };
    const boundaryId = record.boundaryId;
    let attempted = false;
    let invoked = false;
    let terminal:
      | 'started'
      | 'not-invoked'
      | 'indeterminate'
      | 'refused'
      | undefined;
    const remove = (from: BoundaryState[]) =>
      retainUntilApplied(boundaryId, () =>
        options.coordinator.remove({
          boundaryId,
          ownerId: options.owner.id,
          from,
        }),
      );
    return {
      kind: 'owner',
      claim: Object.freeze({
        threadId,
        beginInvocation(at: string) {
          if (terminal) return { kind: 'stale' } as const;
          if (invoked) return { kind: 'applied' } as const;
          attempted = true;
          return retainUntilApplied(boundaryId, () => {
            const result = options.coordinator.transition({
              boundaryId,
              ownerId: options.owner.id,
              from: ['prepared'],
              to: 'invoking',
              now: at,
            });
            if (result.kind === 'applied') invoked = true;
            return result;
          });
        },
        started() {
          if (!invoked || (terminal && terminal !== 'started'))
            return { kind: 'stale' } as const;
          terminal = 'started';
          return remove(['invoking']);
        },
        notInvoked() {
          if (attempted || (terminal && terminal !== 'not-invoked'))
            return { kind: 'stale' } as const;
          terminal = 'not-invoked';
          return remove(['prepared']);
        },
        refused() {
          if (!invoked || terminal) return { kind: 'stale' } as const;
          // Terminal only once released: an unconfirmed release must still be
          // free to become the indeterminate start the caller falls back to.
          const released = remove(['invoking']);
          if (released.kind === 'applied') terminal = 'refused';
          return released;
        },
        indeterminate(at: string) {
          if (terminal && terminal !== 'indeterminate')
            return { kind: 'stale' } as const;
          terminal = 'indeterminate';
          return retainUntilApplied(boundaryId, () =>
            options.coordinator.transition({
              boundaryId,
              ownerId: options.owner.id,
              from: ['prepared', 'invoking', 'indeterminate'],
              to: 'indeterminate',
              now: at,
            }),
          );
        },
      }),
    };
  };

  const claimTurn = (
    threadId: string,
    now: string,
    reserve = false,
    adopted?: {
      record: SessionTurnBoundaryRecord;
      capture: CapturedTurnIntent;
      turnClaim?: TurnClaim;
      current?: () => boolean;
    },
  ): ReturnType<SessionTurnBoundaryAuthority['claim']> => {
    const freshRecord = {
      ...preparedRecord(threadId, now, TURN_BOUNDARY_KIND),
      state:
        reserve && options.coordinator.prepareIntent
          ? ('reserved' as const)
          : ('prepared' as const),
    };
    const record = adopted?.record ?? freshRecord;
    const boundaryId = record.boundaryId;
    const created = adopted
      ? { kind: 'applied' as const }
      : createWithRecovery(freshRecord);
    if (created.kind !== 'applied') {
      return {
        kind: created.kind === 'busy' ? 'busy' : 'unavailable',
      };
    }

    let begunSnapshot: InvocationAcceptanceSnapshot | undefined;
    let beginAt: string | undefined;
    let invocationStarted = false;
    let invocationStartedAt: string | undefined;
    let invocationAttempted = false;
    let prepared:
      | {
          capture: CapturedTurnIntent;
          claim?: TurnClaim;
          preparedAt: string;
          current?: () => boolean;
        }
      | undefined = adopted
      ? {
          capture: adopted.capture,
          claim: adopted.turnClaim,
          preparedAt: adopted.record.updatedAt,
          current: adopted.current,
        }
      : undefined;
    let terminalIntent:
      | { kind: 'accepted'; turnId: string; now: string }
      | { kind: 'terminal-observed'; turnId: string }
      | { kind: 'not-invoked' }
      | { kind: 'indeterminate'; now: string }
      | { kind: 'definitively-refused'; now: string; settlementId: string }
      | undefined;
    let terminalApplied = false;
    const transition = (
      from: BoundaryState[],
      to: 'invoking' | 'accepted' | 'indeterminate',
      transitionNow: string,
      providerTurnId?: string,
    ) =>
      options.coordinator.transition({
        boundaryId,
        ownerId: options.owner.id,
        from,
        to,
        now: transitionNow,
        ...(providerTurnId ? { providerTurnId } : {}),
      });

    return {
      kind: 'owner',
      claim: Object.freeze({
        ...(reserve && options.coordinator.prepareIntent
          ? {
              prepareIntent(
                capture: CapturedTurnIntent,
                claim: TurnClaim | undefined,
                at: string,
              ) {
                if (invocationAttempted || prepared)
                  return { kind: 'stale' } as const;
                const result = options.coordinator.prepareIntent!({
                  boundaryId,
                  ownerId: options.owner.id,
                  capture,
                  claim,
                  now: at,
                });
                // Retain even an uncertain preparation. A lost acknowledgement must
                // never let finally remove the fence or recompose different input.
                if (result.kind !== 'stale')
                  prepared = { capture, claim, preparedAt: at };
                return result;
              },
            }
          : {}),
        beginInvocation(beginNow: string) {
          if (invocationStarted) return { kind: 'applied' } as const;
          invocationAttempted = true;
          beginAt ??= beginNow;
          const result = retainUntilApplied(boundaryId, () => {
            const transitioned: SessionTurnBoundaryTransition & {
              begun?: InvocationAcceptanceSnapshot;
            } =
              prepared && options.coordinator.beginPrepared
                ? options.coordinator.beginPrepared({
                    boundaryId,
                    ownerId: options.owner.id,
                    ...prepared,
                    now: beginAt!,
                  })
                : transition(['prepared'], 'invoking', beginAt!);
            if ('begun' in transitioned && transitioned.begun)
              begunSnapshot ??= transitioned.begun;
            if (transitioned.kind === 'applied') {
              invocationStarted = true;
              invocationStartedAt = beginAt;
            }
            return { kind: transitioned.kind };
          });
          if (result.kind === 'applied') invocationStarted = true;
          return result;
        },
        ...(options.coordinator.recordDefinitiveRefusal
          ? {
              recordDefinitiveRefusal(at: string) {
                if (
                  !prepared ||
                  !invocationStartedAt ||
                  (terminalIntent &&
                    terminalIntent.kind !== 'definitively-refused')
                )
                  return { kind: 'stale' } as const;
                if (terminalApplied) return { kind: 'applied' } as const;
                terminalIntent ??= {
                  kind: 'definitively-refused',
                  now: at,
                  settlementId: randomUUID(),
                };
                const attempt = terminalIntent;
                const result = options.coordinator.recordDefinitiveRefusal!({
                  boundaryId,
                  boundary: {
                    owner: options.owner,
                    createdAt: record.createdAt,
                    updatedAt: invocationStartedAt,
                  },
                  ...prepared,
                  now: attempt.now,
                  settlementId: attempt.settlementId,
                });
                if (result.kind === 'applied') terminalApplied = true;
                return result;
              },
            }
          : {}),
        accepted(turnId: string, acceptedNow: string) {
          if (
            terminalIntent &&
            (terminalIntent.kind !== 'accepted' ||
              terminalIntent.turnId !== turnId)
          ) {
            return { kind: 'stale' } as const;
          }
          if (terminalApplied && !prepared) return { kind: 'applied' } as const;
          terminalIntent ??= {
            kind: 'accepted',
            turnId,
            now: acceptedNow,
          };
          const intent = terminalIntent as Extract<
            NonNullable<typeof terminalIntent>,
            { kind: 'accepted' }
          >;
          const operation = (): SessionTurnBoundaryTransition => {
            if (prepared) {
              if (!begunSnapshot || !options.coordinator.acceptInvocation)
                return { kind: 'unavailable' };
              return options.coordinator.acceptInvocation({
                ...begunSnapshot,
                providerTurnId: intent.turnId,
                now: intent.now,
              });
            }
            return transition(
              ['invoking'],
              'accepted',
              intent.now,
              intent.turnId,
            );
          };
          const result = operation();
          if (prepared && result.kind !== 'applied')
            pendingTransitions.set(boundaryId, () => {
              const retried = operation();
              return retried.kind === 'applied'
                ? retried
                : { kind: 'unavailable' };
            });
          else if (result.kind === 'applied')
            pendingTransitions.delete(boundaryId);
          if (result.kind === 'applied') terminalApplied = true;
          return result;
        },
        terminalObserved(turnId: string) {
          if (prepared) return { kind: 'stale' } as const;
          if (
            terminalIntent &&
            (terminalIntent.kind !== 'terminal-observed' ||
              terminalIntent.turnId !== turnId)
          ) {
            return { kind: 'stale' } as const;
          }
          if (terminalApplied) return { kind: 'applied' } as const;
          terminalIntent ??= { kind: 'terminal-observed', turnId };
          const result = retainUntilApplied(boundaryId, () =>
            options.coordinator.remove({
              boundaryId,
              ownerId: options.owner.id,
              from: ['invoking', 'accepted'],
            }),
          );
          if (result.kind === 'applied') terminalApplied = true;
          return result;
        },
        notInvoked() {
          if (invocationAttempted || prepared)
            return { kind: 'stale' } as const;
          if (terminalIntent && terminalIntent.kind !== 'not-invoked') {
            return { kind: 'stale' } as const;
          }
          if (terminalApplied) return { kind: 'applied' } as const;
          terminalIntent ??= { kind: 'not-invoked' };
          const result = retainUntilApplied(boundaryId, () =>
            options.coordinator.remove({
              boundaryId,
              ownerId: options.owner.id,
              from: [record.state],
            }),
          );
          if (result.kind === 'applied') terminalApplied = true;
          return result;
        },
        indeterminate(indeterminateNow: string) {
          if (terminalIntent && terminalIntent.kind !== 'indeterminate') {
            return { kind: 'stale' } as const;
          }
          if (terminalApplied) return { kind: 'applied' } as const;
          terminalIntent ??= {
            kind: 'indeterminate',
            now: indeterminateNow,
          };
          const intent = terminalIntent as Extract<
            NonNullable<typeof terminalIntent>,
            { kind: 'indeterminate' }
          >;
          const result = retainUntilApplied(boundaryId, () => {
            if (!invocationStarted) {
              const begun = transition(['prepared'], 'invoking', intent.now);
              if (begun.kind !== 'applied') return begun;
              invocationStarted = true;
            }
            return transition(['invoking'], 'indeterminate', intent.now);
          });
          if (result.kind === 'applied') terminalApplied = true;
          return result;
        },
      }),
    };
  };

  return {
    ...(options.coordinator.resumePrepared
      ? {
          resumePrepared(
            capture: CapturedTurnIntent,
            now: string,
            current: () => boolean,
          ) {
            const owner: OwnerIdentity =
              options.owner.identityKind === 'exact'
                ? {
                    id: options.owner.id,
                    pid: options.owner.pid,
                    identityKind: 'exact',
                    birth: options.owner.birth,
                  }
                : {
                    id: options.owner.id,
                    pid: options.owner.pid,
                    identityKind: 'unverified',
                  };
            const resumed = options.coordinator.resumePrepared!({
              capture,
              owner,
              now,
              current,
            });
            if (resumed.kind !== 'applied') return resumed;
            const claimed = claimTurn(capture.threadId, now, true, {
              ...resumed,
              capture,
              current,
            });
            return claimed.kind === 'owner'
              ? { ...claimed, turnClaim: resumed.turnClaim }
              : { kind: 'unavailable' as const };
          },
        }
      : {}),
    async recoverCompletedDispatch(threadId, verify) {
      try {
        const candidates = options.coordinator
          .active()
          .filter(
            (record) =>
              record.threadId === threadId &&
              record.purpose === 'task-dispatch',
          );
        if (candidates.length !== 1) return { kind: 'stale' };
        const candidate = candidates[0];
        if (ownerIsLive(candidate, options.processIdentity))
          return { kind: 'busy' };
        if (!['invoking', 'indeterminate'].includes(candidate.state))
          return { kind: 'stale' };
        if (!(await verify())) return { kind: 'unavailable' };
        const current = options.coordinator
          .active()
          .find((record) => record.boundaryId === candidate.boundaryId);
        if (
          !current ||
          current.ownerId !== candidate.ownerId ||
          current.threadId !== threadId ||
          current.purpose !== 'task-dispatch' ||
          current.state !== candidate.state ||
          current.updatedAt !== candidate.updatedAt
        )
          return { kind: 'stale' };
        if (ownerIsLive(current, options.processIdentity))
          return { kind: 'busy' };
        return options.coordinator.remove({
          boundaryId: current.boundaryId,
          ownerId: current.ownerId,
          from: [current.state],
        });
      } catch {
        return { kind: 'unavailable' };
      }
    },
    claimSessionStart: (threadId, now) => claimStart(threadId, now),
    claimTaskDispatch(threadId, now) {
      const owned = claimStart(threadId, now, 'task-dispatch');
      if (owned.kind !== 'owner') return owned;
      const parent = owned.claim;
      let childInvoked = false;
      let childSettled = false;
      let dispatchTerminal = false;
      const sessionStart: SessionStartBoundaryClaim = Object.freeze({
        threadId,
        beginInvocation(at: string) {
          if (dispatchTerminal || childSettled)
            return { kind: 'stale' } as const;
          const result = parent.beginInvocation(at);
          if (result.kind === 'applied') childInvoked = true;
          return result;
        },
        started() {
          if (dispatchTerminal || !childInvoked)
            return { kind: 'stale' } as const;
          childSettled = true;
          return { kind: 'applied' } as const;
        },
        notInvoked() {
          if (dispatchTerminal || childInvoked)
            return { kind: 'stale' } as const;
          childSettled = true;
          return { kind: 'applied' } as const;
        },
        indeterminate(at: string) {
          if (childSettled) return { kind: 'stale' } as const;
          childSettled = true;
          return parent.indeterminate(at);
        },
      });
      return {
        kind: 'owner',
        claim: Object.freeze({
          beginEffects: parent.beginInvocation,
          settled() {
            dispatchTerminal = true;
            return parent.started();
          },
          notInvoked() {
            const result = parent.notInvoked();
            if (result.kind !== 'stale') dispatchTerminal = true;
            return result;
          },
          indeterminate(at: string) {
            dispatchTerminal = true;
            return parent.indeterminate(at);
          },
          sessionStart,
        }),
      };
    },
    claim: (threadId, now) => claimTurn(threadId, now),
    reserve: (threadId, now) => claimTurn(threadId, now, true),
    claimLifecycle(threadId, now) {
      const boundaryId = `lifecycle-boundary:${randomUUID()}`;
      const record = {
        boundaryId,
        threadId,
        state: 'lifecycle',
        ownerId: options.owner.id,
        ownerPid: options.owner.pid,
        ...(options.owner.identityKind === 'exact'
          ? { ownerBirth: options.owner.birth }
          : {}),
        ownerIdentityKind: options.owner.identityKind,
        createdAt: now,
        updatedAt: now,
      } as const;
      const created = createWithRecovery(record);
      if (created.kind === 'busy') {
        try {
          const possible = options.coordinator.hasPossibleEffect(threadId);
          return possible ? { kind: 'active-turn' } : { kind: 'busy' };
        } catch {
          return { kind: 'unavailable' };
        }
      }
      if (created.kind !== 'applied') return { kind: 'unavailable' };
      let released = false;
      return {
        kind: 'owner',
        release() {
          if (released) return { kind: 'applied' };
          const result = options.coordinator.remove({
            boundaryId,
            ownerId: options.owner.id,
            from: ['lifecycle'],
          });
          if (result.kind === 'applied') released = true;
          return result;
        },
      };
    },
    hasPossibleEffect(threadId) {
      try {
        // Polling is read-only; unresolved intents retry on the next writer.
        return {
          kind: 'available',
          active: options.coordinator.hasPossibleEffect(threadId),
        };
      } catch {
        return { kind: 'unavailable' };
      }
    },
    readInputlessTurnDisposition(threadId) {
      try {
        return (
          options.coordinator.readInputlessTurnDisposition?.(threadId) ?? {
            kind: 'unknown',
          }
        );
      } catch {
        return { kind: 'unknown' };
      }
    },
    retryPendingTransitions,
    readInvocationTerminal(threadId, invocationId, providerTurnId) {
      try {
        return (
          options.coordinator.readInvocationTerminal?.(
            threadId,
            invocationId,
            providerTurnId,
          ) ?? { kind: 'unknown' }
        );
      } catch {
        return { kind: 'unknown' };
      }
    },
    observe(event) {
      retryPendingTransitions();
      if (
        event.method !== 'turn.completed' &&
        event.method !== 'turn.aborted' &&
        event.method !== 'runtime.error' &&
        event.method !== 'session.exited'
      ) {
        return { kind: 'applied' };
      }
      const retire = !(
        (event.method === 'runtime.error' &&
          (event.code === SESSION_START_INDETERMINATE_CODE ||
            isDeferredRetriableTurnError(event))) ||
        (event.method === 'turn.aborted' && event.recoveryTerminal === true)
      );
      if (!retire && event.invocationId === undefined)
        return { kind: 'applied' };
      const turnId = 'turnId' in event ? event.turnId : undefined;
      return options.coordinator.removeTerminal({
        threadId: event.threadId,
        retire,
        ...(typeof turnId === 'string' ? { providerTurnId: turnId } : {}),
        ...(event.invocationId === undefined
          ? {}
          : { invocationId: event.invocationId }),
        sessionTerminal:
          event.method === 'session.exited' ||
          (event.method === 'runtime.error' &&
            typeof turnId !== 'string' &&
            event.invocationId === undefined),
        terminalCreatedAt: event.createdAt,
        terminalEventId: event.eventId,
        // Station's own shutdown closes the session, not the turn in it: the
        // next boot's recovery needs the turn row (see the constant).
        ...(event.method === 'session.exited' &&
        event.reason === ORCHESTRATION_SHUTDOWN_EXIT_REASON
          ? { retainBoundaryIdPrefixes: SHUTDOWN_RETAINED_BOUNDARY_PREFIXES }
          : {}),
      });
    },
    prepareProviderTurn,
    reconcile(now) {
      retryPendingTransitions();
      const result = reconcileDeadOwners(now);
      return result.ok
        ? { kind: 'available', interrupted: result.interrupted }
        : { kind: 'unavailable' };
    },
  };
}

/** Test/embedded fallback with the same opaque Interface but no restart claim. */
export function createInMemorySessionTurnBoundaryAuthority(): SessionTurnBoundaryAuthority {
  const records = new Map<string, SessionTurnBoundaryRecord>();
  let ordinal = 0;
  const terminalSequences = new Map<string, number>();
  const kernelRecord = (
    row: SessionTurnBoundaryRecord,
  ): TurnBoundaryRecord => ({
    boundaryId: row.boundaryId,
    threadId: row.threadId,
    state: row.state,
    purpose: row.purpose ?? 'turn',
    owner:
      row.ownerIdentityKind === 'exact' && row.ownerBirth
        ? {
            id: row.ownerId,
            pid: row.ownerPid,
            identityKind: 'exact',
            birth: row.ownerBirth,
          }
        : { id: row.ownerId, pid: row.ownerPid, identityKind: 'unverified' },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdSequence: row.createdSequence ?? null,
    ...(row.providerTurnId === undefined
      ? {}
      : { providerTurnId: row.providerTurnId }),
    ...(row.intent === undefined ? {} : { intent: row.intent }),
    ...(row.settlement === undefined ? {} : { settlement: row.settlement }),
  });
  const invocationFacts = new Map<string, InvocationTerminalFact>();
  const retirements = new Map<string, InvocationTerminalRetirement>();
  const put = (row: TurnBoundaryRecord) => {
    records.set(row.boundaryId, {
      boundaryId: row.boundaryId,
      threadId: row.threadId,
      state: row.state,
      ...(row.purpose === 'task-dispatch' ? { purpose: 'task-dispatch' } : {}),
      ownerId: row.owner.id,
      ownerPid: row.owner.pid,
      ownerIdentityKind: row.owner.identityKind,
      ...(row.owner.identityKind === 'exact'
        ? { ownerBirth: row.owner.birth }
        : {}),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      createdSequence: row.createdSequence,
      ...(row.providerTurnId === undefined
        ? {}
        : { providerTurnId: row.providerTurnId }),
      ...(row.intent === undefined
        ? {}
        : { intent: structuredClone(row.intent) }),
      ...(row.settlement === undefined
        ? {}
        : { settlement: structuredClone(row.settlement) }),
    });
  };
  const terminalTurnIds = new Map<string, Set<string>>();
  const coordinator: SessionTurnBoundaryCoordinator = {
    create(record) {
      const threadRecords = [...records.values()].filter(
        (candidate) =>
          candidate.threadId === record.threadId &&
          candidate.state !== 'settled',
      );
      if (
        record.state === 'lifecycle'
          ? threadRecords.length > 0
          : threadRecords.some((candidate) => candidate.state !== 'accepted') ||
            threadRecords.filter((candidate) => candidate.state === 'accepted')
              .length >= SESSION_TURN_ACCEPTED_CAPACITY
      ) {
        return { kind: 'busy' };
      }
      records.set(record.boundaryId, { ...record, createdSequence: ++ordinal });
      return { kind: 'applied' };
    },
    prepareIntent({ boundaryId, ownerId, capture, claim, now }) {
      if (claim) return { kind: 'unavailable' };
      const current = records.get(boundaryId);
      const decision = decideTurnBoundaryPrepare(
        current ? kernelRecord(current) : undefined,
        undefined,
        false,
        {
          type: 'turnBoundary.prepare',
          boundaryId,
          ownerId,
          intent: capture.intent,
          now,
        },
      );
      if (decision.put) put(decision.put);
      return decision.result.kind === 'conflict'
        ? { kind: 'stale' }
        : decision.result;
    },
    beginPrepared({ boundaryId, ownerId, capture, claim, now }) {
      if (claim) return { kind: 'unavailable' };
      const current = records.get(boundaryId);
      const decision = decideTurnBoundaryBeginInvocation(
        current ? kernelRecord(current) : undefined,
        undefined,
        false,
        {
          type: 'turnBoundary.beginInvocation',
          boundaryId,
          ownerId,
          intent: capture.intent,
          now,
        },
      );
      if (decision.put) put(decision.put);
      const begun = records.get(boundaryId);
      return decision.result.kind === 'applied' && begun
        ? { kind: 'applied', begun: { expected: kernelRecord(begun) } }
        : { kind: 'stale' };
    },
    acceptInvocation(input) {
      const command = {
        ...input,
        type: 'turnBoundary.acceptInvocation' as const,
      };
      const raw = records.get(input.expected.boundaryId);
      const current = raw ? kernelRecord(raw) : undefined;
      const witness = retirements.get(input.expected.boundaryId);
      const target = current ?? witness?.boundary;
      if (!target?.intent) return { kind: 'stale' };
      const read = findInvocationTerminal(
        [...invocationFacts.values()].filter(
          (fact) =>
            fact.threadId === target.threadId &&
            fact.invocationId === target.intent?.invocationId,
        ),
        {
          threadId: target.threadId,
          invocationId: target.intent.invocationId,
          providerTurnId: input.providerTurnId,
          allowMissingProviderTurnId:
            target.providerTurnId === undefined &&
            input.expected.providerTurnId === undefined,
          ...(current || !witness
            ? {}
            : { terminalEventId: witness.terminal.terminalEventId }),
        },
      );
      const decision = decideTurnBoundaryAcceptInvocation(
        current,
        [...records.values()]
          .filter((row) => row.threadId === target.threadId)
          .map(kernelRecord),
        undefined,
        false,
        read,
        witness,
        command,
      );
      if (decision.retirement)
        retirements.set(
          target.boundaryId,
          structuredClone(decision.retirement),
        );
      if (decision.remove) records.delete(decision.remove);
      if (decision.put) put(decision.put);
      return decision.result.kind === 'accepted' ||
        decision.result.kind === 'terminal'
        ? { kind: 'applied' }
        : decision.result;
    },
    recordDefinitiveRefusal({
      boundaryId,
      boundary,
      capture,
      claim,
      settlementId,
      now,
    }) {
      if (claim) return { kind: 'unavailable' };
      const raw = records.get(boundaryId);
      const decision = decidePreparedTurnSettlement(
        raw ? kernelRecord(raw) : undefined,
        undefined,
        false,
        {
          type: 'turnBoundary.recordDefinitiveRefusal',
          boundaryId,
          boundary,
          intent: capture.intent,
          settlementId,
          now,
        },
      );
      if (decision.put) put(decision.put);
      return decision.result.kind === 'applied'
        ? decision.result
        : { kind: 'stale' };
    },
    transition(input) {
      const raw = records.get(input.boundaryId);
      const collision = Boolean(
        input.providerTurnId &&
          (terminalTurnIds
            .get(raw?.threadId ?? '')
            ?.has(input.providerTurnId) ||
            [...records.values()].some(
              (row) =>
                row.boundaryId !== input.boundaryId &&
                row.threadId === raw?.threadId &&
                row.state === 'accepted' &&
                row.providerTurnId === input.providerTurnId,
            )),
      );
      const decision = decideTurnBoundaryTransition(
        raw ? kernelRecord(raw) : undefined,
        { ...input, type: 'turnBoundary.transition' },
        collision,
      );
      if (decision.put) put(decision.put);
      return decision.result;
    },
    remove(input) {
      const raw = records.get(input.boundaryId);
      const decision = decideTurnBoundaryRemove(
        raw ? kernelRecord(raw) : undefined,
        { ...input, type: 'turnBoundary.remove' },
        () => 'unknown',
      );
      if (decision.remove) records.delete(input.boundaryId);
      return decision.result;
    },
    removeTerminal(input) {
      if (input.providerTurnId) {
        let terminals = terminalTurnIds.get(input.threadId);
        if (!terminals) {
          terminals = new Set();
          terminalTurnIds.set(input.threadId, terminals);
        }
        terminals.add(input.providerTurnId);
      }
      let sequence =
        input.terminalEventId === undefined
          ? undefined
          : terminalSequences.get(input.terminalEventId);
      if (sequence === undefined && input.terminalEventId !== undefined) {
        sequence = ++ordinal;
        terminalSequences.set(input.terminalEventId, sequence);
      }
      let fact: InvocationTerminalFact | undefined;
      const staged = new Map(invocationFacts);
      if (input.invocationId !== undefined && !input.sessionTerminal) {
        if (!input.terminalEventId) return { kind: 'unavailable' };
        fact = {
          threadId: input.threadId,
          invocationId: input.invocationId,
          terminalEventId: input.terminalEventId,
          terminalCreatedAt: input.terminalCreatedAt,
          retire: input.retire ?? true,
          ...(input.providerTurnId === undefined
            ? {}
            : { providerTurnId: input.providerTurnId }),
        };
        const key = JSON.stringify([fact.threadId, fact.terminalEventId]);
        const old = staged.get(key);
        if (old && !isDeepStrictEqual(old, fact))
          return { kind: 'unavailable' };
        staged.set(key, fact);
      }
      const reads = fact
        ? [...records.values()]
            .filter(
              (row) =>
                row.threadId === fact?.threadId &&
                row.intent?.invocationId === fact?.invocationId,
            )
            .map((row) => ({
              boundaryId: row.boundaryId,
              read: findInvocationTerminal(
                [...staged.values()].filter(
                  (candidate) =>
                    candidate.threadId === row.threadId &&
                    candidate.invocationId === row.intent?.invocationId,
                ),
                {
                  threadId: row.threadId,
                  invocationId: fact!.invocationId,
                  terminalEventId: fact!.terminalEventId,
                  ...(row.providerTurnId === undefined
                    ? {}
                    : { providerTurnId: row.providerTurnId }),
                  allowMissingProviderTurnId: row.providerTurnId === undefined,
                },
              ),
            }))
        : [];
      const decision = decideTurnBoundaryObserveTerminal(
        [...records.values()]
          .filter((row) => row.threadId === input.threadId)
          .map(kernelRecord),
        { ...input, type: 'turnBoundary.observeTerminal' },
        sequence,
        reads,
      );
      for (const [key, value] of staged)
        invocationFacts.set(key, structuredClone(value));
      for (const witness of decision.retirements)
        retirements.set(witness.boundary.boundaryId, structuredClone(witness));
      for (const id of decision.retire) records.delete(id);
      return { kind: 'applied' };
    },
    hasPossibleEffect: (threadId) =>
      [...records.values()].some(
        (record) =>
          record.threadId === threadId &&
          record.state !== 'lifecycle' &&
          record.state !== 'settled',
      ),
    active: () => [...records.values()].map((record) => ({ ...record })),
    recordAccepted(record) {
      const raw = records.get(record.boundaryId);
      const row = kernelRecord(record);
      const decision = decideTurnBoundaryRecordAccepted(
        [...records.values()]
          .filter((item) => item.threadId === record.threadId)
          .map(kernelRecord),
        raw ? kernelRecord(raw) : undefined,
        {
          type: 'turnBoundary.recordAccepted',
          boundaryId: row.boundaryId,
          threadId: row.threadId,
          owner: row.owner,
          providerTurnId: record.providerTurnId,
          now: row.createdAt,
        },
        SESSION_TURN_ACCEPTED_CAPACITY,
      );
      if (decision.put) put({ ...decision.put, createdSequence: ++ordinal });
      return decision.result;
    },
  };
  return createSessionTurnBoundaryAuthority({
    coordinator,
    owner: {
      id: randomUUID(),
      pid: process.pid,
      identityKind: 'unverified',
    },
    processIdentity: {
      exact: () => null,
      probe: () => ({ state: 'unavailable' }),
    },
  });
}

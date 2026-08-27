import { randomUUID } from 'node:crypto';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import type {
  RecoveryLedgerProcessIdentity,
  RecoveryOwner,
} from './recovery-ledger.js';

type BoundaryState =
  | 'lifecycle'
  | 'prepared'
  | 'invoking'
  | 'accepted'
  | 'indeterminate';

export interface SessionTurnBoundaryRecord {
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
}

/** Unresolved provider acceptances are protected facts and are never pruned. */
export const SESSION_TURN_ACCEPTED_CAPACITY = 64;

export type SessionTurnBoundaryTransition =
  | { kind: 'applied' }
  | { kind: 'busy' }
  | { kind: 'ambiguous' }
  | { kind: 'stale' }
  | { kind: 'unavailable' };

export interface SessionTurnBoundaryCoordinator {
  create(
    record: SessionTurnBoundaryRecord & {
      state: 'lifecycle' | 'prepared';
    },
  ): SessionTurnBoundaryTransition;
  transition(input: {
    boundaryId: string;
    ownerId: string;
    from: BoundaryState[];
    to: Exclude<BoundaryState, 'lifecycle' | 'prepared'>;
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
    terminalCreatedAt: string;
  }): SessionTurnBoundaryTransition;
  hasPossibleEffect(threadId: string): boolean;
  active(): SessionTurnBoundaryRecord[];
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
  beginInvocation(now: string): SessionTurnBoundaryTransition;
  accepted(turnId: string, now: string): SessionTurnBoundaryTransition;
  terminalObserved(turnId: string): SessionTurnBoundaryTransition;
  notInvoked(): SessionTurnBoundaryTransition;
  indeterminate(now: string): SessionTurnBoundaryTransition;
}

export interface SessionTurnBoundaryAuthority {
  claim(
    threadId: string,
    now: string,
  ):
    | { kind: 'owner'; claim: SessionTurnBoundaryClaim }
    | { kind: 'busy' }
    | { kind: 'unavailable' };
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
  observe(event: CanonicalRuntimeEvent): SessionTurnBoundaryTransition;
  /**
   * station#4080 slice 1: `reconcile`'s existing dead-owner sweep already
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
  const reconcileDeadOwners = (
    now: string,
  ): { ok: boolean; interrupted: SessionTurnBoundaryRecord[] } => {
    const interrupted: SessionTurnBoundaryRecord[] = [];
    try {
      for (const record of options.coordinator.active()) {
        if (ownerIsLive(record, options.processIdentity)) continue;
        if (record.state === 'prepared' || record.state === 'lifecycle') {
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
    record: SessionTurnBoundaryRecord & { state: 'lifecycle' | 'prepared' },
  ) => {
    retryPendingTransitions();
    let created = options.coordinator.create(record);
    if (created.kind === 'busy' && reconcileDeadOwners(record.updatedAt).ok) {
      created = options.coordinator.create(record);
    }
    return created;
  };

  return {
    claim(threadId, now) {
      const boundaryId = `turn-boundary:${randomUUID()}`;
      const record = {
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
      const created = createWithRecovery(record);
      if (created.kind !== 'applied') {
        return {
          kind: created.kind === 'busy' ? 'busy' : 'unavailable',
        };
      }

      let invocationStarted = false;
      let invocationAttempted = false;
      let terminalIntent:
        | { kind: 'accepted'; turnId: string; now: string }
        | { kind: 'terminal-observed'; turnId: string }
        | { kind: 'not-invoked' }
        | { kind: 'indeterminate'; now: string }
        | undefined;
      let terminalApplied = false;
      const transition = (
        from: BoundaryState[],
        to: Exclude<BoundaryState, 'lifecycle' | 'prepared'>,
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
          beginInvocation(beginNow: string) {
            if (invocationStarted) return { kind: 'applied' } as const;
            invocationAttempted = true;
            const result = retainUntilApplied(boundaryId, () => {
              const transitioned = transition(
                ['prepared'],
                'invoking',
                beginNow,
              );
              if (transitioned.kind === 'applied') invocationStarted = true;
              return transitioned;
            });
            if (result.kind === 'applied') invocationStarted = true;
            return result;
          },
          accepted(turnId: string, acceptedNow: string) {
            if (
              terminalIntent &&
              (terminalIntent.kind !== 'accepted' ||
                terminalIntent.turnId !== turnId)
            ) {
              return { kind: 'stale' } as const;
            }
            if (terminalApplied) return { kind: 'applied' } as const;
            terminalIntent ??= {
              kind: 'accepted',
              turnId,
              now: acceptedNow,
            };
            const intent = terminalIntent as Extract<
              NonNullable<typeof terminalIntent>,
              { kind: 'accepted' }
            >;
            const result = retainUntilApplied(boundaryId, () =>
              transition(['invoking'], 'accepted', intent.now, intent.turnId),
            );
            if (result.kind === 'applied') terminalApplied = true;
            return result;
          },
          terminalObserved(turnId: string) {
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
            if (invocationAttempted) return { kind: 'stale' } as const;
            if (terminalIntent && terminalIntent.kind !== 'not-invoked') {
              return { kind: 'stale' } as const;
            }
            if (terminalApplied) return { kind: 'applied' } as const;
            terminalIntent ??= { kind: 'not-invoked' };
            const result = retainUntilApplied(boundaryId, () =>
              options.coordinator.remove({
                boundaryId,
                ownerId: options.owner.id,
                from: ['prepared'],
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
    },
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
        retryPendingTransitions();
        return {
          kind: 'available',
          active: options.coordinator.hasPossibleEffect(threadId),
        };
      } catch {
        return { kind: 'unavailable' };
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
      const turnId = 'turnId' in event ? event.turnId : undefined;
      return options.coordinator.removeTerminal({
        threadId: event.threadId,
        ...(typeof turnId === 'string' ? { providerTurnId: turnId } : {}),
        sessionTerminal:
          event.method === 'session.exited' ||
          (event.method === 'runtime.error' && typeof turnId !== 'string'),
        terminalCreatedAt: event.createdAt,
      });
    },
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
  const terminalTurnIds = new Map<string, Set<string>>();
  const coordinator: SessionTurnBoundaryCoordinator = {
    create(record) {
      const threadRecords = [...records.values()].filter(
        (candidate) => candidate.threadId === record.threadId,
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
      records.set(record.boundaryId, { ...record });
      return { kind: 'applied' };
    },
    transition(input) {
      const record = records.get(input.boundaryId);
      if (
        !record ||
        record.ownerId !== input.ownerId ||
        !input.from.includes(record.state)
      ) {
        return { kind: 'stale' };
      }
      if (
        input.to === 'accepted' &&
        input.providerTurnId &&
        (terminalTurnIds.get(record.threadId)?.has(input.providerTurnId) ||
          [...records.values()].some(
            (candidate) =>
              candidate.boundaryId !== record?.boundaryId &&
              candidate.threadId === record?.threadId &&
              candidate.state === 'accepted' &&
              candidate.providerTurnId === input.providerTurnId,
          ))
      ) {
        records.set(input.boundaryId, {
          ...record,
          state: 'indeterminate',
          providerTurnId: input.providerTurnId,
          updatedAt: input.now,
        });
        return { kind: 'ambiguous' };
      }
      records.set(input.boundaryId, {
        ...record,
        state: input.to,
        updatedAt: input.now,
        ...(input.providerTurnId
          ? { providerTurnId: input.providerTurnId }
          : {}),
      });
      return { kind: 'applied' };
    },
    remove(input) {
      const record = records.get(input.boundaryId);
      if (!record) return { kind: 'applied' };
      if (
        record.ownerId !== input.ownerId ||
        !input.from.includes(record.state)
      ) {
        return { kind: 'stale' };
      }
      records.delete(input.boundaryId);
      return { kind: 'applied' };
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
      for (const [id, record] of records) {
        if (
          record.threadId !== input.threadId ||
          record.state === 'lifecycle'
        ) {
          continue;
        }
        if (
          record.createdAt <= input.terminalCreatedAt &&
          (input.sessionTerminal ||
            (record.state === 'accepted' &&
              record.providerTurnId === input.providerTurnId))
        ) {
          records.delete(id);
        }
      }
      return { kind: 'applied' };
    },
    hasPossibleEffect: (threadId) =>
      [...records.values()].some(
        (record) =>
          record.threadId === threadId && record.state !== 'lifecycle',
      ),
    active: () => [...records.values()].map((record) => ({ ...record })),
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

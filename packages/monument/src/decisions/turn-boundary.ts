import type {
  TurnBoundaryCreateCommand,
  TurnBoundaryCreateResult,
  TurnBoundaryObserveTerminalCommand,
  TurnBoundaryReconcileCommand,
  TurnBoundaryReconcileObservation,
  TurnBoundaryRecordAcceptedCommand,
  TurnBoundaryRemoveCommand,
  TurnBoundaryRemoveResult,
  TurnBoundaryTransitionCommand,
  TurnBoundaryTransitionResult,
} from '../commands.js';
import {
  type OwnerIdentity,
  type OwnerLiveness,
  type OwnerLivenessOptions,
  ownerFields,
  ownerLivenessFromProbe,
  type ProcessIdentityObservation,
  type ProcessIdentityProbe,
} from '../owner.js';
import type { TurnBoundaryRecord } from '../records.js';
import { compareCodePoints } from './order.js';

/**
 * The provider-invocation boundary of one turn:
 *
 *   (none) -> lifecycle                      lifecycle claim, no effect
 *   (none) -> prepared -> invoking -> accepted
 *                     \           \-> indeterminate
 *                      \-> (removed: not invoked)
 *   (none) -> accepted                       engine-opened turn
 *
 * A row in `prepared`, `invoking`, `indeterminate` or `lifecycle` occupies
 * its thread. `accepted` rows do not, up to the per-thread capacity.
 */

export interface TurnBoundaryDecision<Result> {
  readonly put?: TurnBoundaryRecord;
  readonly result: Result;
}

function boundaryRecord(
  command: TurnBoundaryCreateCommand,
): TurnBoundaryRecord {
  return {
    boundaryId: command.boundaryId,
    threadId: command.threadId,
    state: command.state,
    purpose: command.purpose,
    owner: ownerFields(command.owner),
    createdAt: command.now,
    updatedAt: command.now,
  };
}

/**
 * `existing` is the row already stored under the command's boundary id, if
 * any. Re-creating one's own row answers `applied` without a write, so a
 * caller whose commit acknowledgement was lost can retry.
 */
export function decideTurnBoundaryCreate(
  threadRows: readonly TurnBoundaryRecord[],
  existing: TurnBoundaryRecord | undefined,
  command: TurnBoundaryCreateCommand,
  acceptedCapacity: number,
): TurnBoundaryDecision<TurnBoundaryCreateResult> {
  if (existing)
    return {
      result:
        existing.owner.id === command.owner.id &&
        existing.threadId === command.threadId &&
        existing.state === command.state
          ? { kind: 'applied' }
          : { kind: 'busy' },
    };
  const busy =
    command.state === 'lifecycle'
      ? threadRows.length > 0
      : threadRows.some((row) => row.state !== 'accepted') ||
        threadRows.length >= acceptedCapacity;
  if (busy) return { result: { kind: 'busy' } };
  return { put: boundaryRecord(command), result: { kind: 'applied' } };
}

/** An engine-opened turn: never blocked by an invocation, only by capacity. */
export function decideTurnBoundaryRecordAccepted(
  threadRows: readonly TurnBoundaryRecord[],
  existing: TurnBoundaryRecord | undefined,
  command: TurnBoundaryRecordAcceptedCommand,
  acceptedCapacity: number,
): TurnBoundaryDecision<TurnBoundaryCreateResult> {
  if (existing)
    return {
      result:
        existing.owner.id === command.owner.id &&
        existing.state === 'accepted' &&
        existing.providerTurnId === command.providerTurnId
          ? { kind: 'applied' }
          : { kind: 'busy' },
    };
  if (threadRows.length >= acceptedCapacity)
    return { result: { kind: 'busy' } };
  return {
    put: {
      boundaryId: command.boundaryId,
      threadId: command.threadId,
      state: 'accepted',
      purpose: 'turn',
      providerTurnId: command.providerTurnId,
      owner: ownerFields(command.owner),
      createdAt: command.now,
      updatedAt: command.now,
    },
    result: { kind: 'applied' },
  };
}

/**
 * `collision` says whether accepting this provider turn id would reuse one
 * the thread already saw terminate, or one another accepted row holds. In
 * that case the row goes to `indeterminate` and the answer is `ambiguous`.
 *
 * A retry that finds the row already exactly where this command would put it
 * (same state, `updatedAt` and provider turn id) is `applied`.
 */
export function decideTurnBoundaryTransition(
  current: TurnBoundaryRecord | undefined,
  command: TurnBoundaryTransitionCommand,
  collision: boolean,
): TurnBoundaryDecision<TurnBoundaryTransitionResult> {
  const target = collision ? 'indeterminate' : command.to;
  let after = current;
  let put: TurnBoundaryRecord | undefined;
  if (
    current &&
    current.owner.id === command.ownerId &&
    command.from.includes(current.state)
  ) {
    put = {
      ...current,
      state: target,
      updatedAt: command.now,
      ...(command.providerTurnId !== undefined
        ? { providerTurnId: command.providerTurnId }
        : {}),
    };
    after = put;
  }
  const landed =
    after !== undefined &&
    after.owner.id === command.ownerId &&
    after.state === target &&
    after.updatedAt === command.now &&
    (command.providerTurnId === undefined ||
      after.providerTurnId === command.providerTurnId);
  return {
    ...(put ? { put } : {}),
    result: landed
      ? { kind: collision ? 'ambiguous' : 'applied' }
      : { kind: 'stale' },
  };
}

/** Whether accepting `providerTurnId` on this row would be ambiguous. */
export function turnBoundaryAcceptCollides(
  current: TurnBoundaryRecord | undefined,
  command: TurnBoundaryTransitionCommand,
  threadRows: readonly TurnBoundaryRecord[],
  terminalSeen: boolean,
): boolean {
  if (
    !current ||
    command.to !== 'accepted' ||
    command.providerTurnId === undefined
  )
    return false;
  return (
    terminalSeen ||
    threadRows.some(
      (row) =>
        row.boundaryId !== current.boundaryId &&
        row.state === 'accepted' &&
        row.providerTurnId === command.providerTurnId,
    )
  );
}

export function decideTurnBoundaryRemove(
  current: TurnBoundaryRecord | undefined,
  command: TurnBoundaryRemoveCommand,
  liveness: OwnerLiveness,
): { readonly remove: boolean; readonly result: TurnBoundaryRemoveResult } {
  if (!current) return { remove: false, result: { kind: 'applied' } };
  if (
    current.owner.id !== command.ownerId ||
    !command.from.includes(current.state) ||
    (command.ifUpdatedAt !== undefined &&
      current.updatedAt !== command.ifUpdatedAt)
  )
    return { remove: false, result: { kind: 'stale' } };
  if (command.onlyIfOwnerDead && liveness(current.owner) !== 'dead')
    return { remove: false, result: { kind: 'busy' } };
  return { remove: true, result: { kind: 'applied' } };
}

/**
 * Which rows a terminal retires. A row created after the terminal belongs to
 * a later invocation and is never retired by it; lifecycle claims and task
 * dispatches have their own owners.
 */
export function decideTurnBoundaryObserveTerminal(
  threadRows: readonly TurnBoundaryRecord[],
  command: TurnBoundaryObserveTerminalCommand,
  terminalSequence?: number,
): { readonly retire: readonly string[] } {
  if (command.retire === false) return { retire: [] };
  return {
    retire: threadRows
      .filter(
        (row) =>
          row.state !== 'lifecycle' &&
          row.purpose !== 'task-dispatch' &&
          !command.retainBoundaryIdPrefixes?.some((prefix) =>
            row.boundaryId.startsWith(prefix),
          ) &&
          (command.sessionTerminal && row.createdSequence != null
            ? terminalSequence !== undefined &&
              row.createdSequence < terminalSequence
            : compareCodePoints(row.createdAt, command.terminalCreatedAt) <=
              0) &&
          (command.sessionTerminal ||
            (command.providerTurnId !== undefined &&
              row.state === 'accepted' &&
              row.providerTurnId === command.providerTurnId)),
      )
      .map((row) => row.boundaryId),
  };
}

function sameOwner(a: OwnerIdentity, b: OwnerIdentity): boolean {
  return (
    a.id === b.id &&
    a.pid === b.pid &&
    a.identityKind === b.identityKind &&
    (a.identityKind !== 'exact' ||
      (b.identityKind === 'exact' && a.birth === b.birth))
  );
}

/**
 * Dead owners' rows after a crash:
 *
 * - `prepared` and `lifecycle`: no effect began, so the row is removed and not
 *   reported.
 * - `invoking`: the effect may have started, so the row becomes
 *   `indeterminate` and is reported.
 * - `accepted` and `indeterminate`: reported unchanged; the caller retires
 *   them once it has told the user.
 *
 * The verdicts were taken outside the transaction. A row is acted on only if
 * it was observed `dead` and still has the observed owner (id, pid, identity
 * kind and birth), `createdAt` and `updatedAt`.
 * Rows whose owner is live or unknown, rows that moved on, and rows created
 * after the listing are untouched.
 */
export function decideTurnBoundaryReconcile(
  rows: readonly TurnBoundaryRecord[],
  observed: readonly TurnBoundaryReconcileObservation[],
  now: string,
): {
  readonly remove: readonly string[];
  readonly put: readonly TurnBoundaryRecord[];
  readonly interrupted: readonly TurnBoundaryRecord[];
} {
  const verdicts = new Map(
    observed.map((observation) => [observation.boundaryId, observation]),
  );
  const remove: string[] = [];
  const put: TurnBoundaryRecord[] = [];
  const interrupted: TurnBoundaryRecord[] = [];
  for (const row of rows) {
    const observation = verdicts.get(row.boundaryId);
    if (
      observation?.verdict !== 'dead' ||
      !sameOwner(observation.owner, row.owner) ||
      observation.createdAt !== row.createdAt ||
      observation.updatedAt !== row.updatedAt
    )
      continue;
    switch (row.state) {
      case 'prepared':
      case 'lifecycle':
        remove.push(row.boundaryId);
        break;
      case 'invoking': {
        const indeterminate: TurnBoundaryRecord = {
          ...row,
          state: 'indeterminate',
          updatedAt: now,
        };
        put.push(indeterminate);
        interrupted.push(indeterminate);
        break;
      }
      case 'accepted':
      case 'indeterminate':
        interrupted.push(row);
        break;
    }
  }
  return { remove, put, interrupted };
}

/**
 * The reconcile command for rows a host just listed. Liveness is decided
 * here, outside any transaction (a process probe can take seconds), and each
 * distinct process is probed once.
 */
export function planTurnBoundaryReconcile(
  rows: readonly TurnBoundaryRecord[],
  liveness: { readonly probe: ProcessIdentityProbe } & OwnerLivenessOptions,
  now: string,
): TurnBoundaryReconcileCommand {
  const probed = new Map<number, ProcessIdentityObservation>();
  const probe: ProcessIdentityProbe = (pid) => {
    let observation = probed.get(pid);
    if (!observation) {
      observation = liveness.probe(pid);
      probed.set(pid, observation);
    }
    return observation;
  };
  const verdictOf = ownerLivenessFromProbe(probe, liveness);
  return {
    type: 'turnBoundary.reconcile',
    now,
    observed: rows.map((row) => ({
      boundaryId: row.boundaryId,
      owner: ownerFields(row.owner),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      verdict: verdictOf(row.owner),
    })),
  };
}

import type {
  PreparedSettlementResult,
  TurnBoundaryBeginInvocationCommand,
  TurnBoundaryBeginInvocationResult,
  TurnBoundaryCancelPreparedCommand,
  TurnBoundaryCreateCommand,
  TurnBoundaryCreateResult,
  TurnBoundaryObserveTerminalCommand,
  TurnBoundaryPrepareCommand,
  TurnBoundaryPrepareResult,
  TurnBoundaryReconcileCommand,
  TurnBoundaryReconcileObservation,
  TurnBoundaryRecordAcceptedCommand,
  TurnBoundaryRecordDefinitiveRefusalCommand,
  TurnBoundaryRemoveCommand,
  TurnBoundaryRemoveResult,
  TurnBoundaryResumePreparedCommand,
  TurnBoundaryResumePreparedResult,
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
import type {
  InvocationTerminalRead,
  InvocationTerminalRetirement,
  PreparedTurnIntent,
  PreparedTurnSettlement,
  TurnBoundaryRecord,
  TurnDedupRecord,
} from '../records.js';
import {
  assertInvocationTerminalRead,
  invocationTerminalRetires,
} from './invocation-terminal.js';
import { compareCodePoints } from './order.js';
import {
  isPreparedTurnSettlement,
  samePreparedSettlement,
  sameSettlementOwner,
} from './prepared-settlement.js';
import { preparedDedupLinkState } from './turn-dedup.js';

/**
 * The provider-invocation boundary of one turn:
 *
 *   (none) -> lifecycle                      lifecycle claim, no effect
 *   (none) -> reserved -> prepared -> invoking -> accepted
 *   (none) -> prepared                      legacy inputless claim
 *                     \           \-> indeterminate
 *                      \-> (removed: not invoked)
 *   (none) -> accepted                       engine-opened turn
 *
 * A row in `reserved`, `prepared`, `invoking`, `indeterminate` or `lifecycle` occupies
 * its thread. `accepted` rows do not, up to the per-thread capacity.
 */

export interface TurnBoundaryDecision<Result> {
  readonly put?: TurnBoundaryRecord;
  readonly dedupPut?: TurnDedupRecord;
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
  if (command.state === 'reserved' && command.purpose !== 'turn')
    return { result: { kind: 'busy' } };
  if (existing)
    return {
      result:
        existing.owner.id === command.owner.id &&
        existing.threadId === command.threadId &&
        existing.state === command.state
          ? { kind: 'applied' }
          : { kind: 'busy' },
    };
  threadRows = threadRows.filter((row) => row.state !== 'settled');
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
        existing.intent === undefined &&
        existing.owner.id === command.owner.id &&
        existing.state === 'accepted' &&
        existing.providerTurnId === command.providerTurnId
          ? { kind: 'applied' }
          : { kind: 'busy' },
    };
  threadRows = threadRows.filter((row) => row.state !== 'settled');
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
  if (current?.state === 'settled' || current?.settlement !== undefined)
    return { result: { kind: 'stale' } };
  if (!['invoking', 'accepted', 'indeterminate'].includes(command.to))
    return { result: { kind: 'stale' } };
  // Prepared intent must cross the dual fence, never the legacy transition.
  if (
    current?.intent &&
    (command.to === 'invoking' ||
      command.to === 'accepted' ||
      current.state === 'prepared' ||
      current.state === 'reserved')
  )
    return { result: { kind: 'stale' } };
  if (current?.state === 'reserved') return { result: { kind: 'stale' } };
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
  if (current.state === 'settled' || current.settlement !== undefined)
    return { remove: false, result: { kind: 'stale' } };
  if (current.state === 'prepared' && current.intent)
    return { remove: false, result: { kind: 'stale' } };
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
  invocationReads: readonly {
    readonly boundaryId: string;
    readonly read: InvocationTerminalRead;
    readonly dedup?: TurnDedupRecord;
  }[] = [],
): {
  readonly retire: readonly string[];
  readonly retirements: readonly InvocationTerminalRetirement[];
} {
  const retire: string[] = [];
  const retirements: InvocationTerminalRetirement[] = [];
  if (command.retire === false) return { retire, retirements };
  for (const row of threadRows) {
    if (
      row.state === 'lifecycle' ||
      row.state === 'settled' ||
      row.settlement !== undefined ||
      row.purpose === 'task-dispatch' ||
      command.retainBoundaryIdPrefixes?.some((prefix) =>
        row.boundaryId.startsWith(prefix),
      )
    )
      continue;
    if (command.sessionTerminal) {
      if (
        row.createdSequence != null
          ? terminalSequence !== undefined &&
            row.createdSequence < terminalSequence
          : compareCodePoints(row.createdAt, command.terminalCreatedAt) <= 0
      )
        retire.push(row.boundaryId);
      continue;
    }
    if (row.intent !== undefined) {
      if (
        !isPreparedTurnIntent(row.intent) ||
        command.invocationId !== row.intent.invocationId
      )
        continue;
      const input = invocationReads.find(
        (entry) => entry.boundaryId === row.boundaryId,
      );
      if (!input) continue;
      const query = {
        threadId: row.threadId,
        invocationId: row.intent.invocationId,
        ...(row.providerTurnId === undefined
          ? {}
          : { providerTurnId: row.providerTurnId }),
        allowMissingProviderTurnId: row.providerTurnId === undefined,
        ...(command.terminalEventId === undefined
          ? {}
          : { terminalEventId: command.terminalEventId }),
      };
      assertInvocationTerminalRead(input.read, query);
      if (
        input.read.kind === 'found' &&
        invocationTerminalRetires(row, input.read.fact)
      ) {
        retirements.push({
          schema: 'monument.invocation-terminal-retirement/v1',
          terminal: input.read.fact,
          boundary: row,
          ...(input.dedup ? { dedup: input.dedup } : {}),
        });
        retire.push(row.boundaryId);
      }
      continue;
    }
    if (
      command.providerTurnId !== undefined &&
      row.state === 'accepted' &&
      row.providerTurnId === command.providerTurnId &&
      compareCodePoints(row.createdAt, command.terminalCreatedAt) <= 0
    )
      retire.push(row.boundaryId);
  }
  return { retire, retirements };
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

/** Invalid or incomplete identities are never resumable. No digest semantics are inferred. */
export function isPreparedTurnIntent(
  value: unknown,
): value is PreparedTurnIntent {
  if (typeof value !== 'object' || value === null) return false;
  const intent = value as Record<string, unknown>;
  return (
    ['invocationId', 'inputDigest', 'intentDigest', 'bodyRef'].every(
      (field) => typeof intent[field] === 'string' && intent[field] !== '',
    ) &&
    (intent.dedupKey === undefined ||
      (typeof intent.dedupKey === 'string' && intent.dedupKey !== ''))
  );
}

function sameIntent(
  a: PreparedTurnIntent | undefined,
  b: PreparedTurnIntent,
): boolean {
  return (
    isPreparedTurnIntent(a) &&
    isPreparedTurnIntent(b) &&
    a.invocationId === b.invocationId &&
    a.inputDigest === b.inputDigest &&
    a.intentDigest === b.intentDigest &&
    a.bodyRef === b.bodyRef &&
    a.dedupKey === b.dedupKey
  );
}

function pendingLink(
  dedup: TurnDedupRecord | undefined,
  intent: PreparedTurnIntent,
  ownerId: string | undefined,
): dedup is TurnDedupRecord & { owner: OwnerIdentity } {
  return (
    dedup !== undefined &&
    dedup.key === intent.dedupKey &&
    dedup.value === null &&
    dedup.invocation === 'pending' &&
    dedup.owner !== undefined &&
    preparedDedupLinkState(dedup) === 'linked' &&
    dedup.owner.id === ownerId &&
    dedup.preparedInvocationId === intent.invocationId
  );
}

export function decideTurnBoundaryPrepare(
  current: TurnBoundaryRecord | undefined,
  dedup: TurnDedupRecord | undefined,
  tombstoned: boolean,
  command: TurnBoundaryPrepareCommand,
): TurnBoundaryDecision<TurnBoundaryPrepareResult> {
  if (
    !current ||
    current.settlement !== undefined ||
    dedup?.settlement !== undefined ||
    current.owner.id !== command.ownerId ||
    current.purpose !== 'turn' ||
    (current.state !== 'reserved' && current.state !== 'prepared') ||
    !isPreparedTurnIntent(command.intent)
  )
    return { result: { kind: 'stale' } };
  if (current.intent && !sameIntent(current.intent, command.intent))
    return { result: { kind: 'conflict' } };
  if (current.state === 'prepared' && !current.intent)
    return { result: { kind: 'stale' } };
  if (
    command.intent.dedupKey !== undefined &&
    (tombstoned ||
      !dedup ||
      preparedDedupLinkState(dedup) === 'invalid' ||
      dedup.value !== null ||
      dedup.invocation !== 'pending' ||
      !dedup.owner ||
      dedup.owner.id !== command.dedupOwnerId ||
      dedup.key !== command.intent.dedupKey ||
      (dedup.preparedInvocationId !== undefined &&
        dedup.preparedInvocationId !== command.intent.invocationId) ||
      (current.intent === undefined &&
        dedup.preparedInvocationId !== undefined) ||
      (current.intent !== undefined &&
        !pendingLink(dedup, command.intent, command.dedupOwnerId)))
  )
    return { result: { kind: 'stale' } };
  if (current.intent) return { result: { kind: 'applied' } };
  return {
    put: {
      ...current,
      state: 'prepared',
      intent: { ...command.intent },
      updatedAt: command.now,
    },
    ...(dedup && command.intent.dedupKey !== undefined
      ? {
          dedupPut: {
            ...dedup,
            preparedInvocationId: command.intent.invocationId,
            preparedUpdatedAt: command.now,
          },
        }
      : {}),
    result: { kind: 'applied' },
  };
}

export function decideTurnBoundaryBeginInvocation(
  current: TurnBoundaryRecord | undefined,
  dedup: TurnDedupRecord | undefined,
  tombstoned: boolean,
  command: TurnBoundaryBeginInvocationCommand,
): TurnBoundaryDecision<TurnBoundaryBeginInvocationResult> {
  if (
    current?.purpose !== 'turn' ||
    current.settlement !== undefined ||
    dedup?.settlement !== undefined ||
    current.owner.id !== command.ownerId ||
    !sameIntent(current.intent, command.intent) ||
    (current.state !== 'prepared' && current.state !== 'invoking')
  )
    return { result: { kind: 'refused' } };
  const already = current.state === 'invoking';
  if (
    command.intent.dedupKey !== undefined &&
    (tombstoned ||
      !dedup ||
      preparedDedupLinkState(dedup) !== 'linked' ||
      dedup.key !== command.intent.dedupKey ||
      dedup.value !== null ||
      dedup.owner?.id !== command.dedupOwnerId ||
      dedup.preparedInvocationId !== command.intent.invocationId ||
      dedup.invocation !== (already ? 'begun' : 'pending'))
  )
    return { result: { kind: 'refused' } };
  if (already) return { result: { kind: 'applied' } };
  return {
    put: { ...current, state: 'invoking', updatedAt: command.now },
    ...(dedup && command.intent.dedupKey !== undefined
      ? { dedupPut: { ...dedup, invocation: 'begun' } }
      : {}),
    result: { kind: 'applied' },
  };
}

export function decideTurnBoundaryResumePrepared(
  current: TurnBoundaryRecord | undefined,
  dedup: TurnDedupRecord | undefined,
  tombstoned: boolean,
  command: TurnBoundaryResumePreparedCommand,
  liveness: OwnerLiveness,
): TurnBoundaryDecision<TurnBoundaryResumePreparedResult> {
  const observed = command.observed;
  if (
    current?.purpose !== 'turn' ||
    current.settlement !== undefined ||
    dedup?.settlement !== undefined ||
    current.state !== 'prepared' ||
    !sameIntent(current.intent, command.intent) ||
    observed.verdict !== 'dead' ||
    current.owner.identityKind !== 'exact' ||
    current.owner.id === command.owner.id ||
    !sameOwner(current.owner, observed.owner) ||
    current.createdAt !== observed.createdAt ||
    current.updatedAt !== observed.updatedAt ||
    liveness(current.owner) !== 'dead'
  )
    return { result: { kind: 'refused' } };
  if (
    command.intent.dedupKey !== undefined &&
    (tombstoned ||
      !command.dedup ||
      !pendingLink(dedup, command.intent, command.dedup.previousOwner.id) ||
      dedup.owner.identityKind !== 'exact' ||
      dedup.owner.id === command.dedup.owner.id ||
      !sameOwner(dedup.owner, command.dedup.previousOwner) ||
      dedup.createdAt !== command.dedup.createdAt ||
      dedup.preparedUpdatedAt !== command.dedup.updatedAt ||
      liveness(dedup.owner) !== 'dead')
  )
    return { result: { kind: 'refused' } };
  return {
    put: {
      ...current,
      owner: ownerFields(command.owner),
      updatedAt: command.now,
    },
    ...(dedup && command.dedup && command.intent.dedupKey !== undefined
      ? {
          dedupPut: {
            ...dedup,
            owner: ownerFields(command.dedup.owner),
            preparedUpdatedAt: command.now,
          },
        }
      : {}),
    result: { kind: 'applied' },
  };
}

/** Cancel/refuse through this compound protocol only; ordinary release stays fenced. */
export function decidePreparedTurnSettlement(
  current: TurnBoundaryRecord | undefined,
  dedup: TurnDedupRecord | undefined,
  tombstoned: boolean,
  command:
    | TurnBoundaryCancelPreparedCommand
    | TurnBoundaryRecordDefinitiveRefusalCommand,
): TurnBoundaryDecision<PreparedSettlementResult> {
  const refusal = command.type === 'turnBoundary.recordDefinitiveRefusal';
  const expected: PreparedTurnSettlement = {
    id: command.settlementId,
    disposition: refusal ? 'definitively-refused' : 'cancelled',
    at: command.now,
    boundaryId: command.boundaryId,
    boundary: command.boundary,
    ...(command.dedup ? { dedup: command.dedup } : {}),
  };
  if (
    !isPreparedTurnSettlement(expected) ||
    current?.purpose !== 'turn' ||
    current.boundaryId !== command.boundaryId ||
    !sameIntent(current.intent, command.intent) ||
    !sameSettlementOwner(current.owner, command.boundary.owner) ||
    current.createdAt !== command.boundary.createdAt ||
    current.providerTurnId !== undefined ||
    (command.intent.dedupKey === undefined) !== (command.dedup === undefined)
  )
    return { result: { kind: 'refused' } };
  const already = current.state === 'settled';
  if (
    already
      ? current.updatedAt !== command.now ||
        !samePreparedSettlement(current.settlement, expected)
      : current.state !== (refusal ? 'invoking' : 'prepared') ||
        current.updatedAt !== command.boundary.updatedAt ||
        current.settlement !== undefined
  )
    return { result: { kind: 'refused' } };
  if (command.intent.dedupKey !== undefined) {
    const observed = command.dedup;
    if (
      tombstoned ||
      !observed ||
      !dedup ||
      !dedup.owner ||
      !sameSettlementOwner(dedup.owner, observed.owner) ||
      dedup.createdAt !== observed.createdAt ||
      dedup.value !== null ||
      dedup.invocation !== (refusal ? 'begun' : 'pending') ||
      dedup.key !== command.intent.dedupKey ||
      preparedDedupLinkState(dedup) !== 'linked' ||
      dedup.preparedInvocationId !== command.intent.invocationId ||
      dedup.preparedUpdatedAt !== observed.updatedAt ||
      (already
        ? !samePreparedSettlement(dedup.settlement, expected)
        : dedup.settlement !== undefined)
    )
      return { result: { kind: 'refused' } };
  }
  if (already) return { result: { kind: 'applied' } };
  return {
    ...(dedup ? { dedupPut: { ...dedup, settlement: expected } } : {}),
    put: {
      ...current,
      state: 'settled',
      updatedAt: command.now,
      settlement: expected,
    },
    result: { kind: 'applied' },
  };
}

/**
 * Dead owners' rows after a crash:
 *
 * - `reserved`, inputless legacy `prepared` and `lifecycle`: removed.
 * - Complete ordinary `prepared` intents: retained and reported separately
 *   as candidates; explicit resume still checks both fences.
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
  readonly resumable: readonly TurnBoundaryRecord[];
} {
  const verdicts = new Map(
    observed.map((observation) => [observation.boundaryId, observation]),
  );
  const remove: string[] = [];
  const put: TurnBoundaryRecord[] = [];
  const interrupted: TurnBoundaryRecord[] = [];
  const resumable: TurnBoundaryRecord[] = [];
  for (const row of rows) {
    if (row.state === 'settled' || row.settlement !== undefined) continue;
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
        if (row.purpose === 'turn' && isPreparedTurnIntent(row.intent)) {
          resumable.push(row);
          break;
        }
        remove.push(row.boundaryId);
        break;
      case 'reserved':
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
  return { remove, put, interrupted, resumable };
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

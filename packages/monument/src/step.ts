import type {
  KernelCommand,
  KernelResult,
  KernelResults,
  ParticipantRefusal,
} from './commands.js';
import { decideRequestKeyClaim } from './decisions/request-keys.js';
import {
  decideTurnBoundaryCreate,
  decideTurnBoundaryObserveTerminal,
  decideTurnBoundaryReconcile,
  decideTurnBoundaryRecordAccepted,
  decideTurnBoundaryRemove,
  decideTurnBoundaryTransition,
  turnBoundaryAcceptCollides,
} from './decisions/turn-boundary.js';
import {
  decideTurnDedupBeginInvocation,
  decideTurnDedupClaim,
  decideTurnDedupRelease,
  decideTurnDedupResolve,
  type TurnDedupDecision,
} from './decisions/turn-dedup.js';
import {
  type CommitParticipant,
  DEFAULT_KERNEL_LIMITS,
  type KernelContext,
  type KernelLimits,
  type KernelTransaction,
} from './port.js';

const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function resolveKernelLimits(
  limits: Partial<KernelLimits> | undefined,
): KernelLimits {
  const resolved = { ...DEFAULT_KERNEL_LIMITS, ...limits };
  for (const [name, value] of Object.entries(resolved))
    if (!Number.isInteger(value) || value < 1)
      throw new RangeError(
        `monument limit ${name} must be a positive integer.`,
      );
  return resolved;
}

function applyTurnDedup<Result>(
  tx: KernelTransaction,
  key: string,
  decision: TurnDedupDecision<Result>,
  limits: KernelLimits,
  prune: boolean,
): Result {
  if (decision.write.kind === 'put') tx.turnDedup.put(decision.write.record);
  else if (decision.write.kind === 'delete') tx.turnDedup.delete(key);
  if (prune) tx.turnDedup.pruneResolved(limits.turnDedupMaxEntries);
  return decision.result;
}

/**
 * Executes one command against one open transaction: fetches what its
 * decision reads, calls the pure decision, applies the writes it names. An
 * adapter calls this (through {@link runKernelTransactionStep}) inside its own
 * transaction; it never commits or rolls back itself.
 */
function runKernelCommand<C extends KernelCommand>(
  command: C,
  context: KernelContext,
  tx: KernelTransaction,
): KernelResults[C['type']] {
  return dispatch(command, context, tx) as KernelResults[C['type']];
}

function dispatch(
  command: KernelCommand,
  context: KernelContext,
  tx: KernelTransaction,
): KernelResults[KernelCommand['type']] {
  const limits = resolveKernelLimits(context.limits);
  switch (command.type) {
    case 'turnDedup.claim':
      return applyTurnDedup(
        tx,
        command.key,
        decideTurnDedupClaim(
          tx.turnDedup.get(command.key),
          command,
          context.liveness,
        ),
        limits,
        true,
      );
    case 'turnDedup.beginInvocation': {
      const decision = decideTurnDedupBeginInvocation(
        tx.turnDedup.get(command.key),
        command,
      );
      // A refused begin writes nothing at all, retention included.
      return applyTurnDedup(
        tx,
        command.key,
        decision,
        limits,
        decision.result.kind === 'applied',
      );
    }
    case 'turnDedup.resolve':
      return applyTurnDedup(
        tx,
        command.key,
        decideTurnDedupResolve(tx.turnDedup.get(command.key), command),
        limits,
        true,
      );
    case 'turnDedup.release':
      return applyTurnDedup(
        tx,
        command.key,
        decideTurnDedupRelease(tx.turnDedup.get(command.key), command),
        limits,
        true,
      );
    case 'turnDedup.read': {
      const record = tx.turnDedup.get(command.key);
      return record ? { kind: 'found', record } : { kind: 'absent' };
    }
    case 'turnDedup.forgetPrefix':
      // An empty prefix would forget every key, and an unpaired surrogate is
      // stored differently by each adapter (node:sqlite binds it as U+FFFD).
      if (command.prefix === '' || LONE_SURROGATE.test(command.prefix))
        throw new RangeError(
          'turnDedup.forgetPrefix needs a non-empty, well-formed prefix.',
        );
      return {
        kind: 'applied',
        removed: tx.turnDedup.deletePrefix(command.prefix),
      };

    case 'turnBoundary.create': {
      const decision = decideTurnBoundaryCreate(
        tx.turnBoundary.listThread(command.threadId),
        tx.turnBoundary.get(command.boundaryId),
        command,
        limits.turnBoundaryAcceptedCapacity,
      );
      if (decision.put) tx.turnBoundary.put(decision.put);
      return decision.result;
    }
    case 'turnBoundary.recordAccepted': {
      const decision = decideTurnBoundaryRecordAccepted(
        tx.turnBoundary.listThread(command.threadId),
        tx.turnBoundary.get(command.boundaryId),
        command,
        limits.turnBoundaryAcceptedCapacity,
      );
      if (decision.put) tx.turnBoundary.put(decision.put);
      return decision.result;
    }
    case 'turnBoundary.transition': {
      const current = tx.turnBoundary.get(command.boundaryId);
      const collision = turnBoundaryAcceptCollides(
        current,
        command,
        current ? tx.turnBoundary.listThread(current.threadId) : [],
        current !== undefined &&
          command.providerTurnId !== undefined &&
          tx.turnTerminals.has(current.threadId, command.providerTurnId),
      );
      const decision = decideTurnBoundaryTransition(
        current,
        command,
        collision,
      );
      if (decision.put) tx.turnBoundary.put(decision.put);
      return decision.result;
    }
    case 'turnBoundary.remove': {
      const decision = decideTurnBoundaryRemove(
        tx.turnBoundary.get(command.boundaryId),
        command,
        context.liveness,
      );
      if (decision.remove) tx.turnBoundary.delete(command.boundaryId);
      return decision.result;
    }
    case 'turnBoundary.observeTerminal': {
      if (command.providerTurnId !== undefined)
        tx.turnTerminals.add(command.threadId, command.providerTurnId);
      const decision = decideTurnBoundaryObserveTerminal(
        tx.turnBoundary.listThread(command.threadId),
        command,
      );
      for (const boundaryId of decision.retire)
        tx.turnBoundary.delete(boundaryId);
      return { kind: 'applied' };
    }
    case 'turnBoundary.hasPossibleEffect':
      return {
        kind: 'available',
        active: tx.turnBoundary
          .listThread(command.threadId)
          .some((row) => row.state !== 'lifecycle'),
      };
    case 'turnBoundary.list':
      return { kind: 'records', records: tx.turnBoundary.listAll() };
    case 'turnBoundary.reconcile': {
      const decision = decideTurnBoundaryReconcile(
        tx.turnBoundary.listAll(),
        context.liveness,
        command.now,
      );
      for (const boundaryId of decision.remove)
        tx.turnBoundary.delete(boundaryId);
      for (const record of decision.put) tx.turnBoundary.put(record);
      return { kind: 'reconciled', interrupted: decision.interrupted };
    }
    case 'turnBoundary.forgetThread': {
      for (const row of tx.turnBoundary.listThread(command.threadId))
        if (row.state !== 'lifecycle') tx.turnBoundary.delete(row.boundaryId);
      // Terminal facts retire with the thread's boundaries (see README).
      tx.turnTerminals.deleteThread(command.threadId);
      return { kind: 'applied' };
    }

    case 'requestKeys.claim': {
      // station#3559 remainder (#3581): this purge also forgets unresolved
      // claims. Reproduced exactly from Station; the fixing lane owns it.
      tx.requestKeys.deleteCreatedBefore(command.now - limits.requestKeyTtlMs);
      const existing = tx.requestKeys.get(command.id);
      const decision = decideRequestKeyClaim({
        existing,
        digest: command.digest,
        callerRows: existing
          ? 0
          : tx.requestKeys.countCaller(command.id.callerSessionId),
        callerCompletedRows: existing
          ? 0
          : tx.requestKeys.countCallerCompleted(command.id.callerSessionId),
        allRows: existing ? 0 : tx.requestKeys.countAll(),
        limits,
      });
      if (decision.evict > 0)
        tx.requestKeys.evictOldestCompleted(
          command.id.callerSessionId,
          decision.evict,
        );
      if (decision.insert)
        tx.requestKeys.put({
          id: command.id,
          digest: command.digest,
          decision: null,
          result: null,
          createdAt: command.now,
        });
      return decision.result;
    }
    case 'requestKeys.recordDecision': {
      const existing = tx.requestKeys.get(command.id);
      if (!existing) return { kind: 'missing' };
      tx.requestKeys.put({ ...existing, decision: command.decision });
      return { kind: 'applied' };
    }
    case 'requestKeys.complete': {
      const existing = tx.requestKeys.get(command.id);
      if (!existing) return { kind: 'missing' };
      tx.requestKeys.put({ ...existing, result: command.result });
      return { kind: 'applied' };
    }
    case 'requestKeys.release': {
      const existing = tx.requestKeys.get(command.id);
      if (!existing) return { kind: 'missing' };
      if (existing.result !== null) return { kind: 'kept' };
      tx.requestKeys.delete(command.id);
      return { kind: 'released' };
    }
  }
}

/**
 * What every adapter runs inside its transaction: participant admission, the
 * command, then participant commits. A throw from any of them must make the
 * adapter roll the whole transaction back.
 */
export function runKernelTransactionStep<C extends KernelCommand, Host>(
  command: C,
  context: KernelContext,
  tx: KernelTransaction,
  participants: readonly CommitParticipant<Host>[],
  host: Host,
): KernelResult<C> {
  for (const participant of participants) {
    const verdict = participant.admit?.(command, host);
    if (verdict)
      return {
        kind: 'refused',
        participant: participant.name,
        reason: verdict.refuse,
      } satisfies ParticipantRefusal;
  }
  const result = runKernelCommand(command, context, tx);
  for (const participant of participants)
    participant.commit?.({ command, result }, host);
  return result;
}

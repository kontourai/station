import type {
  KernelCommand,
  KernelResult,
  KernelResults,
  ParticipantRefusal,
} from './commands.js';
import {
  decideInboxCancel,
  decideInboxClaimNext,
  decideInboxRelease,
  decideInboxResolveUnconfirmed,
  decideInboxSettle,
  decideInboxSubmit,
} from './decisions/inbox.js';
import {
  acceptanceQuery,
  assertAcceptInvocationCommand,
  assertInvocationTerminalFact,
  assertInvocationTerminalQuery,
  assertInvocationTerminalRead,
  assertInvocationTerminalRetirement,
  decideTurnBoundaryAcceptInvocation,
  isSynchronousTerminalBundle,
  sameTerminalData,
  terminalDataObject,
} from './decisions/invocation-terminal.js';
import { decideRequestKeyClaim } from './decisions/request-keys.js';
import {
  decidePreparedTurnSettlement,
  decideTurnBoundaryBeginInvocation,
  decideTurnBoundaryCreate,
  decideTurnBoundaryObserveTerminal,
  decideTurnBoundaryPrepare,
  decideTurnBoundaryReconcile,
  decideTurnBoundaryRecordAccepted,
  decideTurnBoundaryRemove,
  decideTurnBoundaryResumePrepared,
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
import type { OwnerLivenessVerdict } from './owner.js';
import {
  type CommitParticipant,
  DEFAULT_KERNEL_LIMITS,
  type KernelContext,
  type KernelLimits,
  type KernelTerminalFacts,
  type KernelTransaction,
} from './port.js';
import type { InvocationTerminalFact } from './records.js';

const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function assertSteerReceiptText(value: string): void {
  if (typeof value !== 'string' || LONE_SURROGATE.test(value))
    throw new TypeError('Steer receipt strings must be well-formed Unicode.');
}

/**
 * The limits a command runs under, or a `RangeError` for one that is not
 * valid. Every command resolves its limits, so an invalid one fails at its
 * first command; a host that builds its limits once can call this when it
 * does, and fail at construction instead.
 */
export function resolveKernelLimits(
  limits: Partial<KernelLimits> | undefined,
): KernelLimits {
  const resolved = { ...DEFAULT_KERNEL_LIMITS, ...limits };
  for (const [name, value] of Object.entries(resolved)) {
    if (name === 'turnDedupTombstoneRetention') continue;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1)
      throw new RangeError(
        `monument limit ${name} must be a positive integer.`,
      );
  }
  for (const rule of resolved.turnDedupTombstoneRetention)
    if (
      typeof rule.keyPrefix !== 'string' ||
      rule.keyPrefix === '' ||
      !Number.isInteger(rule.maxAgeMs) ||
      rule.maxAgeMs < 1
    )
      throw new RangeError(
        'monument limit turnDedupTombstoneRetention needs a non-empty keyPrefix and a positive integer maxAgeMs.',
      );
  return resolved;
}

function applyTurnDedup<Result>(
  tx: KernelTransaction,
  key: string,
  decision: TurnDedupDecision<Result>,
  limits: KernelLimits,
  now: number,
  prune: boolean,
): Result {
  if (decision.write.kind === 'put') tx.turnDedup.put(decision.write.record);
  else if (decision.write.kind === 'delete') tx.turnDedup.delete(key);
  if (prune) {
    // Eviction first, so its own tombstones are never older than the rule.
    tx.turnDedup.pruneResolved(limits.turnDedupMaxEntries, now);
    for (const rule of limits.turnDedupTombstoneRetention)
      tx.turnDedup.deleteTombstonesBefore(rule.keyPrefix, now - rule.maxAgeMs);
  }
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
  facts?: KernelTerminalFacts,
): KernelResults[C['type']] {
  return dispatch(command, context, tx, facts) as KernelResults[C['type']];
}

function dispatch(
  command: KernelCommand,
  context: KernelContext,
  tx: KernelTransaction,
  facts?: KernelTerminalFacts,
): KernelResults[KernelCommand['type']] {
  const limits = resolveKernelLimits(context.limits);
  // One probe per process within a command, however many rows it reads.
  const verdicts = new Map<string, OwnerLivenessVerdict>();
  const probeLiveness = context.liveness;
  context = {
    ...context,
    liveness: (owner) => {
      const key = `${owner.id}\u0000${owner.pid}\u0000${owner.identityKind === 'exact' ? owner.birth : ''}`;
      let verdict = verdicts.get(key);
      if (!verdict) {
        verdict = probeLiveness(owner);
        verdicts.set(key, verdict);
      }
      return verdict;
    },
  };
  switch (command.type) {
    case 'steerReceipts.read': {
      const row = tx.steerReceipts.get(command.threadId, command.clientInputId);
      if (!row) return { kind: 'absent' };
      return row.inputDigest === command.inputDigest &&
        row.confirmedTurnId !== null
        ? { kind: 'confirmed', turnId: row.confirmedTurnId }
        : { kind: 'indeterminate' };
    }
    case 'steerReceipts.claim': {
      if (tx.steerReceipts.get(command.threadId, command.clientInputId))
        return { kind: 'occupied' };
      tx.steerReceipts.put({
        threadId: command.threadId,
        clientInputId: command.clientInputId,
        inputDigest: command.inputDigest,
        confirmedTurnId: null,
      });
      return { kind: 'claimed' };
    }
    case 'steerReceipts.confirm': {
      const row = tx.steerReceipts.get(command.threadId, command.clientInputId);
      if (
        !row ||
        row.inputDigest !== command.inputDigest ||
        row.confirmedTurnId !== null
      )
        return { kind: 'stale' };
      tx.steerReceipts.put({
        ...row,
        confirmedTurnId: command.confirmedTurnId,
      });
      return { kind: 'applied' };
    }
    case 'steerReceipts.forgetThread':
      return {
        kind: 'applied',
        removed: tx.steerReceipts.deleteThread(command.threadId),
      };

    case 'turnDedup.claim': {
      const decision = decideTurnDedupClaim(
        tx.turnDedup.get(command.key),
        command,
        context.liveness,
        tx.turnDedup.expiredAt(command.key) !== undefined,
      );
      // A tombstone is final: an expired claim touches nothing at all.
      return applyTurnDedup(
        tx,
        command.key,
        decision,
        limits,
        command.now,
        decision.result.kind !== 'expired',
      );
    }
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
        command.now,
        decision.result.kind === 'applied',
      );
    }
    case 'turnDedup.resolve':
      return applyTurnDedup(
        tx,
        command.key,
        decideTurnDedupResolve(tx.turnDedup.get(command.key), command),
        limits,
        command.now,
        true,
      );
    case 'turnDedup.release':
      return applyTurnDedup(
        tx,
        command.key,
        decideTurnDedupRelease(tx.turnDedup.get(command.key), command),
        limits,
        command.now,
        true,
      );
    case 'turnDedup.read': {
      const record = tx.turnDedup.get(command.key);
      if (record) return { kind: 'found', record };
      const expiredAt = tx.turnDedup.expiredAt(command.key);
      return expiredAt === undefined
        ? { kind: 'absent' }
        : { kind: 'expired', expiredAt };
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
    case 'turnBoundary.prepare':
    case 'turnBoundary.beginInvocation':
    case 'turnBoundary.resumePrepared': {
      const current = tx.turnBoundary.get(command.boundaryId);
      const key = command.intent.dedupKey;
      const dedup = key === undefined ? undefined : tx.turnDedup.get(key);
      const tombstoned =
        key !== undefined && tx.turnDedup.expiredAt(key) !== undefined;
      const decision =
        command.type === 'turnBoundary.prepare'
          ? decideTurnBoundaryPrepare(current, dedup, tombstoned, command)
          : command.type === 'turnBoundary.beginInvocation'
            ? decideTurnBoundaryBeginInvocation(
                current,
                dedup,
                tombstoned,
                command,
              )
            : decideTurnBoundaryResumePrepared(
                current,
                dedup,
                tombstoned,
                command,
                context.liveness,
              );
      // Both writes belong to this command's transaction. Never call a second command here.
      if (decision.dedupPut) tx.turnDedup.put(decision.dedupPut);
      if (decision.put) tx.turnBoundary.put(decision.put);
      return decision.result;
    }
    case 'turnBoundary.cancelPrepared':
    case 'turnBoundary.recordDefinitiveRefusal': {
      const key = command.intent.dedupKey;
      const decision = decidePreparedTurnSettlement(
        tx.turnBoundary.get(command.boundaryId),
        key === undefined ? undefined : tx.turnDedup.get(key),
        key !== undefined && tx.turnDedup.expiredAt(key) !== undefined,
        command,
      );
      if (decision.dedupPut) tx.turnDedup.put(decision.dedupPut);
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
    case 'turnBoundary.acceptInvocation': {
      assertAcceptInvocationCommand(command);
      const expected = command.expected;
      const source = facts?.invocationTerminals;
      const current = tx.turnBoundary.get(expected.boundaryId);
      const witness = current
        ? undefined
        : source
          ? source.readRetirement(expected.threadId, expected.boundaryId)
          : tx.turnTerminals.readRetirement(
              expected.threadId,
              expected.boundaryId,
            );
      if (witness) assertInvocationTerminalRetirement(witness);
      const target = current ?? witness?.boundary;
      const query = target && acceptanceQuery(target, command, witness);
      if (query) assertInvocationTerminalQuery(query);
      let terminal = query
        ? source
          ? source.find(query)
          : tx.turnTerminals.findInvocation(query)
        : ({ kind: 'absent' } as const);
      if (query) assertInvocationTerminalRead(terminal, query);
      terminal = structuredClone(terminal);
      const key = expected.intent?.dedupKey;
      const decision = decideTurnBoundaryAcceptInvocation(
        current,
        tx.turnBoundary.listThread(expected.threadId),
        key === undefined ? undefined : tx.turnDedup.get(key),
        key !== undefined && tx.turnDedup.expiredAt(key) !== undefined,
        terminal,
        witness,
        command,
      );
      if (decision.retirement) {
        if (source) {
          const result = source.recordRetirement(decision.retirement);
          if (result !== undefined)
            throw new TypeError(
              'Retirement writes must be synchronous and return void.',
            );
        } else tx.turnTerminals.recordRetirement(decision.retirement);
      }
      if (decision.remove) tx.turnBoundary.delete(decision.remove);
      if (decision.put) tx.turnBoundary.put(decision.put);
      return decision.result;
    }
    case 'turnBoundary.transition': {
      const current = tx.turnBoundary.get(command.boundaryId);
      if (current?.intent !== undefined && command.to === 'accepted')
        return { kind: 'stale' };
      const collision = turnBoundaryAcceptCollides(
        current,
        command,
        current ? tx.turnBoundary.listThread(current.threadId) : [],
        current !== undefined &&
          command.providerTurnId !== undefined &&
          (facts
            ? facts.terminalSeen(current.threadId, command.providerTurnId)
            : tx.turnTerminals.has(current.threadId, command.providerTurnId)),
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
      const source = facts?.invocationTerminals;
      const ordinary =
        command.invocationId !== undefined && !command.sessionTerminal;
      let asserted: InvocationTerminalFact | undefined;
      if (ordinary) {
        asserted = {
          threadId: command.threadId,
          invocationId: command.invocationId!,
          terminalEventId: command.terminalEventId!,
          terminalCreatedAt: command.terminalCreatedAt,
          retire: command.retire ?? true,
          ...(command.providerTurnId === undefined
            ? {}
            : { providerTurnId: command.providerTurnId }),
        };
        assertInvocationTerminalFact(asserted);
        if (!facts) tx.turnTerminals.addInvocation(asserted);
        else if (source) {
          const observed = source.readObservation(
            asserted.threadId,
            asserted.terminalEventId,
          );
          if (observed === undefined)
            throw new TypeError('Observed invocation terminal is unavailable.');
          assertInvocationTerminalFact(observed);
          if (!sameTerminalData(observed, asserted))
            throw new TypeError(
              'Observed invocation terminal differs from retained event.',
            );
        }
      }
      if (command.providerTurnId !== undefined && !facts)
        tx.turnTerminals.add(command.threadId, command.providerTurnId);
      const rows = tx.turnBoundary.listThread(command.threadId);
      const reads = ordinary
        ? rows
            .filter((row) => row.intent?.invocationId === command.invocationId)
            .map((row) => {
              const query = {
                threadId: row.threadId,
                invocationId: command.invocationId!,
                ...(row.providerTurnId === undefined
                  ? {}
                  : { providerTurnId: row.providerTurnId }),
                allowMissingProviderTurnId: row.providerTurnId === undefined,
                terminalEventId: command.terminalEventId!,
              };
              assertInvocationTerminalQuery(query);
              const read = source
                ? source.find(query)
                : tx.turnTerminals.findInvocation(query);
              assertInvocationTerminalRead(read, query);
              if (
                read.kind === 'found' &&
                !sameTerminalData(read.fact, asserted)
              )
                throw new TypeError(
                  'Observed invocation terminal differs from retained event.',
                );
              const key = row.intent?.dedupKey;
              const dedup =
                key === undefined ? undefined : tx.turnDedup.get(key);
              return {
                boundaryId: row.boundaryId,
                read,
                ...(dedup ? { dedup } : {}),
              };
            })
        : [];
      const decision = decideTurnBoundaryObserveTerminal(
        rows,
        command,
        command.sessionTerminal
          ? facts?.terminalSequence?.(command.threadId, command.terminalEventId)
          : undefined,
        reads,
      );
      for (const witness of decision.retirements) {
        if (source) {
          const result = source.recordRetirement(witness);
          if (result !== undefined)
            throw new TypeError(
              'Retirement writes must be synchronous and return void.',
            );
        } else tx.turnTerminals.recordRetirement(witness);
      }
      for (const boundaryId of decision.retire)
        tx.turnBoundary.delete(boundaryId);
      return { kind: 'applied' };
    }
    case 'turnBoundary.hasPossibleEffect': {
      const retired = new Set(facts?.retiredBoundaryIds?.(command.threadId));
      const rows = tx.turnBoundary.listThread(command.threadId);
      return {
        kind: 'available',
        active: rows.some((row) => {
          if (
            row.state === 'lifecycle' ||
            row.state === 'settled' ||
            retired.has(row.boundaryId)
          )
            return false;
          if (!row.intent) return true;
          const query = {
            threadId: row.threadId,
            invocationId: row.intent.invocationId,
            ...(row.providerTurnId === undefined
              ? {}
              : { providerTurnId: row.providerTurnId }),
            allowMissingProviderTurnId: row.providerTurnId === undefined,
          };
          const read = facts?.invocationTerminals
            ? facts.invocationTerminals.find(query)
            : facts
              ? { kind: 'unknown' as const }
              : tx.turnTerminals.findInvocation(query);
          assertInvocationTerminalRead(read, query);
          if (read.kind !== 'found') return true;
          // Projection uses the retirement decision without recording its witness.
          return !decideTurnBoundaryObserveTerminal(
            [row],
            {
              type: 'turnBoundary.observeTerminal',
              ...read.fact,
              sessionTerminal: false,
            },
            undefined,
            [{ boundaryId: row.boundaryId, read }],
          ).retire.includes(row.boundaryId);
        }),
      };
    }
    case 'turnBoundary.list':
      return { kind: 'records', records: tx.turnBoundary.listAll() };
    case 'turnBoundary.reconcile': {
      const decision = decideTurnBoundaryReconcile(
        tx.turnBoundary.listAll(),
        command.observed,
        command.now,
      );
      for (const boundaryId of decision.remove)
        tx.turnBoundary.delete(boundaryId);
      for (const record of decision.put) tx.turnBoundary.put(record);
      return {
        kind: 'reconciled',
        interrupted: decision.interrupted,
        resumable: decision.resumable,
      };
    }
    case 'turnBoundary.forgetThread': {
      for (const row of tx.turnBoundary.listThread(command.threadId))
        if (row.state !== 'lifecycle') tx.turnBoundary.delete(row.boundaryId);
      // Terminal facts retire with the thread's boundaries (see README).
      if (!facts) tx.turnTerminals.deleteThread(command.threadId);
      return { kind: 'applied' };
    }

    case 'requestKeys.claim': {
      // station#3559: the purge forgets completed rows only. An unresolved
      // claim may have had its effect, so a late retry must re-drive it. Past
      // the TTL it stays but stops holding a quota slot (station#3606), or a
      // claim that can never resolve would lock its caller out for good.
      const cutoff = command.now - limits.requestKeyTtlMs;
      tx.requestKeys.deleteCompletedCreatedBefore(cutoff);
      const existing = tx.requestKeys.get(command.id);
      const decision = decideRequestKeyClaim({
        existing,
        digest: command.digest,
        callerRows: existing
          ? 0
          : tx.requestKeys.countCaller(command.id.callerSessionId, cutoff),
        callerCompletedRows: existing
          ? 0
          : tx.requestKeys.countCallerCompleted(command.id.callerSessionId),
        allRows: existing ? 0 : tx.requestKeys.countAll(cutoff),
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

    case 'inbox.submit': {
      tx.inbox.deleteSettledBefore(
        command.inboxId,
        command.now - limits.inboxSettledRetentionMs,
      );
      const decision = decideInboxSubmit(
        {
          existing: tx.inbox.get(command.inboxId, command.key),
          entries: tx.inbox.listInbox(command.inboxId),
          maxUnsettled: limits.inboxMaxUnsettled,
        },
        command,
      );
      if (decision.put) tx.inbox.put(decision.put);
      return decision.result;
    }
    case 'inbox.claimNext': {
      const decision = decideInboxClaimNext(
        tx.inbox.listInbox(command.inboxId),
        command,
      );
      if (decision.put) tx.inbox.put(decision.put);
      return decision.result;
    }
    case 'inbox.settle': {
      const decision = decideInboxSettle(
        tx.inbox.get(command.inboxId, command.key),
        command,
      );
      if (decision.put) tx.inbox.put(decision.put);
      return decision.result;
    }
    case 'inbox.release': {
      const decision = decideInboxRelease(
        tx.inbox.get(command.inboxId, command.key),
        command,
      );
      if (decision.put) tx.inbox.put(decision.put);
      return decision.result;
    }
    case 'inbox.resolveUnconfirmed': {
      const decision = decideInboxResolveUnconfirmed(
        tx.inbox.get(command.inboxId, command.key),
        command,
      );
      if (decision.put) tx.inbox.put(decision.put);
      return decision.result;
    }
    case 'inbox.cancel': {
      const decision = decideInboxCancel(
        tx.inbox.get(command.inboxId, command.key),
        command,
      );
      if (decision.put) tx.inbox.put(decision.put);
      return decision.result;
    }
    case 'inbox.read': {
      const entry = tx.inbox.get(command.inboxId, command.key);
      return entry ? { kind: 'found', entry } : { kind: 'absent' };
    }
    case 'inbox.list':
      return { kind: 'entries', entries: tx.inbox.listInbox(command.inboxId) };
    case 'inbox.listOpen':
      return { kind: 'entries', entries: tx.inbox.listOpen() };
    case 'inbox.forget':
      return {
        kind: 'applied',
        removed: tx.inbox.deleteInbox(command.inboxId),
      };
  }
}

/**
 * Whether each command type only reads. A record, not a set, so adding a
 * command type does not compile until someone decides which it is.
 */
export const KERNEL_COMMAND_READ_ONLY: Readonly<
  Record<KernelCommand['type'], boolean>
> = Object.freeze({
  'turnDedup.claim': false,
  'turnDedup.beginInvocation': false,
  'turnDedup.resolve': false,
  'turnDedup.release': false,
  'turnDedup.read': true,
  'turnDedup.forgetPrefix': false,
  'turnBoundary.create': false,
  'turnBoundary.prepare': false,
  'turnBoundary.beginInvocation': false,
  'turnBoundary.resumePrepared': false,
  'turnBoundary.cancelPrepared': false,
  'turnBoundary.recordDefinitiveRefusal': false,
  'turnBoundary.acceptInvocation': false,
  'turnBoundary.transition': false,
  'turnBoundary.remove': false,
  'turnBoundary.recordAccepted': false,
  'turnBoundary.observeTerminal': false,
  'turnBoundary.hasPossibleEffect': true,
  'turnBoundary.list': true,
  'turnBoundary.reconcile': false,
  'turnBoundary.forgetThread': false,
  'requestKeys.claim': false,
  'requestKeys.recordDecision': false,
  'requestKeys.complete': false,
  'requestKeys.release': false,
  'steerReceipts.read': true,
  'steerReceipts.claim': false,
  'steerReceipts.confirm': false,
  'steerReceipts.forgetThread': false,
  'inbox.submit': false,
  'inbox.claimNext': false,
  'inbox.settle': false,
  'inbox.release': false,
  'inbox.cancel': false,
  'inbox.read': true,
  'inbox.list': true,
  'inbox.listOpen': true,
  'inbox.forget': false,
  'inbox.resolveUnconfirmed': false,
});

/** Commands that write nothing, whatever their result. */
export function isReadOnlyKernelCommand(command: KernelCommand): boolean {
  return KERNEL_COMMAND_READ_ONLY[command.type];
}

/**
 * A participant's refusal, as opposed to a kernel answer that happens to be
 * named `refused` (`turnDedup.beginInvocation`). Only the former may make an
 * adapter roll back.
 */
export function isParticipantRefusal(
  result: KernelResult<KernelCommand>,
): result is ParticipantRefusal {
  return result.kind === 'refused' && 'participant' in result;
}

/**
 * What every adapter runs inside its transaction: participant admission, the
 * command, then participant commits. A read-only command involves only the
 * participants that set `observeReads`.
 *
 * The adapter must roll the whole transaction back when this throws, and
 * also when it returns a participant refusal ({@link isParticipantRefusal}):
 * an earlier participant's `admit` may already have written through the host
 * handle. A kernel answer of `refused` is an ordinary result and commits.
 */
export function runKernelTransactionStep<C extends KernelCommand, Host>(
  command: C,
  context: KernelContext,
  tx: KernelTransaction,
  participants: readonly CommitParticipant<Host>[],
  host: Host,
  facts?: KernelTerminalFacts,
): KernelResult<C> {
  switch (command.type) {
    case 'steerReceipts.read':
    case 'steerReceipts.claim':
    case 'steerReceipts.confirm':
      assertSteerReceiptText(command.threadId);
      assertSteerReceiptText(command.clientInputId);
      assertSteerReceiptText(command.inputDigest);
      if (command.type === 'steerReceipts.confirm')
        assertSteerReceiptText(command.confirmedTurnId);
      break;
    case 'steerReceipts.forgetThread':
      assertSteerReceiptText(command.threadId);
      break;
  }
  if (command.type === 'turnBoundary.acceptInvocation')
    assertAcceptInvocationCommand(command);
  if (
    command.type === 'turnBoundary.observeTerminal' &&
    'invocationId' in command
  ) {
    if (
      !terminalDataObject(
        command,
        [
          'type',
          'threadId',
          'invocationId',
          'sessionTerminal',
          'terminalCreatedAt',
        ],
        ['providerTurnId', 'terminalEventId', 'retire'],
      ) ||
      typeof command.invocationId !== 'string' ||
      command.invocationId === '' ||
      typeof command.sessionTerminal !== 'boolean' ||
      (Object.hasOwn(command, 'retire') && typeof command.retire !== 'boolean')
    )
      throw new TypeError('Invalid invocation terminal observation.');
    assertInvocationTerminalQuery({
      threadId: command.threadId,
      invocationId: command.invocationId,
      allowMissingProviderTurnId: true,
      ...(Object.hasOwn(command, 'providerTurnId')
        ? { providerTurnId: command.providerTurnId }
        : {}),
      ...(Object.hasOwn(command, 'terminalEventId')
        ? { terminalEventId: command.terminalEventId }
        : {}),
    });
    if (
      typeof command.terminalCreatedAt !== 'string' ||
      command.terminalCreatedAt === ''
    )
      throw new TypeError('Invalid invocation terminal time.');
    if (!command.sessionTerminal)
      assertInvocationTerminalFact({
        threadId: command.threadId,
        invocationId: command.invocationId,
        terminalEventId: command.terminalEventId,
        terminalCreatedAt: command.terminalCreatedAt,
        retire: command.retire ?? true,
        ...(Object.hasOwn(command, 'providerTurnId')
          ? { providerTurnId: command.providerTurnId }
          : {}),
      });
  }
  if (
    facts &&
    (command.type === 'turnBoundary.acceptInvocation' ||
      (command.type === 'turnBoundary.observeTerminal' &&
        'invocationId' in command))
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(
      facts,
      'invocationTerminals',
    );
    if (
      !descriptor ||
      !Object.hasOwn(descriptor, 'value') ||
      !isSynchronousTerminalBundle(descriptor.value)
    )
      throw new TypeError(
        'Invocation terminals require an own synchronous source bundle.',
      );
  }
  if (
    command.type === 'turnBoundary.acceptInvocation' ||
    (command.type === 'turnBoundary.observeTerminal' &&
      'invocationId' in command)
  )
    command = structuredClone(command);
  const readOnly = isReadOnlyKernelCommand(command);
  const joined = readOnly
    ? participants.filter((participant) => participant.observeReads)
    : participants;
  for (const participant of joined) {
    const verdict = participant.admit?.(command, host);
    if (verdict)
      return {
        kind: 'refused',
        participant: participant.name,
        reason: verdict.refuse,
      } satisfies ParticipantRefusal;
  }
  const result = runKernelCommand(command, context, tx, facts);
  for (const participant of joined)
    participant.commit?.({ command, result }, host);
  return result;
}

import { compareCodePoints } from './decisions/order.js';
import {
  decideRecoveryArm,
  decideRecoveryStorageGuard,
  type RecoveryGuardRow,
  recoveryGuardPlan,
} from './decisions/recovery-storage.js';
import type {
  RecoveryIntentInput,
  RecoveryOwner,
  RecoveryTransition,
} from './recovery-ledger.js';
import type {
  RecoveryExecuteOptions,
  RecoverySqlIntent,
  RecoveryStorageCommand,
  RecoveryStoragePort,
  RecoveryStorageResult,
} from './sqlite-recovery.js';

type Row<I> = {
  intent: I;
  dueAt: string | null;
  resumedTurnId: string | null;
  outcomeReason: string | null;
  attemptId?: string;
  correlationId?: string;
  owner?: RecoveryOwner;
  credentialAttemptId?: string;
  shutdownAt?: string;
};

const applied = (): RecoveryTransition => ({ kind: 'applied' });
const stale = (): RecoveryTransition => ({ kind: 'stale' });
const countResult = (count: number): RecoveryTransition =>
  count === 1 ? applied() : stale();

/** The committed image survives closing and reopening an in-memory adapter. */
export class MemoryRecoveryVolume<I extends RecoverySqlIntent> {
  readonly #rows = new Map<string, Row<I>>();
  #inFlight = false;
  static open<I extends RecoverySqlIntent, P, Reason extends string>(options: {
    volume: MemoryRecoveryVolume<I>;
    makeIntent(input: RecoveryIntentInput<I>): I;
    updateIntent(intent: I, changes: Partial<RecoverySqlIntent>): I;
    project(intent: I): P;
    sourceTerminated(intent: I): boolean;
    beforeCommit?: () => void;
  }): RecoveryStoragePort<I, P, Reason> {
    const executeSync = <C extends RecoveryStorageCommand<I, P, Reason>>(
      command: C,
      executeOptions: RecoveryExecuteOptions = {},
    ): RecoveryStorageResult<I, P, Reason, C> => {
      if (executeOptions.withinHostTransaction)
        throw new Error('Memory recovery storage has no host transaction.');
      if (options.volume.#inFlight)
        throw new Error(
          'Recovery storage cannot enter an existing transaction.',
        );
      options.volume.#inFlight = true;
      try {
        const rows = structuredClone(options.volume.#rows);
        const view = (row: Row<I>): I => ({
          ...structuredClone(row.intent),
          ...(row.attemptId ? { dispatchAttemptId: row.attemptId } : {}),
          ...(row.correlationId
            ? { recoveryCorrelationId: row.correlationId }
            : {}),
        });
        const update = (row: Row<I>, changes: Partial<RecoverySqlIntent>) => {
          const next = structuredClone(
            options.updateIntent(row.intent, changes),
          );
          for (const [key, value] of Object.entries(next))
            if (value === undefined) Reflect.deleteProperty(next, key);
          row.intent = next;
        };
        const find = (fingerprint: string) => rows.get(fingerprint);
        const terminal = (row: Row<I>) =>
          row.shutdownAt !== undefined ||
          options.sourceTerminated(structuredClone(row.intent));
        const ordered = (
          a: string | null | undefined,
          b: string | null | undefined,
        ) =>
          a == null
            ? b == null
              ? 0
              : -1
            : b == null
              ? 1
              : compareCodePoints(a, b);
        const values = () => [...rows.values()];
        let result: unknown;
        let readOnly = false;
        const plan = recoveryGuardPlan(command);
        const candidates = plan
          ? plan.key === undefined
            ? values()
            : values().filter((row) =>
                plan.column === 'fingerprint'
                  ? row.intent.fingerprint === plan.key
                  : row.correlationId === plan.key,
              )
          : [];
        const guardRow = (row: Row<I>): RecoveryGuardRow => ({
          outcome: row.intent.outcome,
          attempts: row.intent.attempts,
          maxAttempts: row.intent.maxAttempts,
          dueAt: row.dueAt,
          usageLimit: row.intent.usageLimit === true,
          decision: row.intent.decision,
          settlement: row.intent.dispatchSettlement ?? null,
          kind: row.intent.dispatchKind ?? null,
          attemptId: row.attemptId ?? null,
          correlationId: row.correlationId ?? null,
          ownerId: row.owner?.id ?? null,
          ownerPid: row.owner?.pid ?? null,
          credentialAttemptId: row.credentialAttemptId ?? null,
          sourceTerminated: plan?.source === true && terminal(row),
        });
        const allowed =
          !plan ||
          candidates.some((row) =>
            decideRecoveryStorageGuard(plan.decision, guardRow(row)),
          );
        if (plan && !allowed) {
          result = plan.refused === 'null' ? null : stale();
        } else
          switch (command.type) {
            case 'armRecoveryIntent': {
              const [input] = command.args;
              let row = find(input.fingerprint);
              if (decideRecoveryArm(row !== undefined) === 'create') {
                row = {
                  intent: structuredClone(
                    options.makeIntent(structuredClone(input)),
                  ),
                  dueAt: input.dueAt ?? null,
                  resumedTurnId: null,
                  outcomeReason: null,
                };
                rows.set(input.fingerprint, row);
              }
              if (!row)
                throw new Error('Recovery arm decision lost its record.');
              result = view(row);
              break;
            }
            case 'findRecoveryIntent': {
              readOnly = true;
              const row = find(command.args[0]);
              result = row ? view(row) : null;
              break;
            }
            case 'readRecoveryProjection': {
              readOnly = true;
              const row = values()
                .reverse()
                .filter((entry) => entry.intent.threadId === command.args[0])
                .sort((a, b) => ordered(b.intent.updatedAt, a.intent.updatedAt))
                .at(0);
              result = row ? options.project(view(row)) : undefined;
              break;
            }
            case 'readPendingRecoveryIntents': {
              readOnly = true;
              result = values()
                .filter(
                  (row) =>
                    row.intent.outcome === 'armed' ||
                    row.intent.outcome === 'resumed',
                )
                .sort(
                  (a, b) =>
                    ordered(a.dueAt, b.dueAt) ||
                    ordered(a.intent.createdAt, b.intent.createdAt),
                )
                .map(view);
              break;
            }
            case 'readUsageLimitIntentsAwaitingUser': {
              readOnly = true;
              result = values()
                .filter(
                  (row) =>
                    row.intent.outcome === 'manual' &&
                    row.intent.usageLimit &&
                    row.attemptId === undefined &&
                    row.correlationId === undefined,
                )
                .sort((a, b) => ordered(a.intent.updatedAt, b.intent.updatedAt))
                .map(view);
              break;
            }
            case 'readRecoveryCompensationSnapshot': {
              readOnly = true;
              result = values()
                .filter((row) => row.intent.outcome === 'compensation-required')
                .sort(
                  (a, b) =>
                    ordered(a.intent.updatedAt, b.intent.updatedAt) ||
                    ordered(a.intent.createdAt, b.intent.createdAt),
                )
                .map(view);
              break;
            }
            case 'claimRecoveryDispatch': {
              const [input] = command.args;
              const row = find(input.fingerprint);
              if (!row) throw new Error('Recovery guard lost its record.');
              row.attemptId = input.dispatchAttemptId;
              row.correlationId = input.recoveryCorrelationId;
              row.owner = structuredClone(input.owner);
              row.outcomeReason = null;
              update(row, {
                outcome: 'resumed',
                attempts: row.intent.attempts + 1,
                outcomeReason: undefined,
                dispatchSettlement: 'prepared',
                dispatchKind: input.kind,
                updatedAt: input.now,
              });
              result = view(row);
              break;
            }
            case 'releaseRecoveryDispatch': {
              const [input] = command.args;
              const row = find(input.fingerprint);
              if (!row) throw new Error('Recovery guard lost its record.');
              row.attemptId = undefined;
              row.correlationId = undefined;
              row.owner = undefined;
              row.credentialAttemptId = undefined;
              update(row, {
                outcome: input.outcome,
                attempts: Math.max(row.intent.attempts - 1, 0),
                dispatchSettlement: undefined,
                dispatchKind: undefined,
                updatedAt: input.now,
              });
              result = applied();
              break;
            }
            case 'acceptRecoveryDispatch': {
              const [input] = command.args;
              const row = find(input.fingerprint);
              if (!row) throw new Error('Recovery guard lost its record.');
              row.resumedTurnId ??= input.turnId;
              update(row, {
                resumedTurnId: row.resumedTurnId,
                dispatchSettlement: 'accepted',
                updatedAt: input.now,
              });
              result = applied();
              break;
            }
            case 'observeRecoveryDispatchCorrelation': {
              const [, turnId, now] = command.args;
              if (!plan) throw new Error('Missing recovery guard.');
              const matched = candidates.filter((row) =>
                decideRecoveryStorageGuard(plan.decision, guardRow(row)),
              );
              const first = matched[0];
              if (!first) throw new Error('Recovery guard lost its record.');
              for (const row of matched) {
                row.resumedTurnId ??= turnId;
                update(row, {
                  resumedTurnId: row.resumedTurnId,
                  updatedAt: now,
                });
              }
              result = view(first);
              break;
            }
            case 'markRecoveryDispatchIndeterminate': {
              const [fingerprint, , now] = command.args;
              const row = find(fingerprint);
              if (!row) throw new Error('Recovery guard lost its record.');
              update(row, { outcome: 'indeterminate', updatedAt: now });
              result = applied();
              break;
            }
            case 'linkRecoveryCredentialAttempt': {
              const [input] = command.args;
              const row = find(input.fingerprint);
              if (!row) throw new Error('Recovery guard lost its record.');
              row.credentialAttemptId = input.credentialAttemptId;
              update(row, { updatedAt: input.now });
              result = applied();
              break;
            }
            case 'preparedRecoveryDispatches': {
              readOnly = true;
              const [kind, unlinkedOnly = false] = command.args;
              result = values()
                .filter((row) => {
                  const state =
                    (row.intent.outcome === 'resumed' &&
                      (row.intent.dispatchSettlement === 'prepared' ||
                        row.intent.dispatchSettlement === 'accepted')) ||
                    (row.intent.outcome === 'succeeded' &&
                      row.credentialAttemptId !== undefined) ||
                    (row.intent.outcome === 'indeterminate' &&
                      (row.credentialAttemptId !== undefined || unlinkedOnly));
                  return (
                    state &&
                    (!kind || row.intent.dispatchKind === kind) &&
                    (!unlinkedOnly || row.credentialAttemptId === undefined) &&
                    ((row.attemptId !== undefined &&
                      row.correlationId !== undefined) ||
                      (unlinkedOnly &&
                        row.intent.outcome === 'indeterminate' &&
                        row.credentialAttemptId === undefined))
                  );
                })
                .sort(
                  (a, b) =>
                    ordered(a.intent.updatedAt, b.intent.updatedAt) ||
                    ordered(a.intent.createdAt, b.intent.createdAt),
                )
                .map((row) => ({
                  intent: view(row),
                  ownerId: row.owner?.id ?? null,
                  ownerPid: row.owner?.pid ?? null,
                  ownerBirth:
                    row.owner?.identityKind === 'exact'
                      ? row.owner.birth
                      : null,
                  ownerIdentityKind: row.owner?.identityKind ?? null,
                  credentialAttemptId: row.credentialAttemptId ?? null,
                }));
              break;
            }
            case 'indeterminatePreparedRecoveryDispatch': {
              const [input] = command.args;
              const row = find(input.fingerprint);
              if (!row) throw new Error('Recovery guard lost its record.');
              update(row, { outcome: 'indeterminate', updatedAt: input.now });
              result = view(row);
              break;
            }
            case 'recordRecoveryTerminal': {
              const [fingerprint, outcome, now] = command.args;
              const row = find(fingerprint);
              if (!row) throw new Error('Recovery guard lost its record.');
              update(row, { outcome, updatedAt: now });
              result = applied();
              break;
            }
            case 'markRecoveryCompensation': {
              const [fingerprint, now] = command.args;
              const row = find(fingerprint);
              if (!row) throw new Error('Recovery guard lost its record.');
              update(row, { outcome: 'compensation-required', updatedAt: now });
              result = applied();
              break;
            }
            case 'resolveRecoveryCompensationRecord': {
              const [fingerprint, now] = command.args;
              const row = find(fingerprint);
              if (!row) throw new Error('Recovery guard lost its record.');
              update(row, { outcome: 'failed', updatedAt: now });
              result = applied();
              break;
            }
            case 'cancelRecovery': {
              const [fingerprint, now, reason] = command.args;
              const row = find(fingerprint);
              if (!row) throw new Error('Recovery guard lost its record.');
              row.outcomeReason = reason ?? row.outcomeReason;
              update(row, {
                outcome: 'canceled',
                outcomeReason: row.outcomeReason ?? undefined,
                updatedAt: now,
              });
              result = applied();
              break;
            }
            case 'retireWaitingRecovery': {
              const [input] = command.args;
              const row = find(input.fingerprint);
              if (!row) throw new Error('Recovery guard lost its record.');
              row.outcomeReason = input.reason;
              update(row, {
                outcome: input.outcome,
                outcomeReason: input.reason,
                updatedAt: input.now,
              });
              result = applied();
              break;
            }
            case 'cancelSourceTerminatedRecoveries': {
              const [now] = command.args;
              let count = 0;
              if (!plan) throw new Error('Missing recovery guard.');
              for (const row of values())
                if (decideRecoveryStorageGuard(plan.decision, guardRow(row))) {
                  update(row, { outcome: 'canceled', updatedAt: now });
                  count++;
                }
              result = countResult(count);
              break;
            }
            case 'cancelRecoveryIfSourceTerminated': {
              const [fingerprint, now] = command.args;
              const row = find(fingerprint);
              if (!row) throw new Error('Recovery guard lost its record.');
              update(row, { outcome: 'canceled', updatedAt: now });
              result = applied();
              break;
            }
            case 'cancelShutdownRecoveries': {
              const [now] = command.args;
              let count = 0;
              if (!plan) throw new Error('Missing recovery guard.');
              for (const row of values()) {
                if (!decideRecoveryStorageGuard(plan.decision, guardRow(row)))
                  continue;
                row.shutdownAt = now;
                update(row, { updatedAt: now });
                count++;
              }
              result = countResult(count);
              break;
            }
            default:
              throw new Error('Unknown recovery storage command.');
          }
        if (!readOnly) options.beforeCommit?.();
        if (!readOnly) {
          options.volume.#rows.clear();
          for (const [key, row] of rows) options.volume.#rows.set(key, row);
        }
        return result as RecoveryStorageResult<I, P, Reason, C>;
      } finally {
        options.volume.#inFlight = false;
      }
    };
    return Object.freeze({
      executeSync,
      execute: async <C extends RecoveryStorageCommand<I, P, Reason>>(
        command: C,
      ) => executeSync(command),
    });
  }
}

/** Open an independent handle on the same committed image. */
export function openMemoryRecoveryStorage<
  I extends RecoverySqlIntent,
  P,
  Reason extends string,
>(
  options: Parameters<typeof MemoryRecoveryVolume.open<I, P, Reason>>[0],
): RecoveryStoragePort<I, P, Reason> {
  return MemoryRecoveryVolume.open(options);
}

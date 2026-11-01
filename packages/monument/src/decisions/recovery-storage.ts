import type {
  RecoverySqlIntent,
  RecoveryStorageCommand,
} from '../sqlite-recovery.js';
import { compareCodePoints } from './order.js';

/** The preimage a recovery mutation is allowed to inspect. */
export interface RecoveryGuardRow {
  readonly outcome: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly dueAt: string | null;
  readonly usageLimit: boolean;
  readonly decision: string;
  readonly settlement: string | null;
  readonly kind: string | null;
  readonly attemptId: string | null;
  readonly correlationId: string | null;
  readonly ownerId: string | null;
  readonly ownerPid: number | null;
  readonly credentialAttemptId: string | null;
  readonly sourceTerminated: boolean;
}

type Claim = {
  fingerprint: string;
  kind: 'due' | 'profile';
  immediate?: boolean;
  now: string;
};
type Attempt = { fingerprint: string; dispatchAttemptId: string };
type Fence = Attempt & {
  recoveryCorrelationId: string;
  ownerId: string | null;
  ownerPid: number | null;
};
type Link = Attempt & { credentialAttemptId: string };
export type RecoveryGuardCommand =
  | { type: 'claimRecoveryDispatch'; input: Claim }
  | {
      type: 'releaseRecoveryDispatch' | 'acceptRecoveryDispatch';
      input: Attempt;
    }
  | { type: 'observeRecoveryDispatchCorrelation'; correlationId: string }
  | { type: 'markRecoveryDispatchIndeterminate'; attemptId: string }
  | { type: 'linkRecoveryCredentialAttempt'; input: Link }
  | { type: 'indeterminatePreparedRecoveryDispatch'; input: Fence }
  | {
      type: 'recordRecoveryTerminal';
      outcome: 'succeeded' | 'failed' | 'canceled';
    }
  | {
      type: 'markRecoveryCompensation';
      expectedOutcome: 'resumed' | 'canceled' | 'indeterminate';
    }
  | {
      type:
        | 'resolveRecoveryCompensationRecord'
        | 'cancelRecovery'
        | 'retireWaitingRecovery'
        | 'cancelSourceTerminatedRecoveries'
        | 'cancelRecoveryIfSourceTerminated'
        | 'cancelShutdownRecoveries';
    };

/** A fingerprint names its first durable intent; later arms replay it. */
export function decideRecoveryArm(exists: boolean): 'existing' | 'create' {
  return exists ? 'existing' : 'create';
}

/** Pure admission decision; SQLite still applies an exact guarded write under its lock. */
export function decideRecoveryStorageGuard(
  command: RecoveryGuardCommand,
  row: RecoveryGuardRow | undefined,
): boolean {
  if (!row) return false;
  const pending =
    row.outcome === 'armed' ||
    row.outcome === 'resumed' ||
    row.outcome === 'manual';
  const prepared = row.outcome === 'resumed' && row.settlement === 'prepared';
  switch (command.type) {
    case 'claimRecoveryDispatch': {
      const input = command.input;
      const immediate = input.kind === 'due' && input.immediate === true;
      const eligible = immediate
        ? (row.outcome === 'armed' || row.outcome === 'manual') &&
          row.usageLimit
        : input.kind === 'due'
          ? row.outcome === 'armed' &&
            row.dueAt !== null &&
            compareCodePoints(row.dueAt, input.now) <= 0
          : row.outcome === 'armed' || row.outcome === 'manual';
      return (
        eligible &&
        row.attempts < row.maxAttempts &&
        row.attemptId === null &&
        row.correlationId === null &&
        !row.sourceTerminated
      );
    }
    case 'releaseRecoveryDispatch':
    case 'acceptRecoveryDispatch':
      return prepared && row.attemptId === command.input.dispatchAttemptId;
    case 'observeRecoveryDispatchCorrelation':
      return (
        row.outcome === 'resumed' && row.correlationId === command.correlationId
      );
    case 'markRecoveryDispatchIndeterminate':
      return prepared && row.attemptId === command.attemptId;
    case 'linkRecoveryCredentialAttempt':
      return (
        prepared &&
        row.kind === 'profile' &&
        row.attemptId === command.input.dispatchAttemptId &&
        (row.credentialAttemptId === null ||
          row.credentialAttemptId === command.input.credentialAttemptId)
      );
    case 'indeterminatePreparedRecoveryDispatch':
      return (
        prepared &&
        row.attemptId === command.input.dispatchAttemptId &&
        row.correlationId === command.input.recoveryCorrelationId &&
        row.ownerId === command.input.ownerId &&
        row.ownerPid === command.input.ownerPid
      );
    case 'recordRecoveryTerminal':
      return (
        (row.outcome === 'resumed' || row.outcome === 'indeterminate') &&
        (command.outcome !== 'succeeded' ||
          (row.outcome === 'resumed' && row.settlement === 'accepted'))
      );
    case 'markRecoveryCompensation':
      return row.outcome === command.expectedOutcome;
    case 'resolveRecoveryCompensationRecord':
      return row.outcome === 'compensation-required';
    case 'cancelRecovery':
      return pending;
    case 'retireWaitingRecovery':
      return (
        (row.outcome === 'armed' ||
          (row.outcome === 'manual' && row.usageLimit)) &&
        row.attemptId === null &&
        row.correlationId === null
      );
    case 'cancelSourceTerminatedRecoveries':
    case 'cancelRecoveryIfSourceTerminated':
      return pending && row.sourceTerminated;
    case 'cancelShutdownRecoveries':
      return (
        pending &&
        !(
          row.attemptId === null &&
          row.correlationId === null &&
          row.usageLimit &&
          ((row.outcome === 'armed' && row.decision === 'wait-until-reset') ||
            row.outcome === 'manual')
        )
      );
  }
}

export interface RecoveryGuardPlan {
  readonly decision: RecoveryGuardCommand;
  readonly key?: string;
  readonly column: 'fingerprint' | 'recovery_correlation_id';
  readonly source: boolean;
  readonly refused: 'null' | 'stale';
}

/** Identify the record and pure admission decision for one command. */
export function recoveryGuardPlan<
  I extends RecoverySqlIntent,
  P,
  Reason extends string,
>(
  command: RecoveryStorageCommand<I, P, Reason>,
): RecoveryGuardPlan | undefined {
  let decision: RecoveryGuardCommand;
  let key: string | undefined;
  let column: 'fingerprint' | 'recovery_correlation_id' = 'fingerprint';
  let source = false;
  let refused: 'null' | 'stale' = 'stale';
  switch (command.type) {
    case 'claimRecoveryDispatch':
      decision = { type: command.type, input: command.args[0] };
      key = command.args[0].fingerprint;
      source = true;
      refused = 'null';
      break;
    case 'releaseRecoveryDispatch':
    case 'acceptRecoveryDispatch':
      decision = { type: command.type, input: command.args[0] };
      key = command.args[0].fingerprint;
      break;
    case 'linkRecoveryCredentialAttempt':
      decision = { type: command.type, input: command.args[0] };
      key = command.args[0].fingerprint;
      break;
    case 'indeterminatePreparedRecoveryDispatch':
      decision = { type: command.type, input: command.args[0] };
      key = command.args[0].fingerprint;
      refused = 'null';
      break;
    case 'observeRecoveryDispatchCorrelation':
      decision = { type: command.type, correlationId: command.args[0] };
      key = command.args[0];
      column = 'recovery_correlation_id';
      refused = 'null';
      break;
    case 'markRecoveryDispatchIndeterminate':
      decision = { type: command.type, attemptId: command.args[1] };
      key = command.args[0];
      break;
    case 'recordRecoveryTerminal':
      decision = { type: command.type, outcome: command.args[1] };
      key = command.args[0];
      break;
    case 'markRecoveryCompensation':
      decision = {
        type: command.type,
        expectedOutcome: command.args[2] ?? 'resumed',
      };
      key = command.args[0];
      break;
    case 'resolveRecoveryCompensationRecord':
    case 'cancelRecovery':
    case 'cancelRecoveryIfSourceTerminated':
      decision = { type: command.type };
      key = command.args[0];
      source = command.type === 'cancelRecoveryIfSourceTerminated';
      break;
    case 'retireWaitingRecovery':
      decision = { type: command.type };
      key = command.args[0].fingerprint;
      break;
    case 'cancelSourceTerminatedRecoveries':
    case 'cancelShutdownRecoveries':
      decision = { type: command.type };
      source = command.type === 'cancelSourceTerminatedRecoveries';
      break;
    default:
      return undefined;
  }
  return { decision, key, column, source, refused };
}

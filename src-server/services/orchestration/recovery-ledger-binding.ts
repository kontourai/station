import type {
  RecoveryIntentInput as KernelRecoveryIntentInput,
  RecoveryLedger as KernelRecoveryLedger,
  RecoveryLedgerCoordinator as KernelRecoveryLedgerCoordinator,
} from '@kontourai/monument/recovery';
import type {
  ConnectionRecoveryIntent,
  ConnectionRecoveryOutcomeReason,
  ConnectionRecoveryProjection,
} from '@kontourai/station-contracts/connection-recovery';

/** Station's connection recovery contract bound to the portable ledger. */
export type RecoveryIntentInput =
  KernelRecoveryIntentInput<ConnectionRecoveryIntent>;
export type RecoveryLedger = KernelRecoveryLedger<
  ConnectionRecoveryIntent,
  ConnectionRecoveryProjection,
  ConnectionRecoveryOutcomeReason
>;
export type RecoveryLedgerCoordinator = KernelRecoveryLedgerCoordinator<
  ConnectionRecoveryIntent,
  ConnectionRecoveryProjection,
  ConnectionRecoveryOutcomeReason
>;

/**
 * @kontourai/monument: an experimental, engine-neutral durability kernel.
 *
 * The portable port is {@link KernelStorage}: one `execute` call is one
 * atomic command. The decisions are pure functions over the records a
 * command reads; adapters run them inside their own transaction. This entry
 * has no Node dependencies. `@kontourai/monument/sqlite` holds the
 * `node:sqlite` adapter and `@kontourai/monument/testing` the conformance
 * suite and crash-point store.
 */
export type * from './commands.js';
export {
  decideRequestKeyClaim,
  type RequestKeyClaimDecision,
  type RequestKeyClaimInputs,
} from './decisions/request-keys.js';
export {
  decideTurnBoundaryCreate,
  decideTurnBoundaryObserveTerminal,
  decideTurnBoundaryReconcile,
  decideTurnBoundaryRecordAccepted,
  decideTurnBoundaryRemove,
  decideTurnBoundaryTransition,
  turnBoundaryAcceptCollides,
} from './decisions/turn-boundary.js';
export {
  decideTurnDedupBeginInvocation,
  decideTurnDedupClaim,
  decideTurnDedupRelease,
  decideTurnDedupResolve,
  turnClaimIsReclaimable,
} from './decisions/turn-dedup.js';
export {
  type MemoryKernelStorageOptions,
  MemoryKernelVolume,
  openMemoryKernelStorage,
} from './memory.js';
export {
  type OwnerIdentity,
  type OwnerLiveness,
  type OwnerLivenessOptions,
  type OwnerLivenessVerdict,
  ownerLivenessFromProbe,
  type ProcessIdentityObservation,
  type ProcessIdentityProbe,
} from './owner.js';
export {
  type CommitParticipant,
  DEFAULT_KERNEL_LIMITS,
  type KernelContext,
  type KernelLimits,
  type KernelStorage,
  KernelStorageClosedError,
  type KernelTransaction,
} from './port.js';
export type * from './records.js';
export { runKernelTransactionStep } from './step.js';

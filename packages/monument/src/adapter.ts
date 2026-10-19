/**
 * For adapter authors: the record operations a decision runs against inside
 * one transaction, and the step every adapter runs in it. Consumers of the
 * kernel use `@kontourai/monument` instead.
 */
export type { KernelTerminalFacts, KernelTransaction } from './port.js';
export {
  isParticipantRefusal,
  isReadOnlyKernelCommand,
  runKernelTransactionStep,
} from './step.js';

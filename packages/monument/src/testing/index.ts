/**
 * Test support for adapters and hosts: the conformance suite, the
 * crash-point store, a fake process table, and the in-memory and node:sqlite
 * harnesses (so this entry loads `node:sqlite`). No test-runner dependency;
 * see `registerKernelConformance`.
 */
export {
  type KernelConformanceArea,
  type KernelConformanceCase,
  type KernelConformanceOutcome,
  type KernelConformanceRunner,
  kernelConformanceCases,
  kernelConformanceCasesFor,
  registerKernelConformance,
  runKernelConformance,
} from './conformance.js';
export {
  type AtomicCase,
  type AtomicCommand,
  type AtomicCrashPointStore,
  type AtomicHeldCommit,
  type AtomicLocation,
  type AtomicParticipant,
  type AtomicPort,
  type AtomicProtocol,
  type AtomicResult,
  type CrashPointStore,
  type HeldCommit,
  KernelCrashError,
  type KernelStorageHarness,
  type KernelStorageLocation,
  openAtomicCrashPointStore,
  openCrashPointStore,
} from './crash-point-store.js';
export {
  type HostBoundaryConformanceHarness,
  hostBoundaryConformanceCases,
} from './host-boundary-conformance.js';
export { memoryKernelHarness } from './memory-harness.js';
export {
  createFakeProcessTable,
  type FakeProcessTable,
} from './process-table.js';
export {
  createSqliteKernelHarness,
  createSqliteKernelLocation,
  type SqliteKernelHarnessOptions,
  type SqliteKernelLocation,
} from './sqlite-harness.js';

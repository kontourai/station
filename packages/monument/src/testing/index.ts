/**
 * Test support for adapters and hosts: the conformance suite, the
 * crash-point store, a fake process table, and the in-memory and node:sqlite
 * harnesses (so this entry loads `node:sqlite`). No test-runner dependency;
 * see `registerKernelConformance`.
 */
export {
  type KernelConformanceCase,
  type KernelConformanceOutcome,
  type KernelConformanceRunner,
  kernelConformanceCases,
  registerKernelConformance,
  runKernelConformance,
} from './conformance.js';
export {
  type CrashPointStore,
  type HeldCommit,
  KernelCrashError,
  type KernelStorageHarness,
  type KernelStorageLocation,
  openCrashPointStore,
} from './crash-point-store.js';
export { memoryKernelHarness } from './memory-harness.js';
export {
  createFakeProcessTable,
  type FakeProcessTable,
} from './process-table.js';
export {
  createSqliteKernelHarness,
  createSqliteKernelLocation,
  type SqliteKernelLocation,
} from './sqlite-harness.js';

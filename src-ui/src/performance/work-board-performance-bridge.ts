/**
 * Board-owned performance seam for station#3806.
 *
 * The SpatialBoard pane registers this driver only after it can perform the
 * real restore, resolver and pointer actions. Keeping this interface here
 * lets the #2892 performance authority report that missing implementation as
 * NOT_VERIFIED instead of substituting a synthetic board measurement.
 */
import type { WorkReference } from '@kontourai/station-contracts';

export type WorkBoardPerformanceFixtureId =
  | 'work-board-200-pins-v1'
  | 'work-board-one-hour-v1';

/** One-shot, data-free synchronization between lazy pane and adapter bridge. */
export const WORK_BOARD_DRIVER_READY_EVENT =
  'station:perf:work-board-driver-ready';

export type WorkBoardFixturePin = Readonly<{ reference: WorkReference }>;

export type WorkBoardPerformanceObservation = Readonly<{
  fixtureId: WorkBoardPerformanceFixtureId;
  counts: Readonly<{ failures: number; degraded: number }>;
  status?: 'NOT_VERIFIED';
  reasonCodes?: readonly string[];
  readonly [key: string]: unknown;
}>;

/** Deterministic, unique, content-free seed for the real 200-pin board fixture. */
export const WORK_BOARD_200_PIN_MIX: readonly WorkBoardFixturePin[] =
  Array.from({ length: 200 }, (_, index) => {
    const suffix = String(index + 1);
    switch (index % 9) {
      case 0:
        return { reference: { kind: 'project', id: `perf-project-${suffix}` } };
      case 1:
        return {
          reference: {
            kind: 'task',
            projectId: `perf-project-${suffix}`,
            id: `perf-task-${suffix}`,
          },
        };
      case 2:
        return { reference: { kind: 'session', id: `perf-session-${suffix}` } };
      case 3:
        return {
          reference: { kind: 'approval', id: `perf-approval-${suffix}` },
        };
      case 4:
        return {
          reference: {
            kind: 'receipt',
            owner: 'scheduler-run',
            id: `perf-scheduled-receipt-${suffix}`,
          },
        };
      case 5:
        return {
          reference: {
            kind: 'receipt',
            owner: 'independent-review',
            projectSlug: `perf-project-${suffix}`,
            id: `perf-review-receipt-${suffix}`,
          },
        };
      case 6:
        return {
          reference: {
            kind: 'run',
            owner: 'flow',
            projectId: `perf-project-${suffix}`,
            id: `perf-run-${suffix}`,
          },
        };
      case 7:
        return {
          reference: {
            kind: 'artifact',
            owner: 'run-output',
            runId: `perf-run-${suffix}`,
            id: `perf-artifact-${suffix}`,
          },
        };
      default:
        return { reference: { kind: 'agent', id: `perf-agent-${suffix}` } };
    }
  });

export interface WorkBoardPerformanceDriver {
  measure(input: {
    readonly fixtureId: WorkBoardPerformanceFixtureId;
    readonly warmups: number;
    readonly samples: number;
    /** The real reference lane supplies false; smoke cannot claim an hour. */
    readonly smoke: boolean;
    readonly pins: readonly WorkBoardFixturePin[];
  }): Promise<WorkBoardPerformanceObservation>;
}

let driver: WorkBoardPerformanceDriver | undefined;

/**
 * Registers the pane's real, product-owned action driver. This is deliberately
 * one narrow bridge: it exposes no board store, resolver inventory, or query
 * cache for the benchmark to mutate or inspect outside the declared fixture.
 */
export function registerWorkBoardPerformanceDriver(
  next: WorkBoardPerformanceDriver,
): () => void {
  driver = next;
  return () => {
    if (driver === next) driver = undefined;
  };
}

export function workBoardPerformanceDriver():
  | WorkBoardPerformanceDriver
  | undefined {
  return driver;
}

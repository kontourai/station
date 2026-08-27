import type { SpatialBoard } from '@kontourai/station-contracts';
import type {
  WorkBoardFixturePin,
  WorkBoardPerformanceDriver,
  WorkBoardPerformanceFixtureId,
  WorkBoardPerformanceObservation,
} from './work-board-performance-bridge';

const ONE_HOUR_MS = 60 * 60 * 1000;
const ACTION_TIMEOUT_MS = import.meta.env.MODE === 'test' ? 50 : 30_000;

type BoardMeasurementRuntime = Readonly<{
  board: () => SpatialBoard | undefined;
  coldRestore: () => Promise<void>;
  warmRestore: () => Promise<void>;
  resolve: () => Promise<void>;
  keyboardMoveResize: () => Promise<void>;
  pointerMoveResize: () => Promise<void>;
  growth: () => Record<string, number>;
  physicallyAvailable: () => boolean;
}>;

type Action = Readonly<{ kind: string; marks: Record<string, number> }>;

function now(): number {
  return performance.now();
}

function waitForSlot(target: number): Promise<void> {
  const delay = Math.max(0, target - now());
  return delay === 0
    ? Promise.resolve()
    : new Promise((resolve) => window.setTimeout(resolve, delay));
}

async function action(
  kind: string,
  startMark: string,
  endMark: string,
  run: () => Promise<void>,
): Promise<Action> {
  const startedAt = now();
  await run();
  return { kind, marks: { [startMark]: startedAt, [endMark]: now() } };
}

function unavailable(
  fixtureId: WorkBoardPerformanceFixtureId,
  reason: string,
): WorkBoardPerformanceObservation {
  return {
    fixtureId,
    status: 'NOT_VERIFIED',
    reasonCodes: [reason],
    counts: { failures: 0, degraded: 0 },
  };
}

function assertFixturePins(
  board: SpatialBoard | undefined,
  pins: readonly WorkBoardFixturePin[],
): boolean {
  return (
    board?.pins.length === pins.length &&
    board.pins.every(
      (pin, index) =>
        JSON.stringify(pin.reference) ===
        JSON.stringify(pins[index]?.reference),
    )
  );
}

async function measure200Pins(
  runtime: BoardMeasurementRuntime,
  input: Parameters<WorkBoardPerformanceDriver['measure']>[0],
): Promise<WorkBoardPerformanceObservation> {
  const measurements: Array<Record<string, unknown>> = [];
  const total = input.warmups + input.samples;
  for (let iteration = 0; iteration < total; iteration += 1) {
    const cold = await action(
      'board-cold-restore',
      'restoreStartedAt',
      'restoreCommittedAt',
      runtime.coldRestore,
    );
    const warm = await action(
      'board-warm-restore',
      'restoreStartedAt',
      'restoreCommittedAt',
      runtime.warmRestore,
    );
    const resolution = await action(
      'board-grouped-live-resolution-commit',
      'resolutionStartedAt',
      'resolutionCommittedAt',
      runtime.resolve,
    );
    const keyboard = await action(
      'board-keyboard-move-resize',
      'interactionStartedAt',
      'interactionCommittedAt',
      runtime.keyboardMoveResize,
    );
    const pointer = await action(
      'board-pointer-move-resize',
      'interactionStartedAt',
      'interactionCommittedAt',
      runtime.pointerMoveResize,
    );
    if (iteration >= input.warmups)
      measurements.push({
        iteration: iteration - input.warmups,
        phases: {
          measured: { actions: [cold, warm, resolution, keyboard, pointer] },
        },
      });
  }
  return {
    fixtureId: input.fixtureId,
    sampling: { warmups: input.warmups, samples: input.samples },
    workloads: [
      'board-cold-restore',
      'board-warm-restore',
      'board-grouped-live-resolution-commit',
      'board-keyboard-move-resize',
      'board-pointer-move-resize',
    ],
    measurements,
    counts: { failures: 0, degraded: 0 },
  };
}

async function measureOneHour(
  runtime: BoardMeasurementRuntime,
  input: Parameters<WorkBoardPerformanceDriver['measure']>[0],
): Promise<WorkBoardPerformanceObservation> {
  const total = input.warmups + input.samples;
  const startedAt = now();
  const growthStart = runtime.growth();
  const measurements: Array<Record<string, unknown>> = [];
  for (let iteration = 0; iteration < total; iteration += 1) {
    await waitForSlot(
      startedAt + Math.floor((iteration * ONE_HOUR_MS) / total),
    );
    if (!runtime.physicallyAvailable())
      return unavailable(
        input.fixtureId,
        'WORK_BOARD_PHYSICAL_ENVIRONMENT_UNAVAILABLE',
      );
    const resolution = await action(
      'board-live-resolution',
      'resolutionStartedAt',
      'resolutionCommittedAt',
      runtime.resolve,
    );
    const interaction = await action(
      'board-interaction-bookkeeping',
      'bookkeepingStartedAt',
      'bookkeepingFinishedAt',
      iteration % 2 === 0
        ? runtime.keyboardMoveResize
        : runtime.pointerMoveResize,
    );
    if (iteration >= input.warmups)
      measurements.push({
        iteration: iteration - input.warmups,
        phases: { measured: { actions: [resolution, interaction] } },
      });
  }
  await waitForSlot(startedAt + ONE_HOUR_MS);
  if (!runtime.physicallyAvailable())
    return unavailable(
      input.fixtureId,
      'WORK_BOARD_PHYSICAL_ENVIRONMENT_UNAVAILABLE',
    );
  const growthEnd = runtime.growth();
  return {
    fixtureId: input.fixtureId,
    sampling: { warmups: input.warmups, samples: input.samples },
    workloads: ['board-live-resolution', 'board-interaction-bookkeeping'],
    measurements,
    growth: Object.fromEntries(
      Object.entries(growthStart).map(([name, start]) => [
        name,
        { start, end: growthEnd[name] },
      ]),
    ),
    duration: {
      logicalDurationMs: ONE_HOUR_MS,
      observedDurationMs: Math.floor(now() - startedAt),
      scaled: false,
    },
    counts: { failures: 0, degraded: 0 },
  };
}

/**
 * The pane supplies only real query refreshes and real DOM interactions. The
 * driver owns the fixture clock and raw contract marks; it never mutates a
 * board store or invents a timing result.
 */
export function createWorkBoardPerformanceDriver(
  runtime: BoardMeasurementRuntime,
): WorkBoardPerformanceDriver {
  return {
    async measure(input) {
      if (!assertFixturePins(runtime.board(), input.pins))
        return unavailable(
          input.fixtureId,
          'WORK_BOARD_200_PIN_FIXTURE_UNAVAILABLE',
        );
      if (!runtime.physicallyAvailable())
        return unavailable(
          input.fixtureId,
          'WORK_BOARD_PHYSICAL_ENVIRONMENT_UNAVAILABLE',
        );
      try {
        return input.fixtureId === 'work-board-200-pins-v1'
          ? await measure200Pins(runtime, input)
          : await measureOneHour(runtime, input);
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        return unavailable(
          input.fixtureId,
          message.includes('timed out')
            ? 'WORK_BOARD_PRODUCT_COMMIT_TIMEOUT'
            : 'WORK_BOARD_PRODUCT_ACTION_UNAVAILABLE',
        );
      }
    },
  };
}

export async function waitForBoardCommit(
  board: () => SpatialBoard | undefined,
  expectedRevision: number,
): Promise<void> {
  const deadline = now() + ACTION_TIMEOUT_MS;
  while ((board()?.revision ?? -1) <= expectedRevision) {
    if (now() >= deadline) throw new Error('work board commit timed out');
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  }
}

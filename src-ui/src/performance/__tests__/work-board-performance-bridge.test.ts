import { expect, test } from 'vitest';
import {
  registerWorkBoardPerformanceDriver,
  WORK_BOARD_200_PIN_MIX,
  workBoardPerformanceDriver,
} from '../work-board-performance-bridge';
import { createWorkBoardPerformanceDriver } from '../work-board-performance-driver';

test('has a deterministic, unique 200-pin mix across every identity kind', () => {
  expect(WORK_BOARD_200_PIN_MIX).toHaveLength(200);
  expect(
    new Set(WORK_BOARD_200_PIN_MIX.map((pin) => pin.reference.kind)),
  ).toEqual(
    new Set([
      'project',
      'task',
      'session',
      'approval',
      'receipt',
      'run',
      'artifact',
      'agent',
    ]),
  );
  expect(
    new Set(WORK_BOARD_200_PIN_MIX.map((pin) => JSON.stringify(pin.reference))),
  ).toHaveLength(200);
});

test('keeps the board measurement seam unavailable until the pane owns real actions', () => {
  expect(workBoardPerformanceDriver()).toBeUndefined();
  const driver = {
    measure: async (_input: unknown) => ({
      fixtureId: 'work-board-200-pins-v1' as const,
      counts: { failures: 0, degraded: 0 },
    }),
  };
  const unregister = registerWorkBoardPerformanceDriver(driver);
  expect(workBoardPerformanceDriver()).toBe(driver);
  unregister();
  expect(workBoardPerformanceDriver()).toBeUndefined();
});

test('derives 200-pin timing only from pane-owned restores, resolution, and interactions', async () => {
  const calls: string[] = [];
  const board = {
    pins: WORK_BOARD_200_PIN_MIX.map((item, index) => ({
      id: String(index),
      reference: item.reference,
    })),
  } as any;
  const driver = createWorkBoardPerformanceDriver({
    board: () => board,
    coldRestore: async () => void calls.push('cold'),
    warmRestore: async () => void calls.push('warm'),
    resolve: async () => void calls.push('resolve'),
    keyboardMoveResize: async () => void calls.push('keyboard'),
    pointerMoveResize: async () => void calls.push('pointer'),
    growth: () => ({
      boardDomNodes: 1,
      boardListeners: 1,
      boardPendingInteractions: 0,
      boardQueryCacheEntries: 2,
    }),
    physicallyAvailable: () => true,
  });
  const observation = await driver.measure({
    fixtureId: 'work-board-200-pins-v1',
    warmups: 1,
    samples: 2,
    smoke: false,
    pins: WORK_BOARD_200_PIN_MIX,
  });
  expect(observation).toMatchObject({
    fixtureId: 'work-board-200-pins-v1',
    sampling: { warmups: 1, samples: 2 },
    counts: { failures: 0, degraded: 0 },
  });
  expect(
    (observation as { measurements?: readonly unknown[] }).measurements,
  ).toHaveLength(2);
  expect(calls).toEqual([
    'cold',
    'warm',
    'resolve',
    'keyboard',
    'pointer',
    'cold',
    'warm',
    'resolve',
    'keyboard',
    'pointer',
    'cold',
    'warm',
    'resolve',
    'keyboard',
    'pointer',
  ]);
});

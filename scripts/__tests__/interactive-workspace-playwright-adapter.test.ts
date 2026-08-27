import { expect, test, vi } from 'vitest';
import {
  bridgeEvidence,
  performWorkBoardInteraction,
  reconnectDocumentGate,
  reconnectRequestFence,
  WORK_BOARD_DRIVER_READY_TIMEOUT_MS,
} from '../interactive-workspace-playwright-adapter.mjs';

const boardConfig = {
  sampling: { warmups: 0, samples: 1 },
  fixtureCorpus: { id: 'board', sha256: 'a'.repeat(64) },
  fixtures: [{ id: 'work-board-200-pins-v1' }],
};

test('rejects missing and wrong native Last-Event-ID headers', async () => {
  const missing = reconnectRequestFence();
  const missingWait = missing.next('revision-base');
  missing.observe(undefined);
  await expect(missingWait).rejects.toThrow('missing Last-Event-ID');

  const wrong = reconnectRequestFence();
  const wrongWait = wrong.next('revision-base');
  wrong.observe('revision-current');
  await expect(wrongWait).rejects.toThrow('identity changed');
});

test('drives Work Board interactions through trusted Playwright input', async () => {
  const focus = vi.fn();
  const scrollIntoViewIfNeeded = vi.fn();
  const move = vi.fn();
  const down = vi.fn();
  const up = vi.fn();
  const press = vi.fn();
  const page = {
    locator: () => ({
      first: () => ({
        focus,
        scrollIntoViewIfNeeded,
        boundingBox: async () => ({ x: 10, y: 20, width: 40, height: 30 }),
      }),
    }),
    keyboard: { press },
    mouse: { move, down, up },
  };

  await expect(
    performWorkBoardInteraction(page, 'work-board-keyboard-move-resize'),
  ).resolves.toEqual({ kind: 'work-board-interaction-completed' });
  expect(focus).toHaveBeenCalledOnce();
  expect(press).toHaveBeenCalledWith('Shift+ArrowRight');

  await expect(
    performWorkBoardInteraction(page, 'work-board-pointer-move-resize'),
  ).resolves.toEqual({ kind: 'work-board-interaction-completed' });
  expect(scrollIntoViewIfNeeded).toHaveBeenCalledTimes(2);
  expect(move).toHaveBeenNthCalledWith(1, 30, 35);
  expect(down).toHaveBeenCalledOnce();
  expect(move).toHaveBeenNthCalledWith(2, 50, 55);
  expect(up).toHaveBeenCalledOnce();
});

test('waits for delayed lazy Board registration before measuring', async () => {
  const page = {
    waitForFunction: async () => undefined,
    evaluate: async (_callback: unknown, input: unknown) => {
      if (typeof input === 'object' && input && 'timeoutMs' in input) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        return true;
      }
      return {
        version: 1,
        source: 'station-ui-production-bridge',
        observations: [{ fixtureId: 'work-board-200-pins-v1' }],
      };
    },
  };

  await expect(bridgeEvidence(page, boardConfig)).resolves.toMatchObject({
    observations: [{ fixtureId: 'work-board-200-pins-v1' }],
  });
});

test('reports an honest bounded Board-driver readiness timeout', async () => {
  expect(WORK_BOARD_DRIVER_READY_TIMEOUT_MS).toBe(30_000);
  const page = {
    waitForFunction: async () => undefined,
    evaluate: async () => false,
  };

  await expect(bridgeEvidence(page, boardConfig)).resolves.toMatchObject({
    observations: [
      {
        fixtureId: 'work-board-200-pins-v1',
        status: 'NOT_VERIFIED',
        reasonCodes: ['WORK_BOARD_PERFORMANCE_DRIVER_UNAVAILABLE'],
      },
    ],
  });
});

test('holds document refetch until the exact product strategy releases it', async () => {
  const gate = reconnectDocumentGate('task-1');
  gate.arm('delta');
  let released = false;
  const held = gate.wait().then(() => {
    released = true;
  });
  await Promise.resolve();
  expect(released).toBe(false);
  expect(() => gate.release({ taskId: 'task-1', strategy: 'gap' })).toThrow(
    'identity changed',
  );
  expect(released).toBe(false);
  gate.release({ taskId: 'task-1', strategy: 'delta' });
  await held;
  expect(released).toBe(true);
});

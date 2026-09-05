import { expect, test, vi } from 'vitest';
import {
  bridgeEvidence,
  clickLiveCommand,
  closedLiveCommandDiagnostic,
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

function liveCommandPage(
  response: Promise<unknown>,
  click: () => Promise<void>,
) {
  return {
    // A plain function matters: mock promise-result tracking itself can attach
    // a rejection handler and hide the abandoned waiter defect.
    waitForResponse: () => response,
    getByRole: vi.fn(() => ({ waitFor: async () => {}, click })),
    waitForFunction: async () => {},
  };
}

const eventLoopTurn = () =>
  new Promise<void>((resolve) => setImmediate(resolve));

test('owns the live-command response rejection after input fails and the page tears down', async () => {
  let rejectResponse!: (error: Error) => void;
  const response = new Promise((_, reject) => {
    rejectResponse = reject;
  });
  const primary = new Error('fixture input failure');
  const page = liveCommandPage(response, async () => {
    throw primary;
  });
  const failure = await clickLiveCommand(page, 'Join room').catch(
    (error: Error & { cause?: unknown }) => error,
  );
  if (!(failure instanceof Error)) throw new Error('Expected input failure');
  expect(failure.cause ?? failure).toBe(primary);
  rejectResponse(new Error('fixture response teardown'));
  // Exercise Node's rejection reporting turn. An abandoned raw waiter is an
  // actual unhandled rejection here, not a source-text or promise-shape claim.
  await eventLoopTurn();
});

test('simultaneous response and input failures preserve the input cause and bounded diagnosis', async () => {
  let rejectResponse!: (error: Error) => void;
  const response = new Promise((_, reject) => {
    rejectResponse = reject;
  });
  let rejectInput!: (error: Error) => void;
  const input = new Promise<void>((_, reject) => {
    rejectInput = reject;
  });
  const page = liveCommandPage(response, () => input);
  const operation = clickLiveCommand(page, 'Join room').catch(
    (error: unknown) => error,
  );
  await eventLoopTurn();
  rejectResponse(new Error('Target page, context or browser has been closed'));
  await eventLoopTurn();
  const primary = new Error(
    'private page text and credential must not enter the receipt',
  );
  primary.name = 'TimeoutError';
  rejectInput(primary);
  const failure = await operation;
  expect(failure).toMatchObject({ cause: primary });
  expect(closedLiveCommandDiagnostic(failure)).toBe(
    'Live command join input TIMEOUT',
  );
});

test('reports the owned response failure when input succeeds without leaking its text', async () => {
  const cause = new Error('private response body');
  const page = liveCommandPage(Promise.reject(cause), async () => {});
  const failure = await clickLiveCommand(page, 'Announce work').catch(
    (error: unknown) => error,
  );
  expect(failure).toMatchObject({ cause });
  expect(closedLiveCommandDiagnostic(failure)).toBe(
    'Live command announce response FAILED',
  );
});

test('arms the exact live response before input and validates the response after input', async () => {
  const order: string[] = [];
  const response = {
    status: () => 200,
    json: async () => {
      order.push('body');
      return { success: true, data: { kind: 'available' } };
    },
  };
  const page = {
    ...liveCommandPage(Promise.resolve(response), async () => {
      order.push('click');
    }),
    waitForResponse: (predicate: (candidate: unknown) => boolean) => {
      order.push('armed');
      const candidate = (method: string, command: string) => ({
        url: () => 'http://fixture.invalid/api/projects/p/tasks/t/room/live',
        request: () => ({
          method: () => method,
          postData: () => JSON.stringify({ command }),
        }),
      });
      expect(predicate(candidate('GET', 'join'))).toBe(false);
      expect(predicate(candidate('POST', 'depart'))).toBe(false);
      expect(predicate(candidate('POST', 'join'))).toBe(true);
      return Promise.resolve(response);
    },
  };
  await expect(clickLiveCommand(page, 'Join room')).resolves.toBeUndefined();
  expect(order).toEqual(['armed', 'click', 'body']);
});

test.each(['constructor', '__proto__', 'toString'])(
  'rejects inherited live-command label %s before touching the browser',
  async (name) => {
    const page = {
      waitForResponse: () => {
        throw new Error('Browser must not be touched');
      },
    };
    await expect(clickLiveCommand(page, name)).rejects.toThrow(
      'live command label is invalid',
    );
  },
);

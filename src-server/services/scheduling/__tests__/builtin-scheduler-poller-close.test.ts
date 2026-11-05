/**
 * #4582: `stop()` waits for the automation poller's own `close()`. Task
 * tracker follow-ups run on their own single flight and are stopped by that
 * close, so a scheduler stop that did not await it would return while a
 * follow-up poll still runs.
 */
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { BuiltinScheduler } from '../builtin-scheduler.js';
import { createSchedulerLedger } from '../scheduler-ledger.js';

const makeTempDir = trackTempDirs();

test('stop() resolves only after an asynchronous poller close has finished', async () => {
  const home = makeTempDir('station-scheduler-poller-close-');
  let finishClose!: () => void;
  const closed = vi.fn();
  const scheduler = new BuiltinScheduler({
    ledger: createSchedulerLedger({ directory: join(home, 'scheduler') }),
    turnAdapter: { invoke: vi.fn() } as never,
    automationPoller: {
      poll: async () => undefined,
      close: () =>
        new Promise<void>((resolve) => {
          finishClose = () => {
            closed();
            resolve();
          };
        }),
    },
  });
  scheduler.start();
  let stopped = false;
  const stopping = scheduler.stop().then(() => {
    stopped = true;
  });
  await vi.waitFor(() => expect(finishClose).toBeTypeOf('function'));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(stopped).toBe(false);
  finishClose();
  await stopping;
  expect(closed).toHaveBeenCalledOnce();
  expect(stopped).toBe(true);
});

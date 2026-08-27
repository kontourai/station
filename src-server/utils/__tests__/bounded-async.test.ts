import { describe, expect, test } from 'vitest';
import { raceWithSignal } from '../bounded-async.js';

const drainEventLoop = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('raceWithSignal', () => {
  test('adopts a later rejection when the signal was already aborted', async () => {
    const controller = new AbortController();
    const reason = new Error('already-aborted operation rejection');
    controller.abort(reason);
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (rejection: unknown) => {
      unhandledRejections.push(rejection);
    };
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      const operation = new Promise<never>((_, reject) => {
        setTimeout(() => reject(reason), 0);
      });

      await expect(raceWithSignal(operation, controller.signal)).rejects.toBe(
        reason,
      );
      await drainEventLoop();

      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  test('adopts a later resolution when the signal was already aborted', async () => {
    const controller = new AbortController();
    const reason = new Error('already-aborted operation resolution');
    controller.abort(reason);
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (rejection: unknown) => {
      unhandledRejections.push(rejection);
    };
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      const operation = new Promise<string>((resolve) => {
        setTimeout(() => resolve('later value'), 0);
      });

      await expect(raceWithSignal(operation, controller.signal)).rejects.toBe(
        reason,
      );
      await drainEventLoop();

      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  test('keeps adopting the operation after an in-flight abort', async () => {
    const controller = new AbortController();
    const reason = new Error('in-flight abort');
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (rejection: unknown) => {
      unhandledRejections.push(rejection);
    };
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      const operation = new Promise<never>((_, reject) => {
        setTimeout(() => reject(reason), 0);
      });
      const raced = raceWithSignal(operation, controller.signal);
      controller.abort(reason);

      await expect(raced).rejects.toBe(reason);
      await drainEventLoop();

      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });
});

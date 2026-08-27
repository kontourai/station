import { describe, expect, it, vi } from 'vitest';
import * as buildProvenance from '../../../routes/system/build-provenance.js';
import {
  type CrashHandlerTarget,
  installCrashHandlers,
  logFatalAndFlush,
} from '../crash-handlers.js';

describe('logFatalAndFlush', () => {
  it('logs fatal and flushes on the happy path', () => {
    const logger = { fatal: vi.fn() };
    const flushSync = vi.fn();

    logFatalAndFlush(
      logger,
      'Failed to start Station',
      { err: 'boom' },
      flushSync,
    );

    expect(logger.fatal).toHaveBeenCalledWith('Failed to start Station', {
      err: 'boom',
    });
    expect(flushSync).toHaveBeenCalledTimes(1);
  });

  it('falls back to console.error, preserving the original failure, when logger.fatal throws — and never throws itself', () => {
    const loggingFailure = new Error('logger broke');
    const logger = {
      fatal: vi.fn(() => {
        throw loggingFailure;
      }),
    };
    const flushSync = vi.fn();
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const originalFailure = new Error('original startup failure');

    expect(() =>
      logFatalAndFlush(
        logger,
        'Failed to start Station',
        { err: originalFailure },
        flushSync,
      ),
    ).not.toThrow();

    // First console.error call preserves the ORIGINAL msg/context — a reader
    // debugging a broken logger must still see what actually failed.
    expect(consoleErrorSpy).toHaveBeenNthCalledWith(
      1,
      'Failed to start Station',
      {
        err: originalFailure,
      },
    );
    // Second call names the logging failure itself, without swallowing it.
    expect(consoleErrorSpy).toHaveBeenNthCalledWith(
      2,
      '(logger itself failed to emit the line above)',
      loggingFailure,
    );
    // flushSync still runs — a broken logger must not skip the durability step.
    expect(flushSync).toHaveBeenCalledTimes(1);

    consoleErrorSpy.mockRestore();
  });

  it('never throws when flushSync itself throws', () => {
    const logger = { fatal: vi.fn() };
    const flushSync = vi.fn(() => {
      throw new Error('flush broke');
    });

    expect(() =>
      logFatalAndFlush(logger, 'msg', undefined, flushSync),
    ).not.toThrow();
    expect(logger.fatal).toHaveBeenCalled();
  });

  it('writes and flushes a crash line without a bootstrap snapshot', () => {
    const logger = { fatal: vi.fn() };
    const flushSync = vi.fn();

    expect(() =>
      logFatalAndFlush(
        logger,
        'Failed to start Station',
        { err: 'boom' },
        flushSync,
      ),
    ).not.toThrow();

    expect(
      logger.fatal,
      'fatal line must still be written when bootstrap has not produced a snapshot',
    ).toHaveBeenCalledWith('Failed to start Station', { err: 'boom' });
    expect(flushSync).toHaveBeenCalledTimes(1);
  });

  it('uses the bootstrap snapshot without resolving provenance on the crash path', () => {
    const snapshot = buildProvenance.captureBuildProvenance({
      STATION_BUILD_SHA: 'abcdef0123456789abcdef0123456789abcdef01',
      STATION_BUILD_BUILT_AT: '2026-08-11T12:00:00.000Z',
    });
    const resolver = vi.spyOn(buildProvenance, 'readBuildProvenance');
    const logger = { fatal: vi.fn() };
    const flushSync = vi.fn();

    logFatalAndFlush(logger, 'crash', { err: 'boom' }, flushSync, snapshot);

    expect(
      resolver,
      'crash path must not resolve build provenance after bootstrap',
    ).not.toHaveBeenCalled();
    expect(logger.fatal).toHaveBeenCalledWith('crash', {
      err: 'boom',
      build: {
        fullSha: 'abcdef0123456789abcdef0123456789abcdef01',
        shortSha: 'abcdef0',
        shaSource: 'checkout',
        builtAt: '2026-08-11T12:00:00.000Z',
        ageSeconds: expect.any(Number),
        channel: 'source-checkout',
      },
    });
  });
});

/** A fake process-shaped target so these tests never register a listener on
 * the real global `process` (which would leak across the suite). */
function createFakeTarget(): CrashHandlerTarget & {
  emit(event: string, ...args: unknown[]): void;
} {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    on(event, listener) {
      const existing = listeners.get(event) ?? [];
      existing.push(listener);
      listeners.set(event, existing);
      return this;
    },
    emit(event, ...args) {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
  };
}

describe('installCrashHandlers', () => {
  it('logs unhandledRejection at error and does not call onUncaughtException', () => {
    const logger = { fatal: vi.fn(), error: vi.fn() };
    const flushSync = vi.fn();
    const onUncaughtException = vi.fn();
    const target = createFakeTarget();
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    installCrashHandlers(logger, { flushSync, onUncaughtException }, target);
    target.emit('unhandledRejection', 'some rejection reason');

    expect(logger.error).toHaveBeenCalledWith('Unhandled rejection', {
      err: 'some rejection reason',
    });
    expect(logger.fatal).not.toHaveBeenCalled();
    expect(flushSync).not.toHaveBeenCalled();
    expect(onUncaughtException).not.toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it('an unhandledRejection whose own logger.error throws never propagates', () => {
    const logger = {
      fatal: vi.fn(),
      error: vi.fn(() => {
        throw new Error('logger broke');
      }),
    };
    const target = createFakeTarget();
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    installCrashHandlers(logger, { flushSync: vi.fn() }, target);
    expect(() => target.emit('unhandledRejection', 'reason')).not.toThrow();

    consoleErrorSpy.mockRestore();
  });

  it('logs fatal, flushes, and calls onUncaughtException for an uncaughtException', () => {
    const logger = { fatal: vi.fn(), error: vi.fn() };
    const flushSync = vi.fn();
    const onUncaughtException = vi.fn();
    const target = createFakeTarget();
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const err = new Error('boom');

    installCrashHandlers(logger, { flushSync, onUncaughtException }, target);
    target.emit('uncaughtException', err);

    expect(logger.fatal).toHaveBeenCalledWith('Uncaught exception', { err });
    expect(flushSync).toHaveBeenCalledTimes(1);
    expect(onUncaughtException).toHaveBeenCalledWith(err);

    consoleErrorSpy.mockRestore();
  });
});

// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  captureLoggerLines,
  stopLoggerCaptures,
} from '../../__test-utils__/logger-capture.js';
import { logRecordsSuppressed } from '../../telemetry/metrics.js';
import {
  createLogRepeatLimiter,
  DEFAULT_LOG_REPEAT_LIMIT,
  logRepeatKey,
  resolveLogRepeatLimitPolicy,
} from '../log-repeat-limiter.js';
import {
  configureLogRepeatLimit,
  createLogger,
  flushLogRepeatSummaries,
} from '../logger.js';

const originalStdoutLogs = process.env.STATION_STDOUT_LOGS;

beforeEach(() => {
  // Keep pino-pretty quiet; the durable tee is what these tests read.
  process.env.STATION_STDOUT_LOGS = '0';
  vi.useFakeTimers();
  configureLogRepeatLimit({ limit: 3, windowMs: 60_000, maxKeys: 64 });
});

afterEach(() => {
  stopLoggerCaptures();
  configureLogRepeatLimit({ limit: 0 });
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (originalStdoutLogs === undefined) delete process.env.STATION_STDOUT_LOGS;
  else process.env.STATION_STDOUT_LOGS = originalStdoutLogs;
});

describe('logger repeat limit (#4995)', () => {
  it('writes the first N identical warnings, suppresses the rest and summarizes them when the window ends', () => {
    const logger = createLogger({ name: 'repeat-test' });
    const capture = captureLoggerLines();
    const error = new Error("Agent 'muse' not found at /tmp/agents/muse");

    for (let index = 0; index < 10; index += 1) {
      logger.warn('Station setup requirement probe failed', {
        err: error,
        attempt: index,
      });
    }

    const written = capture.at('warn');
    expect(written).toHaveLength(3);
    expect(written.map((line) => line.attempt)).toEqual([0, 1, 2]);

    vi.advanceTimersByTime(60_000);

    const after = capture.at('warn');
    expect(after).toHaveLength(4);
    expect(after[3]).toMatchObject({
      msg: 'Suppressed 7 repeats of: Station setup requirement probe failed',
      suppressedRepeats: 7,
      windowSeconds: 60,
      name: 'repeat-test',
    });
    // The summary does not carry the suppressed records' payloads.
    expect(after[3]).not.toHaveProperty('attempt');
    expect(after[3]).not.toHaveProperty('err');

    // A new window admits the identity again.
    logger.warn('Station setup requirement probe failed', { err: error });
    expect(capture.at('warn')).toHaveLength(5);
  });

  it('flushLogRepeatSummaries writes a pending summary before its window ends (#5054)', () => {
    const logger = createLogger({ name: 'repeat-test' });
    const capture = captureLoggerLines();
    for (let index = 0; index < 5; index += 1) {
      logger.warn('Probe failed', { attempt: index });
    }
    expect(capture.at('warn')).toHaveLength(3);

    vi.advanceTimersByTime(1_000);
    flushLogRepeatSummaries();

    const written = capture.at('warn');
    expect(written).toHaveLength(4);
    expect(written[3]).toMatchObject({
      msg: 'Suppressed 2 repeats of: Probe failed',
      suppressedRepeats: 2,
      name: 'repeat-test',
    });
    // Written once: the window's own end has nothing left to report, and a
    // second flush is a no-op.
    flushLogRepeatSummaries();
    vi.advanceTimersByTime(60_000);
    expect(capture.at('warn')).toHaveLength(4);
    // The identity starts a fresh window after the flush.
    logger.warn('Probe failed');
    expect(capture.at('warn')).toHaveLength(5);
  });

  it('never suppresses error or fatal records', () => {
    const logger = createLogger({ name: 'repeat-test' });
    const capture = captureLoggerLines();
    const error = new Error('disk full');
    for (let index = 0; index < 20; index += 1) {
      logger.error('Write failed', { err: error });
      logger.fatal('Crashed', { err: error });
    }
    expect(capture.at('error')).toHaveLength(20);
    expect(capture.at('fatal')).toHaveLength(20);
  });

  it('keeps distinct messages, components and errors apart, and folds digits inside one error', () => {
    const first = createLogger({ name: 'component-a' });
    const second = createLogger({ name: 'component-b' });
    const capture = captureLoggerLines();
    for (let index = 0; index < 5; index += 1) {
      first.warn('Message one');
      first.warn('Message two');
      second.warn('Message one');
      first.warn('Failed', { err: new Error('ENOENT') });
      first.warn('Failed', { err: new Error('EACCES') });
      // Only the pid differs: one identity.
      first.warn('Probe', { err: new Error(`process ${4000 + index} gone`) });
    }
    const count = (name: string, msg: string, errMessage?: string) =>
      capture
        .at('warn')
        .filter(
          (line) =>
            line.name === name &&
            line.msg === msg &&
            (errMessage === undefined ||
              (line.err as { message?: string } | undefined)?.message ===
                errMessage),
        ).length;
    expect(count('component-a', 'Message one')).toBe(3);
    expect(count('component-a', 'Message two')).toBe(3);
    expect(count('component-b', 'Message one')).toBe(3);
    expect(count('component-a', 'Failed', 'ENOENT')).toBe(3);
    expect(count('component-a', 'Failed', 'EACCES')).toBe(3);
    expect(count('component-a', 'Probe')).toBe(3);
  });

  it('counts each suppressed record by component and level, without message text', async () => {
    const add = vi.spyOn(logRecordsSuppressed, 'add');
    const logger = createLogger({ name: 'repeat-metric' });
    captureLoggerLines();
    for (let index = 0; index < 5; index += 1) {
      logger.warn('Usage telemetry requeued');
    }
    vi.useRealTimers();
    await vi.waitFor(() => expect(add).toHaveBeenCalledTimes(2));
    for (const call of add.mock.calls) {
      expect(call).toEqual([1, { component: 'repeat-metric', level: 'warn' }]);
    }
  });

  it('writes every repeat when the limit is turned off', () => {
    configureLogRepeatLimit({ limit: 0 });
    const logger = createLogger({ name: 'repeat-test' });
    const capture = captureLoggerLines();
    for (let index = 0; index < 10; index += 1) logger.warn('Same warning');
    expect(capture.at('warn')).toHaveLength(10);
  });

  it('a child logger shares its component identity and limit', () => {
    const logger = createLogger({ name: 'repeat-test' });
    const capture = captureLoggerLines();
    for (let index = 0; index < 5; index += 1) {
      logger.child({ sessionId: `s-${index}` }).warn('Same warning');
    }
    expect(capture.at('warn')).toHaveLength(3);
  });
});

describe('log repeat limiter bounds', () => {
  it('tracks at most maxKeys identities and summarizes an evicted one', () => {
    let clock = 0;
    const limiter = createLogRepeatLimiter(
      { limit: 1, windowMs: 1_000, maxKeys: 4 },
      () => clock,
    );
    const summaries: Array<[string, number]> = [];
    for (let key = 0; key < 50; key += 1) {
      for (let repeat = 0; repeat < 3; repeat += 1) {
        limiter.admit(`k${key}`, (suppressed) =>
          summaries.push([`k${key}`, suppressed]),
        );
      }
      expect(limiter.size()).toBeLessThanOrEqual(4);
    }
    // Every evicted identity reported its two suppressed repeats.
    expect(summaries).toHaveLength(46);
    expect(summaries.every(([, suppressed]) => suppressed === 2)).toBe(true);
    clock = 1_000;
    limiter.sweep();
    expect(limiter.size()).toBe(0);
    expect(summaries).toHaveLength(50);
  });

  it('keys only on component, message and error identity', () => {
    const refused = (address: string) =>
      Object.assign(new Error(`connect ECONNREFUSED ${address}`), {
        code: 'ECONNREFUSED',
      });
    const key = logRepeatKey('usage', 'Requeue', {
      err: refused('127.0.0.1:3141'),
      payload: 'x'.repeat(10_000),
    });
    expect(key).toBe(
      logRepeatKey('usage', 'Requeue', { err: refused('127.0.0.2:3142') }),
    );
    expect(key).not.toBe(
      logRepeatKey('usage', 'Requeue', { err: new Error('timed out') }),
    );
    expect(key).not.toContain('xxxx');
    expect(key.length).toBeLessThan(600);
  });

  it('reads its policy from the environment and falls back on invalid values', () => {
    expect(
      resolveLogRepeatLimitPolicy({
        STATION_LOG_REPEAT_LIMIT: '10',
        STATION_LOG_REPEAT_WINDOW_SECONDS: '5',
      }),
    ).toMatchObject({ limit: 10, windowMs: 5_000 });
    expect(
      resolveLogRepeatLimitPolicy({ STATION_LOG_REPEAT_LIMIT: '0' }).limit,
    ).toBe(0);
    expect(
      resolveLogRepeatLimitPolicy({
        STATION_LOG_REPEAT_LIMIT: 'lots',
        STATION_LOG_REPEAT_WINDOW_SECONDS: '0',
      }),
    ).toMatchObject({
      limit: DEFAULT_LOG_REPEAT_LIMIT.limit,
      windowMs: DEFAULT_LOG_REPEAT_LIMIT.windowMs,
    });
  });
});

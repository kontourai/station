/**
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  CONSOLE_CAPTURE_LIMIT,
  CONSOLE_ENTRY_MAX_CHARS,
  installConsoleCapture,
  readCapturedConsoleEntries,
  resetConsoleCaptureForTests,
} from '../console-capture';

afterEach(() => {
  resetConsoleCaptureForTests();
  vi.restoreAllMocks();
});

describe('installConsoleCapture', () => {
  test('buffers console.error and console.warn while still invoking the originals', () => {
    const originalError = vi.fn();
    const originalWarn = vi.fn();
    console.error = originalError;
    console.warn = originalWarn;
    installConsoleCapture();

    console.error('boom', { code: 503 });
    console.warn('slow response');

    expect(originalError).toHaveBeenCalledWith('boom', { code: 503 });
    expect(originalWarn).toHaveBeenCalledWith('slow response');
    expect(readCapturedConsoleEntries()).toEqual([
      expect.objectContaining({ level: 'error', message: 'boom {"code":503}' }),
      expect.objectContaining({ level: 'warn', message: 'slow response' }),
    ]);
  });

  test('is idempotent — a second install does not double-record', () => {
    console.error = vi.fn();
    installConsoleCapture();
    installConsoleCapture();

    console.error('once');
    expect(readCapturedConsoleEntries()).toHaveLength(1);
  });

  test('keeps only the newest entries at the capture limit', () => {
    console.error = vi.fn();
    installConsoleCapture();

    for (let index = 0; index < CONSOLE_CAPTURE_LIMIT + 5; index += 1) {
      console.error(`entry-${index}`);
    }

    const entries = readCapturedConsoleEntries();
    expect(entries).toHaveLength(CONSOLE_CAPTURE_LIMIT);
    expect(entries[0]?.message).toBe('entry-5');
    expect(entries.at(-1)?.message).toBe(`entry-${CONSOLE_CAPTURE_LIMIT + 4}`);
  });

  test('caps a single pathological entry and says so', () => {
    console.error = vi.fn();
    installConsoleCapture();

    console.error('y'.repeat(CONSOLE_ENTRY_MAX_CHARS + 100));

    const [entry] = readCapturedConsoleEntries();
    expect(entry?.message.endsWith('… [truncated]')).toBe(true);
    expect(entry?.message.length).toBeLessThan(CONSOLE_ENTRY_MAX_CHARS + 20);
  });

  test('records uncaught window errors', () => {
    console.error = vi.fn();
    installConsoleCapture();

    window.dispatchEvent(
      new ErrorEvent('error', { message: 'ReferenceError: x is not defined' }),
    );

    expect(readCapturedConsoleEntries()).toEqual([
      expect.objectContaining({
        level: 'error',
        message: expect.stringContaining(
          'Uncaught: ReferenceError: x is not defined',
        ),
      }),
    ]);
  });

  test('formats Error arguments and survives unserializable values', () => {
    console.error = vi.fn();
    installConsoleCapture();

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    console.error(new TypeError('bad state'), circular);

    const [entry] = readCapturedConsoleEntries();
    expect(entry?.message).toContain('TypeError: bad state');
    expect(entry?.message).toContain('[object Object]');
  });

  test('reset restores the original console methods', () => {
    const originalError = vi.fn();
    console.error = originalError;
    installConsoleCapture();
    resetConsoleCaptureForTests();

    expect(console.error).toBe(originalError);
    console.error('after reset');
    expect(readCapturedConsoleEntries()).toEqual([]);
  });
});

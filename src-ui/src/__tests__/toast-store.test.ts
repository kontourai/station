import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { stripAnsi, toastStore } from '../contexts/ToastContext';

const ESC = String.fromCharCode(27);

describe('stripAnsi', () => {
  test('removes ANSI CSI color sequences from provider stderr', () => {
    const input = `${ESC}[2m2026-06-15${ESC}[0m ${ESC}[31mERROR${ESC}[0m boom`;
    expect(stripAnsi(input)).toBe('2026-06-15 ERROR boom');
  });

  test('leaves plain text and legitimate brackets untouched', () => {
    expect(stripAnsi('no codes [here] at all')).toBe('no codes [here] at all');
  });
});

describe('toastStore.show', () => {
  beforeEach(() => {
    toastStore.dismissAll();
    toastStore.clearHistory();
  });

  test('collapses identical messages into a single toast', () => {
    toastStore.show('refresh token failed', 's1', 100_000);
    toastStore.show('refresh token failed', 's1', 100_000);
    toastStore.show('refresh token failed', 's1', 100_000);
    expect(
      toastStore
        .getSnapshot()
        .filter((t) => t.message === 'refresh token failed'),
    ).toHaveLength(1);
  });

  test('strips ANSI from the stored toast message', () => {
    toastStore.show(`${ESC}[31mboom${ESC}[0m`, 's2', 100_000);
    const toast = toastStore.getSnapshot().find((t) => t.sessionId === 's2');
    expect(toast?.message).toBe('boom');
  });

  test('dismissAll removes every active toast at once', () => {
    toastStore.show('a', 's3', 100_000);
    toastStore.show('b', 's3', 100_000);
    expect(toastStore.getSnapshot().length).toBeGreaterThanOrEqual(2);
    toastStore.dismissAll();
    expect(toastStore.getSnapshot()).toHaveLength(0);
  });
});

/**
 * archive#4512 — `duration: 0` is the store's own "sticky,
 * no auto-dismiss" contract (`showToolApproval` never schedules a timeout
* at all). `show`'s NEW-toast path used to schedule `setTimeout(dismiss,
 * duration)` unconditionally, so `duration: 0` dismissed the toast on the
 * very next macrotask — faster than the 5-second default it was meant to
 * opt out of. A reviewer proved this with a direct probe; these pin the
 * fix at the STORE, which is what every `duration: 0` caller (not just the
 * restart-failure toast) depends on.
 */
describe('toastStore.show — duration: 0 is sticky', () => {
  beforeEach(() => {
    toastStore.dismissAll();
    toastStore.clearHistory();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('a duration: 0 toast survives every timer running out', () => {
    toastStore.show('restart failed', 's-b2-1', 0);
    expect(toastStore.getSnapshot().some((t) => t.sessionId === 's-b2-1')).toBe(
      true,
    );

    vi.runAllTimers();

    expect(toastStore.getSnapshot().some((t) => t.sessionId === 's-b2-1')).toBe(
      true,
    );
  });

  test('a positive duration still auto-dismisses', () => {
    toastStore.show('transient notice', 's-b2-2', 1_000);
    expect(toastStore.getSnapshot().some((t) => t.sessionId === 's-b2-2')).toBe(
      true,
    );

    vi.advanceTimersByTime(1_000);

    expect(toastStore.getSnapshot().some((t) => t.sessionId === 's-b2-2')).toBe(
      false,
    );
  });

  test('the dedupe (refresh-existing) path keeps its own duration:0 guard, unchanged', () => {
    toastStore.show('sticky duplicate', 's-b2-3', 0);
    toastStore.show('sticky duplicate', 's-b2-3', 0);

    expect(
      toastStore
        .getSnapshot()
        .filter(
          (t) => t.sessionId === 's-b2-3' && t.message === 'sticky duplicate',
        ),
    ).toHaveLength(1);

    vi.runAllTimers();

    expect(toastStore.getSnapshot().some((t) => t.sessionId === 's-b2-3')).toBe(
      true,
    );
  });
});

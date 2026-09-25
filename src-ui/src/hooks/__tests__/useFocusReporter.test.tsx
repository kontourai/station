/**
 * @vitest-environment jsdom
 */

import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ authenticatedFetch: vi.fn() }));

vi.mock('@kontourai/station-sdk', () => ({
  authenticatedFetch: mocks.authenticatedFetch,
}));
vi.mock('../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));

import { CLIENT_DOCUMENT_SESSION_ID } from '../clientDocumentSession';
import { FOCUS_HEARTBEAT_MS, FOCUS_REPORT_DEBOUNCE_MS } from '../focusReporter';
import { useFocusReporter } from '../useFocusReporter';

async function mount() {
  const rendered = renderHook(() => useFocusReporter());
  await vi.dynamicImportSettled();
  return rendered;
}

let visibility: DocumentVisibilityState = 'visible';
let focused = true;

function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  document.dispatchEvent(new Event('visibilitychange'));
}

function sentStates(): string[] {
  return mocks.authenticatedFetch.mock.calls.map(
    ([, init]) => JSON.parse(init.body).state,
  );
}

describe('useFocusReporter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    visibility = 'visible';
    focused = true;
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(
      () => visibility,
    );
    vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
    mocks.authenticatedFetch.mockReset().mockResolvedValue(new Response(null));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('reports the mounted state once, debounced, with this document session', async () => {
    await mount();
    vi.advanceTimersByTime(FOCUS_REPORT_DEBOUNCE_MS - 1);
    expect(mocks.authenticatedFetch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(mocks.authenticatedFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mocks.authenticatedFetch.mock.calls[0];
    expect(url).toBe('http://station.test/api/presence/focus');
    expect(init.method).toBe('POST');
    expect(init.headers['X-Station-Client-Session']).toBe(
      CLIENT_DOCUMENT_SESSION_ID,
    );
    expect(JSON.parse(init.body)).toEqual({
      clientSessionId: CLIENT_DOCUMENT_SESSION_ID,
      state: 'focused',
    });
  });

  test('a burst of blur/focus collapses into one report of the settled state', async () => {
    await mount();
    vi.advanceTimersByTime(FOCUS_REPORT_DEBOUNCE_MS);
    mocks.authenticatedFetch.mockClear();

    focused = false;
    window.dispatchEvent(new Event('blur'));
    vi.advanceTimersByTime(500);
    focused = true;
    window.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(500);
    focused = false;
    window.dispatchEvent(new Event('blur'));
    vi.advanceTimersByTime(FOCUS_REPORT_DEBOUNCE_MS);
    expect(sentStates()).toEqual(['visible']);

    // Settling back on the state already sent sends nothing.
    window.dispatchEvent(new Event('blur'));
    vi.advanceTimersByTime(FOCUS_REPORT_DEBOUNCE_MS);
    expect(sentStates()).toEqual(['visible']);
  });

  test('becoming hidden is reported at once, not after the debounce', async () => {
    await mount();
    vi.advanceTimersByTime(FOCUS_REPORT_DEBOUNCE_MS);
    mocks.authenticatedFetch.mockClear();

    setVisibility('hidden');
    expect(sentStates()).toEqual(['hidden']);

    setVisibility('visible');
    vi.advanceTimersByTime(FOCUS_REPORT_DEBOUNCE_MS);
    expect(sentStates()).toEqual(['hidden', 'focused']);
  });

  test('pagehide reports hidden even while the document still reads visible', async () => {
    await mount();
    vi.advanceTimersByTime(FOCUS_REPORT_DEBOUNCE_MS);
    mocks.authenticatedFetch.mockClear();
    window.dispatchEvent(new Event('pagehide'));
    expect(sentStates()).toEqual(['hidden']);
  });

  test('the focused heartbeat runs only while there was input in the last 2 minutes', async () => {
    await mount();
    vi.advanceTimersByTime(FOCUS_REPORT_DEBOUNCE_MS);
    mocks.authenticatedFetch.mockClear();

    // No input since mount: the heartbeat stays silent.
    vi.advanceTimersByTime(FOCUS_HEARTBEAT_MS);
    expect(sentStates()).toEqual([]);

    window.dispatchEvent(new Event('keydown'));
    vi.advanceTimersByTime(FOCUS_HEARTBEAT_MS);
    expect(sentStates()).toEqual(['focused']);
    vi.advanceTimersByTime(FOCUS_HEARTBEAT_MS);
    expect(sentStates()).toEqual(['focused', 'focused']);

    // Input is now over 2 minutes old: the lease is left to lapse.
    vi.advanceTimersByTime(FOCUS_HEARTBEAT_MS);
    expect(sentStates()).toEqual(['focused', 'focused']);
  });

  test('no heartbeat while not focused, even with recent input', async () => {
    await mount();
    vi.advanceTimersByTime(FOCUS_REPORT_DEBOUNCE_MS);
    mocks.authenticatedFetch.mockClear();
    focused = false;
    window.dispatchEvent(new Event('pointerdown'));
    vi.advanceTimersByTime(FOCUS_HEARTBEAT_MS);
    expect(sentStates()).toEqual([]);
  });

  test('unmounting before the reporter loads never starts it', async () => {
    const { unmount } = renderHook(() => useFocusReporter());
    unmount();
    await vi.dynamicImportSettled();
    setVisibility('hidden');
    vi.advanceTimersByTime(FOCUS_HEARTBEAT_MS * 3);
    expect(mocks.authenticatedFetch).not.toHaveBeenCalled();
  });

  test('unmounting stops every report', async () => {
    const { unmount } = await mount();
    unmount();
    window.dispatchEvent(new Event('keydown'));
    setVisibility('hidden');
    window.dispatchEvent(new Event('pagehide'));
    vi.advanceTimersByTime(FOCUS_HEARTBEAT_MS * 3);
    expect(mocks.authenticatedFetch).not.toHaveBeenCalled();
  });

  test('a failing or throwing send never escapes', async () => {
    mocks.authenticatedFetch.mockImplementationOnce(() => {
      throw new Error('read-only');
    });
    await mount();
    expect(() =>
      vi.advanceTimersByTime(FOCUS_REPORT_DEBOUNCE_MS),
    ).not.toThrow();
    mocks.authenticatedFetch.mockRejectedValueOnce(new Error('offline'));
    expect(() => setVisibility('hidden')).not.toThrow();
    await vi.runOnlyPendingTimersAsync();
    expect(sentStates()).toEqual(['focused', 'hidden']);
  });
});

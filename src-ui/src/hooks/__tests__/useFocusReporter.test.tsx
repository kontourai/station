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

let visibility: DocumentVisibilityState = 'visible';
let focused = true;

const ok = () => new Response(null, { status: 204 });
const status = (code: number, headers?: Record<string, string>) =>
  new Response(null, { status: code, headers });

async function mount() {
  const rendered = renderHook(() => useFocusReporter());
  await vi.dynamicImportSettled();
  return rendered;
}

/** Advances fake time and lets every resulting send settle. */
async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

async function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  document.dispatchEvent(new Event('visibilitychange'));
  await advance(0);
}

async function fire(target: EventTarget, type: string) {
  target.dispatchEvent(new Event(type));
  await advance(0);
}

function sentStates(): string[] {
  return mocks.authenticatedFetch.mock.calls.map(
    ([, init]) => JSON.parse(init.body).state,
  );
}

/** Mounts, lets the initial report land, and clears the call log. */
async function mountSettled() {
  const rendered = await mount();
  await advance(FOCUS_REPORT_DEBOUNCE_MS);
  mocks.authenticatedFetch.mockClear();
  return rendered;
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
    mocks.authenticatedFetch.mockReset().mockImplementation(async () => ok());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('reports the mounted state once, debounced, naming this document in header and body', async () => {
    await mount();
    await advance(FOCUS_REPORT_DEBOUNCE_MS - 1);
    expect(mocks.authenticatedFetch).not.toHaveBeenCalled();
    await advance(1);
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
    await mountSettled();
    focused = false;
    await fire(window, 'blur');
    await advance(500);
    focused = true;
    await fire(window, 'focus');
    await advance(500);
    focused = false;
    await fire(window, 'blur');
    await advance(FOCUS_REPORT_DEBOUNCE_MS);
    expect(sentStates()).toEqual(['visible']);

    // Settling back on the state already accepted sends nothing.
    await fire(window, 'blur');
    await advance(FOCUS_REPORT_DEBOUNCE_MS);
    expect(sentStates()).toEqual(['visible']);
  });

  test('becoming hidden is reported at once, not after the debounce', async () => {
    await mountSettled();
    await setVisibility('hidden');
    expect(sentStates()).toEqual(['hidden']);
    await setVisibility('visible');
    await advance(FOCUS_REPORT_DEBOUNCE_MS);
    expect(sentStates()).toEqual(['hidden', 'focused']);
  });

  test('pagehide reports hidden even while the document still reads visible', async () => {
    await mountSettled();
    await fire(window, 'pagehide');
    expect(sentStates()).toEqual(['hidden']);
  });

  test('a rate-limited hidden is resent after Retry-After until accepted', async () => {
    await mountSettled();
    mocks.authenticatedFetch.mockImplementationOnce(async () =>
      status(429, { 'Retry-After': '7' }),
    );
    await setVisibility('hidden');
    expect(sentStates()).toEqual(['hidden']);
    await advance(6_999);
    expect(sentStates()).toEqual(['hidden']);
    await advance(1);
    expect(sentStates()).toEqual(['hidden', 'hidden']);
    // Accepted now: nothing further is sent for the same state.
    await advance(FOCUS_HEARTBEAT_MS);
    expect(sentStates()).toEqual(['hidden', 'hidden']);
  });

  test('a lowering report that fails transiently is retried with backoff', async () => {
    await mountSettled();
    mocks.authenticatedFetch
      .mockImplementationOnce(async () => {
        throw new Error('offline');
      })
      .mockImplementationOnce(async () => status(503));
    await setVisibility('hidden');
    await advance(2_000);
    expect(sentStates()).toEqual(['hidden', 'hidden']);
    await advance(3_999);
    expect(sentStates()).toEqual(['hidden', 'hidden']);
    await advance(1);
    expect(sentStates()).toEqual(['hidden', 'hidden', 'hidden']);
  });

  test('a 401 is not retried on a timer, but the next state change resends', async () => {
    mocks.authenticatedFetch.mockImplementationOnce(async () => status(401));
    await mount();
    await advance(FOCUS_REPORT_DEBOUNCE_MS);
    expect(sentStates()).toEqual(['focused']);
    await advance(30_000);
    expect(sentStates()).toEqual(['focused']);

    focused = false;
    await fire(window, 'blur');
    await advance(FOCUS_REPORT_DEBOUNCE_MS);
    expect(sentStates()).toEqual(['focused', 'visible']);
  });

  test('the focused heartbeat runs only while there was input in the last 2 minutes', async () => {
    await mountSettled();
    await advance(FOCUS_HEARTBEAT_MS);
    expect(sentStates()).toEqual([]);

    await fire(window, 'keydown');
    await advance(FOCUS_HEARTBEAT_MS);
    expect(sentStates()).toEqual(['focused']);
    await advance(FOCUS_HEARTBEAT_MS);
    expect(sentStates()).toEqual(['focused', 'focused']);
    // Input is now over 2 minutes old: the lease is left to lapse.
    await advance(FOCUS_HEARTBEAT_MS);
    expect(sentStates()).toEqual(['focused', 'focused']);
  });

  test('the first input after the lease lapsed renews it at once', async () => {
    await mountSettled();
    await advance(120_000);
    expect(sentStates()).toEqual([]);
    await fire(window, 'pointermove');
    expect(sentStates()).toEqual(['focused']);
    // Only once: the renewed lease is fresh again.
    await fire(window, 'pointermove');
    expect(sentStates()).toEqual(['focused']);
  });

  test('no heartbeat while not focused, even with recent input', async () => {
    await mountSettled();
    focused = false;
    await fire(window, 'pointerdown');
    await advance(FOCUS_HEARTBEAT_MS);
    expect(sentStates()).toEqual([]);
  });

  test('unmounting before the reporter loads never starts it', async () => {
    const { unmount } = renderHook(() => useFocusReporter());
    unmount();
    await vi.dynamicImportSettled();
    await setVisibility('hidden');
    await advance(FOCUS_HEARTBEAT_MS * 3);
    expect(mocks.authenticatedFetch).not.toHaveBeenCalled();
  });

  test('unmounting stops every report and retry', async () => {
    const { unmount } = await mount();
    mocks.authenticatedFetch.mockImplementation(async () => status(503));
    await advance(FOCUS_REPORT_DEBOUNCE_MS);
    mocks.authenticatedFetch.mockClear();
    unmount();
    await fire(window, 'keydown');
    await setVisibility('hidden');
    await fire(window, 'pagehide');
    await advance(FOCUS_HEARTBEAT_MS * 3);
    expect(mocks.authenticatedFetch).not.toHaveBeenCalled();
  });

  test('a throwing send never escapes', async () => {
    mocks.authenticatedFetch.mockImplementationOnce(() => {
      throw new Error('read-only');
    });
    await mount();
    await expect(advance(FOCUS_REPORT_DEBOUNCE_MS)).resolves.toBeUndefined();
    await expect(setVisibility('hidden')).resolves.toBeUndefined();
    expect(sentStates()).toEqual(['focused', 'hidden']);
  });
});

/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  capturedShareToken,
  captureShareToken,
  reloadSharePage,
  resetCapturedShareTokenForTests,
} from '../views/share/share-token';

/**
 * archive#1423 L-3 +. Scrubbing the token from the address bar is only
 * honest if it does not silently break the page's own recovery paths — the
 * error boundary's Reload and an ordinary refresh both re-read the URL.
 */

const TOKEN = 'a'.repeat(43);

afterEach(() => {
  resetCapturedShareTokenForTests();
  window.location.hash = '';
  vi.restoreAllMocks();
});

describe('share-token', () => {
  it('reads the token and clears the fragment', () => {
    window.location.hash = `#t=${TOKEN}`;
    expect(captureShareToken()).toBe(TOKEN);
    expect(window.location.hash).toBe('');
  });

  it('keeps answering after the fragment is gone, so a re-mount still works', () => {
    window.location.hash = `#t=${TOKEN}`;
    captureShareToken();
    // The boundary retrying, or StrictMode's double render, must not conclude
    // the link was incomplete.
    expect(captureShareToken()).toBe(TOKEN);
    expect(capturedShareToken()).toBe(TOKEN);
  });

  it('reports no token for a link that never carried one', () => {
    window.location.hash = '';
    expect(captureShareToken()).toBeUndefined();
    expect(capturedShareToken()).toBeUndefined();
  });

  it('ignores a malformed fragment rather than capturing garbage', () => {
    window.location.hash = '#t=not a token!!';
    expect(captureShareToken()).toBeUndefined();
  });

  it('restores the fragment before reloading, so Reload can actually recover', () => {
    window.location.hash = `#t=${TOKEN}`;
    captureShareToken();
    expect(window.location.hash).toBe('');

    const reload = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload, hash: '' },
    });

    reloadSharePage();
    // Without this the boundary's Reload button was guaranteed to land on the
    // missing-token state — a recovery affordance that always fails.
    expect(window.location.hash).toBe(`t=${TOKEN}`);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('still reloads when there was never a token to restore', () => {
    const reload = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload, hash: '' },
    });
    reloadSharePage();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

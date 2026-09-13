/**
 * @vitest-environment jsdom
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { MOBILE_MEDIA_QUERY, useIsMobile } from '../hooks/useIsMobile';

type Listener = (event: MediaQueryListEvent) => void;

/**
 * Installs a controllable matchMedia mock and returns a setter that flips the
 * match state and notifies subscribed listeners (mimicking a viewport resize
 * crossing the breakpoint).
 */
function installMatchMedia(initialMatches: boolean) {
  let matches = initialMatches;
  const listeners = new Set<Listener>();

  const mql = {
    get matches() {
      return matches;
    },
    media: MOBILE_MEDIA_QUERY,
    addEventListener: (_type: 'change', cb: Listener) => listeners.add(cb),
    removeEventListener: (_type: 'change', cb: Listener) =>
      listeners.delete(cb),
    // Legacy API (unused, kept for completeness)
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
    onchange: null,
  };

  const matchMedia = vi.fn().mockReturnValue(mql);
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: matchMedia,
  });

  return {
    setMatches(next: boolean) {
      matches = next;
      const event = { matches: next } as MediaQueryListEvent;
      for (const cb of listeners) cb(event);
    },
    listenerCount: () => listeners.size,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useIsMobile', () => {
  test('reports false when the viewport is above the breakpoint', () => {
    installMatchMedia(false);
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);
  });

  test('reports true when the viewport is at or below the breakpoint', () => {
    installMatchMedia(true);
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(true);
  });

  test('toggles when the media query changes', () => {
    const mq = installMatchMedia(false);
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);

    act(() => mq.setMatches(true));
    expect(result.current).toBe(true);

    act(() => mq.setMatches(false));
    expect(result.current).toBe(false);
  });

  test('unsubscribes on unmount', () => {
    const mq = installMatchMedia(false);
    const { unmount } = renderHook(() => useIsMobile());
    expect(mq.listenerCount()).toBe(1);
    unmount();
    expect(mq.listenerCount()).toBe(0);
  });

  test('is SSR/jsdom-safe when matchMedia is unavailable', () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: undefined,
    });
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);
  });
});

/**
 * General mobile layout uses the complete query; a short-window adaptation
 * can use its exact height-and-pointer branch. Until archive#3928 nothing
 * checked agreement with the hook. A dock slice widened the constant to
 * `(max-width: 768px), (pointer: coarse)` to answer a dock question, leaving
 * the stylesheets on the old condition and the docblock asserting a match that
 * no longer held — so a touchscreen laptop would have taken desktop CSS and
 * mobile component behaviour at the same time.
 *
 * A claim in a comment is not a guarantee. This is the guarantee.
 */
function isSharedMobileCondition(condition: string) {
  const desktopGuard =
    '(min-width: 769px) and (not ((max-height: 540px) and (pointer: coarse)))';
  const shortViewportBranch = MOBILE_MEDIA_QUERY.split(',')
    .map((clause) => clause.trim())
    .find((clause) => clause.startsWith('(max-height:'));
  return (
    condition === MOBILE_MEDIA_QUERY ||
    condition === desktopGuard ||
    condition === shortViewportBranch
  );
}

test('mobile stylesheet conditions agree with the shared mobile classification', () => {
  const css = readFileSync(join(process.cwd(), 'src-ui/src/index.css'), 'utf8');
  const conditions = [...css.matchAll(/@media ([^{]+)\{/g)].map((match) =>
    match[1].trim(),
  );

  // General layout must still cover the entire mobile population. Short-window
  // overrides narrow that population using the same height/pointer branch.
  expect(conditions).toContain(MOBILE_MEDIA_QUERY);

  const mobileShaped = conditions.filter(
    (condition) =>
      condition.includes('pointer: coarse') ||
      condition.includes('max-width: 768px'),
  );
  expect(
    mobileShaped.length,
    'index.css must still carry the mobile breakpoint blocks this constant mirrors',
  ).toBeGreaterThan(0);

  for (const condition of mobileShaped)
    expect(
      isSharedMobileCondition(condition),
      `"${condition}" disagrees with the shared mobile classification`,
    ).toBe(true);
});

test.each([
  '(max-width: 768px)',
  '(pointer: coarse)',
  '(max-width: 768px), (pointer: coarse)',
  '(max-height: 600px) and (pointer: coarse)',
  '(max-width: 767px), (max-height: 540px) and (pointer: coarse)',
  '(min-width: 769px) and (not ((max-height: 600px) and (pointer: coarse)))',
])('rejects an inconsistent mobile condition: %s', (condition) => {
  expect(isSharedMobileCondition(condition)).toBe(false);
});

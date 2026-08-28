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
 * The literal's own docblock says it "must stay byte-identical to the
 * condition on every mobile `@media` block across the stylesheets", and until
 * archive#3928 nothing computed that. A dock slice widened the constant to
 * `(max-width: 768px), (pointer: coarse)` to answer a dock question, leaving
 * the stylesheets on the old condition and the docblock asserting a match that
 * no longer held — so a touchscreen laptop would have taken desktop CSS and
 * mobile component behaviour at the same time.
 *
 * A claim in a comment is not a guarantee. This is the guarantee.
 */
test('every mobile @media block in index.css spells MOBILE_MEDIA_QUERY exactly', () => {
  const css = readFileSync(join(process.cwd(), 'src-ui/src/index.css'), 'utf8');
  const conditions = [...css.matchAll(/@media ([^{]+)\{/g)].map((match) =>
    match[1].trim(),
  );

  // The two forms this constant is allowed to appear in: the mobile blocks
  // themselves, and the desktop blocks guarded by the negation of its second
  // clause (a landscape phone matches BOTH width conditions, so the desktop
  // rules have to opt out explicitly).
  const desktopGuard =
    '(min-width: 769px) and (not ((max-height: 540px) and (pointer: coarse)))';

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
      condition === MOBILE_MEDIA_QUERY || condition === desktopGuard,
      `"${condition}" is neither MOBILE_MEDIA_QUERY nor its documented desktop negation`,
    ).toBe(true);
});

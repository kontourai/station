/**
 * @vitest-environment jsdom
 */
import { act, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  resetScrollMemoryForTests,
  useScrollRestoration,
} from '../useScrollRestoration';

/**
 *measured on the audited build:
 *
 * | step |.content-view.scrollTop |
 * | /settings scrolled (scrollHeight 8428) | 3000                    |
 * | → /registry                            | 0                       |
 * | → back to /settings                    | 0  ← position lost      |
 * | browser Back → /registry               | 0                       |
 *
 * EVERY test here runs against a container that CLAMPS `scrollTop` to what it
 * can currently hold, because a real one does and jsdom does not. That is not
 * decoration: an earlier version of this hook passed a full suite against
 * jsdom's unclamped `scrollTop` and restored nothing in a browser. It saved
 * the outgoing route's offset in a layout effect, by which point React had
 * already swapped the route for a suspense skeleton, the container had
 * collapsed, and the read returned the browser's clamped 0 — overwriting the
 * real offset the scroll listener had recorded moments earlier.
 *
 * `capacity` below is the scrollable extent the container has RIGHT NOW: it
 * drops to 0 when a route is swapped for its skeleton and grows as the next
 * route's content arrives. `scrollHeight`/`clientHeight` are derived from it,
 * because those are what the restore now consults instead of writing
 * `scrollTop` and reading it back every animation frame.
 */
const CLIENT_HEIGHT = 820;

function Harness({ routeKey }: { routeKey: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useScrollRestoration(ref, routeKey);
  return <div data-testid="scroller" ref={ref} />;
}

function clampingScroller(container: HTMLElement) {
  const element = container.querySelector<HTMLDivElement>(
    '[data-testid="scroller"]',
  ) as HTMLDivElement;
  let capacity = 0;
  let position = 0;
  Object.defineProperty(element, 'clientHeight', {
    configurable: true,
    get: () => CLIENT_HEIGHT,
  });
  Object.defineProperty(element, 'scrollHeight', {
    configurable: true,
    get: () => capacity + CLIENT_HEIGHT,
  });
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    get: () => Math.min(position, capacity),
    set: (value: number) => {
      position = Math.max(0, Math.min(value, capacity));
    },
  });
  return {
    element,
    /** Route content arrived, or was swapped out (0). */
    setCapacity(next: number) {
      capacity = next;
      position = Math.min(position, capacity);
    },
    /** The user scrolls, which a browser reports with a `scroll` event. */
    userScrollTo(next: number) {
      element.scrollTop = next;
      element.dispatchEvent(new Event('scroll'));
    },
    /** Code scrolls the container. A browser dispatches `scroll` LATER. */
    programmaticScrollTo(next: number) {
      element.scrollTop = next;
    },
  };
}

/** Advances the coarse backstop poll. */
function poll(times = 1) {
  for (let i = 0; i < times; i++) {
    act(() => {
      vi.advanceTimersByTime(250);
    });
  }
}

/** Captures the ResizeObserver callbacks so a content-size signal can be fired
 *  without waiting for the poll — jsdom has no ResizeObserver at all. */
function installResizeObserver() {
  const callbacks: Array<() => void> = [];
  class FakeResizeObserver {
    constructor(callback: () => void) {
      callbacks.push(callback);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  return {
    /** Content resized — what a real observer reports, after layout. */
    fire() {
      act(() => {
        for (const callback of callbacks) callback();
      });
    },
  };
}

describe('useScrollRestoration', () => {
  beforeEach(() => {
    resetScrollMemoryForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test('restores the position across a route swap that collapses the container', () => {
    const { container, rerender } = render(<Harness routeKey="/settings" />);
    const scroller = clampingScroller(container);
    scroller.setCapacity(8428);
    scroller.userScrollTo(3000);
    expect(scroller.element.scrollTop).toBe(3000);

    // Leaving: React replaces the route with a skeleton, so the container has
    // nothing left to scroll.
    scroller.setCapacity(0);
    rerender(<Harness routeKey="/registry" />);
    scroller.setCapacity(972);
    poll();
    expect(scroller.element.scrollTop).toBe(0);

    // Returning: the route mounts empty and fills in over several seconds.
    scroller.setCapacity(0);
    rerender(<Harness routeKey="/settings" />);
    poll(2);
    expect(scroller.element.scrollTop).toBe(0);

    scroller.setCapacity(8428);
    poll();
    expect(scroller.element.scrollTop).toBe(3000);
  });

  test('restores on a content-size signal without waiting for the poll', () => {
    // the restore used to write AND read `scrollTop` every animation
    // frame until the content could hold it — a forced layout up to ~60x/s
    // for up to eight seconds, precisely while the route was assembling. It
    // now waits for the content to say it grew.
    const resize = installResizeObserver();
    const { container, rerender } = render(<Harness routeKey="/settings" />);
    const scroller = clampingScroller(container);
    scroller.setCapacity(8428);
    scroller.userScrollTo(3000);
    scroller.setCapacity(0);
    rerender(<Harness routeKey="/registry" />);
    scroller.setCapacity(0);
    rerender(<Harness routeKey="/settings" />);

    resize.fire();
    expect(scroller.element.scrollTop).toBe(0);

    scroller.setCapacity(8428);
    resize.fire();
    // No timer was advanced at any point in this test.
    expect(scroller.element.scrollTop).toBe(3000);
  });

  test('never writes a scrollTop the container cannot hold', () => {
    // The capacity check is what removes the write-then-read-back probe: a
    // write that would be clamped is never issued at all.
    const { container, rerender } = render(<Harness routeKey="/settings" />);
    const scroller = clampingScroller(container);
    scroller.setCapacity(8428);
    scroller.userScrollTo(3000);
    scroller.setCapacity(0);
    rerender(<Harness routeKey="/registry" />);
    scroller.setCapacity(0);
    rerender(<Harness routeKey="/settings" />);

    const writes: number[] = [];
    const real = Object.getOwnPropertyDescriptor(
      scroller.element,
      'scrollTop',
    ) as PropertyDescriptor;
    Object.defineProperty(scroller.element, 'scrollTop', {
      configurable: true,
      get: real.get,
      set: (value: number) => {
        writes.push(value);
        real.set?.call(scroller.element, value);
      },
    });

    scroller.setCapacity(1000); // grew, but still cannot hold 3000
    poll(3);
    expect(writes).toEqual([]);

    scroller.setCapacity(8428);
    poll();
    expect(writes).toEqual([3000]);
  });

  test('saves the position on navigation intent, before the route swap', () => {
    // the scroll listener was the only save path, and a browser
    // dispatches `scroll` asynchronously. Code that scrolls the container and
    // navigates in the same task therefore navigated before the save could
    // happen. `navigationStore.navigate` dispatches `popstate` synchronously
    // while the outgoing route is still mounted, so that is where the last
    // position is caught.
    const { container, rerender } = render(<Harness routeKey="/settings" />);
    const scroller = clampingScroller(container);
    scroller.setCapacity(8428);
    scroller.programmaticScrollTo(3000); // no `scroll` event dispatched
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    scroller.setCapacity(0);
    rerender(<Harness routeKey="/registry" />);
    scroller.setCapacity(0);
    rerender(<Harness routeKey="/settings" />);
    scroller.setCapacity(8428);
    poll();
    expect(scroller.element.scrollTop).toBe(3000);
  });

  test('a route the user has never opened starts at the top', () => {
    const { container, rerender } = render(<Harness routeKey="/settings" />);
    const scroller = clampingScroller(container);
    scroller.setCapacity(8428);
    scroller.userScrollTo(3000);

    scroller.setCapacity(0);
    rerender(<Harness routeKey="/guidance" />);
    scroller.setCapacity(5000);
    poll();
    expect(scroller.element.scrollTop).toBe(0);
  });

  test('a route the user scrolled back to the top of stays at the top', () => {
    const { container, rerender } = render(<Harness routeKey="/settings" />);
    const scroller = clampingScroller(container);
    scroller.setCapacity(8428);
    scroller.userScrollTo(3000);
    scroller.userScrollTo(0);

    scroller.setCapacity(0);
    rerender(<Harness routeKey="/registry" />);
    scroller.setCapacity(0);
    rerender(<Harness routeKey="/settings" />);
    scroller.setCapacity(8428);
    poll();
    expect(scroller.element.scrollTop).toBe(0);
  });

  test('gives up rather than jumping the user after the retry window closes', () => {
    const { container, rerender } = render(<Harness routeKey="/settings" />);
    const scroller = clampingScroller(container);
    scroller.setCapacity(8428);
    scroller.userScrollTo(3000);
    scroller.setCapacity(0);
    rerender(<Harness routeKey="/registry" />);
    scroller.setCapacity(0);
    rerender(<Harness routeKey="/settings" />);

    poll(40); // 10s, past the 8s window
    scroller.setCapacity(8428);
    poll(2);
    expect(scroller.element.scrollTop).toBe(0);
  });

  test('stops waiting as soon as the user scrolls for themselves', () => {
    const { container, rerender } = render(<Harness routeKey="/settings" />);
    const scroller = clampingScroller(container);
    scroller.setCapacity(8428);
    scroller.userScrollTo(3000);
    scroller.setCapacity(0);
    rerender(<Harness routeKey="/registry" />);
    scroller.setCapacity(0);
    rerender(<Harness routeKey="/settings" />);

    poll();
    act(() => {
      scroller.element.dispatchEvent(new Event('wheel'));
    });

    scroller.setCapacity(8428);
    poll(2);
    expect(scroller.element.scrollTop).toBe(0);
  });
});

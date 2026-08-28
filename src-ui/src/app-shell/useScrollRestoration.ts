import { type RefObject, useEffect, useLayoutEffect, useRef } from 'react';

/**
 * Per-route scroll memory for the shell's single scroll container
 * (`.content-view`).
 *
 * Measured before this existed: `/settings` scrolled to 3000 (of an 8,246 px
 * column), navigate away and back → 0. Browser Back → 0. Neither in-app
 * navigation nor history restored anything, so returning to Settings after
 * checking one thing put the user 8,000 px from where they were.
 *
 * Keyed on pathname, which covers both directions with one rule: an in-app
 * navigation back to a route the user has already scrolled restores that
 * scroll, a route with no recorded position starts at the top, and browser
 * Back is not a special case because it lands on a pathname like any other.
 */
const positions = new Map<string, number>();

/** Bounded so a long session of parameterised routes cannot grow it forever. */
const MAX_REMEMBERED_ROUTES = 50;

/**
 * How long to keep waiting for a route to grow enough to hold a restored
 * offset before giving up. Route content arrives asynchronously, so the
 * container is usually still short when the route mounts.
 *
 * Eight seconds, not the two this shipped with first: at two seconds it did
 * not restore Settings at runtime. Settings' 8,705 px column is still
 * arriving then — the audit measured route content settling 4.0–7.0 s
 * (SHELL-21).
 */
const RESTORE_WINDOW_MS = 8000;

/**
 * Backstop poll while waiting. The restore is driven by content-size signals
 * (`ResizeObserver` on the container's content, `MutationObserver` on the
 * route swap); this only covers growth neither observer reports, so it is
 * deliberately coarse. It replaces a `requestAnimationFrame` loop that wrote
 * AND read `scrollTop` every frame — a forced layout up to ~60×/s for up to
 * the full window, precisely while the route was assembling.
 */
const RESTORE_POLL_MS = 250;

function remember(key: string, top: number) {
  // Re-insert so the map's iteration order is least-recently-used first.
  positions.delete(key);
  positions.set(key, top);
  while (positions.size > MAX_REMEMBERED_ROUTES) {
    const oldest = positions.keys().next();
    if (oldest.done) break;
    positions.delete(oldest.value);
  }
}

/** Test seam: the memory is module state, and a test that asserts a restore
 *  must be able to start from a known one. */
export function resetScrollMemoryForTests() {
  positions.clear();
}

export function useScrollRestoration(
  containerRef: RefObject<HTMLElement | null>,
  routeKey: string,
) {
  // The key the scroll listener attributes movement to. Held in a ref because
  // the listener is registered once: reading `routeKey` from the closure would
  // record the NEW route's scroll under the OLD route's key for the frames
  // between a route change and the listener being re-registered.
  const activeKeyRef = useRef(routeKey);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const save = () => {
      remember(activeKeyRef.current, element.scrollTop);
    };
    element.addEventListener('scroll', save, { passive: true });
    // Navigation intent, saved BEFORE the route swap. `navigationStore.
    // navigate` pushes the URL and dispatches `popstate` synchronously,
    // and React's resulting re-render is scheduled rather than applied, so
    // the container still holds the outgoing route's content here and its
    // `scrollTop` is still true. A `scroll` event is the only other save
    // path, and it is asynchronous: code that scrolls the container and
    // navigates in the same task (a deep-link handler, a "jump to section
    // then open the item" flow) navigates before the browser has dispatched
    // the scroll, and that position would otherwise be lost.
    window.addEventListener('popstate', save);
    return () => {
      element.removeEventListener('scroll', save);
      window.removeEventListener('popstate', save);
    };
  }, [containerRef]);

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    // The `scroll` listener is the ONLY writer. Recording the outgoing route's
    // offset here as well is what broke the first version of this at runtime:
    // by the time a layout effect runs, React has already replaced the route's
    // content with a suspense skeleton, the container's scrollHeight has
    // collapsed, and reading `scrollTop` forces the layout that clamps it to
    // 0 — so the "save" overwrote the real 3000 the listener had recorded a
    // moment earlier with the browser's clamp. Nothing above the DOM can see
    // that: jsdom has no layout and never clamps, so the unit test passed.
    activeKeyRef.current = routeKey;

    const target = positions.get(routeKey) ?? 0;
    element.scrollTop = target;
    if (target === 0) return;

    let settled = false;
    let poll = 0;
    let resizes: ResizeObserver | null = null;
    let swaps: MutationObserver | null = null;
    const deadline = performance.now() + RESTORE_WINDOW_MS;

    const userEvents = [
      'wheel',
      'touchstart',
      'keydown',
      'pointerdown',
    ] as const;

    const stop = () => {
      settled = true;
      resizes?.disconnect();
      swaps?.disconnect();
      if (poll) {
        clearInterval(poll);
        poll = 0;
      }
      for (const type of userEvents) {
        element.removeEventListener(type, stop);
      }
    };

    // A user who scrolls while the restore is still waiting owns the scroll
    // from that moment — writing `scrollTop` after that would fight them.
    // Only genuine user input stops it; the container's own `scroll` events
    // are what this restore causes.
    for (const type of userEvents) {
      element.addEventListener(type, stop, { passive: true });
    }

    /** The route's content is the thing that grows; the container's own box
     *  is a fixed-height flex child and never changes as content arrives.
     *  `observe` is idempotent, so re-observing after a swap is safe. */
    const observeContent = () => {
      if (!resizes) return;
      resizes.observe(element);
      for (const child of element.children) resizes.observe(child);
    };

    /**
     * Restore only once the container can actually hold the offset. Checking
     * capacity first is what removes the write-then-read-back probe: a write
     * the browser would clamp is never issued, and `scrollHeight` is read on
     * events that already follow layout rather than ahead of it.
     */
    const attempt = () => {
      if (settled) return;
      if (performance.now() >= deadline) {
        stop();
        return;
      }
      observeContent();
      if (element.scrollHeight < target + element.clientHeight) return;
      element.scrollTop = target;
      stop();
    };

    if (typeof ResizeObserver !== 'undefined') {
      resizes = new ResizeObserver(attempt);
    }
    swaps = new MutationObserver(attempt);
    swaps.observe(element, { childList: true });
    poll = window.setInterval(attempt, RESTORE_POLL_MS);
    attempt();

    return stop;
  }, [containerRef, routeKey]);
}

/**
 * Move the reader to a region of Home that is already on the page.
 *
 * Home's counts and its chart describe populations Home itself renders, and
 * nothing outside Home can be navigated to with those populations applied:
 * `/activity` takes only `?session=<id>` (`app-shell/routing.ts`), and its
 * project filter is component state with no route parameter, so every
 * external destination would land on an unfiltered list. Revealing the exact
 * lane the number counted is the destination that is actually true.
 *
 * Returns whether the target existed. Callers must not offer a control whose
 * target may be absent — the count and its target are derived from the same
 * lane — but the boolean keeps that assumption testable rather than assumed.
 */
export function revealHomeRegion(id: string): boolean {
  if (typeof document === 'undefined') return false;
  const target = document.getElementById(id);
  if (!target) return false;
  // No `behavior: 'smooth'`: every other scroll-to in this UI is a plain
  // positioned scroll, and jsdom implements none of it, hence the guard.
  if (typeof target.scrollIntoView === 'function') {
    target.scrollIntoView({ block: 'start' });
  }
  // Focus, not just scroll: a keyboard or screen-reader user who activates
  // "Just finished, 20" must land IN the lane, not merely have it painted
  // somewhere behind their still-parked focus ring.
  target.focus({ preventScroll: true });
  return true;
}

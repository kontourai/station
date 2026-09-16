/**
 * @vitest-environment jsdom
 */

/**
 * #2158 — a chip menu whose chunk fails to load must be retried by the next
 * gesture, not latched off for the life of the row.
 *
 * THE DEFECT THIS PINS, found in review after it had shipped once:
 * `ProjectLayoutChips` renders the menu behind a `LazyBoundary` and passes
 * `unavailable={() => null}`, which discards the boundary's own `onRetry` — an
 * error card with two buttons planted in a 240px rail is a worse answer for a
 * menu than no menu, and nothing in the rail could dismiss it. That leaves the
 * boundary's `attempt` frozen, and re-opening does not unmount it either:
 * right-clicking the same chip writes the `menuFor` value it already holds and
 * React bails out, while a different chip only changes the boundary's props.
 * One failed fetch and the menu was off, silently, while the component's own
 * docblock claimed the next right-click retried. The fix is a `key` the
 * gesture owns.
 *
 * WHY THIS IS ITS OWN FILE. Making a dynamic import reject needs the module
 * mocked. Doing it inline with `vi.doMock`/`vi.doUnmock` inside the panel's
 * shared suite leaked into whichever case ran next — observed on two different
 * neighbours depending on the corpus, which is the module-registry edit, not a
 * flake. Declared ONCE here, with a flag the test flips, there is no edit to
 * leak: a factory that throws caches nothing, so the next import re-runs it
 * and reads the flag again. That is also exactly the shape of the thing under
 * test — a fetch that fails once and then succeeds.
 *
 * The strip is driven directly, which its own docblock invites: what is under
 * test is the boundary's lifecycle, and `ProjectSidebarRow`'s construction of
 * the id is pinned by the panel suite and by `pill-region-placement.test.ts`.
 */
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * Whether the menu's chunk is currently unavailable, and how many times
 * anything has tried to load it.
 *
 * `attempts` is the observable that makes this test about the MECHANISM rather
 * than about a render: the defect is that a second gesture never re-ran the
 * import, so the count staying at 1 IS the bug, independently of what the DOM
 * shows or how long anything waited.
 */
const chunk = vi.hoisted(() => ({ fails: false, attempts: 0 }));
vi.mock('../ProjectLayoutChipMenu', async (importActual) => {
  chunk.attempts += 1;
  if (chunk.fails) throw new Error('chunk unavailable');
  return await importActual<typeof import('../ProjectLayoutChipMenu')>();
});

const openSurfaceInRegion = vi.hoisted(() => vi.fn());
vi.mock('../../../contexts/RegionModelContext', () => ({
  useRegionModelOptional: () => ({ openSurfaceInRegion }),
}));

import { ProjectLayoutChips } from '../ProjectLayoutChips';

const SURFACE_ID =
  'layout:9f1d2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b/1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

function renderStrip() {
  return render(
    <ProjectLayoutChips
      projectName="Demo"
      chips={[
        {
          key: 'code',
          name: 'Coding',
          current: false,
          activate: vi.fn(),
          dockSurfaceId: SURFACE_ID,
        },
      ]}
    />,
  );
}

/** The gesture. What it causes is awaited by each case, on its own terms. */
function rightClickChip() {
  return act(async () => {
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Coding' }));
  });
}

beforeEach(() => {
  chunk.fails = false;
  chunk.attempts = 0;
  openSurfaceInRegion.mockClear();
});

describe('a chip menu whose chunk fails to load (#2158)', () => {
  test('renders nothing for the gesture that failed, and arrives on the next one', async () => {
    chunk.fails = true;
    renderStrip();

    await rightClickChip();
    // The import was attempted and refused. Waiting on the ATTEMPT rather than
    // on the absence is what keeps the next line a decision: "no menu" is
    // asserted at a moment when the load is known to have finished failing,
    // not at a moment that merely came too early.
    await waitFor(() => expect(chunk.attempts).toBe(1));
    expect(screen.queryByRole('menu')).toBeNull();

    chunk.fails = false;
    // The SAME chip, which is the case a key derived from `menuFor` would
    // still fail: React bails out of a state write that changes nothing, so
    // only a key the gesture itself moves can remount the boundary.
    await rightClickChip();

    // THE ASSERTION THAT NAMES THE DEFECT: a second load was attempted at all.
    // With the boundary left in place this stays 1 for ever.
    await waitFor(() => expect(chunk.attempts).toBe(2));
    // And it WORKS, rather than merely being present — the retried chunk is
    // the real menu, wired to the real model call.
    await screen.findByRole('menu', { name: 'Coding actions' });
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Open in Right' }));
    });
    expect(openSurfaceInRegion).toHaveBeenCalledWith(SURFACE_ID, {
      region: 'right',
    });
  });

  test('the ordinary case is unaffected: the first gesture opens the menu', async () => {
    renderStrip();
    await rightClickChip();
    expect(screen.getByRole('menu', { name: 'Coding actions' })).toBeDefined();
  });
});

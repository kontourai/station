/**
 * @vitest-environment jsdom
 */

import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * The Review chunk, held open until the test lets it arrive — the deferred
 * lazy import that makes "cold" and "warm" two states of the same route rather
 * than two different fixtures. The FIRST render of `review-queue` suspends on
 * this promise; every later one resolves synchronously from React's own lazy
 * cache, which is exactly what a warm transition is in the running app.
 */
const reviewChunk = vi.hoisted(() => {
  let release!: () => void;
  const arrived = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { arrived, release: () => release() };
});

vi.mock('../../views/ReviewQueueView', async () => {
  await reviewChunk.arrived;
  return {
    ReviewQueueView: () => <div>Review queue detail</div>,
  };
});

vi.mock('../../views/PluginManagementView', () => ({
  PluginManagementView: () => <div>Installed plugins list</div>,
}));

/** Guidance's chunk, held open the same way, for the tab-shape case. */
const guidanceChunk = vi.hoisted(() => {
  let release!: () => void;
  const arrived = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { arrived, release: () => release() };
});

vi.mock('../../views/GuidanceView', async () => {
  await guidanceChunk.arrived;
  return { GuidanceView: () => <div>Slash commands list</div> };
});

/** A third held-open chunk, for the urgent-vs-transition contrast below. */
const scheduleChunk = vi.hoisted(() => {
  let release!: () => void;
  const arrived = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { arrived, release: () => release() };
});

vi.mock('../../views/ScheduleView', async () => {
  await scheduleChunk.arrived;
  return { ScheduleView: () => <div>Schedule body</div> };
});

vi.mock('@kontourai/station-connect', () => ({
  useConnections: () => ({ activeConnection: null }),
}));

vi.mock('../../contexts/onboarding-setup-store', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../contexts/onboarding-setup-store')
  >()),
  useOnboardingSetupState: () => ({
    visible: false,
    isBlockingFullScreen: false,
    content: null,
    dismiss: vi.fn(),
  }),
}));

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTransition } from 'react';
import { splitPaneStorageKey } from '../../components/split-pane-metrics';
import type { NavigationView } from '../../types';
import { GUIDANCE_TAB_MEMORY_KEY } from '../../views/guidance-tab';
import { AppViewContent } from '../AppViewContent';
import { resolvePageFrame } from '../page-frame-registry';
import { RoutePendingSkeleton } from '../RoutePendingSkeleton';
import { routePendingShape } from '../route-pending-shape';
import { routeTransitionStore } from '../route-transition-store';

const baseProps = {
  agents: [],
  apiBase: 'http://localhost:3242',
  availableModels: [],
  onNavigate: vi.fn(),
  onNavigateHome: vi.fn(),
  onSettingsSaved: vi.fn(),
};

/**
 * The text a user can actually read.
 *
 * React does not unmount the previous route when an update suspends — it keeps
 * that subtree committed and hides it with an inline `display: none`. A plain
 * `textContent` (or Testing Library's `getByText`) therefore finds the
 * departing page's copy whether or not it is on screen, which is the one thing
 * archive#3660 is about. This walk skips what React hid, so an assertion against it
 * is an assertion about the screen.
 */
function visibleText(root: HTMLElement): string {
  const parts: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent ?? '');
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.style.display === 'none' || node.hidden) return;
    for (const child of Array.from(node.childNodes)) walk(child);
  };
  walk(root);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/** The shape for `view` on a desktop viewport, which is jsdom's default. */
function shapeOf(view: NavigationView, isMobile = false) {
  return routePendingShape(view, resolvePageFrame(view), isMobile);
}

/**
 * jsdom ships no `matchMedia`, and `useIsMobile` reads "not mobile" when it is
 * absent — so the desktop cases need no mock and the mobile ones need this.
 */
function mockViewportIsMobile(matches: boolean) {
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

describe('routePendingShape — read off the destination’s own frame', () => {
  afterEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    // Restoring jsdom's own absence of matchMedia, hence delete.
    delete (window as { matchMedia?: unknown }).matchMedia;
  });

  test('a split-pane route’s placeholder is a split pane', () => {
    // Asserted through the REAL route table, not a hand-written spec: the
    // claim is about what Review, Plugins and Agents are declared to be.
    expect(shapeOf({ type: 'review-queue' })).toBe('split-pane');
    expect(shapeOf({ type: 'plugins' })).toBe('split-pane');
    expect(shapeOf({ type: 'agents' })).toBe('split-pane');
  });

  test('a single-column route’s placeholder is a region', () => {
    expect(shapeOf({ type: 'settings' })).toBe('region');
    expect(shapeOf({ type: 'schedule' })).toBe('region');
    // `fill` without `flush`: a board owns its height but is not a list rail
    // beside a detail pane.
    expect(shapeOf({ type: 'registry' })).toBe('region');
  });

  test('a route with no frame has no declared shape to hold', () => {
    expect(shapeOf({ type: 'home' })).toBe('unshaped');
    expect(shapeOf({ type: 'task', taskId: 't1' })).toBe('unshaped');
  });

  describe('Guidance — one frame, three tabs, two layouts', () => {
    test('the Commands tab is a region, from the URL', () => {
      // `guidance` always carries the shared SPLIT_PANE spec, and Skills is a
      // split pane — but Commands renders a single-column PageRow list, so the
      // spec alone classifies part of the route wrongly.
      expect(shapeOf({ type: 'guidance', tab: 'commands' })).toBe('region');
      expect(shapeOf({ type: 'guidance', tab: 'skills' })).toBe('split-pane');
      expect(shapeOf({ type: 'guidance', tab: 'skills' })).toBe('split-pane');
    });

    test('and from the session memory when the URL does not say', () => {
      // The same memory `GuidanceView` opens on. A placeholder that ignored it
      // would draw a rail for a user whose remembered tab is Commands.
      sessionStorage.setItem(GUIDANCE_TAB_MEMORY_KEY, 'commands');
      expect(shapeOf({ type: 'guidance' })).toBe('region');
      // A retired tab an older build could have left behind reads as the
      // default, which is a split pane.
      sessionStorage.setItem(GUIDANCE_TAB_MEMORY_KEY, 'playbooks');
      expect(shapeOf({ type: 'guidance' })).toBe('split-pane');
      sessionStorage.clear();
      expect(shapeOf({ type: 'guidance' })).toBe('split-pane');
    });

    test('the URL wins over the memory, as it does in the view', () => {
      sessionStorage.setItem(GUIDANCE_TAB_MEMORY_KEY, 'commands');
      expect(shapeOf({ type: 'guidance', tab: 'skills' })).toBe('split-pane');
    });
  });

  describe('below the mobile breakpoint a split pane shows one side', () => {
    test('a route that names a record opens on its detail', () => {
      // `SplitPaneLayout` picks the detail from `selectedId`, so an editor
      // route arrives as a full-width sheet, not as a list.
      expect(shapeOf({ type: 'agent-edit', slug: 'a' }, true)).toBe(
        'detail-sheet',
      );
      expect(shapeOf({ type: 'agent-new' }, true)).toBe('detail-sheet');
      expect(shapeOf({ type: 'connections-model-edit', id: 'p' }, true)).toBe(
        'detail-sheet',
      );
      expect(shapeOf({ type: 'connections-engine-edit', id: 'r' }, true)).toBe(
        'detail-sheet',
      );
      expect(shapeOf({ type: 'connections-tool-edit', id: 't' }, true)).toBe(
        'detail-sheet',
      );
      expect(shapeOf({ type: 'activity', sessionId: 's' }, true)).toBe(
        'detail-sheet',
      );
      expect(shapeOf({ type: 'guidance', selectedId: 'skill-a' }, true)).toBe(
        'detail-sheet',
      );
    });

    test('a route that names none opens on its list', () => {
      expect(shapeOf({ type: 'agents' }, true)).toBe('split-pane');
      expect(shapeOf({ type: 'plugins' }, true)).toBe('split-pane');
      expect(shapeOf({ type: 'review-queue' }, true)).toBe('split-pane');
      expect(shapeOf({ type: 'activity' }, true)).toBe('split-pane');
      expect(shapeOf({ type: 'connections-models' }, true)).toBe('split-pane');
    });

    test('the same routes on a desktop viewport keep both panes', () => {
      // The discriminating half: without this, "always detail-sheet" would
      // pass every assertion above.
      expect(shapeOf({ type: 'agent-edit', slug: 'a' })).toBe('split-pane');
      expect(shapeOf({ type: 'activity', sessionId: 's' })).toBe('split-pane');
    });
  });

  describe('a pane that was left collapsed comes back collapsed', () => {
    function persistCollapsed(paneId: string) {
      localStorage.setItem(
        splitPaneStorageKey(paneId),
        JSON.stringify({ width: 280, collapsed: true }),
      );
    }

    test('the placeholder draws no rail for it', () => {
      // `SplitPaneLayout` restores this on mount, so a placeholder that always
      // drew a 280px rail would be a 252px jump the moment the chunk landed.
      persistCollapsed('agents');
      expect(shapeOf({ type: 'agents' })).toBe('detail-sheet');
      expect(shapeOf({ type: 'agent-edit', slug: 'a' })).toBe('detail-sheet');

      persistCollapsed('connections-models');
      expect(shapeOf({ type: 'connections-models' })).toBe('detail-sheet');

      persistCollapsed('connections-agent-apps');
      expect(shapeOf({ type: 'connections-engines' })).toBe('detail-sheet');
    });

    test('one pane’s collapse says nothing about another’s', () => {
      persistCollapsed('agents');
      expect(shapeOf({ type: 'connections-models' })).toBe('split-pane');
      // Review persists nothing at all — it mounts its pane without an id, so
      // it always starts expanded.
      expect(shapeOf({ type: 'review-queue' })).toBe('split-pane');
    });

    test('an expanded or unreadable entry is not a collapse', () => {
      localStorage.setItem(
        splitPaneStorageKey('agents'),
        JSON.stringify({ width: 300, collapsed: false }),
      );
      expect(shapeOf({ type: 'agents' })).toBe('split-pane');
      localStorage.setItem(splitPaneStorageKey('agents'), 'not json');
      expect(shapeOf({ type: 'agents' })).toBe('split-pane');
    });

    /**
     * A source assertion, deliberately.
     *
     * The fact under test is that ONE string decides which persisted entry a
     * pane writes and which one the placeholder reads. Rendering a view proves
     * the pair agrees for whatever that view happens to pass today; it cannot
     * prove nobody re-typed the literal in the next view, which is the only way
     * this drifts — and it drifts silently, because a placeholder reading a key
     * nobody writes just looks like a pane that was never collapsed.
     *
     * Checked in both directions: no literal anywhere, AND every shared
     * constant actually reaching a `paneId`, so deleting the pane ids cannot
     * turn this green.
     */
    test('every persisted pane id comes from the shared constant, never a literal', () => {
      // `import.meta.url` is an http: URL under the jsdom environment, so this
      // resolves from the run root instead — which `test:focused` pins and
      // verifies before any test runs.
      const srcRoot = join(process.cwd(), 'src-ui', 'src');
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) {
            if (entry.name !== '__tests__') walk(full);
          } else if (full.endsWith('.tsx')) {
            files.push(full);
          }
        }
      };
      walk(srcRoot);
      expect(files.length).toBeGreaterThan(100);

      const literals: string[] = [];
      const wired = new Set<string>();
      for (const file of files) {
        const source = readFileSync(file, 'utf8');
        for (const match of source.matchAll(/paneId=(\{?)([^\s>}]*)/g)) {
          const value = match[2];
          if (match[1] === '') {
            literals.push(`${file.slice(srcRoot.length)} -> ${value}`);
          } else {
            wired.add(value);
          }
        }
      }

      expect(literals).toEqual([]);
      expect([...wired].sort()).toEqual([
        'AGENTS_PANE_ID',
        'CONNECTIONS_ENGINES_PANE_ID',
        'CONNECTIONS_MODELS_PANE_ID',
      ]);
    });

    test('collapse is a desktop affordance and is ignored on mobile', () => {
      persistCollapsed('agents');
      expect(shapeOf({ type: 'agents' }, true)).toBe('split-pane');
    });
  });
});

describe('RoutePendingSkeleton renders the shape it resolved', () => {
  afterEach(() => {
    localStorage.clear();
    // Restoring jsdom's own absence of matchMedia, hence delete.
    delete (window as { matchMedia?: unknown }).matchMedia;
  });

  function renderFor(view: NavigationView) {
    return render(
      <RoutePendingSkeleton view={view} spec={resolvePageFrame(view)} />,
    );
  }

  test('mobile editor route: a detail sheet, no rail', () => {
    mockViewportIsMobile(true);
    const { container } = renderFor({ type: 'agent-edit', slug: 'a' });
    expect(
      container.querySelector('.route-pending--detail-sheet'),
    ).not.toBeNull();
    expect(container.querySelector('.route-pending__rail')).toBeNull();
    expect(
      container
        .querySelector('[role="status"][aria-busy="true"]')
        ?.getAttribute('aria-label'),
    ).toBe('Loading view');
  });

  test('the same route on desktop: rail and detail', () => {
    const { container } = renderFor({ type: 'agent-edit', slug: 'a' });
    expect(
      container.querySelector('.route-pending--split-pane'),
    ).not.toBeNull();
    expect(container.querySelector('.route-pending__rail')).not.toBeNull();
  });

  test('a persisted collapse on desktop: a detail sheet, no rail', () => {
    localStorage.setItem(
      splitPaneStorageKey('agents'),
      JSON.stringify({ width: 280, collapsed: true }),
    );
    const { container } = renderFor({ type: 'agents' });
    expect(
      container.querySelector('.route-pending--detail-sheet'),
    ).not.toBeNull();
    expect(container.querySelector('.route-pending__rail')).toBeNull();
  });

  test('a region inside a flush frame keeps the frame’s x-origin', () => {
    // Guidance's Commands tab is the one route that is both `flush` (declared
    // for a rail that runs to the frame edge) and railless, so without this the
    // placeholder sat 24px left of the list that replaced it.
    const commands = renderFor({ type: 'guidance', tab: 'commands' });
    expect(
      commands.container.querySelector('.route-pending--inset'),
    ).not.toBeNull();
    commands.unmount();

    // A region in an ordinary frame is already inside the frame's padding, and
    // a second inset would indent it twice.
    const settings = renderFor({ type: 'settings' });
    expect(settings.container.querySelector('.skeleton-block')).not.toBeNull();
    expect(
      settings.container.querySelector('.route-pending--inset'),
    ).toBeNull();
  });

  test('a caller with no route gets the unshaped placeholder', () => {
    const { container } = render(<RoutePendingSkeleton />);
    expect(container.querySelector('.route-pending')).toBeNull();
    expect(container.querySelector('.skeleton-list')).not.toBeNull();
  });
});

describe('the body while a route chunk is in flight (#3660)', () => {
  const published: Array<string | null> = [];
  let unsubscribe: () => void;

  beforeEach(() => {
    published.length = 0;
    unsubscribe = routeTransitionStore.subscribe(() => {
      published.push(routeTransitionStore.getSnapshot());
    });
  });

  afterEach(() => {
    unsubscribe();
  });

  test('cold: the header names Review, and the body holds Review’s shape — not the Plugins list', async () => {
    const { container, rerender } = render(
      <AppViewContent {...baseProps} currentView={{ type: 'plugins' }} />,
    );
    expect(await screen.findByText('Installed plugins list')).toBeTruthy();

    rerender(
      <AppViewContent {...baseProps} currentView={{ type: 'review-queue' }} />,
    );

    // The header already names the arriving route (that is archive#3659, and it is
    // the half that made the body's disagreement visible).
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Review',
    );

    // The departing page is off screen. It is still in the DOM — React hid it
    // rather than unmounting it — so this must be a visibility assertion.
    expect(container.textContent).toContain('Installed plugins list');
    expect(visibleText(container)).not.toContain('Installed plugins list');

    //.and what replaced it holds the shape Review will arrive in: a list
    // rail beside a detail pane, not a generic full-width row list.
    const placeholder = container.querySelector('.route-pending--split-pane');
    expect(placeholder).not.toBeNull();
    expect(placeholder?.querySelector('.route-pending__rail')).not.toBeNull();
    expect(placeholder?.querySelector('.route-pending__detail')).not.toBeNull();

    // Exactly one live region announces the wait, and it names the wait rather
    // than the route (the header already named the route).
    const statuses = container.querySelectorAll(
      '[role="status"][aria-busy="true"]',
    );
    expect(statuses).toHaveLength(1);
    expect(statuses[0].getAttribute('aria-label')).toBe('Loading view');

    // The suspension published itself, which is what makes the warm case's
    // silence below evidence rather than an inert channel.
    expect(published.filter(Boolean)).not.toHaveLength(0);

    await act(async () => {
      reviewChunk.release();
      await reviewChunk.arrived;
    });

    expect(await screen.findByText('Review queue detail')).toBeTruthy();
    expect(container.querySelector('.route-pending')).toBeNull();
    expect(routeTransitionStore.getSnapshot()).toBeNull();
  });

  test('warm: a chunk already in memory swaps with no placeholder at all', async () => {
    // Warm the SAME lazy component this file's cold case uses, here rather
    // than by inheriting the cold test's leftovers — React caches a resolved
    // `lazy` for the life of the module, so this really is the warm path,
    // and the test still is one when run on its own.
    const warmUp = render(
      <AppViewContent {...baseProps} currentView={{ type: 'review-queue' }} />,
    );
    await act(async () => {
      reviewChunk.release();
      await reviewChunk.arrived;
    });
    expect(await screen.findByText('Review queue detail')).toBeTruthy();
    warmUp.unmount();

    const { container, rerender } = render(
      <AppViewContent {...baseProps} currentView={{ type: 'plugins' }} />,
    );
    expect(await screen.findByText('Installed plugins list')).toBeTruthy();
    published.length = 0;

    rerender(
      <AppViewContent {...baseProps} currentView={{ type: 'review-queue' }} />,
    );

    expect(screen.getByText('Review queue detail')).toBeTruthy();
    expect(visibleText(container)).not.toContain('Installed plugins list');
    // No skeleton flashed. The fallback publishes on mount, so an empty
    // publication log is the same fact as an absent placeholder, observed a
    // second way.
    expect(container.querySelector('.route-pending')).toBeNull();
    expect(
      container.querySelector('[role="status"][aria-busy="true"]'),
    ).toBeNull();
    expect(published.filter(Boolean)).toHaveLength(0);
  });

  test('cold: Guidance’s Commands tab holds a region, not a rail (#3660 review M1)', async () => {
    // `guidance` carries the shared SPLIT_PANE spec whatever the tab, so the
    // frame alone would have drawn a rail here and then jumped to a
    // single-column list. The tab is in the URL before the chunk exists.
    const { container, rerender } = render(
      <AppViewContent {...baseProps} currentView={{ type: 'plugins' }} />,
    );
    expect(await screen.findByText('Installed plugins list')).toBeTruthy();

    rerender(
      <AppViewContent
        {...baseProps}
        currentView={{ type: 'guidance', tab: 'commands' }}
      />,
    );

    expect(container.querySelector('.route-pending--split-pane')).toBeNull();
    expect(container.querySelector('.skeleton-block')).not.toBeNull();
    expect(visibleText(container)).not.toContain('Installed plugins list');

    await act(async () => {
      guidanceChunk.release();
      await guidanceChunk.arrived;
    });
    expect(await screen.findByText('Slash commands list')).toBeTruthy();
  });

  test('the placeholder replaces the departing body because navigation is URGENT (#3660 review L)', async () => {
    // What the "no stale body" claim actually rests on. Station navigates with
    // a plain `setCurrentView` — ordinary clicks and `popstate` alike
    // (`App.tsx`) — and React shows a Suspense fallback for an urgent update
    // that suspends, hiding the previous children. Wrapped in
    // `startTransition` React does the opposite: it keeps the departing content
    // revealed and shows no fallback at all. Both halves are asserted, so a
    // future change that wraps navigation in a transition reddens here with the
    // reason rather than silently restoring the archive#3660 symptom.
    const { container, rerender } = render(
      <AppViewContent {...baseProps} currentView={{ type: 'plugins' }} />,
    );
    expect(await screen.findByText('Installed plugins list')).toBeTruthy();

    await act(async () => {
      startTransition(() => {
        rerender(
          <AppViewContent {...baseProps} currentView={{ type: 'schedule' }} />,
        );
      });
    });

    expect(visibleText(container)).toContain('Installed plugins list');
    expect(container.querySelector('.route-pending')).toBeNull();
    expect(
      container.querySelector('[role="status"][aria-busy="true"]'),
    ).toBeNull();

    await act(async () => {
      scheduleChunk.release();
      await scheduleChunk.arrived;
    });
    expect(await screen.findByText('Schedule body')).toBeTruthy();
  });
});

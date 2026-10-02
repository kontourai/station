/** @vitest-environment jsdom */

/**
 * #2986: swapping `main`'s page at `/` has a history identity. Back returns
 * to the page that was replaced, Forward re-opens the one left, and the
 * stamp lives in `history.state` so it is still there after a reload.
 *
 * #2988: a pane moved into `main` (`placeSurface` — a tab's Move to Main, the
 * Layout picker) is shown, not left behind a maximized dock.
 *
 * Real `RegionModelProvider`, navigation store, dialog-history layer and
 * jsdom history; traversals are `history.go` and the `popstate` they fire.
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { registerDialogHistory } from '../../components/dialog-history';
import { ProjectSidebarNav } from '../../components/project-sidebar/ProjectSidebarNav';
import { MOBILE_MEDIA_QUERY } from '../../hooks/useIsMobile';
import { deviceSettingsStore } from '../../lib/device-settings-store';
import { KeyboardShortcutsProvider } from '../KeyboardShortcutsContext';
import { mainPageOf } from '../main-page-history';
import { NavigationProvider, useNavigation } from '../NavigationContext';
import { navigationStore } from '../navigation-store';
import { RegionModelProvider, useRegionModel } from '../RegionModelContext';

vi.mock('../../hooks/useSurfaceVisibilityFlags', () => ({
  useSurfaceVisibilityFlags: () => new Set<string>(),
}));

let model: ReturnType<typeof useRegionModel> | null = null;

function Probe() {
  const value = useRegionModel();
  useEffect(() => {
    model = value;
  }, [value]);
  return null;
}

function current() {
  if (!model) throw new Error('probe never rendered');
  return model;
}

/** What `main` shows; an empty `main` is Home's. */
function page(): string {
  return current().regions.main.occupant ?? 'home';
}

function Row() {
  const { pathname } = useNavigation((state) => ({
    pathname: state.pathname,
  }));
  return (
    <ProjectSidebarNav
      collapsed={false}
      isMobile={false}
      navigate={(path) => navigationStore.navigate(path)}
      activePath={pathname}
    />
  );
}

function stubDevice({ phone }: { phone: boolean }) {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: phone ? 390 : 1440,
  });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches:
      phone && (query === MOBILE_MEDIA_QUERY || query === '(pointer: coarse)'),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

function Shell() {
  return (
    <KeyboardShortcutsProvider>
      <NavigationProvider>
        <RegionModelProvider>
          <Probe />
          <Row />
        </RegionModelProvider>
      </NavigationProvider>
    </KeyboardShortcutsProvider>
  );
}

async function mount() {
  const view = render(<Shell />);
  await waitFor(() => expect(model).not.toBeNull());
  return view;
}

function activityRow(): HTMLElement {
  return screen.getByRole('button', { name: 'Activity' });
}

/** One real traversal, settled: the entry's own `popstate` has been handled. */
async function travel(delta: number) {
  await act(async () => {
    const landed = new Promise<void>((resolve) => {
      const onPop = (event: PopStateEvent) => {
        // The store's own notifications dispatch a bare `popstate`.
        if (event.state === null) return;
        window.removeEventListener('popstate', onPop);
        resolve();
      };
      window.addEventListener('popstate', onPop);
    });
    window.history.go(delta);
    await landed;
  });
}

async function openActivityPage() {
  fireEvent.click(activityRow());
  await waitFor(() => expect(page()).toBe('activity'));
}

beforeEach(() => {
  model = null;
  localStorage.clear();
  sessionStorage.clear();
  deviceSettingsStore.reloadFromStorage();
  window.history.replaceState({}, '', '/');
  navigationStore.navigate('/', {
    dock: null,
    maximize: null,
    dockSlotPlacement: null,
  });
  stubDevice({ phone: false });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

describe('the page at / has a history entry of its own', () => {
  test('Back returns to Home, and Forward re-opens Activity', async () => {
    await mount();
    expect(page()).toBe('home');
    const before = window.history.length;

    await openActivityPage();
    expect(window.history.length).toBe(before + 1);
    expect(mainPageOf(window.history.state)).toBe('activity');
    expect(activityRow().getAttribute('aria-current')).toBe('page');

    await travel(-1);
    expect(window.location.pathname).toBe('/');
    expect(page()).toBe('home');
    expect(activityRow().getAttribute('aria-current')).toBeNull();
    expect(mainPageOf(window.history.state)).toBe('home');

    await travel(1);
    expect(page()).toBe('activity');
    await waitFor(() =>
      expect(activityRow().getAttribute('aria-current')).toBe('page'),
    );
  });

  test('pressing the current page again adds no entry', async () => {
    await mount();
    await openActivityPage();
    const length = window.history.length;
    fireEvent.click(activityRow());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(window.history.length).toBe(length);
    expect(page()).toBe('activity');
  });

  test('Home taking the page back is an entry too: Back returns to Activity', async () => {
    await mount();
    await openActivityPage();
    act(() => current().showSurface('home'));
    await waitFor(() => expect(page()).toBe('home'));

    await travel(-1);
    expect(page()).toBe('activity');
    await travel(-1);
    expect(page()).toBe('home');
  });

  test('a route visited in between does not disturb the entries', async () => {
    await mount();
    await openActivityPage();
    act(() => navigationStore.navigate('/settings'));
    await waitFor(() => expect(window.location.pathname).toBe('/settings'));
    // A route entry carries no page stamp of its own.
    expect(mainPageOf(window.history.state)).toBeUndefined();

    await travel(-1);
    expect(window.location.pathname).toBe('/');
    expect(page()).toBe('activity');
    await travel(-1);
    expect(window.location.pathname).toBe('/');
    expect(page()).toBe('home');
    await travel(2);
    expect(window.location.pathname).toBe('/settings');
    // `main` keeps its occupant while another route is on screen.
    expect(page()).toBe('home');
    await travel(-1);
    expect(page()).toBe('activity');
  });

  test('opened from another route it is one entry, and Back returns to that route', async () => {
    await mount();
    act(() => navigationStore.navigate('/settings'));
    await waitFor(() => expect(window.location.pathname).toBe('/settings'));
    const length = window.history.length;

    fireEvent.click(activityRow());
    await waitFor(() => expect(window.location.pathname).toBe('/'));
    expect(page()).toBe('activity');
    expect(window.history.length).toBe(length + 1);
    await waitFor(() =>
      expect(mainPageOf(window.history.state)).toBe('activity'),
    );

    await travel(-1);
    expect(window.location.pathname).toBe('/settings');
    await travel(1);
    expect(window.location.pathname).toBe('/');
    expect(page()).toBe('activity');
  });

  test('the chord returning the page to its dock restamps the entry, so Back does not bring it back', async () => {
    await mount();
    act(() => current().showSurface('activity'));
    await waitFor(() =>
      expect(current().regions.right.occupant).toBe('activity'),
    );
    await openActivityPage();
    act(() => current().toggleSurface('activity'));
    await waitFor(() => expect(page()).toBe('home'));
    await waitFor(() => expect(mainPageOf(window.history.state)).toBe('home'));

    act(() => navigationStore.navigate('/settings'));
    await waitFor(() => expect(window.location.pathname).toBe('/settings'));
    await travel(-1);
    expect(window.location.pathname).toBe('/');
    expect(page()).toBe('home');
    expect(current().regions.right.panes).toContain('activity');
  });

  test('a traversal to an entry with no stamp leaves the page alone', async () => {
    await mount();
    await openActivityPage();
    // An entry something else wrote at `/`, carrying no page stamp.
    act(() => window.history.pushState({ other: true }, '', '/'));
    act(() => window.history.pushState({ other: true }, '', '/?x=1'));
    await travel(-1);
    expect(mainPageOf(window.history.state)).toBeUndefined();
    expect(page()).toBe('activity');
  });

  test('the stamp is in history.state, so a reload on the entry keeps Back working', async () => {
    const first = await mount();
    await openActivityPage();
    // Let the arrangement record's trailing write land before the "reload".
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    first.unmount();
    model = null;
    deviceSettingsStore.reloadFromStorage();

    await mount();
    expect(page()).toBe('activity');
    expect(mainPageOf(window.history.state)).toBe('activity');
    await travel(-1);
    expect(page()).toBe('home');
  });

  test('a page chosen from a dialog survives the dialog closing, and Back still returns', async () => {
    await mount();
    // The command palette's shape: a dialog layer is the live entry when its
    // Activity entry runs, and the dialog unmounts right after.
    let closed = false;
    let release: () => void = () => {};
    act(() => {
      release = registerDialogHistory('test-palette', () => {
        closed = true;
      });
    });
    await openActivityPage();
    act(() => release());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    // The dialog's deferred cleanup must not travel Back over the new entry.
    expect(page()).toBe('activity');
    expect(mainPageOf(window.history.state)).toBe('activity');
    // The page open is a navigation, and a navigation closes the dialog
    // whose entry it left, as any other does.
    expect(closed).toBe(true);

    await travel(-1);
    await waitFor(() => expect(page()).toBe('home'));
    expect(window.location.pathname).toBe('/');
  });

  test('on a phone, Back from the page returns to the full-screen Chat it was opened over', async () => {
    stubDevice({ phone: true });
    await mount();
    act(() => navigationStore.setDockState(true, true));
    await waitFor(() => expect(current().regions.bottom.maximized).toBe(true));

    await openActivityPage();
    await waitFor(() =>
      expect(navigationStore.getSnapshot().isDockMaximized).toBe(false),
    );

    await travel(-1);
    expect(window.location.pathname).toBe('/');
    await waitFor(() => expect(page()).toBe('home'));
    await waitFor(() => expect(current().regions.bottom.maximized).toBe(true));
    expect(navigationStore.getSnapshot().isDockMaximized).toBe(true);
  });
});

describe('entries the traversal must not obey', () => {
  test('a guarded jump across page entries leaves the page alone until it is admitted', async () => {
    await mount();
    await openActivityPage();
    act(() => navigationStore.navigate('/settings'));
    await waitFor(() => expect(window.location.pathname).toBe('/settings'));
    // A dirty form on the route: its guard holds the decision.
    let decide: { go: () => void } | null = null;
    const release = navigationStore.registerNavigationGuard(
      Symbol('dirty-form'),
      (go) => {
        decide = { go };
      },
    );

    // Two entries back at once: past the Activity entry, onto Home's. The
    // browser lands there before the store travels back to ask.
    act(() => window.history.go(-2));
    await waitFor(() => expect(decide).not.toBeNull());
    expect(window.location.pathname).toBe('/settings');
    // The reader was never admitted to Home's entry, so `main` did not move.
    expect(page()).toBe('activity');

    release();
    await act(async () => {
      decide?.go();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    await waitFor(() => expect(window.location.pathname).toBe('/'));
    await waitFor(() => expect(page()).toBe('home'));
  });

  test('after Back between page entries, a guarded Back from a route still asks', async () => {
    await mount();
    await openActivityPage();
    // A same-URL traversal: the store has to follow it, or the route pushed
    // next is numbered from the entry left and the guarded Back below is
    // travelled back by the wrong distance — past the end, so nobody asks.
    await travel(-1);
    expect(page()).toBe('home');
    act(() => navigationStore.navigate('/settings'));
    await waitFor(() => expect(window.location.pathname).toBe('/settings'));
    let asked = false;
    const release = navigationStore.registerNavigationGuard(
      Symbol('dirty-form'),
      () => {
        asked = true;
      },
    );

    act(() => window.history.back());
    await waitFor(() => expect(asked).toBe(true));
    expect(window.location.pathname).toBe('/settings');
    release();
  });

  test('a dialog that collapsed onto a new URL is its own entry: Back from it restores the page beneath', async () => {
    await mount();
    await openActivityPage();
    // A dialog over the Activity page. While it is open the page goes back
    // to its dock and the URL gains a param, so an ordinary close collapses
    // the layer where it stands (dialog-history) under a NEW navigation index.
    let release: () => void = () => {};
    act(() => {
      release = registerDialogHistory('test-collapsing-dialog', () => {});
    });
    act(() => current().toggleSurface('activity'));
    await waitFor(() => expect(page()).toBe('home'));
    act(() => navigationStore.updateParams({ fontSize: '15' }));
    act(() => release());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    expect(window.location.search).toContain('fontSize=15');
    expect(page()).toBe('home');

    // The entry beneath is a different navigation entry, and it showed
    // Activity as the page.
    await travel(-1);
    expect(window.location.search).not.toContain('fontSize');
    expect(page()).toBe('activity');
  });

  test('closing a dialog does not undo a change made while it was open', async () => {
    await mount();
    act(() => current().showSurface('activity'));
    await waitFor(() =>
      expect(current().regions.right.occupant).toBe('activity'),
    );
    await openActivityPage();
    // A dialog over the Activity page: its layer copies the entry's stamp.
    let release: () => void = () => {};
    act(() => {
      release = registerDialogHistory('test-layout-picker', () => {});
    });
    expect(mainPageOf(window.history.state)).toBe('activity');
    // From inside it, the page goes back to its dock: not a page open.
    act(() => current().toggleSurface('activity'));
    await waitFor(() => expect(page()).toBe('home'));

    // An ordinary close folds the layer by travelling back onto the entry
    // beneath, which still says Activity.
    act(() => release());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    expect(page()).toBe('home');
    expect(current().regions.right.panes).toContain('activity');
    await waitFor(() => expect(mainPageOf(window.history.state)).toBe('home'));
  });

  test('an entry reached by a plain link is stamped on arrival, so Back to it restores its page', async () => {
    await mount();
    await openActivityPage();
    act(() => navigationStore.navigate('/settings'));
    await waitFor(() => expect(window.location.pathname).toBe('/settings'));
    // A plain navigation to `/` — a link, not a page open — while Activity
    // is `main`'s occupant.
    act(() => navigationStore.navigate('/'));
    await waitFor(() =>
      expect(mainPageOf(window.history.state)).toBe('activity'),
    );
    act(() => navigationStore.navigate('/settings'));
    await waitFor(() => expect(window.location.pathname).toBe('/settings'));
    // Home takes the page from the other route: one new entry at `/`.
    act(() => current().showSurface('home'));
    await waitFor(() => expect(window.location.pathname).toBe('/'));
    expect(page()).toBe('home');

    await travel(-2);
    expect(window.location.pathname).toBe('/');
    expect(page()).toBe('activity');
  });
});

describe('a deep link that changes the page', () => {
  test('is its own entry: Back leaves it, and coming back does not run it again', async () => {
    await mount();
    await openActivityPage();
    const length = window.history.length;

    // `/?surface=home` while Activity is the page: the adoption reveals Home
    // in `main`, then clears the command from the live entry.
    act(() => navigationStore.navigate('/', { surface: 'home' }));
    await waitFor(() => expect(page()).toBe('home'));
    await waitFor(() =>
      expect(window.location.search).not.toContain('surface'),
    );
    // One entry — the link's — and no second one for the swap it caused.
    expect(window.history.length).toBe(length + 1);

    await travel(-1);
    expect(page()).toBe('activity');
    expect(window.location.search).not.toContain('surface');
    await travel(1);
    expect(page()).toBe('home');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(window.history.length).toBe(length + 1);
  });
});

describe('the page opened from the phone layer', () => {
  test('Back skips the ended layer and returns to the full-screen Chat', async () => {
    stubDevice({ phone: true });
    await mount();
    act(() => navigationStore.setDockState(true, true));
    await waitFor(() => expect(current().regions.bottom.maximized).toBe(true));
    act(() => current().showSurface('activity'));
    await waitFor(() => expect(current().phoneLayer).not.toBeNull());

    await openActivityPage();
    expect(current().phoneLayer).toBeNull();
    await waitFor(() =>
      expect(navigationStore.getSnapshot().isDockMaximized).toBe(false),
    );

    // One press: the layer's orphaned entry is skipped by the dialog layer.
    act(() => window.history.back());
    await waitFor(() => expect(page()).toBe('home'));
    await waitFor(() => expect(current().regions.bottom.maximized).toBe(true));
    expect(current().phoneLayer).toBeNull();
    expect(current().regions.bottom.occupant).toBe('chat');
    expect(window.location.pathname).toBe('/');
  });
});

describe('a pane moved into main is shown (#2988)', () => {
  test.each(['bottom', 'right'] as const)(
    'with Chat maximized in %s, Move to Main restores the dock and keeps the maximize memory',
    async (region) => {
      await mount();
      if (region === 'right')
        act(() => current().placeSurface('chat', 'right'));
      act(() => current().showSurface('activity'));
      await waitFor(() => expect(occupiedBy('activity')).not.toBe('main'));
      act(() => navigationStore.setDockState(true, true));
      await waitFor(() =>
        expect(current().regions[region].maximized).toBe(true),
      );
      expect(navigationStore.lastDockMaximized).toBe(true);

      act(() => current().placeSurface('activity', 'main'));
      await waitFor(() => expect(page()).toBe('activity'));
      await waitFor(() =>
        expect(navigationStore.getSnapshot().isDockMaximized).toBe(false),
      );
      for (const id of ['left', 'right', 'bottom'] as const)
        expect(current().regions[id].maximized).toBe(false);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      expect(navigationStore.lastDockMaximized).toBe(true);
      // The move is a page swap like the row's: Back returns to Home.
      await travel(-1);
      await waitFor(() => expect(page()).toBe('home'));
    },
  );

  test('a move into a dock region leaves a maximized dock as it is', async () => {
    await mount();
    act(() => navigationStore.setDockState(true, true));
    await waitFor(() => expect(current().regions.bottom.maximized).toBe(true));
    act(() => current().placeSurface('activity', 'left'));
    await waitFor(() =>
      expect(current().regions.left.panes).toContain('activity'),
    );
    expect(current().regions.bottom.maximized).toBe(true);
  });
});

function occupiedBy(surfaceId: string): string | undefined {
  return (['main', 'left', 'right', 'bottom'] as const).find((id) =>
    current().regions[id].panes.includes(surfaceId),
  );
}

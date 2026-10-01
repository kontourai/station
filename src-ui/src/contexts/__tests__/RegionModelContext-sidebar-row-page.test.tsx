/** @vitest-environment jsdom */

/**
 * The sidebar's Activity row is a PLACE: pressing it opens Activity as the
 * page (`main` at `/`) and the row becomes the current page, on a desktop and
 * on a phone. `ProjectSidebarNav.test.tsx` mocks the model, so it proves only
 * which seam the row calls; this runs the row against the REAL
 * `RegionModelProvider`, navigation store and history, so a regression in
 * `useShowSurfacePage`, the model's `region` option, or the phone-layer
 * branch of `openSurfaceInRegion` reds here.
 *
 * It also pins what must NOT change: a contextual reveal (`showSurface`, what
 * a notification or evidence link runs) still docks Activity on the right,
 * and the chord's `toggleSurface` still returns a `main` Activity to its dock.
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
import { ProjectSidebarNav } from '../../components/project-sidebar/ProjectSidebarNav';
import { MOBILE_MEDIA_QUERY } from '../../hooks/useIsMobile';
import { deviceSettingsStore } from '../../lib/device-settings-store';
import { KeyboardShortcutsProvider } from '../KeyboardShortcutsContext';
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

/** The row as `ProjectSidebar` mounts it: `activePath` is the live pathname. */
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

async function mount() {
  render(
    <KeyboardShortcutsProvider>
      <NavigationProvider>
        <RegionModelProvider>
          <Probe />
          <Row />
        </RegionModelProvider>
      </NavigationProvider>
    </KeyboardShortcutsProvider>,
  );
  await waitFor(() => expect(model).not.toBeNull());
}

function activityRow(): HTMLElement {
  return screen.getByRole('button', { name: 'Activity' });
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

describe('the Activity row opens Activity as the page', () => {
  test('a press puts Activity in main and makes the row the current page', async () => {
    await mount();
    expect(activityRow().getAttribute('aria-current')).toBeNull();
    // A place row is not a toggle: it reports no pressed state at all.
    expect(activityRow().hasAttribute('aria-pressed')).toBe(false);

    fireEvent.click(activityRow());
    await waitFor(() =>
      expect(activityRow().getAttribute('aria-current')).toBe('page'),
    );
    expect(current().regions.main.occupant).toBe('activity');
    expect(current().regions.right.panes).not.toContain('activity');
    expect(window.location.pathname).toBe('/');

    // Pressing the current page again leaves it the page.
    fireEvent.click(activityRow());
    await waitFor(() =>
      expect(current().regions.main.occupant).toBe('activity'),
    );
    expect(current().regions.right.panes).not.toContain('activity');
    expect(activityRow().getAttribute('aria-current')).toBe('page');
  });

  test('from another route it navigates back to / with Activity as the page', async () => {
    await mount();
    act(() => navigationStore.navigate('/settings'));
    await waitFor(() => expect(window.location.pathname).toBe('/settings'));
    expect(activityRow().getAttribute('aria-current')).toBeNull();

    fireEvent.click(activityRow());
    await waitFor(() => expect(window.location.pathname).toBe('/'));
    expect(current().regions.main.occupant).toBe('activity');
    await waitFor(() =>
      expect(activityRow().getAttribute('aria-current')).toBe('page'),
    );
  });

  test('a docked Activity is moved to main, not revealed in its dock', async () => {
    await mount();
    act(() => current().showSurface('activity'));
    await waitFor(() =>
      expect(current().regions.right).toMatchObject({
        occupant: 'activity',
        visible: true,
      }),
    );
    // Docked beside Home: Home is the page, so the row is not current.
    expect(activityRow().getAttribute('aria-current')).toBeNull();

    fireEvent.click(activityRow());
    await waitFor(() =>
      expect(current().regions.main.occupant).toBe('activity'),
    );
    expect(current().regions.right.panes).not.toContain('activity');
    expect(activityRow().getAttribute('aria-current')).toBe('page');
  });

  test('on a phone it opens as the page, not as a layer over Chat', async () => {
    stubDevice({ phone: true });
    await mount();

    fireEvent.click(activityRow());
    await waitFor(() =>
      expect(current().regions.main.occupant).toBe('activity'),
    );
    expect(current().phoneLayer).toBeNull();
    expect(current().regions.bottom.panes).not.toContain('activity');
    expect(activityRow().getAttribute('aria-current')).toBe('page');
  });

  test('a contextual reveal still docks it right, and the chord still re-docks the page', async () => {
    await mount();
    // What a notification/evidence deep link runs (`showSurface` with an
    // intent) is unchanged: Activity opens in its default dock region.
    act(() => current().showSurface('activity', { session: 'thread-1' }));
    await waitFor(() =>
      expect(current().regions.right).toMatchObject({
        occupant: 'activity',
        visible: true,
      }),
    );
    expect(current().regions.main.occupant).not.toBe('activity');

    fireEvent.click(activityRow());
    await waitFor(() =>
      expect(current().regions.main.occupant).toBe('activity'),
    );
    // ⌘⇧A is `toggleSurface`: a `main` occupant returns to its dock, Home
    // is the page again, and the row stops being current.
    act(() => current().toggleSurface('activity'));
    await waitFor(() =>
      expect(current().regions.right).toMatchObject({
        occupant: 'activity',
        visible: true,
      }),
    );
    expect(current().regions.main.occupant).toBeNull();
    expect(activityRow().getAttribute('aria-current')).toBeNull();
  });

  // Review round 1: a page opened on a phone has to be SEEN. `App.tsx`
  // hides the whole route outlet while the phone dock is maximized
  // (`isMobileDockFullscreenState` over navigation's dock state), so the
  // row must restore the dock, or `main` changes behind a full-screen Chat.
  test('on a phone with Chat maximized, the page open restores the dock', async () => {
    stubDevice({ phone: true });
    await mount();
    act(() => navigationStore.setDockState(true, true));
    await waitFor(() => expect(current().regions.bottom.maximized).toBe(true));

    fireEvent.click(activityRow());
    await waitFor(() =>
      expect(current().regions.main.occupant).toBe('activity'),
    );
    await waitFor(() =>
      expect(navigationStore.getSnapshot().isDockMaximized).toBe(false),
    );
    expect(current().regions.bottom.maximized).toBe(false);
    expect(activityRow().getAttribute('aria-current')).toBe('page');

    // Home shares the path (`showSurface('home')` lands in `main`).
    act(() => navigationStore.setDockState(true, true));
    await waitFor(() => expect(current().regions.bottom.maximized).toBe(true));
    act(() => current().showSurface('home'));
    await waitFor(() =>
      expect(navigationStore.getSnapshot().isDockMaximized).toBe(false),
    );
    expect(current().regions.main.occupant).toBe('home');
  });

  // The reviewer's case: Chat was maximized BEFORE the layer, so the layer's
  // own restore puts that maximize back. The page open must end the layer
  // first and then restore the dock, not have the layer's dismissal re-apply
  // Chat's maximize after the page landed.
  test('on a phone with Activity open over a maximized Chat, the row ends the layer and shows the page', async () => {
    stubDevice({ phone: true });
    await mount();
    act(() => navigationStore.setDockState(true, true));
    await waitFor(() => expect(current().regions.bottom.maximized).toBe(true));
    act(() => current().showSurface('activity'));
    await waitFor(() => expect(current().phoneLayer).not.toBeNull());
    expect(current().regions.bottom.maximized).toBe(true);

    fireEvent.click(activityRow());
    await waitFor(() =>
      expect(current().regions.main.occupant).toBe('activity'),
    );
    expect(current().phoneLayer).toBeNull();
    expect(current().regions.bottom.panes).not.toContain('activity');
    // Settle every effect the layer's end schedules before reading.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(current().regions.bottom.maximized).toBe(false);
    expect(navigationStore.getSnapshot().isDockMaximized).toBe(false);
    expect(current().regions.main.occupant).toBe('activity');
  });

  // Review round 1: a user's own dock placement survives the round trip
  // through the page — the chord returns Activity to the region it came
  // from, not to its `defaultRegion`.
  test('the chord returns a page to the dock region it was taken from', async () => {
    await mount();
    act(() => current().placeSurface('activity', 'left'));
    await waitFor(() =>
      expect(current().regions.left).toMatchObject({
        occupant: 'activity',
        visible: true,
      }),
    );

    fireEvent.click(activityRow());
    await waitFor(() =>
      expect(current().regions.main.occupant).toBe('activity'),
    );
    act(() => current().toggleSurface('activity'));
    await waitFor(() =>
      expect(current().regions.left).toMatchObject({
        occupant: 'activity',
        visible: true,
      }),
    );
    expect(current().regions.right.panes).not.toContain('activity');
    expect(current().regions.main.occupant).toBeNull();
  });

  // Review round 2: on a DESKTOP a maximized dock hides the route outlet too
  // (a maximized side region hides `.main-content`; a maximized bottom
  // region takes its row), so the page open restores it on every device —
  // and it leaves the reader's maximize MEMORY alone, which is what
  // `focusSession` reopens Chat with.
  test.each(['bottom', 'right'] as const)(
    'on a desktop with Chat maximized in %s, the page open restores the dock and keeps the maximize memory',
    async (region) => {
      await mount();
      if (region === 'right')
        act(() => current().placeSurface('chat', 'right'));
      act(() => navigationStore.setDockState(true, true));
      await waitFor(() =>
        expect(current().regions[region].maximized).toBe(true),
      );
      expect(navigationStore.lastDockMaximized).toBe(true);

      fireEvent.click(activityRow());
      await waitFor(() =>
        expect(current().regions.main.occupant).toBe('activity'),
      );
      await waitFor(() =>
        expect(navigationStore.getSnapshot().isDockMaximized).toBe(false),
      );
      expect(current().regions[region].maximized).toBe(false);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      expect(navigationStore.lastDockMaximized).toBe(true);
    },
  );

  // Review round 2: the remembered dock region also survives Home taking
  // the page back — the chord then SHOWS the unplaced Activity, and that
  // show lands where the user had docked it.
  test('after Home displaces the page, the chord shows Activity in its remembered region', async () => {
    await mount();
    act(() => current().placeSurface('activity', 'left'));
    fireEvent.click(activityRow());
    await waitFor(() =>
      expect(current().regions.main.occupant).toBe('activity'),
    );
    act(() => current().showSurface('home'));
    await waitFor(() => expect(current().regions.main.occupant).toBe('home'));

    act(() => current().toggleSurface('activity'));
    await waitFor(() =>
      expect(current().regions.left).toMatchObject({
        occupant: 'activity',
        visible: true,
      }),
    );
    expect(current().regions.right.panes).not.toContain('activity');
  });
});

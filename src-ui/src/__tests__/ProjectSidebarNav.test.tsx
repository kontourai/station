/**
 * @vitest-environment jsdom
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

// archive#3313: the nav derives surface visibility from live flags (enabled
// feature previews + the developer-tools device setting). The derivation has
// its own test (useSurfaceVisibilityFlags.test.ts); here it is a controllable
// set so these tests pin what the nav DOES with the flags it is given.
const flagsState = vi.hoisted(() => ({ flags: new Set<string>() }));
const regionState = vi.hoisted(() => ({
  showSurfacePage: vi.fn(),
  toggleSurface: vi.fn(),
  activityVisible: false,
  mainOccupant: null as string | null,
}));
vi.mock('../hooks/useSurfaceVisibilityFlags', () => ({
  useSurfaceVisibilityFlags: () => flagsState.flags,
}));
vi.mock('../contexts/RegionModelContext', () => ({
  useRegionModelOptional: () => ({
    toggleSurface: regionState.toggleSurface,
    regions: {
      main: {
        visible: true,
        size: 0,
        panes: regionState.mainOccupant ? [regionState.mainOccupant] : [],
        occupant: regionState.mainOccupant,
      },
      left: { visible: false, size: 400, panes: [], occupant: null },
      right: {
        visible: regionState.activityVisible,
        size: 400,
        panes: ['activity'],
        occupant: 'activity',
      },
      bottom: { visible: true, size: 320, panes: ['chat'], occupant: 'chat' },
    },
  }),
}));
vi.mock('../contexts/useShowSurface', () => ({
  useShowSurfacePage: () => regionState.showSurfacePage,
}));

import { DEVELOPER_TOOLS_FLAG } from '../app-shell/destination-registry';
import { routeTransitionStore } from '../app-shell/route-transition-store';
import { ProjectSidebarNav } from '../components/project-sidebar/ProjectSidebarNav';

describe('ProjectSidebarNav', () => {
  beforeEach(() => {
    flagsState.flags = new Set();
    regionState.showSurfacePage.mockReset();
    regionState.toggleSurface.mockReset();
    regionState.activityVisible = false;
    regionState.mainOccupant = null;
    routeTransitionStore.clearPending(routeTransitionStore.getSnapshot() ?? '');
  });

  // #2059 (design record D3): the left panel lists PLACES only. Agents,
  // Connections, Skills, Registry, Plugins, Schedule and Developer moved
  // behind the gear and the palette; Notifications and Settings became the
  // footer's bell and gear; and the `Customize` and `System` group headers
  // went with them. Activity is what is left — a place, beside Home.
  //
  // This is the panel's whole row inventory, not a "does not contain X" check
  // per removed destination: a list assertion is what notices a row nobody
  // meant to add.
  test('lists places only — Activity, and no configuration rows or group headers', () => {
    window.history.pushState({}, '', '/registry');
    render(
      <ProjectSidebarNav
        collapsed={false}
        isMobile={false}
        navigate={vi.fn()}
      />,
    );

    expect(
      screen.getAllByRole('button').map((button) => button.textContent?.trim()),
    ).toEqual(['Activity']);
    // The two group toggles are gone as controls, not merely collapsed: a
    // collapsed group is still a button that reads "Customize".
    expect(screen.queryByRole('button', { name: 'Customize' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'System' })).toBeNull();
    expect(document.querySelector('[aria-expanded]')).toBeNull();
  });

  // The flag gate is unchanged by the move, and it must not resurrect a row:
  // Developer is advertised as a row of Settings' own section navigation now,
  // never in the panel. That the row exists, points at /developer, and
  // disappears with the flag is covered by `developer-reachable.test.ts`;
  // that it sits under This Station rather than among the Set up entity lists
  // is covered by `SettingsSectionNav.test.tsx`.
  test('keeps Developer out of the panel even with developer tools enabled', () => {
    flagsState.flags = new Set([DEVELOPER_TOOLS_FLAG]);
    render(
      <ProjectSidebarNav
        collapsed={false}
        isMobile={false}
        navigate={vi.fn()}
        activePath="/developer"
      />,
    );
    expect(screen.queryByRole('button', { name: 'Developer' })).toBeNull();
    expect(
      screen.getAllByRole('button').map((button) => button.textContent?.trim()),
    ).toEqual(['Activity']);
  });

  test('marks a row whose route is still loading', () => {
    // SHELL-05: a cold route chunk takes ~1.4 s to arrive. `aria-busy` and
    // the spinner are rendered from the SAME derivation — the suspended route
    // outlet — so neither can claim a pending state the other does not have.
    // The published value is a DESTINATION ID, resolved through the same
    // `getDestinationForView` that decides which row is active.
    render(
      <ProjectSidebarNav
        collapsed={false}
        isMobile={false}
        navigate={vi.fn()}
        activePath="/"
      />,
    );
    const activity = screen.getByRole('button', { name: 'Activity' });
    expect(activity.getAttribute('aria-busy')).toBeNull();

    act(() => {
      routeTransitionStore.setPending('activity');
    });
    expect(activity.getAttribute('aria-busy')).toBe('true');
    expect(activity.className).toContain('sidebar__nav-btn--pending');

    // A pending route that is NOT this row's leaves it alone.
    act(() => {
      routeTransitionStore.clearPending('activity');
      routeTransitionStore.setPending('agents');
    });
    expect(activity.getAttribute('aria-busy')).toBeNull();
    expect(activity.className).not.toContain('sidebar__nav-btn--pending');
  });

  // Activity's row is a PLACE, like Home: it opens Activity as the page, so
  // it is current exactly when `/` shows Activity in `main`. (#1582 D4 had
  // made it a pressed toggle while it only docked Activity beside the page.)
  test('is the current page when Activity occupies main at /', () => {
    regionState.mainOccupant = 'activity';
    render(
      <ProjectSidebarNav
        collapsed={false}
        isMobile={false}
        navigate={vi.fn()}
        activePath="/"
      />,
    );

    const activity = screen.getByRole('button', { name: 'Activity' });
    expect(activity.getAttribute('aria-current')).toBe('page');
    expect(activity.className).toContain('sidebar__nav-btn--active');
    expect(activity.hasAttribute('aria-pressed')).toBe(false);
  });

  // `main` renders only at `/`: on another route the routed view is the
  // page, even with Activity still placed there for the next return.
  test('is not current on another route, even with Activity in main', () => {
    regionState.mainOccupant = 'activity';
    render(
      <ProjectSidebarNav
        collapsed={false}
        isMobile={false}
        navigate={vi.fn()}
        activePath="/settings"
      />,
    );

    const activity = screen.getByRole('button', { name: 'Activity' });
    expect(activity.getAttribute('aria-current')).toBeNull();
    expect(activity.className).not.toContain('sidebar__nav-btn--active');
  });

  // Docked beside Home, Activity is a pane, not the page: Home stays current
  // (`ProjectSidebar`), and this row claims nothing.
  test('is not current while Activity is only docked', () => {
    regionState.activityVisible = true;
    render(
      <ProjectSidebarNav
        collapsed={false}
        isMobile={false}
        navigate={vi.fn()}
        activePath="/"
      />,
    );

    const activity = screen.getByRole('button', { name: 'Activity' });
    expect(activity.getAttribute('aria-current')).toBeNull();
    expect(activity.hasAttribute('aria-pressed')).toBe(false);
  });

  // The press is the page verb in every state — hidden, docked, or already
  // the page — and never the dock toggle (that stays ⌘⇧A's).
  test.each([
    ['hidden', false, null],
    ['docked', true, null],
    ['the page', false, 'activity'],
  ] as const)(
    'pressing the row while Activity is %s opens its page',
    (_label, docked, main) => {
      regionState.activityVisible = docked;
      regionState.mainOccupant = main;
      render(
        <ProjectSidebarNav
          collapsed={false}
          isMobile={false}
          navigate={vi.fn()}
          activePath="/registry"
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Activity' }));
      expect(regionState.showSurfacePage).toHaveBeenCalledWith('activity');
      expect(regionState.toggleSurface).not.toHaveBeenCalled();
    },
  );

  // archive#2652: a stable anchor per management group so the first-run tour
  // can point at a real nav affordance, derived from the registry's semantic
  // owner rather than a parallel list.
  test('carries the first-run anchor for the row it renders', () => {
    render(
      <ProjectSidebarNav
        collapsed={false}
        isMobile={false}
        navigate={vi.fn()}
        activePath="/"
      />,
    );
    expect(
      screen
        .getByRole('button', { name: 'Activity' })
        .getAttribute('data-first-run-anchor'),
    ).toBe('nav-activity');
  });

  test('closes the mobile drawer after a row is used, and only on mobile', () => {
    const onAfterNavigate = vi.fn();
    const { unmount } = render(
      <ProjectSidebarNav
        collapsed={false}
        isMobile={false}
        navigate={vi.fn()}
        activePath="/"
        onAfterNavigate={onAfterNavigate}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Activity' }));
    expect(onAfterNavigate).not.toHaveBeenCalled();
    unmount();

    render(
      <ProjectSidebarNav
        collapsed={false}
        isMobile={true}
        navigate={vi.fn()}
        activePath="/"
        onAfterNavigate={onAfterNavigate}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Activity' }));
    expect(onAfterNavigate).toHaveBeenCalledTimes(1);
  });
});

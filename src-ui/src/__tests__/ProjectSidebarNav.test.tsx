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
  showSurface: vi.fn(),
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
  useShowSurface: () => regionState.showSurface,
}));

import { DEVELOPER_TOOLS_FLAG } from '../app-shell/destination-registry';
import { routeTransitionStore } from '../app-shell/route-transition-store';
import { ProjectSidebarNav } from '../components/project-sidebar/ProjectSidebarNav';

describe('ProjectSidebarNav', () => {
  beforeEach(() => {
    flagsState.flags = new Set();
    regionState.showSurface.mockReset();
    regionState.toggleSurface.mockReset();
    regionState.activityVisible = false;
    regionState.mainOccupant = null;
    routeTransitionStore.clearPending(routeTransitionStore.getSnapshot() ?? '');
  });

  // #2059 (design record D3): the left panel lists PLACES only. Agents,
  // Connections, Guidance, Registry, Plugins, Schedule and Developer moved
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
  // Developer is advertised in Settings' Manage group now (covered by
  // SettingsManageSection.test.tsx), never in the panel.
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

  // #1582 D4: Activity's row places a surface — it never navigates, and the
  // audit found it wearing the same current-page highlight as Home while the
  // URL was unchanged, so two rows read as "you are here" at once. Its state
  // is `aria-pressed` plus a distinct `--shown` mark, and `aria-current`
  // stays the exclusive property of a routed row.
  test('marks Activity as a pressed toggle from visible region occupancy, never as the current page', () => {
    regionState.activityVisible = true;
    render(
      <ProjectSidebarNav
        collapsed={false}
        isMobile={false}
        navigate={vi.fn()}
        activePath="/registry"
      />,
    );

    const activity = screen.getByRole('button', { name: 'Activity' });
    expect(activity.getAttribute('aria-pressed')).toBe('true');
    expect(activity.className).toContain('sidebar__nav-btn--shown');
    expect(activity.className).not.toContain('sidebar__nav-btn--active');
    expect(activity.getAttribute('aria-current')).toBeNull();
    expect(
      screen
        .getAllByRole('button')
        .filter((button) => button.getAttribute('aria-current') === 'page'),
    ).toHaveLength(0);
  });

  // A control that reports `aria-pressed` has to un-press, or the state it
  // announces is a label nothing acts on. Hiding goes through the model's own
  // toggle (#1523), so the sidebar keeps no copy of the placement rules.
  test('pressing a shown region-surface row hides it through the model toggle', () => {
    regionState.activityVisible = true;
    render(
      <ProjectSidebarNav
        collapsed={false}
        isMobile={false}
        navigate={vi.fn()}
        activePath="/registry"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Activity' }));
    expect(regionState.toggleSurface).toHaveBeenCalledWith('activity');
    expect(regionState.showSurface).not.toHaveBeenCalled();
  });

  test('pressing a hidden region-surface row reveals it through the show seam', () => {
    // Revealing keeps `useShowSurface`, which routes to the canonical deep
    // link when no region host is mounted — the model's toggle has no such
    // fallback.
    regionState.activityVisible = false;
    render(
      <ProjectSidebarNav
        collapsed={false}
        isMobile={false}
        navigate={vi.fn()}
        activePath="/registry"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Activity' }));
    expect(regionState.showSurface).toHaveBeenCalledWith('activity');
    expect(regionState.toggleSurface).not.toHaveBeenCalled();
  });

  test('reports Activity as not pressed while its region is hidden', () => {
    regionState.activityVisible = false;
    render(
      <ProjectSidebarNav
        collapsed={false}
        isMobile={false}
        navigate={vi.fn()}
        activePath="/registry"
      />,
    );

    const activity = screen.getByRole('button', { name: 'Activity' });
    expect(activity.getAttribute('aria-pressed')).toBe('false');
    expect(activity.className).not.toContain('sidebar__nav-btn--shown');
  });

  // #928 lets Activity take the primary area. A surface showing in `main` is
  // no less shown than one in a side region, and the row must say so — the
  // pre-#1582 read only looked at the dock regions.
  test('marks Activity as pressed when it occupies main', () => {
    regionState.mainOccupant = 'activity';
    regionState.activityVisible = false;
    render(
      <ProjectSidebarNav
        collapsed={false}
        isMobile={false}
        navigate={vi.fn()}
        activePath="/registry"
      />,
    );

    expect(
      screen
        .getByRole('button', { name: 'Activity' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
  });

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

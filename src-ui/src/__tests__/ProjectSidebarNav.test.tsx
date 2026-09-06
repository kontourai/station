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
  activityVisible: false,
  mainOccupant: null as string | null,
}));
vi.mock('../hooks/useSurfaceVisibilityFlags', () => ({
  useSurfaceVisibilityFlags: () => flagsState.flags,
}));
vi.mock('../contexts/RegionModelContext', () => ({
  useRegionModelOptional: () => ({
    regions: {
      main: { visible: true, size: 0, occupant: regionState.mainOccupant },
      left: { visible: false, size: 400, occupant: null },
      right: {
        visible: regionState.activityVisible,
        size: 400,
        occupant: 'activity',
      },
      bottom: { visible: true, size: 320, occupant: 'chat' },
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
    regionState.activityVisible = false;
    regionState.mainOccupant = null;
    routeTransitionStore.clearPending(routeTransitionStore.getSnapshot() ?? '');
  });

  test('marks only the row whose route is still loading', () => {
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
        activePath="/registry"
      />,
    );
    const registry = screen.getByRole('button', { name: 'Registry' });
    const schedule = screen.getByRole('button', { name: 'Schedule' });
    expect(schedule.getAttribute('aria-busy')).toBeNull();

    act(() => {
      routeTransitionStore.setPending('schedule');
    });
    expect(schedule.getAttribute('aria-busy')).toBe('true');
    expect(schedule.className).toContain('sidebar__nav-btn--pending');
    expect(registry.getAttribute('aria-busy')).toBeNull();

    act(() => {
      routeTransitionStore.clearPending('schedule');
    });
    expect(schedule.getAttribute('aria-busy')).toBeNull();
    expect(schedule.className).not.toContain('sidebar__nav-btn--pending');
  });
  test('leads with a flat primary band and shows every destination at once', () => {
    window.history.pushState({}, '', '/registry');
    const navigate = vi.fn();

    render(
      <ProjectSidebarNav
        collapsed={false}
        isMobile={false}
        navigate={navigate}
      />,
    );

    const customize = screen.getByRole('button', { name: 'Customize' });
    const system = screen.getByRole('button', { name: 'System' });
    // SHELL-15: both groups start open. They used to be MUTUALLY EXCLUSIVE
    // accordions derived from the route — exactly one open, and neither on
    // Home — so every cross-group move cost two clicks.
    expect(customize.getAttribute('aria-expanded')).toBe('true');
    expect(system.getAttribute('aria-expanded')).toBe('true');
    // RT-13 / SHELL-08: Agents, Connections and Activity are top-level rows
    // ahead of both group toggles, not entries inside a collapsed group.
    expect(
      screen.getAllByRole('button').map((button) => button.textContent?.trim()),
    ).toEqual([
      'Agents',
      'Connections',
      'Activity',
      'Customize−',
      'Guidance',
      'Registry',
      'System−',
      'Review',
      'Plugins',
      'Notifications',
      'Schedule',
      'Settings',
    ]);
    expect(
      screen.getByRole('button', { name: 'Registry' }).className,
    ).toContain('sidebar__nav-btn--active');
    expect(
      screen
        .getAllByRole('button')
        .some((button) => button.textContent?.trim() === 'Prompts'),
    ).toBe(false);
    expect(
      screen
        .getByRole('button', { name: 'Schedule' })
        .getAttribute('data-first-run-anchor'),
    ).toBe('nav-schedule');
    fireEvent.click(screen.getByRole('button', { name: 'Agents' }));
    expect(navigate).toHaveBeenCalledWith('/agents');

    fireEvent.click(screen.getByRole('button', { name: 'Guidance' }));
    expect(navigate).toHaveBeenCalledWith('/guidance');

    fireEvent.click(screen.getByRole('button', { name: 'Activity' }));
    expect(regionState.showSurface).toHaveBeenCalledWith('activity');
  });

  test('is expanded by default on Home and is keyboard-operable', () => {
    window.history.pushState({}, '', '/');
    render(
      <ProjectSidebarNav
        collapsed={false}
        isMobile={false}
        navigate={vi.fn()}
      />,
    );
    const customize = screen.getByRole('button', { name: 'Customize' });
    expect(customize.tagName).toBe('BUTTON');
    expect(customize.getAttribute('type')).toBe('button');
    expect(customize.getAttribute('aria-controls')).toBe(
      'sidebar-customize-nav',
    );
    // SHELL-15 measured Home as the worst case: BOTH groups collapsed, so
    // every one of the management destinations cost two clicks from Home.
    expect(customize.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: 'Guidance' })).toBeTruthy();
    fireEvent.click(customize);
    expect(customize.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: 'Guidance' })).toBeNull();
  });

  test.each([
    ['/connections/models/demo', 'Connections'],
    ['/connections/tools', 'Connections'],
    ['/connections/engines', 'Connections'],
    ['/guidance?tab=commands', 'Guidance'],
    ['/guidance?tab=skills', 'Guidance'],
    ['/agents', 'Agents'],
  ])('highlights the owning row for canonical path %s', (path, label) => {
    render(
      <ProjectSidebarNav
        collapsed={false}
        isMobile={false}
        navigate={vi.fn()}
        activePath={path}
      />,
    );
    expect(screen.getByRole('button', { name: label }).className).toContain(
      'sidebar__nav-btn--active',
    );
  });

  // #1582 D4: Activity's row places a surface — it never navigates, and the
  // audit found it wearing the same current-page highlight as Home while the
  // URL was unchanged, so two rows read as "you are here" at once. Its state
  // is now `aria-pressed` plus a distinct `--shown` mark, and `aria-current`
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

    // The routed row is the one that is current, and it is the only one.
    const registry = screen.getByRole('button', { name: 'Registry' });
    expect(registry.getAttribute('aria-current')).toBe('page');
    expect(registry.getAttribute('aria-pressed')).toBeNull();
    expect(
      screen
        .getAllByRole('button')
        .filter((button) => button.getAttribute('aria-current') === 'page'),
    ).toHaveLength(1);
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

  test('shows and highlights Developer only while the developer-tools flag is enabled (station#3313)', () => {
    const { unmount } = render(
      <ProjectSidebarNav
        collapsed={false}
        isMobile={false}
        navigate={vi.fn()}
        activePath="/developer/telemetry"
      />,
    );
    // Default flags: gated off — Developer never appears, even on its own
    // route (which still opens the System group it belongs to).
    expect(
      screen
        .getByRole('button', { name: 'System' })
        .getAttribute('aria-expanded'),
    ).toBe('true');
    expect(screen.queryByRole('button', { name: 'Developer' })).toBeNull();
    unmount();

    flagsState.flags = new Set([DEVELOPER_TOOLS_FLAG]);
    render(
      <ProjectSidebarNav
        collapsed={false}
        isMobile={false}
        navigate={vi.fn()}
        activePath="/developer/telemetry"
      />,
    );
    expect(
      screen
        .getByRole('button', { name: 'System' })
        .getAttribute('aria-expanded'),
    ).toBe('true');
    expect(
      screen.getByRole('button', { name: 'Developer' }).className,
    ).toContain('sidebar__nav-btn--active');
  });

  test("keeps the user's own collapse across navigation instead of deriving it from the route", () => {
    // SHELL-15's mechanism, not just its symptom: the open group used to be
    // COMPUTED from the active route, so a collapse the user performed was
    // silently reinstated (or reversed) by the next navigation. Collapsing
    // System here and then navigating INTO a System route is the case that
    // separates "the user's choice persists" from "the route decides".
    const { rerender } = render(
      <ProjectSidebarNav
        collapsed={false}
        isMobile={false}
        navigate={vi.fn()}
        activePath="/registry"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'System' }));
    expect(
      screen
        .getByRole('button', { name: 'System' })
        .getAttribute('aria-expanded'),
    ).toBe('false');

    rerender(
      <ProjectSidebarNav
        collapsed={false}
        isMobile={false}
        navigate={vi.fn()}
        activePath="/schedule"
      />,
    );
    expect(
      screen
        .getByRole('button', { name: 'System' })
        .getAttribute('aria-expanded'),
    ).toBe('false');
    // Customize was never touched, so it is still open — the two groups are
    // independent now, not one exclusive selection.
    expect(
      screen
        .getByRole('button', { name: 'Customize' })
        .getAttribute('aria-expanded'),
    ).toBe('true');
  });

  test('keeps the legacy Schedule navigation available', () => {
    const navigate = vi.fn();
    render(
      <ProjectSidebarNav
        collapsed={false}
        isMobile={false}
        navigate={navigate}
        activePath="/schedule"
      />,
    );
    const schedule = screen.getByRole('button', { name: 'Schedule' });
    expect(schedule.getAttribute('aria-disabled')).toBeNull();

    fireEvent.click(schedule);
    expect(navigate).toHaveBeenCalledWith('/schedule');
  });
});

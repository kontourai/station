/** @vitest-environment jsdom */

/**
 * (archive#4090): while a route's pane occupies the ambient dock, the
 * route renders an AWAY STATE instead of a second live copy of the pane —
 * and derives "away" from the host's published occupant state through
 * `isAmbientDockOccupant`, never a route-local flag.
 *
 * These tests drive the derivation's ONE input (the context the ambient host
 * publishes through) and assert the route follows it in both directions:
 * occupant = my pane → away state; occupant = anything else, or no
 * publishing host at all → the pane renders. A hand-rolled route-side flag
 * cannot follow this feed, so replacing the derivation with one fails here.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

const selection = vi.hoisted(() => ({
  // The shape HomeView/ActivityView admit as "builtin selected": pane
  // selection is not what these tests exercise, so it stays permissive.
  result: {
    state: 'selected',
    candidate: {
      source: 'primary',
      renderer: { kind: 'builtin-component', name: 'stub' },
    },
  } as unknown,
}));
const regionOccupant = vi.hoisted(() => ({ activity: false }));

vi.mock('../contexts/RegionModelContext', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../contexts/RegionModelContext')>();
  return {
    ...actual,
    useRegionModelOptional: () =>
      regionOccupant.activity
        ? {
            regions: {
              main: { visible: true, size: 0, occupant: null },
              left: { visible: false, size: 400, occupant: null },
              right: { visible: true, size: 400, occupant: 'activity' },
              bottom: { visible: true, size: 320, occupant: 'chat' },
            },
          }
        : null,
  };
});

vi.mock('../workspace-panes/workspacePaneRendererSelection', () => ({
  selectClientWorkspacePaneRenderer: () => selection.result,
}));

vi.mock('../views/home/useHomeViewModel', () => ({
  useHomeViewModel: () => ({ workItems: [], projects: [] }),
}));

vi.mock('../views/home/HomeWorkspacePane', () => ({
  HomeWorkspacePaneBindingProvider: ({
    children,
  }: {
    children: React.ReactNode;
  }) => <>{children}</>,
  HomeWorkspacePane: () => <div data-testid="home-surface" />,
}));

vi.mock('../components/first-run/FirstRunHomeChapter', () => ({
  FirstRunHomeChapter: () => null,
}));

vi.mock('../contexts/ConfigContext', () => ({ useConfig: () => null }));

vi.mock('../views/home/useWorkspaceHomeRole', () => ({
  useWorkspaceHomeRoleStatus: () => ({ state: 'none' }),
  useRevokeWorkspaceHomeRole: () => () => undefined,
}));

vi.mock('../views/activity/ActivityWorkspacePane', () => ({
  ActivityWorkspacePane: () => <div data-testid="activity-surface" />,
}));

// station#520: real `useIsMobile()` is correctly "desktop" in jsdom's
// default (unmocked matchMedia) environment — the posture-aware copy tests
// below flip this to exercise the phone branch without depending on a real
// `matchMedia` breakpoint match.
const mobileFlag = vi.hoisted(() => ({ isMobile: false }));
vi.mock('../hooks/useIsMobile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/useIsMobile')>();
  return { ...actual, useIsMobile: () => mobileFlag.isMobile };
});

import { WORKSPACE_ACTIVITY_PANE_INSTANCE } from '@kontourai/station-contracts/workspace-activity-pane';
import { WORKSPACE_HOME_PANE_INSTANCE } from '@kontourai/station-contracts/workspace-home-pane';
import { workspacePaneHostSuppliableContexts } from '@kontourai/station-contracts/workspace-pane-host';
import { ActivityView } from '../views/ActivityView';
import { HomeView } from '../views/HomeView';
import {
  type WorkspacePaneDockAction,
  WorkspacePaneDockContext,
} from '../workspace-panes/WorkspacePaneDockContext';

beforeEach(() => {
  mobileFlag.isMobile = false;
  regionOccupant.activity = false;
});

function publishedAction(
  occupantInstanceId: string,
  undockOccupant: () => void = () => {},
): WorkspacePaneDockAction {
  return {
    suppliable: workspacePaneHostSuppliableContexts({ kind: 'ambient' }),
    dockPane: () => {},
    dockPaneAsOnlyContent: () => {},
    occupantInstanceId,
    undockOccupant,
  };
}

function renderHome(action: WorkspacePaneDockAction | null) {
  return render(
    <WorkspacePaneDockContext.Provider value={action}>
      <HomeView continuation={null} onNavigate={() => {}} />
    </WorkspacePaneDockContext.Provider>,
  );
}

function renderActivity(action: WorkspacePaneDockAction | null) {
  return render(
    <WorkspacePaneDockContext.Provider value={action}>
      <ActivityView apiBase="http://test.local" />
    </WorkspacePaneDockContext.Provider>,
  );
}

test('Home renders its away state while the published dock occupant is Home', () => {
  renderHome(publishedAction(WORKSPACE_HOME_PANE_INSTANCE.instanceId));
  expect(screen.getByText('Home is in the dock')).not.toBeNull();
  expect(
    screen.getByRole('button', { name: 'Bring it back here' }),
  ).not.toBeNull();
  expect(
    screen.queryByTestId('home-surface'),
    'the away state REPLACES the pane — no second co-mounted copy',
  ).toBeNull();
});

test('Home renders its pane again the moment the occupant is someone else', () => {
  // The transition most likely to be wrong ( acceptance 1): the dock moved
  // on to Activity, so Home is NOT docked anymore and `/` must render it.
  renderHome(publishedAction(WORKSPACE_ACTIVITY_PANE_INSTANCE.instanceId));
  expect(screen.queryByText('Home is in the dock')).toBeNull();
  expect(screen.getByTestId('home-surface')).not.toBeNull();
});

test('Home renders its pane when no host publishes an occupant at all', () => {
  // No dock action means no dock — "away" cannot be derived, so it is not
  // shown. A hand-rolled flag could survive the host unmounting; the
  // derivation cannot.
  renderHome(null);
  expect(screen.queryByText('Home is in the dock')).toBeNull();
  expect(screen.getByTestId('home-surface')).not.toBeNull();
});

test("Home's away action asks the HOST to undock — it owns no dock semantics", () => {
  const undock = vi.fn();
  renderHome(publishedAction(WORKSPACE_HOME_PANE_INSTANCE.instanceId, undock));
  fireEvent.click(screen.getByRole('button', { name: 'Bring it back here' }));
  expect(undock).toHaveBeenCalledTimes(1);
});

test('Activity renders its away state while the published dock occupant is Activity', () => {
  renderActivity(publishedAction(WORKSPACE_ACTIVITY_PANE_INSTANCE.instanceId));
  expect(screen.getByText('Activity is in the dock')).not.toBeNull();
  expect(
    screen.getByRole('button', { name: 'Bring it back here' }),
  ).not.toBeNull();
  expect(screen.queryByTestId('activity-surface')).toBeNull();
});

test('Activity renders its pane when the occupant is someone else or absent', () => {
  renderActivity(publishedAction(WORKSPACE_HOME_PANE_INSTANCE.instanceId));
  expect(screen.queryByText('Activity is in the dock')).toBeNull();
  expect(screen.getByTestId('activity-surface')).not.toBeNull();
});

test('Activity route points at its occupied region without mounting a second pane', () => {
  regionOccupant.activity = true;
  renderActivity(publishedAction(WORKSPACE_HOME_PANE_INSTANCE.instanceId));

  expect(screen.getByText('Activity is in Right region')).not.toBeNull();
  expect(screen.queryByTestId('activity-surface')).toBeNull();
  expect(
    screen.queryByRole('button', { name: 'Bring it back here' }),
  ).toBeNull();
});

test("Activity's away action asks the HOST to undock", () => {
  const undock = vi.fn();
  renderActivity(
    publishedAction(WORKSPACE_ACTIVITY_PANE_INSTANCE.instanceId, undock),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Bring it back here' }));
  expect(undock).toHaveBeenCalledTimes(1);
});

/* ------------------------------------------------------------------ *
 * station#520 part 2: posture-aware away-state copy. "Docked at the edge
 * of your workspace" is desktop-specific (a side/bottom panel); on mobile
 * every dock is a bottom bar, so the away state must say that instead. The
 * action text ("Bring it back here") stays identical on both postures —
 * only the label/description name the dock's shape.
 * ------------------------------------------------------------------ */

test('desktop: away-state copy names the dock at the edge of the workspace', () => {
  mobileFlag.isMobile = false;
  renderHome(publishedAction(WORKSPACE_HOME_PANE_INSTANCE.instanceId));
  expect(screen.getByText('Home is in the dock')).not.toBeNull();
  expect(
    screen.getByText(
      'This pane is currently docked at the edge of your workspace.',
    ),
  ).not.toBeNull();
});

test('mobile: away-state copy names the bottom bar, not "the edge of your workspace"', () => {
  mobileFlag.isMobile = true;
  renderHome(publishedAction(WORKSPACE_HOME_PANE_INSTANCE.instanceId));
  expect(screen.getByText('Home is in the bottom bar')).not.toBeNull();
  expect(
    screen.getByText('This pane is currently docked in the bottom bar.'),
  ).not.toBeNull();
  expect(
    screen.queryByText(/edge of your workspace/),
    'desktop-specific copy must not survive onto the phone posture',
  ).toBeNull();
  // The action stays identical on both postures.
  expect(
    screen.getByRole('button', { name: 'Bring it back here' }),
  ).not.toBeNull();
});

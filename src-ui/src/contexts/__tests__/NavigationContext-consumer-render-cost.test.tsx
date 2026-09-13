/**
 * @vitest-environment jsdom
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { Profiler, useState } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * `useNavigation()` subscribes its caller to the WHOLE navigation store, so
 * every dock toggle, workspace-pane change or font-size write re-rendered all
 * ~66 consumers — including `ProjectSidebarRow`, which is mounted once per
 * project and reads a single route field.
 *
 * This harness measures that directly: a real `ProjectSidebarRow` under a
 * `<Profiler>` while the navigation store takes N updates that touch nothing
 * the row reads. Measured on this tree before the selector landed: 8 extra
 * commits for 8 dock toggles (one per store notification); after: 0.
 *
 * Two things keep the zero honest. The whole-snapshot control probe must
 * still re-render N times — otherwise a row that never re-renders is
 * indistinguishable from a store that never notified. And the second test
 * pins the other direction: a change to the field the row DOES read must
 * still reach it, so the cost was removed rather than the subscription.
 */

const rowRenders = vi.hoisted(() => ({ count: 0 }));

vi.mock('@kontourai/station-sdk', () => ({
  useProjectLayoutsQuery: () => ({ data: undefined }),
  useBoardAvailabilityQuery: () => ({ data: undefined }),
  useOrchestrationSessionsQuery: () => ({ data: [] }),
  useReorderProjectsMutation: () => ({ mutate: vi.fn() }),
  useFeaturePreviewsQuery: () => ({ data: [] }),
}));

// Counts renders of the REAL row. The mounted test below needs per-row
// renders, not subtree commits: a row re-renders whenever its parent does,
// whatever its own subscription says, and that is the whole point of M1.
vi.mock(
  '../../components/project-sidebar/ProjectSidebarRow',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../components/project-sidebar/ProjectSidebarRow')
      >();
    return {
      ProjectSidebarRow: (
        props: Parameters<typeof actual.ProjectSidebarRow>[0],
      ) => {
        rowRenders.count += 1;
        return <actual.ProjectSidebarRow {...props} />;
      },
    };
  },
);

// The sidebar's own dependencies, mirroring ProjectSidebar.test.tsx's mock
// shape. NavigationContext is deliberately NOT mocked here — the real hook
// and the real store are the subject.
const PROJECTS = [
  {
    id: 'p1',
    slug: 'alpha',
    name: 'Alpha',
    hasWorkingDirectory: true,
    layoutCount: 1,
    hasKnowledge: false,
  },
  {
    id: 'p2',
    slug: 'beta',
    name: 'Beta',
    hasWorkingDirectory: true,
    layoutCount: 1,
    hasKnowledge: false,
  },
  {
    id: 'p3',
    slug: 'gamma',
    name: 'Gamma',
    hasWorkingDirectory: true,
    layoutCount: 1,
    hasKnowledge: false,
  },
];

vi.mock('../ProjectsContext', () => ({
  useProjects: () => ({ projects: PROJECTS, isLoading: false }),
}));
vi.mock('../AgentsContext', () => ({ useAgents: () => [] }));
vi.mock('../ActiveChatsContext', () => ({ useAllActiveChats: () => ({}) }));
vi.mock('../open-chats-store', () => ({
  useOpenChats: () => [],
  openChatsStore: {
    focus: vi.fn(),
    openCollection: vi.fn(),
    registerNavigation: () => vi.fn(),
  },
}));
vi.mock('../useShowSurface', () => ({ useShowSurface: () => vi.fn() }));
vi.mock('../RegionModelContext', () => ({
  useRegionModelOptional: () => null,
}));
vi.mock('../../hooks/useBranding', () => ({
  useBranding: () => ({ appName: 'Station' }),
}));
vi.mock('../../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => ({ isTauri: false }),
}));
vi.mock('../../hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../../build-info', () => ({
  buildInfo: { version: '0.0.0-test', commit: 'test' },
}));

import { ProjectSidebar } from '../../components/project-sidebar/ProjectSidebar';
import { ProjectSidebarRow } from '../../components/project-sidebar/ProjectSidebarRow';
import {
  NavigationProvider,
  navigationStore,
  useNavigation,
  useNavigationActions,
} from '../NavigationContext';
import type { ProjectMetadata } from '../ProjectsContext';

const NAVIGATION_UPDATES = 8;

const PROJECT: ProjectMetadata = {
  id: 'p1',
  slug: 'demo',
  name: 'Demo',
  hasWorkingDirectory: true,
  layoutCount: 2,
  hasKnowledge: false,
};

function renderRowWithProbe(): {
  rowCommits: () => number;
  probeRenders: () => number;
} {
  let rowCommits = 0;
  let probeRenders = 0;

  function WholeSnapshotProbe() {
    // The control: reads the whole snapshot, so it re-renders on every store
    // notification. Proves the updates below really are observable.
    useNavigation();
    probeRenders += 1;
    return <div data-testid="probe" />;
  }

  render(
    <NavigationProvider>
      <Profiler
        id="sidebar-row"
        onRender={() => {
          rowCommits += 1;
        }}
      >
        <ProjectSidebarRow
          project={PROJECT}
          isActive={false}
          activeLayout={null}
          collapsed={false}
        />
      </Profiler>
      <WholeSnapshotProbe />
    </NavigationProvider>,
  );

  return { rowCommits: () => rowCommits, probeRenders: () => probeRenders };
}

describe('navigation store fan-out to a per-project sidebar row', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
    // `navigate` commits the parsed URL; `setDockState` alone early-returns
    // when the search string is already what it would write, which would let
    // a previous test's `selectedProject` survive into this one.
    navigationStore.navigate('/');
    navigationStore.setDockState(false);
  });

  test('a sidebar row does not re-render for navigation changes it does not read', () => {
    const { rowCommits, probeRenders } = renderRowWithProbe();
    const rowCommitsAfterMount = rowCommits();
    const probeRendersAfterMount = probeRenders();

    for (let i = 0; i < NAVIGATION_UPDATES; i += 1) {
      act(() => {
        navigationStore.setDockState(i % 2 === 0);
      });
    }

    // Not vacuous: the store really did change and really did notify.
    expect(navigationStore.getSnapshot().isDockOpen).toBe(false);
    expect(probeRenders() - probeRendersAfterMount).toBe(NAVIGATION_UPDATES);

    expect(rowCommits() - rowCommitsAfterMount).toBe(0);
  });

  test('every mounted sidebar row is spared an unrelated navigation write', () => {
    // The isolated test above measures the ROW's own subscription, which is
    // not what decides whether it renders. This one measures the shape the
    // app mounts: rows under the real ProjectSidebar, under a parent that
    // reads the whole snapshot — `App` (App.tsx:177-185, `<ProjectSidebar />`
    // at :629) reads `lastProject`/`lastProjectLayout`, store memory no
    // selector can see, so it re-renders on every store write and always
    // will. Before ProjectSidebar took a selector AND a memo boundary this
    // read 24: three rows, eight dock toggles, every one of them through the
    // parent.
    rowRenders.count = 0;
    let probeRenders = 0;

    function WholeSnapshotProbe() {
      useNavigation();
      probeRenders += 1;
      return <div />;
    }

    function AppLikeParent() {
      // Stands in for App: subscribes to everything, renders the sidebar.
      useNavigation();
      return <ProjectSidebar />;
    }

    render(
      <NavigationProvider>
        <AppLikeParent />
        <WholeSnapshotProbe />
      </NavigationProvider>,
    );

    // Three rows really are mounted, so a 0 below is a spared row, not an
    // empty list.
    expect(rowRenders.count).toBe(3);
    const rowRendersAfterMount = rowRenders.count;
    const probeRendersAfterMount = probeRenders;

    for (let i = 0; i < NAVIGATION_UPDATES; i += 1) {
      act(() => {
        navigationStore.setDockState(i % 2 === 0);
      });
    }

    expect(probeRenders - probeRendersAfterMount).toBe(NAVIGATION_UPDATES);
    expect(rowRenders.count - rowRendersAfterMount).toBe(0);
  });

  test('an object selector holds its reference across unrelated store writes', () => {
    // `useNewChatSelectionModel` selects two fields as one object, so the
    // selector allocates a fresh object on every notification. The default
    // shallow compare is what keeps that from re-rendering the consumer.
    let selectorRenders = 0;
    let probeRenders = 0;

    function ObjectSelectorProbe() {
      const { selectedProject, selectedProjectLayout } = useNavigation(
        (state) => ({
          selectedProject: state.selectedProject,
          selectedProjectLayout: state.selectedProjectLayout,
        }),
      );
      selectorRenders += 1;
      return <div>{`${selectedProject}:${selectedProjectLayout}`}</div>;
    }

    function WholeSnapshotProbe() {
      useNavigation();
      probeRenders += 1;
      return <div />;
    }

    render(
      <NavigationProvider>
        <ObjectSelectorProbe />
        <WholeSnapshotProbe />
      </NavigationProvider>,
    );
    const selectorRendersAfterMount = selectorRenders;
    const probeRendersAfterMount = probeRenders;

    for (let i = 0; i < NAVIGATION_UPDATES; i += 1) {
      act(() => {
        navigationStore.setDockState(i % 2 === 0);
      });
    }

    expect(probeRenders - probeRendersAfterMount).toBe(NAVIGATION_UPDATES);
    expect(selectorRenders - selectorRendersAfterMount).toBe(0);

    // And the selected fields still reach it when they change.
    act(() => {
      navigationStore.setProject('demo');
    });
    expect(navigationStore.getSnapshot().selectedProject).toBe('demo');
    expect(selectorRenders).toBeGreaterThan(selectorRendersAfterMount);
  });

  test('the actions object is identical across a store write and a provider re-render', () => {
    // The whole reason `useNavigationActions` can skip the subscription is
    // that the provider publishes ONE actions object for its lifetime
    // (archive#3796). Every consumer destructures it, so nothing else in the
    // suite would notice this hook handing back a fresh object per render —
    // and a fresh one puts every consumer's `useEffect`/`useCallback`
    // dependency on it back in play.
    const seen: unknown[] = [];
    let forceHostRender: () => void = () => {};

    function ActionsProbe() {
      seen.push(useNavigationActions());
      return null;
    }

    function Host() {
      const [tick, setTick] = useState(0);
      forceHostRender = () => setTick(tick + 1);
      return (
        <NavigationProvider>
          <ActionsProbe />
          <span>{tick}</span>
        </NavigationProvider>
      );
    }

    render(<Host />);
    expect(seen).toHaveLength(1);

    act(() => {
      navigationStore.setDockState(true);
    });
    // A store write does not reach an actions-only consumer at all.
    expect(navigationStore.getSnapshot().isDockOpen).toBe(true);
    expect(seen).toHaveLength(1);

    // Re-render the provider itself; the actions must survive it by identity.
    act(() => {
      forceHostRender();
    });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(seen[0]);
  });

  test('a selector that closes over a prop re-selects when the prop changes', () => {
    // No store write happens here at all. Caching the selection on snapshot
    // identity alone made the consumer read a value built from the previous
    // prop until the next unrelated navigation write.
    const seen: string[] = [];

    function Child({ label }: { label: string }) {
      const value = useNavigation(
        (state) => `${label}:${state.selectedProject ?? 'none'}`,
      );
      seen.push(value);
      return <div>{value}</div>;
    }

    function Parent() {
      const [label, setLabel] = useState('a');
      return (
        <>
          <button type="button" onClick={() => setLabel('b')}>
            flip
          </button>
          <Child label={label} />
        </>
      );
    }

    render(
      <NavigationProvider>
        <Parent />
      </NavigationProvider>,
    );
    const before = seen[seen.length - 1];
    expect(before.startsWith('a:')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'flip' }));

    // Same store value, new prop: the selected half is unchanged and the
    // closed-over half moved, which is only true if the selection re-ran.
    const after = `b:${before.slice('a:'.length)}`;
    expect(seen[seen.length - 1]).toBe(after);
    expect(screen.getByText(after)).toBeTruthy();
  });

  test('a sidebar row still re-renders when the route it reads changes', () => {
    const { rowCommits } = renderRowWithProbe();
    const rowCommitsAfterMount = rowCommits();

    act(() => {
      navigationStore.navigate('/projects/demo/session-board');
    });

    expect(navigationStore.getSnapshot().pathname).toBe(
      '/projects/demo/session-board',
    );
    expect(rowCommits()).toBeGreaterThan(rowCommitsAfterMount);
  });
});

/**
 * @vitest-environment jsdom
 */

import { act, render } from '@testing-library/react';
import { Profiler } from 'react';
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

vi.mock('@kontourai/station-sdk', () => ({
  useProjectLayoutsQuery: () => ({ data: undefined }),
  useBoardAvailabilityQuery: () => ({ data: undefined }),
}));

import { ProjectSidebarRow } from '../../components/project-sidebar/ProjectSidebarRow';
import {
  NavigationProvider,
  navigationStore,
  useNavigation,
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

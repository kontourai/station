/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  navigate: vi.fn(),
  mutate: vi.fn(),
}));

let queryResult: {
  data: unknown;
  isLoading: boolean;
  error: Error | null;
};

let hasBuilderRun = true;

const refetchProjects = vi.fn();
let projectsQueryResult: {
  data: unknown;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
} = {
  data: [{ id: 'demo-id', slug: 'demo', name: 'Demo project' }],
  isLoading: false,
  isError: false,
  error: null,
};

vi.mock('../../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate: hoisted.navigate }),
}));

vi.mock('../../contexts/ConfigContext', () => ({
  useConfig: () => ({}),
}));

let coarsePointer = false;
vi.mock('../../hooks/useIsMobile', () => ({
  useIsMobile: () => coarsePointer,
}));

vi.mock('@kontourai/station-sdk', () => ({
  authenticatedFetch: vi.fn(),
  useOperatingStateQuery: () => ({ ...queryResult, refetch: vi.fn() }),
  useBoardAvailabilityQuery: () => ({
    data: { hasBuilderRun },
    isLoading: false,
  }),
  useProjectsQuery: () => ({
    ...projectsQueryResult,
    refetch: refetchProjects,
  }),
  useProjectLayoutsQuery: () => ({
    data: [],
    isLoading: false,
    isError: false,
  }),
  useConsoleBoardIntentMutation: () => ({ mutate: hoisted.mutate }),
}));

import { PAGE_HEADER_CLASS, PageFrame } from '../../components/page-frame';
import { bannerStore } from '../../contexts/banner-store';
import {
  BOARD_UNAVAILABLE_BANNER_ID,
  BOARD_UNAVAILABLE_NOTICE,
} from '../board/BoardWorkspacePane';
import { ConsoleBoardView } from '../ConsoleBoardView';

function renderView(requireBuilderRun = true) {
  return render(
    <ConsoleBoardView
      projectSlug="demo"
      requireBuilderRun={requireBuilderRun}
    />,
  );
}

/**
 * These tests render the whole chain deliberately — the route host
 * (`ConsoleBoardView`, slug→id occurrence + renderer selection), the one
 * mounter (`BoardWorkspacePane`, canonical check + identity + shell
 * bindings), and the packaged surface (`@kontourai/station-board-pane`'s
 * `ConsoleBoardPane`) — so every assertion below proves the extracted Board
 * behaves exactly as the pre-extraction view did, through the pane path.
 */
describe('ConsoleBoardView', () => {
  beforeEach(() => {
    hoisted.navigate.mockClear();
    hoisted.mutate.mockClear();
    queryResult = { data: undefined, isLoading: true, error: null };
    hasBuilderRun = true;
    coarsePointer = false;
    bannerStore.dismiss(BOARD_UNAVAILABLE_BANNER_ID);
    projectsQueryResult = {
      data: [{ id: 'demo-id', slug: 'demo', name: 'Demo project' }],
      isLoading: false,
      isError: false,
      error: null,
    };
    refetchProjects.mockClear();
  });

  /**
   * route guard. The notice is the load-bearing half: it used to be
   * handed to `navigate` as a second argument, which is the destination's
   * QUERY STRING — no surface reads a `notice` key, so a reader was moved
   * off the route they asked for without a word. Asserting the banner is
   * what makes that regression visible again.
   */
  test('a project with no Builder run is redirected, and the notice travels with it', () => {
    hasBuilderRun = false;
    queryResult = { data: { processes: [] }, isLoading: false, error: null };
    renderView();

    // The adapter's redirect resolves through the shared target→route
    // mapping, which always passes an explicit params object; `{}` writes no
    // query fields, exactly as omitting the argument did.
    expect(hoisted.navigate).toHaveBeenCalledWith('/projects/demo', {});
    const banner = bannerStore
      .getSnapshot()
      .find((item) => item.id === BOARD_UNAVAILABLE_BANNER_ID);
    expect(banner?.message).toBe(BOARD_UNAVAILABLE_NOTICE);
  });

  test('a project with a Builder run is not redirected', () => {
    queryResult = { data: { processes: [] }, isLoading: false, error: null };
    renderView();

    expect(hoisted.navigate).not.toHaveBeenCalled();
    expect(
      bannerStore
        .getSnapshot()
        .some((item) => item.id === BOARD_UNAVAILABLE_BANNER_ID),
    ).toBe(false);
  });

  test('an installed Session Board layout stays open before its first Builder run', () => {
    hasBuilderRun = false;
    queryResult = { data: { processes: [] }, isLoading: false, error: null };

    renderView(false);

    expect(hoisted.navigate).not.toHaveBeenCalled();
    expect(screen.getByText('No work in flight')).toBeTruthy();
  });

  test('renders a loading skeleton while the OperatingState query is pending', () => {
    queryResult = { data: undefined, isLoading: true, error: null };
    const { container } = renderView();
    // The project eyebrow moved to the page header (4-HOME-016); what this
    // view renders while pending is the skeleton and nothing else.
    expect(container.querySelector('.skeleton')).not.toBeNull();
    expect(container.querySelector(`.${PAGE_HEADER_CLASS}`)).toBeNull();
  });

  test('publishes the project trail and Board title into the page frame', () => {
    queryResult = { data: undefined, isLoading: true, error: null };
    render(
      <PageFrame
        spec={{ width: 'full', body: 'fill' }}
        routeIdentity="project-session-board:demo"
      >
        <ConsoleBoardView projectSlug="demo" />
      </PageFrame>,
    );
    const header = document.querySelector('.page-frame__header');
    expect(header?.textContent).toContain('Demo project');
    expect(header?.textContent).toContain('Board');
  });

  test('renders an error state with a Retry action on fetch failure', () => {
    queryResult = {
      data: undefined,
      isLoading: false,
      error: new Error('Unable to reach the operating-state API'),
    };
    renderView();
    expect(
      screen.getByText('Unable to reach the operating-state API'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  test('mounts the real BoardView and renders its empty state for zero processes', () => {
    queryResult = { data: { processes: [] }, isLoading: false, error: null };
    renderView();
    expect(screen.getByText('No work in flight')).toBeTruthy();
  });

  test('mounts the real BoardView with cards for each process, grouped by stage', () => {
    queryResult = {
      data: {
        processes: [
          {
            id: 'station:repo:demo:my-task',
            label: 'my-task',
            status: 'running',
            updatedAt: '2026-07-23T00:00:00.000Z',
          },
        ],
      },
      isLoading: false,
      error: null,
    };
    renderView();
    expect(screen.getByText('my-task')).toBeTruthy();
    expect(screen.getByText('Work in flight')).toBeTruthy();
  });

  test('card selection navigates to the project, recovering the task slug from the qualified process id', () => {
    queryResult = {
      data: {
        processes: [
          {
            id: 'station:repo:demo:my-task',
            label: 'my-task',
            status: 'running',
            updatedAt: '2026-07-23T00:00:00.000Z',
          },
        ],
      },
      isLoading: false,
      error: null,
    };
    renderView();

    fireEvent.click(screen.getByRole('button', { name: /my-task/ }));

    expect(hoisted.navigate).toHaveBeenCalledWith('/projects/demo', {
      task: 'my-task',
    });
  });

  test('a process id from a different scope navigates without a task param (fails closed)', () => {
    queryResult = {
      data: {
        processes: [
          {
            id: 'station:repo:other-project:my-task',
            label: 'my-task',
            status: 'running',
            updatedAt: '2026-07-23T00:00:00.000Z',
          },
        ],
      },
      isLoading: false,
      error: null,
    };
    renderView();

    fireEvent.click(screen.getByRole('button', { name: /my-task/ }));

    expect(hoisted.navigate).toHaveBeenCalledWith('/projects/demo', {});
  });

  test('a review_pending process (roadmap #753) renders its card with the blockedReason surfaced', () => {
    queryResult = {
      data: {
        processes: [
          {
            id: 'station:repo:demo:my-task',
            label: 'my-task',
            status: 'review_pending',
            blockedReason:
              'an independent review is required and has not yet recorded a verdict (trust.bundle carries an unresolved live critique)',
            updatedAt: '2026-07-23T00:00:00.000Z',
          },
        ],
      },
      isLoading: false,
      error: null,
    };
    renderView();

    expect(screen.getByText('my-task')).toBeTruthy();
    expect(
      screen.getByText(/trust\.bundle carries an unresolved live critique/),
    ).toBeTruthy();
  });
});

describe('ConsoleBoardView — the receipt is stated once (station#3776)', () => {
  const oneProcess = {
    processes: [
      {
        id: 'station:repo:demo:my-task',
        label: 'my-task',
        status: 'running',
        updatedAt: '2026-07-23T00:00:00.000Z',
      },
    ],
  };

  beforeEach(() => {
    hasBuilderRun = true;
    coarsePointer = false;
    bannerStore.dismiss(BOARD_UNAVAILABLE_BANNER_ID);
  });

  test("the frame no longer prints a second copy of the Kit's number", () => {
    queryResult = { data: oneProcess, isLoading: false, error: null };
    render(
      <PageFrame
        spec={{ width: 'full', body: 'fill' }}
        routeIdentity="project-session-board:demo"
      >
        <ConsoleBoardView projectSlug="demo" />
      </PageFrame>,
    );

    // BoardView's own `.board-receipt` states it, once.
    expect(screen.getAllByText('1 item in flight')).toHaveLength(1);
    expect(
      document.querySelector('.page-frame__header')?.textContent,
    ).not.toContain('in flight');
  });
});

describe('ConsoleBoardView — the Board names its columns on a phone (station#3777)', () => {
  const backlogAndInFlight = {
    processes: [
      {
        id: 'station:repo:demo:running-task',
        label: 'running-task',
        status: 'running',
        step: 'execute',
        updatedAt: '2026-07-23T00:00:00.000Z',
      },
    ],
  };

  beforeEach(() => {
    hasBuilderRun = true;
    bannerStore.dismiss(BOARD_UNAVAILABLE_BANNER_ID);
  });

  test('a coarse pointer gets a tab strip naming every stage and its count', () => {
    coarsePointer = true;
    queryResult = { data: backlogAndInFlight, isLoading: false, error: null };
    const { container } = renderView();

    const strip = container.querySelector(
      '[role="tablist"][aria-label="Flow stages"]',
    );
    expect(strip).not.toBeNull();
    const tabs = strip?.querySelectorAll('[role="tab"]') ?? [];
    // Every stage BoardView lays out, including the ones the scroller hides.
    expect(tabs.length).toBe(
      container.querySelectorAll('.board-columns > *').length,
    );
    // The counts are the Kit's own projection, so the strip cannot claim a
    // column is empty while a card sits in it.
    const total = [...tabs].reduce(
      (sum, tab) => sum + Number(tab.querySelector('span')?.textContent ?? 0),
      0,
    );
    expect(total).toBe(1);
  });

  test('a fine pointer gets no strip — the columns are all on screen', () => {
    coarsePointer = false;
    queryResult = { data: backlogAndInFlight, isLoading: false, error: null };
    const { container } = renderView();

    expect(
      container.querySelector('[role="tablist"][aria-label="Flow stages"]'),
    ).toBeNull();
  });

  test('the strip uses the shared tab-strip primitive, not page-local markup', () => {
    coarsePointer = true;
    queryResult = { data: backlogAndInFlight, isLoading: false, error: null };
    const { container } = renderView();

    const strip = container.querySelector('[aria-label="Flow stages"]');
    expect(strip?.className).toContain('page__tabs');
    expect(strip?.className).toContain('tab-strip--scroll');
  });
});

describe('ConsoleBoardView — the pane path (epic station#4142 M4a)', () => {
  beforeEach(() => {
    hasBuilderRun = true;
    coarsePointer = false;
    queryResult = { data: { processes: [] }, isLoading: false, error: null };
    bannerStore.dismiss(BOARD_UNAVAILABLE_BANNER_ID);
    projectsQueryResult = {
      data: [{ id: 'demo-id', slug: 'demo', name: 'Demo project' }],
      isLoading: false,
      isError: false,
      error: null,
    };
    refetchProjects.mockClear();
  });

  test('an unknown project slug renders an error state, never an unbound Board', () => {
    render(<ConsoleBoardView projectSlug="missing" />);
    expect(screen.getByText('The Board is unavailable')).toBeTruthy();
  });

  // archive#771: a settled projects-read failure
  // with no cached data used to render the SAME "This host has no Project
  // with that slug." an actually-missing slug shows — a fabricated negative
  // fact. It must say the read failed and offer a retry instead.
  test('a projects-query failure with no cached data renders an error state with retry, not the fabricated "no Project" claim', () => {
    projectsQueryResult = {
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('projects unavailable'),
    };
    render(<ConsoleBoardView projectSlug="demo" />);

    expect(screen.getByText('Could not load projects')).toBeTruthy();
    expect(screen.getByText('projects unavailable')).toBeTruthy();
    expect(
      screen.queryByText('This host has no Project with that slug.'),
    ).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetchProjects).toHaveBeenCalledTimes(1);
  });
});

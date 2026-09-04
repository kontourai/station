/**
 * @vitest-environment jsdom
 */

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const layoutQueryState = vi.hoisted(() => ({
  data: undefined as unknown,
  isLoading: false,
  error: undefined as unknown,
}));
const refetchLayoutMock = vi.hoisted(() => vi.fn());
const navigateMock = vi.hoisted(() => vi.fn());
const hostQuery = vi.hoisted(() => ({
  isSuccess: true,
  data: {
    complete: true,
    contributions: [] as Array<{ projection: { owner: { pluginId: string } } }>,
  },
}));
vi.mock('@kontourai/station-sdk/workspace-pane', () => ({
  useWorkspacePaneHostActionsQuery: () => hostQuery,
}));
const StationHttpError = vi.hoisted(
  () =>
    class StationHttpError extends Error {
      readonly status: number;

      constructor(status: number, message?: string) {
        super(message ?? `HTTP ${status}`);
        this.name = 'StationHttpError';
        this.status = status;
      }
    },
);

vi.mock('@kontourai/station-sdk', () => ({
  FullScreenError: ({ title }: { title: string }) => (
    <div data-testid="full-screen-error">{title}</div>
  ),
  FullScreenLoader: ({ label }: { label?: string }) => (
    <div data-testid="full-screen-loader">Loading {label}</div>
  ),
  LayoutNavigationProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  StationHttpError,
  useProjectLayoutQuery: () => ({
    ...layoutQueryState,
    refetch: refetchLayoutMock,
  }),
  useProjectQuery: () => ({ data: undefined, isSuccess: false }),
}));

vi.mock('@tanstack/react-query', () => ({
  useIsFetching: () => 0,
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock('../../contexts/AgentsContext', () => ({ useAgents: () => [] }));
vi.mock('../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://localhost:3000' }),
}));
vi.mock('../../contexts/NavigationContext', () => ({
  useNavigation: () => ({
    activeTab: null,
    setDockState: vi.fn(),
    setLayoutTab: vi.fn(),
    setActiveChat: vi.fn(),
    navigate: navigateMock,
  }),
}));
vi.mock('../../core/SDKAdapter', () => ({
  SDKAdapter: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../../hooks/useActiveChatSessions', () => ({
  useCreateChatSession: () => vi.fn(),
  useSendMessage: () => vi.fn(),
}));
vi.mock('../../hooks/useSlashCommandHandler', () => ({
  useSlashCommandHandler: () => vi.fn(),
}));
const renderedLayout = vi.hoisted(() => ({ value: undefined as any }));
vi.mock('../../layouts', () => ({
  LayoutRenderer: ({ layout }: { layout: unknown }) => {
    renderedLayout.value = layout;
    return <div>Layout rendered</div>;
  },
}));

import { LAST_PROJECT_LAYOUT_KEY } from '../../contexts/navigation-store';
import { LayoutView } from '../LayoutView';

describe('LayoutView terminal states (4-HOME-009)', () => {
  beforeEach(() => {
    localStorage.clear();
    navigateMock.mockReset();
    refetchLayoutMock.mockReset();
    layoutQueryState.data = undefined;
    layoutQueryState.isLoading = false;
    layoutQueryState.error = undefined;
    renderedLayout.value = undefined;
    hostQuery.isSuccess = true;
    hostQuery.data.contributions = [];
  });

  test('package host contribution withdraws duplicate legacy global controls while keeping tab-local actions', () => {
    const local = { type: 'prompt', label: 'Local', data: 'Local body' };
    layoutQueryState.data = {
      slug: 'demo',
      name: 'Demo',
      config: {
        plugin: 'demo-plugin',
        tabs: [
          { id: 'one', label: 'One', component: 'demo', actions: [local] },
        ],
        actions: [{ type: 'prompt', label: 'Global', data: 'Global body' }],
        globalSkills: [{ id: 'hello', label: 'Hello', prompt: 'Hello body' }],
      },
    };
    hostQuery.data.contributions = [
      { projection: { owner: { pluginId: 'demo-plugin' } } },
    ];
    render(<LayoutView projectSlug="one" layoutSlug="demo" />);
    expect(renderedLayout.value.actions).toEqual([]);
    expect(renderedLayout.value.globalSkills).toEqual([]);
    expect(renderedLayout.value.tabs[0].actions).toEqual([local]);
  });

  test('unknown host capability does not briefly activate a persisted plugin global action', () => {
    layoutQueryState.data = {
      slug: 'demo',
      name: 'Demo',
      config: {
        plugin: 'demo-plugin',
        tabs: [],
        actions: [{ type: 'prompt', label: 'Global', data: 'Global body' }],
      },
    };
    hostQuery.isSuccess = false;
    render(<LayoutView projectSlug="one" layoutSlug="demo" />);
    expect(renderedLayout.value.actions).toEqual([]);
  });

  /**
   * The audit watched `/projects/audit-alpha/layouts/coding` rotate whimsical
   * loading phrases indefinitely while the API had already answered 404 three
   * times. The old code called `navigate` from inside render and returned a
   * loader; this asserts an answered 404 produces an ANSWER.
   */
  test('a 404 renders the not-found state with a way back, and never a loader', () => {
    layoutQueryState.error = new StationHttpError(404, 'Layout not found');
    localStorage.setItem(LAST_PROJECT_LAYOUT_KEY, 'coding');

    render(<LayoutView projectSlug="audit-alpha" layoutSlug="coding" />);

    expect(screen.getByRole('alert').textContent).toContain('Layout not found');
    expect(screen.getByRole('alert').textContent).toContain('coding');
    expect(screen.queryByTestId('full-screen-loader')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Back to project' }),
    ).toBeTruthy();
    // The dead layout stops being the restore target for `/`.
    expect(localStorage.getItem(LAST_PROJECT_LAYOUT_KEY)).toBeNull();
    //.and it is not a silent redirect: the broken deep link stays visible.
    expect(navigateMock).not.toHaveBeenCalled();
  });

  test('a plain Error saying "not found" is still recognised as missing', () => {
    layoutQueryState.error = new Error('Layout not found');

    render(<LayoutView projectSlug="audit-alpha" layoutSlug="coding" />);

    expect(screen.getByRole('alert').textContent).toContain('Layout not found');
    expect(screen.queryByTestId('full-screen-loader')).toBeNull();
  });

  test('a non-404 failure keeps the retryable error screen', () => {
    layoutQueryState.error = new StationHttpError(500, 'boom');

    render(<LayoutView projectSlug="audit-alpha" layoutSlug="coding" />);

    expect(screen.getByTestId('full-screen-error').textContent).toBe(
      'Failed to load layout',
    );
  });

  test('a settled query with no layout answers instead of loading forever', () => {
    layoutQueryState.data = undefined;
    layoutQueryState.isLoading = false;
    layoutQueryState.error = undefined;

    render(<LayoutView projectSlug="audit-alpha" layoutSlug="coding" />);

    expect(screen.queryByTestId('full-screen-loader')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain(
      'This layout could not be loaded',
    );
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  test('an in-flight request still loads, with an escape hatch', () => {
    layoutQueryState.isLoading = true;

    render(<LayoutView projectSlug="audit-alpha" layoutSlug="coding" />);

    expect(screen.getByTestId('full-screen-loader')).toBeTruthy();
  });
  // LayoutView maps the STORED config into the shape the renderer reads. The
  // `tabs[].prompts` -> `tabs[].skills` rename moved the contract and the
  // renderer but not this mapper, so a correctly authored quick action arrived
  // as `undefined` and vanished with no error anywhere
  test('a tab skill survives the map into the renderer shape', () => {
    layoutQueryState.data = {
      slug: 'coding',
      name: 'Coding',
      config: {
        tabs: [
          {
            id: 'main',
            label: 'Main',
            component: 'chat',
            skills: [
              { type: 'prompt', label: 'Summarise the day', data: 'summarise' },
            ],
          },
        ],
      },
    };

    render(<LayoutView projectSlug="audit-alpha" layoutSlug="coding" />);

    expect(renderedLayout.value.tabs[0].skills).toEqual([
      expect.objectContaining({ label: 'Summarise the day' }),
    ]);
    // The retired key must not be re-emitted alongside it.
    expect(renderedLayout.value.tabs[0].prompts).toBeUndefined();
  });

  test('a tab still carrying the retired prompts key maps to no skills', () => {
    layoutQueryState.data = {
      slug: 'coding',
      name: 'Coding',
      config: {
        tabs: [
          {
            id: 'main',
            label: 'Main',
            component: 'chat',
            prompts: [
              { type: 'prompt', label: 'Summarise the day', data: 'summarise' },
            ],
          },
        ],
      },
    };

    render(<LayoutView projectSlug="audit-alpha" layoutSlug="coding" />);

    expect(renderedLayout.value.tabs[0].skills).toEqual([]);
  });
});

/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const layoutQueryState = vi.hoisted(() => ({
  data: undefined as unknown,
  isLoading: false,
  fetchStatus: 'idle' as string,
  errorUpdatedAt: 0,
  error: undefined as unknown,
}));
const agentState = vi.hoisted(() => ({
  agents: [] as any[],
  project: { data: undefined as any, isSuccess: false },
}));
const legacyCreate = vi.hoisted(() => vi.fn(() => 'legacy-session'));
const legacySend = vi.hoisted(() => vi.fn(async () => {}));
const refetchLayoutMock = vi.hoisted(() => vi.fn());
const navigateMock = vi.hoisted(() => vi.fn());
const setDockStateMock = vi.hoisted(() => vi.fn());
const hostQuery = vi.hoisted(() => ({
  isSuccess: true,
  data: {
    complete: true,
    contributions: [] as Array<{
      projection: {
        owner: { pluginId: string };
        actions?: Array<{ id: string }>;
      };
    }>,
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
  useProjectQuery: () => agentState.project,
}));

vi.mock('@tanstack/react-query', () => ({
  useIsFetching: () => 0,
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock('../../contexts/AgentsContext', () => ({
  useAgents: () => agentState.agents,
}));
vi.mock('../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://localhost:3000' }),
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://localhost:3000',
    authorityKey: 'test',
    isCurrent: () => true,
  }),
}));
vi.mock('../../contexts/NavigationContext', () => ({
  useNavigation: () => ({
    activeTab: null,
    setDockState: setDockStateMock,
    setLayoutTab: vi.fn(),
    setActiveChat: vi.fn(),
    navigate: navigateMock,
  }),
}));
vi.mock('../../core/SDKAdapter', () => ({
  SDKAdapter: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../../hooks/useActiveChatSessions', () => ({
  useCreateChatSession: () => legacyCreate,
  useSendMessage: () => legacySend,
}));
vi.mock('../../hooks/useSlashCommandHandler', () => ({
  useSlashCommandHandler: () => vi.fn(),
}));
const renderedLayout = vi.hoisted(() => ({
  value: undefined as any,
  launch: undefined as any,
  canLaunchPrompts: 'unset' as unknown,
}));
vi.mock('../../layouts', () => ({
  LayoutRenderer: ({
    layout,
    onLaunchPrompt,
    canLaunchPrompts,
  }: {
    layout: unknown;
    onLaunchPrompt: unknown;
    canLaunchPrompts?: boolean;
  }) => {
    renderedLayout.value = layout;
    renderedLayout.launch = onLaunchPrompt;
    renderedLayout.canLaunchPrompts = canLaunchPrompts;
    return <div>Layout rendered</div>;
  },
}));

import { LAST_PROJECT_LAYOUT_KEY } from '../../contexts/navigation-store';
import { workspacePaneHostActionControlId } from '../../workspace-panes/workspacePaneHostActionFocus';
import { LayoutView } from '../LayoutView';

describe('LayoutView terminal states (4-HOME-009)', () => {
  beforeEach(() => {
    localStorage.clear();
    agentState.agents = [];
    agentState.project = { data: undefined, isSuccess: false };
    legacyCreate.mockClear();
    legacySend.mockClear();
    navigateMock.mockReset();
    setDockStateMock.mockReset();
    refetchLayoutMock.mockReset();
    renderedLayout.canLaunchPrompts = 'unset';
    layoutQueryState.data = undefined;
    layoutQueryState.isLoading = false;
    layoutQueryState.fetchStatus = 'idle';
    layoutQueryState.errorUpdatedAt = 0;
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
    expect(renderedLayout.value.tabs[0].actions).toEqual([
      { ...local, label: 'Review Local' },
    ]);
  });

  test('migrated tab Review focuses the existing host action without an ambient Agent', () => {
    layoutQueryState.data = {
      slug: 'demo',
      name: 'Demo',
      config: {
        plugin: 'demo-plugin',
        tabs: [{ id: 'one', label: 'One', component: 'demo' }],
      },
    };
    hostQuery.data.contributions = [
      {
        projection: {
          owner: { pluginId: 'demo-plugin' },
          actions: [{ id: 'activity' }],
        },
      },
    ];
    render(
      <>
        <button
          type="button"
          id={workspacePaneHostActionControlId(
            'one',
            'demo-plugin',
            'activity',
          )}
        >
          Log Activity
        </button>
        <button
          type="button"
          onClick={() =>
            renderedLayout.launch({
              id: 'demo-plugin:activity',
              label: 'Review Log Activity',
            })
          }
        >
          Review Log Activity
        </button>
        <LayoutView projectSlug="one" layoutSlug="demo" />
      </>,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Review Log Activity' }),
    );
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Log Activity' }),
    );
    expect(navigateMock).not.toHaveBeenCalled();
  });

  test('uninstall after a catalog cannot revive a stale plugin callback and explains the unavailable action', async () => {
    agentState.agents = [{ slug: 'assistant', name: 'Available assistant' }];
    agentState.project = { data: { agents: ['assistant'] }, isSuccess: true };
    layoutQueryState.data = {
      slug: 'demo',
      name: 'Demo',
      config: {
        plugin: 'demo-plugin',
        defaultAgent: 'assistant',
        actions: [
          {
            type: 'inline-prompt',
            label: 'Legacy action',
            data: 'legacy body',
          },
        ],
        tabs: [],
      },
    };
    hostQuery.data.contributions = [
      {
        projection: {
          owner: { pluginId: 'demo-plugin' },
          actions: [{ id: 'current' }],
        },
      },
    ];
    const view = render(<LayoutView projectSlug="one" layoutSlug="demo" />);
    const stale = renderedLayout.launch;
    hostQuery.data.contributions = [];
    view.rerender(<LayoutView projectSlug="one" layoutSlug="demo" />);
    render(
      <button
        type="button"
        onClick={() =>
          stale({
            id: 'legacy-action',
            label: 'Legacy action',
            prompt: 'legacy body',
          })
        }
      >
        Review saved action
      </button>,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Review saved action' }),
    );
    expect(
      await screen.findByText(/This saved plugin action is unavailable/),
    ).toBeTruthy();
    expect(renderedLayout.value.actions).toEqual([]);
    expect(legacyCreate).not.toHaveBeenCalled();
    expect(legacySend).not.toHaveBeenCalled();
  });

  test('genuinely user-authored non-plugin Layout actions retain their explicit Agent launch', async () => {
    agentState.agents = [{ slug: 'assistant', name: 'Available assistant' }];
    agentState.project = { data: { agents: ['assistant'] }, isSuccess: true };
    layoutQueryState.data = {
      slug: 'mine',
      name: 'Mine',
      config: {
        defaultAgent: 'assistant',
        actions: [
          { type: 'inline-prompt', label: 'My action', data: 'my exact body' },
        ],
        tabs: [],
      },
    };
    render(<LayoutView projectSlug="one" layoutSlug="mine" />);
    await renderedLayout.launch({
      id: 'my-action',
      label: 'My action',
      prompt: 'my exact body',
    });
    expect(legacyCreate).toHaveBeenCalledWith(
      'assistant',
      'Available assistant',
      'My action',
      'one',
    );
    expect(legacySend).toHaveBeenCalledWith(
      'legacy-session',
      'assistant',
      undefined,
      'my exact body',
    );
    // #2171 A3: the route-bound host's launch path is untouched — it opens
    // the dock, and it never declares `canLaunchPrompts` (the docked host's
    // `false` would strip the very buttons this launch is reached from).
    expect(setDockStateMock).toHaveBeenCalledWith(true);
    expect(renderedLayout.canLaunchPrompts).toBeUndefined();
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
    layoutQueryState.errorUpdatedAt = 1;

    render(<LayoutView projectSlug="audit-alpha" layoutSlug="coding" />);

    expect(screen.getByRole('alert').textContent).toContain(
      "Couldn't open this layout",
    );
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetchLayoutMock).toHaveBeenCalledTimes(1);
  });

  // The on-device report: with the connection down, every background retry
  // reset the query to loading, and the view flipped between this error and
  // the skeleton until the connection came back.
  test('a retry after a failure keeps the error instead of flickering to the skeleton', () => {
    layoutQueryState.error = new TypeError('Failed to fetch');
    layoutQueryState.errorUpdatedAt = 1;
    const view = render(
      <LayoutView projectSlug="audit-alpha" layoutSlug="coding" />,
    );
    expect(screen.getByRole('alert').textContent).toContain(
      'Could not reach Station',
    );

    // What TanStack reports once a refetch starts for a query with no data.
    layoutQueryState.error = null;
    layoutQueryState.isLoading = true;
    layoutQueryState.fetchStatus = 'fetching';
    view.rerender(<LayoutView projectSlug="audit-alpha" layoutSlug="coding" />);

    expect(screen.queryByRole('status', { name: 'Opening layout' })).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain(
      'Could not reach Station',
    );
    const retry = screen.getByRole('button', { name: 'Try again' });
    expect(retry.getAttribute('aria-busy')).toBe('true');
    expect((retry as HTMLButtonElement).disabled).toBe(true);
  });

  test('re-checking a missing layout keeps saying it is missing', () => {
    layoutQueryState.error = new StationHttpError(404, 'Layout not found');
    layoutQueryState.errorUpdatedAt = 1;
    const view = render(
      <LayoutView projectSlug="audit-alpha" layoutSlug="coding" />,
    );
    layoutQueryState.error = null;
    layoutQueryState.isLoading = true;
    layoutQueryState.fetchStatus = 'fetching';
    view.rerender(<LayoutView projectSlug="audit-alpha" layoutSlug="coding" />);

    expect(screen.getByRole('alert').textContent).toContain('Layout not found');
  });

  test('a failed refresh of a loaded layout keeps the layout', () => {
    layoutQueryState.data = {
      slug: 'coding',
      name: 'Coding',
      config: { tabs: [{ id: 'main', label: 'Main', component: 'chat' }] },
    };
    layoutQueryState.error = new TypeError('Failed to fetch');
    layoutQueryState.errorUpdatedAt = 1;

    render(<LayoutView projectSlug="audit-alpha" layoutSlug="coding" />);

    expect(screen.getByText('Layout rendered')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
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

    expect(screen.getByRole('status', { name: 'Opening layout' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back to project' }));
    expect(navigateMock).toHaveBeenCalledWith('/projects/audit-alpha');
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

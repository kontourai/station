/**
 * @vitest-environment jsdom
 *
 * A failed agents read says what happened once, with one Retry: the layout's
 * error state when nothing is listed, or one banner over stale rows.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AgentsView } from '../views/AgentsView';
import { buildAgentsViewEmptyContent } from '../views/agent-editor/agentsViewHelpers';

const state = vi.hoisted(() => ({
  listItems: [] as Array<{ id: string; name: string }>,
  /** What the agents catalogue read answers (`GET /api/registry/agents`). */
  agentCatalog: { data: [] as unknown[] | undefined } as {
    data: unknown[] | undefined;
    error?: Error;
  },
  query: {
    isLoading: false,
    isError: true,
    error: new Error('agents read failed') as Error | null,
    refetch: vi.fn(),
  },
}));

vi.mock('../contexts/NavigationContext', () => {
  const navigation = () => ({ navigate: vi.fn() });
  return {
    useNavigation: (
      selector?: (value: ReturnType<typeof navigation>) => unknown,
    ) => (selector ? selector(navigation()) : navigation()),
    useNavigationActions: navigation,
  };
});

vi.mock('@kontourai/station-sdk', () => ({
  useAgentsQuery: () => state.query,
  useRegistryItemsQuery: (tab: string) =>
    tab === 'agents' ? state.agentCatalog : { data: undefined },
}));

vi.mock('../views/agent-editor/useAgentsViewModel', () => ({
  useAgentsViewModel: () => ({
    DiscardModal: () => null,
    listItems: state.listItems,
    agentsCollectionEmpty: state.listItems.length === 0,
    editorId: null,
    // The exact card the real view model builds when no authored agent
    // exists (useAgentsViewModel → buildAgentsViewEmptyContent), not a stub:
    // the view must withhold it while the read has failed.
    emptyContent: buildAgentsViewEmptyContent({
      agentsCount: 0,
      onCreateBlank: () => {},
    }),
    search: '',
    setSearch: vi.fn(),
    handleNew: vi.fn(),
    handleSelect: vi.fn(),
    handleDeselect: vi.fn(),
  }),
}));

vi.mock('../views/agent-editor/AgentsViewEditorPane', () => ({
  AgentsViewEditorPane: () => null,
}));

afterEach(cleanup);
beforeEach(() => {
  state.query.refetch.mockClear();
  state.listItems = [];
  state.agentCatalog = { data: [] };
});

describe('AgentsView after a failed agents read', () => {
  test('with nothing listed, shows only the error state with Retry', () => {
    render(
      <AgentsView agents={[]} availableModels={[]} onNavigate={vi.fn()} />,
    );

    expect(screen.getByText('Couldn’t load agents')).toBeTruthy();
    expect(screen.queryByText('Couldn’t refresh agents')).toBeNull();
    expect(screen.queryByText('No agents yet')).toBeNull();
    expect(screen.queryByText('No agents of your own yet')).toBeNull();
    const retry = screen.getAllByRole('button', { name: 'Retry' });
    expect(retry).toHaveLength(1);
    fireEvent.click(retry[0]);
    expect(state.query.refetch).toHaveBeenCalledOnce();
  });

  test('with stale agents listed, shows one banner with Retry', () => {
    state.listItems = [{ id: 'writer', name: 'Writer' }];
    render(
      <AgentsView agents={[]} availableModels={[]} onNavigate={vi.fn()} />,
    );

    expect(screen.getByText('Couldn’t refresh agents')).toBeTruthy();
    expect(screen.getByText('This list may be out of date.')).toBeTruthy();
    expect(screen.queryByText('Couldn’t load agents')).toBeNull();
    expect(screen.getByText('Writer')).toBeTruthy();
    const retry = screen.getAllByRole('button', { name: 'Retry' });
    expect(retry).toHaveLength(1);
    fireEvent.click(retry[0]);
    expect(state.query.refetch).toHaveBeenCalledOnce();
  });

  test('a successful empty read still offers the create card', () => {
    state.query = { ...state.query, isError: false, error: null };
    try {
      render(
        <AgentsView agents={[]} availableModels={[]} onNavigate={vi.fn()} />,
      );
      expect(screen.getByText('No agents of your own yet')).toBeTruthy();
    } finally {
      state.query = {
        ...state.query,
        isError: true,
        error: new Error('agents read failed'),
      };
    }
  });
});

// Agents arrive inside apps: the agent catalogue is not a page and Agents
// links to none, even when a source lists agent entries.
test('Agents offers no agent catalogue, even when a source lists agents', () => {
  state.agentCatalog = {
    data: [{ id: 'planner', displayName: 'Project Planner' }],
  };
  render(<AgentsView agents={[]} availableModels={[]} onNavigate={vi.fn()} />);
  expect(screen.queryByRole('button', { name: /browse agents/i })).toBeNull();
});

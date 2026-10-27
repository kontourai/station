/** @vitest-environment jsdom */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  openConversation: vi.fn(),
  showSurface: vi.fn(),
  isCurrent: vi.fn(() => true),
  refetch: vi.fn(),
}));
const projection = {
  owner: {
    pluginId: 'host-package',
    installationGeneration: `sha256:${'a'.repeat(64)}`,
  },
  projectId: 'project-one',
  actions: [
    {
      key: 'overview-key',
      id: 'overview',
      label: 'Overview',
      presentation: 'action',
      availability: 'available',
    },
    {
      key: 'fixed-key',
      id: 'fixed',
      label: 'Fixed action',
      presentation: 'action',
      availability: 'available',
      agent: { kind: 'own-plugin-agent', agentId: 'assistant' },
    },
  ],
  agentSelection: {
    availableAgents: ['assistant', 'alternate'].map((agentId) => ({
      declaration: { kind: 'own-plugin-agent', agentId },
      resolution: { state: 'available' },
    })),
    defaultAgent: {
      declaration: { kind: 'own-plugin-agent', agentId: 'assistant' },
      resolution: { state: 'available' },
    },
  },
};
const hostQuery = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
}));
const loadedHostQuery = () => ({
  isLoading: false,
  isFetching: false,
  isError: false,
  error: null as unknown,
  errorUpdateCount: 0,
  data: { contributions: [{ projection }] } as unknown,
});
vi.mock('@kontourai/station-sdk/workspace-pane', () => ({
  useWorkspacePaneHostActionsQuery: () => ({
    ...hostQuery.state,
    refetch: mocks.refetch,
  }),
  useWorkspacePaneHostActionMutation: () => ({
    mutateAsync: mocks.mutateAsync,
  }),
}));
vi.mock('../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://station.test',
    authorityKey: 'owner',
    isCurrent: mocks.isCurrent,
  }),
}));
vi.mock('../../contexts/open-chats-store', () => ({
  openChatsStore: { openConversation: mocks.openConversation },
}));
vi.mock('../../contexts/useShowSurface', () => ({
  useShowSurface: () => mocks.showSurface,
}));

import { WorkspacePaneHostActionsFrame } from '../WorkspacePaneHostActions';

beforeEach(() => {
  vi.clearAllMocks();
  hostQuery.state = loadedHostQuery();
  mocks.isCurrent.mockReturnValue(true);
  mocks.openConversation.mockResolvedValue(true);
});
afterEach(cleanup);

test('one real host bar aggregates multiple pane occupants and routes explicit selected Agent', async () => {
  mocks.mutateAsync.mockResolvedValue({
    state: 'accepted',
    conversationId: 'conversation-one',
    sessionId: 'execution-one',
    turnId: 'turn-one',
  });
  render(
    <WorkspacePaneHostActionsFrame projectSlug="one">
      <div>First pane</div>
      <div>Second pane</div>
    </WorkspacePaneHostActionsFrame>,
  );
  expect(
    screen.getAllByRole('region', { name: 'Workspace actions' }),
  ).toHaveLength(1);
  expect(screen.getAllByRole('button', { name: 'Overview' })).toHaveLength(1);
  expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe(
    'own-plugin-agent:assistant',
  );
  fireEvent.change(screen.getByRole('combobox'), {
    target: { value: 'own-plugin-agent:alternate' },
  });
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Overview' })),
  );
  expect(mocks.mutateAsync).toHaveBeenCalledExactlyOnceWith({
    ...projection.owner,
    actionKey: 'overview-key',
    selectedAgent: { kind: 'own-plugin-agent', agentId: 'alternate' },
  });
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Open conversation' })),
  );
  expect(mocks.openConversation).toHaveBeenCalledWith(
    'conversation-one',
    mocks.isCurrent,
  );
  fireEvent.click(screen.getByRole('button', { name: 'View result' }));
  expect(mocks.showSurface).toHaveBeenCalledWith('activity', {
    session: 'execution-one',
    focus: 'evidence',
  });
});

test('fixed action binding is never replaced by the host dropdown', async () => {
  mocks.mutateAsync.mockResolvedValue({
    state: 'unavailable',
    reason: 'host-unavailable',
  });
  render(
    <WorkspacePaneHostActionsFrame projectSlug="one">
      <div>Pane</div>
    </WorkspacePaneHostActionsFrame>,
  );
  fireEvent.change(screen.getByRole('combobox'), {
    target: { value: 'own-plugin-agent:alternate' },
  });
  await act(async () =>
    fireEvent.click(
      screen.getByRole('button', { name: 'Fixed action (assistant)' }),
    ),
  );
  expect(mocks.mutateAsync).toHaveBeenCalledExactlyOnceWith({
    ...projection.owner,
    actionKey: 'fixed-key',
  });
});

test('same-frame repeated clicks cannot repeat work and uncertain effects stay blocked', async () => {
  let settle!: (value: unknown) => void;
  mocks.mutateAsync.mockReturnValue(
    new Promise((resolve) => {
      settle = resolve;
    }),
  );
  render(
    <WorkspacePaneHostActionsFrame projectSlug="one">
      <div>Pane</div>
    </WorkspacePaneHostActionsFrame>,
  );
  const action = screen.getByRole('button', { name: 'Overview' });
  await act(async () => {
    fireEvent.click(action);
    fireEvent.click(action);
  });
  expect(mocks.mutateAsync).toHaveBeenCalledTimes(1);
  await act(async () => settle({ state: 'indeterminate' }));
  expect(screen.getByText(/may have started/)).toBeTruthy();
  expect(
    (screen.getByRole('button', { name: 'Overview' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh actions' }));
  expect(mocks.mutateAsync).toHaveBeenCalledTimes(1);
});

test('missing Agent on canonical open falls back to the created Session evidence, never a default Agent', async () => {
  mocks.mutateAsync.mockResolvedValue({
    state: 'accepted',
    conversationId: 'conversation-one',
    sessionId: 'created-session',
    turnId: 'turn-one',
  });
  mocks.openConversation.mockResolvedValue(false);
  render(
    <WorkspacePaneHostActionsFrame projectSlug="one">
      <div>Pane</div>
    </WorkspacePaneHostActionsFrame>,
  );
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Overview' })),
  );
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Open conversation' })),
  );
  expect(mocks.showSurface).toHaveBeenCalledExactlyOnceWith('activity', {
    session: 'created-session',
    focus: 'evidence',
  });
  expect(mocks.mutateAsync).toHaveBeenCalledTimes(1);
});

test('late results cannot publish into a replaced Station authority', async () => {
  let settle!: (value: unknown) => void;
  mocks.mutateAsync.mockReturnValue(
    new Promise((resolve) => {
      settle = resolve;
    }),
  );
  render(
    <WorkspacePaneHostActionsFrame projectSlug="one">
      <div>Pane</div>
    </WorkspacePaneHostActionsFrame>,
  );
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Overview' })),
  );
  mocks.isCurrent.mockReturnValue(false);
  await act(async () =>
    settle({
      state: 'accepted',
      conversationId: 'foreign-conversation',
      sessionId: 'foreign-session',
      turnId: 'foreign-turn',
    }),
  );
  expect(
    screen.queryByRole('button', { name: 'Open conversation' }),
  ).toBeNull();
  expect(mocks.openConversation).not.toHaveBeenCalled();
});

test('a failed catalog stays a failure while it retries instead of flickering to the skeleton', () => {
  hostQuery.state = {
    ...loadedHostQuery(),
    data: undefined,
    isError: true,
    error: new TypeError('Failed to fetch'),
    errorUpdateCount: 1,
  };
  const view = render(
    <WorkspacePaneHostActionsFrame projectSlug="one">
      <div>Pane</div>
    </WorkspacePaneHostActionsFrame>,
  );
  expect(screen.getByRole('alert').textContent).toContain(
    'Workspace actions unavailable',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(mocks.refetch).toHaveBeenCalledTimes(1);

  // TanStack resets a no-data query to loading when the refetch starts.
  hostQuery.state = {
    ...hostQuery.state,
    isError: false,
    error: null,
    isLoading: true,
    isFetching: true,
  };
  view.rerender(
    <WorkspacePaneHostActionsFrame projectSlug="one">
      <div>Pane</div>
    </WorkspacePaneHostActionsFrame>,
  );
  expect(
    screen.queryByRole('status', { name: 'Loading workspace actions' }),
  ).toBeNull();
  expect(screen.getByRole('alert').textContent).toContain(
    'Could not reach Station',
  );
  expect(
    screen.getByRole('button', { name: 'Retrying…' }).getAttribute('aria-busy'),
  ).toBe('true');
});

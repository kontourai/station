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
  setActiveChat: vi.fn(),
  setDockState: vi.fn(),
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
vi.mock('@kontourai/station-sdk/workspace-pane', () => ({
  useWorkspacePaneHostActionsQuery: () => ({
    isLoading: false,
    isError: false,
    refetch: mocks.refetch,
    data: { contributions: [{ projection }] },
  }),
  useWorkspacePaneHostActionMutation: () => ({
    mutateAsync: mocks.mutateAsync,
  }),
}));
vi.mock('../../contexts/NavigationContext', () => ({
  useNavigation: () => mocks,
}));

import { WorkspacePaneHostActionsFrame } from '../WorkspacePaneHostActions';

beforeEach(() => vi.clearAllMocks());
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
  fireEvent.click(screen.getByRole('button', { name: 'Open conversation' }));
  expect(mocks.setActiveChat).toHaveBeenCalledWith('conversation-one');
  expect(mocks.setDockState).toHaveBeenCalledWith(true);
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
    fireEvent.click(screen.getByRole('button', { name: 'Fixed action' })),
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

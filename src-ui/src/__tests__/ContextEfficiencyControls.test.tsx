/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

const api = vi.hoisted(() => ({ get: vi.fn(), mutate: vi.fn() }));
vi.mock('@kontourai/station-sdk', () => ({
  getJson: api.get,
  mutateJson: api.mutate,
  readEnvelopeOrThrow: async (response: Response) => {
    const value = await response.json();
    if (!response.ok) throw new Error(value.error);
    return value.data;
  },
}));
vi.mock('../hooks/useSurfaceVisibilityFlags', () => ({
  useSurfaceVisibilityFlags: () =>
    new Set(['context-compaction', 'project-supervision']),
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://host',
    authorityKey: 'current',
    isCurrent: () => true,
  }),
}));
vi.mock('../hooks/useUnsavedGuard', () => ({
  useUnsavedGuard: () => ({ DiscardModal: () => null }),
}));

import { ContextCompactionControl } from '../components/conversation-stats/ContextCompactionControl';
import { TaskSupervisionPanel } from '../views/task-workspace/TaskSupervisionPanel';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
function mount(element: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}
const response = (data: unknown) =>
  new Response(JSON.stringify({ success: true, data }), { status: 200 });

test('Task refresh and policy controls send current Session/revision and preserve an unknown operation without automatic resend', async () => {
  const view = {
    state: 'ready',
    currentSessionId: 'current-session',
    threshold: 90,
    policyRevision: 7,
    autoEnabled: false,
    contextKind: 'task-state',
  };
  api.get.mockImplementation(async () => response(view));
  api.mutate.mockResolvedValue(response({}));
  mount(
    <ContextCompactionControl
      apiBase="http://host"
      conversationId="conversation"
    />,
  );
  await screen.findByRole('button', { name: 'Refresh Task context' });
  expect(screen.getByText(/No summary model is called/)).toBeTruthy();
  fireEvent.change(
    screen.getByLabelText('Confirmed context threshold (5–90%)'),
    { target: { value: '75' } },
  );
  fireEvent.click(screen.getByRole('button', { name: 'Save context policy' }));
  await waitFor(() => expect(api.mutate).toHaveBeenCalledTimes(1));
  expect(api.mutate.mock.calls[0][3]).toEqual({
    threshold: 75,
    autoEnabled: false,
    expectedCurrentSessionId: 'current-session',
    expectedRevision: 7,
  });
  api.mutate.mockRejectedValueOnce(
    new Error('Outcome unknown; check the retained operation.'),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Refresh Task context' }));
  await screen.findByText('Outcome unknown; check the retained operation.');
  expect(api.mutate).toHaveBeenCalledTimes(2);
  expect(api.mutate.mock.calls[1][3]).toMatchObject({
    expectedSessionId: 'current-session',
    mode: 'manual',
    operationId: expect.any(String),
  });
  expect(
    screen.getByRole('button', { name: 'Check retained outcome' }),
  ).toBeTruthy();
});

test('supervision pause and stop use the displayed generation and retain visible unknown wake outcomes', async () => {
  const intent = {
    projectId: 'project',
    taskId: 'task',
    taskCreatedAt: 'created',
    key: 'key',
    generation: 4,
    state: 'active',
    ownerUserId: 'owner',
    coordinatorConversationId: 'coordinator',
    policy: {
      maxWakes: 3,
      maxNoProgressWakes: 2,
      minIntervalMs: 60000,
      stopAt: Date.now() + 86400000,
    },
    attention: 'Original wake outcome is unconfirmed',
    observation: {
      wait: 'unknown',
      reason: 'Awaiting receipt',
      checkpointRevision: 'checkpoint',
    },
  };
  api.get.mockImplementation(async () =>
    response({
      intent,
      serverNow: Date.now(),
      coordinatorConversationId: 'coordinator',
      wakes: [
        { id: 'wake', state: 'attention', reason: 'No resend permitted' },
      ],
    }),
  );
  api.mutate.mockImplementation(async () => response({}));
  mount(
    <TaskSupervisionPanel
      taskId="task"
      taskCreatedAt="created"
      projectId="project"
      authority={{
        apiBase: 'http://host',
        authorityKey: 'current',
      }}
    />,
  );
  fireEvent.click(
    await screen.findByRole('button', { name: 'Pause supervision' }),
  );
  await waitFor(() => expect(api.mutate).toHaveBeenCalledTimes(1));
  expect(api.mutate.mock.calls[0][3]).toMatchObject({
    expectedGeneration: 4,
    state: 'paused',
    coordinatorConversationId: 'coordinator',
  });
  fireEvent.click(screen.getByRole('button', { name: 'Stop supervision' }));
  await waitFor(() => expect(api.mutate).toHaveBeenCalledTimes(2));
  expect(api.mutate.mock.calls[1][3]).toMatchObject({
    expectedGeneration: 4,
    state: 'cancelled',
  });
  expect(screen.getByText('Original wake outcome is unconfirmed')).toBeTruthy();
  expect(screen.getByText('attention: No resend permitted')).toBeTruthy();
});

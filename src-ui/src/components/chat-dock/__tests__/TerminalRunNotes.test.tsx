/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { TerminalRunNotes, terminalRunRefreshKey } from '../TerminalRunNotes';

const { sdk, runs } = vi.hoisted(() => ({
  runs: { list: [] as Record<string, unknown>[] },
  sdk: {
    approve: vi.fn(),
    decline: vi.fn(),
    stop: vi.fn(),
  },
}));

vi.mock('@kontourai/station-sdk', () => ({
  listConversationTerminalRuns: async () =>
    runs.list.map((run) => ({ ...run })),
  approveTerminalRun: (_apiBase: string, runId: string) => sdk.approve(runId),
  declineTerminalRun: (_apiBase: string, runId: string) => sdk.decline(runId),
  closeProjectTerminalSession: (...args: unknown[]) => sdk.stop(...args),
}));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://station.test',
    authorityKey: 'operator',
    isCurrent: () => true,
  }),
}));

const pending = (runId: string, command: string) => ({
  runId,
  state: 'needs_approval',
  command,
  cwd: '/work/alpha/.worktrees/fix',
  conversationId: 'conv-1',
  projectSlug: 'alpha',
  bindingKey: 'thread:s1',
  createdAt: '2026-11-03T00:00:00.000Z',
  expiresAt: '2026-11-03T00:10:00.000Z',
});

beforeEach(() => {
  runs.list = [];
  sdk.approve.mockReset().mockResolvedValue({});
  sdk.decline.mockReset().mockResolvedValue({});
  sdk.stop.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

function renderNotes() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TerminalRunNotes conversationId="conv-1" refreshKey="idle:0" />
    </QueryClientProvider>,
  );
}

test('each waiting command is its own card with its exact command and directory', async () => {
  runs.list = [
    pending('run-1', 'npm test -- --run'),
    pending('run-2', 'npm test -- --run'),
  ];
  renderNotes();
  const cards = await screen.findAllByRole('region', {
    name: 'Run npm test -- --run?',
  });
  expect(cards).toHaveLength(2);
  expect(within(cards[0]!).getByText('npm test -- --run')).toBeTruthy();
  expect(
    within(cards[0]!).getByText('/work/alpha/.worktrees/fix'),
  ).toBeTruthy();

  fireEvent.click(within(cards[0]!).getByRole('button', { name: 'Run' }));
  await waitFor(() => expect(sdk.approve).toHaveBeenCalledWith('run-1'));
  // Running the first approves nothing else: the second still asks.
  expect(sdk.approve).toHaveBeenCalledTimes(1);
  fireEvent.click(within(cards[1]!).getByRole('button', { name: 'Decline' }));
  await waitFor(() => expect(sdk.decline).toHaveBeenCalledWith('run-2'));
  expect(sdk.approve).toHaveBeenCalledTimes(1);
});

test('a running command can be stopped in its own binding', async () => {
  runs.list = [
    { ...pending('run-1', 'sleep 60'), state: 'running', terminalId: 't-1' },
  ];
  renderNotes();
  fireEvent.click(await screen.findByRole('button', { name: 'Stop sleep 60' }));
  await waitFor(() =>
    expect(sdk.stop).toHaveBeenCalledWith(
      'http://station.test',
      'alpha',
      't-1',
      'thread:s1',
      expect.anything(),
    ),
  );
});

test('a finished terminal_run call re-reads the runs; a call still running does not', () => {
  const call = (state: string) => ({
    type: 'tool-invocation',
    toolName: 'mcp__station-control__terminal_run',
    state,
  });
  expect(terminalRunRefreshKey('t1', [call('running')])).toBe('t1:0');
  expect(terminalRunRefreshKey('t1', [call('result')])).toBe('t1:1');
});

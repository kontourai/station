/** @vitest-environment jsdom */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { CodingTerminalPane } from '../CodingTerminalPane';

const { closeProjectTerminal, connections } = vi.hoisted(() => ({
  closeProjectTerminal: vi.fn(),
  /** What `useACPConnections` answers: the agent kinds, or not yet. */
  connections: { data: [] as unknown[], isPending: false },
}));

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

beforeEach(() => {
  closeProjectTerminal.mockReset();
  sessionStorage.clear();
  connections.data = [];
  connections.isPending = false;
});

function renderPane(tabs: unknown[]) {
  sessionStorage.setItem('coding-terminal-tabs', JSON.stringify(tabs));
  sessionStorage.setItem(
    'coding-terminal-active-tab',
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
  renderPane([{ id: 'terminal-one', type: 'shell', label: 'Shell 1' }]);

  fireEvent.click(screen.getByRole('button', { name: 'Close Shell 1' }));

  expect(closeProjectTerminal).toHaveBeenCalledWith(
    'http://station.test',
    'project-a',
    'terminal-one',
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
  renderPane([
    {
      id: 'agent-one',
      type: 'agent',
      label: 'Agent: alpha',
      agentSlug: 'alpha',
      mode: 'chat',
    },
  ]);

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
    'agent-one',
  );
  expect(closeProjectTerminal).toHaveBeenNthCalledWith(
    2,
    'http://station.test',
    'project-a',
    'agent-one',
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
  sessionStorage.setItem('coding-terminal-tabs', '[]');
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
  fireEvent.click(screen.getByRole('button', { name: 'Close Shell 1' }));
  await waitFor(() => expect(screen.queryByRole('tab')).toBeNull());
  inA.unmount();
  // Project B, with the (browser-tab-wide) tab list empty: its panel was
  // never emptied by the reader, so it opens a shell.
  expect(sessionStorage.getItem('coding-terminal-tabs')).toBe('[]');
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
  sessionStorage.setItem('coding-terminal-tabs', '[]');
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

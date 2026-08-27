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

const { closeProjectTerminal } = vi.hoisted(() => ({
  closeProjectTerminal: vi.fn(),
}));

vi.mock('@kontourai/station-sdk', () => ({ closeProjectTerminal }));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));
vi.mock('../../../hooks/useACPConnections', () => ({
  useACPConnections: () => ({ data: [] }),
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
});

function renderPane(tabs: unknown[]) {
  sessionStorage.setItem('coding-terminal-tabs', JSON.stringify(tabs));
  sessionStorage.setItem(
    'coding-terminal-active-tab',
    (tabs[0] as any)?.id ?? '',
  );
  render(
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

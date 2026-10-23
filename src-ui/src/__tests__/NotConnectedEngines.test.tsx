/**
 * @vitest-environment jsdom
 *
 * A failed first add leaves a saved connection whose engine never
 * registered. GET /acp/connections does not list it (it is not an installed
 * engine, station#1548); the Engines page lists it beside the engines and its
 * page offers the repairs it needs, never the controls of an engine Station
 * has.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { openOverflow, overflowItems } from './helpers/overflow-menu';

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  remove: vi.fn(),
  update: vi.fn(),
  startChat: vi.fn(),
}));

/** What GET /acp/connections/unregistered answers after two failed adds. */
const unregistered = [
  {
    id: 'stub',
    name: 'Stub Engine',
    command: 'stub-acp',
    args: ['--acp'],
    icon: '🔌',
    enabled: true,
    status: 'unavailable',
    modes: [],
    sessionId: null,
    mcpServers: [],
    currentModel: null,
    lastError: { phase: 'spawn', message: 'spawn stub-acp ENOENT' },
  },
  {
    id: 'kiro',
    name: 'Kiro CLI',
    command: 'kiro-cli',
    args: ['acp'],
    icon: '🔌',
    enabled: true,
    status: 'unavailable',
    modes: [],
    sessionId: null,
    mcpServers: [],
    currentModel: null,
  },
];

vi.mock('../hooks/useACPConnections', () => ({
  useACPConnections: () => ({
    data: [],
    error: null,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
  useACPConnectionRegistry: () => ({ data: [] }),
  useACPConnectionProbeStatuses: () => ({ data: undefined }),
}));

vi.mock('../components/acp-connections/useStartChatWithEngine', () => ({
  useStartChatWithEngine: () => ({
    start: mocks.startChat,
    pending: false,
    notice: null,
  }),
}));

vi.mock('@kontourai/station-sdk', async (importActual) => ({
  ...(await (async () => {
    const actual =
      await importActual<typeof import('@kontourai/station-sdk')>();
    return {
      splitACPArgs: actual.splitACPArgs,
      joinACPArgs: actual.joinACPArgs,
    };
  })()),
  useCreateACPConnectionMutation: () => ({ mutateAsync: vi.fn() }),
  useDeleteACPConnectionMutation: () => ({ mutateAsync: mocks.remove }),
  useInstallACPConnectionRegistryEntryMutation: () => ({
    mutateAsync: vi.fn(),
  }),
  useCheckACPConnectionMutation: () => ({ mutateAsync: mocks.check }),
  useUpdateACPConnectionMutation: () => ({ mutateAsync: mocks.update }),
}));

import { NotConnectedEngineDetail } from '../views/NotConnectedEngineDetail';

afterEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
});

/** The owner's half, as `AgentConnectionView` keeps it. */
function Page({ index, custom }: { index: number; custom: boolean }) {
  const [repairing, setRepairing] = useState<'recheck' | 'edit' | null>(null);
  return (
    <NotConnectedEngineDetail
      engine={{ connection: unregistered[index], custom }}
      repairing={repairing}
      onRepairingChange={setRepairing}
      onRemoved={vi.fn()}
    />
  );
}

describe('a saved engine that never connected', () => {
  test('reads as Not connected yet with the reason, not as an engine Station has', () => {
    render(<Page index={0} custom />);

    expect(screen.getByRole('heading', { name: 'Stub Engine' })).toBeTruthy();
    expect(screen.getByText('Not connected yet', { selector: 'strong' }));
    expect(screen.getByText('spawn stub-acp ENOENT')).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Check connection' }),
    ).toBeNull();
  });

  test('Retry check re-checks the saved connection in place and shows its result', async () => {
    mocks.check.mockResolvedValue({
      ...unregistered[0],
      status: 'unavailable',
      lastError: { phase: 'spawn', message: 'still missing' },
    });
    render(<Page index={0} custom />);

    fireEvent.click(screen.getByRole('button', { name: 'Retry check' }));

    await vi.waitFor(() => expect(mocks.check).toHaveBeenCalledWith('stub'));
    await vi.waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain(
        'Setup required',
      ),
    );
    expect(screen.getByRole('status').textContent).toContain('still missing');
    expect(mocks.update).not.toHaveBeenCalled();
  });

  test('a re-check that connects offers a chat with the engine', async () => {
    mocks.check.mockResolvedValue({
      ...unregistered[0],
      status: 'available',
      lastError: undefined,
    });
    render(<Page index={0} custom />);

    fireEvent.click(screen.getByRole('button', { name: 'Retry check' }));
    const start = await screen.findByRole('button', {
      name: 'Start a chat with Stub Engine',
    });
    fireEvent.click(start);

    expect(mocks.startChat).toHaveBeenCalledWith('stub', 'Stub Engine');
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();
  });

  test('a custom engine can be edited or removed; a built-in one only checked or removed', async () => {
    mocks.remove.mockResolvedValue(undefined);
    const { unmount } = render(<Page index={1} custom={false} />);
    expect(screen.queryByRole('button', { name: 'Edit setup' })).toBeNull();
    expect(overflowItems(openOverflow('Manage Kiro CLI'))).toEqual([
      { name: 'Remove', danger: true },
    ]);
    unmount();

    render(<Page index={0} custom />);
    expect(screen.getByRole('button', { name: 'Edit setup' })).toBeTruthy();
    fireEvent.click(
      within(openOverflow('Manage Stub Engine')).getByRole('menuitem', {
        name: 'Remove',
      }),
    );
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Remove',
      }),
    );
    await vi.waitFor(() => expect(mocks.remove).toHaveBeenCalledWith('stub'));
  });

  test('Edit setup reopens the saved values and saves through the update', async () => {
    mocks.update.mockResolvedValue({
      ...unregistered[0],
      command: 'stub-acp-fixed',
      status: 'available',
      lastError: undefined,
    });
    render(<Page index={0} custom />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit setup' }));
    expect(screen.getByRole('heading', { name: 'Edit engine' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Command'), {
      target: { value: 'stub-acp-fixed' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Check engine' }));

    await vi.waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith({
        id: 'stub',
        updates: {
          name: 'Stub Engine',
          command: 'stub-acp-fixed',
          args: ['--acp'],
          icon: '🔌',
          // Sent even when empty, so an edit can clear the folder.
          cwd: '',
        },
      }),
    );
  });

  // Saving Edit setup with nothing changed must still re-check the engine:
  // the update would change nothing and probe nothing. The check route
  // re-probes the saved config and answers its status.
  test('an unchanged Edit setup re-checks the saved engine and shows its result', async () => {
    mocks.check.mockResolvedValue({
      ...unregistered[0],
      status: 'unavailable',
      lastError: { phase: 'spawn', message: 'spawn stub-acp ENOENT' },
    });
    render(<Page index={0} custom />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit setup' }));

    fireEvent.click(screen.getByRole('button', { name: 'Check engine' }));

    await vi.waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain(
        'Setup required',
      ),
    );
    expect(mocks.check).toHaveBeenCalledWith('stub');
    expect(mocks.update).not.toHaveBeenCalled();

    // Retry check re-checks the saved engine too, not a re-sent update.
    fireEvent.click(screen.getByRole('button', { name: 'Retry check' }));
    await vi.waitFor(() => expect(mocks.check).toHaveBeenCalledTimes(2));
    expect(mocks.update).not.toHaveBeenCalled();
  });

  // After an edit is saved, Retry check must re-check what was saved, not
  // re-send the same update (an unchanged update probes nothing).
  test('Retry check after a saved edit re-checks rather than re-sending the edit', async () => {
    mocks.update.mockResolvedValue({
      ...unregistered[0],
      command: 'stub-acp-fixed',
      status: 'unavailable',
      lastError: { phase: 'initialize', message: 'exited with code 1' },
    });
    mocks.check.mockResolvedValue({
      ...unregistered[0],
      command: 'stub-acp-fixed',
      status: 'available',
      lastError: undefined,
    });
    render(<Page index={0} custom />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit setup' }));
    fireEvent.change(screen.getByLabelText('Command'), {
      target: { value: 'stub-acp-fixed' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Check engine' }));
    await vi.waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain(
        'Setup required',
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Retry check' }));

    await vi.waitFor(() => expect(mocks.check).toHaveBeenCalledWith('stub'));
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });
});

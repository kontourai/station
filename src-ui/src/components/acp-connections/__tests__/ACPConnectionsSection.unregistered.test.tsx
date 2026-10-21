/**
 * @vitest-environment jsdom
 *
 * A failed first add leaves a saved connection whose engine never
 * registered. GET /acp/connections does not list it (it is not an installed
 * engine, station#1548), so the section lists it from its own read with the
 * repairs it needs, and never as an engine Station has.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  openOverflow,
  overflowItems,
} from '../../../__tests__/helpers/overflow-menu';

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  remove: vi.fn(),
  update: vi.fn(),
  refetchConnections: vi.fn(),
  refetchUnregistered: vi.fn(),
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

vi.mock('../../../hooks/useACPConnections', () => ({
  useACPConnections: () => ({
    data: [],
    error: null,
    isError: false,
    isFetching: false,
    isPending: false,
    refetch: mocks.refetchConnections,
  }),
  useUnregisteredACPConnections: () => ({
    data: unregistered,
    refetch: mocks.refetchUnregistered,
  }),
  useACPConnectionRegistry: () => ({
    data: [
      {
        id: 'kiro',
        name: 'Kiro CLI',
        command: 'kiro-cli',
        installed: false,
        detected: true,
      },
    ],
  }),
  useACPConnectionProbeStatuses: () => ({ data: undefined }),
}));

vi.mock('@kontourai/station-sdk', async (importActual) => ({
  splitACPArgs: (await importActual<typeof import('@kontourai/station-sdk')>())
    .splitACPArgs,
  useCreateACPConnectionMutation: () => ({ mutateAsync: vi.fn() }),
  useDeleteACPConnectionMutation: () => ({ mutateAsync: mocks.remove }),
  useInstallACPConnectionRegistryEntryMutation: () => ({
    mutateAsync: vi.fn(),
  }),
  useReconnectACPConnectionMutation: () => ({ mutateAsync: vi.fn() }),
  useCheckACPConnectionMutation: () => ({ mutateAsync: mocks.check }),
  useUpdateACPConnectionMutation: () => ({ mutateAsync: mocks.update }),
}));

import { ACPConnectionsSection } from '../ACPConnectionsSection';

afterEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
});

function card(name: string) {
  return screen
    .getByRole('button', { name: `Open ${name} connection details` })
    .closest('.acp-connection-card') as HTMLElement;
}

describe('saved connections whose engine never registered', () => {
  test('are listed as Not connected yet, not as engines Station has', () => {
    render(<ACPConnectionsSection acpAgents={[]} />);

    for (const name of ['Stub Engine', 'Kiro CLI']) {
      expect(
        within(card(name)).getByRole('status', {
          name: 'Readiness: Not connected yet',
        }),
      ).toBeTruthy();
    }
    expect(screen.queryByText('Add an engine to get started')).toBeNull();
  });

  test('Retry check re-checks the saved connection', async () => {
    mocks.check.mockResolvedValue({ id: 'stub', status: 'available' });
    render(<ACPConnectionsSection acpAgents={[]} />);

    fireEvent.click(
      within(card('Stub Engine')).getByRole('button', { name: 'Retry check' }),
    );

    await vi.waitFor(() => expect(mocks.check).toHaveBeenCalledWith('stub'));
  });

  test('a failed re-check rejects nothing and refreshes the list', async () => {
    mocks.check.mockRejectedValue(new Error('Failed to check the engine'));
    render(<ACPConnectionsSection acpAgents={[]} />);

    fireEvent.click(
      within(card('Stub Engine')).getByRole('button', { name: 'Retry check' }),
    );

    await vi.waitFor(() =>
      expect(mocks.refetchUnregistered).toHaveBeenCalled(),
    );
  });

  test('a custom engine can be edited or removed; a built-in one only removed', async () => {
    render(<ACPConnectionsSection acpAgents={[]} />);

    expect(overflowItems(openOverflow('Manage Kiro CLI'))).toEqual([
      { name: 'Remove', danger: true },
    ]);
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: 'Escape',
    });

    expect(overflowItems(openOverflow('Manage Stub Engine'))).toEqual([
      { name: 'Edit setup', danger: false },
      { name: 'Remove', danger: true },
    ]);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove' }));
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
    render(<ACPConnectionsSection acpAgents={[]} />);

    fireEvent.click(screen.getByRole('button', { name: 'Manage Stub Engine' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit setup' }));

    const dialog = screen.getByRole('dialog', { name: 'Edit engine' });
    fireEvent.change(within(dialog).getByLabelText('Command'), {
      target: { value: 'stub-acp-fixed' },
    });
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Check engine' }),
    );

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
    render(<ACPConnectionsSection acpAgents={[]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Manage Stub Engine' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit setup' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit engine' });

    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Check engine' }),
    );

    await vi.waitFor(() =>
      expect(within(dialog).getByRole('status').textContent).toContain(
        'Setup required',
      ),
    );
    expect(mocks.check).toHaveBeenCalledWith('stub');
    expect(mocks.update).not.toHaveBeenCalled();

    // Retry check re-checks the saved engine too, not a re-sent update.
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Retry check' }),
    );
    await vi.waitFor(() => expect(mocks.check).toHaveBeenCalledTimes(2));
    expect(mocks.update).not.toHaveBeenCalled();
  });
});

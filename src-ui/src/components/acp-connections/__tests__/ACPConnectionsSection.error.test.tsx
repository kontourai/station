/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

const connectionsState = {
  data: [] as unknown[],
  error: null as unknown,
  isError: false,
  isFetching: false,
  isPending: false,
};
const refetchConnections = vi.fn();

vi.mock('../../../hooks/useACPConnections', () => ({
  useACPConnections: () => ({
    ...connectionsState,
    refetch: refetchConnections,
  }),
  useACPConnectionRegistry: () => ({ data: [] }),
}));

vi.mock('@kontourai/station-sdk', () => ({
  useCreateACPConnectionMutation: () => ({
    isPending: false,
    mutateAsync: vi.fn(),
  }),
  useDeleteACPConnectionMutation: () => ({
    isPending: false,
    mutateAsync: vi.fn(),
  }),
  useInstallACPConnectionRegistryEntryMutation: () => ({
    isPending: false,
    mutateAsync: vi.fn(),
  }),
  useReconnectACPConnectionMutation: () => ({
    isPending: false,
    mutateAsync: vi.fn(),
  }),
  useUpdateACPConnectionMutation: () => ({
    isPending: false,
    mutateAsync: vi.fn(),
  }),
}));

import { ACPConnectionsSection } from '../ACPConnectionsSection';

afterEach(() => {
  connectionsState.data = [];
  connectionsState.error = null;
  connectionsState.isError = false;
  connectionsState.isFetching = false;
  connectionsState.isPending = false;
  refetchConnections.mockReset();
});

describe('ACPConnectionsSection read failure (review H1)', () => {
  test('renders the empty state only when the read actually settled empty', () => {
    render(<ACPConnectionsSection acpAgents={[]} />);

    expect(screen.getByText('Add an engine to get started')).toBeTruthy();
    expect(screen.queryByText('Unable to load engines')).toBeNull();
  });

  // The failure was read before this change, but only inside the Add-provider
  // modal — the page fell through and told a user whose provider list Station
  // could not read that they had none and should add one.
  test('renders the failure, not "Add an engine to get started", on a failed read', () => {
    connectionsState.isError = true;
    connectionsState.error = new Error('providers read failed');

    render(<ACPConnectionsSection acpAgents={[]} />);

    expect(screen.queryByText('Add an engine to get started')).toBeNull();
    expect(screen.getByText('Unable to load engines')).toBeTruthy();
    expect(screen.getByText('providers read failed')).toBeTruthy();
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  test('retries the provider read from the failure state', () => {
    connectionsState.isError = true;
    connectionsState.error = new Error('providers read failed');

    render(<ACPConnectionsSection acpAgents={[]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(refetchConnections).toHaveBeenCalledTimes(1);
  });

  test('shows the wait, not the failure, while the first read is in flight', () => {
    connectionsState.isPending = true;

    render(<ACPConnectionsSection acpAgents={[]} />);

    expect(screen.getByLabelText('Loading engines')).toBeTruthy();
    expect(screen.queryByText('Unable to load engines')).toBeNull();
    expect(screen.queryByText('Add an engine to get started')).toBeNull();
  });
});

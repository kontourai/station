/**
 * @vitest-environment jsdom
 *
 * The one "Add computer" entry point and its three branches (:
 * three differently-shaped ways to add a machine within 300px, one of which
 * bypassed the chooser whose copy exists to explain the difference).
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  probe: vi.fn(),
  create: vi.fn(),
}));

vi.mock('@kontourai/station-sdk', () => ({
  authenticatedFetch: vi.fn(),
  useOpenSshHostsQuery: () => ({ data: { hosts: [], unavailableAliases: [] } }),
  useProbeSshEnvironmentMutation: () => ({
    isPending: false,
    mutateAsync: mocks.probe,
  }),
  useCreateSshEnvironmentMutation: () => ({
    isPending: false,
    mutateAsync: mocks.create,
  }),
// `undefined` is the SDK hook's own "the server has not answered yet" shape,
// and its docblock says a consumer must make no device claim in that state —
// so it is the honest default for a file that stands up no server.
  useDevicePresentation: () => undefined,
}));

vi.mock('@kontourai/station-connect', () => ({
  ConnectionManagerModal: ({ initialPanel }: { initialPanel: string }) => (
    <div data-testid="connection-manager">{initialPanel}</div>
  ),
// The SSH branch renders SshComputerCreatorDialog, which reads the device
// presentation and so reaches `useConnections` for the active api base.
// A factory mock makes any unlisted export a hard throw, so this owes the
// line even though nothing here asserts on the connection.
  useConnections: () => ({ apiBase: 'http://station.test' }),
}));

vi.mock('../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => ({ isTauri: false, isDesktop: false }),
}));

vi.mock('../platform/native/haptics', () => ({ triggerHaptic: vi.fn() }));
vi.mock('../lib/compatibilityLoader', () => ({
  checkHostCompatibility: vi.fn(),
}));
vi.mock('../lib/serverHealth', () => ({ checkServerHealthDetailed: vi.fn() }));

import { AddMachineModal } from '../views/connections-hub/AddMachineModal';

describe('AddMachineModal', () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.probe.mockReset();
    mocks.create.mockReset();
  });

  test('asks the goal first, offering all three mechanisms', () => {
    render(<AddMachineModal isOpen onClose={vi.fn()} />);
    expect(screen.getByText('What do you want to do?')).toBeTruthy();
    expect(
      screen.getByText('Control this Station from another device'),
    ).toBeTruthy();
    expect(screen.getByText('Reach another Station')).toBeTruthy();
    expect(
      screen.getByText('Run work on another computer over SSH'),
    ).toBeTruthy();
  });

  test('the control branch opens the shared pairing panel', () => {
    render(<AddMachineModal isOpen onClose={vi.fn()} />);
    fireEvent.click(
      screen.getByText('Control this Station from another device'),
    );
    expect(screen.getByTestId('connection-manager').textContent).toBe(
      'pair-host',
    );
  });

  test('the Station branch opens the address dialog, and adding one persists it locally', async () => {
// A never-resolving handshake proves the add never waits on it.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    );
    const onClose = vi.fn();
    render(<AddMachineModal isOpen onClose={onClose} />);
    fireEvent.click(screen.getByText('Reach another Station'));

    fireEvent.change(screen.getByLabelText(/Station address/), {
      target: { value: 'https://home-lab.tailnet.ts.net' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add Station' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const stored = JSON.parse(
      localStorage.getItem('station-known-environments') ?? '[]',
    ) as Array<{ label: string; source: string }>;
    expect(stored).toHaveLength(1);
    expect(stored[0].label).toBe('https://home-lab.tailnet.ts.net');
    expect(stored[0].source).toBe('manual');
    vi.unstubAllGlobals();
  });

  test('an invalid Station address is refused with a usable message, and nothing is stored', () => {
    render(<AddMachineModal isOpen onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('Reach another Station'));
    fireEvent.change(screen.getByLabelText(/Station address/), {
      target: { value: 'not a url' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add Station' }));

    expect(screen.getByRole('alert').textContent).toContain(
      'Enter a valid Station address',
    );
    expect(localStorage.getItem('station-known-environments')).toBeNull();
  });

  test('the SSH branch opens the creator, in the shared dialog chrome (CI-R19)', () => {
    const { container } = render(<AddMachineModal isOpen onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('Run work on another computer over SSH'));

    expect(
      screen.getByRole('heading', {
        name: 'Run work on another computer over SSH',
      }),
    ).toBeTruthy();
// The shared surface, not the old bespoke uncentred panel with no scrim.
    expect(container.querySelector('.station-dialog__overlay')).toBeTruthy();
    expect(container.querySelector('.ssh-environment-modal')).toBeNull();
  });
});

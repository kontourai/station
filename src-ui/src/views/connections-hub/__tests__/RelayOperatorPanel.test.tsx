/** @vitest-environment jsdom */

import type {
  RelayManagementView,
  RelaySetupApproval,
} from '@kontourai/station-contracts/relay-management';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { RelayOperatorPanel } from '../RelayOperatorPanel';

const state = vi.hoisted(() => ({
  current: true,
  capabilities: vi.fn(),
  view: vi.fn(),
  approve: vi.fn(),
  invite: vi.fn(),
  approveDevice: vi.fn(),
  revoke: vi.fn(),
  deny: vi.fn(),
  copy: vi.fn(),
}));
vi.mock('@kontourai/station-sdk/relay-management', () => ({
  getRelayManagementCapabilities: (...args: unknown[]) =>
    state.capabilities(...args),
  getRelayManagement: (...args: unknown[]) => state.view(...args),
  approveRelaySetup: (...args: unknown[]) => state.approve(...args),
  createRelayInvitation: (...args: unknown[]) => state.invite(...args),
  approveRelayDevice: (...args: unknown[]) => state.approveDevice(...args),
  revokeRelaySetup: (...args: unknown[]) => state.revoke(...args),
  denyRelayDevice: (...args: unknown[]) => state.deny(...args),
}));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({
    apiBase: 'https://station.example',
    authorityKey: 'operator-one',
    isCurrent: () => state.current,
  }),
}));
vi.mock('../../../lib/clipboard', () => ({
  copyToClipboard: (...args: unknown[]) => state.copy(...args),
}));
const approval: RelaySetupApproval = {
  approvalId: '91c3579e-bb25-4bdb-8cb4-bc9706d61456',
  revision: 1,
  scope: {
    stationId: 'b39e4ea7-1a94-4cfb-9583-70ff9e971e21',
    enrollmentId: '8adbb1f1-1863-4560-b922-8f04467730ee',
    routingGeneration: 1,
  },
  surface: {
    kind: 'station-native',
    appIdentifier: 'io.kontourai.station.nightly',
    channel: 'nightly',
    clientInstanceId: '579f0519-95eb-47b8-846b-5908dcb52251',
    keyThumbprint: 'T'.repeat(43),
  },
};
const view: RelayManagementView = {
  route: {
    applicationOrigin: 'https://station.example',
    brokerOrigin: 'https://broker.example',
    stationId: approval.scope.stationId,
    enrollmentId: approval.scope.enrollmentId,
  },
  confirmationCode: '0123456789ABCDEF',
  keyId: 'K'.repeat(43),
  setupLinks: {
    stable: 'station-relay-stable://setup',
    beta: 'station-relay-beta://setup',
    nightly: 'station-relay-nightly://setup',
  },
  approvals: [],
  pendingDevices: [],
};
const clients: QueryClient[] = [];
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <RelayOperatorPanel />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  state.current = true;
  state.capabilities.mockResolvedValue({ canManage: true, configured: true });
  state.view.mockResolvedValue(view);
  state.approve.mockResolvedValue(approval);
  state.invite.mockResolvedValue({
    link: 'station-relay-nightly://bound-invitation',
    expiresAt: Number.MAX_SAFE_INTEGER,
  });
  state.copy.mockResolvedValue(true);
  state.revoke.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
});

test('a caller without the server-reported IAM permission sees no operator controls and never loads invitation data', async () => {
  state.capabilities.mockResolvedValue({ canManage: false, configured: true });
  mount();
  await waitFor(() => expect(state.capabilities).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole('region', { name: 'Invite a device' })).toBeNull();
  expect(state.view).not.toHaveBeenCalled();
  expect(state.approve).not.toHaveBeenCalled();
});

test('the actual setup actions require approval before creating and copying a one-time invitation with the selected expiry', async () => {
  mount();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Copy setup link' }),
  );
  await waitFor(() =>
    expect(state.copy).toHaveBeenCalledWith(view.setupLinks.nightly),
  );
  fireEvent.click(screen.getByText('Approve recipient'));
  fireEvent.change(screen.getByLabelText('Setup info from recipient'), {
    target: { value: '{"publicKey":"recipient-info"}' },
  });
  const create = screen.getByRole('button', { name: 'Create invitation' });
  expect(create.hasAttribute('disabled')).toBe(true);
  fireEvent.change(
    screen.getByRole('combobox', { name: 'Invitation expires' }),
    { target: { value: 'never' } },
  );
  fireEvent.click(screen.getByRole('button', { name: 'Approve device' }));
  await waitFor(() => expect(create.hasAttribute('disabled')).toBe(false));
  expect(state.approve.mock.calls[0]?.[1]).toEqual({
    publicKey: 'recipient-info',
  });
  fireEvent.click(create);
  fireEvent.click(
    await screen.findByRole('button', { name: 'Copy invitation' }),
  );
  expect(state.invite.mock.calls[0]?.[2]).toBe('never');
  await waitFor(() =>
    expect(state.copy).toHaveBeenLastCalledWith(
      'station-relay-nightly://bound-invitation',
    ),
  );
});

test('an uncertain issuance does not offer automatic retry, and retired authority removes the controls', async () => {
  state.invite.mockRejectedValue(new Error('The write outcome is uncertain'));
  const mounted = mount();
  await screen.findByRole('button', { name: 'Copy setup link' });
  fireEvent.click(screen.getByText('Approve recipient'));
  fireEvent.change(screen.getByLabelText('Setup info from recipient'), {
    target: { value: '{}' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Approve device' }));
  const create = screen.getByRole('button', { name: 'Create invitation' });
  await waitFor(() => expect(create.hasAttribute('disabled')).toBe(false));
  fireEvent.click(create);
  await screen.findByRole('alert');
  expect(create.hasAttribute('disabled')).toBe(true);
  expect(state.invite).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', { name: 'Copy invitation' })).toBeNull();
  state.current = false;
  mounted.rerender(
    <QueryClientProvider client={clients[0]!}>
      <RelayOperatorPanel />
    </QueryClientProvider>,
  );
  expect(screen.queryByRole('region', { name: 'Invite a device' })).toBeNull();
});

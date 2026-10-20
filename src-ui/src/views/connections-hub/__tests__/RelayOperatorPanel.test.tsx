/** @vitest-environment jsdom */

import { NATIVE_DEVICE_BINDING_CANDIDATE_VERSION } from '@kontourai/station-contracts/native-device-proof';
import type {
  RelayManagementView,
  RelaySetupApproval,
} from '@kontourai/station-contracts/relay-management';
import {
  StationHttpError,
  setClientCredentialResolver,
} from '@kontourai/station-sdk/client';
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
import { RelayOperatorPanel } from '../RelayOperatorPanel';

const state = vi.hoisted(() => ({
  current: true,
  requiresEnrolledCredential: true,
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
    requiresEnrolledCredential: state.requiresEnrolledCredential,
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
  state.requiresEnrolledCredential = true;
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
  setClientCredentialResolver(undefined);
  vi.restoreAllMocks();
  cleanup();
  for (const client of clients.splice(0)) client.clear();
});

const setupInfo = {
  profileName: 'Home',
  brokerOrigin: view.route.brokerOrigin,
  stationId: view.route.stationId,
  enrollmentId: view.route.enrollmentId,
  appIdentifier: 'io.kontourai.station.nightly',
  channel: 'nightly',
  clientInstanceId: approval.surface.clientInstanceId,
  keyThumbprint: approval.surface.keyThumbprint,
  publicKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
};

async function openInvite() {
  fireEvent.click(await screen.findByRole('button', { name: 'Invite device' }));
  return within(await screen.findByRole('dialog'));
}

test('a caller without the server-reported IAM permission sees no operator controls and never loads invitation data', async () => {
  state.capabilities.mockResolvedValue({ canManage: false, configured: true });
  mount();
  await waitFor(() => expect(state.capabilities).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole('region', { name: 'Devices' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Invite device' })).toBeNull();
  expect(state.view).not.toHaveBeenCalled();
  expect(state.approve).not.toHaveBeenCalled();
});

test('the invite dialog copies the chosen app link, then approves pasted setup info before creating the one-time invitation with the chosen expiry', async () => {
  mount();
  const dialog = await openInvite();
  fireEvent.click(dialog.getByRole('button', { name: 'Beta' }));
  fireEvent.click(dialog.getByRole('button', { name: 'Copy link' }));
  await waitFor(() =>
    expect(state.copy).toHaveBeenCalledWith(view.setupLinks.beta),
  );
  fireEvent.click(dialog.getByRole('button', { name: 'Next' }));
  const approve = dialog.getByRole('button', { name: 'Approve and invite' });
  expect(approve.hasAttribute('disabled')).toBe(true);
  // Messaging apps wrap what the share sheet sent; the JSON inside is used.
  fireEvent.change(dialog.getByLabelText('Their setup info'), {
    target: {
      value: `Here is my setup info:\n${JSON.stringify(setupInfo)}\nthanks`,
    },
  });
  // Valid setup info collapses to what it names; the raw text is gone.
  expect(dialog.getByText('Nightly app').parentElement?.textContent).toBe(
    'Nightly app for this Station',
  );
  expect(dialog.queryByLabelText('Their setup info')).toBeNull();
  const expiry = dialog.getByRole('combobox', { name: 'Invitation expires' });
  expect((expiry as HTMLSelectElement).value).toBe('24h');
  fireEvent.change(expiry, { target: { value: 'never' } });
  fireEvent.click(approve);
  await dialog.findByRole('heading', { name: 'Send the invitation' });
  expect(state.approve.mock.calls[0]?.[1]).toEqual(setupInfo);
  expect(state.invite.mock.calls[0]?.[2]).toEqual(setupInfo);
  expect(state.invite.mock.calls[0]?.[3]).toBe('never');
  expect(state.approve.mock.invocationCallOrder[0]).toBeLessThan(
    state.invite.mock.invocationCallOrder[0]!,
  );
  expect(dialog.getByText(view.confirmationCode)).toBeTruthy();
  fireEvent.click(dialog.getByRole('button', { name: 'Copy invitation' }));
  await waitFor(() =>
    expect(state.copy).toHaveBeenLastCalledWith(
      'station-relay-nightly://bound-invitation',
    ),
  );
  fireEvent.click(dialog.getByRole('button', { name: 'Copy key ID' }));
  await waitFor(() => expect(state.copy).toHaveBeenLastCalledWith(view.keyId));
});

test('setup info for another Station is refused before any approval write', async () => {
  mount();
  const dialog = await openInvite();
  fireEvent.click(dialog.getByRole('button', { name: 'Next' }));
  fireEvent.change(dialog.getByLabelText('Their setup info'), {
    target: {
      value: JSON.stringify({
        ...setupInfo,
        stationId: 'c39e4ea7-1a94-4cfb-9583-70ff9e971e21',
      }),
    },
  });
  expect(dialog.getByRole('alert').textContent).toBe(
    'This setup info is for a different Station.',
  );
  const approve = dialog.getByRole('button', { name: 'Approve and invite' });
  expect(approve.hasAttribute('disabled')).toBe(true);
  fireEvent.click(approve);
  expect(state.approve).not.toHaveBeenCalled();
});

async function enterSetup(dialog: ReturnType<typeof within>, info: object) {
  if (!dialog.queryByLabelText('Their setup info'))
    fireEvent.click(dialog.getByRole('button', { name: 'Next' }));
  fireEvent.change(dialog.getByLabelText('Their setup info'), {
    target: { value: JSON.stringify(info) },
  });
  return dialog.getByRole('button', { name: 'Approve and invite' });
}

test('an uncertain issuance blocks that recipient across Change and close/reopen until explicitly allowed, and retired authority removes the controls', async () => {
  state.invite.mockRejectedValueOnce(
    new Error('The write outcome is uncertain'),
  );
  const mounted = mount();
  let dialog = await openInvite();
  let approve = await enterSetup(dialog, setupInfo);
  fireEvent.click(approve);
  await dialog.findByText(/last invitation wasn’t confirmed/);
  expect(approve.hasAttribute('disabled')).toBe(true);
  fireEvent.click(approve);
  expect(state.approve).toHaveBeenCalledTimes(1);
  expect(state.invite).toHaveBeenCalledTimes(1);
  expect(dialog.queryByRole('button', { name: 'Copy invitation' })).toBeNull();

  // Change, then the same setup info: still blocked.
  fireEvent.click(dialog.getByRole('button', { name: 'Change' }));
  approve = await enterSetup(dialog, setupInfo);
  expect(approve.hasAttribute('disabled')).toBe(true);
  dialog.getByText(/last invitation wasn’t confirmed/);

  // Closing unmounts the dialog; reopening with the same setup info is still
  // blocked and writes nothing.
  fireEvent.click(dialog.getByRole('button', { name: 'Close invite device' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  dialog = await openInvite();
  approve = await enterSetup(dialog, setupInfo);
  expect(approve.hasAttribute('disabled')).toBe(true);
  fireEvent.click(approve);
  expect(state.approve).toHaveBeenCalledTimes(1);
  expect(state.invite).toHaveBeenCalledTimes(1);

  // Another phone is unaffected.
  fireEvent.click(dialog.getByRole('button', { name: 'Change' }));
  const other = {
    ...setupInfo,
    clientInstanceId: '679f0519-95eb-47b8-846b-5908dcb52251',
  };
  approve = await enterSetup(dialog, other);
  expect(approve.hasAttribute('disabled')).toBe(false);
  expect(dialog.queryByText(/last invitation wasn’t confirmed/)).toBeNull();
  fireEvent.click(approve);
  await dialog.findByRole('heading', { name: 'Send the invitation' });
  expect(state.invite.mock.calls[1]?.[2]).toEqual(other);
  fireEvent.click(dialog.getByRole('button', { name: 'Done' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

  // The original phone stays blocked until the operator explicitly allows
  // another; allowing does not itself write.
  dialog = await openInvite();
  approve = await enterSetup(dialog, setupInfo);
  expect(approve.hasAttribute('disabled')).toBe(true);
  fireEvent.click(dialog.getByRole('button', { name: 'Allow another' }));
  expect(state.invite).toHaveBeenCalledTimes(2);
  expect(approve.hasAttribute('disabled')).toBe(false);
  fireEvent.click(approve);
  await dialog.findByRole('heading', { name: 'Send the invitation' });
  expect(state.invite).toHaveBeenCalledTimes(3);
  expect(state.invite.mock.calls[2]?.[2]).toEqual(setupInfo);

  state.current = false;
  mounted.rerender(
    <QueryClientProvider client={clients[0]!}>
      <RelayOperatorPanel />
    </QueryClientProvider>,
  );
  expect(screen.queryByRole('region', { name: 'Devices' })).toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('a refusal the server makes before issuing is not treated as an uncertain invitation', async () => {
  state.invite.mockRejectedValueOnce(
    new StationHttpError(403, 'Relay management is unavailable.'),
  );
  mount();
  const dialog = await openInvite();
  const approve = await enterSetup(dialog, setupInfo);
  fireEvent.click(approve);
  await dialog.findByText(
    'Couldn’t create the invitation. Check it with them.',
  );
  expect(dialog.queryByText(/last invitation wasn’t confirmed/)).toBeNull();
  expect(approve.hasAttribute('disabled')).toBe(false);
  expect(state.invite).toHaveBeenCalledTimes(1);
});

test('a waiting device is approved from its own row, and removal of an approved device needs confirmation', async () => {
  const pending: RelayManagementView['pendingDevices'][number] = {
    enrollmentId: 'E'.repeat(43),
    requestId: '0d3d7e2c-35a4-4a4a-9d55-5f8d5a1f0b11',
    candidate: {
      version: NATIVE_DEVICE_BINDING_CANDIDATE_VERSION,
      stationId: view.route.stationId,
      deviceId: '4f3d7e2c-35a4-4a4a-9d55-5f8d5a1f0b12',
      bindingId: '5f3d7e2c-35a4-4a4a-9d55-5f8d5a1f0b13',
      surface: approval.surface,
      deviceProofJwk: {
        kty: 'EC',
        crv: 'P-256',
        x: 'X'.repeat(43),
        y: 'Y'.repeat(43),
      },
      deviceProofKeyThumbprint: 'D'.repeat(43),
    },
    account: { issuer: 'local', subject: 'zach', displayName: 'Zach' },
    requestedScope: 'orchestration:read',
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
  state.view.mockResolvedValue({
    ...view,
    pendingDevices: [pending],
    approvals: [approval],
  });
  state.approveDevice.mockResolvedValue(undefined);
  mount();
  const waiting = within(
    await screen.findByRole('list', { name: 'Waiting for approval' }),
  );
  fireEvent.click(waiting.getByRole('button', { name: 'Approve' }));
  await waitFor(() =>
    expect(state.approveDevice.mock.calls[0]?.[1]).toBe(pending),
  );
  const approved = within(
    screen.getByRole('list', { name: 'Approved devices' }),
  );
  fireEvent.click(approved.getByRole('button', { name: 'Remove' }));
  expect(state.revoke).not.toHaveBeenCalled();
  fireEvent.click(
    within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }),
  );
  await waitFor(() => expect(state.revoke.mock.calls[0]?.[1]).toBe(approval));
});

test('cookie-authenticated operator controls reach the real SDK while enrolled-only requests remain closed', async () => {
  const sdk = await vi.importActual<
    typeof import('@kontourai/station-sdk/relay-management')
  >('@kontourai/station-sdk/relay-management');
  state.capabilities.mockImplementation(sdk.getRelayManagementCapabilities);
  setClientCredentialResolver(() => ({
    origin: 'https://station.example',
    credential: '',
    requestAuthority: {
      apiBase: 'https://station.example',
      authorityKey: 'operator-one',
      isCurrent: () => state.current,
    },
  }));
  const wire = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input) => {
      if (
        String(input) !==
        'https://station.example/api/relay-management/capabilities'
      )
        throw new Error('unexpected fixture request');
      return Response.json({ data: { canManage: true, configured: true } });
    });
  state.requiresEnrolledCredential = false;
  mount();
  await screen.findByRole('region', { name: 'Devices' });
  expect(wire).toHaveBeenCalledTimes(1);
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  wire.mockClear();
  state.capabilities.mockClear();
  state.requiresEnrolledCredential = true;
  mount();
  await waitFor(() => expect(state.capabilities).toHaveBeenCalledTimes(1));
  await expect(state.capabilities.mock.results[0].value).rejects.toThrow(
    'An enrolled Station credential for this target is required',
  );
  expect(wire).not.toHaveBeenCalled();
  expect(screen.queryByRole('region', { name: 'Devices' })).toBeNull();
});

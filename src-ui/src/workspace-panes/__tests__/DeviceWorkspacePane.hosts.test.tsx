// @vitest-environment jsdom

/**
 * #1973: the Device pane's host picker. With SSH device hosts, the pane
 * lists a host's devices, and every request — the list, the sessions, Open —
 * names that host. With none, no picker appears at all.
 */

import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../hooks/useActiveProject', () => ({
  useActiveProject: () => ({
    projectSlug: null,
    projectName: null,
    workingDirectory: null,
  }),
}));

vi.mock('../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://station.test',
    authorityKey: 'authority-1',
  }),
}));

import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { DeviceWorkspacePane } from '../DeviceWorkspacePane';
import {
  authorizeScope,
  click,
  IOS_DEVICE,
  readyInventory,
  renderInQueryClient,
  stubDeviceFetch,
  unavailableInventory,
} from './deviceWorkspacePaneHarness';

const REMOTE = 'ssh-0123456789ab';
const REMOTE_IOS = {
  ...IOS_DEVICE,
  hostId: REMOTE,
  deviceId: 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE',
  name: 'Studio iPhone',
};
const HOSTS = [
  { hostId: 'local', label: 'This Station', kind: 'local' as const },
  { hostId: REMOTE, label: 'Studio Mac', kind: 'ssh' as const },
];

beforeEach(() => authorizeScope());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setClientCredentialResolver();
  localStorage.clear();
});

describe('the device host picker (#1973)', () => {
  test('no SSH hosts: no picker', async () => {
    stubDeviceFetch();
    renderInQueryClient(<DeviceWorkspacePane />);
    await screen.findByRole('heading', { name: 'iOS Simulators' });
    expect(screen.queryByRole('group', { name: 'Device host' })).toBeNull();
  });

  test('picking an SSH host lists ITS devices and opens a session there', async () => {
    const log = stubDeviceFetch({
      hosts: HOSTS,
      remoteInventory: {
        [REMOTE]: {
          ...readyInventory([REMOTE_IOS]),
          hostId: REMOTE,
        },
      },
    });
    renderInQueryClient(<DeviceWorkspacePane />);
    const picker = await screen.findByRole('group', { name: 'Device host' });
    const local = screen.getByRole('button', { name: 'This Station' });
    expect(local.getAttribute('aria-pressed')).toBe('true');
    expect(picker).toBeTruthy();
    await screen.findByText('iPhone 17 Pro');

    await click(screen.getByRole('button', { name: 'Studio Mac' }));
    await screen.findByText('Studio iPhone');
    expect(
      screen
        .getByRole('button', { name: 'Studio Mac' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    expect(screen.queryByText('iPhone 17 Pro')).toBeNull();

    await click(screen.getByRole('button', { name: /Open Studio iPhone/ }));
    await waitFor(() =>
      expect(
        log.requests.some(
          (request) =>
            request.method === 'POST' &&
            request.url.includes(
              `/api/mobile-devices/hosts/${REMOTE}/devices/ios/${REMOTE_IOS.deviceId}/sessions`,
            ),
        ),
      ).toBe(true),
    );
    // Every device request after the switch named the SSH host.
    const after = log.requests.filter(
      (request) =>
        request.url.includes('/api/mobile-devices/hosts/') &&
        request.url.includes(REMOTE_IOS.deviceId),
    );
    expect(
      after.every((request) => request.url.includes(`/hosts/${REMOTE}/`)),
    ).toBe(true);
    // The pane remembers the host with the device.
    const stored = Object.keys(localStorage)
      .map((key) => localStorage.getItem(key) ?? '')
      .find((value) => value.includes(REMOTE_IOS.deviceId));
    expect(stored && JSON.parse(stored).hostId).toBe(REMOTE);
  });

  test('an SSH host the operator has not enabled says so, not the local setup wizard', async () => {
    stubDeviceFetch({
      hosts: HOSTS,
      remoteInventory: {
        [REMOTE]: { ...unavailableInventory('not-configured'), hostId: REMOTE },
      },
    });
    renderInQueryClient(<DeviceWorkspacePane />);
    await click(await screen.findByRole('button', { name: 'Studio Mac' }));
    await screen.findByText('Devices are not set up on this host');
    expect(screen.getByText(/Settings › Device hosts/)).toBeTruthy();
  });
});

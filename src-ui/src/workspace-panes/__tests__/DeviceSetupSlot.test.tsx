// @vitest-environment jsdom

/**
 * The Device pane's setup slot right after setup: while the managed helper
 * the operator just enabled is starting, it says so (and keeps re-reading
 * the device list) instead of offering "Set up devices" again.
 */

import type { DeviceToolchainStatus } from '@kontourai/station-contracts/device-toolchain';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { DeviceSetupSlot } from '../DeviceSetupSlot';
import {
  authorizeScope,
  renderInQueryClient,
} from './deviceWorkspacePaneHarness';

const SCOPE = { apiBase: 'http://station.test', authorityKey: 'authority-1' };

function status(
  hubEnabled: boolean,
  hubProcess: DeviceToolchainStatus['hubProcess'],
): DeviceToolchainStatus {
  return {
    managedBy: 'station',
    canManage: true,
    hub: { tool: 'expo-device-hub', state: 'installed', version: '0.19.1' },
    agentDevice: {
      tool: 'agent-device',
      state: 'needs-consent',
      requiredVersion: '0.21.12',
    },
    hubProcess,
    hubSource: 'managed',
    hubEnabled,
    agentAccess: false,
    platforms: [],
  } as DeviceToolchainStatus;
}

let answer: DeviceToolchainStatus;
beforeEach(() => {
  authorizeScope();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/mobile-devices/toolchain')
        return Response.json({ success: true, data: answer });
      throw new Error(`Unexpected request ${path}`);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setClientCredentialResolver();
});

test('a helper starting after setup is named, not offered as setup again', async () => {
  answer = status(true, { state: 'starting', version: '0.19.1' });
  renderInQueryClient(
    <DeviceSetupSlot failure="not-configured" requestScope={SCOPE} />,
  );
  await screen.findByLabelText('Starting the device helper');
  expect(screen.queryByRole('button', { name: 'Set up devices' })).toBeNull();
});

test('without the helper enabled, setup is offered', async () => {
  answer = status(false, { state: 'stopped' });
  renderInQueryClient(
    <DeviceSetupSlot failure="not-configured" requestScope={SCOPE} />,
  );
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Set up devices' })).toBeTruthy(),
  );
});

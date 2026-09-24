// @vitest-environment jsdom

/**
 * The device setup wizard (#1970) over a stubbed `fetch` and a real
 * QueryClient: every state it shows is a server status it was handed, and
 * every switch sends the consent its step describes — and nothing before.
 */
import type {
  DeviceToolchainStatus,
  DeviceToolState,
} from '@kontourai/station-contracts/device-toolchain';
import type { MobileDeviceInventory } from '@kontourai/station-contracts/mobile-device';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://station.test',
    authorityKey: 'authority-1',
  }),
}));
// The live Device pane reads the active Project (its `?projectSlug=`);
// the operator here has none.
vi.mock('../../../hooks/useActiveProject', () => ({
  useActiveProject: () => ({
    projectSlug: null,
    projectName: null,
    workingDirectory: null,
  }),
}));

import {
  authorizeScope,
  click,
  renderInQueryClient,
  unavailableInventory,
} from '../../__tests__/deviceWorkspacePaneHarness';
import { DeviceWorkspacePane } from '../../DeviceWorkspacePane';
import DeviceSetupWizard from '../DeviceSetupWizard';

const SCOPE = { apiBase: 'http://station.test', authorityKey: 'authority-1' };

function status(
  overrides: Partial<DeviceToolchainStatus> = {},
): DeviceToolchainStatus {
  return {
    managedBy: 'station',
    canManage: true,
    hub: {
      tool: 'expo-device-hub',
      state: 'needs-consent',
      requiredVersion: '0.10.1',
    },
    agentDevice: {
      tool: 'agent-device',
      state: 'needs-consent',
      requiredVersion: '0.21.12',
    },
    hubProcess: { state: 'stopped' },
    hubSource: 'none',
    hubEnabled: false,
    agentAccess: false,
    platforms: [
      { platform: 'ios', ready: true, reason: 'ready' },
      { platform: 'android', ready: false, reason: 'emulator-missing' },
    ],
    ...overrides,
  };
}

const INSTALLED_HUB: DeviceToolState = {
  tool: 'expo-device-hub',
  state: 'installed',
  version: '0.10.1',
};

interface Plan {
  status: () => DeviceToolchainStatus | { status: number };
  inventory?: MobileDeviceInventory;
  shares?: () => unknown[];
  avds?: Record<string, string>;
}

function stub(plan: Plan) {
  const posts: Array<{ path: string; body: unknown }> = [];
  const reads: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const json = (value: unknown, statusCode = 200) =>
        new Response(JSON.stringify(value), {
          status: statusCode,
          headers: { 'Content-Type': 'application/json' },
        });
      if (url.pathname === '/api/mobile-devices/hosts/local/devices')
        return json({ success: true, data: plan.inventory });
      if (url.pathname === '/api/mobile-devices/shares/avds')
        return json({
          success: true,
          data: Object.fromEntries(
            url.searchParams
              .getAll('serial')
              .map((serial) => [serial, plan.avds?.[serial] ?? null]),
          ),
        });
      if (url.pathname.startsWith('/api/mobile-devices/shares')) {
        const method = init?.method ?? 'GET';
        if (method === 'GET')
          return json({ success: true, data: plan.shares?.() ?? [] });
        posts.push({
          path: `${method} ${url.pathname.replace('/api/mobile-devices/', '')}`,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return json({ success: true, data: {} }, method === 'POST' ? 201 : 200);
      }
      if (url.pathname.startsWith('/api/mobile-devices/toolchain')) {
        if ((init?.method ?? 'GET') === 'POST') {
          posts.push({
            path: url.pathname.replace('/api/mobile-devices/', ''),
            body: JSON.parse(String(init?.body ?? '{}')),
          });
        } else reads.push(url.pathname);
        if (url.pathname.endsWith('/versions'))
          return json({
            success: true,
            data: {
              checkedAt: '2026-09-22T00:00:00.000Z',
              tools: [
                {
                  tool: 'expo-device-hub',
                  required: '0.10.1',
                  installed: ['0.9.0', '0.10.1'],
                  running: '0.10.1',
                },
                {
                  tool: 'agent-device',
                  required: '0.21.12',
                  installed: [],
                  running: null,
                },
              ],
            },
          });
        const current = plan.status();
        if ('status' in current && typeof current.status === 'number')
          return json(
            { success: false, code: 'access-denied' },
            current.status,
          );
        return json({ success: true, data: current });
      }
      throw new Error(`Unexpected request ${url}`);
    }),
  );
  return { posts, reads };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function mountWizard() {
  authorizeScope(SCOPE);
  const onClose = vi.fn();
  renderInQueryClient(
    <DeviceSetupWizard requestScope={SCOPE} onClose={onClose} />,
  );
  return { onClose };
}

describe('device setup wizard', () => {
  test('nothing is installed until the hub switch is turned on, which sends consent', async () => {
    const log = stub({ status: () => status() });
    mountWizard();
    const toggle = await screen.findByRole('switch', {
      name: 'Enable device hub',
    });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText(/Turning this on is your consent/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(log.posts).toEqual([]);
    await click(toggle);
    await waitFor(() =>
      expect(log.posts).toEqual([
        { path: 'toolchain/hub', body: { enabled: true, consent: true } },
      ]),
    );
  });

  test('an install in progress names its step', async () => {
    stub({
      status: () =>
        status({
          hubEnabled: true,
          hub: {
            tool: 'expo-device-hub',
            state: 'installing',
            requiredVersion: '0.10.1',
            phase: 'downloading',
            step: 2,
            totalSteps: 4,
            startedAt: '2026-09-22T00:00:00.000Z',
          },
        }),
    });
    mountWizard();
    expect(
      await screen.findByText(
        'Installing the device hub… (step 2 of 4: downloading)',
      ),
    ).toBeTruthy();
    expect(
      (
        screen.getByRole('switch', {
          name: 'Enable device hub',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  test('a failed install says why and Retry re-sends consent', async () => {
    const log = stub({
      status: () =>
        status({
          hubEnabled: true,
          hub: {
            tool: 'expo-device-hub',
            state: 'failed',
            requiredVersion: '0.10.1',
            reason: 'integrity-mismatch',
            detail: 'node_modules/ws was installed with the wrong integrity.',
            retryable: true,
          },
        }),
    });
    mountWizard();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(
      'node_modules/ws was installed with the wrong integrity.',
    );
    await click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(log.posts).toEqual([
        { path: 'toolchain/hub', body: { enabled: true, consent: true } },
      ]),
    );
  });

  test('a crashed hub offers Start again', async () => {
    const log = stub({
      status: () =>
        status({
          hubEnabled: true,
          hub: INSTALLED_HUB,
          hubProcess: {
            state: 'crashed',
            attempts: 5,
            detail: 'The device hub exited (1).',
          },
        }),
    });
    mountWizard();
    await screen.findByText(/stopped after repeated failures/);
    await click(screen.getByRole('button', { name: 'Start again' }));
    await waitFor(() =>
      expect(log.posts).toEqual([{ path: 'toolchain/hub/start', body: {} }]),
    );
  });

  test('an older install offers Update with the required version', async () => {
    const log = stub({
      status: () =>
        status({
          hubEnabled: true,
          hub: {
            tool: 'expo-device-hub',
            state: 'update-available',
            installedVersion: '0.9.0',
            requiredVersion: '0.10.1',
          },
        }),
    });
    mountWizard();
    await screen.findByText(
      /0\.9\.0 is installed; Station now requires 0\.10\.1/,
    );
    await click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() =>
      expect(log.posts).toEqual([
        { path: 'toolchain/update', body: { tool: 'expo-device-hub' } },
      ]),
    );
  });

  test('a ready hub continues to platform readiness, then agent access (off by default)', async () => {
    const log = stub({
      inventory: {
        hostId: 'local',
        state: 'ready',
        observedAt: '2026-09-22T00:00:00.000Z',
        devices: [],
      },
      status: () =>
        status({
          hubEnabled: true,
          hub: INSTALLED_HUB,
          hubSource: 'managed',
          hubProcess: {
            state: 'running',
            version: '0.10.1',
            startedAt: '2026-09-22T00:00:00.000Z',
          },
        }),
    });
    mountWizard();
    await screen.findByText('The device hub is ready.');
    await click(screen.getByRole('button', { name: 'Continue' }));
    expect(
      screen.getByText('Xcode and iOS Simulator are available.'),
    ).toBeTruthy();
    expect(screen.getByText(/The Android Emulator is missing/)).toBeTruthy();
    const readsBefore = log.reads.length;
    await click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(log.reads.length).toBeGreaterThan(readsBefore));
    await click(screen.getByRole('button', { name: 'Continue' }));
    const agent = screen.getByRole('switch', {
      name: 'Allow agents to control devices',
    });
    expect(agent.getAttribute('aria-checked')).toBe('false');
    expect(
      screen.getByText(
        'Leave this off to keep manual device controls without giving agents access.',
      ),
    ).toBeTruthy();
    expect(log.posts).toEqual([]);
    await click(agent);
    await waitFor(() =>
      expect(log.posts).toEqual([
        {
          path: 'toolchain/agent-access',
          body: { enabled: true, consent: true },
        },
      ]),
    );
  });

  test('a caller who is not the operator is told so, with no switch to press', async () => {
    stub({ status: () => ({ status: 403 }) });
    mountWizard();
    expect(
      await screen.findByText('Ask the Station operator to set up devices.'),
    ).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
  });

  test('Versions shows running, required and installed, managed by Station', async () => {
    stub({ status: () => status() });
    mountWizard();
    await click(await screen.findByRole('button', { name: 'Versions' }));
    const panel = await screen.findByRole('region', {
      name: 'Device tool versions',
    });
    await waitFor(() => expect(panel.textContent).toContain('0.9.0, 0.10.1'));
    expect(panel.textContent).toContain('Managed by Station');
    expect(panel.textContent).toContain('Not running');
  });
});

describe('device sharing (D12)', () => {
  const READY = () =>
    status({
      hubEnabled: true,
      hub: INSTALLED_HUB,
      hubSource: 'managed',
      hubProcess: {
        state: 'running',
        version: '0.10.1',
        startedAt: '2026-09-22T00:00:00.000Z',
      },
    });
  const IPHONE = '6E8C08FA-3A81-4347-90B9-AD41B7FAE876';

  test('the operator shares a device with a Project, and can stop sharing it', async () => {
    const log = stub({
      status: READY,
      inventory: {
        hostId: 'local',
        state: 'ready',
        observedAt: '2026-09-22T00:00:00.000Z',
        devices: [
          {
            hostId: 'local',
            platform: 'ios',
            deviceId: IPHONE,
            name: 'iPhone 17 Pro',
            runtime: 'iOS 26.5',
            booted: true,
          },
        ],
      },
      shares: () => [
        { projectId: 'p-alpha', projectSlug: 'alpha', shares: [] },
        {
          projectId: 'p-beta',
          projectSlug: 'beta',
          shares: [{ platform: 'ios', deviceId: IPHONE, label: 'iPhone' }],
        },
      ],
    });
    mountWizard();
    await screen.findByText('The device hub is ready.');
    await click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Shared with beta.')).toBeTruthy();
    await click(screen.getByRole('button', { name: 'Share with Project…' }));
    const select = screen.getByLabelText('Project') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'alpha' } });
    await click(screen.getByRole('button', { name: 'Share' }));
    await waitFor(() =>
      expect(log.posts).toEqual([
        {
          path: 'POST shares',
          body: {
            projectSlug: 'alpha',
            platform: 'ios',
            deviceId: IPHONE,
            label: 'iPhone 17 Pro',
          },
        },
      ]),
    );
    await click(screen.getByRole('button', { name: 'Stop sharing with beta' }));
    await waitFor(() =>
      expect(log.posts.at(-1)).toEqual({
        path: `DELETE shares/beta/ios/${IPHONE}`,
        body: undefined,
      }),
    );
  });

  test('a running emulator, listed by serial, shows the shares of the AVD running there', async () => {
    const log = stub({
      status: READY,
      avds: { 'emulator-5554': 'Pixel_A' },
      inventory: {
        hostId: 'local',
        state: 'ready',
        observedAt: '2026-09-22T00:00:00.000Z',
        devices: [
          {
            hostId: 'local',
            platform: 'android',
            deviceId: 'emulator-5554',
            name: 'Pixel 9',
            runtime: 'Android 16',
            booted: true,
          },
        ],
      },
      shares: () => [
        {
          projectId: 'p-beta',
          projectSlug: 'beta',
          shares: [
            { platform: 'android', deviceId: 'Pixel_A', label: 'Pixel' },
          ],
        },
      ],
    });
    mountWizard();
    await screen.findByText('The device hub is ready.');
    await click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Shared with beta.')).toBeTruthy();
    await click(screen.getByRole('button', { name: 'Stop sharing with beta' }));
    await waitFor(() =>
      expect(log.posts.at(-1)).toEqual({
        path: 'DELETE shares/beta/android/Pixel_A',
        body: undefined,
      }),
    );
  });

  test('a Project admin is told to ask the operator, with no switch to press', async () => {
    stub({ status: () => ({ ...READY(), canManage: false }) });
    mountWizard();
    expect(
      await screen.findByText('Ask the Station operator to set up devices.'),
    ).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(
      (screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  test('the hub step says what the guard actually guarantees', async () => {
    stub({ status: () => status() });
    mountWizard();
    expect(
      await screen.findByText(
        /Station runs the device hub locally and only answers requests from Station itself\./,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/where only Station can reach it/)).toBeNull();
  });
});

describe('Device pane entry', () => {
  test('an unconfigured host offers Set up devices, which opens the wizard', async () => {
    stub({
      status: () => status(),
      inventory: unavailableInventory('not-configured'),
    });
    authorizeScope(SCOPE);
    renderInQueryClient(<DeviceWorkspacePane />);
    await click(await screen.findByRole('button', { name: 'Set up devices' }));
    expect(
      await screen.findByRole('switch', { name: 'Enable device hub' }),
    ).toBeTruthy();
  });
});

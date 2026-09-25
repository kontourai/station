/** @vitest-environment jsdom */

import type { NativePushRegistrationResponse } from '@kontourai/station-contracts/native-push';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { completeNativeCapabilityReport } from '../../../platform/native/__tests__/completeNativeCapabilityReportFixture';
import {
  type AgentActivityController,
  createAgentActivityController,
  localAgentActivityRegistrationStore,
} from '../../../platform/native/agentActivity';
import { TauriNativePlatformAdapter } from '../../../platform/native/tauri';
import type { NativeAgentActivityStatus } from '../../../platform/native/types';

let target: string = 'android';
vi.mock('../../../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => ({ target }),
}));
vi.mock('@kontourai/station-connect', () => ({
  useConnections: () => ({
    apiBase: 'https://station.test',
    activeConnection: { environmentId: 'env-a' },
  }),
}));

import { AgentActivitySetting } from '../AgentActivitySetting';

const PAYLOAD_KEY = 'p'.repeat(43);

function phone(status: Partial<NativeAgentActivityStatus> = {}) {
  const commands: string[] = [];
  const adapter = new TauriNativePlatformAdapter({
    async invoke<T>(command: string) {
      if (command === 'native_capability_report') {
        return completeNativeCapabilityReport('android', {
          'remote-push': { state: 'enabled' },
        }) as T;
      }
      commands.push(command.split('|')[1]);
      if (command.endsWith('|status')) {
        return {
          sdkInt: 36,
          packageName: 'io.kontourai.station',
          notificationsEnabled: true,
          liveUpdatesSupported: true,
          promotionAllowed: true,
          pushConfigured: true,
          configured: false,
          ...status,
        } as T;
      }
      if (command.endsWith('|push_token'))
        return { state: 'available', token: 'tok' } as T;
      if (command.endsWith('|open_live_update_settings'))
        return { opened: true } as T;
      return null as T;
    },
    listen: async () => () => {},
  });
  return { adapter, commands };
}

async function controllerFor(
  status: Partial<NativeAgentActivityStatus> = {},
  register: () => Promise<NativePushRegistrationResponse> = async () =>
    ({
      registrationId: 'reg_AAAAAAAAAAAAAAAAAAAA',
      stationId: 'env-a',
      stationKey: 'k'.repeat(43),
      payloadKey: PAYLOAD_KEY,
    }) as NativePushRegistrationResponse,
) {
  const { adapter, commands } = phone(status);
  await adapter.getCapabilityReport();
  const unregister = vi.fn(async () => {});
  const controller = createAgentActivityController({
    adapter,
    register,
    unregister,
    store: localAgentActivityRegistrationStore(window.localStorage),
    requestNotificationPermission: async () => false,
    now: () => 0,
  });
  return { controller, commands, unregister };
}

function renderWith(
  loadController: () => Promise<AgentActivityController | null>,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(<AgentActivitySetting loadController={loadController} />, {
    wrapper,
  });
}

const toggle = () =>
  screen.findByRole('switch', { name: 'Agent activity on this phone' });

describe('AgentActivitySetting', () => {
  beforeEach(() => {
    target = 'android';
    window.localStorage.clear();
  });

  it('is absent outside the phone apps, without loading anything', async () => {
    target = 'macos';
    const load = vi.fn(async () => null);
    renderWith(load);
    await act(async () => {});
    expect(screen.queryByTestId('agent-activity')).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it('is absent when the host does not report remote-push as enabled', async () => {
    // The real runtime: under jsdom the platform adapter is the web one.
    const { agentActivityController } = await import(
      '../../../platform/native/agentActivityRuntime'
    );
    renderWith(agentActivityController);
    await act(async () => {});
    expect(screen.queryByTestId('agent-activity')).toBeNull();
  });

  it('turns on through the plugin and the Station, and turns off again', async () => {
    const { controller, commands, unregister } = await controllerFor();
    renderWith(async () => controller);

    fireEvent.click(await toggle());
    await waitFor(async () =>
      expect((await toggle()).getAttribute('aria-checked')).toBe('true'),
    );
    expect(document.body.textContent).not.toContain(PAYLOAD_KEY);

    fireEvent.click(await toggle());
    await waitFor(async () =>
      expect((await toggle()).getAttribute('aria-checked')).toBe('false'),
    );
    expect(unregister).toHaveBeenCalledWith('https://station.test');
    // `status` is re-read after every change; the rest is the flow itself.
    expect(commands.filter((command) => command !== 'status')).toEqual([
      'push_token',
      'configure',
      'clear',
    ]);
  });

  it('shows the registration failure', async () => {
    const { controller } = await controllerFor({}, async () => {
      throw new Error('Failed to register for native push: 500');
    });
    renderWith(async () => controller);

    fireEvent.click(await toggle());
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Failed to register for native push: 500',
    );
    expect((await toggle()).getAttribute('aria-checked')).toBe('false');
  });

  it('says when this build has no push configuration and cannot be turned on', async () => {
    const { controller } = await controllerFor({ pushConfigured: false });
    renderWith(async () => controller);

    expect(
      await screen.findByText('This build has no push configuration.'),
    ).toBeTruthy();
    expect((await toggle()) as HTMLButtonElement).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('says when Android notifications are off', async () => {
    const { controller } = await controllerFor({ notificationsEnabled: false });
    renderWith(async () => controller);

    fireEvent.click(await toggle());
    expect(
      await screen.findByText(
        'Notifications for Station are off. Turn them on in Android settings.',
      ),
    ).toBeTruthy();
    expect((await toggle()).getAttribute('aria-checked')).toBe('false');
  });

  it('offers Live Update settings when promotion is not allowed', async () => {
    const { controller, commands } = await controllerFor({
      promotionAllowed: false,
    });
    renderWith(async () => controller);

    fireEvent.click(await toggle());
    const allow = await screen.findByRole('button', {
      name: 'Allow Live Updates',
    });
    fireEvent.click(allow);
    await waitFor(() =>
      expect(commands).toContain('open_live_update_settings'),
    );
  });
});

/** An iOS phone whose host reports the Live Activity half, over the real adapter. */
async function iosControllerFor(status: Record<string, unknown> = {}) {
  const commands: string[] = [];
  const register = vi.fn(
    async () =>
      ({
        registrationId: 'reg_AAAAAAAAAAAAAAAAAAAA',
        stationId: 'env-a',
        stationKey: 'k'.repeat(43),
        payloadKey: PAYLOAD_KEY,
      }) as NativePushRegistrationResponse,
  );
  const adapter = new TauriNativePlatformAdapter({
    async invoke<T>(command: string) {
      if (command === 'native_capability_report') {
        return completeNativeCapabilityReport('ios', {
          'remote-push': { state: 'enabled' },
        }) as T;
      }
      commands.push(command.split('|')[1]);
      if (command.endsWith('|status')) {
        return {
          platform: 'ios',
          osVersion: '18.4',
          packageName: 'io.kontourai.station',
          liveActivitiesSupported: true,
          liveActivitiesEnabled: true,
          frequentPushesEnabled: false,
          pushConfigured: true,
          configured: false,
          apnsEnvironment: 'production',
          ...status,
        } as T;
      }
      if (command.endsWith('|push_token'))
        return {
          state: 'available',
          token: 'ab'.repeat(32),
          apnsEnvironment: 'production',
        } as T;
      if (command.endsWith('|open_live_update_settings'))
        return { opened: true } as T;
      return null as T;
    },
    listen: async () => () => {},
  });
  await adapter.getCapabilityReport();
  const controller = createAgentActivityController({
    adapter,
    register,
    unregister: vi.fn(async () => {}),
    store: localAgentActivityRegistrationStore(window.localStorage),
    requestNotificationPermission: async () => false,
    now: () => 0,
  });
  return { controller, commands, register };
}

describe('AgentActivitySetting on iOS', () => {
  beforeEach(() => {
    target = 'ios';
    window.localStorage.clear();
  });

  it('turns on as an iOS registration when the build has the Live Activity half and is signed for push', async () => {
    const { controller, register } = await iosControllerFor();
    renderWith(async () => controller);

    fireEvent.click(await toggle());
    await waitFor(async () =>
      expect((await toggle()).getAttribute('aria-checked')).toBe('true'),
    );
    expect(register).toHaveBeenCalledWith(
      {
        token: 'ab'.repeat(32),
        packageName: 'io.kontourai.station',
        platform: 'ios',
        apnsEnvironment: 'production',
      },
      'https://station.test',
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows nothing, and no error, when the host has no Live Activity half', async () => {
    const load = vi.fn(async () => null);
    renderWith(load);
    await act(async () => {});
    expect(load).toHaveBeenCalled();
    expect(screen.queryByTestId('agent-activity')).toBeNull();
  });

  it('shows nothing, and no error, when the build is not signed for push', async () => {
    const { controller, commands } = await iosControllerFor({
      pushConfigured: false,
      apnsEnvironment: undefined,
    });
    renderWith(async () => controller);
    await waitFor(() => expect(commands).toContain('status'));
    await act(async () => {});
    expect(screen.queryByTestId('agent-activity')).toBeNull();
  });

  it('shows nothing below iOS 18', async () => {
    const { controller, commands } = await iosControllerFor({
      liveActivitiesSupported: false,
    });
    renderWith(async () => controller);
    await waitFor(() => expect(commands).toContain('status'));
    await act(async () => {});
    expect(screen.queryByTestId('agent-activity')).toBeNull();
  });

  it('says when Live Activities are off for Station and offers Settings', async () => {
    const { controller, commands, register } = await iosControllerFor({
      liveActivitiesEnabled: false,
    });
    renderWith(async () => controller);

    fireEvent.click(await toggle());
    fireEvent.click(
      await screen.findByRole('button', { name: 'Open Settings' }),
    );
    await waitFor(() =>
      expect(commands).toContain('open_live_update_settings'),
    );
    expect(register).not.toHaveBeenCalled();
    expect((await toggle()).getAttribute('aria-checked')).toBe('false');
  });
});

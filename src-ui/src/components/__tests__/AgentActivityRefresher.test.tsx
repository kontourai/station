/** @vitest-environment jsdom */

import type { NativePushRegistrationResponse } from '@kontourai/station-contracts/native-push';
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { completeNativeCapabilityReport } from '../../platform/native/__tests__/completeNativeCapabilityReportFixture';
import {
  type AgentActivityController,
  createAgentActivityController,
  localAgentActivityRegistrationStore,
} from '../../platform/native/agentActivity';
import { TauriNativePlatformAdapter } from '../../platform/native/tauri';

let target = 'android';
let controller: AgentActivityController | null = null;
vi.mock('../../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => ({ target }),
}));
vi.mock('@kontourai/station-connect', () => ({
  useConnections: () => ({
    apiBase: 'https://station.test',
    activeConnection: { environmentId: 'env-a' },
  }),
}));
vi.mock('../../platform/native/agentActivityRuntime', () => ({
  agentActivityController: async () => controller,
}));

import { AgentActivityRefresher } from '../AgentActivityRefresher';

let token = 'tok-1';
const register = vi.fn(
  async () =>
    ({
      registrationId: 'reg_AAAAAAAAAAAAAAAAAAAA',
      stationId: 'env-a',
      stationKey: 'k'.repeat(43),
      payloadKey: 'p'.repeat(43),
    }) as NativePushRegistrationResponse,
);

async function phoneController() {
  const adapter = new TauriNativePlatformAdapter({
    async invoke<T>(command: string) {
      if (command === 'native_capability_report') {
        return completeNativeCapabilityReport('android', {
          'remote-push': { state: 'enabled' },
        }) as T;
      }
      if (command.endsWith('|status')) {
        return {
          sdkInt: 36,
          packageName: 'io.kontourai.station',
          notificationsEnabled: true,
          liveUpdatesSupported: true,
          promotionAllowed: true,
          pushConfigured: true,
          configured: true,
        } as T;
      }
      if (command.endsWith('|push_token'))
        return { state: 'available', token } as T;
      return null as T;
    },
    listen: async () => () => {},
  });
  await adapter.getCapabilityReport();
  return createAgentActivityController({
    adapter,
    register,
    unregister: async () => {},
    store: localAgentActivityRegistrationStore(window.localStorage),
    requestNotificationPermission: async () => true,
    now: () => 0,
  });
}

async function foreground() {
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await act(async () => {});
}

describe('AgentActivityRefresher', () => {
  beforeEach(async () => {
    target = 'android';
    token = 'tok-1';
    window.localStorage.clear();
    register.mockClear();
    controller = await phoneController();
  });

  it('registers nothing for a Station that was never turned on', async () => {
    render(<AgentActivityRefresher />);
    await foreground();
    expect(register).not.toHaveBeenCalled();
  });

  it('re-registers on return to the foreground only when the token changed', async () => {
    await controller?.enable({
      environmentId: 'env-a',
      apiBase: 'https://station.test',
    });
    register.mockClear();
    render(<AgentActivityRefresher />);
    await foreground();
    expect(register).not.toHaveBeenCalled();

    token = 'tok-2';
    await foreground();
    expect(register).toHaveBeenCalledTimes(1);
    expect(register.mock.calls[0]).toEqual([
      {
        token: 'tok-2',
        packageName: 'io.kontourai.station',
        platform: 'android',
      },
      'https://station.test',
    ]);
  });

  it('does nothing outside the Android app', async () => {
    await controller?.enable({
      environmentId: 'env-a',
      apiBase: 'https://station.test',
    });
    register.mockClear();
    token = 'tok-2';
    target = 'macos';
    render(<AgentActivityRefresher />);
    await foreground();
    expect(register).not.toHaveBeenCalled();
  });

  it('re-registers an iOS registration on return to the foreground when the push-to-start token rotated', async () => {
    target = 'ios';
    let iosToken = 'ab'.repeat(32);
    const adapter = new TauriNativePlatformAdapter({
      async invoke<T>(command: string) {
        if (command === 'native_capability_report') {
          return completeNativeCapabilityReport('ios', {
            'remote-push': { state: 'enabled' },
          }) as T;
        }
        if (command.endsWith('|status')) {
          return {
            platform: 'ios',
            osVersion: '18.4',
            packageName: 'io.kontourai.station',
            liveActivitiesSupported: true,
            liveActivitiesEnabled: true,
            frequentPushesEnabled: false,
            pushConfigured: true,
            configured: true,
            apnsEnvironment: 'production',
          } as T;
        }
        if (command.endsWith('|push_token'))
          return {
            state: 'available',
            token: iosToken,
            apnsEnvironment: 'production',
          } as T;
        return null as T;
      },
      listen: async () => () => {},
    });
    await adapter.getCapabilityReport();
    controller = createAgentActivityController({
      adapter,
      register,
      unregister: async () => {},
      store: localAgentActivityRegistrationStore(window.localStorage),
      requestNotificationPermission: async () => true,
      now: () => 0,
    });
    await controller.enable({
      environmentId: 'env-a',
      apiBase: 'https://station.test',
    });
    register.mockClear();
    render(<AgentActivityRefresher />);
    await foreground();
    expect(register).not.toHaveBeenCalled();

    iosToken = 'cd'.repeat(32);
    await foreground();
    expect(register).toHaveBeenCalledTimes(1);
    expect(register.mock.calls[0]).toEqual([
      {
        token: 'cd'.repeat(32),
        packageName: 'io.kontourai.station',
        platform: 'ios',
        apnsEnvironment: 'production',
      },
      'https://station.test',
    ]);
  });
});

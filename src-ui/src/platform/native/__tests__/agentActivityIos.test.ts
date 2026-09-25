import type {
  NativePushRegistrationRequest,
  NativePushRegistrationResponse,
} from '@kontourai/station-contracts/native-push';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_ACTIVITY_REFRESH_AFTER_MS,
  createAgentActivityController,
  localAgentActivityRegistrationStore,
} from '../agentActivity';
import { TauriNativePlatformAdapter } from '../tauri';
import { completeNativeCapabilityReport } from './completeNativeCapabilityReportFixture';

const STATION = 'env-station-a';
const API_BASE = 'https://station-a.test';
const REGISTRATION_ID = 'reg_AAAAAAAAAAAAAAAAAAAA';
const STATION_KEY = 'k'.repeat(43);
const PAYLOAD_KEY = 'p'.repeat(43);
// A push-to-start token as the Swift plugin writes it: lowercase hex.
const TOKEN_1 = 'ab'.repeat(32);
const TOKEN_2 = 'cd'.repeat(40);

type Call = { command: string; args?: Record<string, unknown> };

/**
 * The exact `status` reply AgentActivityPlugin.swift builds on an iOS 18
 * phone signed for push (a debug build: `sandbox`). `apnsEnvironment` is
 * absent when the build is not signed for push.
 */
function iosStatus(overrides: Record<string, unknown> = {}) {
  return {
    platform: 'ios',
    osVersion: '18.4',
    packageName: 'io.kontourai.station.nightly',
    liveActivitiesSupported: true,
    liveActivitiesEnabled: true,
    frequentPushesEnabled: false,
    pushConfigured: true,
    configured: false,
    apnsEnvironment: 'sandbox',
    ...overrides,
  };
}

/**
 * Drives the controller through the REAL Tauri adapter over a recording
 * bridge reporting an iOS host with the Live Activity half, so a wrong plugin
 * command, argument or reply shape fails here.
 */
function iosHarness(
  options: {
    status?: Record<string, unknown>;
    pushToken?: Record<string, unknown>;
    response?: Partial<NativePushRegistrationResponse>;
  } = {},
) {
  const calls: Call[] = [];
  const events: string[] = [];
  let status: Record<string, unknown> | undefined = options.status;
  let pushToken: Record<string, unknown> = options.pushToken ?? {
    state: 'available',
    token: TOKEN_1,
    apnsEnvironment: 'sandbox',
  };
  const adapter = new TauriNativePlatformAdapter({
    async invoke<T>(command: string, args?: Record<string, unknown>) {
      if (command === 'native_capability_report') {
        return completeNativeCapabilityReport('ios', {
          'remote-push': { state: 'enabled' },
        }) as T;
      }
      calls.push({ command, args });
      const name = command.split('|')[1];
      events.push(name);
      switch (name) {
        case 'status':
          return iosStatus(status) as T;
        case 'push_token':
          return pushToken as T;
        case 'configure':
        case 'clear':
          return null as T;
      }
      throw new Error(`unexpected command ${command}`);
    },
    listen: async () => () => {},
  });
  const registered: Array<{
    request: NativePushRegistrationRequest;
    apiBase: string;
  }> = [];
  const unregistered: string[] = [];
  const storage = new Map<string, string>();
  const store = localAgentActivityRegistrationStore({
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => void storage.set(key, value),
  });
  let now = 1_000_000;
  const controller = createAgentActivityController({
    adapter,
    async register(request, apiBase) {
      events.push('register');
      registered.push({ request, apiBase });
      return {
        registrationId: REGISTRATION_ID,
        stationId: STATION,
        stationKey: STATION_KEY,
        payloadKey: PAYLOAD_KEY,
        ...options.response,
      };
    },
    async unregister(apiBase) {
      events.push('unregister');
      unregistered.push(apiBase);
    },
    store,
    async requestNotificationPermission() {
      events.push('permission');
      return false;
    },
    now: () => now,
  });
  return {
    controller,
    calls,
    events,
    registered,
    unregistered,
    storage,
    setStatus: (next: Record<string, unknown>) => {
      status = next;
    },
    setPushToken: (next: Record<string, unknown>) => {
      pushToken = next;
    },
    advance: (ms: number) => {
      now += ms;
    },
    ready: () => adapter.getCapabilityReport(),
  };
}

const target = { environmentId: STATION, apiBase: API_BASE };

describe('agent activity controller on iOS', () => {
  let h: ReturnType<typeof iosHarness>;
  beforeEach(async () => {
    h = iosHarness();
    await h.ready();
  });

  it('enables with status → push_token → register as ios → configure with exactly what the Station returned', async () => {
    const outcome = await h.controller.enable(target);

    // No notification permission prompt: a Live Activity does not need one.
    expect(h.events).toEqual(['status', 'push_token', 'register', 'configure']);
    expect(h.registered).toEqual([
      {
        request: {
          token: TOKEN_1,
          packageName: 'io.kontourai.station.nightly',
          platform: 'ios',
          apnsEnvironment: 'sandbox',
        },
        apiBase: API_BASE,
      },
    ]);
    expect(h.calls.at(-1)).toEqual({
      command: 'plugin:station-agent-activity|configure',
      args: {
        registrationId: REGISTRATION_ID,
        stationId: STATION,
        stationKey: STATION_KEY,
        payloadKey: PAYLOAD_KEY,
        ongoingEnabled: true,
      },
    });
    expect(outcome.status).toBe('enabled');
    expect([...h.storage.values()].join('')).not.toContain(PAYLOAD_KEY);
    expect(h.controller.registration(STATION)).toEqual({
      registrationId: REGISTRATION_ID,
      stationId: STATION,
      stationKey: STATION_KEY,
      token: TOKEN_1,
      packageName: 'io.kontourai.station.nightly',
      registeredAt: 1_000_000,
      platform: 'ios',
      apnsEnvironment: 'sandbox',
    });
  });

  it('registers the APNs environment the token belongs to (a production build)', async () => {
    h = iosHarness({
      status: { apnsEnvironment: 'production' },
      pushToken: {
        state: 'available',
        token: TOKEN_1,
        apnsEnvironment: 'production',
      },
    });
    await h.ready();

    await h.controller.enable(target);

    expect(h.registered[0]?.request).toMatchObject({
      platform: 'ios',
      apnsEnvironment: 'production',
    });
  });

  it('refuses a token whose APNs environment the plugin did not name, registering nothing', async () => {
    h = iosHarness({ pushToken: { state: 'available', token: TOKEN_1 } });
    await h.ready();

    await expect(h.controller.enable(target)).rejects.toThrow(
      /which APNs environment/,
    );
    expect(h.registered).toEqual([]);
  });

  it('refuses a bundle the push gateway does not deliver Live Activities to', async () => {
    // An Android-only channel id: in NATIVE_PUSH_ANDROID_PACKAGES, not in NATIVE_PUSH_IOS_BUNDLES.
    h = iosHarness({ status: { packageName: 'io.kontourai.station.debug' } });
    await h.ready();

    await expect(h.controller.enable(target)).rejects.toThrow(
      /not one the push gateway delivers to/,
    );
    expect(h.registered).toEqual([]);
  });

  it('registers nothing when the build is not signed for push', async () => {
    h = iosHarness({
      status: { pushConfigured: false, apnsEnvironment: undefined },
    });
    await h.ready();

    await expect(h.controller.enable(target)).resolves.toEqual({
      status: 'unconfigured',
    });
    expect(h.events).toEqual(['status']);
  });

  it('registers nothing below iOS 18', async () => {
    h = iosHarness({
      status: { liveActivitiesSupported: false },
      pushToken: { state: 'unsupported' },
    });
    await h.ready();

    await expect(h.controller.enable(target)).resolves.toEqual({
      status: 'unsupported',
    });
    expect(h.registered).toEqual([]);
  });

  it('registers nothing while Live Activities are off for Station, without a notification prompt', async () => {
    h = iosHarness({ status: { liveActivitiesEnabled: false } });
    await h.ready();

    await expect(h.controller.enable(target)).resolves.toEqual({
      status: 'live-activities-disabled',
    });
    expect(h.events).toEqual(['status']);
  });

  it('disables by unregistering and clearing that registration', async () => {
    await h.controller.enable(target);
    h.calls.length = 0;
    h.events.length = 0;

    await h.controller.disable(target);

    expect(h.events).toEqual(['unregister', 'clear']);
    expect(h.unregistered).toEqual([API_BASE]);
    expect(h.calls).toEqual([
      {
        command: 'plugin:station-agent-activity|clear',
        args: { registrationId: REGISTRATION_ID },
      },
    ]);
    expect(h.controller.registration(STATION)).toBeNull();
  });

  it('refresh with an unchanged, recent token does not re-register', async () => {
    await h.controller.enable(target);
    h.events.length = 0;
    h.advance(60_000);

    await expect(h.controller.refresh(target)).resolves.toBe('current');
    expect(h.events).toEqual(['push_token']);
  });

  it('refresh re-registers as ios when the push-to-start token rotated', async () => {
    await h.controller.enable(target);
    h.events.length = 0;
    h.setPushToken({
      state: 'available',
      token: TOKEN_2,
      apnsEnvironment: 'sandbox',
    });

    await expect(h.controller.refresh(target)).resolves.toBe('refreshed');
    expect(h.events).toEqual(['push_token', 'register', 'configure']);
    expect(h.registered.at(-1)?.request).toEqual({
      token: TOKEN_2,
      packageName: 'io.kontourai.station.nightly',
      platform: 'ios',
      apnsEnvironment: 'sandbox',
    });
    expect(h.controller.registration(STATION)?.token).toBe(TOKEN_2);
  });

  it('refresh re-registers when the same token now belongs to another APNs environment', async () => {
    await h.controller.enable(target);
    h.events.length = 0;
    h.setPushToken({
      state: 'available',
      token: TOKEN_1,
      apnsEnvironment: 'production',
    });

    await expect(h.controller.refresh(target)).resolves.toBe('refreshed');
    expect(h.registered.at(-1)?.request).toMatchObject({
      apnsEnvironment: 'production',
    });
    expect(h.controller.registration(STATION)).toMatchObject({
      apnsEnvironment: 'production',
    });
  });

  it('refresh re-registers an unchanged token once the registration is a day old', async () => {
    await h.controller.enable(target);
    h.events.length = 0;
    h.advance(AGENT_ACTIVITY_REFRESH_AFTER_MS);

    await expect(h.controller.refresh(target)).resolves.toBe('refreshed');
    expect(h.events).toEqual(['push_token', 'register', 'configure']);
    expect(h.registered.at(-1)?.request.platform).toBe('ios');
  });

  it('an iOS registration survives the store round trip, and a malformed one is dropped', async () => {
    await h.controller.enable(target);
    const stored = JSON.parse(
      h.storage.get('station-agent-activity-registrations-v1') ?? '{}',
    );
    expect(stored[STATION]).toMatchObject({
      platform: 'ios',
      apnsEnvironment: 'sandbox',
    });

    h.storage.set(
      'station-agent-activity-registrations-v1',
      JSON.stringify({
        [STATION]: { ...stored[STATION], apnsEnvironment: 'development' },
      }),
    );
    expect(h.controller.registration(STATION)).toBeNull();
  });

  it('keeps a record whose bundle the gateway no longer lists: refresh refuses it, disable still withdraws it', async () => {
    await h.controller.enable(target);
    const key = 'station-agent-activity-registrations-v1';
    const stored = JSON.parse(h.storage.get(key) ?? '{}');
    h.storage.set(
      key,
      JSON.stringify({
        [STATION]: { ...stored[STATION], packageName: 'io.kontourai.retired' },
      }),
    );
    expect(h.controller.registration(STATION)).toMatchObject({
      packageName: 'io.kontourai.retired',
    });
    h.events.length = 0;
    h.calls.length = 0;
    h.advance(AGENT_ACTIVITY_REFRESH_AFTER_MS);

    await expect(h.controller.refresh(target)).rejects.toThrow(
      /not one the push gateway delivers to/,
    );
    expect(h.events).not.toContain('register');

    h.events.length = 0;
    h.calls.length = 0;
    await h.controller.disable(target);
    expect(h.events).toEqual(['unregister', 'clear']);
    expect(h.calls).toEqual([
      {
        command: 'plugin:station-agent-activity|clear',
        args: { registrationId: REGISTRATION_ID },
      },
    ]);
    expect(h.controller.registration(STATION)).toBeNull();
  });

  it('builds a request the Station route accepts (isValidNativePushRequest)', async () => {
    // Imported through a variable so the UI typecheck does not pull the
    // server module in, as authenticatedTransport.test.ts does.
    const storePath =
      '../../../../../src-server/services/notifications/native-push-registration-store.js';
    const { isValidNativePushRequest } = (await import(storePath)) as {
      isValidNativePushRequest: (value: unknown) => boolean;
    };
    await h.controller.enable(target);
    h.setPushToken({
      state: 'available',
      token: TOKEN_2,
      apnsEnvironment: 'production',
    });
    await h.controller.refresh(target);

    expect(h.registered.map((entry) => entry.request.platform)).toEqual([
      'ios',
      'ios',
    ]);
    for (const { request } of h.registered)
      expect(isValidNativePushRequest(request)).toBe(true);
    // The check has power: the same request without its APNs environment is
    // refused.
    expect(
      isValidNativePushRequest({
        ...h.registered[0]?.request,
        apnsEnvironment: undefined,
      }),
    ).toBe(false);
  });
});

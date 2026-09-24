import type {
  NativePushRegistrationRequest,
  NativePushRegistrationResponse,
} from '@kontourai/station-contracts/native-push';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_ACTIVITY_REFRESH_AFTER_MS,
  type AgentActivityRegistrationRecord,
  createAgentActivityController,
  localAgentActivityRegistrationStore,
} from '../agentActivity';
import { TauriNativePlatformAdapter } from '../tauri';
import type { NativeAgentActivityStatus } from '../types';
import { completeNativeCapabilityReport } from './completeNativeCapabilityReportFixture';

const STATION = 'env-station-a';
const API_BASE = 'https://station-a.test';
const REGISTRATION_ID = 'reg_AAAAAAAAAAAAAAAAAAAA';
const STATION_KEY = 'k'.repeat(43);
const PAYLOAD_KEY = 'p'.repeat(43);

type Call = { command: string; args?: Record<string, unknown> };

/**
 * Drives the controller through the REAL Tauri adapter over a recording
 * bridge, so a wrong plugin command or argument name fails here too.
 */
function harness(
  options: {
    status?: Partial<NativeAgentActivityStatus>;
    token?: string | null;
    response?: Partial<NativePushRegistrationResponse> & {
      payloadKey?: unknown;
    };
    registerError?: Error;
    unregisterError?: Error;
    permissionGrants?: boolean;
  } = {},
) {
  const calls: Call[] = [];
  const events: string[] = [];
  let status: NativeAgentActivityStatus = {
    sdkInt: 36,
    packageName: 'io.kontourai.station.nightly',
    notificationsEnabled: true,
    liveUpdatesSupported: true,
    promotionAllowed: true,
    pushConfigured: true,
    configured: false,
    ...options.status,
  };
  let token = options.token === undefined ? 'fcm-token-1' : options.token;
  const adapter = new TauriNativePlatformAdapter({
    async invoke<T>(command: string, args?: Record<string, unknown>) {
      if (command === 'native_capability_report') {
        return completeNativeCapabilityReport('android', {
          'remote-push': { state: 'enabled' },
        }) as T;
      }
      calls.push({ command, args });
      const name = command.split('|')[1];
      events.push(name);
      switch (name) {
        case 'status':
          return status as T;
        case 'push_token':
          return (
            token === null
              ? { state: 'unconfigured' }
              : { state: 'available', token }
          ) as T;
        case 'configure':
        case 'clear':
          return null as T;
        case 'open_live_update_settings':
          return { opened: true } as T;
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
      if (options.registerError) throw options.registerError;
      return {
        registrationId: REGISTRATION_ID,
        stationId: STATION,
        stationKey: STATION_KEY,
        payloadKey: PAYLOAD_KEY,
        ...options.response,
      } as NativePushRegistrationResponse;
    },
    async unregister(apiBase) {
      events.push('unregister');
      unregistered.push(apiBase);
      if (options.unregisterError) throw options.unregisterError;
    },
    store,
    async requestNotificationPermission() {
      events.push('permission');
      if (options.permissionGrants) {
        status = { ...status, notificationsEnabled: true };
      }
      return options.permissionGrants === true;
    },
    now: () => now,
  });
  return {
    adapter,
    controller,
    calls,
    events,
    registered,
    unregistered,
    store,
    setToken: (next: string) => {
      token = next;
    },
    advance: (ms: number) => {
      now += ms;
    },
    ready: () => adapter.getCapabilityReport(),
  };
}

const target = { environmentId: STATION, apiBase: API_BASE };

describe('agent activity controller', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(async () => {
    h = harness();
    await h.ready();
  });

  it('enables with status → push_token → register → configure, passing each step the previous answer', async () => {
    const outcome = await h.controller.enable(target);

    expect(h.events).toEqual(['status', 'push_token', 'register', 'configure']);
    expect(h.registered).toEqual([
      {
        request: {
          token: 'fcm-token-1',
          packageName: 'io.kontourai.station.nightly',
          platform: 'android',
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
    expect(h.controller.registration(STATION)).toEqual({
      registrationId: REGISTRATION_ID,
      stationId: STATION,
      stationKey: STATION_KEY,
      payloadKey: PAYLOAD_KEY,
      token: 'fcm-token-1',
      packageName: 'io.kontourai.station.nightly',
      registeredAt: 1_000_000,
    });
  });

  it('refuses to configure the phone when the Station returns no payload key, and withdraws the registration', async () => {
    h = harness({ response: { payloadKey: undefined } });
    await h.ready();

    const failure = await h.controller.enable(target).catch((e: Error) => e);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/encryption key/);
    expect(h.events).not.toContain('configure');
    expect(h.unregistered).toEqual([API_BASE]);
    expect(h.controller.registration(STATION)).toBeNull();
  });

  it('never puts the payload key into an error message', async () => {
    h = harness({ response: { stationId: 'env-other' } });
    await h.ready();

    const failure = (await h.controller
      .enable(target)
      .catch((e: Error) => e)) as Error;

    expect(failure.message).toMatch(/different Station/);
    expect(failure.message).not.toContain(PAYLOAD_KEY);
    expect(h.events).not.toContain('configure');
  });

  it('registers nothing when this build has no push configuration', async () => {
    h = harness({ status: { pushConfigured: false } });
    await h.ready();

    await expect(h.controller.enable(target)).resolves.toEqual({
      status: 'unconfigured',
    });
    expect(h.registered).toEqual([]);
  });

  it('asks for notification permission and registers nothing while it is refused', async () => {
    h = harness({ status: { notificationsEnabled: false } });
    await h.ready();

    await expect(h.controller.enable(target)).resolves.toEqual({
      status: 'notifications-disabled',
    });
    expect(h.events).toEqual(['status', 'permission', 'status']);
    expect(h.registered).toEqual([]);
  });

  it('continues once notification permission is granted', async () => {
    h = harness({
      status: { notificationsEnabled: false },
      permissionGrants: true,
    });
    await h.ready();

    await expect(h.controller.enable(target)).resolves.toMatchObject({
      status: 'enabled',
    });
  });

  it('refuses a package the push gateway does not deliver to', async () => {
    h = harness({ status: { packageName: 'com.example.fork' } });
    await h.ready();

    await expect(h.controller.enable(target)).rejects.toThrow(
      /not one the push gateway delivers to/,
    );
    expect(h.registered).toEqual([]);
  });

  it('disables by unregistering and clearing only that registration', async () => {
    await h.controller.enable(target);
    const other: AgentActivityRegistrationRecord = {
      registrationId: 'reg_BBBBBBBBBBBBBBBBBBBB',
      stationId: 'env-station-b',
      stationKey: STATION_KEY,
      payloadKey: PAYLOAD_KEY,
      token: 'fcm-token-1',
      packageName: 'io.kontourai.station.nightly',
      registeredAt: 1,
    };
    h.store.set('env-station-b', other);
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
    expect(h.controller.registration('env-station-b')).toEqual(other);
  });

  it('still turns the phone off when the Station cannot be told, and says so', async () => {
    h = harness({ unregisterError: new Error('Station unreachable') });
    await h.ready();
    await h.controller.enable(target);

    await expect(h.controller.disable(target)).rejects.toThrow(
      /Turned off on this phone, but the Station could not be told: Station unreachable/,
    );
    expect(h.events.at(-1)).toBe('clear');
    expect(h.controller.registration(STATION)).toBeNull();
  });

  it('refresh does nothing at all for a Station that was never turned on', async () => {
    await expect(h.controller.refresh(target)).resolves.toBe('off');
    expect(h.calls).toEqual([]);
    expect(h.registered).toEqual([]);
  });

  it('refresh with an unchanged, recent token does not re-register', async () => {
    await h.controller.enable(target);
    h.events.length = 0;
    h.advance(60_000);

    await expect(h.controller.refresh(target)).resolves.toBe('current');
    expect(h.events).toEqual(['push_token']);
  });

  it('refresh re-registers and reconfigures when FCM rotated the token', async () => {
    await h.controller.enable(target);
    h.events.length = 0;
    h.setToken('fcm-token-2');

    await expect(h.controller.refresh(target)).resolves.toBe('refreshed');
    expect(h.events).toEqual(['push_token', 'register', 'configure']);
    expect(h.registered.at(-1)?.request.token).toBe('fcm-token-2');
    expect(h.controller.registration(STATION)?.token).toBe('fcm-token-2');
  });

  it('refresh re-registers an unchanged token once the registration is a day old', async () => {
    await h.controller.enable(target);
    h.events.length = 0;
    h.advance(AGENT_ACTIVITY_REFRESH_AFTER_MS);

    await expect(h.controller.refresh(target)).resolves.toBe('refreshed');
    expect(h.events).toEqual(['push_token', 'register', 'configure']);
  });

  it('a new registration id from the Station replaces the old one on the phone after configuring it', async () => {
    await h.controller.enable(target);
    h.calls.length = 0;
    h.events.length = 0;
    h.advance(AGENT_ACTIVITY_REFRESH_AFTER_MS);
    const replaced = harnessResponse(h, 'reg_CCCCCCCCCCCCCCCCCCCC');

    await replaced.refresh(target);

    expect(h.events).toEqual(['push_token', 'register', 'configure', 'clear']);
    expect(h.calls.at(-1)).toEqual({
      command: 'plugin:station-agent-activity|clear',
      args: { registrationId: REGISTRATION_ID },
    });
  });
});

/** A second controller over the same phone and store whose Station now answers with a new id. */
function harnessResponse(
  h: ReturnType<typeof harness>,
  registrationId: string,
) {
  return createAgentActivityController({
    adapter: h.adapter,
    async register(request, apiBase) {
      h.events.push('register');
      h.registered.push({ request, apiBase });
      return {
        registrationId,
        stationId: STATION,
        stationKey: STATION_KEY,
        payloadKey: PAYLOAD_KEY,
      } as NativePushRegistrationResponse;
    },
    async unregister() {},
    store: h.store,
    requestNotificationPermission: async () => true,
    now: () => 1_000_000 + AGENT_ACTIVITY_REFRESH_AFTER_MS,
  });
}

describe('registration store', () => {
  it('keeps one registration per Station and ignores malformed entries', () => {
    const storage = new Map<string, string>();
    const store = localAgentActivityRegistrationStore({
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => void storage.set(key, value),
    });
    const record: AgentActivityRegistrationRecord = {
      registrationId: REGISTRATION_ID,
      stationId: 'a',
      stationKey: STATION_KEY,
      payloadKey: PAYLOAD_KEY,
      token: 't',
      packageName: 'io.kontourai.station',
      registeredAt: 1,
    };
    store.set('a', record);
    store.set('b', { ...record, stationId: 'b' });
    store.remove('a');
    expect(store.get('a')).toBeNull();
    expect(store.get('b')?.stationId).toBe('b');

    storage.set(
      'station-agent-activity-registrations-v1',
      JSON.stringify({ c: { ...record, payloadKey: undefined } }),
    );
    expect(store.get('c')).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { TauriNativePlatformAdapter } from '../tauri';
import type { NativeCapabilityState } from '../types';
import { WebNativePlatformAdapter } from '../web';
import { completeNativeCapabilityReport } from './completeNativeCapabilityReportFixture';

/**
 * The adapter is the only place the plugin's command names and argument
 * names are written down. They must match the Kotlin plugin exactly
 * (src-desktop/plugins/agent-activity: `@Command fun pushToken` is invoked as
 * `push_token`, `ConfigureArgs` fields are camelCase).
 */
function adapter(
  remotePush: NativeCapabilityState,
  reply: (command: string) => unknown = () => null,
) {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const instance = new TauriNativePlatformAdapter({
    async invoke<T>(command: string, args?: Record<string, unknown>) {
      if (command === 'native_capability_report') {
        return completeNativeCapabilityReport('android', {
          'remote-push': { state: remotePush, reason: 'from host' },
        }) as T;
      }
      calls.push({ command, args });
      const value = reply(command);
      if (value instanceof Error) throw value;
      return value as T;
    },
    listen: async () => () => {},
  });
  return { instance, calls };
}

const STATUS = {
  sdkInt: 36,
  packageName: 'io.kontourai.station',
  notificationsEnabled: true,
  liveUpdatesSupported: true,
  promotionAllowed: false,
  pushConfigured: true,
  configured: true,
};

describe('Tauri agent-activity adapter', () => {
  it('maps every command to the plugin command and argument names', async () => {
    const { instance, calls } = adapter('enabled', (command) => {
      if (command.endsWith('|status')) return STATUS;
      if (command.endsWith('|push_token'))
        return { state: 'available', token: 'tok' };
      if (command.endsWith('|open_live_update_settings'))
        return { opened: true };
      return null;
    });
    await instance.getCapabilityReport();

    await expect(instance.agentActivityStatus()).resolves.toEqual({
      status: 'ok',
      value: STATUS,
    });
    await expect(instance.agentActivityPushToken()).resolves.toEqual({
      status: 'ok',
      value: { state: 'available', token: 'tok' },
    });
    await expect(
      instance.configureAgentActivity({
        registrationId: 'r',
        stationId: 's',
        stationKey: 'k',
        payloadKey: 'p',
        ongoingEnabled: true,
      }),
    ).resolves.toEqual({ status: 'ok', value: undefined });
    await expect(instance.clearAgentActivity('r')).resolves.toEqual({
      status: 'ok',
      value: undefined,
    });
    await expect(instance.openLiveUpdateSettings()).resolves.toEqual({
      status: 'ok',
      value: { opened: true },
    });

    expect(calls).toEqual([
      { command: 'plugin:station-agent-activity|status', args: undefined },
      { command: 'plugin:station-agent-activity|push_token', args: undefined },
      {
        command: 'plugin:station-agent-activity|configure',
        args: {
          registrationId: 'r',
          stationId: 's',
          stationKey: 'k',
          payloadKey: 'p',
          ongoingEnabled: true,
        },
      },
      {
        command: 'plugin:station-agent-activity|clear',
        args: { registrationId: 'r' },
      },
      {
        command: 'plugin:station-agent-activity|open_live_update_settings',
        args: undefined,
      },
    ]);
  });

  it('reads an unconfigured push token as a state, not an error', async () => {
    const { instance } = adapter('enabled', () => ({ state: 'unconfigured' }));
    await instance.getCapabilityReport();
    await expect(instance.agentActivityPushToken()).resolves.toEqual({
      status: 'ok',
      value: { state: 'unconfigured' },
    });
  });

  it('keeps the plugin rejection text and refuses malformed answers', async () => {
    const { instance } = adapter('enabled', () => ({ sdkInt: 36 }));
    await instance.getCapabilityReport();
    // A plain-string rejection, as the Kotlin plugin's invoke.reject sends.
    const rejecting = adapter('enabled', () => {
      throw 'push token unavailable';
    });
    await rejecting.instance.getCapabilityReport();

    await expect(instance.agentActivityStatus()).resolves.toMatchObject({
      status: 'error',
      command: 'agent-activity-status',
    });
    await expect(rejecting.instance.agentActivityPushToken()).resolves.toEqual({
      status: 'error',
      command: 'agent-activity-push-token',
      message: 'push token unavailable',
    });
  });

  it('attempts nothing when the host does not report remote-push as enabled', async () => {
    const { instance, calls } = adapter('unsupported');
    await instance.getCapabilityReport();

    for (const result of await Promise.all([
      instance.agentActivityStatus(),
      instance.agentActivityPushToken(),
      instance.clearAgentActivity('r'),
      instance.openLiveUpdateSettings(),
    ])) {
      expect(result).toMatchObject({
        status: 'unsupported',
        reason: 'from host',
      });
    }
    expect(calls).toEqual([]);
  });
});

describe('web agent-activity adapter', () => {
  it('reports every agent-activity command as unsupported', async () => {
    const web = new WebNativePlatformAdapter();
    expect(web.capability('remote-push').state).toBe('unsupported');
    const results = await Promise.all([
      web.agentActivityStatus(),
      web.agentActivityPushToken(),
      web.configureAgentActivity(),
      web.clearAgentActivity(),
      web.openLiveUpdateSettings(),
      web.takeAgentActivityLaunchRoute(),
    ]);
    expect(
      results.map((result) => [
        result.status,
        result.status === 'ok' ? null : result.command,
      ]),
    ).toEqual([
      ['unsupported', 'agent-activity-status'],
      ['unsupported', 'agent-activity-push-token'],
      ['unsupported', 'configure-agent-activity'],
      ['unsupported', 'clear-agent-activity'],
      ['unsupported', 'open-live-update-settings'],
      ['unsupported', 'take-agent-activity-launch-route'],
    ]);
  });
});

describe('agent-activity launch routes (#2515)', () => {
  it('takes the route with take_launch_route and checks its shape', async () => {
    let reply: unknown = {
      route: {
        stationId: 'env-a',
        sessionId: 'thread-1',
        projectSlug: 'login-app',
      },
    };
    const { instance, calls } = adapter('enabled', () => reply);
    await instance.getCapabilityReport();
    await expect(instance.takeAgentActivityLaunchRoute()).resolves.toEqual({
      status: 'ok',
      value: {
        route: {
          stationId: 'env-a',
          sessionId: 'thread-1',
          projectSlug: 'login-app',
        },
      },
    });
    expect(calls).toEqual([
      {
        command: 'plugin:station-agent-activity|take_launch_route',
        args: undefined,
      },
    ]);
    reply = { route: null };
    await expect(instance.takeAgentActivityLaunchRoute()).resolves.toEqual({
      status: 'ok',
      value: { route: null },
    });
    for (const malformed of [
      null,
      'route',
      { route: 'thread-1' },
      { route: { stationId: 'env-a' } },
      { route: { stationId: 'env-a', sessionId: 7 } },
      { route: { stationId: 'env-a', sessionId: 's', projectSlug: 1 } },
    ]) {
      reply = malformed;
      await expect(instance.takeAgentActivityLaunchRoute()).resolves.toEqual(
        expect.objectContaining({
          status: 'error',
          command: 'take-agent-activity-launch-route',
        }),
      );
    }
  });

  it('listens for the plugin nudge only where remote-push is enabled', async () => {
    const registered: Array<{ plugin: string; event: string }> = [];
    let fire: (() => void) | undefined;
    let unregistered = 0;
    const make = (remotePush: NativeCapabilityState) =>
      new TauriNativePlatformAdapter({
        async invoke<T>(command: string) {
          return (
            command === 'native_capability_report'
              ? completeNativeCapabilityReport('android', {
                  'remote-push': { state: remotePush, reason: 'from host' },
                })
              : null
          ) as T;
        },
        listen: async () => () => {},
        async addPluginListener(plugin, event, handler) {
          registered.push({ plugin, event });
          fire = handler;
          return () => {
            unregistered += 1;
          };
        },
      });
    const off = make('unsupported');
    await off.getCapabilityReport();
    const offSubscription = off.subscribeToAgentActivityLaunchRoutes(() => {});
    await offSubscription.ready;
    offSubscription.dispose();
    expect(registered).toEqual([]);

    const on = make('enabled');
    await on.getCapabilityReport();
    let nudges = 0;
    const subscription = on.subscribeToAgentActivityLaunchRoutes(() => {
      nudges += 1;
    });
    await subscription.ready;
    expect(registered).toEqual([
      { plugin: 'station-agent-activity', event: 'launchRoute' },
    ]);
    fire?.();
    expect(nudges).toBe(1);
    subscription.dispose();
    expect(unregistered).toBe(1);
    fire?.();
    expect(nudges).toBe(1);
  });
});

describe('agent-activity launch routes on iOS', () => {
  it('never asks the iOS plugin for a launch route nor listens for one, though remote-push is enabled', async () => {
    const calls: string[] = [];
    const registered: string[] = [];
    const instance = new TauriNativePlatformAdapter({
      async invoke<T>(command: string) {
        if (command === 'native_capability_report')
          return completeNativeCapabilityReport('ios', {
            'remote-push': { state: 'enabled', reason: 'from host' },
          }) as T;
        calls.push(command);
        return { route: null } as T;
      },
      listen: async () => () => {},
      async addPluginListener(_plugin, event) {
        registered.push(event);
        return () => {};
      },
    });
    await instance.getCapabilityReport();

    await expect(instance.takeAgentActivityLaunchRoute()).resolves.toEqual(
      expect.objectContaining({
        status: 'unsupported',
        command: 'take-agent-activity-launch-route',
      }),
    );
    const subscription = instance.subscribeToAgentActivityLaunchRoutes(
      () => {},
    );
    await subscription.ready;
    subscription.dispose();
    expect(calls).toEqual([]);
    expect(registered).toEqual([]);
  });
});

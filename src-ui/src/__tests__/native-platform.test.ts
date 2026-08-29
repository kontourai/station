/**
 * @vitest-environment jsdom
 */

import { describe, expect, test, vi } from 'vitest';
import {
  createNativePlatformAdapter,
  createNativePlatformPromise,
} from '../platform/native';
import { MAX_NATIVE_SHARE_TEXT_BYTES } from '../platform/native/share';
import {
  type TauriEventBridge,
  type TauriEventHandler,
  TauriNativePlatformAdapter,
} from '../platform/native/tauri';
import type {
  NativeCapabilityId,
  NativeCapabilityState,
} from '../platform/native/types';
import {
  consumePwaShareUrl,
  WebNativePlatformAdapter,
} from '../platform/native/web';

/**
 * `parseCapabilityReport` demands an EXACT set match against its own
 * `CAPABILITY_IDS`, so a report missing one id is rejected wholesale. That
 * makes this fixture a second copy of the capability vocabulary — and when
 * #1655 added `local-browser-preview` it went stale silently, turning two
 * assertions about a VALID report into assertions that ran against an invalid
 * one and reddening `main` for every branch (archive#1667).
 *
 * Keying it by `NativeCapabilityId` makes the next addition a `npm run
 * typecheck` failure at the fixture instead of a runtime surprise in the gate:
 * a `Record` over a closed union is missing-key-checked.
 */
const CAPABILITY_FIXTURE: Record<
  NativeCapabilityId,
  { state: NativeCapabilityState; reason: string }
> = {
  'capability-report': {
    state: 'enabled',
    reason: 'Capability report is enabled.',
  },
  'desktop-tray': { state: 'enabled', reason: 'Desktop tray is enabled.' },
  'host-event-bridge': { state: 'enabled', reason: 'Host events are enabled.' },
  'local-browser-preview': {
    state: 'disabled',
    reason: 'Desktop browser preview is not configured.',
  },
  'workspace-pane-pop-out': {
    state: 'enabled',
    reason: 'Desktop pane pop-out is enabled.',
  },
  'pairing-deep-link': {
    state: 'enabled',
    reason: 'test pairing deep link',
  },
  'host-credential-broker': {
    state: 'enabled',
    reason: 'Host credential broker is enabled.',
  },
  'native-consent-broker': {
    state: 'enabled',
    reason: 'Native consent review is enabled.',
  },
  'remote-push': {
    state: 'unsupported',
    reason: 'Native push is not provisioned.',
  },
  haptics: {
    state: 'unsupported',
    reason: 'Haptics are mobile-only.',
  },
  'share-intake': {
    state: 'disabled',
    reason: 'Native shares are not configured.',
  },
};

function validCapabilityReport() {
  return {
    platform: 'linux',
    capabilities: Object.entries(CAPABILITY_FIXTURE).map(
      ([id, capability]) => ({ id, ...capability }),
    ),
  };
}

describe('native platform boundary', () => {
  test('selects the deterministic web fallback when Tauri is absent', async () => {
    await expect(
      createNativePlatformAdapter(() => false),
    ).resolves.toMatchObject({ platform: 'web' });
  });

  test('selects Tauri only through the factory detector', async () => {
    await expect(
      createNativePlatformAdapter(() => true),
    ).resolves.toMatchObject({ platform: 'tauri' });
  });

  test('defers the singleton host decision until document bootstrap completes', async () => {
    let ready: (() => void) | undefined;
    const create = vi.fn(async () => new TauriNativePlatformAdapter());
    const adapter = createNativePlatformPromise(create, {
      readyState: 'loading',
      addEventListener: (_type, listener) => {
        ready = listener as () => void;
      },
    });

    expect(create).not.toHaveBeenCalled();
    ready?.();
    await expect(adapter).resolves.toMatchObject({ platform: 'tauri' });
    expect(create).toHaveBeenCalledOnce();
  });

  test('reports web-native commands as typed unsupported results', async () => {
    await expect(
      new WebNativePlatformAdapter().getCapabilityReport(),
    ).resolves.toEqual({
      status: 'unsupported',
      command: 'capability-report',
      reason: expect.any(String),
    });
  });

  test('consumes PWA share URLs while preserving unrelated query state', () => {
    window.history.pushState(
      {},
      '',
      '/chat?share=hello%20Station&keep=yes#dock',
    );

    expect(consumePwaShareUrl(window.location)).toBe('hello Station');
    expect(
      `${window.location.pathname}${window.location.search}${window.location.hash}`,
    ).toBe('/chat?keep=yes#dock');
  });

  test('delivers PWA shares through the adapter event boundary', () => {
    window.history.pushState({}, '', '/chat?text=shared%20context');
    const received: string[] = [];

    new WebNativePlatformAdapter().subscribeToShare((event) => {
      received.push(`${event.source}:${event.text}`);
    });

    expect(received).toEqual(['pwa-share-target:shared context']);
  });

  test('returns typed command errors from the Tauri adapter', async () => {
    const adapter = new TauriNativePlatformAdapter({
      invoke: async () => {
        throw new Error('command denied');
      },
      listen: async () => () => undefined,
    });

    await expect(adapter.getCapabilityReport()).resolves.toEqual({
      status: 'error',
      command: 'capability-report',
      message: 'command denied',
    });
  });

  test('retains the native sidecar identity ticket and rejects a malformed generation', async () => {
    const status = {
      phase: 'running',
      attempt: 0,
      maxAttempts: 5,
      apiBase: 'http://127.0.0.1:43123',
      port: 43123,
      generation: 7,
      instanceId: 'desktop-sidecar-stable',
      bootId: 'boot-7',
      lastExitCode: null,
      nextRetryInMs: null,
      logPath: null,
      ownership: 'sidecar',
      canRunInBackground: true,
      failClosed: false,
      message: 'Station is running on this device.',
    };
    const adapter = new TauriNativePlatformAdapter({
      invoke: async <T>() => status as T,
      listen: async () => () => undefined,
    });
    await expect(adapter.getBundledServerStatus()).resolves.toEqual({
      status: 'ok',
      value: expect.objectContaining({
        generation: 7,
        instanceId: 'desktop-sidecar-stable',
        bootId: 'boot-7',
      }),
    });

    const malformed = new TauriNativePlatformAdapter({
      invoke: async <T>() => ({ ...status, generation: 7.5 }) as T,
      listen: async () => () => undefined,
    });
    await expect(malformed.getBundledServerStatus()).resolves.toEqual({
      status: 'error',
      command: 'bundled-server-status',
      message: 'The native host returned an invalid bundled-server status.',
    });
  });

  test('validates and adopts the native host capability report', async () => {
    const adapter = new TauriNativePlatformAdapter({
      invoke: async <T>() => validCapabilityReport() as T,
      listen: async () => () => undefined,
    });

    expect(adapter.capability('desktop-tray').state).toBe('disabled');
    await expect(adapter.getCapabilityReport()).resolves.toEqual({
      status: 'ok',
      // The host fixture omits `devBuild`; the adapter normalises that absence
      // to a release build rather than passing the gap through.
      value: { ...validCapabilityReport(), devBuild: false },
    });
    expect(adapter.capability('desktop-tray').state).toBe('enabled');
  });

  test('rejects malformed capability reports without changing state', async () => {
    const adapter = new TauriNativePlatformAdapter({
      invoke: async <T>() =>
        ({
          platform: 'linux',
          capabilities: [
            {
              id: 'desktop-tray',
              state: 'enabled',
              reason: 'Incomplete report.',
            },
          ],
        }) as T,
      listen: async () => () => undefined,
    });

    await expect(adapter.getCapabilityReport()).resolves.toEqual({
      status: 'error',
      command: 'capability-report',
      message: 'The native host returned an invalid capability report.',
    });
    expect(adapter.capability('desktop-tray').state).toBe('disabled');
  });

  test('subscribes to typed host shares and cleans up after asynchronous registration', async () => {
    let handler: ((event: { payload: unknown }) => void) | undefined;
    let unlistened = false;
    const adapter = new TauriNativePlatformAdapter({
      invoke: async <T>() => validCapabilityReport() as T,
      listen: async <_T>(
        _event: string,
        registeredHandler: (event: { payload: _T }) => void,
      ) => {
        handler = registeredHandler as (event: { payload: unknown }) => void;
        return () => {
          unlistened = true;
        };
      },
    });
    const received: string[] = [];
    const subscription = adapter.subscribeToShare((event) =>
      received.push(event.text),
    );

    await Promise.resolve();
    handler?.({ payload: { text: 'from native host' } });
    handler?.({ payload: { text: 42 } });
    subscription.dispose();

    expect(received).toEqual(['from native host']);
    expect(unlistened).toBe(true);
  });

  test('subscribes to only the three closed tray destinations and unlistens exactly once', async () => {
    let eventName = '';
    let handler: ((event: { payload: unknown }) => void) | undefined;
    const unlisten = vi.fn();
    const adapter = new TauriNativePlatformAdapter({
      invoke: async <T>() => validCapabilityReport() as T,
      listen: async <_T>(
        event: Parameters<TauriEventBridge['listen']>[0],
        next: TauriEventHandler<_T>,
      ) => {
        eventName = event;
        handler = next as unknown as TauriEventHandler<unknown>;
        return unlisten;
      },
    });
    const received: string[] = [];
    const subscription = adapter.subscribeToTrayNavigation((event) =>
      received.push(event.destination),
    );
    await Promise.resolve();
    handler?.({ payload: 'connections' });
    handler?.({ payload: 'pairedDevices' });
    handler?.({ payload: 'coreUpdates' });
    handler?.({ payload: '/settings' });
    subscription.dispose();
    subscription.dispose();
    expect(eventName).toBe('station://tray-navigation');
    expect(received).toEqual(['connections', 'pairedDevices', 'coreUpdates']);
    expect(unlisten).toHaveBeenCalledOnce();
  });

  test('contains rejected tray registration and keeps web tray subscription inert', async () => {
    const errors: string[] = [];
    new TauriNativePlatformAdapter({
      invoke: async <T>() => validCapabilityReport() as T,
      listen: async () => Promise.reject(new Error('denied')),
    }).subscribeToTrayNavigation(
      () => {
        throw new Error('must not fire');
      },
      (error) => errors.push(error.code),
    );
    await vi.waitFor(() =>
      expect(errors).toEqual(['listener-registration-failed']),
    );
    const web = new WebNativePlatformAdapter();
    const listener = vi.fn();
    web.subscribeToTrayNavigation(listener).dispose();
    expect(listener).not.toHaveBeenCalled();
  });

  test('disposes a tray listener that resolves after disposal', async () => {
    let resolve!: (value: () => void) => void;
    const listen = vi.fn(
      () =>
        new Promise<() => void>((next) => {
          resolve = next;
        }),
    );
    const unlisten = vi.fn();
    const adapter = new TauriNativePlatformAdapter({
      invoke: async <T>() => validCapabilityReport() as T,
      listen,
    });
    const subscription = adapter.subscribeToTrayNavigation(() => undefined);
    subscription.dispose();
    resolve(unlisten);
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledOnce());
  });

  test('contains a rejected host listener registration', async () => {
    const adapter = new TauriNativePlatformAdapter({
      invoke: async <T>() => validCapabilityReport() as T,
      listen: async () => Promise.reject(new Error('event permission denied')),
    });
    const errors: string[] = [];

    adapter.subscribeToShare(
      () => undefined,
      (error) => errors.push(`${error.code}:${error.message}`),
    );

    await expect
      .poll(() => errors)
      .toEqual([
        'listener-registration-failed:Station could not receive native share events: event permission denied',
      ]);
    expect(adapter.capability('host-event-bridge').state).toBe(
      'permission-required',
    );
  });

  test('delivers launch and active pairing links through the distinct native boundary', async () => {
    let activeHandler: ((urls: string[]) => void) | undefined;
    let unlistened = false;
    const adapter = new TauriNativePlatformAdapter(
      {
        invoke: async <T>() => validCapabilityReport() as T,
        listen: async () => () => undefined,
      },
      {
        getCurrent: async () => [
          'station-stable://pair?linkVersion=1&clientChannel=stable&payload=launch',
        ],
        onOpenUrl: async (handler) => {
          activeHandler = handler;
          return () => {
            unlistened = true;
          };
        },
      },
    );
    const received: string[] = [];
    const subscription = adapter.subscribeToPairingDeepLinks(({ url }) =>
      received.push(url),
    );

    await vi.waitFor(() =>
      expect(received).toContain(
        'station-stable://pair?linkVersion=1&clientChannel=stable&payload=launch',
      ),
    );
    activeHandler?.([
      'station-stable://pair?linkVersion=1&clientChannel=stable&payload=active',
    ]);
    subscription.dispose();

    expect(received).toEqual([
      'station-stable://pair?linkVersion=1&clientChannel=stable&payload=launch',
      'station-stable://pair?linkVersion=1&clientChannel=stable&payload=active',
    ]);
    expect(unlistened).toBe(true);
  });

  test('cleans up a registered deep-link listener when launch-link discovery fails', async () => {
    let unlistened = false;
    const errors: string[] = [];
    const adapter = new TauriNativePlatformAdapter(
      {
        invoke: async <T>() => validCapabilityReport() as T,
        listen: async () => () => undefined,
      },
      {
        getCurrent: async () => {
          throw new Error('launch link unavailable');
        },
        onOpenUrl: async () => () => {
          unlistened = true;
        },
      },
    );

    adapter.subscribeToPairingDeepLinks(
      () => undefined,
      (error) => errors.push(error.message),
    );

    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(unlistened).toBe(true);
  });

  test('ignores listener registration failures after disposal', async () => {
    let rejectRegistration: ((error: Error) => void) | undefined;
    const registration = new Promise<() => void>((_resolve, reject) => {
      rejectRegistration = reject;
    });
    const adapter = new TauriNativePlatformAdapter({
      invoke: async <T>() => validCapabilityReport() as T,
      listen: async () => registration,
    });
    const errors: string[] = [];

    const subscription = adapter.subscribeToShare(
      () => undefined,
      (error) => errors.push(error.code),
    );
    subscription.dispose();
    rejectRegistration?.(new Error('late event permission denial'));
    await Promise.resolve();
    await Promise.resolve();

    expect(errors).toEqual([]);
    expect(adapter.capability('host-event-bridge').state).toBe('enabled');
  });

  test('rejects oversized PWA and native share text before React state', async () => {
    const oversized = 'x'.repeat(MAX_NATIVE_SHARE_TEXT_BYTES + 1);
    const webErrors: string[] = [];
    window.history.pushState({}, '', `/chat?share=${oversized}`);
    new WebNativePlatformAdapter().subscribeToShare(
      () => {
        throw new Error('oversized PWA share should not be delivered');
      },
      (error) => webErrors.push(error.code),
    );

    let nativeHandler:
      | ((event: { payload: { text: string } }) => void)
      | undefined;
    const nativeErrors: string[] = [];
    const adapter = new TauriNativePlatformAdapter({
      invoke: async <T>() => validCapabilityReport() as T,
      listen: async <T>(
        _event: string,
        handler: (event: { payload: T }) => void,
      ) => {
        nativeHandler = handler as (event: {
          payload: { text: string };
        }) => void;
        return () => undefined;
      },
    });
    adapter.subscribeToShare(
      () => {
        throw new Error('oversized native share should not be delivered');
      },
      (error) => nativeErrors.push(error.code),
    );
    await Promise.resolve();
    nativeHandler?.({ payload: { text: oversized } });

    expect(webErrors).toEqual(['share-too-large']);
    expect(nativeErrors).toEqual(['share-too-large']);
  });

  test('reads and validates a full bundled-server status snapshot', async () => {
    // This is the exact camel-cased shape emitted by Rust's
    // `BundledServerStatus` writer (`#[serde(rename_all = "camelCase")]`),
    // including nullable fields serialized as `null` rather than omitted.
    const running = {
      phase: 'running',
      attempt: 0,
      maxAttempts: 5,
      apiBase: 'http://127.0.0.1:3142',
      port: 3142,
      lastExitCode: null,
      nextRetryInMs: null,
      logPath: '/home/user/.station/station-server.log',
      errorLogPath: null,
      desktopLogPath: null,
      ownership: 'sidecar',
      canRunInBackground: true,
      failClosed: false,
      message: 'Station is running.',
      detail: null,
    } as const;
    const adapter = new TauriNativePlatformAdapter({
      invoke: async <T>() => running as T,
      listen: async () => () => undefined,
    });
    await expect(adapter.getBundledServerStatus()).resolves.toEqual({
      status: 'ok',
      value: running,
    });
  });

  test('accepts nullable bundled-server fields and a present detail tail', async () => {
    const failed = {
      phase: 'failed',
      attempt: 5,
      maxAttempts: 5,
      apiBase: null,
      port: null,
      lastExitCode: 1,
      nextRetryInMs: null,
      logPath: '/log',
      ownership: 'none',
      canRunInBackground: false,
      failClosed: true,
      message: 'Station stopped.',
      detail: 'last stderr line',
    } as const;
    const adapter = new TauriNativePlatformAdapter({
      invoke: async <T>() => failed as T,
      listen: async () => () => undefined,
    });
    await expect(adapter.getBundledServerStatus()).resolves.toEqual({
      status: 'ok',
      value: {
        ...failed,
        errorLogPath: null,
        desktopLogPath: null,
      },
    });
  });

  test('accepts a null service log path when this platform writes no file (#1899)', async () => {
    const failedWithNoServiceLogFile = {
      phase: 'failed',
      attempt: 5,
      maxAttempts: 5,
      apiBase: null,
      port: null,
      lastExitCode: 1,
      nextRetryInMs: null,
      // A resolved status, but no file exists for this platform's service
      // manager (systemd/journald) — never a fabricated path.
      logPath: null,
      errorLogPath: null,
      desktopLogPath:
        '/home/user/.local/share/io.kontourai.station/logs/station.log',
      ownership: 'service',
      canRunInBackground: false,
      failClosed: false,
      message: 'Station stopped.',
    } as const;
    const adapter = new TauriNativePlatformAdapter({
      invoke: async <T>() => failedWithNoServiceLogFile as T,
      listen: async () => () => undefined,
    });
    await expect(adapter.getBundledServerStatus()).resolves.toEqual({
      status: 'ok',
      value: { ...failedWithNoServiceLogFile, detail: null },
    });
  });

  test('rejects malformed bundled-server status payloads', async () => {
    const cases: unknown[] = [
      null,
      42,
      { attempt: 0, maxAttempts: 5, logPath: '/l', message: 'm' }, // no phase
      {
        phase: 'bogus',
        attempt: 0,
        maxAttempts: 5,
        logPath: '/l',
        message: 'm',
        apiBase: null,
        port: null,
        lastExitCode: null,
        nextRetryInMs: null,
      },
      {
        phase: 'running',
        attempt: 1.5,
        maxAttempts: 5,
        logPath: '/l',
        message: 'm',
        apiBase: null,
        port: null,
        lastExitCode: null,
        nextRetryInMs: null,
      },
      {
        phase: 'running',
        attempt: 0,
        maxAttempts: 5,
        message: 'm',
        apiBase: null,
        port: null,
        lastExitCode: null,
        nextRetryInMs: null,
      }, // no logPath
      {
        phase: 'running',
        attempt: 0,
        maxAttempts: 5,
        logPath: '/l',
        message: 'm',
        apiBase: 7,
        port: null,
        lastExitCode: null,
        nextRetryInMs: null,
      }, // apiBase wrong type
      {
        phase: 'running',
        attempt: 0,
        maxAttempts: 5,
        logPath: '/l',
        message: 'm',
        apiBase: null,
        port: null,
        lastExitCode: null,
        nextRetryInMs: null,
        canRunInBackground: true,
        failClosed: false,
      }, // missing ownership is rejected, not coerced
      {
        phase: 'running',
        attempt: 0,
        maxAttempts: 5,
        logPath: '/l',
        message: 'm',
        apiBase: null,
        port: null,
        lastExitCode: null,
        nextRetryInMs: null,
        ownership: 'sidecar',
        failClosed: false,
      }, // missing canRunInBackground is rejected, not coerced
    ];
    for (const payload of cases) {
      const adapter = new TauriNativePlatformAdapter({
        invoke: async <T>() => payload as T,
        listen: async () => () => undefined,
      });
      await expect(adapter.getBundledServerStatus()).resolves.toEqual({
        status: 'error',
        command: 'bundled-server-status',
        message: 'The native host returned an invalid bundled-server status.',
      });
    }
  });

  test('surfaces bundled-server command failures as typed errors', async () => {
    const adapter = new TauriNativePlatformAdapter({
      invoke: async () => {
        throw new Error('supervisor unavailable');
      },
      listen: async () => () => undefined,
    });
    await expect(adapter.getBundledServerStatus()).resolves.toEqual({
      status: 'error',
      command: 'bundled-server-status',
      message: 'supervisor unavailable',
    });
    await expect(adapter.restartBundledServer()).resolves.toEqual({
      status: 'error',
      command: 'restart-bundled-server',
      message: 'supervisor unavailable',
    });
  });

  test('restarts the bundled server through the native host', async () => {
    const invoked: string[] = [];
    const adapter = new TauriNativePlatformAdapter({
      invoke: async <T>(command: string) => {
        invoked.push(command);
        return undefined as T;
      },
      listen: async () => () => undefined,
    });
    await expect(adapter.restartBundledServer()).resolves.toEqual({
      status: 'ok',
      value: undefined,
    });
    expect(invoked).toContain('restart_bundled_server');
  });

  test('delivers validated bundled-server status events and ignores noise', async () => {
    let handler: ((event: { payload: unknown }) => void) | undefined;
    let unlistened = false;
    const adapter = new TauriNativePlatformAdapter({
      invoke: async <T>() => validCapabilityReport() as T,
      listen: async <_T>(
        _event: string,
        registeredHandler: (event: { payload: _T }) => void,
      ) => {
        handler = registeredHandler as (event: { payload: unknown }) => void;
        return () => {
          unlistened = true;
        };
      },
    });
    const received: string[] = [];
    const subscription = adapter.subscribeToBundledServerStatus((status) =>
      received.push(status.phase),
    );

    await Promise.resolve();
    handler?.({
      payload: {
        phase: 'starting',
        attempt: 0,
        maxAttempts: 5,
        apiBase: null,
        port: null,
        lastExitCode: null,
        nextRetryInMs: null,
        logPath: '/log',
        ownership: 'sidecar',
        canRunInBackground: true,
        failClosed: false,
        message: 'Starting.',
      },
    });
    handler?.({ payload: { phase: 'not-a-phase' } });
    subscription.dispose();

    expect(received).toEqual(['starting']);
    expect(unlistened).toBe(true);
  });

  test('reports web bundled-server commands as typed unsupported results', async () => {
    const web = new WebNativePlatformAdapter();
    await expect(web.getBundledServerStatus()).resolves.toEqual({
      status: 'unsupported',
      command: 'bundled-server-status',
      reason: expect.any(String),
    });
    await expect(web.restartBundledServer()).resolves.toEqual({
      status: 'unsupported',
      command: 'restart-bundled-server',
      reason: expect.any(String),
    });
    expect(() =>
      web.subscribeToBundledServerStatus(() => undefined).dispose(),
    ).not.toThrow();
  });

  test('measures the shared text limit in UTF-8 bytes', async () => {
    const oversized = '€'.repeat(
      Math.floor(MAX_NATIVE_SHARE_TEXT_BYTES / 3) + 1,
    );
    let nativeHandler:
      | ((event: { payload: { text: string } }) => void)
      | undefined;
    const errors: string[] = [];
    const adapter = new TauriNativePlatformAdapter({
      invoke: async <T>() => validCapabilityReport() as T,
      listen: async <T>(
        _event: string,
        handler: (event: { payload: T }) => void,
      ) => {
        nativeHandler = handler as (event: {
          payload: { text: string };
        }) => void;
        return () => undefined;
      },
    });
    adapter.subscribeToShare(
      () => {
        throw new Error('oversized multibyte share should not be delivered');
      },
      (error) => errors.push(error.code),
    );
    await Promise.resolve();
    nativeHandler?.({ payload: { text: oversized } });

    expect(errors).toEqual(['share-too-large']);
  });
});

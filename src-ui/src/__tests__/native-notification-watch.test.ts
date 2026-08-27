import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Delivery lives in the host, not the web layer. The SSE stream this app uses
 * is suspended along with the webview when Station is backgrounded and its
 * events are not replayed on reconnect, so a notification raised while the
 * user was elsewhere was lost rather than delivered late — confirmed on
 * device. These tests hold the contract that keeps that from regressing: the
 * web layer hands the host a connection and stops being involved.
 */

const invoke = vi.fn();
const isPermissionGranted = vi.fn();
const requestPermission = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

vi.mock('@tauri-apps/plugin-notification', () => ({
  sendNotification: vi.fn(),
  requestPermission: () => requestPermission(),
  isPermissionGranted: () => isPermissionGranted(),
}));

beforeEach(() => {
  vi.resetModules();
  invoke.mockReset().mockResolvedValue(undefined);
  isPermissionGranted.mockReset().mockResolvedValue(true);
  requestPermission.mockReset().mockResolvedValue('granted');
});

async function load() {
  return import('../platform/native/notify');
}

describe('native notification watch', () => {
  it('hands the host the connection to poll', async () => {
    const { watchNotificationsNatively } = await load();
    await watchNotificationsNatively({
      endpoint: 'http://station.local:3141',
      credential: 'secret',
    });
    // The host is handed a finished URL — route and live-status filter come
    // from the SDK, so Rust holds no copy of Station's API vocabulary.
    expect(invoke).toHaveBeenCalledWith('notification_watch_start', {
      url: 'http://station.local:3141/notifications?status=pending&status=delivered',
      credential: 'secret',
    });
  });

  it('does not start a watch when permission was refused', async () => {
    // Polling that can never post anything is battery spend for nothing.
    isPermissionGranted.mockResolvedValue(false);
    requestPermission.mockResolvedValue('denied');
    const { watchNotificationsNatively } = await load();
    await watchNotificationsNatively({ endpoint: 'http://x', credential: 'y' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('survives a host that has no such command', async () => {
    // An older shell paired with a newer web bundle. The in-app toast still
    // lands; only the OS notification is lost.
    invoke.mockRejectedValue(new Error('unknown command'));
    const { watchNotificationsNatively } = await load();
    await expect(
      watchNotificationsNatively({ endpoint: 'http://x', credential: 'y' }),
    ).resolves.toBeUndefined();
  });

  it('stops the watch when the connection goes away', async () => {
    const { watchNotificationsNatively, stopWatchingNotificationsNatively } =
      await load();
    await watchNotificationsNatively({ endpoint: 'http://x', credential: 'y' });
    invoke.mockClear();
    await stopWatchingNotificationsNatively();
    expect(invoke.mock.calls[0]?.[0]).toBe('notification_watch_stop');
  });

  it('is not started by the app: the watch is dormant (#917)', async () => {
    // Three blockers stand between this and working on Android — the cached-app
    // freezer, tauri#11609/#15671 blocking the foreground service that would
    // fix it, and native Rust being unable to resolve DNS there at all. Calling
    // it today fails every poll. If a call site reappears while those blockers
    // stand, this fails and asks why rather than shipping a silent error on
    // launch.
    //
    // The guard's condition is the blockers, NOT the state of any issue. It
    // previously read "before #943 closes"; #943 was then closed by a backlog
    // sweep with no code change (#3088), which turned that wording into an
    // invitation to delete a guard whose reason for existing had not changed.
    // Retire this only when the blockers are gone — #917 is the delivery
    // dependency decision that would clear the path.
    const sources = import.meta.glob('../**/*.{ts,tsx}', {
      eager: true,
      query: '?raw',
      import: 'default',
    }) as Record<string, string>;
    const callers = Object.entries(sources)
      .filter(([path]) => !path.includes('__tests__'))
      .filter(([path]) => !path.includes('platform/native/notify'))
      .filter(([, code]) => /\bwatchNotificationsNatively\s*\(/.test(code))
      .map(([path]) => path);
    expect(callers).toEqual([]);
  });

  it('does not ask the host to stop a watch it never started', async () => {
    const { stopWatchingNotificationsNatively } = await load();
    await stopWatchingNotificationsNatively();
    expect(invoke).not.toHaveBeenCalled();
  });
});

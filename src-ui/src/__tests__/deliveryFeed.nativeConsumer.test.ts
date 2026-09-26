/**
 * @vitest-environment jsdom
 *
 * #2608: on a desktop host that consumes the delivery feed natively, the
 * webview is not a second consumer. These tests drive `pollDeliveryFeed`
 * through its DEFAULT dependencies — the real command names, the real
 * localStorage cursor — with only the Tauri bridge, the fetch and the OS
 * notifier replaced.
 */

import type { SurfaceDeliveryFeed } from '@kontourai/station-contracts/notification-preferences';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const notifyNatively = vi.fn(async (_input: unknown) => true);
vi.mock('../platform/native/notify', () => ({
  notifyNatively: (input: unknown) => notifyNatively(input),
}));
const authenticatedFetch = vi.fn();
vi.mock('@kontourai/station-sdk', () => ({
  authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
}));
const INSTALLATION = '6f1c2d3e-aaaa-4bbb-8ccc-111122223333';
vi.mock('../platform/native/installationId', () => ({
  desktopInstallationId: async () => INSTALLATION,
}));
const host = {
  /**
   * What `notification_feed_native_consumer` answers: a boolean, `'missing'`
   * (Tauri's own rejection for an unregistered command) or `'ipc-error'`
   * (any other failure).
   */
  consumer: 'missing' as boolean | 'missing' | 'ipc-error',
  adopt: true,
};
const invokeTauri = vi.fn(
  async (command: string, _args?: Record<string, unknown>) => {
    if (command === 'notification_feed_native_consumer') {
      if (host.consumer === 'missing')
        // What tauri 2 rejects with (`webview/mod.rs`, run_invoke_handler).
        throw 'Command notification_feed_native_consumer not found';
      if (host.consumer === 'ipc-error') throw new Error('IPC channel closed');
      return host.consumer;
    }
    if (command === 'notification_feed_adopt_cursor') return host.adopt;
    throw new Error(`unexpected command ${command}`);
  },
);
vi.mock('../platform/native/tauriInvoke', () => ({
  invokeTauri: (command: string, args?: Record<string, unknown>) =>
    invokeTauri(command, args),
}));

import {
  pollDeliveryFeed,
  resetDeliveryFeedState,
} from '../platform/native/deliveryFeed';

const API = 'http://127.0.0.1:4100';
const SCOPE = `${API}\nconn-a`;
const STORAGE_KEY = `station.notificationDeliveryCursor:${SCOPE}`;
const SURFACE = `local:desktop-${INSTALLATION}`;

function answer(data: SurfaceDeliveryFeed) {
  return { ok: true, status: 200, json: async () => ({ success: true, data }) };
}
function feed(cursor: number, ids: string[]): SurfaceDeliveryFeed {
  return {
    surface: SURFACE as SurfaceDeliveryFeed['surface'],
    cursor,
    epoch: 'run-1',
    leaseMs: 90_000,
    entries: ids.map((id, index) => ({
      seq: cursor - ids.length + index + 1,
      kind: 'alert' as const,
      notificationId: id,
      title: `Alert ${id}`,
      urgency: 'done' as const,
      link: '/',
      at: '2026-09-24T00:00:00.000Z',
    })),
  };
}

describe('the webview defers to a native feed consumer (#2608)', () => {
  beforeEach(() => {
    resetDeliveryFeedState();
    localStorage.clear();
    notifyNatively.mockClear();
    authenticatedFetch.mockReset();
    invokeTauri.mockClear();
    host.consumer = 'missing';
    host.adopt = true;
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    // A Tauri webview: the bridge exists, so the host must be asked.
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  });
  afterEach(() => {
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  test('never reads or posts while the host consumes the feed', async () => {
    host.consumer = true;
    authenticatedFetch.mockResolvedValue(answer(feed(3, ['a', 'b', 'c'])));
    for (let poll = 0; poll < 3; poll += 1)
      expect(await pollDeliveryFeed(API, SCOPE)).toBe(0);
    expect(authenticatedFetch).not.toHaveBeenCalled();
    expect(notifyNatively).not.toHaveBeenCalled();
    // Asked once per document: the answer cannot change under it.
    expect(
      invokeTauri.mock.calls.filter(
        ([command]) => command === 'notification_feed_native_consumer',
      ),
    ).toHaveLength(1);
  });

  test('stays the consumer, and posts, on a host without the command', async () => {
    host.consumer = 'missing';
    authenticatedFetch
      .mockResolvedValueOnce(answer(feed(1, [])))
      .mockResolvedValueOnce(answer(feed(2, ['n-1'])));
    await pollDeliveryFeed(API, SCOPE);
    expect(await pollDeliveryFeed(API, SCOPE)).toBe(1);
    expect(notifyNatively).toHaveBeenCalledWith({ title: 'Alert n-1' });
  });

  test('stays the consumer when the host says it does not consume', async () => {
    host.consumer = false;
    authenticatedFetch
      .mockResolvedValueOnce(answer(feed(1, [])))
      .mockResolvedValueOnce(answer(feed(2, ['n-1'])));
    await pollDeliveryFeed(API, SCOPE);
    expect(await pollDeliveryFeed(API, SCOPE)).toBe(1);
  });

  test('an IPC failure reads and posts nothing, and the host is asked again', async () => {
    host.consumer = 'ipc-error';
    authenticatedFetch.mockResolvedValue(answer(feed(2, ['n-1', 'n-2'])));
    expect(await pollDeliveryFeed(API, SCOPE)).toBe(0);
    expect(await pollDeliveryFeed(API, SCOPE)).toBe(0);
    expect(authenticatedFetch).not.toHaveBeenCalled();
    expect(notifyNatively).not.toHaveBeenCalled();
    const asked = () =>
      invokeTauri.mock.calls.filter(
        ([command]) => command === 'notification_feed_native_consumer',
      ).length;
    // Not cached: a failure is not an answer.
    expect(asked()).toBe(2);
    // The host recovers and says it consumes: still nothing posted here.
    host.consumer = true;
    await pollDeliveryFeed(API, SCOPE);
    await pollDeliveryFeed(API, SCOPE);
    expect(asked()).toBe(3);
    expect(notifyNatively).not.toHaveBeenCalled();
  });

  test('without a Tauri bridge it stays the consumer without asking', async () => {
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    authenticatedFetch
      .mockResolvedValueOnce(answer(feed(1, [])))
      .mockResolvedValueOnce(answer(feed(2, ['n-1'])));
    await pollDeliveryFeed(API, SCOPE);
    expect(await pollDeliveryFeed(API, SCOPE)).toBe(1);
    expect(invokeTauri).not.toHaveBeenCalled();
  });

  test('hands its stored cursor to the host once, then forgets it', async () => {
    // An older build's webview posted through seq 2 and kept this cursor.
    const stored = { surface: SURFACE, cursor: 2, epoch: 'run-1' };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    host.consumer = true;
    await pollDeliveryFeed(API, SCOPE);
    await pollDeliveryFeed(API, SCOPE);
    const offers = invokeTauri.mock.calls.filter(
      ([command]) => command === 'notification_feed_adopt_cursor',
    );
    // Exactly the position the webview reached: the host resumes after it
    // (entries 3.. alert once there) and nothing up to it alerts again.
    expect(offers).toEqual([
      ['notification_feed_adopt_cursor', { origin: API, cursor: stored }],
    ]);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(authenticatedFetch).not.toHaveBeenCalled();
    expect(notifyNatively).not.toHaveBeenCalled();
  });

  test('keeps its cursor when the host does not take it', async () => {
    const stored = { surface: SURFACE, cursor: 2, epoch: 'run-1' };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    host.consumer = true;
    host.adopt = false;
    await pollDeliveryFeed(API, SCOPE);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify(stored));
    expect(notifyNatively).not.toHaveBeenCalled();
  });
});

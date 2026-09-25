/**
 * @vitest-environment jsdom
 */

import type {
  SurfaceDeliveryEntry,
  SurfaceDeliveryFeed,
} from '@kontourai/station-contracts/notification-preferences';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const notifyNatively = vi.fn(async (_input: unknown) => true);
vi.mock('../platform/native/notify', () => ({
  notifyNatively: (input: unknown) => notifyNatively(input),
}));
const authenticatedFetch = vi.fn();
vi.mock('@kontourai/station-sdk', () => ({
  authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
}));
vi.mock('../platform/native/installationId', () => ({
  desktopInstallationId: async () => '6f1c2d3e-aaaa-4bbb-8ccc-111122223333',
}));

import {
  type DeliveryFeedDeps,
  pollDeliveryFeed,
  resetDeliveryFeedState,
  type StoredCursor,
} from '../platform/native/deliveryFeed';

const A = 'http://127.0.0.1:4100';
const SCOPE = `${A}\nconn-a`;
const SURFACE = 'local:desktop-6f1c2d3e-aaaa-4bbb-8ccc-111122223333';

function alert(seq: number, id: string, title = `Alert ${id}`) {
  return {
    seq,
    kind: 'alert',
    notificationId: id,
    title,
    body: `Body ${id}`,
    urgency: 'done',
    link: '/',
    at: '2026-09-24T00:00:00.000Z',
  } as SurfaceDeliveryEntry;
}

function retract(seq: number, id: string) {
  return {
    seq,
    kind: 'retract',
    notificationId: id,
    at: '2026-09-24T00:00:00.000Z',
  } as SurfaceDeliveryEntry;
}

/** A scripted feed: each read returns the next answer. */
function deps(
  answers: Array<SurfaceDeliveryFeed | undefined | 'wrong-surface'>,
  focused = false,
  storage = new Map<string, StoredCursor>(),
) {
  const reads: Array<{ surface?: string; after: number; epoch?: string }> = [];
  const notify = vi.fn(
    async (_input: { title: string; body?: string }) => true,
  );
  const d: DeliveryFeedDeps = {
    installationId: async () => '6f1c2d3e-aaaa-4bbb-8ccc-111122223333',
    readFeed: async (surface, after, epoch) => {
      reads.push({
        ...(surface ? { surface } : {}),
        after,
        ...(epoch ? { epoch } : {}),
      });
      const answer = answers.shift();
      if (answer === 'wrong-surface') return { kind: 'wrong-surface' };
      return answer ? { kind: 'feed', feed: answer } : { kind: 'failed' };
    },
    isWindowFocused: () => focused,
    notify,
    loadCursor: (key) => storage.get(key),
    saveCursor: (key, value) => void storage.set(key, value),
  };
  return { d, reads, notify, storage };
}

function feed(
  cursor: number,
  entries: SurfaceDeliveryEntry[] = [],
  epoch = 'run-1',
) {
  return { cursor, entries, epoch, leaseMs: 90_000 };
}

describe('pollDeliveryFeed (#2587 on #2586’s desktop host feed)', () => {
  beforeEach(() => {
    resetDeliveryFeedState();
    localStorage.clear();
    notifyNatively.mockClear();
    authenticatedFetch.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  test('posts the router’s decided alert verbatim while the window is unfocused', async () => {
    const { d, reads, notify } = deps([
      feed(4),
      feed(5, [alert(5, 'n-1', 'Station')]),
    ]);
    expect(await pollDeliveryFeed(A, SCOPE, d)).toBe(0);
    expect(await pollDeliveryFeed(A, SCOPE, d)).toBe(1);
    expect(reads).toEqual([
      { surface: SURFACE, after: 0 },
      { surface: SURFACE, after: 4, epoch: 'run-1' },
    ]);
    // Title/body are taken as-is: the server already redacted per hideContent.
    expect(notify).toHaveBeenCalledWith({ title: 'Station', body: 'Body n-1' });
  });

  test('a focused window consumes the entry without an OS alert', async () => {
    const { d, notify, reads } = deps(
      [feed(0), feed(1, [alert(1, 'n-1')]), feed(1)],
      true,
    );
    await pollDeliveryFeed(A, SCOPE, d);
    expect(await pollDeliveryFeed(A, SCOPE, d)).toBe(0);
    await pollDeliveryFeed(A, SCOPE, d);
    expect(notify).not.toHaveBeenCalled();
    expect(reads.at(-1)?.after).toBe(1);
  });

  test('seeds on the first read of a connection instead of replaying the queue', async () => {
    const { d, notify } = deps([
      feed(3, [alert(2, 'old-1'), alert(3, 'old-2')]),
    ]);
    expect(await pollDeliveryFeed(A, SCOPE, d)).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });

  test('an alert retracted in the same read is not posted', async () => {
    const { d, notify } = deps([
      feed(0),
      feed(3, [alert(1, 'n-1'), retract(2, 'n-1'), alert(3, 'n-2')]),
    ]);
    await pollDeliveryFeed(A, SCOPE, d);
    expect(await pollDeliveryFeed(A, SCOPE, d)).toBe(1);
    expect(notify).toHaveBeenCalledWith({
      title: 'Alert n-2',
      body: 'Body n-2',
    });
  });

  test('a failed feed read posts nothing and keeps the cursor', async () => {
    const { d, notify, reads } = deps([
      feed(2),
      undefined,
      feed(3, [alert(3, 'n-1')]),
    ]);
    await pollDeliveryFeed(A, SCOPE, d);
    expect(await pollDeliveryFeed(A, SCOPE, d)).toBe(0);
    expect(notify).not.toHaveBeenCalled();
    await pollDeliveryFeed(A, SCOPE, d);
    expect(reads.map((read) => read.after)).toEqual([0, 2, 2]);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  test('a restarted server (new epoch) answers from its start, and those entries post', async () => {
    const { d, notify, reads } = deps([
      feed(40),
      feed(2, [alert(1, 'n-1'), alert(2, 'n-2')], 'run-2'),
      feed(2, [], 'run-2'),
    ]);
    await pollDeliveryFeed(A, SCOPE, d);
    expect(await pollDeliveryFeed(A, SCOPE, d)).toBe(2);
    await pollDeliveryFeed(A, SCOPE, d);
    expect(reads.slice(1)).toEqual([
      { surface: SURFACE, after: 40, epoch: 'run-1' },
      { surface: SURFACE, after: 2, epoch: 'run-2' },
    ]);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  test('a reload resumes from the stored cursor and posts what queued in between', async () => {
    const storage = new Map<string, StoredCursor>();
    const first = deps([feed(4)], false, storage);
    await pollDeliveryFeed(A, SCOPE, first.d);

    resetDeliveryFeedState(); // a reload: module state gone, storage kept
    const second = deps(
      [feed(6, [alert(5, 'n-1'), alert(6, 'n-2')])],
      false,
      storage,
    );
    expect(await pollDeliveryFeed(A, SCOPE, second.d)).toBe(2);
    expect(second.reads).toEqual([
      { surface: SURFACE, after: 4, epoch: 'run-1' },
    ]);
    expect(storage.get(`${SCOPE}\n${SURFACE}`)).toEqual({
      cursor: 6,
      epoch: 'run-1',
    });
  });

  test('a reload after a server restart posts the new run’s feed from its start', async () => {
    const storage = new Map<string, StoredCursor>([
      [`${SCOPE}\n${SURFACE}`, { cursor: 40, epoch: 'run-1' }],
    ]);
    const { d, reads, notify } = deps(
      [feed(1, [alert(1, 'n-1')], 'run-2')],
      false,
      storage,
    );
    expect(await pollDeliveryFeed(A, SCOPE, d)).toBe(1);
    expect(reads).toEqual([{ surface: SURFACE, after: 40, epoch: 'run-1' }]);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  test('stored cursors are per connection: another connection still seeds', async () => {
    const storage = new Map<string, StoredCursor>([
      [`${SCOPE}\n${SURFACE}`, { cursor: 4, epoch: 'run-1' }],
    ]);
    const { d, notify } = deps(
      [feed(9, [alert(8, 'b-1'), alert(9, 'b-2')])],
      false,
      storage,
    );
    expect(await pollDeliveryFeed(A, `${A}\nconn-b`, d)).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });

  test('default wiring persists the cursor in localStorage across a reload', async () => {
    localStorage.clear();
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    authenticatedFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: feed(3) }),
    });
    await pollDeliveryFeed(A, SCOPE);
    resetDeliveryFeedState();
    authenticatedFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: feed(4, [alert(4, 'n-1')]) }),
    });
    expect(await pollDeliveryFeed(A, SCOPE)).toBe(1);
    expect(authenticatedFetch).toHaveBeenLastCalledWith(
      `${A}/api/notifications/deliveries?after=3&epoch=run-1&surface=${encodeURIComponent(SURFACE)}`,
    );
  });

  test('a new connection scope reseeds', async () => {
    const { d, notify } = deps([
      feed(1),
      feed(9, [alert(8, 'b-1'), alert(9, 'b-2')]),
    ]);
    await pollDeliveryFeed(A, SCOPE, d);
    expect(await pollDeliveryFeed(A, `${A}\nconn-b`, d)).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });

  test('a remote Station: the device reads its own surface, no surface named', async () => {
    const REMOTE = 'https://station.example.test';
    const scope = `${REMOTE}\nconn-r`;
    const { d, reads, notify, storage } = deps([
      feed(2),
      feed(3, [alert(3, 'n-1')]),
    ]);
    await pollDeliveryFeed(REMOTE, scope, d);
    expect(await pollDeliveryFeed(REMOTE, scope, d)).toBe(1);
    expect(reads).toEqual([{ after: 0 }, { after: 2, epoch: 'run-1' }]);
    expect(notify).toHaveBeenCalledWith({
      title: 'Alert n-1',
      body: 'Body n-1',
    });
    expect([...storage.keys()]).toEqual([`${scope}\nown`]);
  });

  test('a surface refusal switches form once and the working form is remembered', async () => {
    // Loopback guesses the desktop host surface; this Station answers as a
    // paired device (surface_not_yours), so the device form is used.
    const { d, reads } = deps(['wrong-surface', feed(5), feed(5)]);
    await pollDeliveryFeed(A, SCOPE, d);
    await pollDeliveryFeed(A, SCOPE, d);
    expect(reads).toEqual([
      { surface: SURFACE, after: 0 },
      { after: 0 },
      { after: 5, epoch: 'run-1' },
    ]);
  });

  test('a remote Station that wants a named surface gets the desktop host one', async () => {
    const REMOTE = 'https://station.example.test';
    const { d, reads } = deps(['wrong-surface', feed(1)]);
    await pollDeliveryFeed(REMOTE, `${REMOTE}\nconn-r`, d);
    expect(reads).toEqual([{ after: 0 }, { surface: SURFACE, after: 0 }]);
  });

  test('default wiring: a remote device read names no surface', async () => {
    const REMOTE = 'https://station.example.test';
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    authenticatedFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: feed(1) }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: feed(2, [alert(2, 'n-1')]) }),
      });
    await pollDeliveryFeed(REMOTE, `${REMOTE}\nconn-r`);
    expect(await pollDeliveryFeed(REMOTE, `${REMOTE}\nconn-r`)).toBe(1);
    expect(authenticatedFetch).toHaveBeenLastCalledWith(
      `${REMOTE}/api/notifications/deliveries?after=1&epoch=run-1`,
    );
  });

  test('default wiring maps a surface_not_yours refusal to the device form', async () => {
    authenticatedFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: async () => ({ success: false, error: 'surface_not_yours' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: feed(1) }),
      });
    await pollDeliveryFeed(A, SCOPE);
    expect(authenticatedFetch).toHaveBeenLastCalledWith(
      `${A}/api/notifications/deliveries?after=0`,
    );
  });

  test('default wiring: a refused or failed feed posts nothing', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    for (const status of [403, 404, 503]) {
      resetDeliveryFeedState();
      authenticatedFetch.mockResolvedValue({
        ok: false,
        status,
        json: async () => ({ success: false }),
      });
      await pollDeliveryFeed(A, SCOPE);
      await pollDeliveryFeed(A, SCOPE);
    }
    expect(notifyNatively).not.toHaveBeenCalled();
  });

  test('default wiring reads the feed for this installation’s surface', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    authenticatedFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: feed(7) }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: feed(8, [alert(8, 'n-1')]) }),
      });
    await pollDeliveryFeed(A, SCOPE);
    expect(await pollDeliveryFeed(A, SCOPE)).toBe(1);
    expect(authenticatedFetch).toHaveBeenLastCalledWith(
      `${A}/api/notifications/deliveries?after=7&epoch=run-1&surface=${encodeURIComponent(SURFACE)}`,
    );
    expect(notifyNatively).toHaveBeenCalledWith({
      title: 'Alert n-1',
      body: 'Body n-1',
    });
  });
});

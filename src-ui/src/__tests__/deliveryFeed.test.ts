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
  answers: Array<SurfaceDeliveryFeed | undefined>,
  focused = false,
) {
  const reads: Array<{ surface: string; after: number }> = [];
  const notify = vi.fn(
    async (_input: { title: string; body?: string }) => true,
  );
  const d: DeliveryFeedDeps = {
    installationId: async () => '6f1c2d3e-aaaa-4bbb-8ccc-111122223333',
    readFeed: async (surface, after) => {
      reads.push({ surface, after });
      return answers.shift();
    },
    isWindowFocused: () => focused,
    notify,
  };
  return { d, reads, notify };
}

function feed(cursor: number, entries: SurfaceDeliveryEntry[] = []) {
  return { cursor, entries, leaseMs: 90_000 };
}

describe('pollDeliveryFeed (#2587 on #2586’s desktop host feed)', () => {
  beforeEach(() => {
    resetDeliveryFeedState();
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
      { surface: SURFACE, after: 4 },
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

  test('a restarted server’s lower cursor is re-read from zero', async () => {
    const { d, notify, reads } = deps([
      feed(40),
      feed(2),
      feed(2, [alert(1, 'n-1'), alert(2, 'n-2')]),
    ]);
    await pollDeliveryFeed(A, SCOPE, d);
    await pollDeliveryFeed(A, SCOPE, d);
    expect(await pollDeliveryFeed(A, SCOPE, d)).toBe(2);
    expect(reads.map((read) => read.after)).toEqual([0, 40, 0]);
    expect(notify).toHaveBeenCalledTimes(2);
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
      `${A}/api/notifications/deliveries?surface=${encodeURIComponent(SURFACE)}&after=7`,
    );
    expect(notifyNatively).toHaveBeenCalledWith({
      title: 'Alert n-1',
      body: 'Body n-1',
    });
  });
});

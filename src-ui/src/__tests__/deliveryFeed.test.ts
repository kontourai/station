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
const INSTALLATION = '6f1c2d3e-aaaa-4bbb-8ccc-111122223333';
const installation = { current: INSTALLATION as string | undefined };
vi.mock('../platform/native/installationId', () => ({
  desktopInstallationId: async () => installation.current,
}));

import {
  type DeliveryFeedDeps,
  FEED_READ_DEADLINE_MS,
  FEED_REQUEST_TIMEOUT_MS,
  pollDeliveryFeed,
  resetDeliveryFeedState,
  type StoredCursor,
} from '../platform/native/deliveryFeed';

const A = 'http://127.0.0.1:4100';
const SCOPE = `${A}\nconn-a`;
const LOCAL = `local:desktop-${INSTALLATION}`;

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

function feed(
  cursor: number,
  entries: SurfaceDeliveryEntry[] = [],
  epoch = 'run-1',
  surface = LOCAL,
): SurfaceDeliveryFeed {
  return {
    surface: surface as SurfaceDeliveryFeed['surface'],
    cursor,
    entries,
    epoch,
    leaseMs: 90_000,
  };
}

/** A scripted feed: each read returns the next answer. */
function deps(
  answers: Array<SurfaceDeliveryFeed | undefined>,
  focused = false,
  storage = new Map<string, StoredCursor>(),
) {
  const reads: Array<{ after: number; epoch?: string }> = [];
  const notify = vi.fn(
    async (_input: { title: string; body?: string }) => true,
  );
  const d: DeliveryFeedDeps = {
    installationId: async () => INSTALLATION,
    readFeed: async ({ after, epoch }) => {
      reads.push({ after, ...(epoch ? { epoch } : {}) });
      return answers.shift();
    },
    isWindowFocused: () => focused,
    notify,
    loadCursor: (key) => storage.get(key),
    saveCursor: (key, value) => void storage.set(key, value),
  };
  return { d, reads, notify, storage };
}

function ok(data: SurfaceDeliveryFeed) {
  return { ok: true, status: 200, json: async () => ({ success: true, data }) };
}

describe('pollDeliveryFeed (#2587 on #2586’s delivery feed)', () => {
  beforeEach(() => {
    resetDeliveryFeedState();
    localStorage.clear();
    installation.current = INSTALLATION;
    notifyNatively.mockClear();
    authenticatedFetch.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('posts the router’s decided alert verbatim while the window is unfocused', async () => {
    const { d, reads, notify } = deps([
      feed(4),
      feed(5, [alert(5, 'n-1', 'Station')]),
    ]);
    expect(await pollDeliveryFeed(A, SCOPE, d)).toBe(0);
    expect(await pollDeliveryFeed(A, SCOPE, d)).toBe(1);
    expect(reads).toEqual([{ after: 0 }, { after: 4, epoch: 'run-1' }]);
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

  test('overlapping polls join one read: the entry posts once', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { d, notify, reads } = deps([
      feed(0),
      feed(1, [alert(1, 'n-1')]),
      feed(1, [alert(1, 'n-1')]),
    ]);
    // The posted-alerts line is off here, so a missing join shows up as a
    // second OS notification rather than being absorbed by it.
    d.postedAlerts = { has: () => false, add: () => {} };
    await pollDeliveryFeed(A, SCOPE, d);
    const slowRead = d.readFeed;
    d.readFeed = async (input) => {
      await gate;
      return slowRead(input);
    };
    const first = pollDeliveryFeed(A, SCOPE, d);
    const second = pollDeliveryFeed(A, SCOPE, d);
    release();
    expect(await Promise.all([first, second])).toEqual([1, 1]);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(reads).toHaveLength(2);
  });

  test('an identical alert re-delivered under a new seq is not posted again', async () => {
    const { d, notify } = deps([
      feed(0),
      feed(1, [alert(1, 'n-1')]),
      feed(2, [alert(2, 'n-1')]),
    ]);
    await pollDeliveryFeed(A, SCOPE, d);
    expect(await pollDeliveryFeed(A, SCOPE, d)).toBe(1);
    expect(await pollDeliveryFeed(A, SCOPE, d)).toBe(0);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  test('a content update under the same notification id alerts again', async () => {
    // The router re-delivers a dedupe update only when content changed:
    // an agent's progress card turning into "needs input" must interrupt.
    const needsInput = {
      ...alert(2, 'n-1', 'Needs input'),
      urgency: 'attention',
    } as SurfaceDeliveryEntry;
    const { d, notify } = deps([
      feed(0),
      feed(1, [alert(1, 'n-1', 'Working')]),
      feed(2, [needsInput]),
    ]);
    await pollDeliveryFeed(A, SCOPE, d);
    await pollDeliveryFeed(A, SCOPE, d);
    expect(await pollDeliveryFeed(A, SCOPE, d)).toBe(1);
    expect(notify.mock.calls.map(([input]) => input.title)).toEqual([
      'Working',
      'Needs input',
    ]);
  });

  test('a read that never settles is abandoned at the deadline; the next poll reads afresh', async () => {
    vi.useFakeTimers();
    const { d, reads, notify } = deps([feed(0)]);
    await pollDeliveryFeed(A, SCOPE, d);
    const answer = d.readFeed;
    let hung = true;
    let releaseHung: (value: SurfaceDeliveryFeed) => void = () => {};
    d.readFeed = (input) => {
      if (!hung) return answer(input);
      hung = false;
      reads.push({ after: input.after });
      return new Promise((resolve) => {
        releaseHung = resolve;
      });
    };
    const stuck = pollDeliveryFeed(A, SCOPE, d);
    // Before the deadline a second poll still joins the hung read.
    await vi.advanceTimersByTimeAsync(FEED_READ_DEADLINE_MS - 1);
    void pollDeliveryFeed(A, SCOPE, d);
    expect(reads).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(await stuck).toBe(0);

    // The next poll issues a new read.
    const fresh = feed(1, [alert(1, 'n-1')]);
    // (queue the answer for the fresh read)
    d.readFeed = async (input) => {
      reads.push({ after: input.after });
      return fresh;
    };
    expect(await pollDeliveryFeed(A, SCOPE, d)).toBe(1);
    expect(reads).toHaveLength(3);
    // The abandoned read settling late applies nothing.
    releaseHung(feed(9, [alert(9, 'late')]));
    await vi.advanceTimersByTimeAsync(0);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(await pollDeliveryFeed(A, SCOPE, d)).toBe(0);
    expect(reads.at(-1)?.after).toBe(1);
  });

  test('a poll for another connection does not join the old read, and the old read posts nothing', async () => {
    const storage = new Map<string, StoredCursor>([
      [SCOPE, { surface: LOCAL, cursor: 0, epoch: 'run-1' }],
      [`${A}\nconn-b`, { surface: LOCAL, cursor: 0, epoch: 'run-1' }],
    ]);
    let releaseOld: (value: SurfaceDeliveryFeed) => void = () => {};
    const reads: string[] = [];
    const notify = vi.fn(async (_input: unknown) => true);
    const d: DeliveryFeedDeps = {
      installationId: async () => INSTALLATION,
      readFeed: (input) => {
        reads.push(input.epoch ?? '');
        return reads.length === 1
          ? new Promise((resolve) => {
              releaseOld = resolve;
            })
          : Promise.resolve(feed(3, [alert(3, 'b-1')]));
      },
      isWindowFocused: () => false,
      notify,
      loadCursor: (key) => storage.get(key),
      saveCursor: (key, value) => void storage.set(key, value),
    };
    const old = pollDeliveryFeed(A, SCOPE, d);
    await Promise.resolve();
    await Promise.resolve();
    expect(await pollDeliveryFeed(A, `${A}\nconn-b`, d)).toBe(1);
    expect(reads).toHaveLength(2);
    releaseOld(feed(2, [alert(2, 'a-1')]));
    expect(await old).toBe(0);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({
      title: 'Alert b-1',
      body: 'Body b-1',
    });
    expect(storage.get(SCOPE)?.cursor).toBe(0);
  });

  test('an old read that lands before the new connection’s read starts applies nothing', async () => {
    // The switch is recorded when the new poll is made, not when its read
    // gets as far as loading state: the old answer arriving in between must
    // not move the old cursor or post the old connection's alerts.
    const storage = new Map<string, StoredCursor>([
      [SCOPE, { surface: LOCAL, cursor: 0, epoch: 'run-1' }],
    ]);
    let releaseOld: (value: SurfaceDeliveryFeed) => void = () => {};
    let releaseId: (value: string) => void = () => {};
    let calls = 0;
    const notify = vi.fn(async (_input: unknown) => true);
    const d: DeliveryFeedDeps = {
      installationId: () => {
        calls += 1;
        return calls === 1
          ? Promise.resolve(INSTALLATION)
          : new Promise((resolve) => {
              releaseId = resolve;
            });
      },
      readFeed: () =>
        new Promise((resolve) => {
          releaseOld = resolve;
        }),
      isWindowFocused: () => false,
      notify,
      loadCursor: (key) => storage.get(key),
      saveCursor: (key, value) => void storage.set(key, value),
    };
    const old = pollDeliveryFeed(A, SCOPE, d);
    await Promise.resolve();
    await Promise.resolve();
    void pollDeliveryFeed(A, `${A}\nconn-b`, d);
    releaseOld(feed(2, [alert(2, 'a-1')]));
    expect(await old).toBe(0);
    expect(notify).not.toHaveBeenCalled();
    expect(storage.get(SCOPE)?.cursor).toBe(0);
    releaseId(INSTALLATION);
  });

  test('an urgency-only change under the same id alerts again', async () => {
    const { d, notify } = deps([
      feed(0),
      feed(1, [alert(1, 'n-1')]),
      feed(2, [
        { ...alert(2, 'n-1'), urgency: 'attention' } as SurfaceDeliveryEntry,
      ]),
    ]);
    await pollDeliveryFeed(A, SCOPE, d);
    await pollDeliveryFeed(A, SCOPE, d);
    expect(await pollDeliveryFeed(A, SCOPE, d)).toBe(1);
    expect(notify).toHaveBeenCalledTimes(2);
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
      { after: 40, epoch: 'run-1' },
      { after: 2, epoch: 'run-2' },
    ]);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  test('a reload resumes from the stored cursor and posts what queued in between', async () => {
    const storage = new Map<string, StoredCursor>();
    await pollDeliveryFeed(A, SCOPE, deps([feed(4)], false, storage).d);
    expect(storage.get(SCOPE)).toEqual({
      surface: LOCAL,
      cursor: 4,
      epoch: 'run-1',
    });

    resetDeliveryFeedState(); // a reload: module state gone, storage kept
    const second = deps(
      [feed(6, [alert(5, 'n-1'), alert(6, 'n-2')])],
      false,
      storage,
    );
    expect(await pollDeliveryFeed(A, SCOPE, second.d)).toBe(2);
    expect(second.reads).toEqual([{ after: 4, epoch: 'run-1' }]);
  });

  test('a reload after a server restart posts the new run’s feed from its start', async () => {
    const storage = new Map<string, StoredCursor>([
      [SCOPE, { surface: LOCAL, cursor: 40, epoch: 'run-1' }],
    ]);
    const { d, reads, notify } = deps(
      [feed(1, [alert(1, 'n-1')], 'run-2')],
      false,
      storage,
    );
    expect(await pollDeliveryFeed(A, SCOPE, d)).toBe(1);
    expect(reads).toEqual([{ after: 40, epoch: 'run-1' }]);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  test('a stored cursor for a different surface is not used: the read seeds', async () => {
    // The echoed surface is the key: a cursor stored when this connection
    // read as another surface says nothing about this one.
    const storage = new Map<string, StoredCursor>([
      [SCOPE, { surface: 'device:old', cursor: 4, epoch: 'run-1' }],
    ]);
    const { d, notify } = deps(
      [
        feed(9, [alert(8, 'n-1'), alert(9, 'n-2')]),
        feed(10, [alert(10, 'n-3')]),
      ],
      false,
      storage,
    );
    expect(await pollDeliveryFeed(A, SCOPE, d)).toBe(0);
    expect(storage.get(SCOPE)?.surface).toBe(LOCAL);
    expect(await pollDeliveryFeed(A, SCOPE, d)).toBe(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  test('stored cursors are per connection: another connection still seeds', async () => {
    const storage = new Map<string, StoredCursor>([
      [SCOPE, { surface: LOCAL, cursor: 4, epoch: 'run-1' }],
    ]);
    const { d, notify } = deps(
      [feed(9, [alert(8, 'b-1'), alert(9, 'b-2')])],
      false,
      storage,
    );
    expect(await pollDeliveryFeed(A, `${A}\nconn-b`, d)).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });

  test('default wiring: names no surface and sends the installation header', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    authenticatedFetch
      .mockResolvedValueOnce(ok(feed(7)))
      .mockResolvedValueOnce(ok(feed(8, [alert(8, 'n-1')])));
    await pollDeliveryFeed(A, SCOPE);
    expect(await pollDeliveryFeed(A, SCOPE)).toBe(1);
    expect(authenticatedFetch).toHaveBeenLastCalledWith(
      `${A}/api/notifications/deliveries?after=7&epoch=run-1`,
      {
        timeoutMs: FEED_REQUEST_TIMEOUT_MS,
        headers: { 'X-Station-Desktop-Installation': INSTALLATION },
      },
    );
    expect(notifyNatively).toHaveBeenCalledWith({
      title: 'Alert n-1',
      body: 'Body n-1',
    });
  });

  test('default wiring: a remote device’s echoed surface keys its resume', async () => {
    const REMOTE = 'https://station.example.test';
    const scope = `${REMOTE}\nconn-r`;
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    authenticatedFetch.mockResolvedValueOnce(
      ok(feed(2, [], 'run-9', 'device:dev-1')),
    );
    await pollDeliveryFeed(REMOTE, scope);
    resetDeliveryFeedState();
    authenticatedFetch.mockResolvedValueOnce(
      ok(feed(3, [alert(3, 'n-1')], 'run-9', 'device:dev-1')),
    );
    expect(await pollDeliveryFeed(REMOTE, scope)).toBe(1);
    expect(authenticatedFetch).toHaveBeenLastCalledWith(
      `${REMOTE}/api/notifications/deliveries?after=2&epoch=run-9`,
      {
        timeoutMs: FEED_REQUEST_TIMEOUT_MS,
        headers: { 'X-Station-Desktop-Installation': INSTALLATION },
      },
    );
  });

  test('default wiring: without an installation id no header is sent', async () => {
    installation.current = undefined;
    authenticatedFetch.mockResolvedValueOnce(ok(feed(1)));
    await pollDeliveryFeed(A, SCOPE);
    expect(authenticatedFetch).toHaveBeenLastCalledWith(
      `${A}/api/notifications/deliveries?after=0`,
      { timeoutMs: FEED_REQUEST_TIMEOUT_MS },
    );
  });

  test('default wiring: a refused, failed or surface-less feed posts nothing', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    for (const answer of [
      {
        ok: false,
        status: 400,
        json: async () => ({ error: 'installation_required' }),
      },
      {
        ok: false,
        status: 403,
        json: async () => ({ error: 'device_not_eligible' }),
      },
      { ok: false, status: 404, json: async () => ({}) },
      { ok: false, status: 503, json: async () => ({}) },
      {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: {
            entries: [alert(1, 'n-1')],
            cursor: 1,
            epoch: 'e',
            leaseMs: 1,
          },
        }),
      },
    ]) {
      resetDeliveryFeedState();
      localStorage.clear();
      authenticatedFetch.mockResolvedValue(answer);
      await pollDeliveryFeed(A, SCOPE);
      await pollDeliveryFeed(A, SCOPE);
    }
    expect(notifyNatively).not.toHaveBeenCalled();
  });
});

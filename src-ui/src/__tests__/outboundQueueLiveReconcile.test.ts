// @vitest-environment jsdom
/**
 * A live send recorded `invoking` before its request, then the app is
 * killed: a FRESH module instance (a new renderer, new boot id) reads the
 * same durable rows and settles them by Station's delivery lookup. The
 * storage fake is shared across instances like IndexedDB is across launches;
 * Web Locks are stubbed so the first renderer reads as gone.
 */
import type { TurnDeliveryOutcome } from '@kontourai/station-contracts/orchestration';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  OutboundDispatchTurn,
  OutboundQueueStorage,
} from '../lib/outboundQueue';

type QueueModule = typeof import('../lib/outboundQueue');

let value: unknown;
/** Other keys of the same IndexedDB store (the retired-key list). */
const otherKeys = new Map<string, unknown>();
const QUEUE_KEY = 'station-outbound-queue-v1';
const storage: OutboundQueueStorage = {
  getItem: async (key) => (key === QUEUE_KEY ? value : otherKeys.get(key)),
  setItem: async (key, next) => {
    if (key === QUEUE_KEY) value = next;
    else otherKeys.set(key, next);
  },
  updateItem: async (key, updater) => {
    if (key === QUEUE_KEY) value = updater(value);
    else otherKeys.set(key, updater(otherKeys.get(key)));
  },
};
/** Renderer locks currently held, by name. */
const heldLocks = new Set<string>();

function stubLocks() {
  vi.stubGlobal('navigator', {
    ...navigator,
    locks: {
      request: async (
        name: string,
        optionsOrCallback: unknown,
        maybeCallback?: () => Promise<unknown>,
      ) => {
        const callback = (
          typeof optionsOrCallback === 'function'
            ? optionsOrCallback
            : maybeCallback
        ) as () => Promise<unknown>;
        if (name.startsWith('station-outbound-renderer:')) heldLocks.add(name);
        return callback();
      },
      query: async () => ({
        held: [...heldLocks].map((name) => ({ name })),
      }),
    },
  });
}

async function freshRenderer(): Promise<QueueModule> {
  vi.resetModules();
  const queue = await import('../lib/outboundQueue');
  queue._setOutboundQueueStorage(storage, {
    get: async () => otherKeys.get('station-outbound-retired-v1'),
    set: async (next) => {
      otherKeys.set('station-outbound-retired-v1', next);
    },
  });
  return queue;
}

/** The app was killed: every renderer lock it held is released. */
function kill() {
  heldLocks.clear();
}

const intent = {
  clientTurnId: 'key-live-1',
  sessionId: 'chat-1',
  conversationId: 'chat-1',
  agentSlug: 'codex',
  projectSlug: 'station',
  content: 'Please do not lose me',
};

function lookupAnswering(outcome: TurnDeliveryOutcome) {
  return vi.fn(async (turn: Readonly<OutboundDispatchTurn>) =>
    outcome === 'started'
      ? {
          outcome,
          conversationId: turn.conversationId!,
          clientTurnId: turn.clientTurnId,
          sessionId: 'chat-1',
          turnId: 'provider-turn-1',
        }
      : {
          outcome,
          conversationId: turn.conversationId!,
          clientTurnId: turn.clientTurnId,
        },
  );
}

describe('live outbox rows survive a killed app and settle by the delivery lookup', () => {
  beforeEach(() => {
    value = undefined;
    otherKeys.clear();
    heldLocks.clear();
    localStorage.clear();
    stubLocks();
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function killedMidSend() {
    const first = await freshRenderer();
    await first.outboundDispatch.beginLive(intent);
    const [row] = await first.outboundDispatch.snapshot();
    expect(row).toMatchObject({
      clientTurnId: 'key-live-1',
      status: 'invoking',
      origin: 'live',
    });
    // The renderer that is sending lists it as its own bubble, not a row.
    expect(row?.liveInFlight).toBe(true);
    kill();
    return freshRenderer();
  }

  it('not-received: replays with the identical key, exactly once', async () => {
    const second = await killedMidSend();
    const lookup = lookupAnswering('not-received');
    expect(await second.outboundDispatch.reconcile(lookup)).toEqual({
      received: 0,
    });
    expect(lookup).toHaveBeenCalledTimes(1);
    const [row] = await second.outboundDispatch.snapshot();
    expect(row).toMatchObject({
      clientTurnId: 'key-live-1',
      status: 'pending',
    });
    expect(row?.liveInFlight).toBeUndefined();
    const transport = vi.fn(async (turn: Readonly<OutboundDispatchTurn>) => ({
      kind: 'accepted' as const,
      providerTurnId: `turn-for-${turn.clientTurnId}`,
    }));
    await second.outboundDispatch.flush(transport);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]?.[0]).toMatchObject({
      clientTurnId: 'key-live-1',
      content: 'Please do not lose me',
      projectSlug: 'station',
    });
  });

  it('an unanswered request fences a late live-claim cleanup before releasing it for lookup', async () => {
    const queue = await freshRenderer();
    const late = await queue.outboundDispatch.beginLive(intent);
    await queue.outboundDispatch.recordUnanswered(
      intent,
      new TypeError('response lost'),
    );
    // The caller's bounded beginLive wait expired. Its cleanup arrives after
    // the catch has recorded the unanswered request and must not erase it.
    await late.refused();
    expect(await queue.outboundDispatch.snapshot()).toEqual([
      expect.objectContaining({
        clientTurnId: intent.clientTurnId,
        status: 'invoking',
        awaitingLookup: true,
      }),
    ]);
    const send = vi.fn();
    await queue.outboundDispatch.flush(send);
    expect(send).not.toHaveBeenCalled();
    await queue.outboundDispatch.reconcile(lookupAnswering('started'));
    expect(await queue.outboundDispatch.snapshot()).toEqual([]);
  });

  it('started: delivered, never sent again', async () => {
    const second = await killedMidSend();
    await second.outboundDispatch.reconcile(lookupAnswering('started'));
    expect(await second.outboundDispatch.snapshot()).toEqual([]);
    const transport = vi.fn();
    await second.outboundDispatch.flush(transport);
    expect(transport).not.toHaveBeenCalled();
  });

  it('received: left alone and reported, so the caller asks again later', async () => {
    const second = await killedMidSend();
    expect(
      await second.outboundDispatch.reconcile(lookupAnswering('received')),
    ).toEqual({ received: 1 });
    const [row] = await second.outboundDispatch.snapshot();
    expect(row).toMatchObject({
      status: 'invoking',
      deliveryCheck: { outcome: 'received' },
    });
    const transport = vi.fn();
    await second.outboundDispatch.flush(transport);
    expect(transport).not.toHaveBeenCalled();
  });

  it.each(['indeterminate', 'expired', 'unknown'] as const)(
    '%s: kept as possible-effect evidence, never resent',
    async (outcome) => {
      const second = await killedMidSend();
      await second.outboundDispatch.reconcile(lookupAnswering(outcome));
      const [row] = await second.outboundDispatch.snapshot();
      expect(row).toMatchObject({ status: 'may-have-started' });
      const transport = vi.fn();
      await second.outboundDispatch.flush(transport);
      expect(transport).not.toHaveBeenCalled();
      // A check that finds Station never had it stops; it does not resend.
      expect(
        await second.outboundDispatch.check(
          'key-live-1',
          lookupAnswering('not-received'),
        ),
      ).toBe('not-received');
      expect((await second.outboundDispatch.snapshot())[0]).toMatchObject({
        status: 'failed',
      });
      await second.outboundDispatch.flush(transport);
      expect(transport).not.toHaveBeenCalled();
    },
  );

  it('does not ask about a row whose renderer is still alive', async () => {
    const first = await freshRenderer();
    await first.outboundDispatch.beginLive(intent);
    const second = await freshRenderer();
    const lookup = lookupAnswering('not-received');
    expect(await second.outboundDispatch.reconcile(lookup)).toEqual({
      received: 0,
    });
    expect(lookup).not.toHaveBeenCalled();
    expect((await second.outboundDispatch.snapshot())[0]).toMatchObject({
      status: 'invoking',
    });
  });

  it("lists another window's claimed send as under way only while that window runs", async () => {
    const first = await freshRenderer();
    await first.outboundDispatch.beginLive(intent);
    const second = await freshRenderer();
    // The sending window is running: its send is under way there.
    expect((await second.outboundDispatch.open())[0]).toMatchObject({
      status: 'invoking',
      sendUnderWay: true,
    });
    // A window whose liveness cannot be read is not called running.
    const withLocks = navigator;
    vi.stubGlobal('navigator', { ...navigator, locks: undefined });
    const [unknown] = await second.outboundDispatch.open();
    expect(unknown).toMatchObject({ status: 'invoking' });
    expect(unknown?.sendUnderWay).toBeUndefined();
    vi.stubGlobal('navigator', withLocks);
    expect((await second.outboundDispatch.open())[0]?.sendUnderWay).toBe(true);
    // It closed or crashed: the same claim is no longer a send under way.
    kill();
    const [orphaned] = await second.outboundDispatch.open();
    expect(orphaned).toMatchObject({ status: 'invoking' });
    expect(orphaned?.sendUnderWay).toBeUndefined();
  });

  it("a closed window's claim can be withdrawn like an unanswered send; a running or unknown one cannot", async () => {
    const first = await freshRenderer();
    await first.outboundDispatch.beginLive(intent);
    const ownerLock = [...heldLocks];
    const second = await freshRenderer();
    // Running: under way, not withdrawable.
    expect((await second.outboundDispatch.open())[0]?.awaitingLookup).toBe(
      undefined,
    );
    await expect(
      second.outboundDispatch.dismissUnconfirmed('key-live-1'),
    ).rejects.toThrow(/Only a message that may have reached the agent/);
    // Unknown (no Web Locks): never counted as gone.
    const withLocks = navigator;
    vi.stubGlobal('navigator', { ...navigator, locks: undefined });
    expect((await second.outboundDispatch.open())[0]?.awaitingLookup).toBe(
      undefined,
    );
    await expect(
      second.outboundDispatch.dismissUnconfirmed('key-live-1'),
    ).rejects.toThrow(/Only a message that may have reached the agent/);
    vi.stubGlobal('navigator', withLocks);
    // Proven gone: listed like an unanswered send, and withdrawable.
    kill();
    expect((await second.outboundDispatch.open())[0]).toMatchObject({
      status: 'invoking',
      awaitingLookup: true,
    });
    // ...but the write rechecks: an owner seen gone, then running again
    // before the dismissal, keeps its message.
    for (const name of ownerLock) heldLocks.add(name);
    await expect(
      second.outboundDispatch.dismissUnconfirmed('key-live-1'),
    ).rejects.toThrow(/Only a message that may have reached the agent/);
    expect(await second.outboundDispatch.snapshot()).toHaveLength(1);
    kill();
    await second.outboundDispatch.dismissUnconfirmed('key-live-1');
    expect(await second.outboundDispatch.snapshot()).toEqual([]);
    expect((await second.outboundDispatch.retiredKeys()).discarded).toContain(
      'key-live-1',
    );
  });

  it("this window's own claim reads as under way only while one of its flush passes holds it", async () => {
    const queue = await freshRenderer();
    const { rendererBootId } = await import('../lib/outboundQueueLease');
    const now = Date.now();
    // A claim of this renderer's whose write-back never landed.
    value = [
      {
        ...intent,
        clientTurnId: 'stuck-own-claim',
        createdAt: now,
        attempts: 1,
        status: 'invoking',
        dispatchBootId: rendererBootId,
        claimedAt: now,
      },
    ];
    const [stuck] = await queue.outboundDispatch.open();
    expect(stuck).toMatchObject({ status: 'invoking' });
    expect(stuck?.sendUnderWay).toBeUndefined();
    // A pass of this window's flush in its transport call: under way.
    value = [{ ...intent, createdAt: now, attempts: 0, status: 'pending' }];
    let release!: () => void;
    let entered!: () => void;
    const inTransport = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const flushing = queue.outboundDispatch.flush(async () => {
      entered();
      await new Promise<void>((done) => {
        release = done;
      });
      return { kind: 'accepted' as const, providerTurnId: 'turn-1' };
    });
    await inTransport;
    expect((await queue.outboundDispatch.open())[0]).toMatchObject({
      clientTurnId: 'key-live-1',
      status: 'invoking',
      sendUnderWay: true,
    });
    release();
    await flushing;
    // Settled: no longer this window's send under way.
    expect((await queue.outboundDispatch.open())[0]?.sendUnderWay).toBe(
      undefined,
    );
  });

  it('a window whose lock request failed reads as unknown, never as gone, so its send is not offered for discard', async () => {
    const working = navigator;
    const request = navigator.locks.request.bind(navigator.locks) as (
      ...args: unknown[]
    ) => Promise<unknown>;
    // This renderer cannot take its lock; it still sends.
    vi.stubGlobal('navigator', {
      ...working,
      locks: {
        ...working.locks,
        request: async (name: string, ...rest: unknown[]) => {
          if (name.startsWith('station-outbound-renderer:'))
            throw new DOMException('lock unavailable', 'AbortError');
          return request(name, ...rest);
        },
      },
    });
    const first = await freshRenderer();
    await first.outboundDispatch.beginLive(intent);
    vi.stubGlobal('navigator', working);
    const second = await freshRenderer();
    const [row] = await second.outboundDispatch.open();
    expect(row).toMatchObject({ status: 'invoking' });
    expect(row?.awaitingLookup).toBeUndefined();
    expect(row?.sendUnderWay).toBeUndefined();
    await expect(
      second.outboundDispatch.dismissUnconfirmed('key-live-1'),
    ).rejects.toThrow(/Only a message that may have reached the agent/);
  });

  it('a failed lookup changes nothing', async () => {
    const second = await killedMidSend();
    await second.outboundDispatch.reconcile(
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    expect((await second.outboundDispatch.snapshot())[0]).toMatchObject({
      status: 'invoking',
    });
  });

  it('an answer about a different key is not believed', async () => {
    const second = await killedMidSend();
    await second.outboundDispatch.reconcile(
      vi.fn(async () => ({
        outcome: 'not-received' as const,
        conversationId: 'chat-1',
        clientTurnId: 'key-live-10',
      })),
    );
    expect((await second.outboundDispatch.snapshot())[0]).toMatchObject({
      status: 'invoking',
    });
  });

  it('live transitions: accepted and refused let the row go; no answer keeps it pending for the same key', async () => {
    const queue = await freshRenderer();
    const accepted = await queue.outboundDispatch.beginLive(intent);
    await accepted.accepted();
    expect(await queue.outboundDispatch.snapshot()).toEqual([]);
    const refused = await queue.outboundDispatch.beginLive({
      ...intent,
      clientTurnId: 'key-refused',
    });
    await refused.refused();
    expect(await queue.outboundDispatch.snapshot()).toEqual([]);
    const lost = await queue.outboundDispatch.beginLive({
      ...intent,
      clientTurnId: 'key-lost',
    });
    await lost.undeliverable(new TypeError('Failed to fetch'));
    const [row] = await queue.outboundDispatch.snapshot();
    expect(row).toMatchObject({ clientTurnId: 'key-lost', status: 'pending' });
    expect(row?.liveInFlight).toBeUndefined();
  });

  it('a held follow-up is never sent automatically: once its window is gone it is listed, and Send sends it once with its key', async () => {
    const first = await freshRenderer();
    await first.outboundDispatch.syncHeld([
      { ...intent, clientTurnId: 'held-1', content: 'after this turn' },
    ]);
    const transport = vi.fn(async (turn: Readonly<OutboundDispatchTurn>) => ({
      kind: 'accepted' as const,
      providerTurnId: `turn-for-${turn.clientTurnId}`,
    }));
    await first.outboundDispatch.flush(transport);
    expect(transport).not.toHaveBeenCalled();
    // This window's queue shows it; its copy is not listed here.
    expect((await first.outboundDispatch.snapshot())[0]?.heldHere).toBe(true);
    // Removing it from the chat's queue removes its durable copy.
    await first.outboundDispatch.syncHeld([]);
    expect(await first.outboundDispatch.snapshot()).toEqual([]);
    await first.outboundDispatch.syncHeld([
      { ...intent, clientTurnId: 'held-2', content: 'still waiting' },
    ]);
    kill();
    const second = await freshRenderer();
    // No timer or lookup sends it: it is listed for the user, unchanged.
    await second.outboundDispatch.reconcile(lookupAnswering('not-received'));
    vi.setSystemTime(Date.now() + 24 * 60 * 60_000);
    await second.outboundDispatch.reconcile(lookupAnswering('not-received'));
    await second.outboundDispatch.flush(transport);
    expect(transport).not.toHaveBeenCalled();
    const [listed] = await second.outboundDispatch.snapshot();
    expect(listed).toMatchObject({
      clientTurnId: 'held-2',
      content: 'still waiting',
    });
    expect(listed?.heldHere).toBeUndefined();
    await second.outboundDispatch.sendHeld('held-2');
    await second.outboundDispatch.flush(transport);
    await second.outboundDispatch.flush(transport);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]?.[0]).toMatchObject({
      clientTurnId: 'held-2',
      content: 'still waiting',
    });
  });

  it('a row written for one Station is never sent to, or settled by, another', async () => {
    const queue = await freshRenderer();
    const stationA = { apiBase: 'http://a.test', environmentId: 'env-a' };
    const stationB = { apiBase: 'http://b.test', environmentId: 'env-b' };
    await queue.outboundDispatch.beginLive({
      ...intent,
      clientTurnId: 'for-a',
      station: stationA,
    });
    kill();
    const later = await freshRenderer();
    const lookup = lookupAnswering('not-received');
    await later.outboundDispatch.reconcile(lookup, { station: stationB });
    expect(lookup).not.toHaveBeenCalled();
    await later.outboundDispatch.reconcile(lookup, { station: stationA });
    expect(lookup).toHaveBeenCalledTimes(1);
    const transport = vi.fn(async () => ({
      kind: 'accepted' as const,
      providerTurnId: 'p',
    }));
    await later.outboundDispatch.flush(transport, { station: stationB });
    expect(transport).not.toHaveBeenCalled();
    // Same address, a different Station behind it: still not sent.
    await later.outboundDispatch.flush(transport, {
      station: { apiBase: 'http://a.test', environmentId: 'env-other' },
    });
    expect(transport).not.toHaveBeenCalled();
    await later.outboundDispatch.flush(transport, { station: stationA });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('an unconfirmed row does not hold back the messages written after it', async () => {
    const queue = await freshRenderer();
    const live = await queue.outboundDispatch.beginLive({
      ...intent,
      clientTurnId: 'unconfirmed-1',
    });
    await live.indeterminate('Station could not confirm the start.');
    await queue.outboundDispatch.enqueue({
      ...intent,
      clientTurnId: 'later-1',
      content: 'written afterwards',
    });
    const transport = vi.fn(async (_turn: Readonly<OutboundDispatchTurn>) => ({
      kind: 'accepted' as const,
      providerTurnId: 'p-later',
    }));
    await queue.outboundDispatch.flush(transport);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]?.[0]).toMatchObject({
      clientTurnId: 'later-1',
    });
    // The unconfirmed text is kept, and its own renderer can re-check it.
    expect(
      (await queue.outboundDispatch.snapshot()).find(
        (row) => row.clientTurnId === 'unconfirmed-1',
      ),
    ).toMatchObject({ status: 'may-have-started', content: intent.content });
    expect(
      await queue.outboundDispatch.check(
        'unconfirmed-1',
        lookupAnswering('started'),
      ),
    ).toBe('started');
    expect(
      (await queue.outboundDispatch.snapshot()).some(
        (row) => row.clientTurnId === 'unconfirmed-1',
      ),
    ).toBe(false);
  });

  it('a live send that went undeliverable forgets the lookup answer about the attempt that ended', async () => {
    const queue = await freshRenderer();
    const live = await queue.outboundDispatch.beginLive({
      ...intent,
      clientTurnId: 'offline-after-received',
    });
    await live.observed('received');
    expect((await queue.outboundDispatch.snapshot())[0]).toMatchObject({
      deliveryCheck: { outcome: 'received' },
    });
    await live.undeliverable(new TypeError('Failed to fetch'));
    const [row] = await queue.outboundDispatch.snapshot();
    expect(row).toMatchObject({
      clientTurnId: 'offline-after-received',
      status: 'pending',
    });
    expect(row?.deliveryCheck).toBeUndefined();
  });

  it('lists the keys finished with, by reason, for every window', async () => {
    const queue = await freshRenderer();
    await queue.outboundDispatch.enqueue({
      ...intent,
      clientTurnId: 'thrown-away',
    });
    await queue.outboundDispatch.discard('thrown-away');
    const live = await queue.outboundDispatch.beginLive({
      ...intent,
      clientTurnId: 'went-through',
    });
    await live.accepted();
    const later = await freshRenderer();
    await expect(later.outboundDispatch.retiredKeys()).resolves.toEqual({
      discarded: ['thrown-away'],
      accepted: ['went-through'],
    });
  });

  it('#3596: an unconfirmed row is never discarded by the ordinary Discard; only an explicit dismissal removes it', async () => {
    const queue = await freshRenderer();
    const live = await queue.outboundDispatch.beginLive({
      ...intent,
      clientTurnId: 'unconfirmed-2',
    });
    await live.indeterminate('Station could not confirm the start.');
    await expect(
      queue.outboundDispatch.discard('unconfirmed-2'),
    ).rejects.toThrow('may have started');
    expect(
      (await queue.outboundDispatch.snapshot()).map((row) => row.status),
    ).toEqual(['may-have-started']);

    await queue.outboundDispatch.dismissUnconfirmed('unconfirmed-2');

    expect(await queue.outboundDispatch.snapshot()).toEqual([]);
    // Retired with it: no window can send it again, or queue it again.
    await expect(
      queue.outboundDispatch.beginLive({
        ...intent,
        clientTurnId: 'unconfirmed-2',
      }),
    ).rejects.toMatchObject({
      name: 'OutboundKeyRetiredError',
      reason: 'discarded',
    });
    await expect(
      queue.outboundDispatch.enqueue({
        ...intent,
        clientTurnId: 'unconfirmed-2',
      }),
    ).rejects.toMatchObject({ name: 'OutboundKeyRetiredError' });
  });

  it('a send that got no answer awaits the lookup, and only an explicit dismissal withdraws it', async () => {
    const queue = await freshRenderer();
    const live = await queue.outboundDispatch.beginLive({
      ...intent,
      clientTurnId: 'no-answer',
    });
    expect((await queue.outboundDispatch.snapshot())[0]?.awaitingLookup).toBe(
      undefined,
    );
    await live.unanswered();
    const [row] = await queue.outboundDispatch.snapshot();
    expect(row).toMatchObject({
      clientTurnId: 'no-answer',
      status: 'invoking',
      awaitingLookup: true,
    });
    await expect(queue.outboundDispatch.discard('no-answer')).rejects.toThrow(
      'may have started',
    );
    await queue.outboundDispatch.dismissUnconfirmed('no-answer');
    expect(await queue.outboundDispatch.snapshot()).toEqual([]);
    await expect(queue.outboundDispatch.retiredKeys()).resolves.toMatchObject({
      discarded: ['no-answer'],
    });
  });

  it('#3596: the explicit dismissal refuses any row that is not unconfirmed, and changes nothing', async () => {
    const queue = await freshRenderer();
    await queue.outboundDispatch.beginLive({
      ...intent,
      clientTurnId: 'still-sending',
    });
    await queue.outboundDispatch.enqueue({
      ...intent,
      clientTurnId: 'waiting',
    });
    for (const key of ['still-sending', 'waiting']) {
      await expect(
        queue.outboundDispatch.dismissUnconfirmed(key),
      ).rejects.toThrow('Only a message that may have reached the agent');
    }
    expect(
      (await queue.outboundDispatch.snapshot()).map((row) => [
        row.clientTurnId,
        row.status,
      ]),
    ).toEqual([
      ['still-sending', 'invoking'],
      ['waiting', 'pending'],
    ]);
    // A not-sent row and an accepted one are not unconfirmed either.
    const refused = await queue.outboundDispatch.beginLive({
      ...intent,
      clientTurnId: 'refused-row',
    });
    await refused.notSent('Station refused it.');
    await queue.outboundDispatch.enqueue({
      ...intent,
      clientTurnId: 'accepted-row',
      sessionId: 'chat-accepted',
    });
    await queue.outboundDispatch.flush(async (turn) =>
      turn.clientTurnId === 'accepted-row'
        ? { kind: 'accepted' as const, providerTurnId: 'p-accepted' }
        : { kind: 'deferred' as const, reason: 'not this one' },
    );
    const statuses = Object.fromEntries(
      (await queue.outboundDispatch.snapshot()).map((row) => [
        row.clientTurnId,
        row.status,
      ]),
    );
    expect(statuses).toMatchObject({
      'refused-row': 'failed',
      'accepted-row': 'accepted',
    });
    for (const key of ['refused-row', 'accepted-row']) {
      await expect(
        queue.outboundDispatch.dismissUnconfirmed(key),
      ).rejects.toThrow('Only a message that may have reached the agent');
    }
    expect(
      (await queue.outboundDispatch.snapshot()).map((row) => row.clientTurnId),
    ).toEqual(expect.arrayContaining(['refused-row', 'accepted-row']));
    // A key with no row is nothing to dismiss.
    await expect(
      queue.outboundDispatch.dismissUnconfirmed('no-such-key'),
    ).resolves.toBeUndefined();
  });

  it('after a reload, the restored queue takes its messages back: an edit is what gets sent, a delete is never sent', async () => {
    const before = await freshRenderer();
    await before.outboundDispatch.syncHeld([
      { ...intent, clientTurnId: 'held-edit', content: 'original text' },
      { ...intent, clientTurnId: 'held-delete', content: 'delete me' },
    ]);
    kill(); // the reload: a new renderer, the same session-storage queue
    const after = await freshRenderer();
    // The restored queue holds both again.
    await after.outboundDispatch.syncHeld([
      { ...intent, clientTurnId: 'held-edit', content: 'original text' },
      { ...intent, clientTurnId: 'held-delete', content: 'delete me' },
    ]);
    await after.outboundDispatch.reconcile(lookupAnswering('not-received'));
    const transport = vi.fn(async (turn: Readonly<OutboundDispatchTurn>) => ({
      kind: 'accepted' as const,
      providerTurnId: `turn-for-${turn.clientTurnId}`,
    }));
    // Held by this renderer's queue again: the flush leaves both alone.
    await after.outboundDispatch.flush(transport);
    expect(transport).not.toHaveBeenCalled();
    // The user edits one and deletes the other.
    await after.outboundDispatch.syncHeld([
      { ...intent, clientTurnId: 'held-edit', content: 'edited text' },
    ]);
    expect(await after.outboundDispatch.snapshot()).toEqual([
      expect.objectContaining({
        clientTurnId: 'held-edit',
        content: 'edited text',
      }),
    ]);
    // Closed before the turn ended: only the edited text is left, listed
    // for the user, and that is what Send sends.
    kill();
    const later = await freshRenderer();
    await later.outboundDispatch.reconcile(lookupAnswering('not-received'));
    await later.outboundDispatch.flush(transport);
    expect(transport).not.toHaveBeenCalled();
    expect(
      (await later.outboundDispatch.snapshot()).map((row) => row.content),
    ).toEqual(['edited text']);
    await later.outboundDispatch.sendHeld('held-edit');
    await later.outboundDispatch.flush(transport);
    expect(transport.mock.calls.map(([turn]) => turn.content)).toEqual([
      'edited text',
    ]);
  });

  it('a Station is recognised by its verified identity even at a new address', async () => {
    const queue = await freshRenderer();
    await queue.outboundDispatch.beginLive({
      ...intent,
      clientTurnId: 'moved',
      station: { apiBase: 'http://127.0.0.1:4100', environmentId: 'env-a' },
    });
    kill();
    const later = await freshRenderer();
    const lookup = lookupAnswering('started');
    await later.outboundDispatch.reconcile(lookup, {
      station: {
        apiBase: 'http://station.tailnet:4100',
        environmentId: 'env-a',
      },
    });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(await later.outboundDispatch.snapshot()).toEqual([]);
  });

  it.each(['refused', 'accepted'] as const)(
    'an earlier attempt settling %s after the same key was adopted preserves the key outcome',
    async (outcome) => {
      const queue = await freshRenderer();
      const lateAttempt = await queue.outboundDispatch.beginLive({
        ...intent,
        clientTurnId: 'retried',
      });
      const retry = await queue.outboundDispatch.beginLive({
        ...intent,
        clientTurnId: 'retried',
      });
      await lateAttempt[outcome]();
      if (outcome === 'refused') {
        const [adopted] = await queue.outboundDispatch.snapshot();
        expect(adopted).toMatchObject({
          clientTurnId: 'retried',
          status: 'invoking',
          liveInFlight: true,
        });
      } else {
        // Acceptance is proof about the key, including an overlapping retry.
        expect(await queue.outboundDispatch.snapshot()).toEqual([]);
        expect((await queue.outboundDispatch.retiredKeys()).accepted).toContain(
          'retried',
        );
        await expect(
          queue.outboundDispatch.beginLive({
            ...intent,
            clientTurnId: 'retried',
          }),
        ).rejects.toMatchObject({
          name: 'OutboundKeyRetiredError',
          reason: 'accepted',
        });
      }
      await retry.accepted();
      expect(await queue.outboundDispatch.snapshot()).toEqual([]);
    },
  );

  it('a held copy cannot be edited, merged or reordered here, and never holds back later messages', async () => {
    const queue = await freshRenderer();
    await queue.outboundDispatch.syncHeld([
      { ...intent, clientTurnId: 'held-x', content: 'held' },
    ]);
    await queue.outboundDispatch.enqueue({
      ...intent,
      clientTurnId: 'offline-after',
      content: 'written while offline',
    });
    await expect(
      queue.outboundDispatch.edit('held-x', 'changed'),
    ).rejects.toThrow(/held in a chat's queue/);
    await expect(
      queue.outboundDispatch.merge('held-x', 'offline-after'),
    ).rejects.toThrow(/held in a chat's queue/);
    await expect(
      queue.outboundDispatch.reorder('held-x', 'down'),
    ).rejects.toThrow(/held in a chat's queue/);
    const transport = vi.fn(async (turn: Readonly<OutboundDispatchTurn>) => ({
      kind: 'accepted' as const,
      providerTurnId: `p-${turn.clientTurnId}`,
    }));
    await queue.outboundDispatch.flush(transport);
    expect(transport.mock.calls.map(([turn]) => turn.clientTurnId)).toEqual([
      'offline-after',
    ]);
    expect(
      (await queue.outboundDispatch.snapshot()).find(
        (row) => row.clientTurnId === 'held-x',
      ),
    ).toMatchObject({ content: 'held' });
  });

  it("a held copy discarded in any window is never re-created by its holder's queue, nor sent", async () => {
    const queue = await freshRenderer();
    await queue.outboundDispatch.syncHeld([
      { ...intent, clientTurnId: 'discard-me', content: 'not wanted' },
    ]);
    // Another window's Discard (the outbox is shared; the key is what counts).
    await queue.outboundDispatch.discard('discard-me');
    await queue.outboundDispatch.syncHeld([
      { ...intent, clientTurnId: 'discard-me', content: 'not wanted' },
    ]);
    expect(await queue.outboundDispatch.snapshot()).toEqual([]);
    await expect(
      queue.outboundDispatch.beginLive({
        ...intent,
        clientTurnId: 'discard-me',
      }),
    ).rejects.toMatchObject({
      name: 'OutboundKeyRetiredError',
      reason: 'discarded',
    });
  });

  it('a delivered message is never held again (no ghost copy listed for Send)', async () => {
    const queue = await freshRenderer();
    await queue.outboundDispatch.syncHeld([
      { ...intent, clientTurnId: 'delivered', content: 'sent from elsewhere' },
    ]);
    await queue.outboundDispatch.sendHeld('delivered');
    const transport = vi.fn(async () => ({
      kind: 'accepted' as const,
      providerTurnId: 'p-delivered',
    }));
    await queue.outboundDispatch.flush(transport);
    await queue.outboundDispatch.completeAcceptedTurn('chat-1', 'p-delivered');
    expect(await queue.outboundDispatch.snapshot()).toEqual([]);
    // The holder's queue still lists it until its turn ends; its copy is
    // not re-created, and its drain cannot send it.
    await queue.outboundDispatch.syncHeld([
      { ...intent, clientTurnId: 'delivered', content: 'sent from elsewhere' },
    ]);
    expect(await queue.outboundDispatch.snapshot()).toEqual([]);
    await expect(
      queue.outboundDispatch.beginLive({
        ...intent,
        clientTurnId: 'delivered',
      }),
    ).rejects.toMatchObject({ reason: 'accepted' });
    // Same for a composer send Station accepted.
    const live = await queue.outboundDispatch.beginLive({
      ...intent,
      clientTurnId: 'live-delivered',
    });
    await live.accepted();
    await queue.outboundDispatch.syncHeld([
      { ...intent, clientTurnId: 'live-delivered', content: 'x' },
    ]);
    expect(await queue.outboundDispatch.snapshot()).toEqual([]);
  });

  it("knows its own held copies before it lists anything, so a window never lists its own queue's message as held elsewhere", async () => {
    const queue = await freshRenderer();
    await queue.outboundDispatch.syncHeld([
      { ...intent, clientTurnId: 'mine', content: 'in my queue' },
    ]);
    queue._forgetKnownBootId();
    expect((await queue.outboundDispatch.open())[0]?.heldHere).toBe(true);
  });

  it('the retired list survives a build that rewrites the queue without knowing it', async () => {
    const queue = await freshRenderer();
    await queue.outboundDispatch.syncHeld([
      { ...intent, clientTurnId: 'gone', content: 'discard me' },
    ]);
    await queue.outboundDispatch.discard('gone');
    // An older build's write: the queue record alone, as it knows it.
    const record = value as Record<string, unknown>;
    value = {
      version: 2,
      turns: record.turns,
      terminalEvidence: record.terminalEvidence,
      completedTerminals: record.completedTerminals,
    };
    await queue.outboundDispatch.syncHeld([
      { ...intent, clientTurnId: 'gone', content: 'discard me' },
    ]);
    expect(await queue.outboundDispatch.snapshot()).toEqual([]);
  });

  it('an unreadable or unknown retired entry never stops the outbox, and still retires its key', async () => {
    otherKeys.set('station-outbound-retired-v1', [
      { clientTurnId: 'future', reason: 'some-later-reason', at: 1 },
      { nonsense: true },
    ]);
    const queue = await freshRenderer();
    await expect(queue.outboundDispatch.open()).resolves.toEqual([]);
    await expect(
      queue.outboundDispatch.beginLive({ ...intent, clientTurnId: 'future' }),
    ).rejects.toMatchObject({ name: 'OutboundKeyRetiredError' });
  });

  it('many deliveries never push a Discard out of the retired list', async () => {
    const queue = await freshRenderer();
    await queue.outboundDispatch.syncHeld([
      { ...intent, clientTurnId: 'discarded-early', content: 'x' },
    ]);
    await queue.outboundDispatch.discard('discarded-early');
    for (let index = 0; index < 600; index += 1) {
      const live = await queue.outboundDispatch.beginLive({
        ...intent,
        clientTurnId: `delivered-${index}`,
      });
      await live.accepted();
    }
    await queue.outboundDispatch.syncHeld([
      { ...intent, clientTurnId: 'discarded-early', content: 'x' },
    ]);
    expect(await queue.outboundDispatch.snapshot()).toEqual([]);
  });

  it("Station's lookup answering started retires the key, and a retired key is never queued again", async () => {
    const second = await killedMidSend();
    await second.outboundDispatch.reconcile(lookupAnswering('started'));
    await expect(
      second.outboundDispatch.beginLive({ ...intent }),
    ).rejects.toMatchObject({ reason: 'accepted' });
    await expect(
      second.outboundDispatch.enqueue({ ...intent }),
    ).rejects.toMatchObject({ reason: 'accepted' });
  });

  it("a refused re-send never clears the flag of this renderer's attempt that still holds the key", async () => {
    const queue = await freshRenderer();
    const first = await queue.outboundDispatch.beginLive({
      ...intent,
      clientTurnId: 'still-mine',
    });
    await first.indeterminate('Station could not confirm the start.');
    await expect(
      queue.outboundDispatch.beginLive({
        ...intent,
        clientTurnId: 'still-mine',
      }),
    ).rejects.toMatchObject({ name: 'OutboundRowInFlightError' });
    expect((await queue.outboundDispatch.snapshot())[0]?.liveInFlight).toBe(
      true,
    );
  });
});

/**
 * The queue record and the retired-key list are two keys of ONE IndexedDB
 * object store, written in one readwrite transaction: a delivered row can
 * never be gone from the queue while its key is still sendable, nor the
 * other way round. The fake object store fires its requests asynchronously
 * and commits only when told, like IndexedDB.
 */
function fakeObjectStore(initial: Record<string, unknown>, failPutOf?: string) {
  const data = new Map(Object.entries(initial));
  const puts: Array<[string, unknown]> = [];
  const transaction = {
    aborted: false,
    abort() {
      transaction.aborted = true;
    },
  } as {
    aborted: boolean;
    abort: () => void;
    oncomplete?: () => void;
    onsuccess?: () => void;
    onerror?: () => void;
    onabort?: () => void;
    result?: unknown;
    error?: unknown;
  };
  const objectStore = {
    get(key: string) {
      const request = {} as {
        result?: unknown;
        error?: unknown;
        onsuccess?: () => void;
        onerror?: () => void;
      };
      queueMicrotask(() => {
        request.result = data.get(key);
        request.onsuccess?.();
      });
      return request;
    },
    put(next: unknown, key: string) {
      if (failPutOf === key) throw new Error(`cannot store ${key}`);
      puts.push([key, next]);
      return {};
    },
    transaction,
  };
  return {
    objectStore: objectStore as unknown as Pick<
      IDBObjectStore,
      'get' | 'put' | 'transaction'
    >,
    puts,
    transaction,
    commit: () => (transaction.oncomplete ?? transaction.onsuccess)?.(),
  };
}

describe('the queue and its retired list are written together', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads both keys, puts both in the one transaction, and settles only when it commits', async () => {
    const { updateRecordAndRetired } = await import('../lib/outboundQueue');
    const fake = fakeObjectStore({
      [QUEUE_KEY]: { turns: ['row'] },
      'station-outbound-retired-v1': ['old'],
    });
    const seen: unknown[] = [];
    let settled = false;
    const done = updateRecordAndRetired(fake.objectStore, (record, retired) => {
      seen.push(record, retired);
      return { record: { turns: [] }, retired: ['old', 'new'] };
    }).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toEqual([{ turns: ['row'] }, ['old']]);
    expect(fake.puts).toEqual([
      [QUEUE_KEY, { turns: [] }],
      ['station-outbound-retired-v1', ['old', 'new']],
    ]);
    expect(settled).toBe(false);
    fake.commit();
    await done;
    expect(settled).toBe(true);
  });

  it('an updater that refuses writes neither key', async () => {
    const { updateRecordAndRetired } = await import('../lib/outboundQueue');
    const fake = fakeObjectStore({ [QUEUE_KEY]: { turns: ['row'] } });
    await expect(
      updateRecordAndRetired(fake.objectStore, () => {
        throw new Error('retired');
      }),
    ).rejects.toThrow('retired');
    expect(fake.puts).toEqual([]);
  });

  it('a retired list that cannot be stored aborts the transaction, so the record is not kept alone', async () => {
    const { updateRecordAndRetired } = await import('../lib/outboundQueue');
    const fake = fakeObjectStore(
      { [QUEUE_KEY]: { turns: ['row'] } },
      'station-outbound-retired-v1',
    );
    await expect(
      updateRecordAndRetired(fake.objectStore, () => ({
        record: { turns: [] },
        retired: ['new'],
      })),
    ).rejects.toThrow('cannot store');
    expect(fake.transaction.aborted).toBe(true);
  });

  it('the outbox uses the one-transaction write when its storage offers it, never two separate writes', async () => {
    stubLocks();
    vi.resetModules();
    const queue = await import('../lib/outboundQueue');
    let record: unknown;
    let retired: unknown;
    const separateWrite = async () => {
      throw new Error('a separate write was made');
    };
    queue._setOutboundQueueStorage(
      {
        getItem: async (key) => (key === QUEUE_KEY ? record : retired),
        setItem: separateWrite,
        updateItem: separateWrite,
        updateWithRetired: async (updater) => {
          const next = updater(record, retired);
          record = next.record;
          retired = next.retired;
        },
      },
      { get: async () => retired, set: separateWrite },
    );
    const live = await queue.outboundDispatch.beginLive({
      ...intent,
      clientTurnId: 'atomic-1',
    });
    await live.accepted();
    expect(await queue.outboundDispatch.snapshot()).toEqual([]);
    await expect(
      queue.outboundDispatch.beginLive({ ...intent, clientTurnId: 'atomic-1' }),
    ).rejects.toMatchObject({ reason: 'accepted' });
  });

  it('the production IndexedDB storage writes a delivery and its retired key in one transaction', async () => {
    stubLocks();
    const data = new Map<string, unknown>();
    /** Keys put by each readwrite transaction, in order. */
    const transactions: string[][] = [];
    const db = {
      transaction(_store: string, mode: string) {
        const keys: string[] = [];
        if (mode === 'readwrite') transactions.push(keys);
        const transaction = {
          abort() {},
        } as {
          abort: () => void;
          oncomplete?: () => void;
          onsuccess?: () => void;
        };
        // Commits once its requests have run, like IndexedDB.
        setTimeout(() => (transaction.oncomplete ?? transaction.onsuccess)?.());
        return {
          objectStore: () => ({
            transaction,
            get(key: string) {
              const request = {} as {
                result?: unknown;
                onsuccess?: () => void;
              };
              queueMicrotask(() => {
                request.result = data.get(key);
                request.onsuccess?.();
              });
              return request;
            },
            put(next: unknown, key: string) {
              keys.push(key);
              data.set(key, next);
              const request = {} as { onsuccess?: () => void };
              queueMicrotask(() => request.onsuccess?.());
              return request;
            },
          }),
        };
      },
    };
    vi.stubGlobal('indexedDB', {
      open() {
        const request = { result: db } as {
          result: unknown;
          onsuccess?: () => void;
          onupgradeneeded?: () => void;
        };
        queueMicrotask(() => request.onsuccess?.());
        return request;
      },
    });
    vi.resetModules();
    const queue = await import('../lib/outboundQueue');
    queue._resetOutboundQueueStorage();
    const live = await queue.outboundDispatch.beginLive({
      ...intent,
      clientTurnId: 'idb-atomic',
    });
    transactions.length = 0;
    await live.accepted();
    expect(
      transactions.some(
        (keys) =>
          keys.includes(QUEUE_KEY) &&
          keys.includes('station-outbound-retired-v1'),
      ),
    ).toBe(true);
    expect(
      transactions.some(
        (keys) =>
          keys.length === 1 && keys[0] === 'station-outbound-retired-v1',
      ),
    ).toBe(false);
  });
});

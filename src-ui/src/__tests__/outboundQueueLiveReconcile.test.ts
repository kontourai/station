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
const storage: OutboundQueueStorage = {
  getItem: async () => value,
  setItem: async (_key, next) => {
    value = next;
  },
  updateItem: async (_key, updater) => {
    value = updater(value);
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
  queue._setOutboundQueueStorage(storage);
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
    heldLocks.clear();
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

  it("re-sending a key whose own earlier durable write landed late adopts that row; the old attempt's cleanup cannot delete it", async () => {
    const queue = await freshRenderer();
    const lateAttempt = await queue.outboundDispatch.beginLive({
      ...intent,
      clientTurnId: 'retried',
    });
    // The same message sent again from this renderer (a drain retry).
    const retry = await queue.outboundDispatch.beginLive({
      ...intent,
      clientTurnId: 'retried',
    });
    await lateAttempt.refused();
    expect(await queue.outboundDispatch.snapshot()).toEqual([
      expect.objectContaining({ clientTurnId: 'retried', status: 'invoking' }),
    ]);
    await retry.accepted();
    expect(await queue.outboundDispatch.snapshot()).toEqual([]);
  });
});

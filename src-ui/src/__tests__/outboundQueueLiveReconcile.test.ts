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
  });
  afterEach(() => {
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

  it.each(['indeterminate', 'expired'] as const)(
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
});

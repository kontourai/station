import { once } from 'node:events';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getRequestListener } from '@hono/node-server';
import {
  type CanonicalRuntimeEvent,
  SERVER_EVENTS,
} from '@kontourai/station-contracts/runtime-events';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { createEventRoutes } from '../events.js';
import { createOrchestrationRoutes } from '../orchestration.js';

const temp = trackTempDirs();
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function listen(app: { fetch: (request: Request) => unknown }) {
  const server = createServer(getRequestListener(app.fetch));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No loopback port');
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${address.port}`;
}

async function connect(url: string) {
  const controller = new AbortController();
  cleanup.push(() => controller.abort());
  const response = await fetch(url, { signal: controller.signal });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  let text = '';
  const decoder = new TextDecoder();
  const until = async (marker: string) => {
    while (!text.includes(marker)) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`EOF before ${marker}`);
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text;
  };
  return { until, reader };
}

function fixture() {
  const store = new EventStore(
    join(temp('sse-backpressure-'), 'events.sqlite'),
  );
  const bus = new EventBus();
  const adapter = new GateTestAdapter();
  const service = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(adapter),
    eventBus: bus,
    eventStore: store,
    logger: { debug() {}, warn() {} },
  });
  service.initialize();
  cleanup.push(async () => {
    await service.shutdown();
    store.close();
  });
  // The real owner and replay policy read these server-stamped facts.
  store.appendEvent({
    eventId: 'owner',
    provider: 'claude',
    threadId: 'thread',
    method: 'session.configured',
    sessionId: 'thread',
    createdAt: '2026-10-22T00:00:00Z',
    metadata: { userId: 'owner' },
  });
  const app = createOrchestrationRoutes(service, {
    eventBus: bus,
    getUserId: () => 'owner',
    logger: { debug() {} },
  });
  const emit = (index: number, bytes: number) => {
    const event: CanonicalRuntimeEvent = {
      eventId: `event-${index}`,
      provider: 'claude',
      threadId: 'thread',
      turnId: 'turn',
      method: 'content.text-delta',
      itemId: 'text',
      delta: `${index}:${'x'.repeat(bytes)}`,
      createdAt: '2026-10-22T00:00:01Z',
    };
    store.appendEvent(event);
    bus.emit(SERVER_EVENTS.ORCHESTRATION_EVENT, {
      event,
      globalSequence: store.readGlobalSequence(event.eventId),
    });
  };
  return { store, bus, service, app, emit, adapter };
}

describe('SSE backpressure over real loopback sockets (#3817)', () => {
  test.each([
    [1000, 1024],
    [300, 16 * 1024],
    [3000, 4 * 1024],
    [192, 48 * 1024],
  ])(
    'a healthy reader receives %i snapshot-time events of %i bytes without EOF',
    async (count, bytes) => {
      const f = fixture();
      let release!: () => void;
      let entered!: () => void;
      const snapshotEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      cleanup.push(() => release());
      vi.spyOn(f.service, 'listSessionReadModel').mockImplementationOnce(
        async () => {
          entered();
          await barrier;
          return [];
        },
      );
      const page = vi.spyOn(f.service, 'readEventStreamReplayPage');
      const base = await listen(f.app);
      const connecting = connect(`${base}/events`);
      // Teardown may abort this request if the snapshot fixture fails first.
      void connecting.catch(() => {});
      await snapshotEntered;
      for (let i = 0; i < count; i++) f.emit(i, bytes);
      release();
      const client = await connecting;
      const text = await client.until(`"eventId":"event-${count - 1}"`);
      const ids = [...text.matchAll(/"eventId":"event-(\d+)"/g)].map((match) =>
        Number(match[1]),
      );
      expect(ids).toEqual(Array.from({ length: count }, (_, i) => i));
      expect(text.indexOf('event: orchestration:caughtUp')).toBeLessThan(
        text.indexOf('"eventId":"event-0"'),
      );
      if (count * bytes > 8 * 1024 * 1024) expect(page).toHaveBeenCalled();
      else expect(page).not.toHaveBeenCalled();
      for (const result of page.mock.results) {
        if (result.type !== 'return')
          throw new Error('Replay page did not return');
        expect(result.value.events.length).toBeLessThanOrEqual(64);
        const serializedBytes = result.value.events.reduce(
          (sum, event) =>
            sum + Buffer.byteLength(JSON.stringify({ event: event.payload })),
          0,
        );
        expect(serializedBytes).toBeLessThanOrEqual(1024 * 1024);
      }
      f.emit(count, 10);
      await client.until(`"eventId":"event-${count}"`);
    },
    120_000,
  );

  test('stalled live readers resume via bounded pages on the same socket', async () => {
    const f = fixture();
    const page = vi.spyOn(f.service, 'readEventStreamReplayPage');
    const base = await listen(f.app);
    const client = await connect(`${base}/events`);
    await client.until('event: orchestration:caughtUp');
    // No reads during this synchronous burst: more than the live frame budget.
    for (let i = 0; i < 1800; i++) f.emit(i, 1024);
    const text = await client.until('"eventId":"event-1799"');
    const ids = [...text.matchAll(/"eventId":"event-(\d+)"/g)].map((match) =>
      Number(match[1]),
    );
    expect(ids).toEqual(Array.from({ length: 1800 }, (_, i) => i));
    expect(page).toHaveBeenCalled();
  }, 120_000);

  test('one envelope is serialized and bound once for multiple subscribers, while revocation takes effect', async () => {
    const f = fixture();
    const prepares = vi.spyOn(DatabaseSync.prototype, 'prepare');
    cleanup.push(() => {
      prepares.mockRestore();
    });
    const binding = vi
      .spyOn(f.service, 'conversationStreamBinding')
      .mockReturnValue({
        conversationId: 'thread',
        currentSessionId: 'thread',
      });
    const lookup = vi.spyOn(f.service, 'readEventGlobalSequence');
    const base = await listen(f.app);
    const a = await connect(`${base}/events`);
    const b = await connect(`${base}/events`);
    await Promise.all([
      a.until('event: orchestration:caughtUp'),
      b.until('event: orchestration:caughtUp'),
    ]);
    const encode = vi.fn(() => 'serialized-once');
    const allowed = vi.spyOn(f.service, 'canUserReadSession');
    f.bus.emit(SERVER_EVENTS.ORCHESTRATION_EVENT, {
      event: {
        eventId: 'shared',
        threadId: 'thread',
        method: 'request.opened',
        marker: { toJSON: encode },
      },
      globalSequence: 2,
    });
    await Promise.all([
      a.until('"eventId":"shared"'),
      b.until('"eventId":"shared"'),
    ]);
    expect(encode).toHaveBeenCalledTimes(1);
    expect(binding).toHaveBeenCalledTimes(1);
    expect(lookup).not.toHaveBeenCalled();
    const published = new Promise<Record<string, unknown>>((resolve) => {
      const unsub = f.bus.subscribe((evt) => {
        if (
          (evt.data?.event as { eventId?: string })?.eventId !== 'from-adapter'
        )
          return;
        unsub();
        resolve(evt.data!);
      });
      cleanup.push(unsub);
    });
    f.adapter.events.push({
      eventId: 'from-adapter',
      provider: 'claude',
      threadId: 'thread',
      method: 'session.configured',
      sessionId: 'thread',
      createdAt: '2026-10-22T00:00:02Z',
      metadata: { userId: 'owner' },
    });
    expect((await published).globalSequence).toBe(f.store.headGlobalSequence());
    await Promise.all([
      a.until('"eventId":"from-adapter"'),
      b.until('"eventId":"from-adapter"'),
    ]);
    expect(lookup).not.toHaveBeenCalled();
    allowed.mockReturnValue(false);
    f.bus.emit(SERVER_EVENTS.ORCHESTRATION_EVENT, {
      event: {
        eventId: 'secret',
        threadId: 'thread',
        method: 'request.opened',
      },
    });
    allowed.mockRestore();
    f.emit(50, 10);
    f.emit(51, 10);
    expect(
      prepares.mock.calls.filter(([sql]) =>
        sql.includes(
          'SELECT global_sequence FROM orchestration_events WHERE id = ?',
        ),
      ),
    ).toHaveLength(1);
    expect(await a.until('"eventId":"event-50"')).not.toContain(
      '"eventId":"secret"',
    );
    expect(await b.until('"eventId":"event-50"')).not.toContain(
      '"eventId":"secret"',
    );
  });

  test('revocation while a snapshot is pending withholds previously queued content', async () => {
    const f = fixture();
    let release!: () => void;
    let entered!: () => void;
    const entering = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    cleanup.push(() => release());
    vi.spyOn(f.service, 'listSessionReadModel').mockImplementationOnce(
      async () => {
        entered();
        await barrier;
        return [];
      },
    );
    const allowed = vi
      .spyOn(f.service, 'canUserReadSession')
      .mockReturnValue(true);
    const base = await listen(f.app);
    const connecting = connect(`${base}/events`);
    await entering;
    f.emit(0, 100);
    allowed.mockImplementation((threadId) => threadId === 'public');
    f.bus.emit(SERVER_EVENTS.ORCHESTRATION_EVENT, {
      event: { eventId: 'fence', threadId: 'public', method: 'request.opened' },
    });
    release();
    const text = await (await connecting).until('"eventId":"fence"');
    expect(text).not.toContain('"eventId":"event-0"');
  });

  test('/events compacts a blocked backlog into cache resync and keeps observing', async () => {
    const bus = new EventBus();
    let release!: () => void;
    let blocked!: () => void;
    const entered = new Promise<void>((resolve) => {
      blocked = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    cleanup.push(() => release());
    const app = createEventRoutes({
      eventBus: bus,
      logger: { debug() {} },
      getACPStatus: () => ({ connected: false, connections: [] }),
      writeSse: async (stream, frame) => {
        await stream.writeSSE(frame);
        if (frame.data.includes('"id":"blocked"'))
          setImmediate(() => {
            bus.emit(SERVER_EVENTS.CONFIG_CHANGED, { marker: 'still-live' });
          });
      },
      canReadPluginDraftEvent: async () => {
        blocked();
        await barrier;
        return true;
      },
    });
    const client = await connect(await listen(app));
    await client.until('event: acp:status');
    bus.emit(SERVER_EVENTS.PLUGIN_DRAFTS_REBUILT, { id: 'blocked' });
    await entered;
    for (let i = 0; i < 1500; i++)
      bus.emit(SERVER_EVENTS.CONFIG_CHANGED, { index: i });
    release();
    const text = await client.until('still-live');
    expect(text.includes('event: data:changed')).toBe(true);
    expect(text).toContain('"notifications"');
    expect(text).toContain('"scheduler-jobs"');
    expect(text).toContain('"answer-basis"');
    expect(text).toContain('"server-update-state"');
    expect(text).not.toContain('"index":1499');
  });
});

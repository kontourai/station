import { once } from 'node:events';
import { serve } from '@hono/node-server';
import { serializeClientReportedOrigin } from '@kontourai/station-contracts/client-origin';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { OrchestrationStreamPresence } from '../../../services/orchestration/orchestration-stream-presence.js';
import { createOrchestrationRoutes } from '../orchestration.js';

/**
 * station#2301: the `/events` stream must leave an open AND a close line, with
 * enough identity to reconstruct a two-device divergence after the fact. The
 * access log's `stream-open-after=` line has neither a client nor an end.
 *
 * The close-on-client-abort case binds a real loopback port on purpose:
 * `app.request()` does not propagate a consumer's cancel to
 * `stream.onAbort()` (see `orchestration.routes.presence.test.ts`'s header),
 * and a client going away is precisely the event this logging exists for.
 */

const CLIENT_SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e';

function makeService(head = 0) {
  return {
    listSessionReadModel: vi.fn().mockResolvedValue([]),
    canUserReadSession: vi.fn().mockReturnValue(true),
    readEventStreamHead: () => head,
    conversationStreamBinding: () => undefined,
    readEventGlobalSequence: () => undefined,
    readEventStreamReplay: () => [],
    readEventStreamReplayPlan: () => ({ count: 0, fitsBudget: true }),
  };
}

function makeLogger() {
  return { debug: vi.fn(), info: vi.fn() };
}

function lifecycleCalls(
  logger: ReturnType<typeof makeLogger>,
  message: string,
) {
  return logger.info.mock.calls
    .filter(([line]) => line === message)
    .map(([, meta]) => meta as Record<string, unknown>);
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

async function listen(app: { fetch: (request: Request) => unknown }) {
  const listener = serve({
    fetch: app.fetch as never,
    hostname: '127.0.0.1',
    port: 0,
  });
  await once(listener, 'listening');
  const address = listener.address();
  if (!address || typeof address === 'string')
    throw new Error('loopback listener did not bind a TCP port');
  closers.push(async () => {
    if ('closeAllConnections' in listener) listener.closeAllConnections();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  });
  return `http://127.0.0.1:${address.port}`;
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  marker: string,
) {
  const decoder = new TextDecoder();
  let output = '';
  while (!output.includes(marker)) {
    const { done, value } = await reader.read();
    if (done) break;
    output += decoder.decode(value, { stream: true });
  }
  return output;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('GET /events lifecycle log (station#2301)', () => {
  test('a client that goes away leaves a close line joined to its open line, with duration and frames', async () => {
    const logger = makeLogger();
    const app = createOrchestrationRoutes(makeService() as never, {
      eventBus: new EventBus(),
      logger,
      getUserId: () => 'user-1',
      presence: new OrchestrationStreamPresence(),
    });
    const base = await listen(app);
    const controller = new AbortController();
    const response = await fetch(`${base}/events`, {
      signal: controller.signal,
      headers: {
        'X-Station-Client-Session': CLIENT_SESSION,
        'X-Station-Client-Origin': serializeClientReportedOrigin({
          version: 1,
          surface: 'mobile',
          build: '0.1.11-nightly',
        })!,
      },
    });
    const reader = response.body!.getReader();
    await readUntil(reader, 'event: orchestration:caughtUp');

    const [opened] = lifecycleCalls(
      logger,
      'Orchestration event stream opened',
    );
    expect(opened).toMatchObject({
      clientSession: CLIENT_SESSION,
      surface: 'mobile',
      build: '0.1.11-nightly',
      scope: 'all',
      lastEventId: 'none',
      resumeDecision: 'snapshot',
      resumeReason: 'no_cursor',
    });
    expect(lifecycleCalls(logger, 'Orchestration event stream closed')).toEqual(
      [],
    );

    controller.abort();
    await reader.cancel().catch(() => {});
    await waitFor(
      () =>
        lifecycleCalls(logger, 'Orchestration event stream closed').length > 0,
    );

    const closed = lifecycleCalls(logger, 'Orchestration event stream closed');
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({
      connectionId: opened?.connectionId,
      clientSession: CLIENT_SESSION,
      reason: 'client-abort',
      // snapshot + caught-up
      framesWritten: 2,
    });
    expect(typeof closed[0]?.durationMs).toBe('number');
    expect(typeof opened?.connectionId).toBe('string');
  });

  test('a resuming client records its cursor and the replay decision with the computed gap', async () => {
    const logger = makeLogger();
    const app = createOrchestrationRoutes(makeService(40) as never, {
      eventBus: new EventBus(),
      logger,
      getUserId: () => 'user-1',
      presence: new OrchestrationStreamPresence(),
    });
    const base = await listen(app);
    const controller = new AbortController();
    const response = await fetch(`${base}/events`, {
      signal: controller.signal,
      headers: { 'Last-Event-ID': '25' },
    });
    const reader = response.body!.getReader();
    await readUntil(reader, 'event: orchestration:caughtUp');
    controller.abort();
    await reader.cancel().catch(() => {});

    const [opened] = lifecycleCalls(
      logger,
      'Orchestration event stream opened',
    );
    expect(opened).toMatchObject({
      clientSession: 'none',
      lastEventId: 25,
      head: 40,
      resumeDecision: 'replay',
      resumeReason: 'within_threshold',
      resumeGap: 15,
    });
  });

  test('a malformed session header or cursor is reported as such, never echoed', async () => {
    const logger = makeLogger();
    const app = createOrchestrationRoutes(makeService() as never, {
      eventBus: new EventBus(),
      logger,
      getUserId: () => 'user-1',
      presence: new OrchestrationStreamPresence(),
    });
    const base = await listen(app);
    const controller = new AbortController();
    const response = await fetch(`${base}/events`, {
      signal: controller.signal,
      headers: {
        'X-Station-Client-Session': 'not a uuid <script>',
        'Last-Event-ID': 'abc',
      },
    });
    const reader = response.body!.getReader();
    await readUntil(reader, 'event: orchestration:caughtUp');
    controller.abort();
    await reader.cancel().catch(() => {});

    const [opened] = lifecycleCalls(
      logger,
      'Orchestration event stream opened',
    );
    expect(opened).toMatchObject({
      clientSession: 'none',
      lastEventId: 'invalid',
      resumeReason: 'no_cursor',
    });
  });

  test('a setup failure closes with its reason and error, so a stream that never opened is still visible', async () => {
    const logger = makeLogger();
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const app = createOrchestrationRoutes(
      {
        ...makeService(),
        readEventStreamHead: () => {
          throw new Error('simulated event-store failure');
        },
      } as never,
      {
        eventBus: new EventBus(),
        logger,
        getUserId: () => 'user-1',
        presence: new OrchestrationStreamPresence(),
      },
    );
    await app.request('/events');
    await waitFor(
      () =>
        lifecycleCalls(logger, 'Orchestration event stream closed').length > 0,
    );
    consoleErrorSpy.mockRestore();

    expect(lifecycleCalls(logger, 'Orchestration event stream opened')).toEqual(
      [],
    );
    expect(
      lifecycleCalls(logger, 'Orchestration event stream closed')[0],
    ).toMatchObject({
      reason: 'setup-error',
      error: 'simulated event-store failure',
      framesWritten: 0,
    });
  });
});

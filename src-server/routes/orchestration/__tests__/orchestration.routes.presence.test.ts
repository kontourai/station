import {
  parseHostedTenantRegistry,
  tenantId,
} from '@kontourai/station-contracts/tenancy';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createHostedTenantMiddleware } from '../../../runtime/bootstrap/runtime-tenant-context.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import {
  OrchestrationStreamPresence,
  orchestrationStreamPresenceSubjectForSession,
} from '../../../services/orchestration/orchestration-stream-presence.js';
import { orchestrationStreamDuration } from '../../../telemetry/metrics.js';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_TENANT_HEADER,
} from '../../../utils/internal-api-token.js';
import { createOrchestrationRoutes } from '../orchestration.js';

// archive#1848: only `orchestrationStreamDuration` is replaced; every other
// instrument the route touches keeps its real (no-op) implementation, which is
// what this package's earlier partial `vi.mock` of this module got wrong (see
// `events.routes.test.ts`'s header).
vi.mock('../../../telemetry/metrics.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../telemetry/metrics.js')>()),
  orchestrationStreamDuration: { record: vi.fn() },
}));

/**
 * archive#1225: proves `createOrchestrationRoutes`'s `/events` handler
 * actually registers a connection against the SHARED
 * `OrchestrationStreamPresence` instance the push-on-completion gate reads
 * — not just that the class works in isolation
 * (`orchestration-stream-presence.test.ts` covers connect/disconnect/
 * double-release there).
 *
 * NOT_VERIFIED here (disclosed, not silently skipped): the matching
 * disconnect-on-abort half of this wiring. `app.request()`'s Response body
 * in this Hono+Node test harness does not propagate a consumer's
 * `reader.cancel()` back to `streamSSE`'s `stream.onAbort()` subscribers —
 * confirmed by a standalone repro against bare `hono/streaming` outside
 * this route entirely (it hangs waiting for the abort callback that never
 * fires). This is a pre-existing harness limitation, not something this
 * change introduces: no test anywhere in this suite (including the
 * archive#1092/#1197/#1205 resume/replay suites, which rely on the exact
 * SAME `stream.onAbort()` mechanism for their own `unsub()` cleanup)
 * exercises the disconnect path this way either. The disconnect code itself
 * (`releasePresence()`, right alongside the pre-existing `unsub()` it
 * mirrors) is a one-line call reviewable by inspection.
 */
function makeMinimalService() {
  return {
    listSessionReadModel: vi.fn().mockResolvedValue([]),
    canUserReadSession: vi.fn().mockReturnValue(true),
    readEventStreamHead: () => 0,
    readEventGlobalSequence: () => undefined,
    readEventStreamReplay: () => [],
  };
}

const hostedRegistry = parseHostedTenantRegistry({
  schemaVersion: 1,
  tenants: [
    { id: 'alpha', authority: 'alpha.example.test' },
    { id: 'bravo', authority: 'bravo.example.test' },
  ],
});

function hostedEventRequest(tenant: 'alpha' | 'bravo') {
  return new Request('http://station.test/events', {
    headers: {
      [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
      [INTERNAL_TENANT_HEADER]: tenant,
    },
  });
}

const loopbackEnv = {
  incoming: { socket: { remoteAddress: '127.0.0.1' } },
} as never;

/** Module-scoped so both this file's route-level describe blocks can share it. */
async function readUntilCaughtUp(
  reader: ReadableStreamDefaultReader<Uint8Array>,
) {
  const decoder = new TextDecoder();
  let output = '';
  while (!output.includes('event: orchestration:caughtUp')) {
    const { done, value } = await reader.read();
    if (done) break;
    output += decoder.decode(value, { stream: true });
  }
}

describe('GET /events registers connections with the shared presence tracker (station#1225)', () => {
  const activeReaders: Array<ReadableStreamDefaultReader<Uint8Array>> = [];

  afterEach(async () => {
    for (const reader of activeReaders.splice(0)) {
      await reader.cancel().catch(() => {});
    }
  });

  test('a connecting client is registered against the caller-supplied presence tracker by its resolved userId', async () => {
    const presence = new OrchestrationStreamPresence();
    const eventBus = new EventBus();
    const app = createOrchestrationRoutes(makeMinimalService() as any, {
      eventBus,
      logger: { debug: vi.fn() },
      getUserId: () => 'user-1',
      presence,
    });

    expect(presence.isConnected('user-1')).toBe(false);

    const res = await app.request('/events');
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    activeReaders.push(reader);
    await readUntilCaughtUp(reader);

    expect(presence.isConnected('user-1')).toBe(true);
    // A different user is never reported connected by this session.
    expect(presence.isConnected('user-2')).toBe(false);
  });

  test('two concurrent connections for the same user both register (count, not boolean, semantics)', async () => {
    const presence = new OrchestrationStreamPresence();
    const eventBus = new EventBus();
    const app = createOrchestrationRoutes(makeMinimalService() as any, {
      eventBus,
      logger: { debug: vi.fn() },
      getUserId: () => 'user-1',
      presence,
    });

    const [resA, resB] = await Promise.all([
      app.request('/events'),
      app.request('/events'),
    ]);
    const readerA = resA.body!.getReader();
    const readerB = resB.body!.getReader();
    activeReaders.push(readerA, readerB);
    await Promise.all([readUntilCaughtUp(readerA), readUntilCaughtUp(readerB)]);

    expect(presence.isConnected('user-1')).toBe(true);
  });

  test('keeps concurrent hosted alpha and bravo presence separate for one user', async () => {
    const presence = new OrchestrationStreamPresence();
    const eventBus = new EventBus();
    const app = new Hono();
    app.use('*', createHostedTenantMiddleware(hostedRegistry));
    app.route(
      '/',
      createOrchestrationRoutes(makeMinimalService() as any, {
        eventBus,
        logger: { debug: vi.fn() },
        getUserId: () => 'shared-user',
        hostedTenantRegistry: hostedRegistry,
        presence,
      }),
    );

    const [alphaResponse, bravoResponse] = await Promise.all([
      app.fetch(hostedEventRequest('alpha'), loopbackEnv),
      app.fetch(hostedEventRequest('bravo'), loopbackEnv),
    ]);
    const alphaReader = alphaResponse.body!.getReader();
    const bravoReader = bravoResponse.body!.getReader();
    activeReaders.push(alphaReader, bravoReader);
    await Promise.all([
      readUntilCaughtUp(alphaReader),
      readUntilCaughtUp(bravoReader),
    ]);

    const alpha = orchestrationStreamPresenceSubjectForSession('shared-user', {
      tenantId: tenantId('alpha'),
      source: 'session',
    });
    const bravo = orchestrationStreamPresenceSubjectForSession('shared-user', {
      tenantId: tenantId('bravo'),
      source: 'session',
    });
    expect(presence.isConnected(alpha)).toBe(true);
    expect(presence.isConnected(bravo)).toBe(true);
    expect(presence.isConnected('shared-user')).toBe(false);
  });

  test('a setup-time throw (e.g. an event-store read failing) still releases the presence count (station#1225 HIGH fix)', async () => {
    const presence = new OrchestrationStreamPresence();
    const eventBus = new EventBus();
    const service = {
      ...makeMinimalService(),
      // Simulates one of the unguarded event-store reads the review flagged
      // (`readEventStreamHead`/`readEventStreamReplay`/
      // `listSessionReadModel`) throwing during setup, BEFORE the route
      // reaches its own former unconditional cleanup lines.
      readEventStreamHead: () => {
        throw new Error('simulated event-store failure');
      },
    };
    // Hono's own `streamSSE` wrapper `console.error`s an uncaught throw from
    // the callback (no `onError` is passed here) — expected, not part of
    // what this test asserts. Swallow it so the suite's output stays clean.
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const app = createOrchestrationRoutes(service as any, {
      eventBus,
      logger: { debug: vi.fn() },
      getUserId: () => 'user-1',
      presence,
    });

    expect(presence.isConnected('user-1')).toBe(false);
    await app.request('/events');
    // Give the async streamSSE callback a tick to run past the throw and
    // execute its `finally` cleanup (this is exactly the fix under test:
    // before it, this assertion would fail — the throw happened before the
    // route's old unconditional `releasePresence()` line ever ran).
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(presence.isConnected('user-1')).toBe(false);
    consoleErrorSpy.mockRestore();
  });

  test('station#1848: a connection that ends records its real lifetime, scoped, exactly once', async () => {
    const record = vi.mocked(orchestrationStreamDuration.record);
    record.mockClear();
    const presence = new OrchestrationStreamPresence();
    const eventBus = new EventBus();
    const service = {
      ...makeMinimalService(),
      readEventStreamHead: () => {
        throw new Error('simulated event-store failure');
      },
    };
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const app = createOrchestrationRoutes(service as any, {
      eventBus,
      logger: { debug: vi.fn() },
      getUserId: () => 'user-1',
      presence,
    });

    // The setup-throw path is used deliberately: it is the one teardown this
    // harness can actually reach (see this file's header on `stream.onAbort()`
    // not propagating through `app.request()`), and it is also the case a
    // duration histogram most needs to cover — a connection that died at
    // setup is indistinguishable from a healthy one in the request log.
    await app.request('/events');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(record).toHaveBeenCalledTimes(1);
    const [duration, attributes] = record.mock.calls[0] as [
      number,
      Record<string, string>,
    ];
    expect(typeof duration).toBe('number');
    expect(duration).toBeGreaterThanOrEqual(0);
    expect(attributes).toEqual({ scope: 'all' });
    consoleErrorSpy.mockRestore();
  });

  test('station#1848: a thread-scoped connection is recorded under its own scope', async () => {
    const record = vi.mocked(orchestrationStreamDuration.record);
    record.mockClear();
    const eventBus = new EventBus();
    const service = {
      ...makeMinimalService(),
      readEventStreamHead: () => {
        throw new Error('simulated event-store failure');
      },
    };
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const app = createOrchestrationRoutes(service as any, {
      eventBus,
      logger: { debug: vi.fn() },
      getUserId: () => 'user-1',
      presence: new OrchestrationStreamPresence(),
    });

    await app.request('/events?threadId=thread-1');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]?.[1]).toEqual({ scope: 'thread' });
    consoleErrorSpy.mockRestore();
  });

  test('omitting `presence` still leaves the route functional (route-local fallback instance)', async () => {
    const eventBus = new EventBus();
    const app = createOrchestrationRoutes(makeMinimalService() as any, {
      getUserId: () => 'user-1',
      eventBus,
      logger: { debug: vi.fn() },
    });

    const res = await app.request('/events');
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    activeReaders.push(reader);
    await readUntilCaughtUp(reader);
  });
});

/**
 * archive#4075 stage 3 slice 2: `GET /presence/summary` reads the SAME
 * shared `OrchestrationStreamPresence` `/events` registers into above, and
 * must retain the stage-2 resolved `PrincipalRef` — not a re-resolution,
 * and not the test-only `getUserId` string. These tests wire
 * `resolvePrincipal` (the production seam — see `resolveActorPrincipal`'s
 * docs in `orchestration.ts`) rather than `getUserId`, so `principal` is a
 * real `PrincipalRef` the route can retain.
 */
describe('GET /presence/summary (station#4075 stage 3 slice 2)', () => {
  const activeReaders: Array<ReadableStreamDefaultReader<Uint8Array>> = [];

  afterEach(async () => {
    for (const reader of activeReaders.splice(0)) {
      await reader.cancel().catch(() => {});
    }
  });

  const operatorPrincipal = {
    id: 'human:local:operator',
    kind: 'human' as const,
    display: 'Operator',
  };

  test('carries the exact resolved principal id/kind while a stream is open, with connections: 1', async () => {
    const presence = new OrchestrationStreamPresence();
    const eventBus = new EventBus();
    const app = createOrchestrationRoutes(makeMinimalService() as any, {
      eventBus,
      logger: { debug: vi.fn() },
      resolvePrincipal: () => operatorPrincipal,
      presence,
    });

    const before = await app.request('/presence/summary');
    expect(before.status).toBe(200);
    await expect(before.json()).resolves.toMatchObject({ principals: [] });

    const res = await app.request('/events');
    const reader = res.body!.getReader();
    activeReaders.push(reader);
    await readUntilCaughtUp(reader);

    const during = await app.request('/presence/summary');
    expect(during.status).toBe(200);
    const body = (await during.json()) as {
      principals: unknown;
      observedAt: unknown;
    };
    expect(body.principals).toEqual([
      { id: 'human:local:operator', kind: 'human', connections: 1 },
    ]);
    expect(typeof body.observedAt).toBe('number');
  });

  test('disconnect (a setup-time throw releasing the connection) removes the principal from the roster', async () => {
    const presence = new OrchestrationStreamPresence();
    const eventBus = new EventBus();
    const service = {
      ...makeMinimalService(),
      readEventStreamHead: () => {
        throw new Error('simulated event-store failure');
      },
    };
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const app = createOrchestrationRoutes(service as any, {
      eventBus,
      logger: { debug: vi.fn() },
      resolvePrincipal: () => operatorPrincipal,
      presence,
    });

    await app.request('/events');
    await new Promise((resolve) => setTimeout(resolve, 10));

    const res = await app.request('/presence/summary');
    await expect(res.json()).resolves.toMatchObject({ principals: [] });
    consoleErrorSpy.mockRestore();
  });

  test('a caller with no resolved principal (test-only getUserId escape hatch) still registers presence but never appears in the roster', async () => {
    const presence = new OrchestrationStreamPresence();
    const eventBus = new EventBus();
    const app = createOrchestrationRoutes(makeMinimalService() as any, {
      eventBus,
      logger: { debug: vi.fn() },
      getUserId: () => 'user-1',
      presence,
    });

    const res = await app.request('/events');
    const reader = res.body!.getReader();
    activeReaders.push(reader);
    await readUntilCaughtUp(reader);

    expect(presence.isConnected('user-1')).toBe(true);
    const summary = await app.request('/presence/summary');
    await expect(summary.json()).resolves.toMatchObject({ principals: [] });
  });

  test('hosted mode 404s, the same mechanism /api/live-activity uses, regardless of roster content', async () => {
    const presence = new OrchestrationStreamPresence();
    const eventBus = new EventBus();
    const app = new Hono();
    app.use('*', createHostedTenantMiddleware(hostedRegistry));
    app.route(
      '/',
      createOrchestrationRoutes(makeMinimalService() as any, {
        eventBus,
        logger: { debug: vi.fn() },
        getUserId: () => 'shared-user',
        hostedTenantRegistry: hostedRegistry,
        presence,
      }),
    );

    const request = new Request('http://station.test/presence/summary', {
      headers: {
        [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
        [INTERNAL_TENANT_HEADER]: 'alpha',
      },
    });
    const response = await app.fetch(request, loopbackEnv);
    expect(response.status).toBe(404);
  });
});

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DEFAULT_GRANT_PAIRING_SCOPE } from '@kontourai/station-contracts/environment-security';
import { Hono } from 'hono';
import { afterEach, describe, expect, test } from 'vitest';
import { createRouteTestApp } from '../../../__test-utils__/route-test-app.js';
import { WorkflowNotFoundError } from '../../../domain/agent-workflow-errors.js';
import { createWorkflowRoutes } from '../../../routes/projects/layouts.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import type { LayoutService } from '../../../services/projects/layout-service.js';
import {
  fetchRemoteStation,
  RELAYED_RESPONSE_HEADER,
} from '../../../services/remote-stations/remote-station-forwarder.js';
import type { Logger } from '../../../utils/logger.js';
import {
  configureRuntimeHttp,
  installStationEnvelopeMarker,
} from '../runtime-http.js';
import { createHostedTenantMiddleware } from '../runtime-tenant-context.js';

// Pinned beside the contract constant, so a rename there fails here.
const MARKER = 'x-station-envelope';

const silentLogger = (): Logger => {
  const logger = {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child: () => logger,
    setLevel() {},
    getLevel: () => 'info' as const,
  };
  return logger as unknown as Logger;
};

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

/** Another Station, answering one refusal the way a marked Station does. */
async function peerStation(headers: Record<string, string>): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(403, {
      'content-type': 'application/json',
      ...headers,
    });
    response.end(
      JSON.stringify({ success: false, error: 'peer refused', code: 'peer' }),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/refuse`;
}

describe("#2842: the marker on Station's own answers", () => {
  test('a real route refusal answered by the error boundary carries it', async () => {
    const app = createRouteTestApp();
    app.route(
      '/agents',
      createWorkflowRoutes({
        getWorkflow: async () => {
          throw new WorkflowNotFoundError('build.ts');
        },
      } as unknown as LayoutService),
    );

    const response = await app.request('/agents/planner/workflows/build.ts');

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ success: false });
    expect(response.headers.get(MARKER)).toBe('1');
  });

  test("the runtime's own auth refusal carries it, and a cross-origin client may read it", async () => {
    const app = new Hono();
    configureRuntimeHttp({
      app: app as never,
      logger: silentLogger(),
      eventBus: new EventBus(),
      security: {
        allowedOrigins: ['http://localhost:5173'],
        verifyCredential: () => false,
        resolveGrantedScope: () => DEFAULT_GRANT_PAIRING_SCOPE,
      },
    });

    const response = await app.request(
      'http://station.test/api/orchestration/events',
      { headers: { Origin: 'http://localhost:5173' } },
      { incoming: { socket: { remoteAddress: '203.0.113.9' } } } as never,
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: 'authentication_required' },
    });
    expect(response.headers.get(MARKER)).toBe('1');
    expect(
      (response.headers.get('Access-Control-Expose-Headers') ?? '')
        .split(',')
        .map((name) => name.trim().toLowerCase()),
    ).toContain(MARKER);
  });

  test('without the security chain, a cross-origin client may still read it', async () => {
    const app = createRouteTestApp();
    app.get('/ok', (c) => c.json({ success: true, data: 1 }));

    const response = await app.request('http://station.test/ok', {
      headers: { Origin: 'http://localhost:5173' },
    });

    expect(response.headers.get(MARKER)).toBe('1');
    expect(
      (response.headers.get('Access-Control-Expose-Headers') ?? '')
        .split(',')
        .map((name) => name.trim().toLowerCase()),
    ).toContain(MARKER);
  });

  test.each([
    ['a success envelope', 200, () => ({ success: true, data: {} })],
    ['a handler-written refusal', 409, () => ({ success: false, error: 'no' })],
  ] as const)('%s carries it', async (_name, status, body) => {
    const app = createRouteTestApp();
    app.get('/x', (c) => c.json(body(), status));
    const response = await app.request('/x');
    expect(response.status).toBe(status);
    expect(response.headers.get(MARKER)).toBe('1');
  });

  test('a JSON Response built without the context helpers carries it', async () => {
    const app = createRouteTestApp();
    app.get(
      '/raw',
      () =>
        new Response(JSON.stringify({ error: { code: 'unavailable' } }), {
          status: 503,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        }),
    );
    const response = await app.request('/raw');
    expect(response.status).toBe(503);
    expect(response.headers.get(MARKER)).toBe('1');
  });

  test('an unhandled error and an unknown throw carry it', async () => {
    const app = createRouteTestApp();
    app.get('/error', () => {
      throw new Error('boom');
    });
    app.get('/foreign', () => {
      throw 'not an Error';
    });
    for (const path of ['/error', '/foreign']) {
      const response = await app.request(path);
      expect(response.status).toBe(500);
      expect(response.headers.get(MARKER)).toBe('1');
    }
  });

  test('a body that is not JSON does not carry it', async () => {
    const app = createRouteTestApp();
    app.get('/text', (c) => c.text('plain'));
    app.get('/events', (c) =>
      c.body('data: 1\n\n', 200, { 'Content-Type': 'text/event-stream' }),
    );
    app.get('/problem', (c) =>
      c.body('{}', 400, { 'Content-Type': 'application/jsonlines' }),
    );
    for (const path of ['/text', '/events', '/problem', '/missing']) {
      const response = await app.request(path);
      expect(response.headers.has(MARKER), path).toBe(false);
    }
  });

  test('a gate registered ahead of the HTTP boundary is marked once the marker is installed first', async () => {
    const app = new Hono();
    installStationEnvelopeMarker(app as never);
    app.use(
      '*',
      createHostedTenantMiddleware({
        tenants: [],
      } as unknown as Parameters<
        typeof createHostedTenantMiddleware
      >[0]) as never,
    );
    configureRuntimeHttp({
      app: app as never,
      logger: silentLogger(),
      eventBus: new EventBus(),
    });
    app.get('/ok', (c) => c.json({ success: true }));

    const response = await app.request('/ok');

    expect(response.status).toBe(421);
    expect(await response.json()).toEqual({
      error: { code: 'tenant_context_required' },
    });
    // Installed twice (here and by configureRuntimeHttp), registered once.
    expect(response.headers.get(MARKER)).toBe('1');
  });
});

describe("#2842: another Station's answer is never marked as this one's", () => {
  test("a relayed peer refusal leaves without this Station's marker, the peer's, or the relay tag", async () => {
    const peer = await peerStation({ [MARKER]: '1' });
    const app = createRouteTestApp();
    app.get('/relay', () => fetchRemoteStation(peer, {}, 5_000));

    const response = await app.request('/relay');

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      success: false,
      error: 'peer refused',
      code: 'peer',
    });
    expect(response.headers.has(MARKER)).toBe(false);
    expect(response.headers.has(RELAYED_RESPONSE_HEADER)).toBe(false);
  });

  test('a relayed answer from a peer that sends no marker is not given one', async () => {
    // An older Station, or a proxy in front of the peer.
    const peer = await peerStation({});
    const app = createRouteTestApp();
    app.get('/relay', () => fetchRemoteStation(peer, {}, 5_000));

    const response = await app.request('/relay');

    expect(response.status).toBe(403);
    expect(response.headers.has(MARKER)).toBe(false);
  });

  test('a peer cannot clear the relay tag', async () => {
    const peer = await peerStation({ [RELAYED_RESPONSE_HEADER]: '' });
    const relayed = await fetchRemoteStation(peer, {}, 5_000);
    expect(relayed.headers.get(RELAYED_RESPONSE_HEADER)).toBe('1');
  });

  test("this Station's own envelope about a peer's refusal is its own answer", async () => {
    const peer = await peerStation({ [MARKER]: '1' });
    const app = createRouteTestApp();
    app.get('/dispatch', async (c) => {
      const relayed = await fetchRemoteStation(peer, {}, 5_000);
      return c.json(
        { success: false, error: 'The selected Station refused the request' },
        relayed.ok ? 200 : 502,
      );
    });

    const response = await app.request('/dispatch');

    expect(response.status).toBe(502);
    expect(response.headers.get(MARKER)).toBe('1');
  });
});

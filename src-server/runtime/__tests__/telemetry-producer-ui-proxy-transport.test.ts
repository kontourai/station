/**
 * Telemetry producer ingest over REAL sockets, through Station's own UI proxy
 * (`uiRequestHandler`, unmodified) in front of the real runtime auth stack.
 *
 * The remote producer topology is Tailscale Serve: `https://<host>.ts.net`
 * terminates TLS and dials the UI port from loopback. The UI proxy then
 * re-dials the API from loopback too, so neither socket says "remote". What
 * must decide it is the proxy's own attestation of its client: the forwarded
 * Host, the forwarding/`tailscale-*` evidence marker, and a verified ingress
 * identity. This suite proves a local sender stays local, a Serve-shaped
 * request is remote unless the token allows it, and that the proxy forwards
 * ingest POSTs while a GET to an ingest path is never forwarded.
 */
import * as crypto from 'node:crypto';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as http from 'node:http';
import { createServer, type Server } from 'node:http';
import * as path from 'node:path';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  UI_MIME_TYPES,
  UI_PROXY_BACKEND_NAVIGATION_PREFIXES,
  UI_PROXY_BACKEND_PREFIXES,
  uiRequestHandler,
} from '../../../packages/cli/src/commands/lifecycle.js';
import { K } from '../../../src-shared/monitoring-keys.js';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { createOtlpReceiverRoutes } from '../../monitoring/otlp-receiver.js';
import type { MonitoringEvent } from '../../monitoring/schema.js';
import type { EventBus } from '../../services/orchestration/event-bus.js';
import {
  admittedTelemetryProducer,
  TelemetryProducerStore,
} from '../../services/telemetry-producers/telemetry-producer-store.js';
import { getInternalApiToken } from '../../utils/internal-api-token.js';
import type { Logger } from '../../utils/logger.js';
import { configureRuntimeHttp } from '../bootstrap/runtime-http.js';

const SERVE_HOST = 'station.example.ts.net';
const closers: Array<() => Promise<void>> = [];
const makeTempDir = trackTempDirs();

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

const logger = (): Logger =>
  ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
    setLevel: vi.fn(),
    getLevel: vi.fn(() => 'info' as const),
  }) as unknown as Logger;

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  closers.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  return (server.address() as { port: number }).port;
}

async function setup() {
  const home = makeTempDir('station-producer-proxy-');
  const store = new TelemetryProducerStore({
    securityDir: join(home, 'security'),
  });
  const emitted: MonitoringEvent[] = [];
  const app = new Hono();
  configureRuntimeHttp({
    app: app as never,
    logger: logger(),
    eventBus: { emit: vi.fn() } as unknown as EventBus,
    security: {
      verifyCredential: () => false,
      resolveGrantedScope: () => undefined,
      telemetryProducers: store,
    },
  } as Parameters<typeof configureRuntimeHttp>[0]);
  app.route(
    '',
    createOtlpReceiverRoutes(
      (event) => emitted.push(event),
      () => 'station-owner',
      admittedTelemetryProducer,
    ),
  );
  const upstreamHits: string[] = [];
  const api = serve({
    // Every request that reaches the API, before any middleware answers it.
    fetch: (request, env) => {
      upstreamHits.push(`${request.method} ${new URL(request.url).pathname}`);
      return app.fetch(request, env);
    },
    port: 0,
    hostname: '127.0.0.1',
  });
  await once(api as unknown as Server, 'listening');
  closers.push(
    () => new Promise<void>((resolve) => api.close(() => resolve())),
  );
  const apiPort = (api.address() as { port: number }).port;

  const uiDir = makeTempDir('station-producer-proxy-ui-');
  const handler = uiRequestHandler({
    backendPrefixes: UI_PROXY_BACKEND_PREFIXES,
    backendNavigationPrefixes: UI_PROXY_BACKEND_NAVIGATION_PREFIXES,
    crypto,
    dir: uiDir,
    fs,
    http,
    inject: '',
    mime: UI_MIME_TYPES,
    path,
    upstreamPort: apiPort,
    internalApiToken: getInternalApiToken(),
    trustedTailscaleServeOrigin: `https://${SERVE_HOST}`,
  });
  const uiPort = await listen(createServer(handler));

  const create = async (name: string, allowRemote = false) =>
    (
      await store.create({
        name,
        allowRemote,
        expiresInDays: null,
        ownerPrincipalId: 'operator-principal',
      })
    ).secret;

  /** One request to the UI proxy, the way a producer or Serve would send it. */
  const viaProxy = (
    pathName: string,
    init: {
      method?: string;
      token?: string;
      host: string;
      headers?: Record<string, string>;
    },
  ) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const body = JSON.stringify({
        schema_version: '0.3.0',
        timestamp: `${Date.now()}`,
        session_id: 'codex-session',
        event_id: 'event-1',
        event_type: 'tool.invoke',
        agent: { name: 'codex', runtime: 'codex', version: '1.0.0' },
      });
      const method = init.method ?? 'POST';
      const request = http.request(
        {
          host: '127.0.0.1',
          port: uiPort,
          path: pathName,
          method,
          headers: {
            host: init.host,
            accept: 'application/json',
            'content-type': 'application/json',
            ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
            ...(method === 'POST'
              ? { 'content-length': Buffer.byteLength(body) }
              : {}),
            ...init.headers,
          },
        },
        (response) => {
          let text = '';
          response.on('data', (chunk) => {
            text += String(chunk);
          });
          response.on('end', () =>
            resolve({ status: response.statusCode ?? 0, body: text }),
          );
        },
      );
      request.on('error', reject);
      if (method === 'POST') request.write(body);
      request.end();
    });

  /** The headers Tailscale Serve adds for a tailnet user. */
  const serveHeaders = {
    'x-forwarded-for': '100.64.1.2',
    'x-forwarded-proto': 'https',
    'tailscale-user-login': 'casey@example.test',
    'tailscale-user-name': 'Casey',
    'tailscale-headers-info': 'https://tailscale.com/s/serve-headers',
  };
  return { create, viaProxy, serveHeaders, emitted, upstreamHits, uiPort };
}

describe('telemetry producers through the UI proxy (real sockets)', () => {
  test('a local sender through the UI proxy is local', async () => {
    const h = await setup();
    const token = await h.create('local-only');
    const response = await h.viaProxy('/v1/agent-events', {
      token,
      host: `127.0.0.1:${h.uiPort}`,
    });
    expect(response.status, response.body).toBe(200);
    expect(h.emitted[0]?.[K.TELEMETRY_PRODUCER]).toBe('local-only');
  });

  test('a Tailscale Serve request is remote: 403 without remote access, 200 with it', async () => {
    const h = await setup();
    const local = await h.create('local-only');
    const remote = await h.create('tailnet', true);

    const refused = await h.viaProxy('/v1/agent-events', {
      token: local,
      host: SERVE_HOST,
      headers: h.serveHeaders,
    });
    expect(refused.status, refused.body).toBe(403);
    expect(JSON.parse(refused.body)).toEqual({
      error: { code: 'telemetry_producer_remote_not_allowed' },
    });

    const admitted = await h.viaProxy('/v1/agent-events', {
      token: remote,
      host: SERVE_HOST,
      headers: h.serveHeaders,
    });
    expect(admitted.status, admitted.body).toBe(200);
    expect(h.emitted.map((event) => event[K.TELEMETRY_PRODUCER])).toEqual([
      'tailnet',
    ]);
  });

  test('forwarding evidence alone marks a proxied request remote, even with a loopback Host', async () => {
    // The proxy strips the client's `x-forwarded-*` and `tailscale-*`
    // headers; its own marker is what carries the fact upstream.
    const h = await setup();
    const local = await h.create('local-only');
    const response = await h.viaProxy('/v1/agent-events', {
      token: local,
      host: `127.0.0.1:${h.uiPort}`,
      headers: { 'x-forwarded-for': '100.64.1.2' },
    });
    expect(response.status, response.body).toBe(403);
    expect(h.emitted).toHaveLength(0);
  });

  test('a GET to an ingest path is not forwarded to the API', async () => {
    const h = await setup();
    const token = await h.create('local-only');
    for (const pathName of ['/v1/agent-events', '/v1/traces', '/v1/other']) {
      const response = await h.viaProxy(pathName, {
        method: 'GET',
        token,
        host: `127.0.0.1:${h.uiPort}`,
      });
      expect(response.status).toBe(404);
    }
    expect(h.upstreamHits).toEqual([]);
  });

  test('a producer token on another /v1 POST reaches no handler', async () => {
    const h = await setup();
    const token = await h.create('local-only');
    const response = await h.viaProxy('/v1/other', {
      token,
      host: `127.0.0.1:${h.uiPort}`,
    });
    // Forwarded (the proxy forwards every non-GET), where the token is not a
    // credential: the `/v1` family needs a paired operate credential.
    expect(response.status).toBe(401);
    expect(h.emitted).toHaveLength(0);
  });
});

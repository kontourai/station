import * as crypto from 'node:crypto';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { networkInterfaces, tmpdir } from 'node:os';
import * as path from 'node:path';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { DEFAULT_GRANT_PAIRING_SCOPE } from '@kontourai/station-contracts';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  UI_MIME_TYPES,
  UI_PROXY_BACKEND_PREFIXES,
  uiRequestHandler,
} from '../../../packages/cli/src/commands/lifecycle.js';
import type { EventBus } from '../../services/orchestration/event-bus.js';
import { DevicePairingService } from '../../services/ssh/device-pairing-service.js';
import {
  getInternalApiToken,
  INTERNAL_PROXY_PEER_HEADER,
} from '../../utils/internal-api-token.js';
import type { Logger } from '../../utils/logger.js';
import { configureRuntimeHttp } from '../bootstrap/runtime-http.js';
import {
  configureDevicePairingHostRoutes,
  configureDevicePairingPublicRoutes,
} from '../routes/runtime-routes.js';

/**
 * station#1490, over REAL sockets.
 *
 * Every other test of this guard hands the middleware a synthetic
 * `{incoming:{socket:{remoteAddress}}}`, which cannot catch anything that only
 * exists in the transport: what the kernel actually reports as the peer of a
 * connection to this host's own address, and what Station's own UI proxy does
 * to a request on its way through. Both decide whether a pairing request is
 * approvable, and the second was wrong until the proxy started attesting the
 * address it saw.
 *
 * A genuinely off-box peer cannot be produced on one host, so its grant path
 * remains covered by synthetic-socket injection in
 * `device-pairing-routes.test.ts`. This suite instead proves the real transport
 * and proxy peer metadata cannot let an unauthenticated loopback caller approve
 * a request, and that a verified operator can subsequently make the explicit
 * approval decision without the rejected attempt consuming it.
 */
const ENVIRONMENT_ID = '11111111-1111-4111-8111-111111111111';
const LOOPBACK = '127.0.0.1';
const OPERATOR_CREDENTIAL = 'pairing-transport-operator-credential';
const closers: Array<() => void | Promise<void>> = [];
const homes: string[] = [];

function hostOwnIpv4(): string | undefined {
  return Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .find((entry) => entry.family === 'IPv4' && !entry.internal)?.address;
}

function createPairingApp(allowedOrigins: string[]) {
  const homeDir = mkdtempSync(join(tmpdir(), 'station-pairing-transport-'));
  homes.push(homeDir);
  mkdirSync(join(homeDir, 'security'), { mode: 0o700 });
  const pairing = new DevicePairingService({
    homeDir,
    environmentId: ENVIRONMENT_ID,
  });
  const logger: Logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
    setLevel: vi.fn(),
    getLevel: vi.fn(() => 'info' as const),
  };
  const app = new Hono();
  configureDevicePairingPublicRoutes(app as never, pairing, {
    // Read per request, so a proxy origin can be admitted once its port is
    // known — the same shape as a deployment configuring its UI origin.
    allowedOrigins,
  });
  configureRuntimeHttp({
    app: app as never,
    logger,
    eventBus: { emit: vi.fn() } as unknown as EventBus,
    security: {
      verifyCredential: (candidate) => candidate === OPERATOR_CREDENTIAL,
      resolveGrantedScope: () => DEFAULT_GRANT_PAIRING_SCOPE,
      allowedOrigins,
    },
  });
  configureDevicePairingHostRoutes(app as never, pairing);
  return app;
}

/** The real app on a real listener bound to every interface. */
async function listenPairingApi(): Promise<{
  port: number;
  allowedOrigins: string[];
}> {
  const allowedOrigins: string[] = [];
  const server = serve({
    fetch: createPairingApp(allowedOrigins).fetch,
    port: 0,
  });
  await once(server as unknown as Server, 'listening');
  closers.push(() => new Promise((resolve) => server.close(() => resolve())));
  return { port: (server.address() as { port: number }).port, allowedOrigins };
}

/** Station's own UI proxy, unmodified, in front of `upstreamPort`. */
async function listenUiProxy(upstreamPort: number): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), 'station-pairing-ui-'));
  homes.push(dir);
  const server = createServer(
    uiRequestHandler({
      backendPrefixes: UI_PROXY_BACKEND_PREFIXES,
      crypto,
      dir,
      fs,
      http: await import('node:http'),
      inject: '',
      mime: UI_MIME_TYPES,
      path,
      upstreamPort,
      internalApiToken: getInternalApiToken(),
    }),
  );
  server.listen(0, '0.0.0.0');
  await once(server, 'listening');
  closers.push(() => new Promise((resolve) => server.close(() => resolve())));
  return (server.address() as { port: number }).port;
}

/**
 * The proxy in front of `upstreamPort`, with each incoming request's socket
 * address made unreadable before the handler sees it. Real socket, real
 * handler, real upstream — only the one field the strip below defends against
 * is removed, which is otherwise not producible over TCP.
 */
async function listenUiProxyWithUnreadablePeer(
  upstreamPort: number,
): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), 'station-pairing-ui-'));
  homes.push(dir);
  const handler = uiRequestHandler({
    backendPrefixes: UI_PROXY_BACKEND_PREFIXES,
    crypto,
    dir,
    fs,
    http: await import('node:http'),
    inject: '',
    mime: UI_MIME_TYPES,
    path,
    upstreamPort,
    internalApiToken: getInternalApiToken(),
  });
  const server = createServer((req, res) => {
    Object.defineProperty(req.socket, 'remoteAddress', {
      value: undefined,
      configurable: true,
    });
    handler(req, res);
  });
  server.listen(0, LOOPBACK);
  await once(server, 'listening');
  closers.push(() => new Promise((resolve) => server.close(() => resolve())));
  return (server.address() as { port: number }).port;
}

/** A recording upstream, for asserting what the proxy forwards. */
async function listenRecordingUpstream(): Promise<{
  port: number;
  received: IncomingMessage[];
}> {
  const received: IncomingMessage[] = [];
  const server = createServer((req, res) => {
    received.push(req);
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  server.listen(0, LOOPBACK);
  await once(server, 'listening');
  closers.push(() => new Promise((resolve) => server.close(() => resolve())));
  return { port: (server.address() as { port: number }).port, received };
}

async function accessRequest(
  host: string,
  port: number,
  deviceName: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(
    `http://${host}:${port}/.well-known/station/v1/pairing/access-request`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: `http://${host}:${port}`,
        ...headers,
      },
      body: JSON.stringify({ deviceName }),
    },
  );
}

const confirm = (
  host: string,
  port: number,
  requestId: string,
  authenticated = false,
) =>
  fetch(`http://${host}:${port}/api/pairing/requests/${requestId}/confirm`, {
    method: 'POST',
    headers: authenticated
      ? { Authorization: `Bearer ${OPERATOR_CREDENTIAL}` }
      : undefined,
  });

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

describe('pairing approval over a real transport (station#1490)', () => {
  test('a request dialled to this host own address cannot be approved by an unauthenticated loopback caller', async () => {
    const own = hostOwnIpv4();
    // Every machine that can run this suite has a non-internal IPv4 address.
    // A skip here would read as coverage while proving nothing.
    expect(own).toBeDefined();
    const { port } = await listenPairingApi();

    const access = await accessRequest(own as string, port, 'Self dial');
    expect(access.status).toBe(202);
    const { requestId } = (await access.json()) as { requestId: string };

    // station#2090: #2051 deliberately moved the credential floor ahead of
    // the peer classification guard. Loopback is not operator authority, so
    // this caller cannot approve the request regardless of which host address
    // the kernel reported for the access request.
    const approval = await confirm(LOOPBACK, port, requestId);
    expect(approval.status).toBe(401);
    expect(await approval.json()).toEqual({
      error: { code: 'authentication_required' },
    });

    // Authentication failure must not consume the request. A verified
    // operator can still make the explicit approval decision afterward.
    expect((await confirm(LOOPBACK, port, requestId, true)).status).toBe(200);
  });

  test('a proxied loopback request requires a verified operator to approve', async () => {
    const { port: apiPort, allowedOrigins } = await listenPairingApi();
    const uiPort = await listenUiProxy(apiPort);
    // The proxy rewrites Host to the upstream authority, so the browser's
    // Origin only matches through the allowlist — as it does in a deployment.
    allowedOrigins.push(`http://${LOOPBACK}:${uiPort}`);

    const access = await accessRequest(LOOPBACK, uiPort, 'Proxied browser');
    expect(access.status).toBe(202);
    const { requestId } = (await access.json()) as { requestId: string };

    // The proxy opens its own loopback connection upstream, so without its
    // attestation this request is indistinguishable from a phone's. With it,
    // the upstream judges the address the proxy actually saw.
    expect((await confirm(LOOPBACK, apiPort, requestId)).status).toBe(401);
    expect((await confirm(LOOPBACK, apiPort, requestId, true)).status).toBe(
      200,
    );
  });

  test('a proxied host-address request requires a verified operator to approve', async () => {
    const own = hostOwnIpv4();
    expect(own).toBeDefined();
    const { port: apiPort, allowedOrigins } = await listenPairingApi();
    const uiPort = await listenUiProxy(apiPort);
    allowedOrigins.push(`http://${own}:${uiPort}`);

    const access = await accessRequest(
      own as string,
      uiPort,
      'Proxied self dial',
    );
    expect(access.status).toBe(202);
    const { requestId } = (await access.json()) as { requestId: string };

    // The attested path must not become a way back in: the proxy reports a
    // non-loopback address here, and it is still one this host holds.
    expect((await confirm(LOOPBACK, apiPort, requestId)).status).toBe(401);
    expect((await confirm(LOOPBACK, apiPort, requestId, true)).status).toBe(
      200,
    );
  });

  test('the proxy forwards no peer at all when it cannot read one, rather than the client claim', async () => {
    const upstream = await listenRecordingUpstream();
    const uiPort = await listenUiProxyWithUnreadablePeer(upstream.port);

    await accessRequest(LOOPBACK, uiPort, 'Forging client', {
      [INTERNAL_PROXY_PEER_HEADER]: '198.51.100.42',
    });

    // The strip is the only thing standing here: the proxy writes its own
    // value over the client's on every ordinary request, so this is the one
    // shape in which a relayed claim would survive — and it would arrive
    // token-attested, which is exactly what the upstream trusts.
    expect(upstream.received).toHaveLength(1);
    expect(
      upstream.received[0].headers[INTERNAL_PROXY_PEER_HEADER],
    ).toBeUndefined();
  });

  test('the proxy attests the address it saw and refuses to relay a client supplied one', async () => {
    const upstream = await listenRecordingUpstream();
    const uiPort = await listenUiProxy(upstream.port);

    await accessRequest(LOOPBACK, uiPort, 'Forging client', {
      // A client claiming to be off-box. If this reached the upstream, every
      // refusal above would be one header away from a grant.
      [INTERNAL_PROXY_PEER_HEADER]: '198.51.100.42',
    });

    expect(upstream.received).toHaveLength(1);
    const forwarded = upstream.received[0].headers[INTERNAL_PROXY_PEER_HEADER];
    expect(forwarded).not.toBe('198.51.100.42');
    expect(String(forwarded).replace('::ffff:', '')).toBe(LOOPBACK);
  });
});

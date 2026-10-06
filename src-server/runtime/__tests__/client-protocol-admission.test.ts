import { request as nodeRequest } from 'node:http';
import { type HttpBindings, serve } from '@hono/node-server';
import { DEFAULT_GRANT_PAIRING_SCOPE } from '@kontourai/station-contracts';
import {
  DEPLOYMENT_AUTHENTICATION_VERSION,
  type DeploymentAuthenticationProvider,
} from '@kontourai/station-contracts/deployment-authentication';
import {
  CLIENT_PROTOCOL_HEADER,
  PUBLIC_DEVICE_PAIRING_ACCESS_REQUEST_PATH,
  PUBLIC_DEVICE_PAIRING_EXCHANGE_PATH,
  PUBLIC_DEVICE_PAIRING_REQUEST_PATH,
  PUBLIC_STATION_HANDSHAKE_PATH,
  STATION_COMPAT_MIN_CLIENT_PROTOCOL,
  STATION_COMPAT_PROTOCOL_VERSION,
} from '@kontourai/station-contracts/environment-security';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import {
  CLIENT_PROTOCOL_NAVIGATION_EXEMPT_RULE_IDS,
  type ClientProtocolPolicy,
} from '../../security/client-protocol-admission.js';
import type { RuntimeSecurityAuditRecord } from '../../security/runtime-request-security.js';
import { DeploymentAuthenticationService } from '../../services/identity/deployment-authentication-service.js';
import type { EventBus } from '../../services/orchestration/event-bus.js';
import { HOST_STATION_COMPATIBILITY } from '../../services/ssh/environment-security-service.js';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_PROXY_CALLER_HEADER,
} from '../../utils/internal-api-token.js';
import type { Logger } from '../../utils/logger.js';
import { configureRuntimeHttp } from '../bootstrap/runtime-http.js';
import { configureRuntimePublicRoutes } from '../routes/runtime-routes.js';

const CREDENTIAL = 'client-protocol-test-credential';
const ALLOWED_ORIGIN = 'https://station.example.test';

type TestBindings = HttpBindings & {
  incoming: HttpBindings['incoming'] & {
    socket: HttpBindings['incoming']['socket'] & { remoteAddress?: string };
  };
};

/**
 * The production composition order: the runtime boundary first, then the
 * public discovery and pairing routes, then protected routes behind it.
 * `policy` is the test seam; omitting it enforces what the host advertises.
 */
function createHarness(
  policy?: ClientProtocolPolicy,
  deploymentAuthentication?: DeploymentAuthenticationService,
) {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
    setLevel: vi.fn(),
    getLevel: vi.fn(() => 'info' as const),
  } as unknown as Logger;
  const app = new Hono<{ Bindings: TestBindings }>();
  const reached: string[] = [];
  const audits: RuntimeSecurityAuditRecord[] = [];
  configureRuntimeHttp({
    app: app as never,
    logger,
    eventBus: { emit: vi.fn() } as unknown as EventBus,
    security: {
      deploymentAuthentication,
      verifyCredential: (candidate: string) => candidate === CREDENTIAL,
      resolveGrantedScope: (candidate: string) =>
        candidate === CREDENTIAL ? DEFAULT_GRANT_PAIRING_SCOPE : undefined,
      resolveCredentialAuthority: () => 'operator-credential',
      allowedOrigins: [ALLOWED_ORIGIN],
      audit: (record: RuntimeSecurityAuditRecord) => audits.push(record),
      ...(policy ? { clientCompatibility: policy } : {}),
    },
  } as Parameters<typeof configureRuntimeHttp>[0]);
  configureRuntimePublicRoutes(app as never, {
    getPublicHandshake: async () =>
      ({
        schemaVersion: 1,
        environmentId: 'environment-1',
        compatibility: { ...(policy ?? HOST_STATION_COMPATIBILITY) },
      }) as never,
    createPublicProof: async () => {
      throw new Error('not used');
    },
  });
  for (const path of [
    PUBLIC_DEVICE_PAIRING_REQUEST_PATH,
    PUBLIC_DEVICE_PAIRING_ACCESS_REQUEST_PATH,
    PUBLIC_DEVICE_PAIRING_EXCHANGE_PATH,
  ]) {
    app.post(path, (c) => {
      reached.push(path);
      return c.json({ reached: true });
    });
  }
  for (const path of ['/', '/doc', '/ui', '/integrations/github/icon']) {
    app.get(path, (c) => {
      reached.push(path);
      return c.json({ reached: true });
    });
  }
  app.get('/api/projects', (c) => {
    reached.push('projects');
    return c.json({ reached: true });
  });

  function request(
    path: string,
    init: RequestInit = {},
    peerAddress = '203.0.113.9',
  ): Promise<Response> {
    const incoming = { socket: { remoteAddress: peerAddress } };
    return Promise.resolve(
      app.request(path, init, { incoming } as TestBindings),
    );
  }
  return { app, reached, request, audits };
}

function api(protocol?: string, extra: Record<string, string> = {}) {
  return {
    headers: {
      Authorization: `Bearer ${CREDENTIAL}`,
      ...(protocol === undefined ? {} : { [CLIENT_PROTOCOL_HEADER]: protocol }),
      ...extra,
    },
  };
}

/** Raised minimum: this host speaks 3 and still serves N−1 (2). */
const RAISED: ClientProtocolPolicy = {
  serverVersion: '9.9.9',
  protocolVersion: 3,
  minClientProtocol: 2,
};

describe('client API protocol admission (#2962)', () => {
  it('keeps the minimum at legacy protocol while known undeclared callers remain', () => {
    // Rollout blockers independently identified at their request owners. Remove
    // an entry only with carriage evidence, not merely a protocol-constant bump.
    const knownUndeclaredCallers = [
      'native pairing exchange: src-desktop/src/lib.rs',
      'notification action: src-ui/src/components/notifications/NotificationContainer.tsx',
      'local UI identity: src-ui/src/lib/local-ui-bootstrap.ts',
      'operate event stream: packages/cli/src/commands/operate/shell.ts',
    ];
    expect(
      STATION_COMPAT_MIN_CLIENT_PROTOCOL <= 1 ||
        knownUndeclaredCallers.length === 0,
      `Cannot raise minClientProtocol above 1 while callers remain undeclared: ${knownUndeclaredCallers.join('; ')}`,
    ).toBe(true);
  });

  it('enforces exactly what the handshake advertises, which today admits every client', async () => {
    // Pinned beside the constants so a bump is a deliberate edit here too.
    expect(STATION_COMPAT_PROTOCOL_VERSION).toBe(1);
    expect(STATION_COMPAT_MIN_CLIENT_PROTOCOL).toBe(1);
    const { request } = createHarness();
    const handshake = await (
      await request(PUBLIC_STATION_HANDSHAKE_PATH)
    ).json();
    expect(handshake).toHaveProperty('compatibility.minClientProtocol', 1);
    expect((await request('/api/projects', api())).status).toBe(200);
    expect((await request('/api/projects', api('1'))).status).toBe(200);
  });

  it('admits in-range and N−1 clients and refuses below the minimum with readable remediation', async () => {
    const { request, reached } = createHarness(RAISED);
    expect((await request('/api/projects', api('3'))).status).toBe(200);
    // N−1: the previous client train stays admitted during a rollout.
    expect((await request('/api/projects', api('2'))).status).toBe(200);
    // A client newer than the host is the client's own decision to make.
    expect((await request('/api/projects', api('4'))).status).toBe(200);
    expect(reached).toEqual(['projects', 'projects', 'projects']);

    const refused = await request('/api/projects', api('1'));
    expect(refused.status).toBe(426);
    const body = await refused.json();
    expect(body).toEqual({
      error: {
        code: 'client_protocol_unsupported',
        message: expect.stringContaining('Update this app. Station 9.9.9'),
        clientProtocol: 1,
        minClientProtocol: 2,
        protocolVersion: 3,
        serverVersion: '9.9.9',
      },
    });
    expect(body).toHaveProperty(
      'error.message',
      expect.stringContaining('needs client protocol 2'),
    );
    expect(reached).toHaveLength(3);
  });

  it('reads an absent header as protocol 1: admitted at minimum 1, refused at minimum 2', async () => {
    const atOne = createHarness({ ...RAISED, minClientProtocol: 1 });
    expect((await atOne.request('/api/projects', api())).status).toBe(200);

    const atTwo = createHarness(RAISED);
    const refused = await atTwo.request('/api/projects', api());
    expect(refused.status).toBe(426);
    const body = await refused.json();
    expect(body).toHaveProperty('error.clientProtocol', 1);
    expect(body).toHaveProperty(
      'error.message',
      expect.stringContaining('did not say which protocol it speaks'),
    );
    expect(atTwo.reached).toEqual([]);
  });

  it('refuses a malformed header with 400 even where any declared value would pass', async () => {
    const { request, reached } = createHarness();
    for (const value of [
      '',
      '0',
      '-1',
      '+2',
      '02',
      '1.0',
      '1e3',
      'two',
      '0x10',
      '10000',
      '99999999999999999999999',
    ]) {
      const response = await request('/api/projects', api(value));
      expect(response.status, `value ${JSON.stringify(value)}`).toBe(400);
      expect(await response.json()).toHaveProperty(
        'error.code',
        'client_protocol_invalid',
      );
    }
    // Repeated headers are joined into one value and are not a protocol.
    const repeated = new Headers({ Authorization: `Bearer ${CREDENTIAL}` });
    repeated.append(CLIENT_PROTOCOL_HEADER, '2');
    repeated.append(CLIENT_PROTOCOL_HEADER, '3');
    expect((await request('/api/projects', { headers: repeated })).status).toBe(
      400,
    );
    // The largest legal value is still declared, not refused.
    expect((await request('/api/projects', api('9999'))).status).toBe(200);
    expect(reached).toEqual(['projects']);
  });

  it('refuses duplicate header lines arriving on a real socket', async () => {
    const { app } = createHarness();
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.once('listening', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('missing test port');
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const request = nodeRequest(
          {
            hostname: '127.0.0.1',
            port: address.port,
            path: '/api/projects',
            method: 'GET',
            headers: [
              'Authorization',
              `Bearer ${CREDENTIAL}`,
              CLIENT_PROTOCOL_HEADER,
              '1',
              CLIENT_PROTOCOL_HEADER,
              '1',
            ],
          },
          (response) => {
            response.resume();
            response.once('end', () => resolve(response.statusCode ?? 0));
          },
        );
        request.once('error', reject);
        request.end();
      });
      expect(status).toBe(400);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('refuses before authentication, so an outdated client is not told to re-pair', async () => {
    const { request } = createHarness(RAISED);
    const response = await request('/api/projects', {
      headers: { [CLIENT_PROTOCOL_HEADER]: '1' },
    });
    expect(response.status).toBe(426);
  });

  it('covers the pairing ceremony an outdated client would otherwise complete', async () => {
    const { request, reached } = createHarness(RAISED);
    for (const path of [
      PUBLIC_DEVICE_PAIRING_REQUEST_PATH,
      PUBLIC_DEVICE_PAIRING_ACCESS_REQUEST_PATH,
      PUBLIC_DEVICE_PAIRING_EXCHANGE_PATH,
    ]) {
      const old = await request(path, { method: 'POST' });
      expect(old.status, path).toBe(426);
      expect(await old.json()).toHaveProperty(
        'error.code',
        'client_protocol_unsupported',
      );
      const current = await request(path, {
        method: 'POST',
        headers: { [CLIENT_PROTOCOL_HEADER]: '2' },
      });
      expect(current.status, path).toBe(200);
    }
    expect(reached).toEqual([
      PUBLIC_DEVICE_PAIRING_REQUEST_PATH,
      PUBLIC_DEVICE_PAIRING_ACCESS_REQUEST_PATH,
      PUBLIC_DEVICE_PAIRING_EXCHANGE_PATH,
    ]);
  });

  it('keeps the handshake and liveness reachable so a refused client can learn why', async () => {
    const { request, reached } = createHarness(RAISED);
    const handshake = await request(PUBLIC_STATION_HANDSHAKE_PATH, {
      headers: { [CLIENT_PROTOCOL_HEADER]: '1' },
    });
    expect(handshake.status).toBe(200);
    expect(await handshake.json()).toHaveProperty(
      'compatibility',
      expect.objectContaining({ minClientProtocol: 2, serverVersion: '9.9.9' }),
    );
    const liveness = await request('/api/system/liveness');
    expect(liveness.status).toBe(200);
    expect(await liveness.json()).toEqual({ live: true });
    expect(reached).toEqual([]);
  });

  it("exempts only Station's own attested loopback consumer", async () => {
    const { request } = createHarness(RAISED);
    const internal = {
      Authorization: `Bearer ${CREDENTIAL}`,
      [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
    };
    expect(
      (
        await request(
          '/api/projects',
          { headers: { ...internal, [INTERNAL_PROXY_CALLER_HEADER]: 'local' } },
          '127.0.0.1',
        )
      ).status,
    ).toBe(200);
    // The UI proxy forwards browser traffic as `remote`: still a client.
    expect(
      (
        await request(
          '/api/projects',
          {
            headers: { ...internal, [INTERNAL_PROXY_CALLER_HEADER]: 'remote' },
          },
          '127.0.0.1',
        )
      ).status,
    ).toBe(426);
    // Claiming `local` from off the machine earns nothing.
    expect(
      (
        await request('/api/projects', {
          headers: { ...internal, [INTERNAL_PROXY_CALLER_HEADER]: 'local' },
        })
      ).status,
    ).toBe(426);
  });

  it('lets a browser preflight the header and read the refusal', async () => {
    const { request } = createHarness(RAISED);
    const preflight = await request('/api/projects', {
      method: 'OPTIONS',
      headers: {
        Origin: ALLOWED_ORIGIN,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': `authorization, ${CLIENT_PROTOCOL_HEADER.toLowerCase()}`,
      },
    });
    expect(preflight.status).toBe(204);
    const allowed = (
      preflight.headers.get('Access-Control-Allow-Headers') ?? ''
    )
      .split(',')
      .map((name) => name.trim().toLowerCase());
    expect(allowed).toContain(CLIENT_PROTOCOL_HEADER.toLowerCase());

    const refused = await request(
      '/api/projects',
      api('1', { Origin: ALLOWED_ORIGIN }),
    );
    expect(refused.status).toBe(426);
    expect(refused.headers.get('Access-Control-Allow-Origin')).toBe(
      ALLOWED_ORIGIN,
    );
  });

  it('advertises the header in its handshake exactly because it allow-lists it', async () => {
    const { request } = createHarness();
    const handshake = await (
      await request(PUBLIC_STATION_HANDSHAKE_PATH)
    ).json();
    expect(handshake).toHaveProperty(
      'compatibility.capabilities.clientProtocolHeader',
      1,
    );
    const preflight = await request('/api/projects', {
      method: 'OPTIONS',
      headers: {
        Origin: ALLOWED_ORIGIN,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'x-station-client-protocol',
      },
    });
    expect(preflight.headers.get('Access-Control-Allow-Headers')).toContain(
      'X-Station-Client-Protocol',
    );
  });

  it('exempts only navigation-reached routes, which cannot carry a header', async () => {
    // Pinned literally: widening the exemption is a deliberate edit here.
    expect([...CLIENT_PROTOCOL_NAVIGATION_EXEMPT_RULE_IDS].sort()).toEqual([
      '/:landing-read',
      '/doc:read',
      '/integrations/:id/icon:read',
      '/ui:read',
    ]);
    const { request, reached } = createHarness(RAISED);
    const noHeader = { headers: { Authorization: `Bearer ${CREDENTIAL}` } };
    for (const path of ['/', '/doc', '/ui', '/integrations/github/icon']) {
      expect((await request(path, noHeader)).status, path).toBe(200);
    }
    expect(reached).toEqual(['/', '/doc', '/ui', '/integrations/github/icon']);
    // A sibling in the same family is not exempt.
    expect((await request('/api/projects', noHeader)).status).toBe(426);
  });

  it('bounds unauthenticated protocol refusal audits by a separate peer audit budget', async () => {
    const { request, audits, reached } = createHarness(RAISED);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const protocol = attempt % 2 === 0 ? 'invalid' : '1';
      const response = await request('/api/projects', {
        headers: { [CLIENT_PROTOCOL_HEADER]: protocol },
      });
      expect(response.status).toBe(protocol === 'invalid' ? 400 : 426);
    }
    expect(
      audits,
      '100 refusals from one peer must emit only 10 audits',
    ).toHaveLength(10);
    expect(reached).toEqual([]);
    expect(
      (
        await request(
          '/api/projects',
          { headers: { [CLIENT_PROTOCOL_HEADER]: 'invalid' } },
          '203.0.113.10',
        )
      ).status,
    ).toBe(400);
    expect(
      audits.filter((record) => record.reason === 'client_protocol_invalid'),
    ).toHaveLength(6);
  });

  it('admits a valid deployment-account client after malformed protocol refusals', async () => {
    const now = Date.parse('2026-10-03T12:00:00Z');
    const authenticate = vi.fn<
      DeploymentAuthenticationProvider['authenticate']
    >(async () => ({
      kind: 'authenticated',
      session: {
        subject: 'opaque-person',
        displayName: 'Example Person',
        sessionId: 'session-record',
        authenticatedAt: '2026-10-03T11:00:00Z',
        expiresAt: '2026-10-03T13:00:00Z',
        contacts: [],
      },
    }));
    const authentication = new DeploymentAuthenticationService(
      {
        version: DEPLOYMENT_AUTHENTICATION_VERSION,
        issuer: 'https://identity.example.test',
        displayName: 'Example login',
        sessionCookies: ['fixture_account'],
        endpoints: [
          { path: '/logout', methods: ['POST'], operation: 'logout' },
        ],
        authenticate,
        handle: async () => new Response(null, { status: 204 }),
      },
      () => now,
    );
    const { request, reached } = createHarness(RAISED, authentication);
    for (let attempt = 0; attempt < 12; attempt += 1) {
      expect((await request('/api/projects', api('invalid'))).status).toBe(400);
    }
    expect(authenticate).not.toHaveBeenCalled();
    expect(
      (
        await request(
          '/api/projects',
          api('2', { Cookie: 'fixture_account=valid' }),
        )
      ).status,
    ).toBe(200);
    expect(authenticate).toHaveBeenCalled();
    expect(reached).toEqual(['projects']);
  });

  it('audits refusals within the budget without recording the raw header', async () => {
    const { request, audits } = createHarness(RAISED);
    await request('/api/projects', api('1'));
    await request('/api/projects', api('not-a-number'));
    await request('/api/projects', api('3'));
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({
      event: 'station.auth.failure',
      outcome: 'denied',
      reason: 'client_protocol_unsupported',
      clientProtocol: 1,
      routeClass: 'protected',
      path: '/api/projects',
    });
    expect(audits[1]).toMatchObject({ reason: 'client_protocol_invalid' });
    expect(JSON.stringify(audits)).not.toContain('not-a-number');
  });
});

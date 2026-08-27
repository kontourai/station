import { request as nodeRequest } from 'node:http';
import { type HttpBindings, serve } from '@hono/node-server';
import { DEFAULT_GRANT_PAIRING_SCOPE } from '@kontourai/station-contracts';
import { STATION_PLUGIN_HEADER } from '@kontourai/station-contracts/http';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SharedWorkingState } from '../../domain/shared-working-state.js';
import { createProjectTaskRoomRoutes } from '../../routes/orchestration/project-task-rooms.js';
import { assertRuntimeHttpRouteCoverage } from '../../security/pairing-route-scopes.js';
import {
  classifyDirectDeviceActivityPeer,
  getRuntimeAuthenticatedRequestPrincipal,
  type RuntimeDeviceActivityClassifierContext,
  resolveClientOriginForRequest,
} from '../../security/runtime-request-security.js';
import type { EventBus } from '../../services/orchestration/event-bus.js';
import { ProjectTaskRoomRuntime } from '../../services/orchestration/project-task-room-runtime.js';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_INGRESS_IDENTITY_HEADER,
  INTERNAL_PROXY_CALLER_HEADER,
  INTERNAL_PROXY_PEER_HEADER,
} from '../../utils/internal-api-token.js';
import type { Logger } from '../../utils/logger.js';
import { configureRuntimeHttp } from '../bootstrap/runtime-http.js';
import {
  classifyRuntimePairedDeviceActivity,
  configureRuntimePublicRoutes,
  readBoundedRequestBody,
} from '../routes/runtime-routes.js';
import { RUNTIME_AUTH_ROUTE_MATRIX } from './fixtures/runtime-auth-route-matrix.js';

const CREDENTIAL = 'test-only-credential-that-must-never-be-logged';
const DEVICE_CREDENTIAL = 'd'.repeat(43);
const ALLOWED_ORIGIN = 'https://station.example.test';
const HOSTILE_ORIGIN = 'https://hostile.example.test';

type TestBindings = HttpBindings & {
  incoming: HttpBindings['incoming'] & {
    socket: HttpBindings['incoming']['socket'] & { remoteAddress?: string };
  };
};

interface AuditRecord {
  event: string;
  [key: string]: unknown;
}

function createHarness(
  options: {
    now?: () => number;
    maxFailures?: number;
    windowMs?: number;
    /**
     * Extra routes registered behind the same boundary. Deliberately not
     * folded into `RUNTIME_AUTH_ROUTE_MATRIX`: that matrix's cases all
     * assert "an authenticated remote caller reaches this", which is exactly
     * what must NOT hold for the station#1398 fleet-inference family (its
     * `inference:invoke` tier is absent from the fixture credential's
     * default grant, by design).
     */
    extraRoutes?: ReadonlyArray<{
      method: 'GET' | 'POST' | 'ALL';
      path: string;
      onReached?: () => void;
    }>;
    /** Models public/bespoke routes registered after the production boundary. */
    registerBeforeSecurity?: (app: Hono<{ Bindings: TestBindings }>) => void;
    afterSecurity?: (app: Hono<{ Bindings: TestBindings }>) => void;
    activityClassifier?: (
      context: RuntimeDeviceActivityClassifierContext,
    ) => 'loopback' | 'lan' | 'tailnet' | undefined;
    onCredentialVerification?: (request: unknown) => void;
    credentialValid?: () => boolean;
    deviceId?: string;
  } = {},
) {
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
  const auditRecords: AuditRecord[] = [];
  const app = new Hono<{ Bindings: TestBindings }>();
  const runtimeSecurity = {
    verifyCredential: (candidate: string, request: unknown) => {
      options.onCredentialVerification?.(request);
      return (
        candidate === CREDENTIAL ||
        (candidate === DEVICE_CREDENTIAL &&
          (options.credentialValid?.() ?? true))
      );
    },
    // Both fixture credentials carry full scope — this suite is about the
    // peer/credential/origin boundary, not scope tiering (that's
    // pairing-scope-enforcement.test.ts); a fully-scoped credential still
    // correctly fails closed on the one deliberately-unmapped route below.
    resolveGrantedScope: (candidate: string) =>
      candidate === CREDENTIAL || candidate === DEVICE_CREDENTIAL
        ? DEFAULT_GRANT_PAIRING_SCOPE
        : undefined,
    resolveCredentialAuthority: (candidate: string) =>
      candidate === DEVICE_CREDENTIAL
        ? 'device-credential'
        : 'operator-credential',
    resolveCredentialDeviceId: (candidate: string) =>
      candidate === DEVICE_CREDENTIAL
        ? (options.deviceId ?? 'device-1')
        : undefined,
    now: options.now ?? (() => Date.now()),
    maxFailures: options.maxFailures ?? 3,
    windowMs: options.windowMs ?? 60_000,
    audit: (record: AuditRecord) => auditRecords.push(record),
    allowedOrigins: [ALLOWED_ORIGIN],
    ...(options.activityClassifier
      ? { classifyPairedDeviceActivity: options.activityClassifier }
      : {}),
  };

  // This is the intended single runtime seam. It is deliberately supplied to
  // the current implementation so RED proves that the boundary is absent,
  // rather than merely proving that a route forgot its own auth check.
  configureRuntimeHttp({
    app: app as never,
    logger,
    eventBus: { emit: vi.fn() } as unknown as EventBus,
    security: runtimeSecurity,
  } as Parameters<typeof configureRuntimeHttp>[0]);

  options.registerBeforeSecurity?.(app);
  options.afterSecurity?.(app);

  for (const route of RUNTIME_AUTH_ROUTE_MATRIX) {
    app.on(route.method, route.path, (c) =>
      c.json({ reached: true, route: route.name }),
    );
  }
  for (const route of options.extraRoutes ?? []) {
    if (route.method === 'ALL') {
      app.all(route.path, (c) => {
        route.onReached?.();
        return c.json({ reached: true, route: route.path });
      });
    } else {
      app.on(route.method, route.path, (c) => {
        route.onReached?.();
        return c.json({ reached: true, route: route.path });
      });
    }
  }
  app.options('*', (c) => c.body(null, 204));

  async function request(
    path: string,
    init: RequestInit = {},
    peerAddress?: string,
  ): Promise<Response> {
    const socket = { remoteAddress: peerAddress };
    const incoming = { socket };
    return app.request(path, init, { incoming } as TestBindings);
  }

  return { app, auditRecords, logger, request };
}

describe('central runtime HTTP security boundary', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('derives device identity at auth composition and keeps reported metadata non-authoritative', async () => {
    const observed: unknown[] = [];
    const { request } = createHarness({
      deviceId: 'device-auth-7',
      afterSecurity: (app) => {
        app.use('/api/projects', async (c) => {
          observed.push(resolveClientOriginForRequest(c.req.raw));
          return c.json({ reached: true });
        });
      },
    });
    await request('/api/projects', {
      headers: {
        authorization: `Bearer ${DEVICE_CREDENTIAL}`,
        'X-Station-Client-Origin': '1;mobile;1.2.3',
        'X-Station-Device-Id': 'forged',
      },
    });
    expect(observed).toEqual([
      {
        version: 1,
        actor: { kind: 'device', deviceId: 'device-auth-7' },
        reported: { version: 1, surface: 'mobile', build: '1.2.3' },
      },
    ]);
  });

  it('classifies direct activity peers without treating a CGNAT address as verified tailnet', () => {
    expect(classifyDirectDeviceActivityPeer('127.0.0.1')).toBe('loopback');
    expect(classifyDirectDeviceActivityPeer('192.168.20.44')).toBe('lan');
    expect(classifyDirectDeviceActivityPeer('fd7a:115c:a1e0::42')).toBe('lan');
    expect(classifyDirectDeviceActivityPeer('100.96.12.7')).toBeUndefined();
    expect(classifyDirectDeviceActivityPeer('203.0.113.7')).toBeUndefined();
  });

  it('passes only the configured coarse device-activity classification to credential verification', async () => {
    const observed: unknown[] = [];
    const { request } = createHarness({
      activityClassifier: () => 'lan',
      onCredentialVerification: (activity) => observed.push(activity),
    });

    expect(
      (
        await request(
          '/api/projects',
          { headers: { Authorization: `Bearer ${CREDENTIAL}` } },
          '192.168.20.44',
        )
      ).status,
    ).toBe(200);
    expect(observed).toEqual([
      expect.objectContaining({ activity: { lastSeenFrom: 'lan' } }),
    ]);
  });

  it('classifies only attested proxy, tailnet, and direct peers for device activity', async () => {
    const observed: unknown[] = [];
    const { request } = createHarness({
      activityClassifier: classifyRuntimePairedDeviceActivity,
      onCredentialVerification: (request) => observed.push(request),
    });
    const token = getInternalApiToken();

    await request(
      '/api/projects',
      {
        headers: {
          Authorization: `Bearer ${CREDENTIAL}`,
          [INTERNAL_API_TOKEN_HEADER]: token,
          [INTERNAL_PROXY_PEER_HEADER]: '192.168.20.44',
        },
      },
      '127.0.0.1',
    );
    await request(
      '/api/projects',
      {
        headers: {
          Authorization: `Bearer ${CREDENTIAL}`,
          [INTERNAL_PROXY_PEER_HEADER]: '192.168.20.44',
        },
      },
      '127.0.0.1',
    );
    await request(
      '/api/projects',
      {
        headers: {
          Authorization: `Bearer ${CREDENTIAL}`,
          [INTERNAL_API_TOKEN_HEADER]: token,
          [INTERNAL_PROXY_PEER_HEADER]: '203.0.113.7',
        },
      },
      '127.0.0.1',
    );
    await request(
      '/api/projects',
      {
        headers: {
          Authorization: `Bearer ${CREDENTIAL}`,
          [INTERNAL_API_TOKEN_HEADER]: token,
          [INTERNAL_INGRESS_IDENTITY_HEADER]: Buffer.from(
            JSON.stringify({ provider: 'tailscale-serve', login: 'brian' }),
          ).toString('base64url'),
        },
      },
      '127.0.0.1',
    );

    expect(observed).toEqual([
      expect.objectContaining({ activity: { lastSeenFrom: 'lan' } }),
      expect.objectContaining({ activity: { lastSeenFrom: 'loopback' } }),
      expect.objectContaining({ activity: { lastSeenFrom: undefined } }),
      expect.objectContaining({ activity: { lastSeenFrom: 'tailnet' } }),
    ]);
  });

  it.each([
    ['IPv4 loopback', '127.0.0.1'],
    ['IPv6 loopback', '::1'],
    ['IPv4-mapped loopback', '::ffff:127.0.0.1'],
  ])('fails closed for an unauthenticated %s', async (_name, peer) => {
    const { request } = createHarness();
    const response = await request('/api/projects', {}, peer);
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'authentication_required' },
    });
  });

  it.each([
    ['RFC1918 peer', '192.168.20.44'],
    ['tailnet-like peer', '100.96.12.7'],
    ['IPv6 remote peer', 'fd7a:115c:a1e0::42'],
    ['absent peer metadata', undefined],
  ])('fails closed for an unauthenticated %s', async (_name, peer) => {
    const { request } = createHarness();
    const response = await request('/api/projects', {}, peer);
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'authentication_required' },
    });
  });

  it('ignores forwarding headers when the direct peer is remote', async () => {
    const { request } = createHarness();
    const response = await request(
      '/api/projects',
      {
        headers: {
          Forwarded: 'for=127.0.0.1;proto=https',
          'X-Forwarded-For': '127.0.0.1',
          'X-Real-IP': '127.0.0.1',
        },
      },
      '100.96.12.7',
    );
    expect(response.status).toBe(401);
  });

  it('preserves remote authority across the Station-owned loopback proxy hop', async () => {
    const { request } = createHarness();
    const attestation = {
      [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
      [INTERNAL_PROXY_CALLER_HEADER]: 'remote',
    };
    expect(
      (await request('/api/projects', { headers: attestation }, '127.0.0.1'))
        .status,
    ).toBe(401);
    expect(
      (
        await request(
          '/api/projects',
          {
            headers: { ...attestation, Authorization: `Bearer ${CREDENTIAL}` },
          },
          '127.0.0.1',
        )
      ).status,
    ).toBe(200);
  });

  it('accepts local proxy attestation only with its process secret and loopback peer', async () => {
    const { request } = createHarness();
    const local = {
      [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
      [INTERNAL_PROXY_CALLER_HEADER]: 'local',
    };
    expect(
      (await request('/api/projects', { headers: local }, '127.0.0.1')).status,
    ).toBe(200);
    expect(
      (
        await request(
          '/api/projects',
          { headers: { ...local, [INTERNAL_API_TOKEN_HEADER]: 'invalid' } },
          '127.0.0.1',
        )
      ).status,
    ).toBe(401);
    expect(
      (await request('/api/projects', { headers: local }, '100.96.12.7'))
        .status,
    ).toBe(401);
  });

  it.each(RUNTIME_AUTH_ROUTE_MATRIX.filter((route) => route.kind === 'public'))(
    'allows $name without a credential for remote peers',
    async ({ method, path }) => {
      const { request } = createHarness();
      expect((await request(path, { method }, '100.96.12.7')).status).toBe(200);
    },
  );

  it.each(
    RUNTIME_AUTH_ROUTE_MATRIX.filter((route) => route.kind === 'protected'),
  )(
    'denies unauthenticated remote $name',
    async ({ method, path, scopeMapped }) => {
      const { request } = createHarness();
      expect((await request(path, { method }, '100.96.12.7')).status).toBe(
        scopeMapped ? 401 : 403,
      );
    },
  );

  it.each(
    RUNTIME_AUTH_ROUTE_MATRIX.filter(
      (route) => route.kind === 'protected' && route.scopeMapped,
    ),
  )('allows authenticated remote $name', async ({ method, path }) => {
    const { request } = createHarness();
    const response = await request(
      path,
      { method, headers: { Authorization: `Bearer ${CREDENTIAL}` } },
      '100.96.12.7',
    );
    expect(response.status).toBe(200);
  });

  it.each(
    RUNTIME_AUTH_ROUTE_MATRIX.filter(
      (route) => route.kind === 'protected' && !route.scopeMapped,
    ),
  )(
    'denies authenticated remote access to an unmapped route (station#1098 R2 fail-closed): $name',
    async ({ method, path }) => {
      const { request } = createHarness();
      // Even a fully-scoped, fully-authenticated credential — same one the
      // "allows authenticated remote" cases above prove works — is denied
      // when the route has no entry in the pairing-scope table.
      const response = await request(
        path,
        { method, headers: { Authorization: `Bearer ${CREDENTIAL}` } },
        '100.96.12.7',
      );
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: { code: 'insufficient_scope' },
      });
    },
  );

  it.each([
    ['wrong scheme', `Basic ${CREDENTIAL}`],
    ['missing value', 'Bearer'],
    ['empty value', 'Bearer '],
    ['multiple values', `Bearer ${CREDENTIAL}, Bearer second`],
    ['embedded whitespace', `Bearer ${CREDENTIAL} second`],
    ['wrong credential', 'Bearer definitely-wrong'],
  ])('rejects malformed Authorization: %s', async (_name, authorization) => {
    const { request } = createHarness();
    const response = await request(
      '/api/projects',
      { headers: { Authorization: authorization } },
      '100.96.12.7',
    );
    expect(response.status).toBe(401);
  });

  it('treats Origin rejection separately from authentication', async () => {
    const { request } = createHarness();
    const hostile = await request(
      '/api/projects',
      {
        headers: {
          Authorization: `Bearer ${CREDENTIAL}`,
          Origin: HOSTILE_ORIGIN,
        },
      },
      '100.96.12.7',
    );
    expect(hostile.status).toBe(403);
    await expect(hostile.json()).resolves.toMatchObject({
      error: { code: 'origin_forbidden' },
    });

    const missingOrigin = await request(
      '/api/projects',
      { headers: { Authorization: `Bearer ${CREDENTIAL}` } },
      '100.96.12.7',
    );
    expect(missingOrigin.status).toBe(200);

    const validOriginButNoAuth = await request(
      '/api/projects',
      { headers: { Origin: ALLOWED_ORIGIN } },
      '100.96.12.7',
    );
    expect(validOriginButNoAuth.status).toBe(401);
  });

  it('accepts a paired-device cookie for reads and trusted-origin mutations', async () => {
    const { request } = createHarness();
    const cookie = `__Host-station-device=${DEVICE_CREDENTIAL}`;

    expect(
      (
        await request(
          '/api/projects',
          { headers: { Cookie: cookie } },
          '100.96.12.7',
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await request(
          '/api/projects',
          {
            method: 'POST',
            headers: { Cookie: cookie, Origin: ALLOWED_ORIGIN },
          },
          '100.96.12.7',
        )
      ).status,
    ).toBe(200);
  });

  it('carries a real paired-cookie principal through canonical middleware into mounted room routes and revokes it', async () => {
    let valid = true;
    const seen: unknown[] = [];
    const { app, request } = createHarness({ credentialValid: () => valid });
    const runtime = new ProjectTaskRoomRuntime({
      taskGraph: {
        readTaskView: (id) =>
          id === 'task-1'
            ? ({
                id,
                projectId: 'project-1',
                title: '',
                description: '',
                priority: 'normal',
                status: 'ready',
                createdBy: 'owner',
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
              } as any)
            : null,
      },
      projectForId: (id) =>
        id === 'project-1' ? { id, slug: 'project' } : undefined,
      history: (authority) =>
        ({
          open: async ({ grant }: any) => {
            seen.push(
              await authority.capabilities.resolve({
                grant,
                required: 'discover',
              }),
            );
            return {
              kind: 'opened',
              scope: {
                projectId: 'project-1',
                projectSlug: 'project',
                taskId: 'task-1',
              },
              channelId: 'room',
              assurance: 'L0',
            };
          },
          read: async ({ grant }: any) => {
            seen.push(
              await authority.capabilities.resolve({
                grant,
                required: 'history-read',
              }),
            );
            return {
              kind: 'available',
              records: [],
              hasMore: false,
              integrity: 'L0',
              checkpoint: {
                channelId: 'room',
                epoch: 0,
                throughSeq: 0,
                checkpointDigest: 'a'.repeat(64),
                retainedAnchorSeq: 0,
                retainedAnchorDigest: 'b'.repeat(64),
              },
            };
          },
          append: async ({ grant, intent }: any) => {
            seen.push(
              await authority.capabilities.resolve({
                grant,
                required: grant.capability,
              }),
            );
            return {
              kind: 'committed',
              receipt: {
                schemaVersion: 'station.project-task-room-append-receipt/v1',
                proposalId: intent.proposalId,
                proposalDigest: 'a'.repeat(64),
                envelopeDigest: 'b'.repeat(64),
                coordinate: { channelId: 'room', epoch: 0, seq: 1 },
                checkpoint: {
                  channelId: 'room',
                  epoch: 0,
                  throughSeq: 1,
                  checkpointDigest: 'c'.repeat(64),
                  retainedAnchorSeq: 0,
                  retainedAnchorDigest: 'd'.repeat(64),
                },
                committedAt: '2026-01-01T00:00:00.000Z',
                assurance: 'L0',
              },
            };
          },
          close: async () => ({ kind: 'closed' }),
        }) as any,
      working: {
        read: async () => ({ kind: 'snapshot', revision: 'empty', text: '' }),
        settle: async () => ({ kind: 'rejected' }),
        receipt: async () => ({ kind: 'missing' }),
        readRevisionPublication: async () => ({ kind: 'missing' as const }),
        markRevisionPublication: async () => 'unavailable' as const,
        removeRevisionPublication: async () => 'unavailable' as const,
        recovery: async () => 'stored',
        readRecovery: async () => ({ kind: 'unavailable' }),
        privateSnapshot: async ({ scope }: any) =>
          new SharedWorkingState({ scope }).snapshot(),
        agentLifecycle: async () => 'stored' as const,
        readAgentLifecycles: async () => [],
        removeAgentLifecycle: async () => 'removed' as const,
        watch: () => () => {},
        close: async () => {},
      },
      requestAuthority: {
        resolve: async (raw) => {
          const principal = getRuntimeAuthenticatedRequestPrincipal(raw);
          return principal?.credential === DEVICE_CREDENTIAL
            ? {
                kind: 'granted' as const,
                operatorId: 'owner',
                deviceId: 'paired-device-1',
                policyRevision: 'paired-scope',
              }
            : { kind: 'revoked' as const };
        },
      },
    });
    // This is the production mounting shape: central middleware already owns
    // authentication before the room adapter sees the exact Request object.
    app.route('/api/tasks', createProjectTaskRoomRoutes(runtime));
    const cookie = `__Host-station-device=${DEVICE_CREDENTIAL}`;
    expect(
      (await request('/api/tasks/task-1/room', { headers: { Cookie: cookie } }))
        .status,
    ).toBe(200);
    expect(
      (
        await request('/api/tasks/task-1/room/history', {
          headers: { Cookie: cookie },
        })
      ).status,
    ).toBe(200);
    const messageResponse = await request('/api/tasks/task-1/room/messages', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: ALLOWED_ORIGIN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ proposalId: 'message', text: 'hello' }),
    });
    expect(messageResponse.status).toBe(200);
    expect(
      (
        await request('/api/tasks/task-1/room/live', {
          method: 'POST',
          headers: {
            Cookie: cookie,
            Origin: ALLOWED_ORIGIN,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ command: 'join', requestId: 'join' }),
        })
      ).status,
    ).toBe(200);
    expect(seen).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'granted',
          receipt: expect.objectContaining({
            principal: {
              kind: 'operator',
              operatorId: 'owner',
              deviceId: 'paired-device-1',
            },
          }),
        }),
      ]),
    );
    valid = false;
    expect(
      (await request('/api/tasks/task-1/room', { headers: { Cookie: cookie } }))
        .status,
    ).toBe(401);
    await runtime.close();
  });

  it('fails closed for originless mutations and ambiguous paired-device cookies', async () => {
    const { request } = createHarness();
    const cookie = `__Host-station-device=${DEVICE_CREDENTIAL}`;

    const originless = await request(
      '/api/projects',
      { method: 'POST', headers: { Cookie: cookie } },
      '100.96.12.7',
    );
    expect(originless.status).toBe(403);
    await expect(originless.json()).resolves.toMatchObject({
      error: { code: 'origin_required' },
    });

    expect(
      (
        await request(
          '/api/projects',
          {
            headers: {
              Cookie: `${cookie}; __Host-station-device=${DEVICE_CREDENTIAL}`,
            },
          },
          '100.96.12.7',
        )
      ).status,
    ).toBe(401);
  });

  it('does not let a cookie rescue an explicitly malformed bearer credential', async () => {
    const { request } = createHarness();
    expect(
      (
        await request(
          '/api/projects',
          {
            headers: {
              Authorization: 'Bearer definitely-wrong',
              Cookie: `__Host-station-device=${DEVICE_CREDENTIAL}`,
            },
          },
          '100.96.12.7',
        )
      ).status,
    ).toBe(401);
  });

  it('does not let the local exemption bypass Origin policy', async () => {
    const { request } = createHarness();
    expect(
      (
        await request(
          '/api/projects',
          { headers: { Origin: HOSTILE_ORIGIN } },
          '127.0.0.1',
        )
      ).status,
    ).toBe(403);
  });

  it('answers preflight without granting business authorization', async () => {
    const { request } = createHarness();
    const response = await request(
      '/api/projects',
      {
        method: 'OPTIONS',
        headers: {
          Origin: ALLOWED_ORIGIN,
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'authorization',
        },
      },
      '100.96.12.7',
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(
      ALLOWED_ORIGIN,
    );
    expect(response.headers.get('access-control-allow-headers')).toContain(
      'Authorization',
    );
    expect(response.headers.get('access-control-allow-headers')).toContain(
      STATION_PLUGIN_HEADER,
    );
  });

  // station#1890: plugin-context SDK requests set the STATION_PLUGIN_HEADER
  // (`x-station-plugin`) on every outgoing request (packages/sdk/src/api-core.ts,
  // telemetry.ts). A cross-origin caller's preflight must allow it, or the
  // browser blocks the real request before it ever reaches the server.
  it('allows the plugin header in a preflight requesting it', async () => {
    const { request } = createHarness();
    const response = await request(
      '/api/projects',
      {
        method: 'OPTIONS',
        headers: {
          Origin: ALLOWED_ORIGIN,
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': STATION_PLUGIN_HEADER,
        },
      },
      '100.96.12.7',
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-headers')).toContain(
      STATION_PLUGIN_HEADER,
    );
  });

  it('gates implicit public HEAD and CORS preflight before earlier special handlers', async () => {
    const unexpectedHandler = vi.fn();
    const { request, auditRecords } = createHarness({
      registerBeforeSecurity: (app) => {
        configureRuntimePublicRoutes(app as never, {
          getPublicHandshake: vi.fn(),
          createPublicProof: vi.fn(),
        });
        app.get('/not-in-table', (c) => {
          unexpectedHandler();
          return c.json({ reached: true });
        });
      },
    });

    const publicHead = await request(
      '/api/system/liveness',
      { method: 'HEAD' },
      '100.96.12.7',
    );
    expect(publicHead.status).toBe(200);

    const unknownPreflight = await request(
      '/not-in-table',
      {
        method: 'OPTIONS',
        headers: {
          Origin: ALLOWED_ORIGIN,
          'Access-Control-Request-Method': 'GET',
        },
      },
      '100.96.12.7',
    );
    expect(unknownPreflight.status).toBe(403);
    await expect(unknownPreflight.json()).resolves.toEqual({
      error: { code: 'insufficient_scope' },
    });
    expect(unexpectedHandler).not.toHaveBeenCalled();
    expect(
      auditRecords.filter((record) => record.reason === 'route_scope_unmapped'),
    ).toHaveLength(1);

    const publicHeadPreflight = await request(
      '/api/system/liveness',
      {
        method: 'OPTIONS',
        headers: {
          Origin: ALLOWED_ORIGIN,
          'Access-Control-Request-Method': 'HEAD',
        },
      },
      '100.96.12.7',
    );
    expect(publicHeadPreflight.status).toBe(204);
    expect(
      publicHeadPreflight.headers.get('access-control-allow-methods'),
    ).toContain('HEAD');
  });

  it('authenticates a pairing-scoped handler before production-order dispatch', async () => {
    const earlyHandler = vi.fn();
    const { request } = createHarness({
      registerBeforeSecurity: (app) => {
        app.get('/api/projects', (c) => {
          earlyHandler();
          return c.json({ reached: true });
        });
      },
    });

    expect((await request('/api/projects', {}, '100.96.12.7')).status).toBe(
      401,
    );
    expect(earlyHandler).not.toHaveBeenCalled();

    expect(
      (
        await request(
          '/api/projects',
          { headers: { Authorization: `Bearer ${CREDENTIAL}` } },
          '100.96.12.7',
        )
      ).status,
    ).toBe(200);
    expect(earlyHandler).toHaveBeenCalledTimes(1);

    expect((await request('/api/projects', {}, '127.0.0.1')).status).toBe(401);
    expect(earlyHandler).toHaveBeenCalledTimes(1);
  });

  it('leaves the declared MCP-token route to its bespoke authenticator', async () => {
    const mcpHandler = vi.fn();
    const { request } = createHarness({
      registerBeforeSecurity: (app) => {
        app.all('/mcp/station-control', (c) => {
          mcpHandler();
          return c.json({ reached: true });
        });
      },
    });

    expect(
      (
        await request(
          '/mcp/station-control?token=bespoke-token',
          { method: 'POST' },
          '100.96.12.7',
        )
      ).status,
    ).toBe(200);
    expect(mcpHandler).toHaveBeenCalledOnce();
  });

  it('leaves only the exact attachment PUT leaf to its stage-grant authenticator', async () => {
    const uploadHandler = vi.fn();
    const verifiedCredentials: unknown[] = [];
    const { request } = createHarness({
      onCredentialVerification: (request) => verifiedCredentials.push(request),
      registerBeforeSecurity: (app) => {
        app.put('/api/orchestration/attachment-staging/:stageId', (c) => {
          uploadHandler();
          return c.json({ reached: true });
        });
      },
    });

    expect(
      (
        await request(
          '/api/orchestration/attachment-staging/stage_opaque',
          {
            method: 'PUT',
            headers: { Authorization: `Bearer ${'s'.repeat(43)}` },
          },
          '100.96.12.7',
        )
      ).status,
    ).toBe(200);
    expect(uploadHandler).toHaveBeenCalledOnce();
    expect(verifiedCredentials).toEqual([]);

    // The stage grant is not a family wildcard: another method retains the
    // normal protected-route policy instead of becoming an accidental bypass.
    expect(
      (
        await request(
          '/api/orchestration/attachment-staging/stage_opaque',
          { method: 'POST' },
          '100.96.12.7',
        )
      ).status,
    ).toBe(401);
  });

  it('rate-limits repeated failures with a bounded fake clock', async () => {
    let now = 1_000;
    const { request } = createHarness({
      now: () => now,
      maxFailures: 3,
      windowMs: 10_000,
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(
        (
          await request(
            '/api/projects',
            { headers: { Authorization: 'Bearer wrong' } },
            '100.96.12.7',
          )
        ).status,
      ).toBe(401);
    }
    const limited = await request('/api/projects', {}, '100.96.12.7');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('10');
    // station#3903: this refusal is reachable ONLY through rejected
    // credentials, so it says so. It used to answer the mutation budget's
    // `rate_limited`, which left a client no way to tell "this Station is
    // refusing your access" from "you are writing too fast" — and
    // `classifyHttpFailureResponse` could only report the revoked device's
    // own Station as something that "answered, but not as a Station".
    expect(await limited.json()).toEqual({
      error: { code: 'authentication_rate_limited' },
    });

    const recovered = await request(
      '/api/projects',
      { headers: { Authorization: `Bearer ${CREDENTIAL}` } },
      '100.96.12.7',
    );
    expect(recovered.status).toBe(200);
    expect((await request('/api/projects', {}, '100.96.12.7')).status).toBe(
      401,
    );

    now += 10_001;
    expect((await request('/api/projects', {}, '100.96.12.7')).status).toBe(
      401,
    );
  });

  it('emits stable redacted audit data with method and pathname only', async () => {
    const { auditRecords, logger, request } = createHarness();
    const response = await request(
      `/api/projects?credential=${encodeURIComponent(CREDENTIAL)}`,
      {
        headers: {
          Authorization: `Bearer ${CREDENTIAL}-wrong`,
          Cookie: `__Host-station-device=${DEVICE_CREDENTIAL}`,
        },
      },
      '100.96.12.7',
    );

    expect(response.status).toBe(401);
    expect(auditRecords).toEqual([
      expect.objectContaining({
        event: 'station.auth.failure',
        outcome: 'denied',
        reason: 'query_credential_rejected',
        method: 'GET',
        path: '/api/projects',
        routeClass: 'protected',
        peerClass: 'remote',
        transport: 'http',
      }),
    ]);
    const serialized = JSON.stringify({
      auditRecords,
      info: vi.mocked(logger.info).mock.calls,
      warn: vi.mocked(logger.warn).mock.calls,
      error: vi.mocked(logger.error).mock.calls,
    });
    expect(serialized).not.toContain(CREDENTIAL);
    expect(serialized).not.toContain(DEVICE_CREDENTIAL);
    expect(serialized).not.toContain('Authorization');
    expect(serialized).not.toContain('Cookie');
    expect(serialized).not.toContain('/api/projects?');
  });

  it('names a mapped credentialless route as credential_missing with its path', async () => {
    const { auditRecords, request } = createHarness();
    const response = await request(
      '/api/projects?ignored=query',
      {},
      '127.0.0.1',
    );

    expect(response.status).toBe(401);
    expect(auditRecords).toContainEqual(
      expect.objectContaining({
        reason: 'credential_missing',
        method: 'GET',
        path: '/api/projects',
      }),
    );
  });
});

describe('station#2051: credentialed loopback boundary', () => {
  it.each([
    ['IPv4 loopback', '127.0.0.1'],
    ['IPv6 loopback', '::1'],
    ['IPv4-mapped loopback', '::ffff:127.0.0.1'],
    ['SSH-forward-equivalent loopback', '::ffff:127.0.0.1'],
  ])('rejects a credentialless mutating %s request', async (_name, peer) => {
    const { request } = createHarness();
    const response = await request('/api/projects', { method: 'POST' }, peer);
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'authentication_required' },
    });
  });

  it.each(['Bearer', 'Basic x', 'Bearer  token'])(
    'rejects a malformed Authorization header on a loopback mutation (%s)',
    async (authorization) => {
      const { request } = createHarness();
      const response = await request(
        '/api/projects',
        { method: 'POST', headers: { Authorization: authorization } },
        '127.0.0.1',
      );
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'authentication_required' },
      });
    },
  );

  it('keeps the exact loopback internal-token attestation as an explicit credential path', async () => {
    const { request } = createHarness();
    const response = await request(
      '/api/projects',
      {
        method: 'POST',
        headers: {
          [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
          [INTERNAL_PROXY_CALLER_HEADER]: 'local',
        },
      },
      '127.0.0.1',
    );
    expect(response.status).toBe(200);
  });

  it('enforces the normal verify+scope path once a credential IS presented at a loopback peer, exactly like a remote caller', async () => {
    const { request } = createHarness();
    const response = await request(
      '/api/projects',
      { method: 'POST', headers: { Authorization: `Bearer ${CREDENTIAL}` } },
      '127.0.0.1',
    );
    expect(response.status).toBe(200);
  });

  it('does not let an invalid credential ride the loopback exemption', async () => {
    const { request } = createHarness();
    const response = await request(
      '/api/projects',
      { headers: { Authorization: 'Bearer definitely-wrong' } },
      '127.0.0.1',
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'authentication_required' },
    });
  });

  it('denies a loopback caller on an unmapped route once a fully-scoped credential is presented (fail-closed, matches the remote case)', async () => {
    const { request } = createHarness();
    const response = await request(
      RUNTIME_AUTH_ROUTE_MATRIX.find(
        (route) => route.kind === 'protected' && !route.scopeMapped,
      )!.path,
      { headers: { Authorization: `Bearer ${CREDENTIAL}` } },
      '127.0.0.1',
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'insufficient_scope' },
    });
  });

  it.each([
    ['loopback', '127.0.0.1', {}],
    [
      'attested local proxy',
      '127.0.0.1',
      {
        [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
        [INTERNAL_PROXY_CALLER_HEADER]: 'local',
      },
    ],
    ['SSH-forward-equivalent peer', '::ffff:127.0.0.1', {}],
  ] as const)(
    'does not dispatch an unmapped route for a credentialless %s',
    async (_name, peer, headers) => {
      const onReached = vi.fn();
      const { request, auditRecords } = createHarness({
        extraRoutes: [
          {
            method: 'GET',
            path: '/unmapped-local-shortcut-regression',
            onReached,
          },
        ],
      });

      const response = await request(
        '/unmapped-local-shortcut-regression',
        { headers },
        peer,
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: { code: 'insufficient_scope' },
      });
      expect(onReached).not.toHaveBeenCalled();
      expect(auditRecords).toContainEqual(
        expect.objectContaining({
          reason: 'route_scope_unmapped',
          method: 'GET',
          path: '/unmapped-local-shortcut-regression',
        }),
      );
    },
  );

  it('labels an unmapped route from literals mounted after the security boundary without weakening refusal', async () => {
    const onReached = vi.fn();
    const { request, auditRecords } = createHarness({
      extraRoutes: [
        {
          method: 'GET',
          path: '/notifications',
          onReached,
        },
      ],
    });

    const response = await request('/api/notifications', {}, '127.0.0.1');

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'insufficient_scope' },
    });
    expect(onReached).not.toHaveBeenCalled();
    expect(auditRecords).toContainEqual(
      expect.objectContaining({
        reason: 'route_scope_unmapped',
        method: 'GET',
        path: '/api/notifications',
        routeLabel: 'api/notifications',
      }),
    );
  });

  it('denies a nonstandard method registered through Hono app.all before dispatch', async () => {
    const onReached = vi.fn();
    const { request, auditRecords } = createHarness({
      extraRoutes: [
        {
          method: 'ALL',
          path: '/all-method-regression',
          onReached,
        },
      ],
    });
    const response = await request(
      '/all-method-regression',
      { method: 'PROPFIND' },
      '127.0.0.1',
    );
    expect(response.status).toBe(403);
    expect(onReached).not.toHaveBeenCalled();
    expect(
      auditRecords.filter((record) => record.reason === 'route_scope_unmapped'),
    ).toHaveLength(1);
  });

  // Non-regression proof 1 (design doc §4 / §10 UNVERIFIED item): Station's
  // own internal MCP calls (`station-control-shared.ts`'s
  // `controlRequestOptions()`) send NO `Authorization` header or device
  // cookie at all — only the internal-token/caller attestation pair, which
  // `classifyAttestedProxyCaller` resolves independently of this reorder.
  // Without a bearer or device-session credential, the exact internal-token
  // attestation remains a valid process credential on reads AND mutations.
  it('non-regression: Station-internal MCP calls keep their exact internal-token credential path on reads and mutations', async () => {
    const { request } = createHarness();
    const local = {
      [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
      [INTERNAL_PROXY_CALLER_HEADER]: 'local',
    };
    const read = await request(
      '/api/projects',
      { headers: local },
      '127.0.0.1',
    );
    expect(read.status).toBe(200);
    const mutate = await request(
      '/api/projects',
      { method: 'POST', headers: local },
      '127.0.0.1',
    );
    expect(mutate.status).toBe(200);
  });

  // Non-regression proof 2 (design doc §4 / §10 UNVERIFIED item): the
  // same-origin "Request access" continuity flow always requests FULL scope
  // (docs/security/remote-access-threat-model.md:157-165) and rides the same
  // device-session cookie mechanism as any other paired device. It must
  // still pass every route — including a mutation, which now runs through
  // the full verify+scope path even at a loopback peer.
  it('non-regression: the same-origin continuity device cookie (full scope) still passes a mutating route at a loopback peer', async () => {
    const { request } = createHarness();
    const cookie = `__Host-station-device=${DEVICE_CREDENTIAL}`;
    const response = await request(
      '/api/projects',
      { method: 'POST', headers: { Cookie: cookie, Origin: ALLOWED_ORIGIN } },
      '127.0.0.1',
    );
    expect(response.status).toBe(200);
  });
});

describe('minimal public runtime routes', () => {
  it('mounts an exact versioned handshake and secret-free liveness document', async () => {
    const app = new Hono();
    configureRuntimePublicRoutes(app as never, {
      getPublicHandshake: async () => ({
        schemaVersion: 1,
        environmentId: '018f3f5f-c27b-7c32-8a44-d35f9d9b86d1',
        authentication: { scheme: 'bearer', protocolVersion: 1 },
        transports: { http: 1, sse: 1, websocket: 1 },
        compatibility: {
          serverVersion: '0.4.1',
          protocolVersion: 1,
          minClientProtocol: 1,
        },
      }),
      createPublicProof: async (nonce) => ({
        protocolVersion: 1,
        environmentId: '018f3f5f-c27b-7c32-8a44-d35f9d9b86d1',
        nonce,
        signature: 's'.repeat(43),
      }),
    });

    const handshake = (await (
      await app.request('/.well-known/station/v1')
    ).json()) as Record<string, unknown>;
    expect(handshake).toEqual({
      schemaVersion: 1,
      environmentId: '018f3f5f-c27b-7c32-8a44-d35f9d9b86d1',
      authentication: { scheme: 'bearer', protocolVersion: 1 },
      transports: { http: 1, sse: 1, websocket: 1 },
      compatibility: {
        serverVersion: '0.4.1',
        protocolVersion: 1,
        minClientProtocol: 1,
      },
    });
    expect(Object.keys(handshake).sort()).toEqual([
      'authentication',
      'compatibility',
      'environmentId',
      'schemaVersion',
      'transports',
    ]);

    const liveness = (await (
      await app.request('/api/system/liveness')
    ).json()) as Record<string, unknown>;
    expect(liveness).toEqual({ live: true });
    expect(Object.keys(liveness)).toEqual(['live']);

    const nonce = 'n'.repeat(43);
    const proof = await app.request('/.well-known/station/v1/proof', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocolVersion: 1, nonce }),
    });
    expect(proof.status).toBe(200);
    expect(await proof.json()).toEqual({
      protocolVersion: 1,
      environmentId: '018f3f5f-c27b-7c32-8a44-d35f9d9b86d1',
      nonce,
      signature: 's'.repeat(43),
    });

    for (const body of [
      '{}',
      JSON.stringify({ protocolVersion: 2, nonce }),
      JSON.stringify({ protocolVersion: 1, nonce: 'short' }),
    ]) {
      expect(
        (
          await app.request('/.well-known/station/v1/proof', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
          })
        ).status,
      ).toBe(400);
    }
    expect(
      (
        await app.request('/.well-known/station/v1/proof', {
          method: 'POST',
          body: 'x'.repeat(257),
        })
      ).status,
    ).toBe(413);
  });

  it('rate limits bounded public proof requests by direct peer', async () => {
    const app = new Hono();
    configureRuntimePublicRoutes(app as never, {
      getPublicHandshake: vi.fn() as never,
      createPublicProof: async (nonce) => ({
        protocolVersion: 1,
        environmentId: 'environment-fixture',
        nonce,
        signature: 's'.repeat(43),
      }),
    });
    const request = () =>
      app.request(
        '/.well-known/station/v1/proof',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ protocolVersion: 1, nonce: 'n'.repeat(43) }),
        },
        { incoming: { socket: { remoteAddress: '100.96.12.9' } } } as never,
      );
    for (let index = 0; index < 30; index += 1) {
      expect((await request()).status).toBe(200);
    }
    expect((await request()).status).toBe(429);
  });
});

describe('bounded public proof request reader', () => {
  it('rejects declared oversize before pulling the body', async () => {
    const body = new ReadableStream<Uint8Array>({
      pull() {},
    });
    const request = new Request('https://station.test/proof', {
      method: 'POST',
      headers: { 'Content-Length': '257' },
      body,
      duplex: 'half',
    } as RequestInit);
    await expect(readBoundedRequestBody(request, 256)).resolves.toEqual({
      status: 'too-large',
    });
  });

  it('cancels chunked input immediately when cumulative bytes cross the cap', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(200));
        controller.enqueue(new Uint8Array(57));
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request('https://station.test/proof', {
      method: 'POST',
      body,
      duplex: 'half',
    } as RequestInit);
    await expect(readBoundedRequestBody(request, 256)).resolves.toEqual({
      status: 'too-large',
    });
    expect(cancelled).toBe(true);
  });

  it('counts UTF-8 bytes, accepts at-cap input, and rejects reader failures', async () => {
    const encoder = new TextEncoder();
    const multibyte = new Request('https://station.test/proof', {
      method: 'POST',
      body: 'é'.repeat(129),
    });
    await expect(readBoundedRequestBody(multibyte, 256)).resolves.toEqual({
      status: 'too-large',
    });
    const atCap = new Request('https://station.test/proof', {
      method: 'POST',
      body: encoder.encode('x'.repeat(256)),
    });
    await expect(readBoundedRequestBody(atCap, 256)).resolves.toEqual({
      status: 'ok',
      body: 'x'.repeat(256),
    });
    const failed = new Request('https://station.test/proof', {
      method: 'POST',
      body: new ReadableStream({
        pull(controller) {
          controller.error(new Error('fixture read failure'));
        },
      }),
      duplex: 'half',
    } as RequestInit);
    await expect(readBoundedRequestBody(failed, 256)).resolves.toEqual({
      status: 'invalid',
    });
  });
});

describe('public proof body cap through the Node adapter', () => {
  it('rejects declared and delayed chunked overflow promptly and accepts a bounded proof', async () => {
    const app = new Hono();
    configureRuntimePublicRoutes(app as never, {
      getPublicHandshake: vi.fn() as never,
      createPublicProof: async (nonce) => ({
        protocolVersion: 1,
        environmentId: 'environment-fixture',
        nonce,
        signature: 's'.repeat(43),
      }),
    });
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.once('listening', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('missing test port');
    const errors: Error[] = [];
    server.on('clientError', (error) => errors.push(error));

    const send = (
      headers: Record<string, string>,
      write: (request: ReturnType<typeof nodeRequest>) => void,
    ) =>
      new Promise<{ status: number; elapsed: number }>((resolve, reject) => {
        const started = Date.now();
        const request = nodeRequest(
          {
            hostname: '127.0.0.1',
            port: address.port,
            path: '/.well-known/station/v1/proof',
            method: 'POST',
            headers,
          },
          (response) => {
            response.resume();
            response.once('end', () => {
              request.destroy();
              resolve({
                status: response.statusCode ?? 0,
                elapsed: Date.now() - started,
              });
            });
          },
        );
        request.once('error', reject);
        write(request);
      });

    try {
      const declared = await send({ 'Content-Length': '257' }, (request) => {
        request.end(Buffer.alloc(257, 120));
      });
      expect(declared.status).toBe(413);
      expect(declared.elapsed).toBeLessThan(1_000);

      const chunked = await send(
        { 'Transfer-Encoding': 'chunked' },
        (request) => {
          request.write(Buffer.alloc(200, 120));
          setTimeout(() => request.end(Buffer.alloc(57, 120)), 20);
        },
      );
      expect(chunked.status).toBe(413);
      expect(chunked.elapsed).toBeLessThan(1_000);

      const body = JSON.stringify({
        protocolVersion: 1,
        nonce: 'n'.repeat(43),
      });
      const valid = await send(
        {
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(body)),
        },
        (request) => request.end(body),
      );
      expect(valid.status).toBe(200);
      expect(errors).toEqual([]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

describe('actual VoltAgent full-app mounts', () => {
  it('places framework landing, agent, and tool routes behind Station auth', async () => {
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
    } as Logger;
    // Load the optional full-app integration only for the one case that needs
    // it. Besides shortening the other 55 security checks, this avoids a
    // Windows module-evaluation race between VoltAgent's bundled Zod OpenAPI
    // extensions and MCP's Zod v4 schemas.
    const { createVoltAgentApp } = await import('@voltagent/server-hono');
    const { app } = await createVoltAgentApp({} as never, {
      cors: false,
      configureFullApp: ({ app, routes, middlewares }) => {
        configureRuntimeHttp({
          app: app as never,
          logger,
          eventBus: { emit: vi.fn() } as unknown as EventBus,
          security: {
            verifyCredential: (candidate) => candidate === CREDENTIAL,
            resolveGrantedScope: (candidate) =>
              candidate === CREDENTIAL
                ? DEFAULT_GRANT_PAIRING_SCOPE
                : undefined,
          },
        });
        middlewares.landingPage();
        routes.agents();
        routes.tools();
        assertRuntimeHttpRouteCoverage(app.routes);
      },
    });
    const request = (path: string, authorization?: string) =>
      app.request(
        path,
        authorization
          ? { headers: { Authorization: authorization } }
          : undefined,
        { incoming: { socket: { remoteAddress: '100.96.12.7' } } } as never,
      );

    for (const path of ['/', '/agents', '/tools']) {
      expect((await request(path)).status, path).toBe(401);
      expect(
        (await request(path, `Bearer ${CREDENTIAL}`)).status,
        `${path} authenticated request must pass Station's boundary`,
      ).not.toBe(401);
    }
  }, 15_000); // Cold full-app module evaluation measured 5.5s on native Windows.
});

/**
 * station#1398 slice 2 — the §12 regression the design doc explicitly
 * demanded of this slice, and the one it names as reasoned-from-reading
 * rather than executed.
 *
 * station#2051 retired the generic loopback compatibility floor. The inference
 * family remains covered here because it must require both a valid credential
 * and its narrower `inference:invoke` scope; no family-specific transport
 * exception is needed or retained.
 */
describe('station#1398 §2.1/§12: /api/inference/** is not reachable credential-less over an SSH loopback forward', () => {
  const INFERENCE_ROUTES = [
    { method: 'GET' as const, path: '/api/inference/manifest' },
    { method: 'POST' as const, path: '/api/inference/completions' },
  ];

  const harness = () => createHarness({ extraRoutes: INFERENCE_ROUTES });

  it.each([
    ['IPv4 loopback', '127.0.0.1'],
    ['IPv6 loopback', '::1'],
    [
      'IPv4-mapped loopback (an SSH -L forward presents as this)',
      '::ffff:127.0.0.1',
    ],
  ])(
    'refuses a credential-less %s caller on every inference route',
    async (_name, peer) => {
      const { request } = harness();
      for (const route of INFERENCE_ROUTES) {
        const response = await request(
          route.path,
          { method: route.method },
          peer,
        );
        expect([route.path, response.status]).toEqual([route.path, 401]);
        await expect(response.json()).resolves.toMatchObject({
          error: { code: 'authentication_required' },
        });
      }
    },
  );

  it('refuses a malformed Authorization header too — the branch that made the gap reachable', async () => {
    // `credential` is `undefined` both when no header is sent AND when one
    // is sent but fails strict bearer parsing, and both take the loopback
    // branch. A guard that only checked "no header" would leave the second
    // path open.
    const { request } = harness();
    for (const authorization of ['Bearer', 'Basic abc', 'Bearer  token']) {
      const response = await request(
        '/api/inference/completions',
        { method: 'POST', headers: { Authorization: authorization } },
        '127.0.0.1',
      );
      expect([authorization, response.status]).toEqual([authorization, 401]);
    }
  });

  it('still refuses a loopback caller holding the operator/default-grant credential (no inference:invoke)', async () => {
    // The other half of the slice-2 decoupling, proven at the boundary: the
    // fixture credential resolves to `DEFAULT_GRANT_PAIRING_SCOPE`, which is
    // exactly what the operator bootstrap credential resolves to in
    // production. It reaches every other protected route and must not reach
    // this one — otherwise "no existing credential silently gained fleet
    // invocation" would be false.
    const { request } = harness();
    const response = await request(
      '/api/inference/completions',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${CREDENTIAL}` },
      },
      '127.0.0.1',
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'insufficient_scope' },
    });
  });

  it('refuses a remote peer with no credential, exactly as every protected route does', async () => {
    const { request } = harness();
    const response = await request(
      '/api/inference/manifest',
      {},
      '100.96.12.7',
    );
    expect(response.status).toBe(401);
  });

  it('applies the same credential requirement to the pre-existing surface', async () => {
    const { request } = harness();
    expect((await request('/api/projects', {}, '127.0.0.1')).status).toBe(401);
    expect(
      (await request('/api/connections/model-inventory', {}, '127.0.0.1'))
        .status,
    ).toBe(401);
  });
});

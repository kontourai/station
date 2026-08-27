import type { HttpBindings } from '@hono/node-server';
import { Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import { configureRuntimeHttp } from '../../../runtime/bootstrap/runtime-http.js';
import {
  RUNTIME_CREDENTIAL_AUTHORITY_VAR,
  type RuntimeCredentialAuthority,
} from '../../../security/runtime-request-security.js';
import {
  type UnattendedGrantStore,
  UnattendedGrantStoreUnavailableError,
  type UnattendedToolGrant,
} from '../../../services/agents/unattended-grant-store.js';
import type { EventBus } from '../../../services/orchestration/event-bus.js';
import type { Logger } from '../../../utils/logger.js';
import { createUnattendedGrantRoutes } from '../unattended-grants-routes.js';

const OPERATOR = 'brian';
const PRINCIPAL = '{"kind":"scheduled-job","jobId":"daily"}';
const TOOL = 'reports.send';

type TestBindings = HttpBindings & {
  incoming: HttpBindings['incoming'] & {
    socket: HttpBindings['incoming']['socket'] & { remoteAddress?: string };
  };
};

function createStore() {
  const grants: UnattendedToolGrant[] = [];
  return {
    grants,
    grantTool: vi.fn(
      (principalKey: string, toolName: string, grantedBy: string) => {
        const receipt = {
          principalKey,
          toolName,
          grantedBy,
          grantedAt: '2026-08-10T00:00:00.000Z',
        };
        grants.splice(0, grants.length, receipt);
        return receipt;
      },
    ),
    revokeGrant: vi.fn((principalKey: string, toolName: string) => {
      const grant = grants.find(
        (entry) =>
          entry.principalKey === principalKey && entry.toolName === toolName,
      );
      if (grant) grant.revokedAt = '2026-08-10T00:01:00.000Z';
    }),
    isGranted: vi.fn((principalKey: string, toolName: string) =>
      grants.some(
        (grant) =>
          grant.principalKey === principalKey &&
          grant.toolName === toolName &&
          grant.revokedAt === undefined,
      ),
    ),
    listGrants: vi.fn(() => grants.map((grant) => ({ ...grant }))),
  };
}

function operatorRoutes(store = createStore()) {
  const app = createUnattendedGrantRoutes(
    store as unknown as UnattendedGrantStore,
    {
      operatorIdentityForRequest: () => OPERATOR,
    },
  );
  return { app, store };
}

function post(
  app: ReturnType<typeof createUnattendedGrantRoutes>,
  path: string,
  body: unknown,
) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('unattended grant routes (station#2037)', () => {
  test('grants with the authenticated operator identity, never body-supplied grantedBy', async () => {
    const { app, store } = operatorRoutes();
    const response = await post(app, '/', {
      principalKey: PRINCIPAL,
      toolName: TOOL,
      grantedBy: 'unattended-principal-trying-to-self-grant',
    });

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      success: true,
      data: {
        principalKey: PRINCIPAL,
        toolName: TOOL,
        grantedBy: OPERATOR,
        grantedAt: '2026-08-10T00:00:00.000Z',
      },
    });
    expect(store.grantTool).toHaveBeenCalledWith(PRINCIPAL, TOOL, OPERATOR);
  });

  test('revokes authorization and lists the retained revoked receipt', async () => {
    const { app, store } = operatorRoutes();
    await post(app, '/', { principalKey: PRINCIPAL, toolName: TOOL });

    const revoked = await post(app, '/revoke', {
      principalKey: PRINCIPAL,
      toolName: TOOL,
    });
    expect(revoked.status).toBe(200);
    expect(await json(revoked)).toEqual({ success: true });
    expect(store.isGranted(PRINCIPAL, TOOL)).toBe(false);

    const listed = await app.request('/');
    expect(listed.status).toBe(200);
    expect(await json(listed)).toEqual({
      success: true,
      data: [
        expect.objectContaining({
          principalKey: PRINCIPAL,
          toolName: TOOL,
          revokedAt: '2026-08-10T00:01:00.000Z',
        }),
      ],
    });
  });

  test.each([
    ['empty principalKey', { principalKey: '', toolName: TOOL }],
    ['empty toolName', { principalKey: PRINCIPAL, toolName: '' }],
  ])('returns 400 for %s without writing', async (_label, body) => {
    const { app, store } = operatorRoutes();
    const response = await post(app, '/', body);
    expect(response.status).toBe(400);
    expect(store.grantTool).not.toHaveBeenCalled();
  });

  test('returns 503 when the persistent store is unavailable', async () => {
    const unavailable = new UnattendedGrantStoreUnavailableError(
      '/tmp/unattended-tool-grants.json',
      'corrupt',
    );
    const store = createStore();
    store.listGrants.mockImplementation(() => {
      throw unavailable;
    });
    const logger = { warn: vi.fn() };
    const app = createUnattendedGrantRoutes(
      store as unknown as UnattendedGrantStore,
      {
        operatorIdentityForRequest: () => OPERATOR,
        logger,
      },
    );

    const response = await app.request('/');
    expect(response.status).toBe(503);
    expect(logger.warn).toHaveBeenCalledWith(
      'Unattended grant store unavailable',
      expect.any(Object),
    );
  });

  test('returns the committed receipt when a later listGrants read would fail', async () => {
    const unavailable = new UnattendedGrantStoreUnavailableError(
      '/tmp/unattended-tool-grants.json',
      'corrupt',
    );
    const store = createStore();
    store.listGrants.mockImplementation(() => {
      throw unavailable;
    });
    const { app } = operatorRoutes(store);

    const response = await post(app, '/', {
      principalKey: PRINCIPAL,
      toolName: TOOL,
    });

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      success: true,
      data: {
        principalKey: PRINCIPAL,
        toolName: TOOL,
        grantedBy: OPERATOR,
        grantedAt: '2026-08-10T00:00:00.000Z',
      },
    });
    expect(store.grantTool).toHaveBeenCalledWith(PRINCIPAL, TOOL, OPERATOR);
    expect(store.listGrants).not.toHaveBeenCalled();
    expect(store.isGranted(PRINCIPAL, TOOL)).toBe(true);
  });
});

const MANAGE_CREDENTIAL = 'manage-credential';
const STANDARD_CREDENTIAL = 'standard-credential';
const DEFAULT_SCOPE_DEVICE_CREDENTIAL = 'default-scope-device-credential';

function securityHarness() {
  const store = createStore();
  const app = new Hono<{ Bindings: TestBindings }>();
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
  configureRuntimeHttp({
    app: app as never,
    logger,
    eventBus: { emit: vi.fn() } as unknown as EventBus,
    security: {
      verifyCredential: (credential) =>
        credential === MANAGE_CREDENTIAL ||
        credential === STANDARD_CREDENTIAL ||
        credential === DEFAULT_SCOPE_DEVICE_CREDENTIAL,
      resolveGrantedScope: (credential) =>
        credential === MANAGE_CREDENTIAL ||
        credential === DEFAULT_SCOPE_DEVICE_CREDENTIAL
          ? 'access:manage'
          : 'orchestration:operate',
      resolveCredentialAuthority: (
        credential,
      ): RuntimeCredentialAuthority | undefined =>
        credential === MANAGE_CREDENTIAL
          ? 'operator-credential'
          : 'device-credential',
      allowedOrigins: ['https://station.example.test'],
    },
  } as Parameters<typeof configureRuntimeHttp>[0]);
  app.route(
    '/api/agents/unattended-grants',
    createUnattendedGrantRoutes(store as unknown as UnattendedGrantStore, {
      operatorIdentityForRequest: (context) =>
        (context as unknown as { get(key: string): unknown }).get(
          RUNTIME_CREDENTIAL_AUTHORITY_VAR,
        ) === 'operator-credential'
          ? OPERATOR
          : undefined,
    }),
  );

  return {
    store,
    request: (init: RequestInit = {}, peer = '127.0.0.1') =>
      app.request('/api/agents/unattended-grants', init, {
        incoming: { socket: { remoteAddress: peer } },
      } as TestBindings),
    requestPath: (path: string, init: RequestInit = {}, peer = '127.0.0.1') =>
      app.request(
        `/api/agents/unattended-grants${path === '/' ? '' : path}`,
        init,
        {
          incoming: { socket: { remoteAddress: peer } },
        } as TestBindings,
      ),
  };
}

describe('unattended grant route authentication floor (station#2037)', () => {
  test('refuses unauthenticated and insufficient-scope callers before grantTool', async () => {
    const { request, store } = securityHarness();
    const body = JSON.stringify({ principalKey: PRINCIPAL, toolName: TOOL });

    expect(
      (
        await request({
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
          },
          '100.96.12.7',
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await request({
          method: 'POST',
          headers: {
            Authorization: `Bearer ${STANDARD_CREDENTIAL}`,
            'content-type': 'application/json',
          },
          body,
        })
      ).status,
    ).toBe(403);
    expect(store.grantTool).not.toHaveBeenCalled();
  });

  test('allows a remote access:manage operator and binds grantedBy to that operator', async () => {
    const { request, store } = securityHarness();
    const response = await request(
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${MANAGE_CREDENTIAL}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          principalKey: PRINCIPAL,
          toolName: TOOL,
          grantedBy: 'body-must-not-control-audit-identity',
        }),
      },
      '100.96.12.7',
    );

    expect(response.status).toBe(200);
    expect(store.grantTool).toHaveBeenCalledWith(PRINCIPAL, TOOL, OPERATOR);
    expect(
      (await json<{ data: UnattendedToolGrant }>(response)).data.grantedBy,
    ).toBe(OPERATOR);
  });

  test('requires authenticated operator authority even when a device credential has access:manage', async () => {
    const { requestPath, store } = securityHarness();
    const headers = {
      Authorization: `Bearer ${DEFAULT_SCOPE_DEVICE_CREDENTIAL}`,
    };

    for (const [method, path, body] of [
      ['GET', '/', undefined],
      [
        'POST',
        '/',
        JSON.stringify({ principalKey: PRINCIPAL, toolName: TOOL }),
      ],
      [
        'POST',
        '/revoke',
        JSON.stringify({ principalKey: PRINCIPAL, toolName: TOOL }),
      ],
    ] as const) {
      const response = await requestPath(path, {
        method,
        headers: body
          ? { ...headers, 'content-type': 'application/json' }
          : headers,
        body,
      });
      expect(response.status).toBe(401);
    }
    expect(store.grantTool).not.toHaveBeenCalled();
    expect(store.revokeGrant).not.toHaveBeenCalled();
    expect(store.listGrants).not.toHaveBeenCalled();
  });

  test('applies the access:manage and operator-authority gates to list and revoke', async () => {
    const { requestPath, store } = securityHarness();
    const mutation = JSON.stringify({
      principalKey: PRINCIPAL,
      toolName: TOOL,
    });

    for (const [method, path, body] of [
      ['GET', '/', undefined],
      ['POST', '/revoke', mutation],
    ] as const) {
      const response = await requestPath(path, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body,
      });
      expect(response.status).toBe(401);
    }
    const insufficient = await requestPath('/', {
      method: 'GET',
      headers: { Authorization: `Bearer ${STANDARD_CREDENTIAL}` },
    });
    expect(insufficient.status).toBe(403);

    await requestPath('/', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${MANAGE_CREDENTIAL}`,
        'content-type': 'application/json',
      },
      body: mutation,
    });
    const listed = await requestPath('/', {
      method: 'GET',
      headers: { Authorization: `Bearer ${MANAGE_CREDENTIAL}` },
    });
    expect(listed.status).toBe(200);
    expect(
      (await json<{ data: UnattendedToolGrant[] }>(listed)).data,
    ).toHaveLength(1);

    const revoked = await requestPath(
      '/revoke',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${MANAGE_CREDENTIAL}`,
          'content-type': 'application/json',
        },
        body: mutation,
      },
      '127.0.0.1',
    );
    expect(revoked.status).toBe(200);
    expect(store.revokeGrant).toHaveBeenCalledWith(PRINCIPAL, TOOL);
  });
});

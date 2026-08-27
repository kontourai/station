import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_GRANT_PAIRING_SCOPE } from '@kontourai/station-contracts/environment-security';
import { parseHostedTenantRegistry } from '@kontourai/station-contracts/tenancy';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventBus } from '../../../services/orchestration/event-bus.js';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_TENANT_HEADER,
} from '../../../utils/internal-api-token.js';
import type { Logger } from '../../../utils/logger.js';
import { isAttachmentStageGrantUploadRequest } from '../../routes/runtime-routes.js';
import { configureRuntimeHttp } from '../runtime-http.js';
import {
  createHostedTenantMiddleware,
  getTenantRequestContext,
  loadHostedTenantRegistryFromEnvironment,
  tenantExecutionContextForRequest,
} from '../runtime-tenant-context.js';

const registry = parseHostedTenantRegistry({
  schemaVersion: 1,
  tenants: [{ id: 'alpha', authority: 'alpha.example.test' }],
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

describe('hosted runtime tenant context', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const directory of tempDirs.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  it('loads a configured regular registry file and fails closed for invalid configured files', () => {
    const directory = mkdtempSync(join(tmpdir(), 'station-tenants-'));
    tempDirs.push(directory);
    const file = join(directory, 'tenants.json');
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        tenants: [{ id: 'alpha', authority: 'alpha.example.test' }],
      }),
    );
    expect(
      loadHostedTenantRegistryFromEnvironment({
        STATION_HOSTED_TENANT_REGISTRY_FILE: file,
      })?.authorityToTenant,
    ).toEqual({ 'alpha.example.test': 'alpha' });
    expect(loadHostedTenantRegistryFromEnvironment({})).toBeUndefined();
    expect(() =>
      loadHostedTenantRegistryFromEnvironment({
        STATION_HOSTED_TENANT_REGISTRY_FILE: 'tenants.json',
      }),
    ).toThrow('regular file');
    expect(() =>
      loadHostedTenantRegistryFromEnvironment({
        STATION_HOSTED_TENANT_REGISTRY_FILE: join(directory, 'missing.json'),
      }),
    ).toThrow('readable regular file');
  });

  it('gates requests before credential verification and exposes one frozen verified context', async () => {
    const app = new Hono();
    const verifyCredential = vi.fn(
      (_credential: string, request?: { tenant?: unknown }) => {
        expect(request?.tenant).toEqual({ tenantId: 'alpha' });
        expect(Object.isFrozen(request?.tenant)).toBe(true);
        return true;
      },
    );
    app.use('*', createHostedTenantMiddleware(registry) as never);
    configureRuntimeHttp({
      app: app as never,
      logger,
      eventBus: { emit: vi.fn() } as unknown as EventBus,
      security: {
        verifyCredential,
        resolveGrantedScope: () => DEFAULT_GRANT_PAIRING_SCOPE,
      },
    });
    app.get('/api/projects', (c) =>
      c.json({ tenant: getTenantRequestContext(c.req.raw)?.tenantId }),
    );
    const environment = {
      incoming: { socket: { remoteAddress: '127.0.0.1' } },
    };
    const trusted = {
      [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
      [INTERNAL_TENANT_HEADER]: 'alpha',
      Authorization: 'Bearer credential',
    };
    const allowed = await app.request(
      '/api/projects',
      { headers: trusted },
      environment as never,
    );
    expect(allowed.status).toBe(200);
    await expect(allowed.json()).resolves.toEqual({ tenant: 'alpha' });

    for (const headers of [
      {},
      {
        [INTERNAL_TENANT_HEADER]: 'unknown',
        [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
      },
      {
        [INTERNAL_TENANT_HEADER]: 'alpha',
        [INTERNAL_API_TOKEN_HEADER]: 'wrong',
      },
      {
        [INTERNAL_TENANT_HEADER]: 'x'.repeat(65),
        [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
      },
    ]) {
      const denied = await app.request(
        '/api/projects',
        { headers },
        environment as never,
      );
      expect(denied.status).toBe(421);
      await expect(denied.json()).resolves.toEqual({
        error: { code: 'tenant_context_required' },
      });
    }
    const remote = await app.request('/api/projects', { headers: trusted }, {
      incoming: { socket: { remoteAddress: '198.51.100.4' } },
    } as never);
    expect(remote.status).toBe(421);
    expect(verifyCredential).toHaveBeenCalledTimes(1);
  });

  it('leaves direct local behavior unchanged when no registry middleware is installed', async () => {
    const app = new Hono();
    configureRuntimeHttp({
      app: app as never,
      logger,
      eventBus: { emit: vi.fn() } as unknown as EventBus,
    });
    app.get('/api/projects', (c) => c.json({ reached: true }));
    const response = await app.request('/api/projects', {}, {
      incoming: { socket: { remoteAddress: '127.0.0.1' } },
    } as never);
    expect(response.status).toBe(200);
  });

  it('allows only a valid stage-grant PUT to bypass hosted tenant ingress', async () => {
    const app = new Hono();
    app.use(
      '*',
      createHostedTenantMiddleware(registry, {
        bypass: isAttachmentStageGrantUploadRequest,
      }) as never,
    );
    configureRuntimeHttp({
      app: app as never,
      logger,
      eventBus: { emit: vi.fn() } as unknown as EventBus,
      security: {
        verifyCredential: vi.fn(() => false),
        resolveGrantedScope: () => undefined,
      },
    });
    app.put('/api/orchestration/attachment-staging/:stageId', (c) =>
      c.json({ reached: true }),
    );
    const environment = {
      incoming: { socket: { remoteAddress: '198.51.100.4' } },
    };
    const stageId = 'stage_12345678-1234-1234-1234-123456789abc';
    const stageGrant = await app.request(
      `/api/orchestration/attachment-staging/${stageId}`,
      { method: 'PUT', headers: { Authorization: `Bearer ${'s'.repeat(43)}` } },
      environment as never,
    );
    expect(stageGrant.status).toBe(200);
    await expect(stageGrant.json()).resolves.toEqual({ reached: true });

    const other = await app.request(
      '/api/orchestration/attachment-staging/not-a-stage',
      { method: 'PUT', headers: { Authorization: `Bearer ${'s'.repeat(43)}` } },
      environment as never,
    );
    expect(other.status).toBe(421);
  });

  /**
   * station#4075 stage 2 review round 3 (the header-forgery guard the
   * ruling asked for): `tenantExecutionContextForRequest` — the ONE
   * accessor `resolveOrchestrationRequestPrincipal`
   * (`runtime-routes.ts`) is required to read for the hosted-tenant
   * principal — must answer from the middleware-verified WeakMap ONLY,
   * never from the raw header itself. A route that never ran
   * `createHostedTenantMiddleware` at all (any future bypass, mis-mount,
   * or misuse of this accessor outside the protected tree) sees NO bound
   * context even though the header is present and well-formed — nothing
   * verified loopback + the per-boot internal token for that request. The
   * contrast case proves this isn't a hollow always-`undefined` stub: the
   * identical header, behind the real middleware, legitimately binds.
   */
  it('tenantExecutionContextForRequest reads ONLY the middleware-bound context, never the raw header', async () => {
    const unprotected = new Hono();
    unprotected.get('/api/orchestration/sessions', (c) =>
      c.json({
        bound: tenantExecutionContextForRequest(c.req.raw) ?? null,
        rawHeaderPresent: c.req.header(INTERNAL_TENANT_HEADER) !== undefined,
      }),
    );
    const forged = await unprotected.request(
      '/api/orchestration/sessions',
      { headers: { [INTERNAL_TENANT_HEADER]: 'alpha' } },
      { incoming: { socket: { remoteAddress: '203.0.113.7' } } } as never,
    );
    expect(forged.status).toBe(200);
    await expect(forged.json()).resolves.toEqual({
      bound: null,
      rawHeaderPresent: true,
    });

    const protectedApp = new Hono();
    protectedApp.use('*', createHostedTenantMiddleware(registry) as never);
    protectedApp.get('/api/orchestration/sessions', (c) =>
      c.json({ bound: tenantExecutionContextForRequest(c.req.raw) ?? null }),
    );
    const legitimate = await protectedApp.request(
      '/api/orchestration/sessions',
      {
        headers: {
          [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
          [INTERNAL_TENANT_HEADER]: 'alpha',
        },
      },
      { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as never,
    );
    expect(legitimate.status).toBe(200);
    await expect(legitimate.json()).resolves.toEqual({
      bound: { tenantId: 'alpha', source: 'request' },
    });
  });
});

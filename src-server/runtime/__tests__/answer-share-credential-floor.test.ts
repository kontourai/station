import type { HttpBindings } from '@hono/node-server';
import { DEFAULT_GRANT_PAIRING_SCOPE } from '@kontourai/station-contracts';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { EventBus } from '../../services/orchestration/event-bus.js';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_PROXY_CALLER_HEADER,
} from '../../utils/internal-api-token.js';
import type { Logger } from '../../utils/logger.js';
import { configureRuntimeHttp } from '../bootstrap/runtime-http.js';

/**
 * station#1423 security review H-1 — answer-share authorization.
 *
 * Every protected route now requires a credential. A bare loopback socket is
 * transport position only — it can be an SSH local forward — so POST, DELETE,
 * and GET must all fail loudly without a bearer or device session. The only
 * internal token-attested path is a genuine Station-internal caller: its
 * per-boot token plus `caller: local` marker is the process credential, not a
 * loopback compatibility bypass. The UI proxy always represents browser
 * traffic as remote and relays that browser's credential.
 */

const CREDENTIAL = 'test-only-credential-that-must-never-be-logged';

type TestBindings = HttpBindings & {
  incoming: HttpBindings['incoming'] & {
    socket: HttpBindings['incoming']['socket'] & { remoteAddress?: string };
  };
};

function createHarness() {
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
  const audit: Array<Record<string, unknown>> = [];
  const app = new Hono<{ Bindings: TestBindings }>();

  configureRuntimeHttp({
    app: app as never,
    logger,
    eventBus: { emit: vi.fn() } as unknown as EventBus,
    security: {
      verifyCredential: (candidate: string) => candidate === CREDENTIAL,
      resolveGrantedScope: (candidate: string) =>
        candidate === CREDENTIAL ? DEFAULT_GRANT_PAIRING_SCOPE : undefined,
      audit: (record: Record<string, unknown>) => audit.push(record),
      allowedOrigins: ['https://station.example.test'],
    },
  } as Parameters<typeof configureRuntimeHttp>[0]);

  for (const method of ['GET', 'POST', 'DELETE'] as const) {
    app.on(method, '/api/shares', (c) => c.json({ reached: true }, 200));
    app.on(method, '/api/shares/:id', (c) => c.json({ reached: true }, 200));
  }

  return {
    audit,
    request: (path: string, init: RequestInit = {}, peer = '127.0.0.1') =>
      app.request(path, init, {
        incoming: { socket: { remoteAddress: peer } },
      } as TestBindings),
  };
}

/** Exact Station-internal caller credentials; the UI proxy never uses this local marker. */
const LOCAL_PROXY_HEADERS = {
  [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
  [INTERNAL_PROXY_CALLER_HEADER]: 'local',
};

describe('answer-share mint floor (station#1423 H-1)', () => {
  it('refuses a credential-less POST /api/shares from a bare loopback socket (the SSH local-forward shape)', async () => {
    const { request } = createHarness();
    const response = await request('/api/shares', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'authentication_required' },
    });
  });

  it("admits Station's token-attested internal caller path", async () => {
    const { request } = createHarness();
    const response = await request('/api/shares', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...LOCAL_PROXY_HEADERS },
      body: '{}',
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ reached: true });
  });

  it('refuses a credential-less DELETE, so a tunnel cannot revoke the operator’s links', async () => {
    const { request } = createHarness();
    const response = await request('/api/shares/share-1', {
      method: 'DELETE',
    });
    expect(response.status).toBe(401);
  });

  it('names a bare-loopback refusal as credential-missing in the audit trail', async () => {
    const { request, audit } = createHarness();
    await request('/api/shares', { method: 'POST', body: '{}' });
    expect(audit.at(-1)).toMatchObject({
      event: 'station.auth.failure',
      reason: 'credential_missing',
      peerClass: 'loopback',
    });
  });

  it('refuses a credential-less GET, so loopback does not disclose share metadata', async () => {
    const { request } = createHarness();
    const response = await request('/api/shares');
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'authentication_required' },
    });
  });

  it('admits a credential carrying access:manage on the mutating verbs', async () => {
    const { request } = createHarness();
    const response = await request('/api/shares', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CREDENTIAL}`,
        Origin: 'https://station.example.test',
      },
      body: '{}',
    });
    expect(response.status).toBe(200);
  });

  it('still refuses a REMOTE caller with no credential, unchanged', async () => {
    const { request } = createHarness();
    expect(
      (await request('/api/shares', { method: 'POST' }, '100.96.12.7')).status,
    ).toBe(401);
  });

  it('requires a credential for a sibling protected family too', async () => {
    const sibling = new Hono<{ Bindings: TestBindings }>();
    configureRuntimeHttp({
      app: sibling as never,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
        fatal: vi.fn(),
        child: vi.fn().mockReturnThis(),
        setLevel: vi.fn(),
        getLevel: vi.fn(() => 'info' as const),
      } as Logger,
      eventBus: { emit: vi.fn() } as unknown as EventBus,
      security: {
        verifyCredential: () => false,
        resolveGrantedScope: () => undefined,
        allowedOrigins: [],
      },
    } as Parameters<typeof configureRuntimeHttp>[0]);
    sibling.post('/api/projects', (c) => c.json({ reached: true }));

    const response = await sibling.request(
      '/api/projects',
      { method: 'POST' },
      { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as TestBindings,
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'authentication_required' },
    });
  });
});

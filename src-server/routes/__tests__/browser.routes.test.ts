import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HttpBindings } from '@hono/node-server';
import {
  DEFAULT_GRANT_PAIRING_SCOPE,
  PAIRING_SCOPE_ORCHESTRATION_READ,
  PAIRING_SCOPE_TERMINAL_OPERATE,
  pairingScopePresetString,
} from '@kontourai/station-contracts';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { configureRuntimeHttp } from '../../runtime/bootstrap/runtime-http.js';
import { requiredPairingScope } from '../../security/pairing-route-scopes.js';
import { isRuntimeRequestPrincipalCurrent } from '../../security/runtime-request-security.js';
import type { BrowserProjectAuthorizer } from '../../services/browser/browser-access.js';
import type {
  BrowserHost,
  CdpTransport,
} from '../../services/browser/browser-host.js';
import { LocalTargetStore } from '../../services/browser/browser-local-targets.js';
import { isStationInternalRequest } from '../../services/browser/browser-request-origin.js';
import {
  type BrowserSessionActor,
  BrowserSessionRegistry,
} from '../../services/browser/browser-session-registry.js';
import { CdpProtocolError } from '../../services/browser/cdp-pipe-transport.js';
import type { ChromiumAcquisitionStatus } from '../../services/browser/chromium-acquisition.js';
import { BrowserHostPolicyError } from '../../services/browser/hosts/chromium-server-host.js';
import { EventBus } from '../../services/orchestration/event-bus.js';
import { createBrowserRoutes } from '../browser.js';

type CdpResponder = (method: string, params?: object) => unknown;

function fakeHost(respond: CdpResponder = () => ({})): BrowserHost {
  let seq = 0;
  const cdp: CdpTransport = {
    send: async <R>(method: string, params?: object) =>
      (await respond(method, params)) as R,
    on: () => () => {},
    close: async () => {},
    closed: new Promise(() => {}),
  };
  return {
    kind: 'server-chromium',
    openTarget: async () => {
      seq += 1;
      return { targetId: `T${seq}`, cdpSessionId: `S${seq}` };
    },
    cdp: () => cdp,
    closeTarget: async () => {},
    onExit: () => () => {},
    shutdown: async () => {},
  };
}

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

/**
 * Runtime authentication (pairing scopes) in front of the real routes, with
 * a real session registry over a fake browser host.
 */
function harness(
  options: {
    acquisition?: ChromiumAcquisitionStatus;
    /** Which principals are admins of which Projects (D5 stand-in). */
    admins?: Record<string, string[]>;
    surfaceIdFor?: (browserSessionId: string) => string | undefined;
    cdp?: CdpResponder;
  } = {},
) {
  const credentials = new Map([
    ['operator', DEFAULT_GRANT_PAIRING_SCOPE],
    ['viewer', pairingScopePresetString('read-only')],
    ['admin-alpha', DEFAULT_GRANT_PAIRING_SCOPE],
    ['contributor-alpha', DEFAULT_GRANT_PAIRING_SCOPE],
  ]);
  const security = {
    verifyCredential: (value: string) => credentials.has(value),
    authorizeCredential: (value: string) => credentials.has(value),
    resolveGrantedScope: (value: string) => credentials.get(value),
    allowedOrigins: [],
  };
  const logger = {
    info() {},
    warn() {},
    error() {},
    debug() {},
    trace() {},
    fatal() {},
    child() {
      return this;
    },
    setLevel() {},
    getLevel() {
      return 'info' as const;
    },
  };
  const app = new Hono<{ Bindings: HttpBindings }>();
  configureRuntimeHttp({
    app: app as never,
    logger,
    eventBus: new EventBus(),
    security,
  } as Parameters<typeof configureRuntimeHttp>[0]);
  const stationHome = mkdtempSync(join(tmpdir(), 'station-browser-routes-'));
  homes.push(stationHome);
  const registry = new BrowserSessionRegistry({
    stationHome,
    createHost: () => fakeHost(options.cdp),
  });
  const acquisitionStatus: ChromiumAcquisitionStatus = options.acquisition ?? {
    state: 'found-system',
    executablePath: '/fake/chrome',
    browser: 'google-chrome',
  };
  const acquisition = {
    status: vi.fn(() => acquisitionStatus),
    startDownload: vi.fn(() => ({
      status: acquisitionStatus,
      completion: Promise.resolve(),
    })),
  };
  // Canonical Project IDs differ from slugs on purpose (D7).
  const projects: Record<
    string,
    { id: string; slug: string; workspaceRoot?: string }
  > = {
    alpha: { id: 'p-alpha', slug: 'alpha', workspaceRoot: '/work/alpha' },
    beta: { id: 'p-beta', slug: 'beta' },
  };
  const admins = options.admins ?? { 'p-alpha': ['admin-alpha'] };
  let principalCurrent = true;
  // Review M3 power: current at the middleware, gone by the time the route
  // publishes — only a route's own re-check can refuse then.
  let expireAfterFirstCheck = false;
  const checks = new WeakMap<Request, number>();
  const localTargets = new LocalTargetStore(stationHome);
  const suggestLocalTargets = vi.fn(async () => ({
    state: 'ok' as const,
    suggestions: [
      {
        host: 'localhost' as const,
        port: 5173,
        label: 'vite :5173',
        pid: 42,
        processName: 'node',
        commandLine: 'node vite',
        cwd: '/work/alpha',
        selected: false as const,
        warnings: ['may-proxy' as const],
      },
    ],
  }));
  const bearer = (request: Request) =>
    request.headers.get('authorization')?.replace(/^Bearer /, '');
  const authorizeProject = vi.fn<BrowserProjectAuthorizer>(
    async (request, projectId) => {
      const credential = bearer(request);
      if (credential === 'operator') return { kind: 'operator' };
      if (credential && admins[projectId]?.includes(credential))
        return { kind: 'project-admin', principalId: credential };
      return undefined;
    },
  );
  app.route(
    '/api/browser',
    createBrowserRoutes({
      registry,
      acquisition,
      authorizeProject,
      authorizeOperator: async (request) => bearer(request) === 'operator',
      localTargets,
      listeners: () => ({ ports: [4100, 4101, 4102, 4103], hostnames: [] }),
      suggestLocalTargets,
      resolveProject: (slug) => projects[slug],
      isStationInternalRequest,
      ...(options.surfaceIdFor ? { surfaceIdFor: options.surfaceIdFor } : {}),
      isRequestPrincipalCurrent: (request) => {
        const seen = checks.get(request) ?? 0;
        checks.set(request, seen + 1);
        if (expireAfterFirstCheck && seen >= 1) return false;
        return (
          principalCurrent &&
          isRuntimeRequestPrincipalCurrent(request, security)
        );
      },
    }),
  );
  const request = (
    method: string,
    path: string,
    credential?: string,
    body?: unknown,
  ) =>
    app.request(
      `/api/browser${path}`,
      {
        method,
        headers: {
          ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
          'Content-Type': 'application/json',
        },
        ...(body === undefined
          ? {}
          : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
      },
      {
        incoming: { socket: { remoteAddress: '100.96.12.7' } },
      } as HttpBindings,
    );
  const create = async (credential: string, projectSlug = 'alpha') =>
    request('POST', '/sessions', credential, {
      projectSlug,
      url: 'https://example.com',
    });
  return {
    request,
    create,
    registry,
    acquisition,
    authorizeProject,
    credentials,
    localTargets,
    suggestLocalTargets,
    setPrincipalCurrent: (value: boolean) => {
      principalCurrent = value;
    },
    expireAfterFirstCheck: () => {
      expireAfterFirstCheck = true;
    },
  };
}

describe('browser routes: pairing scope classification', () => {
  test('reads sit at orchestration:read; every mutation needs terminal:operate', () => {
    for (const path of [
      '/api/browser/acquisition',
      '/api/browser/sessions',
      '/api/browser/sessions/bs_x',
    ]) {
      expect(requiredPairingScope('GET', path)).toBe(
        PAIRING_SCOPE_ORCHESTRATION_READ,
      );
    }
    for (const [method, path] of [
      ['POST', '/api/browser/acquisition/download'],
      ['POST', '/api/browser/sessions'],
      ['POST', '/api/browser/sessions/bs_x/navigate'],
      ['POST', '/api/browser/sessions/bs_x/reopen'],
      ['DELETE', '/api/browser/sessions/bs_x'],
    ] as const) {
      expect(requiredPairingScope(method, path)).toBe(
        PAIRING_SCOPE_TERMINAL_OPERATE,
      );
    }
  });

  test('unauthenticated and read-only callers cannot create sessions', async () => {
    const h = harness();
    expect((await h.create('')).status).toBe(401);
    expect((await h.create('viewer')).status).toBe(403);
    expect(h.registry.listSessions()).toEqual([]);
  });
});

describe('browser routes: per-Project authorization (D5)', () => {
  test('the operator and a Project admin may create and drive; others are refused', async () => {
    const h = harness();
    const byOperator = await h.create('operator');
    expect(byOperator.status).toBe(201);
    const byAdmin = await h.create('admin-alpha');
    expect(byAdmin.status).toBe(201);
    // A contributor of the Project holds a full-scope credential and still
    // gets nothing: scope is necessary, Project standing is required.
    expect((await h.create('contributor-alpha')).status).toBe(403);
    // Admin of alpha is not admin of beta.
    expect((await h.create('admin-alpha', 'beta')).status).toBe(403);
    const session = (
      (await byAdmin.json()) as { data: { browserSessionId: string } }
    ).data;
    const id = session.browserSessionId;
    for (const [method, path, body] of [
      ['GET', `/sessions/${id}`, undefined],
      ['POST', `/sessions/${id}/navigate`, { url: 'https://example.org' }],
      ['POST', `/sessions/${id}/reopen`, {}],
      ['DELETE', `/sessions/${id}`, undefined],
    ] as const) {
      const refused = await h.request(method, path, 'contributor-alpha', body);
      expect(refused.status, `${method} ${path}`).toBe(403);
    }
    expect(h.registry.getSession(id)?.state).toBe('live');
    const navigated = await h.request(
      'POST',
      `/sessions/${id}/navigate`,
      'admin-alpha',
      {
        url: 'https://example.org',
      },
    );
    expect(navigated.status).toBe(200);
    const history = h.registry.getSession(id)?.history.entries ?? [];
    expect(history.map((e) => [e.kind, e.actor])).toEqual([
      ['created', { kind: 'project-admin', principalId: 'admin-alpha' }],
      ['navigated', { kind: 'project-admin', principalId: 'admin-alpha' }],
    ] satisfies Array<[string, BrowserSessionActor]>);
  });

  test('the session list is filtered to Projects the caller may view, with history (D6)', async () => {
    const h = harness();
    await h.create('operator', 'alpha');
    await h.create('operator', 'beta');
    const asOperator = (await (
      await h.request('GET', '/sessions', 'operator')
    ).json()) as {
      data: Array<{ projectId: string; history: { total: number } }>;
    };
    expect(asOperator.data.map((s) => s.projectId).sort()).toEqual([
      'p-alpha',
      'p-beta',
    ]);
    expect(asOperator.data.every((s) => s.history.total === 1)).toBe(true);
    await h.create('admin-alpha', 'alpha');
    const asAdmin = (await (
      await h.request('GET', '/sessions', 'admin-alpha')
    ).json()) as {
      data: Array<{ projectId: string; principalKey: string }>;
    };
    // D7: the admin sees only their own profile's sessions, never the
    // operator's (whose logins it would expose).
    expect(asAdmin.data.map((s) => [s.projectId, s.principalKey])).toEqual([
      ['p-alpha', 'principal:admin-alpha'],
    ]);
    const asContributor = (await (
      await h.request('GET', '/sessions', 'contributor-alpha')
    ).json()) as { data: unknown[] };
    expect(asContributor.data).toEqual([]);
  });

  test('Chromium acquisition is operator-only, even for a Project admin', async () => {
    const h = harness();
    expect((await h.request('GET', '/acquisition', 'admin-alpha')).status).toBe(
      403,
    );
    expect(
      (
        await h.request('POST', '/acquisition/download', 'admin-alpha', {
          consent: true,
        })
      ).status,
    ).toBe(403);
    // Authorization precedes body validation: 403, not 400, for a bad body.
    for (const body of [{}, 'nope', { consent: false }]) {
      expect(
        (await h.request('POST', '/acquisition/download', 'admin-alpha', body))
          .status,
      ).toBe(403);
    }
    expect(h.acquisition.startDownload).not.toHaveBeenCalled();
    expect((await h.request('GET', '/acquisition', 'operator')).status).toBe(
      200,
    );
  });
});

describe('browser routes: validation and typed failures', () => {
  test('a download starts only on the literal consent: true', async () => {
    const h = harness({
      acquisition: {
        state: 'needs-consent',
        version: '1',
        platform: 'mac-arm64',
        downloadBytes: 10,
        installDir: '/x',
      },
    });
    for (const body of [
      {},
      { consent: 'true' },
      { consent: 1 },
      { consent: false },
      { consent: true, extra: 1 },
      'nope',
    ]) {
      const response = await h.request(
        'POST',
        '/acquisition/download',
        'operator',
        body,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'consent-required' });
    }
    expect(h.acquisition.startDownload).not.toHaveBeenCalled();
    const accepted = await h.request(
      'POST',
      '/acquisition/download',
      'operator',
      { consent: true },
    );
    expect(accepted.status).toBe(202);
    expect(h.acquisition.startDownload).toHaveBeenCalledWith({ consent: true });
  });

  test('no browser available is a typed 409 carrying the acquisition state', async () => {
    const h = harness({
      acquisition: {
        state: 'needs-consent',
        version: '1',
        platform: 'mac-arm64',
        downloadBytes: 10,
        installDir: '/x',
      },
    });
    const response = await h.create('operator');
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: 'browser-unavailable',
      acquisition: { state: 'needs-consent' },
    });
  });

  test('out-of-scope URLs, unknown Projects and malformed bodies are refused', async () => {
    const h = harness();
    const fileUrl = await h.request('POST', '/sessions', 'operator', {
      projectSlug: 'alpha',
      url: 'file:///etc/passwd',
    });
    expect(fileUrl.status).toBe(400);
    expect(await fileUrl.json()).toMatchObject({
      code: 'url-not-allowed',
      detail: { urlRejection: 'unsupported-scheme' },
    });
    expect(
      (
        await h.request('POST', '/sessions', 'operator', {
          projectSlug: 'gamma',
          url: 'https://a.b',
        })
      ).status,
    ).toBe(403);
    for (const body of [
      { projectSlug: '../x', url: 'https://a.b' },
      { projectSlug: 'alpha' },
      { projectSlug: 'alpha', url: 'https://a.b', surprise: true },
      { projectId: 'alpha', url: 'https://a.b' },
      {
        projectSlug: 'alpha',
        url: 'https://a.b',
        viewport: { width: 1, height: 1, deviceScaleFactor: 1 },
      },
      '{not json',
    ]) {
      expect(
        (await h.request('POST', '/sessions', 'operator', body)).status,
      ).toBe(400);
    }
    expect(
      (await h.request('GET', '/sessions/not-an-id', 'operator')).status,
    ).toBe(400);
    expect(
      (
        await h.request(
          'GET',
          '/sessions/bs_00000000-0000-0000-0000-000000000000',
          'operator',
        )
      ).status,
    ).toBe(404);
  });

  test('a stale generation is a typed 409', async () => {
    const h = harness();
    const created = (await (await h.create('operator')).json()) as {
      data: { browserSessionId: string; generation: number };
    };
    const response = await h.request(
      'POST',
      `/sessions/${created.data.browserSessionId}/navigate`,
      'operator',
      { url: 'https://example.org', generation: created.data.generation + 5 },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'stale-generation' });
  });
});

describe('browser routes: D7 profile isolation', () => {
  test("a Project admin cannot open, drive or see the operator's session", async () => {
    const h = harness();
    const created = (await (await h.create('operator')).json()) as {
      data: { browserSessionId: string };
    };
    const id = created.data.browserSessionId;
    for (const [method, path, body] of [
      ['GET', `/sessions/${id}`, undefined],
      ['POST', `/sessions/${id}/navigate`, { url: 'https://example.org' }],
      ['DELETE', `/sessions/${id}`, undefined],
    ] as const) {
      expect(
        (await h.request(method, path, 'admin-alpha', body)).status,
        `${method} ${path}`,
      ).toBe(403);
    }
    // The operator can open an admin's session (D6: never hidden from the user).
    const adminSession = (await (await h.create('admin-alpha')).json()) as {
      data: { browserSessionId: string };
    };
    expect(
      (
        await h.request(
          'GET',
          `/sessions/${adminSession.data.browserSessionId}`,
          'operator',
        )
      ).status,
    ).toBe(200);
  });
});

describe('browser routes: a principal that stopped being current (review M3)', () => {
  test('every route refuses and nothing changes', async () => {
    const h = harness();
    const created = (await (await h.create('operator')).json()) as {
      data: { browserSessionId: string };
    };
    const id = created.data.browserSessionId;
    h.setPrincipalCurrent(false);
    for (const [method, path, body] of [
      ['GET', '/acquisition', undefined],
      ['POST', '/acquisition/download', { consent: true }],
      ['GET', '/sessions', undefined],
      ['POST', '/sessions', { projectSlug: 'alpha', url: 'https://a.b' }],
      ['GET', `/sessions/${id}`, undefined],
      ['POST', `/sessions/${id}/navigate`, { url: 'https://example.org' }],
      ['POST', `/sessions/${id}/reopen`, {}],
      ['DELETE', `/sessions/${id}`, undefined],
      ['GET', '/projects/alpha/local-targets', undefined],
      [
        'POST',
        '/projects/alpha/local-targets',
        { host: 'localhost', port: 5173, label: 'x' },
      ],
      ['GET', '/projects/alpha/local-target-suggestions', undefined],
      ['POST', `/sessions/${id}/history`, { action: 'reload' }],
      [
        'POST',
        `/sessions/${id}/viewport`,
        { viewport: { width: 400, height: 800, deviceScaleFactor: 1 } },
      ],
      ['GET', '/projects/alpha/access', undefined],
      [
        'DELETE',
        '/projects/alpha/local-targets/lt_00000000-0000-4000-8000-000000000001',
        undefined,
      ],
    ] as const) {
      const response = await h.request(method, path, 'operator', body);
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(await response.json()).toMatchObject({ code: 'access-denied' });
    }
    expect(h.registry.listSessions().map((s) => s.state)).toEqual(['live']);
    expect(h.registry.getSession(id)?.history.total).toBe(1);
    expect(h.acquisition.startDownload).not.toHaveBeenCalled();
    expect(h.localTargets.list('p-alpha')).toEqual([]);
    expect(h.suggestLocalTargets).not.toHaveBeenCalled();
  });
});

describe('browser routes: a principal that expires mid-request (review M3)', () => {
  test('each route re-checks at its publication boundary, and nothing changes', async () => {
    const h = harness();
    const created = (await (await h.create('operator')).json()) as {
      data: { browserSessionId: string };
    };
    const id = created.data.browserSessionId;
    const target = h.localTargets.add(
      'p-alpha',
      { host: 'localhost', port: 5173, label: 'vite' },
      'operator',
      { ports: [4100, 4101, 4102, 4103], hostnames: [] },
    );
    const before = h.registry.getSession(id);
    h.expireAfterFirstCheck();
    for (const [method, path, body] of [
      ['POST', `/sessions/${id}/history`, { action: 'reload' }],
      [
        'POST',
        `/sessions/${id}/viewport`,
        { viewport: { width: 400, height: 800, deviceScaleFactor: 1 } },
      ],
      ['GET', '/projects/alpha/access', undefined],
      ['DELETE', `/projects/alpha/local-targets/${target.id}`, undefined],
      ['POST', `/sessions/${id}/navigate`, { url: 'https://example.org' }],
      ['DELETE', `/sessions/${id}`, undefined],
    ] as const) {
      const response = await h.request(method, path, 'operator', body);
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(await response.json()).toMatchObject({ code: 'access-denied' });
    }
    const after = h.registry.getSession(id);
    expect(after?.state).toBe('live');
    expect(after?.viewport).toEqual(before?.viewport);
    expect(after?.history.total).toBe(before?.history.total);
    expect(h.localTargets.list('p-alpha')).toHaveLength(1);
  });
});

describe('browser routes: registered local targets (D7)', () => {
  test('only the operator adds or removes; Project admins can list; others get nothing', async () => {
    const h = harness();
    const target = { host: 'localhost', port: 5173, label: 'Vite dev server' };
    expect(
      (
        await h.request(
          'POST',
          '/projects/alpha/local-targets',
          'admin-alpha',
          target,
        )
      ).status,
    ).toBe(403);
    const added = await h.request(
      'POST',
      '/projects/alpha/local-targets',
      'operator',
      target,
    );
    expect(added.status).toBe(201);
    const { data } = (await added.json()) as {
      data: { id: string; addedBy: string };
    };
    expect(data.addedBy).toBe('operator');
    expect(h.localTargets.list('p-alpha')).toHaveLength(1);
    const listed = await h.request(
      'GET',
      '/projects/alpha/local-targets',
      'admin-alpha',
    );
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { data: unknown[] }).data).toHaveLength(1);
    expect(
      (
        await h.request(
          'GET',
          '/projects/alpha/local-targets',
          'contributor-alpha',
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await h.request(
          'DELETE',
          `/projects/alpha/local-targets/${data.id}`,
          'admin-alpha',
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await h.request(
          'DELETE',
          `/projects/alpha/local-targets/${data.id}`,
          'operator',
        )
      ).status,
    ).toBe(200);
    expect(h.localTargets.list('p-alpha')).toEqual([]);
  });

  test('a Station listener port, a public host and junk are refused at registration', async () => {
    const h = harness();
    for (const [body, code] of [
      [
        { host: 'localhost', port: 4101, label: 'terminal' },
        'station-listener',
      ],
      [{ host: '93.184.216.34', port: 80, label: 'public' }, 'invalid-host'],
      [
        { host: '169.254.169.254', port: 80, label: 'metadata' },
        'invalid-host',
      ],
      [{ host: 'localhost', port: 0, label: 'x' }, 'invalid-port'],
      [{ host: 'localhost', port: 5173, label: '' }, 'invalid-label'],
    ] as const) {
      const response = await h.request(
        'POST',
        '/projects/alpha/local-targets',
        'operator',
        body,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code });
    }
    expect(h.localTargets.list('p-alpha')).toEqual([]);
  });

  test('suggestions are operator-only and never register anything', async () => {
    const h = harness();
    expect(
      (
        await h.request(
          'GET',
          '/projects/alpha/local-target-suggestions',
          'admin-alpha',
        )
      ).status,
    ).toBe(403);
    const response = await h.request(
      'GET',
      '/projects/alpha/local-target-suggestions',
      'operator',
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        state: 'ok',
        suggestions: [
          {
            port: 5173,
            pid: 42,
            commandLine: 'node vite',
            cwd: '/work/alpha',
            selected: false,
            warnings: ['may-proxy'],
          },
        ],
      },
    });
    expect(h.suggestLocalTargets).toHaveBeenCalledWith({
      id: 'p-alpha',
      slug: 'alpha',
      workspaceRoot: '/work/alpha',
    });
    expect(h.localTargets.list('p-alpha')).toEqual([]);
  });
});

describe('browser routes: pane v2 surface (#90 wave 2)', () => {
  test('the access route answers role and browser readiness, and refuses a contributor', async () => {
    const h = harness();
    const operator = await h.request(
      'GET',
      '/projects/alpha/access',
      'operator',
    );
    expect(operator.status).toBe(200);
    expect(await operator.json()).toEqual({
      success: true,
      data: {
        projectId: 'p-alpha',
        role: 'operator',
        principalKey: 'operator',
        operator: true,
        browser: 'ready',
      },
    });
    const admin = await h.request(
      'GET',
      '/projects/alpha/access',
      'admin-alpha',
    );
    expect(((await admin.json()) as { data: unknown }).data).toMatchObject({
      role: 'project-admin',
      principalKey: 'principal:admin-alpha',
      operator: false,
    });
    expect(
      (await h.request('GET', '/projects/alpha/access', 'contributor-alpha'))
        .status,
    ).toBe(403);
    expect(
      (await h.request('GET', '/projects/missing/access', 'operator')).status,
    ).toBe(403);
  });

  test('the access route reports a browser that is not set up yet', async () => {
    const h = harness({
      acquisition: {
        state: 'needs-consent',
        version: '1',
        platform: 'mac-arm64',
        downloadBytes: 150_000_000,
        installDir: '/x',
      },
    });
    const response = await h.request(
      'GET',
      '/projects/alpha/access',
      'admin-alpha',
    );
    expect(((await response.json()) as { data: unknown }).data).toMatchObject({
      browser: 'not-ready',
    });
  });

  test('a live session carries its surface id; a closed one does not', async () => {
    const h = harness({ surfaceIdFor: (id) => `browser:${id.slice(3)}:g1` });
    const created = (await (await h.create('operator')).json()) as {
      data: { browserSessionId: string; surfaceId?: string };
    };
    const id = created.data.browserSessionId;
    expect(created.data.surfaceId).toBe(`browser:${id.slice(3)}:g1`);
    const read = (await (
      await h.request('GET', `/sessions/${id}`, 'operator')
    ).json()) as { data: { surfaceId?: string } };
    expect(read.data.surfaceId).toBe(`browser:${id.slice(3)}:g1`);
    const list = (await (
      await h.request('GET', '/sessions?projectSlug=alpha', 'operator')
    ).json()) as { data: Array<{ surfaceId?: string }> };
    expect(list.data[0]?.surfaceId).toBe(`browser:${id.slice(3)}:g1`);
    const closed = (await (
      await h.request('DELETE', `/sessions/${id}`, 'operator')
    ).json()) as { data: { surfaceId?: string; state: string } };
    expect(closed.data.state).toBe('closed');
    expect(closed.data.surfaceId).toBeUndefined();
  });

  test('history and viewport drive the session; a contributor is refused both', async () => {
    const h = harness();
    const created = (await (await h.create('admin-alpha')).json()) as {
      data: { browserSessionId: string };
    };
    const id = created.data.browserSessionId;
    const reload = await h.request(
      'POST',
      `/sessions/${id}/history`,
      'admin-alpha',
      {
        action: 'reload',
      },
    );
    expect(reload.status).toBe(200);
    expect(
      (
        (await reload.json()) as {
          data: { history: { entries: Array<{ kind: string }> } };
        }
      ).data.history.entries.at(-1)?.kind,
    ).toBe('reloaded');
    // No earlier page: a typed refusal, not a crash.
    const back = await h.request(
      'POST',
      `/sessions/${id}/history`,
      'admin-alpha',
      {
        action: 'back',
      },
    );
    expect(back.status).toBe(409);
    expect(((await back.json()) as { code: string }).code).toBe(
      'no-history-entry',
    );
    expect(
      (
        await h.request('POST', `/sessions/${id}/history`, 'admin-alpha', {
          action: 'sideways',
        })
      ).status,
    ).toBe(400);
    const phone = {
      width: 393,
      height: 852,
      deviceScaleFactor: 3,
      mobile: true,
    };
    const resized = await h.request(
      'POST',
      `/sessions/${id}/viewport`,
      'admin-alpha',
      {
        viewport: phone,
      },
    );
    expect(resized.status).toBe(200);
    expect(
      ((await resized.json()) as { data: { viewport: unknown } }).data.viewport,
    ).toEqual(phone);
    expect(
      (
        await h.request('POST', `/sessions/${id}/viewport`, 'admin-alpha', {
          viewport: { width: 5, height: 852, deviceScaleFactor: 3 },
        })
      ).status,
    ).toBe(400);
    for (const [path, body] of [
      ['history', { action: 'reload' }],
      ['viewport', { viewport: phone }],
    ] as const) {
      expect(
        (
          await h.request(
            'POST',
            `/sessions/${id}/${path}`,
            'contributor-alpha',
            body,
          )
        ).status,
      ).toBe(403);
    }
  });

  test('a refused URL names why (the pane turns it into a sentence)', async () => {
    const h = harness();
    const created = (await (await h.create('operator')).json()) as {
      data: { browserSessionId: string };
    };
    const refused = await h.request(
      'POST',
      `/sessions/${created.data.browserSessionId}/navigate`,
      'operator',
      { url: 'file:///etc/passwd' },
    );
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({
      success: false,
      code: 'url-not-allowed',
      detail: { urlRejection: 'unsupported-scheme' },
    });
  });
});

describe('browser routes: wave 2 fix round', () => {
  test("reuse restores only the CALLER's own open session for exactly that URL (S1)", async () => {
    const h = harness();
    const url = 'http://localhost:5173/app?tab=1';
    const open = async (credential: string, reuse: boolean) =>
      (await (
        await h.request('POST', '/sessions', credential, {
          projectSlug: 'alpha',
          url,
          ...(reuse ? { reuse: true } : {}),
        })
      ).json()) as { data: { browserSessionId: string; principalKey: string } };
    const operators = await open('operator', false);
    // An admin asking to reuse gets a NEW session in their own profile, not
    // the operator's session for the same URL.
    const admins = await open('admin-alpha', true);
    expect(admins.data.browserSessionId).not.toBe(
      operators.data.browserSessionId,
    );
    expect(admins.data.principalKey).toBe('principal:admin-alpha');
    // The operator reusing gets its own session back, matched on the FULL
    // normalized URL (the list view's redacted URL would not match it).
    const again = await open('operator', true);
    expect(again.data.browserSessionId).toBe(operators.data.browserSessionId);
    // A different query is a different page: not reused.
    const other = (await (
      await h.request('POST', '/sessions', 'operator', {
        projectSlug: 'alpha',
        url: 'http://localhost:5173/app?tab=2',
        reuse: true,
      })
    ).json()) as { data: { browserSessionId: string } };
    expect(other.data.browserSessionId).not.toBe(
      operators.data.browserSessionId,
    );
    // A closed session is never reused.
    await h.request(
      'DELETE',
      `/sessions/${operators.data.browserSessionId}`,
      'operator',
    );
    const fresh = await open('operator', true);
    expect(fresh.data.browserSessionId).not.toBe(
      operators.data.browserSessionId,
    );
  });

  test('the summary view carries the latest few actions and the server-derived activity (S4, S5)', async () => {
    const h = harness();
    const created = (await (await h.create('operator')).json()) as {
      data: { browserSessionId: string };
    };
    const id = created.data.browserSessionId;
    for (let i = 0; i < 8; i += 1)
      await h.request('POST', `/sessions/${id}/navigate`, 'operator', {
        url: `https://example.com/${i}?secret=${i}`,
      });
    const summary = (await (
      await h.request('GET', `/sessions/${id}?view=summary`, 'operator')
    ).json()) as {
      data: {
        history: { entries: Array<{ url?: string }>; total: number };
        activity: { lastDriver: { kind: string }; agentDriven: boolean };
      };
    };
    expect(summary.data.history.entries).toHaveLength(5);
    expect(summary.data.history.total).toBe(9);
    expect(summary.data.history.entries.at(-1)?.url).toBe(
      'https://example.com/7',
    );
    expect(summary.data.activity).toMatchObject({
      lastDriver: { kind: 'operator' },
      agentDriven: false,
    });
    const full = (await (
      await h.request('GET', `/sessions/${id}`, 'operator')
    ).json()) as { data: { history: { entries: unknown[] } } };
    expect(full.data.history.entries).toHaveLength(9);
    expect(
      (await h.request('GET', `/sessions/${id}?view=everything`, 'operator'))
        .status,
    ).toBe(400);
  });

  test('Back onto an entry the host refuses is a typed 409, and a browser protocol error a 502 (S7)', async () => {
    const h = harness({
      cdp: (method) => {
        if (method === 'Page.getNavigationHistory')
          return {
            currentIndex: 1,
            entries: [
              { id: 1, url: 'chrome://settings' },
              { id: 2, url: 'https://example.com/' },
            ],
          };
        if (method === 'Page.navigateToHistoryEntry')
          throw new BrowserHostPolicyError(method, 'url-not-allowed');
        if (method === 'Page.reload')
          throw new CdpProtocolError(method, -32000, 'Not attached');
        return {};
      },
    });
    const created = (await (await h.create('operator')).json()) as {
      data: { browserSessionId: string };
    };
    const id = created.data.browserSessionId;
    const back = await h.request(
      'POST',
      `/sessions/${id}/history`,
      'operator',
      {
        action: 'back',
      },
    );
    expect(back.status).toBe(409);
    expect(await back.json()).toEqual({
      success: false,
      code: 'url-not-allowed',
    });
    const reload = await h.request(
      'POST',
      `/sessions/${id}/history`,
      'operator',
      { action: 'reload' },
    );
    expect(reload.status).toBe(502);
    expect(await reload.json()).toEqual({
      success: false,
      code: 'browser-error',
    });
  });

  test('a navigation Station refused (its own listener) is credited to Station (D2)', async () => {
    const h = harness({
      cdp: (method) =>
        method === 'Page.navigate'
          ? { errorText: 'net::ERR_BLOCKED_BY_CLIENT' }
          : {},
    });
    const created = (await (await h.create('operator')).json()) as {
      data: { browserSessionId: string };
    };
    const id = created.data.browserSessionId;
    const own = (await (
      await h.request('POST', `/sessions/${id}/navigate`, 'operator', {
        url: 'http://127.0.0.1:4101/',
      })
    ).json()) as { data: { blocked?: string; errorText?: string } };
    expect(own.data).toMatchObject({
      blocked: 'station-listener',
      errorText: 'net::ERR_BLOCKED_BY_CLIENT',
    });
    const elsewhere = (await (
      await h.request('POST', `/sessions/${id}/navigate`, 'operator', {
        url: 'http://127.0.0.1:9999/',
      })
    ).json()) as { data: { blocked?: string } };
    expect(elsewhere.data.blocked).toBeUndefined();
    // A Project admin gets the generic refusal: telling them which
    // addresses are Station's would map this host's interfaces (S-N3).
    const adminSession = (await (await h.create('admin-alpha')).json()) as {
      data: { browserSessionId: string };
    };
    const admin = (await (
      await h.request(
        'POST',
        `/sessions/${adminSession.data.browserSessionId}/navigate`,
        'admin-alpha',
        { url: 'http://127.0.0.1:4101/' },
      )
    ).json()) as { data: { blocked?: string; errorText?: string } };
    expect(admin.data.errorText).toBe('net::ERR_BLOCKED_BY_CLIENT');
    expect(admin.data.blocked).toBeUndefined();
  });
});

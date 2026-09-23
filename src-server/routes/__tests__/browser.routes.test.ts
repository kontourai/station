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
import {
  type BrowserSessionActor,
  BrowserSessionRegistry,
} from '../../services/browser/browser-session-registry.js';
import type { ChromiumAcquisitionStatus } from '../../services/browser/chromium-acquisition.js';
import { EventBus } from '../../services/orchestration/event-bus.js';
import { createBrowserRoutes } from '../browser.js';

function fakeHost(): BrowserHost {
  let seq = 0;
  const cdp: CdpTransport = {
    send: async <R>() => ({}) as R,
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
    createHost: () => fakeHost(),
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
      isRequestPrincipalCurrent: (request) =>
        principalCurrent && isRuntimeRequestPrincipalCurrent(request, security),
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

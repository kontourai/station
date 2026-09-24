/**
 * Browser sessions → live surfaces (#90 wave 2): registration follows the
 * session's life (live, crash, reopen, close), and every surface route is
 * authorized D5 + D7 through the REAL live-surface routes and registry.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createLiveSurfaceRoutes } from '../../../routes/live-surface.js';
import { LiveSurfaceRegistry } from '../../live-surface/registry.js';
import { createBrowserProjectAuthorizer } from '../browser-access.js';
import type { BrowserHost, CdpTransport } from '../browser-host.js';
import {
  BrowserLiveSurfaces,
  browserSurfaceId,
} from '../browser-live-surfaces.js';
import {
  type BrowserSessionActor,
  BrowserSessionRegistry,
} from '../browser-session-registry.js';

const OPERATOR: BrowserSessionActor = { kind: 'operator' };
const ADMIN_PRINCIPAL = 'human:deployment:admin';
const ADMIN: BrowserSessionActor = {
  kind: 'project-admin',
  principalId: ADMIN_PRINCIPAL,
};

function fakeHost(id: number) {
  const exitListeners = new Set<(reason: string) => void>();
  const listeners = new Map<string, Set<(p: unknown, s?: string) => void>>();
  const sent: Array<{ method: string; params?: object; sessionId?: string }> =
    [];
  let targetSeq = 0;
  const cdp: CdpTransport = {
    async send<R>(method: string, params?: object, sessionId?: string) {
      sent.push({ method, params, sessionId });
      return {} as R;
    },
    on(event, fn) {
      const set = listeners.get(event) ?? new Set();
      set.add(fn);
      listeners.set(event, set);
      return () => set.delete(fn);
    },
    close: async () => {},
    closed: new Promise(() => {}),
  };
  const host = {
    kind: 'server-chromium' as const,
    shutdown: vi.fn(async () => {}),
    async openTarget() {
      targetSeq += 1;
      return {
        targetId: `H${id}-T${targetSeq}`,
        cdpSessionId: `H${id}-S${targetSeq}`,
      };
    },
    cdp: () => cdp,
    async closeTarget() {},
    onExit(fn: (reason: string) => void) {
      exitListeners.add(fn);
      return () => exitListeners.delete(fn);
    },
    crash(reason = 'browser process exited (signal SIGKILL)') {
      for (const fn of [...exitListeners]) fn(reason);
    },
    emit(event: string, params: unknown, sessionId: string) {
      for (const fn of listeners.get(event) ?? []) fn(params, sessionId);
    },
    sent,
  } satisfies BrowserHost & Record<string, unknown>;
  return host;
}

type Role = 'operator' | 'admin' | 'admin2' | 'contributor' | 'nobody';
const ADMIN2_PRINCIPAL = 'human:deployment:admin2';
/** Principals whose admin standing has been withdrawn (mid-stream tests). */
const demoted = new Set<string>();

/** The request names who is calling; the fake membership reads it. */
function requestAs(role: Role, path: string, init?: RequestInit) {
  return new Request(`http://station.test${path}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), 'x-test-role': role },
  });
}
const roleOf = (request: Request) =>
  (request.headers.get('x-test-role') ?? 'nobody') as Role;

const authorizeProject = createBrowserProjectAuthorizer({
  operator: async (request) => {
    if (roleOf(request) !== 'operator') throw new Error('not the operator');
  },
  authority: (request) => ({ request }) as never,
  membership: {
    async readableProjectAdmissions(authority) {
      const role = roleOf(
        (authority as unknown as { request: Request }).request,
      );
      if (role !== 'admin' && role !== 'admin2' && role !== 'contributor')
        return [];
      const id =
        role === 'admin'
          ? ADMIN_PRINCIPAL
          : role === 'admin2'
            ? ADMIN2_PRINCIPAL
            : 'human:deployment:contrib';
      return [
        {
          scope: { localProjectId: 'alpha' },
          member: {
            status: 'active',
            role:
              role === 'contributor' || demoted.has(id)
                ? 'contributor'
                : 'admin',
            principal: { id },
          },
        },
      ] as never;
    },
  },
});

const homes: string[] = [];
afterEach(() => {
  demoted.clear();
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

function harness() {
  const stationHome = mkdtempSync(join(tmpdir(), 'station-browser-surf-'));
  homes.push(stationHome);
  const hosts: Array<ReturnType<typeof fakeHost>> = [];
  let ids = 0;
  const sessions = new BrowserSessionRegistry({
    stationHome,
    createHost: () => {
      const host = fakeHost(hosts.length + 1);
      hosts.push(host);
      return host;
    },
    newId: () =>
      `bs_00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
  });
  // Frequent heartbeats so a running stream re-checks its grant quickly.
  const surfaces = new LiveSurfaceRegistry({ hub: { heartbeatMs: 20 } });
  const binder = new BrowserLiveSurfaces({
    sessions,
    surfaces,
    authorizeProject,
  });
  const routes = createLiveSurfaceRoutes(surfaces, {
    isRequestPrincipalCurrent: () => true,
    principalRecheckMs: 10,
    resolveHumanCaller: (c) => {
      const role = roleOf(c.req.raw);
      if (role === 'nobody') return null;
      return {
        principal:
          role === 'admin'
            ? ADMIN_PRINCIPAL
            : role === 'admin2'
              ? ADMIN2_PRINCIPAL
              : role === 'operator'
                ? 'human:local:operator'
                : 'human:deployment:contrib',
        device: `device:${role}`,
      };
    },
  });
  return { sessions, surfaces, binder, routes, hosts };
}

async function openSession(
  sessions: BrowserSessionRegistry,
  actor: BrowserSessionActor,
) {
  return sessions.createSession({
    projectId: 'alpha',
    projectSlug: 'alpha',
    url: 'https://example.com/',
    actor,
  });
}

describe('BrowserLiveSurfaces registration', () => {
  test('a live session registers a surface named for its session and generation', async () => {
    const { sessions, surfaces, binder } = harness();
    const session = await openSession(sessions, OPERATOR);
    const surfaceId = browserSurfaceId(session.browserSessionId, 1);
    expect(surfaceId).toBe('browser:00000000-0000-4000-8000-000000000001:g1');
    expect(binder.surfaceIdFor(session.browserSessionId)).toBe(surfaceId);
    expect(surfaces.get(surfaceId)).toBeDefined();
  });

  test('a crash unregisters the surface; a reopen registers a NEW surface id', async () => {
    const { sessions, surfaces, binder, hosts } = harness();
    const session = await openSession(sessions, OPERATOR);
    const first = binder.surfaceIdFor(session.browserSessionId)!;
    hosts[0]!.crash();
    expect(sessions.getSession(session.browserSessionId)?.state).toBe(
      'needs-reopen',
    );
    expect(binder.surfaceIdFor(session.browserSessionId)).toBeUndefined();
    await vi.waitFor(() => expect(surfaces.get(first)).toBeUndefined());

    await sessions.reopenSession(session.browserSessionId, OPERATOR);
    const second = binder.surfaceIdFor(session.browserSessionId);
    expect(second).toBe(browserSurfaceId(session.browserSessionId, 2));
    expect(second).not.toBe(first);
    expect(surfaces.get(second!)).toBeDefined();
    expect(surfaces.get(first)).toBeUndefined();
  });

  test('closing a session unregisters its surface', async () => {
    const { sessions, surfaces, binder } = harness();
    const session = await openSession(sessions, OPERATOR);
    const surfaceId = binder.surfaceIdFor(session.browserSessionId)!;
    await sessions.closeSession(session.browserSessionId, OPERATOR);
    await vi.waitFor(() => expect(surfaces.get(surfaceId)).toBeUndefined());
  });

  test('disposing the binder (server stop) unregisters every surface', async () => {
    const { sessions, surfaces, binder } = harness();
    const session = await openSession(sessions, OPERATOR);
    const surfaceId = binder.surfaceIdFor(session.browserSessionId)!;
    await binder.dispose();
    expect(surfaces.get(surfaceId)).toBeUndefined();
    expect(surfaces.size).toBe(0);
  });

  test('a page dialog is answered and recorded in the session history (D6)', async () => {
    const { sessions, hosts } = harness();
    const session = await openSession(sessions, OPERATOR);
    const cdpSession = 'H1-S1';
    hosts[0]!.emit(
      'Page.javascriptDialogOpening',
      { type: 'alert', message: 'saved!' },
      cdpSession,
    );
    expect(hosts[0]!.sent.at(-1)).toMatchObject({
      method: 'Page.handleJavaScriptDialog',
      params: { accept: false },
      sessionId: cdpSession,
    });
    const history = sessions.getSession(session.browserSessionId)!.history;
    expect(history.entries.at(-1)).toMatchObject({
      kind: 'dialog-handled',
      detail: 'alert dismissed automatically: saved!',
    });
  });

  test("a navigation that follows a person's input through the surface is theirs (a followed link)", async () => {
    const { sessions, surfaces, binder, routes, hosts } = harness();
    const session = await openSession(sessions, OPERATOR);
    const surfaceId = binder.surfaceIdFor(session.browserSessionId)!;
    const sent = await routes.fetch(
      requestAs('operator', `/${surfaceId}/input`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          epoch: surfaces.get(surfaceId)!.lease.snapshot().epoch,
          events: [
            { kind: 'pointer', type: 'down', x: 5, y: 5, button: 'left' },
            { kind: 'pointer', type: 'up', x: 5, y: 5, button: 'left' },
          ],
        }),
      }),
    );
    expect(sent.status).toBe(200);
    hosts[0]!.emit(
      'Page.frameNavigated',
      { frame: { id: 'f', url: 'https://example.com/linked' } },
      'H1-S1',
    );
    expect(
      sessions.getSession(session.browserSessionId)!.history.entries.at(-1),
    ).toMatchObject({
      kind: 'link-followed',
      actor: { kind: 'system' },
      cause: { kind: 'operator' },
      url: 'https://example.com/linked',
    });
  });

  const drive = (
    routes: ReturnType<typeof harness>['routes'],
    surfaces: ReturnType<typeof harness>['surfaces'],
    role: Role,
    surfaceId: string,
    events: object[],
  ) =>
    routes.fetch(
      requestAs(role, `/${surfaceId}/input`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          epoch: surfaces.get(surfaceId)!.lease.snapshot().epoch,
          events,
        }),
      }),
    );

  test("moving the mouse or scrolling arms nothing: a page navigation after it is the page's (F1)", async () => {
    const { sessions, surfaces, binder, routes, hosts } = harness();
    const session = await openSession(sessions, OPERATOR);
    const surfaceId = binder.surfaceIdFor(session.browserSessionId)!;
    const moved = await drive(routes, surfaces, 'operator', surfaceId, [
      { kind: 'pointer', type: 'move', x: 5, y: 5 },
      { kind: 'pointer', type: 'wheel', x: 5, y: 5, deltaY: 100 },
    ]);
    expect(moved.status).toBe(200);
    hosts[0]!.emit(
      'Page.frameNavigated',
      { frame: { id: 'f', url: 'https://example.com/timer' } },
      'H1-S1',
    );
    const entries = sessions.getSession(session.browserSessionId)!.history
      .entries;
    expect(entries.some((entry) => entry.kind === 'link-followed')).toBe(false);
    expect(entries.at(-1)).toMatchObject({ kind: 'page-navigated' });
  });

  test("a click in an admin's session names the right person: the admin, or the operator (F2)", async () => {
    const { sessions, surfaces, binder, routes, hosts } = harness();
    const session = await openSession(sessions, ADMIN);
    const surfaceId = binder.surfaceIdFor(session.browserSessionId)!;
    const click = [
      { kind: 'pointer', type: 'down', x: 5, y: 5, button: 'left' },
      { kind: 'pointer', type: 'up', x: 5, y: 5, button: 'left' },
    ];
    const lastCause = () =>
      sessions.getSession(session.browserSessionId)!.history.entries.at(-1)
        ?.cause;
    expect(
      (await drive(routes, surfaces, 'operator', surfaceId, click)).status,
    ).toBe(200);
    hosts[0]!.emit(
      'Page.frameNavigated',
      { frame: { id: 'f', url: 'https://example.com/by-operator' } },
      'H1-S1',
    );
    expect(lastCause()).toEqual({ kind: 'operator' });
    expect(
      (await drive(routes, surfaces, 'admin', surfaceId, click)).status,
    ).toBe(200);
    hosts[0]!.emit(
      'Page.frameNavigated',
      { frame: { id: 'f', url: 'https://example.com/by-admin' } },
      'H1-S1',
    );
    expect(lastCause()).toEqual({
      kind: 'project-admin',
      principalId: ADMIN_PRINCIPAL,
    });
  });

  test('a main-frame navigation the page made on its own is recorded', async () => {
    const { sessions, hosts } = harness();
    const session = await openSession(sessions, OPERATOR);
    hosts[0]!.emit(
      'Page.frameNavigated',
      { frame: { id: 'f', url: 'https://example.com/next' } },
      'H1-S1',
    );
    // A subframe is not the page's URL.
    hosts[0]!.emit(
      'Page.frameNavigated',
      { frame: { id: 'g', parentId: 'f', url: 'https://ads.example/' } },
      'H1-S1',
    );
    const record = sessions.getSession(session.browserSessionId)!;
    expect(record.url).toBe('https://example.com/next');
    expect(record.history.entries.at(-1)).toMatchObject({
      kind: 'page-navigated',
      url: 'https://example.com/next',
    });
  });
});

describe('browser surface routes authorize D5 + D7', () => {
  const lease = (
    routes: ReturnType<typeof harness>['routes'],
    role: Role,
    surfaceId: string,
  ) => routes.fetch(requestAs(role, `/${surfaceId}/lease`));
  const input = (
    routes: ReturnType<typeof harness>['routes'],
    role: Role,
    surfaceId: string,
  ) =>
    routes.fetch(
      requestAs(role, `/${surfaceId}/input`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          epoch: 0,
          events: [{ kind: 'text', text: 'hi' }],
        }),
      }),
    );

  test('a Project contributor is refused view and input on every session', async () => {
    const { sessions, binder, routes } = harness();
    const operatorSession = await openSession(sessions, OPERATOR);
    const adminSession = await openSession(sessions, ADMIN);
    // A session in the contributor's OWN profile (opened while they were an
    // admin, say): only Project standing can refuse it, not profile (D5).
    const ownSession = await openSession(sessions, {
      kind: 'project-admin',
      principalId: 'human:deployment:contrib',
    });
    for (const session of [operatorSession, adminSession, ownSession]) {
      const surfaceId = binder.surfaceIdFor(session.browserSessionId)!;
      const viewed = await lease(routes, 'contributor', surfaceId);
      expect(viewed.status).toBe(403);
      expect(await viewed.json()).toEqual({
        success: false,
        code: 'access-denied',
      });
      expect((await input(routes, 'contributor', surfaceId)).status).toBe(403);
    }
  });

  test("a Project admin cannot view or drive the operator's session, but can their own", async () => {
    const { sessions, binder, routes, hosts } = harness();
    const operatorSession = await openSession(sessions, OPERATOR);
    const adminSession = await openSession(sessions, ADMIN);
    const operatorSurface = binder.surfaceIdFor(
      operatorSession.browserSessionId,
    )!;
    const adminSurface = binder.surfaceIdFor(adminSession.browserSessionId)!;
    expect((await lease(routes, 'admin', operatorSurface)).status).toBe(403);
    expect((await input(routes, 'admin', operatorSurface)).status).toBe(403);
    expect((await lease(routes, 'admin', adminSurface)).status).toBe(200);
    const sent = await input(routes, 'admin', adminSurface);
    expect(sent.status).toBe(200);
    // The admin's own profile runs in its own browser process (D7).
    expect(hosts).toHaveLength(2);
    expect(hosts[1]!.sent.at(-1)).toMatchObject({
      method: 'Input.insertText',
      params: { text: 'hi' },
    });
  });

  test('the operator can view and drive every session', async () => {
    const { sessions, binder, routes } = harness();
    const adminSession = await openSession(sessions, ADMIN);
    const surfaceId = binder.surfaceIdFor(adminSession.browserSessionId)!;
    expect((await lease(routes, 'operator', surfaceId)).status).toBe(200);
    expect((await input(routes, 'operator', surfaceId)).status).toBe(200);
  });

  test('an authorization check with no request to judge is refused', async () => {
    const { sessions, surfaces, binder } = harness();
    const session = await openSession(sessions, OPERATOR);
    const entry = surfaces.get(binder.surfaceIdFor(session.browserSessionId)!)!;
    expect(await entry.authorize('human:local:operator', 'view')).toBe(false);
    expect(
      await entry.authorize('human:local:operator', 'view', {
        request: requestAs('operator', '/'),
      }),
    ).toBe(true);
  });

  test("an admin's request never authorizes a DIFFERENT live-surface principal", async () => {
    const { sessions, surfaces, binder } = harness();
    const session = await openSession(sessions, ADMIN);
    const entry = surfaces.get(binder.surfaceIdFor(session.browserSessionId)!)!;
    const request = requestAs('admin', '/');
    expect(await entry.authorize(ADMIN_PRINCIPAL, 'input', { request })).toBe(
      true,
    );
    expect(
      await entry.authorize('human:deployment:someone-else', 'input', {
        request,
      }),
    ).toBe(false);
  });

  test("after a crash the old surface id is a 404, not another process's stream", async () => {
    const { sessions, binder, routes, hosts } = harness();
    const session = await openSession(sessions, OPERATOR);
    const surfaceId = binder.surfaceIdFor(session.browserSessionId)!;
    expect((await lease(routes, 'operator', surfaceId)).status).toBe(200);
    hosts[0]!.crash();
    await vi.waitFor(async () =>
      expect((await lease(routes, 'operator', surfaceId)).status).toBe(404),
    );
  });
});

describe('browser surfaces between admins, and over a running stream', () => {
  const lease = (
    routes: ReturnType<typeof harness>['routes'],
    role: Role,
    surfaceId: string,
  ) => routes.fetch(requestAs(role, `/${surfaceId}/lease`));

  test("two admins of the same Project never see each other's sessions (D7)", async () => {
    const { sessions, binder, routes } = harness();
    const first = await openSession(sessions, ADMIN);
    const second = await openSession(sessions, {
      kind: 'project-admin',
      principalId: ADMIN2_PRINCIPAL,
    });
    const firstSurface = binder.surfaceIdFor(first.browserSessionId)!;
    const secondSurface = binder.surfaceIdFor(second.browserSessionId)!;
    expect((await lease(routes, 'admin', firstSurface)).status).toBe(200);
    expect((await lease(routes, 'admin2', secondSurface)).status).toBe(200);
    expect((await lease(routes, 'admin', secondSurface)).status).toBe(403);
    expect((await lease(routes, 'admin2', firstSurface)).status).toBe(403);
  });

  test('a running frames stream ends when the viewer stops being a Project admin', async () => {
    const { sessions, binder, routes } = harness();
    const session = await openSession(sessions, ADMIN);
    const surfaceId = binder.surfaceIdFor(session.browserSessionId)!;
    const response = await routes.fetch(
      requestAs('admin', `/${surfaceId}/frames`),
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    // The stream is live: records keep arriving while the grant holds.
    for (let i = 0; i < 4; i += 1)
      expect((await reader.read()).done).toBe(false);
    demoted.add(ADMIN_PRINCIPAL);
    const deadline = Date.now() + 2_000;
    let ended = false;
    while (!ended && Date.now() < deadline) {
      ended = (await reader.read()).done;
    }
    expect(ended).toBe(true);
  });
});

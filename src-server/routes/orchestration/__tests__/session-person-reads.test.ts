/**
 * #3427: the person-facing Session reads at their own route seam, for what
 * the runtime-composition suites cannot reach with the operator credential:
 *
 * - an account principal is held to the Projects it may `view` (the operator
 *   holds every Project, so the composed suite cannot show a refusal);
 * - the leaf's own refusal of an internal request (the composed suite's
 *   station-control guard refuses an unmapped route first).
 *
 * The routes are the real factories; only the records behind them are stubs.
 */

import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import {
  getSessionDigest,
  listSessionActivity,
  waitForSession,
} from '@kontourai/station-sdk/client';
import { Hono } from 'hono';
import { afterEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { configureRuntimePublicRoutes } from '../../../runtime/routes/runtime-routes.js';
import { bindStationControlRequestAuthority } from '../../../security/station-control-request-authority.js';
import { SessionTurnWaiter } from '../../../services/orchestration/session-turn-wait.js';
import { EnvironmentSecurityService } from '../../../services/ssh/environment-security-service.js';
import type { StationControlScope } from '../../../tools/station-control-policy.js';
import { createSessionPersonWaitRoutes } from '../session-agent-control.js';
import {
  createSessionPersonActivityRoutes,
  personSessionScope,
} from '../session-project-activity.js';

const DANA = 'human:deployment:dana';
const SCOPES: Record<string, StationControlScope> = {
  'in-viewable': { kind: 'project', id: 'p-viewable' },
  'in-also-viewable': { kind: 'project', id: 'p-also-viewable' },
  'in-hidden': { kind: 'project', id: 'p-hidden' },
  global: { kind: 'global' },
  unreadable: { kind: 'unreadable' },
};
const SESSIONS = Object.keys(SCOPES);

/** A read-model row with the fields the routes read (the stub is untyped). */
const summary = (threadId: string) => ({
  threadId,
  provider: 'codex',
  status: 'ready',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  lastEventAt: `2026-10-01T00:00:0${SESSIONS.indexOf(threadId)}.000Z`,
});

const scopeOf = (id: string) => SCOPES[id];
const dispatchScope = {
  target: (ref: { kind: string; threadId?: string; conversationId?: string }) =>
    ({
      scope: scopeOf(ref.threadId ?? ref.conversationId ?? ''),
      host: false,
      remote: false,
    }) as never,
  conversationExists: () => true,
  ownProjectSlug: () => undefined,
};
/** As in production: only the deployment account (Dana) is held to memberships. */
const personMayView = (userId: string, projectId: string) =>
  userId !== DANA || ['p-viewable', 'p-also-viewable'].includes(projectId);
const preview = {
  select: <T>(branches: { enabled: () => T; disabled: () => T }) =>
    branches.enabled(),
};

const OPERATOR = 'operator-principal';
/** Only a deployment account (Dana) is held to her memberships. */
const personViewsEveryProject = (userId: string) => userId !== DANA;

function app(
  internal?: 'caller-less' | 'server',
  principalId: string = DANA,
  mount = '/r',
  root = new Hono(),
) {
  root.use(`${mount}/*`, async (c, next) => {
    if (internal)
      bindStationControlRequestAuthority(c.req.raw, { kind: internal });
    await next();
  });
  const orchestrationService = {
    canUserReadSession: () => true,
    currentConversationSessionId: (id: string) => id,
    firstStartedMetadataOfThread: () => undefined,
    listSessionReadModel: async (
      _authority: unknown,
      options?: { threadIds?: readonly string[] },
    ) => (options?.threadIds ?? SESSIONS).map(summary),
    hasActiveTurn: () => false,
  };
  const eventStore = {
    conversationForSession: () => undefined,
    conversationSessions: () => [],
    conversationTitle: () => undefined,
    listSessionsNamingParents: () => ({ sessions: [], truncated: false }),
    listThreadIdsStartedIn: () => SESSIONS,
    readTurnDigestFacts: () => ({
      turns: [],
      totalTurns: 0,
      hasMore: false,
    }),
    listEventsByMethods: () => [],
    readSessionInventoryHighWater: () => 0,
  };
  const resolvePrincipal = () =>
    ({ id: principalId, kind: 'human', display: 'Person' }) as never;
  root.route(
    mount,
    createSessionPersonActivityRoutes({
      orchestrationService: orchestrationService as never,
      eventStore: eventStore as never,
      stationControlDispatchScope: dispatchScope as never,
      resolvePrincipal,
      projectIdForSlug: (slug) =>
        ({ viewable: 'p-viewable', hidden: 'p-hidden' })[slug],
      personMayView,
      personViewsEveryProject,
      preview,
    }),
  );
  const scope = personSessionScope({
    stationControlDispatchScope: dispatchScope as never,
    personMayView,
    personViewsEveryProject,
  });
  root.route(
    mount,
    createSessionPersonWaitRoutes({
      orchestrationService: orchestrationService as never,
      eventStore: eventStore as never,
      resolvePrincipal,
      waiter: new SessionTurnWaiter({
        foldEvents: () => [],
        headSequence: () => 0,
        coordinatorBusy: () => false,
        subscribe: () => () => {},
      }),
      personSeesSession: scope.seesSession,
      preview,
    }),
  );
  return root;
}

const read = async (root: Hono, path: string) => {
  const response = await root.request(path);
  return { status: response.status, body: (await response.json()) as any };
};

describe('an account principal is held to the Projects it may view', () => {
  test('the list holds only viewable Projects and the global space', async () => {
    const listed = await read(app(), '/r/activity');
    expect(listed.status).toBe(200);
    expect(
      listed.body.data.sessions
        .map((row: { sessionId: string }) => row.sessionId)
        .sort(),
    ).toEqual(['global', 'in-also-viewable', 'in-viewable']);
  });

  test('a Project it may not view reads like one that does not exist', async () => {
    const root = app();
    for (const slug of ['hidden', 'missing']) {
      const answer = await read(root, `/r/activity?projectSlug=${slug}`);
      expect([slug, answer.status, answer.body.code]).toEqual([
        slug,
        404,
        'project_not_found',
      ]);
    }
    const narrowed = await read(root, '/r/activity?projectSlug=viewable');
    expect(
      narrowed.body.data.sessions.map(
        (row: { sessionId: string }) => row.sessionId,
      ),
    ).toEqual(['in-viewable']);
    // The candidates named both viewable Projects: the narrowing is the
    // row's own Project, not the candidate selection.
  });

  test('a digest and a wait refuse a Session in a Project it may not view, or whose Project cannot be read', async () => {
    const root = app();
    const rows: unknown[] = [];
    for (const id of SESSIONS) {
      const digest = await read(root, `/r/${id}/digest`);
      const wait = await read(root, `/r/${id}/wait?until=idle`);
      rows.push([id, digest.status, wait.status]);
    }
    expect(rows).toEqual([
      ['in-viewable', 200, 200],
      ['in-also-viewable', 200, 200],
      ['in-hidden', 404, 404],
      ['global', 200, 200],
      ['unreadable', 404, 404],
    ]);
  });
});

describe('a person who may view every Project', () => {
  test('still sees their own Session whose Project cannot be read (its folder is gone)', async () => {
    const root = app(undefined, OPERATOR);
    const listed = await read(root, '/r/activity');
    expect(
      listed.body.data.sessions
        .map((row: { sessionId: string }) => row.sessionId)
        .sort(),
    ).toEqual([...SESSIONS].sort());
    for (const path of [
      '/r/unreadable/digest',
      '/r/unreadable/wait?until=idle',
    ])
      expect([path, (await read(root, path)).status]).toEqual([path, 200]);
  });
});

describe('the leaves refuse every internal request themselves', () => {
  test.each(['caller-less', 'server'] as const)('%s', async (kind) => {
    const root = app(kind);
    for (const path of [
      '/r/activity',
      '/r/global/digest',
      '/r/global/wait?until=idle',
    ]) {
      const answer = await read(root, path);
      expect([path, answer.status, answer.body.code]).toEqual([
        path,
        403,
        'person_credential_required',
      ]);
    }
  });
});

describe('the SDK fetchers read the real routes and the real handshake', () => {
  const makeTempDir = trackTempDirs();
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  test('each fetcher parses its route’s answer, gated on the advertised flag', async () => {
    // The handshake as Station's own public route serves it, beside the
    // leaves at the path the fetchers address.
    const root = new Hono();
    configureRuntimePublicRoutes(
      root as never,
      new EnvironmentSecurityService({
        homeDir: makeTempDir('person-reads-handshake-'),
        environment: {},
      }),
    );
    app(undefined, OPERATOR, '/api/orchestration/session-reads', root);
    let resolvePort!: (port: number) => void;
    const listening = new Promise<number>((resolve) => {
      resolvePort = resolve;
    });
    const server = serve(
      { fetch: root.fetch, hostname: '127.0.0.1', port: 0 },
      (info) => resolvePort((info as AddressInfo).port),
    );
    closers.push(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    const origin = `http://127.0.0.1:${await listening}`;

    const waited = await waitForSession(origin, 'global', { until: 'idle' });
    expect(waited).toMatchObject({
      sessionId: 'global',
      settled: true,
      timedOut: false,
      state: 'idle',
      eventCursor: 0,
    });
    const page = await listSessionActivity(origin, { limit: 2 });
    expect(page.sessions).toHaveLength(2);
    expect(page.sessions[0]).toMatchObject({
      sessionId: expect.any(String),
      engine: 'codex',
      status: expect.any(String),
      turnRunning: false,
    });
    expect(typeof page.nextCursor).toBe('string');
    const digest = await getSessionDigest(origin, 'global');
    expect(digest.session).toMatchObject({
      sessionId: 'global',
      conversationId: 'global',
      turnCount: 0,
    });
    expect(digest.page.order).toBe('newest-first');
    // A refusal keeps its status and code.
    await expect(
      listSessionActivity(origin, { projectSlug: 'missing' }),
    ).rejects.toMatchObject({ status: 404, code: 'project_not_found' });
  });
});

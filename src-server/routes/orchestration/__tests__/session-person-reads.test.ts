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
import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { bindStationControlRequestAuthority } from '../../../security/station-control-request-authority.js';
import { SessionTurnWaiter } from '../../../services/orchestration/session-turn-wait.js';
import type { StationControlScope } from '../../../tools/station-control-policy.js';
import { createSessionPersonWaitRoutes } from '../session-agent-control.js';
import {
  createSessionPersonActivityRoutes,
  personSessionScope,
} from '../session-project-activity.js';

const DANA = 'human:deployment:dana';
const SCOPES: Record<string, StationControlScope> = {
  'in-viewable': { kind: 'project', id: 'p-viewable' },
  'in-hidden': { kind: 'project', id: 'p-hidden' },
  global: { kind: 'global' },
  unreadable: { kind: 'unreadable' },
};
const SESSIONS = Object.keys(SCOPES);

const summary = (threadId: string): OrchestrationSessionSummary =>
  ({
    threadId,
    provider: 'codex',
    status: 'ready',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    lastEventAt: `2026-10-01T00:00:0${SESSIONS.indexOf(threadId)}.000Z`,
  }) as unknown as OrchestrationSessionSummary;

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
const personMayView = (userId: string, projectId: string) =>
  userId === DANA && projectId === 'p-viewable';
const preview = {
  select: <T>(branches: { enabled: () => T; disabled: () => T }) =>
    branches.enabled(),
};

function app(internal?: 'caller-less' | 'server') {
  const root = new Hono();
  root.use('*', async (c, next) => {
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
    ({ id: DANA, kind: 'human', display: 'Dana' }) as never;
  root.route(
    '/r',
    createSessionPersonActivityRoutes({
      orchestrationService: orchestrationService as never,
      eventStore: eventStore as never,
      stationControlDispatchScope: dispatchScope as never,
      resolvePrincipal,
      projectIdForSlug: (slug) =>
        ({ viewable: 'p-viewable', hidden: 'p-hidden' })[slug],
      personMayView,
      preview,
    }),
  );
  const scope = personSessionScope({
    stationControlDispatchScope: dispatchScope as never,
    personMayView,
  });
  root.route(
    '/r',
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
    ).toEqual(['global', 'in-viewable']);
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
      ['in-hidden', 404, 404],
      ['global', 200, 200],
      ['unreadable', 404, 404],
    ]);
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

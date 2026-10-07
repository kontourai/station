/**
 * station#3413: the digest's bounds past what it reads are typed refusals, not
 * 500s. The routes run for a verified station-control caller over fakes whose
 * only job is to reach each overflow; the real-boundary matrix
 * (`runtime-routes-station-control-project-activity.test.ts`) covers scope.
 */
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { bindStationControlRequestAuthority } from '../../../security/station-control-request-authority.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
import {
  EventStore,
  type TurnDigestFacts,
  TurnDigestLineageTooLongError,
} from '../../../services/orchestration/event-store.js';
import { stationControlCallerPrincipal } from '../../../tools/station-control-shared.js';
import { createSessionProjectActivityRoutes } from '../session-project-activity.js';

const fit = vi.hoisted(() => ({ tooLarge: false }));
vi.mock(
  '../../../services/orchestration/session-digest.js',
  async (original) => {
    const actual =
      await original<
        typeof import('../../../services/orchestration/session-digest.js')
      >();
    return {
      ...actual,
      fitDigestPage: (turns: Parameters<typeof actual.fitDigestPage>[0]) => {
        if (fit.tooLarge) throw new actual.DigestTurnTooLargeError();
        return actual.fitDigestPage(turns);
      },
    };
  },
);

const makeTempDir = trackTempDirs();
const facts: TurnDigestFacts = {
  threadId: 's',
  turnId: 'turn-1',
  startedAt: '2026-10-05T10:00:00.000Z',
  startSequence: 5,
  toolCalls: [],
  toolKindsReported: false,
  filesTotal: 0,
  files: [],
  declaredPullRequests: [],
};

function appWith(readTurnDigestFacts: () => unknown) {
  const summary = {
    threadId: 's',
    provider: 'codex',
    status: 'ready',
    answerability: { answerable: true },
    createdAt: facts.startedAt,
    updatedAt: facts.startedAt,
  };
  const routes = createSessionProjectActivityRoutes({
    orchestrationService: {
      canUserReadSession: () => true,
      currentConversationSessionId: (id: string) => id,
      firstStartedMetadataOfThread: () => undefined,
      listSessionReadModel: async () => [summary],
    } as never,
    eventStore: {
      conversationForSession: () => undefined,
      conversationSessions: () => [],
      conversationTitle: () => undefined,
      listSessionsNamingParents: () => ({ sessions: [], truncated: false }),
      listThreadIdsStartedIn: () => [],
      readTurnDigestFacts,
    } as never,
    stationControlDispatchScope: {
      target: () => ({
        ownerId: LOCAL_OPERATOR_PRINCIPAL_ID,
        scope: { kind: 'global' },
        host: false,
        remote: false,
      }),
      conversationExists: () => true,
    },
    resolvePrincipal: () =>
      ({ id: LOCAL_OPERATOR_PRINCIPAL_ID, kind: 'human' }) as never,
  });
  const app = new Hono();
  app.use('*', async (c, next) => {
    bindStationControlRequestAuthority(c.req.raw, {
      kind: 'caller',
      boundOperator: true,
      caller: {
        sessionId: 'caller',
        assurance: 'bound',
        principal: stationControlCallerPrincipal(
          LOCAL_OPERATOR_PRINCIPAL_ID,
          'session-owner',
        ),
      },
    });
    await next();
  });
  app.route('/', routes);
  return app;
}

afterEach(() => {
  fit.tooLarge = false;
});

describe('the digest’s overflows are typed refusals', () => {
  test('a lineage past what the read names is 422 session_digest_lineage_too_long', async () => {
    const app = appWith(() => {
      throw new TurnDigestLineageTooLongError();
    });
    const answer = await app.request('/s/digest');
    expect(answer.status).toBe(422);
    expect(await answer.json()).toMatchObject({
      success: false,
      code: 'session_digest_lineage_too_long',
    });
  });

  test('one turn that alone exceeds the page cap is 422 session_digest_turn_too_large', async () => {
    fit.tooLarge = true;
    const app = appWith(() => ({
      turns: [facts],
      hasMore: false,
      totalTurns: 1,
    }));
    const answer = await app.request('/s/digest');
    expect(answer.status).toBe(422);
    expect(await answer.json()).toMatchObject({
      success: false,
      code: 'session_digest_turn_too_large',
    });
    // The same fakes answer when the turn fits: the refusal is the cap's.
    fit.tooLarge = false;
    expect((await app.request('/s/digest')).status).toBe(200);
  });
});

describe('EventStore.readTurnDigestFacts lineage bound', () => {
  test('500 Sessions are read, 501 are refused with the typed error', () => {
    const store = new EventStore(
      join(makeTempDir('session-digest-lineage-'), 'orchestration.sqlite'),
    );
    try {
      const ids = (n: number) => Array.from({ length: n }, (_, i) => `s-${i}`);
      expect(
        store.readTurnDigestFacts(ids(500), { turnLimit: 1 }).turns,
      ).toEqual([]);
      expect(() =>
        store.readTurnDigestFacts(ids(501), { turnLimit: 1 }),
      ).toThrow(TurnDigestLineageTooLongError);
    } finally {
      store.close();
    }
  });
});

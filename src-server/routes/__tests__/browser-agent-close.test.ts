/**
 * `browser_close` and `browser_status` paging (#90, #3167) through the REAL
 * route boundary: `/api/browser-agent/*` over the REAL `BrowserAutomation`,
 * session registry, live-surface registry and binder, a REAL minted
 * in-process caller token resolved by the REAL record resolver, and the REAL
 * pane routes a person opens and lists sessions through. Only the CDP
 * channel is faked.
 *
 * An agent may close a session only when an agent opened it, it is bound to
 * the caller's own conversation, and no person (or other agent session) is
 * controlling it. Each refusal below isolates exactly one of those checks.
 */
import type { BrowserSessionView } from '@kontourai/station-contracts/workspace-browser-pane';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import {
  createStationControlCallerRecordResolver,
  resolveStationControlCallerFromToken,
} from '../../runtime/mcp/station-control-caller.js';
import {
  __resetStationControlMcpTokensForTests,
  mintStationControlMcpToken,
} from '../../runtime/mcp/station-control-mcp-token.js';
import type { BrowserProjectAuthorizer } from '../../services/browser/browser-access.js';
import {
  authorizeBrowserAgentCaller,
  createBrowserPrincipalAuthorizer,
} from '../../services/browser/browser-agent-authority.js';
import { BrowserAutomation } from '../../services/browser/browser-automation.js';
import {
  type BrowserHost,
  type CdpTransport,
  createLocalBrowserHostResolver,
} from '../../services/browser/browser-host.js';
import { BrowserLiveSurfaces } from '../../services/browser/browser-live-surfaces.js';
import { LocalTargetStore } from '../../services/browser/browser-local-targets.js';
import { BrowserProjectSettingsStore } from '../../services/browser/browser-project-settings.js';
import { BrowserSessionRegistry } from '../../services/browser/browser-session-registry.js';
import {
  claimAgentControl,
  claimHumanControl,
  LiveSurfaceRegistry,
  releaseHumanControl,
} from '../../services/live-surface/registry.js';
import { SESSION_LOCAL_PROJECT_ID_METADATA_KEY } from '../../services/orchestration/session-project-identity.js';
import { STATION_CONTROL_CALLER_TOKEN_HEADER } from '../../tools/station-control-shared.js';
import { createBrowserRoutes } from '../browser.js';
import { createBrowserAgentRoutes } from '../browser-agent.js';

const OPERATOR_ID = 'human:local:operator';
const HUMAN = {
  kind: 'human',
  principal: OPERATOR_ID,
  device: 'device:laptop',
} as const;
// Canonical Project ids differ from slugs on purpose (D7).
const ALPHA = { id: 'p-alpha', slug: 'alpha' };
const BETA = { id: 'p-beta', slug: 'beta' };
const PROJECTS = [ALPHA, BETA];
/** Stands in for Station's internal token (home possession). */
const INTERNAL = 'x-test-station-internal';

/** A CDP answer the test controls; the default answers `{}` at once. */
type CdpSend = (method: string) => Promise<unknown>;

function fakeHost(cdpSend?: CdpSend): BrowserHost {
  let targets = 0;
  const cdp: CdpTransport = {
    send: async <R>(method: string) =>
      ((cdpSend ? await cdpSend(method) : undefined) ?? {}) as R,
    on: () => () => {},
    close: async () => {},
    closed: new Promise(() => {}),
  };
  return {
    kind: 'server-chromium',
    shutdown: async () => {},
    openTarget: async () => {
      targets += 1;
      return { targetId: `T${targets}`, cdpSessionId: `S${targets}` };
    },
    cdp: () => cdp,
    closeTarget: async () => {},
    onExit: () => () => {},
  };
}

interface AgentSessionRecord {
  principalId: string;
  conversationId?: string;
  project?: { id: string; slug: string };
}

type Answer = { ok: boolean; code?: string; message?: string } & Record<
  string,
  unknown
>;
interface StatusEntry {
  browserSessionId: string;
  state: string;
  createdAt: string;
}

const makeTempDir = trackTempDirs();
beforeEach(() => __resetStationControlMcpTokensForTests());
afterEach(() => __resetStationControlMcpTokensForTests());

function harness(options: { now?: () => Date; cdpSend?: CdpSend } = {}) {
  const stationHome = makeTempDir('station-agent-close-');
  let ids = 0;
  const sessions = new BrowserSessionRegistry({
    stationHome,
    hostResolver: createLocalBrowserHostResolver(() =>
      fakeHost(options.cdpSend),
    ),
    ...(options.now ? { now: options.now } : {}),
    newId: () =>
      `bs_00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
  });
  const surfaces = new LiveSurfaceRegistry();
  const binder = new BrowserLiveSurfaces({
    sessions,
    surfaces,
    authorizeProject: async () => ({ kind: 'operator' }),
  });
  const settings = new BrowserProjectSettingsStore(stationHome);
  const automation = new BrowserAutomation({
    sessions,
    surfaces,
    surfaceIdFor: (id) => binder.surfaceIdFor(id),
    settings,
    locatorEngine: async () => undefined,
    sleep: async () => {},
  });

  const records = new Map<string, AgentSessionRecord>();
  const resolveRecord = createStationControlCallerRecordResolver({
    actingPrincipal: (sessionId) => {
      const record = records.get(sessionId);
      return record
        ? { id: record.principalId, source: 'session-owner' }
        : undefined;
    },
    startedMetadata: (sessionId) => {
      const record = records.get(sessionId);
      if (!record) return undefined;
      const project = record.project ?? ALPHA;
      return {
        projectSlug: project.slug,
        [SESSION_LOCAL_PROJECT_ID_METADATA_KEY]: project.id,
      };
    },
    localProjectId: (slug) => PROJECTS.find((p) => p.slug === slug)?.id,
    conversationId: (sessionId) => records.get(sessionId)?.conversationId,
  });
  const isInternal = (request: Request) =>
    request.headers.get(INTERNAL) === '1';

  const authorizePrincipal = createBrowserPrincipalAuthorizer({
    isOperatorPrincipal: (id) => id === OPERATOR_ID,
  });
  const app = new Hono();
  app.route(
    '/api/browser-agent',
    createBrowserAgentRoutes({
      isInternalRequest: isInternal,
      resolveCaller: (request) =>
        resolveStationControlCallerFromToken(
          request.headers.get(STATION_CONTROL_CALLER_TOKEN_HEADER),
          resolveRecord,
        ),
      authorizePrincipal,
      automation,
      settings,
      browserReady: () => true,
      projectSlug: (projectId) =>
        PROJECTS.find((p) => p.id === projectId)?.slug,
      surfaceIdFor: (id) => binder.surfaceIdFor(id),
    }),
  );
  const authorizeProject: BrowserProjectAuthorizer = async (request) =>
    request.headers.get('authorization') === 'Bearer operator'
      ? { kind: 'operator' }
      : undefined;
  app.route(
    '/api/browser',
    createBrowserRoutes({
      registry: sessions,
      surfaceIdFor: (id) => binder.surfaceIdFor(id),
      acquisition: {
        status: () => ({
          state: 'found-system',
          executablePath: '/fake/chrome',
          browser: 'google-chrome',
        }),
        startDownload: () => {
          throw new Error('not under test');
        },
      },
      localTargets: new LocalTargetStore(stationHome),
      listeners: () => ({ ports: [], hostnames: [] }),
      suggestLocalTargets: async () => ({ state: 'ok', suggestions: [] }),
      authorizeProject,
      authorizeOperator: async (request) =>
        request.headers.get('authorization') === 'Bearer operator',
      resolveProject: (slug) => PROJECTS.find((p) => p.slug === slug),
      isStationInternalRequest: isInternal,
      isRequestPrincipalCurrent: () => true,
    }),
  );

  /** An agent session Station started, holding its in-process token. */
  const startAgent = (sessionId: string, record: AgentSessionRecord) => {
    records.set(sessionId, record);
    return mintStationControlMcpToken(sessionId, 'sdk-in-process').token;
  };
  /** A browser tool call as Station's own tool code makes it. */
  const tool = async (
    token: string | undefined,
    operation: string,
    body: Record<string, unknown> = {},
  ) =>
    (await (
      await app.request(`/api/browser-agent/${operation}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [INTERNAL]: '1',
          ...(token ? { [STATION_CONTROL_CALLER_TOKEN_HEADER]: token } : {}),
        },
        body: JSON.stringify(body),
      })
    ).json()) as Answer;
  const agentOpen = async (token: string, url: string) => {
    const answer = await tool(token, 'open', { url });
    expect(answer).toMatchObject({ ok: true, reused: false });
    return (answer.session as { browserSessionId: string }).browserSessionId;
  };
  const statusIds = async (token: string, body = {}) => {
    const answer = await tool(token, 'status', body);
    expect(answer.ok).toBe(true);
    return (answer.sessions as StatusEntry[]).map((s) => s.browserSessionId);
  };
  /** A person opens a session from the Browser pane. */
  const personOpen = async (url: string, threadId?: string) => {
    const response = await app.request('/api/browser/sessions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer operator',
      },
      body: JSON.stringify({
        projectSlug: ALPHA.slug,
        url,
        ...(threadId ? { threadId } : {}),
      }),
    });
    expect(response.status).toBe(201);
    return ((await response.json()) as { data: BrowserSessionView }).data
      .browserSessionId;
  };
  /** The Browser pane's session list, as a person's client reads it. */
  const paneList = async () =>
    (
      (await (
        await app.request(`/api/browser/sessions?projectSlug=${ALPHA.slug}`, {
          headers: { authorization: 'Bearer operator' },
        })
      ).json()) as { data: BrowserSessionView[] }
    ).data;
  const entryOf = (browserSessionId: string) => {
    const surfaceId = binder.surfaceIdFor(browserSessionId);
    expect(surfaceId).toBeTruthy();
    return surfaces.get(surfaceId!)!;
  };

  /** The authority the route derives for a token (for a sibling's lease). */
  const authorityFor = async (token: string) => {
    const decided = await authorizeBrowserAgentCaller(
      resolveStationControlCallerFromToken(token, resolveRecord),
      authorizePrincipal,
    );
    if (!decided.ok) throw new Error(decided.refusal.code);
    return decided.authority;
  };

  return {
    app,
    authorityFor,
    sessions,
    startAgent,
    tool,
    agentOpen,
    statusIds,
    personOpen,
    paneList,
    entryOf,
  };
}

describe('browser_close: an agent closes only its own sessions (#90)', () => {
  test('closes exactly the named session; it leaves browser_status and the pane shows it closed by the agent', async () => {
    const h = harness();
    const token = h.startAgent('exec-1', {
      principalId: OPERATOR_ID,
      conversationId: 'conv-X',
    });
    const keep = await h.agentOpen(token, 'https://example.com/keep');
    const target = await h.agentOpen(token, 'https://example.com/close');
    expect((await h.statusIds(token)).sort()).toEqual([keep, target].sort());

    const answer = await h.tool(token, 'close', { browserSessionId: target });
    expect(answer).toMatchObject({
      ok: true,
      session: { browserSessionId: target, state: 'closed' },
    });

    expect(await h.statusIds(token)).toEqual([keep]);
    expect(h.sessions.getSession(keep)!.state).toBe('live');
    const closed = h.sessions.getSession(target)!;
    expect(closed.state).toBe('closed');
    expect(closed.history.entries.at(-1)).toMatchObject({
      kind: 'closed',
      actor: { kind: 'agent', sessionId: 'exec-1' },
    });
    // What the person's Browser pane reads.
    const pane = await h.paneList();
    expect(pane.find((s) => s.browserSessionId === target)?.state).toBe(
      'closed',
    );
    expect(pane.find((s) => s.browserSessionId === keep)?.state).toBe('live');
  });

  test('a session a person opened, even in this conversation, is refused opened-by-person and stays open', async () => {
    const h = harness();
    const token = h.startAgent('exec-1', {
      principalId: OPERATOR_ID,
      conversationId: 'conv-X',
    });
    const theirs = await h.personOpen('https://example.com/', 'conv-X');
    // It is in the agent's profile and thread: listed, and drivable.
    expect(await h.statusIds(token)).toEqual([theirs]);
    expect(h.sessions.getSession(theirs)!.threadId).toBe('conv-X');

    const answer = await h.tool(token, 'close', { browserSessionId: theirs });
    expect(answer).toMatchObject({ ok: false, code: 'opened-by-person' });
    expect(answer.message!.length).toBeGreaterThan(20);
    expect(h.sessions.getSession(theirs)!.state).toBe('live');
  });

  test('a session a person is driving right now is refused human-controlling; once they let go it closes', async () => {
    const h = harness();
    const token = h.startAgent('exec-1', {
      principalId: OPERATOR_ID,
      conversationId: 'conv-X',
    });
    const id = await h.agentOpen(token, 'https://example.com/');
    const entry = h.entryOf(id);
    expect(claimHumanControl(entry, HUMAN).ok).toBe(true);

    const refused = await h.tool(token, 'close', { browserSessionId: id });
    expect(refused).toMatchObject({ ok: false, code: 'human-controlling' });
    expect(h.sessions.getSession(id)!.state).toBe('live');
    // Recorded in the session's history, like every action a person held off.
    expect(h.sessions.getSession(id)!.history.entries.at(-1)).toMatchObject({
      kind: 'agent-refused',
      detail: 'human-controlling',
    });

    releaseHumanControl(entry, HUMAN, entry.lease.snapshot().epoch);
    expect(
      await h.tool(token, 'close', { browserSessionId: id }),
    ).toMatchObject({ ok: true, session: { state: 'closed' } });
  });

  test('a session another agent session is driving is refused held-by-other', async () => {
    const h = harness();
    const token = h.startAgent('exec-1', {
      principalId: OPERATOR_ID,
      conversationId: 'conv-X',
    });
    const id = await h.agentOpen(token, 'https://example.com/');
    // A sibling execution of the same conversation, mid-action: it holds
    // the lease through the same authorized claim every browser action makes.
    const sibling = h.startAgent('exec-2', {
      principalId: OPERATOR_ID,
      conversationId: 'conv-X',
    });
    const siblingAuthority = await h.authorityFor(sibling);
    expect(
      (
        await claimAgentControl(
          h.entryOf(id),
          { kind: 'agent', principal: OPERATOR_ID, sessionId: 'exec-2' },
          OPERATOR_ID,
          { agentGrant: siblingAuthority.grant },
        )
      ).ok,
    ).toBe(true);

    expect(
      await h.tool(token, 'close', { browserSessionId: id }),
    ).toMatchObject({ ok: false, code: 'held-by-other' });
    expect(h.sessions.getSession(id)!.state).toBe('live');
  });

  test('a session from another conversation is refused other-thread, though browser_status lists it', async () => {
    const h = harness();
    const first = h.startAgent('exec-1', {
      principalId: OPERATOR_ID,
      conversationId: 'conv-X',
    });
    const id = await h.agentOpen(first, 'https://example.com/');
    const second = h.startAgent('exec-2', {
      principalId: OPERATOR_ID,
      conversationId: 'conv-Y',
    });
    expect(await h.statusIds(second)).toEqual([id]);

    expect(
      await h.tool(second, 'close', { browserSessionId: id }),
    ).toMatchObject({ ok: false, code: 'other-thread' });
    expect(h.sessions.getSession(id)!.state).toBe('live');
    expect(h.sessions.getSession(id)!.threadId).toBe('conv-X');
  });

  test('a session in another Project is session-not-found, the same answer as no session', async () => {
    const h = harness();
    const alpha = h.startAgent('exec-1', {
      principalId: OPERATOR_ID,
      conversationId: 'conv-X',
    });
    const id = await h.agentOpen(alpha, 'https://example.com/');
    // The same person and conversation id, started in another Project.
    const beta = h.startAgent('exec-2', {
      principalId: OPERATOR_ID,
      conversationId: 'conv-X',
      project: BETA,
    });
    expect(await h.statusIds(beta)).toEqual([]);

    expect(await h.tool(beta, 'close', { browserSessionId: id })).toMatchObject(
      { ok: false, code: 'session-not-found' },
    );
    expect(
      await h.tool(beta, 'close', {
        browserSessionId: 'bs_00000000-0000-4000-8000-000000000999',
      }),
    ).toMatchObject({ ok: false, code: 'session-not-found' });
    expect(h.sessions.getSession(id)!.state).toBe('live');
  });

  test('a caller with no usable conversation id is refused other-thread, even for a session another such caller opened', async () => {
    const h = harness();
    // Both conversation ids fail BROWSER_THREAD_ID_PATTERN, so neither caller
    // has a thread, and neither session is bound to one.
    const first = h.startAgent('exec 1!', {
      principalId: OPERATOR_ID,
      conversationId: 'bad conv!',
    });
    const id = await h.agentOpen(first, 'https://example.com/');
    expect(h.sessions.getSession(id)!.threadId).toBeUndefined();
    const second = h.startAgent('exec 2!', {
      principalId: OPERATOR_ID,
      conversationId: 'bad conv!',
    });
    for (const token of [second, first])
      expect(
        await h.tool(token, 'close', { browserSessionId: id }),
      ).toMatchObject({ ok: false, code: 'other-thread' });
    expect(h.sessions.getSession(id)!.state).toBe('live');
  });

  test('close waits for an action already running on the session, then closes', async () => {
    let release: (() => void) | undefined;
    let navigating: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      navigating = resolve;
    });
    let gate = false;
    const h = harness({
      cdpSend: async (method) => {
        if (gate && method === 'Page.navigate') {
          navigating?.();
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return {};
      },
    });
    const token = h.startAgent('exec-1', {
      principalId: OPERATOR_ID,
      conversationId: 'conv-X',
    });
    const id = await h.agentOpen(token, 'https://example.com/');
    gate = true;
    const order: string[] = [];
    const navigate = h
      .tool(token, 'navigate', {
        browserSessionId: id,
        url: 'https://example.com/next',
      })
      .then((answer) => {
        order.push('navigate');
        return answer;
      });
    await started;
    const close = h
      .tool(token, 'close', { browserSessionId: id })
      .then((answer) => {
        order.push('close');
        return answer;
      });
    // The navigation is still in flight: close has not run.
    for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
    expect(order).toEqual([]);
    expect(h.sessions.getSession(id)!.state).toBe('live');

    release!();
    expect(await navigate).toMatchObject({ ok: true });
    expect(await close).toMatchObject({
      ok: true,
      session: { state: 'closed' },
    });
    expect(order).toEqual(['navigate', 'close']);
  });

  test("Station's internal token alone closes nothing: the agent route needs a caller, the pane route refuses it", async () => {
    const h = harness();
    const token = h.startAgent('exec-1', {
      principalId: OPERATOR_ID,
      conversationId: 'conv-X',
    });
    const id = await h.agentOpen(token, 'https://example.com/');

    expect(
      await h.tool(undefined, 'close', { browserSessionId: id }),
    ).toMatchObject({ ok: false, code: 'caller-required' });
    const pane = await h.app.request(`/api/browser/sessions/${id}`, {
      method: 'DELETE',
      headers: { [INTERNAL]: '1', authorization: 'Bearer operator' },
    });
    expect(pane.status).toBe(403);
    expect(await pane.json()).toMatchObject({ code: 'access-denied' });
    expect(h.sessions.getSession(id)!.state).toBe('live');
  });
});

describe('browser_status paging (#90)', () => {
  test('pages newest-created first; every session appears exactly once, and the last page has no cursor', async () => {
    const h = harness();
    const token = h.startAgent('exec-1', {
      principalId: OPERATOR_ID,
      conversationId: 'conv-X',
    });
    const opened: string[] = [];
    for (let i = 0; i < 23; i += 1)
      opened.push(await h.agentOpen(token, `https://example.com/${i}`));

    // The default page is 20, and says there is more.
    const first = await h.tool(token, 'status');
    expect((first.sessions as StatusEntry[]).length).toBe(20);
    expect(typeof first.nextCursor).toBe('string');

    const seen: StatusEntry[] = [];
    let cursor: unknown;
    let pages = 0;
    do {
      const page = await h.tool(token, 'status', {
        limit: 5,
        ...(typeof cursor === 'string' ? { cursor } : {}),
      });
      expect(page.ok).toBe(true);
      const sessions = page.sessions as StatusEntry[];
      expect(sessions.length).toBeLessThanOrEqual(5);
      seen.push(...sessions);
      cursor = page.nextCursor;
      pages += 1;
    } while (typeof cursor === 'string' && pages < 10);
    expect(cursor).toBeNull();
    expect(pages).toBe(5);
    const ids = seen.map((s) => s.browserSessionId);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...opened].sort());
    // Newest-created first (ids break same-millisecond ties).
    expect(ids).toEqual([...opened].reverse());
  });

  test.each([
    // A listed session closing shifts an offset forward: one would be skipped.
    ['a listed session closes', 'close'],
    // A new session at the front shifts an offset back: one would repeat.
    ['a new session opens', 'open'],
  ] as const)(
    'when %s between pages, every session already there is listed exactly once',
    async (_label, change) => {
      const h = harness();
      const token = h.startAgent('exec-1', {
        principalId: OPERATOR_ID,
        conversationId: 'conv-X',
      });
      const opened: string[] = [];
      for (let i = 0; i < 9; i += 1)
        opened.push(await h.agentOpen(token, `https://example.com/${i}`));

      const first = await h.tool(token, 'status', { limit: 3 });
      const listed = (first.sessions as StatusEntry[]).map(
        (s) => s.browserSessionId,
      );
      if (change === 'close')
        expect(
          await h.tool(token, 'close', { browserSessionId: listed[0] }),
        ).toMatchObject({ ok: true });
      else await h.agentOpen(token, 'https://example.com/late');

      let cursor = first.nextCursor;
      for (let pages = 0; typeof cursor === 'string'; pages += 1) {
        expect(pages).toBeLessThan(5);
        const page = await h.tool(token, 'status', { limit: 3, cursor });
        listed.push(
          ...(page.sessions as StatusEntry[]).map((s) => s.browserSessionId),
        );
        cursor = page.nextCursor;
      }
      expect(listed).toEqual([...opened].reverse());
    },
  );

  test.each([
    [{ limit: 21 }, /limit/],
    [{ limit: 0 }, /limit/],
    [{ limit: 2.5 }, /limit/],
    [{ limit: '5' }, /limit/],
    [{ cursor: 'not-a-cursor' }, /cursor/],
    [{ cursor: 7 }, /cursor/],
    [
      {
        cursor: Buffer.from(
          JSON.stringify(['2026-01-01T00:00:00.000Z', 'bs_forged']),
        ).toString('base64url'),
      },
      /cursor/,
    ],
  ])(
    'malformed %j is refused invalid-request, not truncated or ignored',
    async (body, message) => {
      const h = harness();
      const token = h.startAgent('exec-1', {
        principalId: OPERATOR_ID,
        conversationId: 'conv-X',
      });
      await h.agentOpen(token, 'https://example.com/');
      const answer = await h.tool(token, 'status', body);
      expect(answer).toMatchObject({ ok: false, code: 'invalid-request' });
      expect(answer.message).toMatch(message);
      expect(answer).not.toHaveProperty('sessions');
    },
  );

  test('a cursor is only a position: a forged or another Project’s cursor never lists a foreign session', async () => {
    const h = harness();
    const alpha = h.startAgent('exec-a', {
      principalId: OPERATOR_ID,
      conversationId: 'conv-A',
    });
    const beta = h.startAgent('exec-b', {
      principalId: OPERATOR_ID,
      conversationId: 'conv-B',
      project: BETA,
    });
    const alphaIds: string[] = [];
    const betaIds: string[] = [];
    // Interleaved, so a cursor from one Project falls between the other's.
    for (let i = 0; i < 4; i += 1) {
      alphaIds.push(await h.agentOpen(alpha, `https://example.com/a${i}`));
      betaIds.push(await h.agentOpen(beta, `https://example.com/b${i}`));
    }
    const pageOf = async (token: string, cursor: string) => {
      const page = await h.tool(token, 'status', { limit: 20, cursor });
      expect(page).toMatchObject({ ok: true });
      return (page.sessions as StatusEntry[]).map((s) => s.browserSessionId);
    };

    // Well-formed but never minted: it only sets where listing resumes.
    const forged = Buffer.from(
      JSON.stringify([
        '9999-01-01T00:00:00.000Z',
        'bs_ffffffff-ffff-ffff-ffff-ffffffffffff',
      ]),
    ).toString('base64url');
    expect(await pageOf(alpha, forged)).toEqual([...alphaIds].reverse());
    expect(await pageOf(beta, forged)).toEqual([...betaIds].reverse());

    // Alpha's own cursor, replayed by the Beta caller.
    const first = await h.tool(alpha, 'status', { limit: 2 });
    expect(typeof first.nextCursor).toBe('string');
    const replayed = await pageOf(beta, first.nextCursor as string);
    expect(replayed.length).toBeGreaterThan(0);
    expect(replayed.every((id) => betaIds.includes(id))).toBe(true);
    // And Beta's cursor replayed by Alpha.
    const betaFirst = await h.tool(beta, 'status', { limit: 2 });
    const back = await pageOf(alpha, betaFirst.nextCursor as string);
    expect(back.length).toBeGreaterThan(0);
    expect(back.every((id) => alphaIds.includes(id))).toBe(true);
  });

  test('sessions created in the same millisecond page by id: each exactly once, in order', async () => {
    const h = harness({ now: () => new Date('2026-10-03T12:00:00.000Z') });
    const token = h.startAgent('exec-1', {
      principalId: OPERATOR_ID,
      conversationId: 'conv-X',
    });
    const opened: string[] = [];
    for (let i = 0; i < 7; i += 1)
      opened.push(await h.agentOpen(token, `https://example.com/${i}`));
    expect(
      new Set(opened.map((id) => h.sessions.getSession(id)!.createdAt)).size,
    ).toBe(1);

    const listed: string[] = [];
    let cursor: unknown;
    for (let pages = 0; pages === 0 || typeof cursor === 'string'; pages += 1) {
      expect(pages).toBeLessThan(5);
      const page = await h.tool(token, 'status', {
        limit: 2,
        ...(typeof cursor === 'string' ? { cursor } : {}),
      });
      listed.push(
        ...(page.sessions as StatusEntry[]).map((s) => s.browserSessionId),
      );
      cursor = page.nextCursor;
    }
    // Ids are minted in increasing order, so newest-first is descending id.
    expect(listed).toEqual([...opened].reverse());
  });

  test('limit 20 is the most one page lists', async () => {
    const h = harness();
    const token = h.startAgent('exec-1', {
      principalId: OPERATOR_ID,
      conversationId: 'conv-X',
    });
    for (let i = 0; i < 21; i += 1)
      await h.agentOpen(token, `https://example.com/${i}`);
    const page = await h.tool(token, 'status', { limit: 20 });
    expect((page.sessions as StatusEntry[]).length).toBe(20);
    expect(typeof page.nextCursor).toBe('string');
  });
});

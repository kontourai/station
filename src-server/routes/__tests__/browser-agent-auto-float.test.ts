/**
 * Cross-lane pin (#90): a session an AGENT opens through the browser tools
 * auto-floats in the chat that asked, for the viewer it acts for — and in no
 * other chat, for no other viewer.
 *
 * Three lanes meet here and each was reviewed on its own:
 *  - the verified caller (a REAL minted in-process token, resolved by the
 *    REAL record resolver, whose conversation id comes from Station's own
 *    session record, never from tool arguments);
 *  - the agent open path (the REAL `/api/browser-agent/open` route over the
 *    REAL `BrowserAutomation`, session registry, live-surface registry and
 *    binder, with only the CDP channel faked), which stamps
 *    `threadId = caller.conversationId ?? caller.sessionId`;
 *  - the floater (the REAL `pickAutoFloatCandidate` the chat's
 *    `FloatOverChatHost` runs), fed exactly what the pane routes answer it:
 *    `GET /sessions?projectSlug=` and `GET /projects/:slug/access`.
 * A chat's thread ids are what `FloatOverChat` derives from it: its tab id,
 * its conversation id and its current execution session.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  BrowserPaneAccessView,
  BrowserSessionView,
} from '@kontourai/station-contracts/workspace-browser-pane';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { pickAutoFloatCandidate } from '../../../src-ui/src/float-over-chat/autoFloatCandidate.js';
import {
  createStationControlCallerRecordResolver,
  resolveStationControlCallerFromToken,
} from '../../runtime/mcp/station-control-caller.js';
import {
  __resetStationControlMcpTokensForTests,
  mintStationControlMcpToken,
} from '../../runtime/mcp/station-control-mcp-token.js';
import type { BrowserProjectAuthorizer } from '../../services/browser/browser-access.js';
import { createBrowserPrincipalAuthorizer } from '../../services/browser/browser-agent-authority.js';
import { BrowserAutomation } from '../../services/browser/browser-automation.js';
import type {
  BrowserHost,
  CdpTransport,
} from '../../services/browser/browser-host.js';
import { BrowserLiveSurfaces } from '../../services/browser/browser-live-surfaces.js';
import { LocalTargetStore } from '../../services/browser/browser-local-targets.js';
import { BrowserProjectSettingsStore } from '../../services/browser/browser-project-settings.js';
import { BrowserSessionRegistry } from '../../services/browser/browser-session-registry.js';
import { LiveSurfaceRegistry } from '../../services/live-surface/registry.js';
import { SESSION_LOCAL_PROJECT_ID_METADATA_KEY } from '../../services/orchestration/session-project-identity.js';
import { STATION_CONTROL_CALLER_TOKEN_HEADER } from '../../tools/station-control-shared.js';
import { createBrowserRoutes } from '../browser.js';
import { createBrowserAgentRoutes } from '../browser-agent.js';

const OPERATOR_ID = 'human:local:operator';
const ADMIN_ID = 'human:deployment:admin';
// Canonical Project ids differ from slugs on purpose (D7).
const PROJECT = { id: 'p-alpha', slug: 'alpha' };

function fakeHost(): BrowserHost {
  const cdp: CdpTransport = {
    send: async <R>() => ({}) as R,
    on: () => () => {},
    close: async () => {},
    closed: new Promise(() => {}),
  };
  return {
    kind: 'server-chromium',
    shutdown: async () => {},
    openTarget: async () => ({ targetId: 'T1', cdpSessionId: 'S1' }),
    cdp: () => cdp,
    closeTarget: async () => {},
    onExit: () => () => {},
  };
}

/** One recorded agent session: who it acts for, and its conversation. */
interface AgentSessionRecord {
  principalId: string;
  conversationId?: string;
}

const homes: string[] = [];
beforeEach(() => __resetStationControlMcpTokensForTests());
afterEach(() => {
  __resetStationControlMcpTokensForTests();
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

function harness() {
  const stationHome = mkdtempSync(join(tmpdir(), 'station-auto-float-'));
  homes.push(stationHome);
  let ids = 0;
  const sessions = new BrowserSessionRegistry({
    stationHome,
    createHost: () => fakeHost(),
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

  // Station's own session records, as the caller resolver reads them.
  const records = new Map<string, AgentSessionRecord>();
  const resolveRecord = createStationControlCallerRecordResolver({
    actingPrincipal: (sessionId) => {
      const record = records.get(sessionId);
      return record
        ? { id: record.principalId, source: 'session-owner' }
        : undefined;
    },
    startedMetadata: (sessionId) =>
      records.has(sessionId)
        ? {
            projectSlug: PROJECT.slug,
            [SESSION_LOCAL_PROJECT_ID_METADATA_KEY]: PROJECT.id,
          }
        : undefined,
    localProjectId: (slug) => (slug === PROJECT.slug ? PROJECT.id : undefined),
    conversationId: (sessionId) => records.get(sessionId)?.conversationId,
  });

  const app = new Hono();
  app.route(
    '/api/browser-agent',
    createBrowserAgentRoutes({
      // The runtime boundary's internal-principal check is pinned by the
      // caller-route tests; here every request is Station's own tool code.
      isInternalRequest: () => true,
      resolveCaller: (request) =>
        resolveStationControlCallerFromToken(
          request.headers.get(STATION_CONTROL_CALLER_TOKEN_HEADER),
          resolveRecord,
        ),
      authorizePrincipal: createBrowserPrincipalAuthorizer({
        isOperatorPrincipal: (id) => id === OPERATOR_ID,
        membership: {
          admissionsForResolvedPrincipal: (id) =>
            id === ADMIN_ID
              ? [
                  {
                    scope: { localProjectId: PROJECT.id },
                    member: { role: 'admin', status: 'active' },
                  },
                ]
              : [],
        },
      }),
      automation,
      settings,
      browserReady: () => true,
      projectSlug: (projectId) =>
        projectId === PROJECT.id ? PROJECT.slug : undefined,
      surfaceIdFor: (id) => binder.surfaceIdFor(id),
    }),
  );

  // The pane routes a viewer's floater reads, authorized by bearer name.
  const authorizeProject: BrowserProjectAuthorizer = async (request) => {
    const who = request.headers.get('authorization');
    if (who === 'Bearer operator') return { kind: 'operator' };
    if (who === 'Bearer admin')
      return { kind: 'project-admin', principalId: ADMIN_ID };
    return undefined;
  };
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
      resolveProject: (slug) => (slug === PROJECT.slug ? PROJECT : undefined),
      isStationInternalRequest: () => false,
      isRequestPrincipalCurrent: () => true,
    }),
  );

  /** An agent session Station started, holding its in-process token. */
  const startAgent = (sessionId: string, record: AgentSessionRecord) => {
    records.set(sessionId, record);
    return mintStationControlMcpToken(sessionId, 'sdk-in-process').token;
  };
  const agentOpen = async (token: string, url: string) => {
    const response = await app.request('/api/browser-agent/open', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [STATION_CONTROL_CALLER_TOKEN_HEADER]: token,
      },
      body: JSON.stringify({ url }),
    });
    const body = (await response.json()) as {
      ok: boolean;
      session?: { browserSessionId: string; threadId?: string };
    };
    expect(body).toMatchObject({ ok: true });
    return body.session!;
  };

  /** Exactly what a viewer's `FloatOverChatHost` reads and decides. */
  const floaterPick = async (
    viewer: 'operator' | 'admin',
    chat: { id: string; conversationId?: string; currentSessionId?: string },
  ) => {
    const headers = { authorization: `Bearer ${viewer}` };
    const access = (await (
      await app.request(`/api/browser/projects/${PROJECT.slug}/access`, {
        headers,
      })
    ).json()) as { success: boolean; data: BrowserPaneAccessView };
    const list = (await (
      await app.request(`/api/browser/sessions?projectSlug=${PROJECT.slug}`, {
        headers,
      })
    ).json()) as { success: boolean; data: BrowserSessionView[] };
    expect(access.success).toBe(true);
    expect(list.success).toBe(true);
    const principalKey = access.data.principalKey;
    expect(principalKey).toBeTruthy();
    // FloatOverChat's derivation of a chat's thread ids.
    const threadIds = [
      chat.id,
      chat.conversationId,
      chat.currentSessionId,
    ].filter((value): value is string => !!value);
    return pickAutoFloatCandidate(
      list.data,
      { projectSlug: PROJECT.slug, threadIds, principalKey: principalKey! },
      () => false,
    );
  };

  /** The session ids a viewer's list shows. */
  const listed = async (viewer: 'operator' | 'admin') =>
    (
      (await (
        await app.request(`/api/browser/sessions?projectSlug=${PROJECT.slug}`, {
          headers: { authorization: `Bearer ${viewer}` },
        })
      ).json()) as { data: BrowserSessionView[] }
    ).data.map((session) => session.browserSessionId);

  /** `browser_status` as the tool calls it. */
  const agentStatus = async (token: string) =>
    (await (
      await app.request('/api/browser-agent/status', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [STATION_CONTROL_CALLER_TOKEN_HEADER]: token,
        },
        body: '{}',
      })
    ).json()) as { ok: boolean; sessions: unknown };

  return { startAgent, agentOpen, floaterPick, listed, agentStatus };
}

describe('an agent-opened browser session floats in the chat that asked (#90)', () => {
  test('it floats in the chat whose conversation id the caller carries, for the viewer it acts for', async () => {
    const h = harness();
    const token = h.startAgent('exec-1', {
      principalId: OPERATOR_ID,
      conversationId: 'conv-X',
    });
    const opened = await h.agentOpen(token, 'https://example.com/');
    expect(opened.threadId).toBe('conv-X');

    const picked = await h.floaterPick('operator', {
      id: 'tab-1',
      conversationId: 'conv-X',
      currentSessionId: 'exec-1',
    });
    expect(picked?.browserSessionId).toBe(opened.browserSessionId);
    expect(picked?.surfaceId).toBeTruthy();

    // A chat whose ids include X only through its conversation (its
    // execution moved on) still gets it.
    expect(
      (
        await h.floaterPick('operator', {
          id: 'tab-9',
          conversationId: 'conv-X',
          currentSessionId: 'exec-later',
        })
      )?.browserSessionId,
    ).toBe(opened.browserSessionId);
  });

  test('another chat in the same Project does not get it', async () => {
    const h = harness();
    const token = h.startAgent('exec-1', {
      principalId: OPERATOR_ID,
      conversationId: 'conv-X',
    });
    await h.agentOpen(token, 'https://example.com/');
    expect(
      await h.floaterPick('operator', {
        id: 'tab-2',
        conversationId: 'conv-Y',
        currentSessionId: 'exec-2',
      }),
    ).toBeNull();
  });

  test('a caller with no conversation yet threads by its session, which the chat carries as its execution', async () => {
    const h = harness();
    const token = h.startAgent('exec-1', { principalId: OPERATOR_ID });
    const opened = await h.agentOpen(token, 'https://example.com/');
    expect(opened.threadId).toBe('exec-1');
    expect(
      (
        await h.floaterPick('operator', {
          id: 'tab-1',
          currentSessionId: 'exec-1',
        })
      )?.browserSessionId,
    ).toBe(opened.browserSessionId);
  });

  test('a Project admin’s agent session floats for that admin, never for the operator', async () => {
    const h = harness();
    const token = h.startAgent('exec-a', {
      principalId: ADMIN_ID,
      conversationId: 'conv-A',
    });
    const opened = await h.agentOpen(token, 'https://example.com/');
    const chat = { id: 'tab-a', conversationId: 'conv-A' };
    expect((await h.floaterPick('admin', chat))?.browserSessionId).toBe(
      opened.browserSessionId,
    );
    // The operator's list can show every profile's sessions (D6), but a
    // session in another principal's profile never floats to them (D7).
    expect(await h.listed('operator')).toContain(opened.browserSessionId);
    expect(await h.floaterPick('operator', chat)).toBeNull();
  });

  test('another conversation of the same person finds the session through browser_status, as a list', async () => {
    const h = harness();
    const first = h.startAgent('exec-1', {
      principalId: OPERATOR_ID,
      conversationId: 'conv-X',
    });
    const opened = await h.agentOpen(first, 'https://example.com/');
    const second = h.startAgent('exec-2', {
      principalId: OPERATOR_ID,
      conversationId: 'conv-Y',
    });
    const status = await h.agentStatus(second);
    // Found live: the route once returned the un-awaited promise, which
    // serialises as `{}`, so a new chat saw no session to adopt.
    expect(status.ok).toBe(true);
    expect(Array.isArray(status.sessions)).toBe(true);
    expect(
      (status.sessions as { browserSessionId: string }[]).map(
        (session) => session.browserSessionId,
      ),
    ).toEqual([opened.browserSessionId]);
  });
});

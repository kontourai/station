import {
  AUTHORITY_OBSERVATION_SCHEMA_VERSION,
  type AuthorityObservation,
  isAuthorityObservation,
} from '@kontourai/station-contracts/authority-observation';
import { DEFAULT_GRANT_PAIRING_SCOPE } from '@kontourai/station-contracts/environment-security';
import type {
  BrowserPaneAccessView,
  BrowserSessionView,
} from '@kontourai/station-contracts/workspace-browser-pane';
import type { Route } from '@playwright/test';

/** Explicit optional shell reads; keep each envelope aligned with its route owner. */
const READS: Readonly<Record<string, unknown>> = {
  '/api/agents': { success: true, data: [] },
  '/api/connections/agents': { success: true, data: [] },
  '/api/models': { success: true, data: [] },
  '/api/plugins': { plugins: [] },
  '/api/projects': { success: true, data: [] },
  '/api/orchestration/sessions/read-model': { success: true, data: [] },
  '/api/attention': { success: true, data: { items: [], pendingCount: 0 } },
  '/api/connections/models': { success: true, data: [] },
  '/api/models/capabilities': { success: true, data: [] },
  '/api/system/capabilities': {
    voice: { stt: [], tts: [] },
    context: { providers: [] },
  },
  '/api/feedback/ratings': { success: true, data: [] },
  '/api/tasks': { success: true, data: [] },
  '/api/plugins/home-role': { success: true, status: { state: 'none' } },
  '/api/environments/ssh/sessions': {
    success: true,
    data: { environments: [], unavailable: [], authenticationRequired: [] },
  },
  '/api/auth/status': { authenticated: true, user: null },
  '/api/boot': {
    version: 1,
    sections: Object.fromEntries(
      [
        'auth',
        'config',
        'capabilities',
        'branding',
        'agents',
        'projects',
        'models',
      ].map((name) => [name, { error: true }]),
    ),
  },
  '/api/branding': {
    success: true,
    data: { name: 'Station', logo: null, theme: null, welcomeMessage: null },
  },
  '/api/conversations': { success: true, data: { items: [], hasMore: false } },
  '/api/feature-previews': { success: true, data: [] },
  '/api/system/core-update': {
    installKind: 'unknown',
    updateAvailable: false,
    message: 'Updates unavailable in this browser fixture',
  },
  '/api/system/skills': { success: true, data: [] },
  '/api/usage-telemetry/disclosure': {
    success: true,
    data: { acknowledged: true, inventoryRevision: 'fixture', events: {} },
  },
  // #2061: `ProjectSidebarBoards`, mounted by `ProjectSidebar` on every shell
  // render, lists the authenticated caller's own Boards. The envelope is the
  // route's own — `src-server/routes/me/personal-layouts.ts:172-177` answers
  // `{ success: true, data: service.list(owner) }` — and the list is EMPTY
  // because nobody in these fixtures has made a Board. That is the shape the
  // real route returns for such a caller, and the section renders itself
  // away for it (ProjectSidebarBoards.tsx:26-36), which is why every shell
  // journey before #2061 looked exactly as it does now.
  '/api/me/layouts': { success: true, data: [] },
};

/**
 * The environment id every shared shell fixture's `/.well-known/station/v1`
 * handshake publishes (`chat-shell-fixture.ts`, `daily-driver-shell.ts`,
 * `orchestration.ts`). A spec whose handshake publishes a different id passes
 * it to `fulfillStationShellRead`, so the observation below never names a
 * Station other than the one the handshake introduced.
 */
export const SHELL_FIXTURE_ENVIRONMENT_ID =
  '11111111-1111-4111-8111-111111111111';

/**
 * `GET /api/auth/authority` (#2278). `AuthorityQueryProvider` reads this
 * credential-bound observation on every activation of a saved connection,
 * before any protected query mounts, so every shell journey issues it.
 *
 * The body is the route's own BARE envelope — `src-server/routes/system/auth.ts`
 * answers `c.json(captured.envelope)` with no `{success,data}` wrapper — and
 * the SDK parses it closed (`isAuthorityObservation`), so a field the
 * contract does not declare would be refused.
 *
 * The browser in these fixtures is a same-origin page on its own Station,
 * which authenticates with an HttpOnly device-session cookie, not the
 * operator bearer (`runtime-request-security.ts`). The server therefore
 * answers with a DEVICE grant carrying the default pairing grant's tokens
 * (`DEFAULT_GRANT_PAIRING_SCOPE`, what an unscoped local pairing issues).
 * A UI-bootstrap device is minted with `locality: 'home-possession'`, which
 * `principal-resolver.ts` resolves to the shared `human:local:operator`
 * principal in personal mode.
 */
export function shellAuthorityObservation(
  environmentId: string,
  deviceId = 'shell-fixture-browser',
): AuthorityObservation {
  return {
    schemaVersion: AUTHORITY_OBSERVATION_SCHEMA_VERSION,
    environmentId,
    principal: { kind: 'human', id: 'human:local:operator' },
    grant: {
      kind: 'device',
      deviceId,
      grantedScopes: DEFAULT_GRANT_PAIRING_SCOPE.split(' '),
    },
  };
}

/**
 * `GET /api/conversation-pull-requests/:conversationId` — the "Linked pull
 * requests" section every open session detail renders
 * (`MutableSessionDetail.tsx:196-202`, #1957) and the chat inbox's hover card
 * reads (`ChatInboxHoverCard.tsx:114-130`).
 *
 * Modelled here rather than per spec because the fetch follows the SESSION,
 * not the journey: any fixture that opens a session detail reads it, under
 * whatever conversation id that fixture minted. The envelope is the route's
 * own projection — `src-server/routes/pull-requests/conversation-pull-request-links.ts:126-129`
 * answers `{ conversationId, observedAt, links }`, where `links` is the link
 * store's entries plus the task graph's kept declarations, each observed
 * through its provider.
 *
 * `links` is EMPTY because that is what the real route computes for these
 * fixtures: nothing links a pull request to a conversation (no POST to this
 * family), and no fixture task keeps a declared pull request. It is the
 * decided answer for the state these fixtures actually model, not an empty
 * stand-in for a shape nobody chose — a fixture that returned invented links
 * would assert a conversation history none of them has.
 */
const CONVERSATION_PULL_REQUESTS = '/api/conversation-pull-requests/';
const FIXTURE_OBSERVED_AT = '2026-07-13T00:00:00Z';

/**
 * The chat's browser float (#2444/#2467, `FloatOverChatHost.tsx`) reads the
 * caller's standing for the chat's Project, then that Project's browser
 * sessions, on every chat that mounts with auto-float on (the default).
 *
 * Modelled for the `default` Project only, the one the shared chat shell
 * declares (`chat-shell-fixture.ts`: id `default`, slug `default`); any other
 * slug stays unmodelled so the audit names it. The envelopes are the routes'
 * own (`src-server/routes/browser.ts`, `GET /projects/:projectSlug/access`
 * and `GET /sessions`). These fixtures' caller is the local operator (see
 * `shellAuthorityObservation`), so access answers `role: 'operator'`,
 * `operator: true` and principal key `operator` (`principalKeyFor` in
 * `browser-session-registry.ts`). No browser has been acquired in a
 * fixture, so `browser` is `not-ready`; and nobody has started a browser
 * session, so the session list is empty — the decided state, not a stand-in.
 */
const DEFAULT_PROJECT_BROWSER_ACCESS: BrowserPaneAccessView = {
  projectId: 'default',
  role: 'operator',
  principalKey: 'operator',
  operator: true,
  browser: 'not-ready',
};
const DEFAULT_PROJECT_BROWSER_SESSIONS: BrowserSessionView[] = [];

export async function fulfillStationShellRead(
  route: Route,
  options: { environmentId?: string; deviceId?: string } = {},
): Promise<boolean> {
  const request = route.request();
  const path = new URL(request.url()).pathname;
  if (request.method() === 'GET' && path === '/api/auth/authority') {
    const observation = shellAuthorityObservation(
      options.environmentId ?? SHELL_FIXTURE_ENVIRONMENT_ID,
      options.deviceId,
    );
    // The client parses this closed; a fixture the contract refuses would
    // silently route every journey through the unverified branch instead.
    if (!isAuthorityObservation(observation))
      throw new Error('shell authority observation violates its contract');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify(observation),
    });
    return true;
  }
  if (
    request.method() === 'GET' &&
    path === '/api/orchestration/attachment-staging/capability'
  ) {
    // This default fixture exercises a negotiated legacy peer; staging tests override it.
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({
        success: false,
        error: 'Legacy fixture has no staging endpoint',
      }),
    });
    return true;
  }
  if (
    request.method() === 'GET' &&
    /^\/api\/orchestration\/sessions\/(?:claude|station)%3A\d+\/checkpoints$/.test(
      path,
    )
  ) {
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({
        success: false,
        error: 'Client-only draft has no execution Session',
      }),
    });
    return true;
  }
  if (
    request.method() === 'GET' &&
    [
      '/api/action-operations',
      '/api/environments/peers',
      '/api/environments/ssh',
      '/api/live-activity',
      '/api/orchestration/commands/receipts',
      '/api/projects/default/workflow/tasks',
      '/api/pull-requests/context',
    ].includes(path)
  ) {
    // Optional Activity sources are explicitly unavailable in the conversation fixture.
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        success: false,
        error: 'Optional Activity source unavailable in this fixture',
      }),
    });
    return true;
  }
  if (
    request.method() === 'GET' &&
    /^\/api\/orchestration\/sessions\/chat-(?:running|review)\/checkpoints$/.test(
      path,
    )
  ) {
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({
        success: false,
        error: 'Client storage key is not an execution Session',
      }),
    });
    return true;
  }
  if (
    request.method() === 'GET' &&
    path === '/api/browser/projects/default/access'
  ) {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: DEFAULT_PROJECT_BROWSER_ACCESS,
      }),
    });
    return true;
  }
  if (
    request.method() === 'GET' &&
    path === '/api/browser/sessions' &&
    new URL(request.url()).searchParams.get('projectSlug') === 'default'
  ) {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: DEFAULT_PROJECT_BROWSER_SESSIONS,
      }),
    });
    return true;
  }
  if (request.method() === 'GET' && path === '/api/orchestration/events') {
    await route.abort();
    return true;
  }
  if (
    request.method() === 'GET' &&
    path.startsWith(CONVERSATION_PULL_REQUESTS)
  ) {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          // Echoed from the path, the way the route echoes its own parameter:
          // the SDK client refuses a projection whose identity is not the one
          // it asked for (`conversation-pull-request-links.ts:30-34`), so a
          // constant here would answer one conversation and break the rest.
          conversationId: decodeURIComponent(
            path.slice(CONVERSATION_PULL_REQUESTS.length),
          ),
          observedAt: FIXTURE_OBSERVED_AT,
          links: [],
        },
      }),
    });
    return true;
  }
  if (request.method() !== 'GET' || !Object.hasOwn(READS, path)) return false;
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(READS[path]),
  });
  return true;
}

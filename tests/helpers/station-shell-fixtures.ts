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

export async function fulfillStationShellRead(route: Route): Promise<boolean> {
  const request = route.request();
  const path = new URL(request.url()).pathname;
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

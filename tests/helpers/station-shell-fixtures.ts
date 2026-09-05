import type { Route } from '@playwright/test';

/** Explicit optional shell reads; keep each envelope aligned with its route owner. */
const READS: Readonly<Record<string, unknown>> = {
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
};

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
  if (request.method() !== 'GET' || !Object.hasOwn(READS, path)) return false;
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(READS[path]),
  });
  return true;
}

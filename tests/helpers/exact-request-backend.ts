import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ProviderSession } from '@kontourai/station-contracts/provider';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import type { Page } from '@playwright/test';
import { Hono } from 'hono';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../src-server/__test-utils__/orchestration-gate-test-harness';
import { createAttentionRoutes } from '../../src-server/routes/orchestration/attention';
import { createOrchestrationRoutes } from '../../src-server/routes/orchestration/orchestration';
import { EventBus } from '../../src-server/services/orchestration/event-bus';
import { EventStore } from '../../src-server/services/orchestration/event-store';
import { OrchestrationService } from '../../src-server/services/orchestration/orchestration-service';
import { AttentionProjectionService } from '../../src-server/services/projects/attention-projection';

/** Real route/service/SQLite seams with a controlled in-process provider, not a live account. */
export async function exactRequestBackend(page: Page, databasePath: string) {
  mkdirSync(dirname(databasePath), { recursive: true });
  const store = new EventStore(databasePath);
  const eventBus = new EventBus();
  const now = new Date().toISOString();
  const session: ProviderSession = {
    provider: 'claude',
    threadId: 'browser-request-session',
    status: 'ready',
    controlMode: 'station-owned',
    createdAt: now,
    updatedAt: now,
  };
  store.upsertSession(session);
  store.appendEvent({
    eventId: 'browser-request-owner',
    threadId: session.threadId,
    provider: session.provider,
    createdAt: now,
    method: 'session.configured',
    sessionId: session.threadId,
    metadata: { userId: 'browser-request-owner' },
  });
  const adapter = new GateTestAdapter();
  adapter.hasSession = async (threadId?: string) =>
    threadId === session.threadId;
  adapter.listSessions = async () => [session];
  const effects: Array<{ requestId: string; decision: string }> = [];
  adapter.respondToRequest = async (
    _thread?: string,
    requestId?: string,
    decision?: 'accept' | 'acceptForSession' | 'decline' | 'cancel',
  ) => {
    if (!requestId || !decision)
      throw new Error('Missing controlled request decision');
    effects.push({ requestId, decision });
    adapter.events.push({
      eventId: `browser-resolved-${effects.length}`,
      threadId: session.threadId,
      provider: session.provider,
      createdAt: new Date().toISOString(),
      method: 'request.resolved',
      requestId,
      status: decision === 'accept' ? 'approved' : 'denied',
    });
  };
  const service = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(adapter),
    eventBus,
    eventStore: store,
    logger: { debug() {}, warn() {} },
  });
  service.initialize();
  let currentEvent = 'browser-opened-a';
  const emit = () =>
    adapter.events.push({
      eventId: currentEvent,
      threadId: session.threadId,
      provider: session.provider,
      createdAt: new Date().toISOString(),
      method: 'request.opened',
      requestId: 'browser-request',
      requestType: 'permission',
      title: 'Allow the fixture file inspection',
      description: 'Read one fixture file. No external provider is contacted.',
      payload: {
        toolName: 'fixture_read',
        arguments: { path: '/fixture/readme.txt' },
      },
    });
  emit();
  const authority = sessionReadAuthorityFromRequest(
    'browser-request-owner',
    undefined,
    undefined,
  );
  const attention = new AttentionProjectionService(
    { list: () => [] },
    service,
    { getRunConsole: async () => ({ gates: [] }) } as never,
    undefined,
    undefined,
    () => 'browser-request-owner',
  );
  const app = new Hono();
  app.route(
    '/api/attention',
    createAttentionRoutes(attention, {
      readAuthorityForRequest: () => authority,
    }),
  );
  app.route(
    '/api/orchestration',
    createOrchestrationRoutes(service, {
      eventBus,
      logger: { debug() {} },
      getUserId: () => 'browser-request-owner',
      isRequestPrincipalCurrent: () => true,
    }),
  );
  await page.route(
    (url) =>
      url.pathname === '/api/attention' ||
      url.pathname.startsWith('/api/attention/') ||
      url.pathname.startsWith(
        `/api/orchestration/sessions/${session.threadId}`,
      ) ||
      url.pathname === '/api/orchestration/commands',
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const response = await app.request(url.pathname + url.search, {
        method: request.method(),
        headers: request.headers(),
        ...(request.postData() ? { body: request.postData()! } : {}),
      });
      await route.fulfill({
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: await response.text(),
      });
    },
  );
  return {
    effects,
    current: () =>
      store.readCurrentRequestEvent(session.threadId, 'browser-request'),
    reopen: () => {
      currentEvent = 'browser-opened-b';
      emit();
    },
    receipts: () => store.listCommandReceipts(session.threadId),
    close: async () => {
      await service.shutdown();
      store.close();
    },
  };
}

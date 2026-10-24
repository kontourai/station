import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import {
  parseHostedTenantRegistry,
  tenantExecutionContextFromSession,
  tenantId,
} from '@kontourai/station-contracts/tenancy';
import { Hono } from 'hono';
import { afterEach, expect, test } from 'vitest';
import { awaitSessionAttachmentSettled } from '../../../__test-utils__/session-runtime-barriers.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { createHostedTenantMiddleware } from '../../../runtime/bootstrap/runtime-tenant-context.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_TENANT_HEADER,
} from '../../../utils/internal-api-token.js';
import { createEventRoutes } from '../events.js';
import { createOrchestrationRoutes } from '../orchestration.js';

const temp = trackTempDirs();
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test('committed inbox and deletion notices reach authorized observers but never another owner, another thread filter or the bare stream', async () => {
  const databasePath = join(
    temp('session-delete-notification-'),
    'events.sqlite',
  );
  const store = new EventStore(databasePath);
  const committedReader = new DatabaseSync(databasePath);
  cleanups.push(() => committedReader.close());
  const bus = new EventBus();
  const service = new OrchestrationService({
    adapterRegistry: { register() {}, get: () => undefined, list: () => [] },
    eventBus: bus,
    eventStore: store,
    logger: { debug() {}, warn() {} },
    personalConversationAccess: {
      canRead: (user, owner) =>
        (user === 'observer' && owner === 'owner') ||
        (user === 'owner' && owner === 'other-owner'),
      ownerIds: () => undefined,
    },
  });
  cleanups.push(async () => {
    await service.shutdown();
    store.close();
  });
  service.initialize();
  await awaitSessionAttachmentSettled(service);
  const threadId = 'private-draft';
  store.upsertSession({
    provider: 'claude',
    threadId,
    status: 'closed',
    createdAt: '2026-10-22T00:00:00Z',
    updatedAt: '2026-10-22T00:00:00Z',
  });
  store.appendEvent({
    eventId: 'draft-start',
    provider: 'claude',
    threadId,
    method: 'session.started',
    sessionId: threadId,
    createdAt: '2026-10-22T00:00:00Z',
    metadata: { userId: 'owner', conversationId: threadId },
  });
  // A different owned thread provides a post-delete liveness marker for denied streams.
  store.upsertSession({
    provider: 'claude',
    threadId: 'other-thread',
    status: 'closed',
    createdAt: '2026-10-22T00:00:00Z',
    updatedAt: '2026-10-22T00:00:00Z',
  });
  store.appendEvent({
    eventId: 'other-start',
    provider: 'claude',
    threadId: 'other-thread',
    method: 'session.started',
    sessionId: 'other-thread',
    createdAt: '2026-10-22T00:00:00Z',
    metadata: { userId: 'other-owner' },
  });
  let actor = 'owner';
  const app = createOrchestrationRoutes(service, {
    eventBus: bus,
    getUserId: () => actor,
    logger: { debug() {} },
  });
  const openStream = async (user: string, path: string) => {
    actor = user;
    const abort = new AbortController();
    cleanups.push(() => abort.abort());
    const response = await app.request(path, { signal: abort.signal });
    const reader = response.body!.getReader();
    cleanups.push(() => reader.cancel());
    const decoder = new TextDecoder();
    let text = '';
    const until = async (marker: string, count = 1) => {
      while (text.split(marker).length - 1 < count) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`Missing stream marker ${marker}`);
        text += decoder.decode(chunk.value, { stream: true });
      }
      return text;
    };
    await until('orchestration:caughtUp');
    text = '';
    return { until };
  };
  const stranger = await openStream('other-owner', '/events');
  const filtered = await openStream('owner', '/events?threadId=other-thread');
  const observer = await openStream('observer', '/events');
  actor = 'owner';
  const bareAbort = new AbortController();
  cleanups.push(() => bareAbort.abort());
  const bare = createEventRoutes({
    eventBus: bus,
    getACPStatus: () => ({ connected: false, connections: [] }),
    logger: { debug() {} },
  });
  const bareResponse = await bare.request('/', { signal: bareAbort.signal });
  const bareReader = bareResponse.body!.getReader();
  cleanups.push(() => bareReader.cancel());
  let bareWire = '';
  const bareUntil = async (marker: string) => {
    while (!bareWire.includes(marker)) {
      const chunk = await bareReader.read();
      if (chunk.done) throw new Error(`Missing bare marker ${marker}`);
      bareWire += new TextDecoder().decode(chunk.value);
    }
  };
  await bareUntil('acp:status');
  const controller = new AbortController();
  cleanups.push(() => controller.abort());
  const stream = await app.request('/events', { signal: controller.signal });
  const reader = stream.body!.getReader();
  cleanups.push(() => reader.cancel());
  const decoder = new TextDecoder();
  let wire = '';
  const until = async (marker: string) => {
    while (!wire.includes(marker)) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`Stream ended before ${marker}`);
      wire += decoder.decode(chunk.value, { stream: true });
    }
  };
  await until('orchestration:caughtUp');
  expect(wire).toContain(threadId);
  const inboxStore = store.threadInboxStore();
  const committedStates: string[] = [];
  cleanups.push(
    bus.subscribe((event) => {
      if (event.event === SERVER_EVENTS.ORCHESTRATION_INBOX_CHANGED)
        committedStates.push(
          committedReader
            .prepare(
              'SELECT state FROM monument_inbox_entries WHERE inbox_id = ? ORDER BY sequence',
            )
            .all(threadId)
            .map((entry) => entry.state)
            .join(','),
        );
    }),
  );
  let inboxNotices = 0;
  const checkInbox = async (state: string) => {
    inboxNotices++;
    expect(committedStates.at(-1)).toBe(state);
    await observer.until(
      `event: ${SERVER_EVENTS.ORCHESTRATION_INBOX_CHANGED}`,
      inboxNotices,
    );
  };
  inboxStore.submit({
    conversationId: threadId,
    clientTurnId: 'held',
    payload: { message: 'follow up', actor: { userId: 'owner' } },
    now: 1,
  });
  await checkInbox('queued');
  const claimed = inboxStore.claimNext(threadId, threadId, 2);
  expect(claimed.kind).toBe('claimed');
  if (claimed.kind !== 'claimed') throw new Error('Inbox claim missing');
  await checkInbox('placing');
  inboxStore.settle(
    claimed.entry,
    'unconfirmed',
    { reasonCode: 'may_have_been_sent' },
    3,
  );
  await checkInbox('unconfirmed');
  inboxStore.resolveUnconfirmed(claimed.entry, 'queued', {}, 4);
  await checkInbox('queued');
  const retry = inboxStore.claimNext(threadId, threadId, 5);
  if (retry.kind !== 'claimed') throw new Error('Inbox retry claim missing');
  await checkInbox('placing');
  inboxStore.settle(retry.entry, 'refused', { reasonCode: 'not_permitted' }, 6);
  await checkInbox('refused');
  inboxStore.cancel(threadId, 'held', 7);
  await checkInbox('cancelled');
  expect(committedStates).toEqual([
    'queued',
    'placing',
    'unconfirmed',
    'queued',
    'placing',
    'refused',
    'cancelled',
  ]);
  const notices: unknown[] = [];
  cleanups.push(
    bus.subscribe((event) => {
      if (event.event !== SERVER_EVENTS.ORCHESTRATION_SESSIONS_CHANGED) return;
      notices.push({
        data: {
          threadId: event.data?.threadId,
          scoped: typeof event.data?.canRead === 'function',
        },
        session: store.readSessionByThread(threadId),
        events: store.listEvents(threadId),
      });
    }),
  );
  const discard = () =>
    app.request('/commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'discardDraft', threadId }),
    });
  actor = 'other-owner';
  const refused = await discard();
  expect(refused.status, JSON.stringify(await refused.json())).toBe(400);
  expect(notices).toEqual([]);
  actor = 'owner';
  const response = await discard();
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  expect(body).toMatchObject({
    success: true,
    receipt: { status: 'accepted' },
  });
  expect(notices).toEqual([
    { data: { threadId, scoped: true }, session: undefined, events: [] },
  ]);
  // A missing publication must fail at this assertion, not hang behind keepalives.
  const deadline = setTimeout(() => controller.abort(), 5000);
  try {
    await until(`event: ${SERVER_EVENTS.ORCHESTRATION_SESSIONS_CHANGED}`);
  } finally {
    clearTimeout(deadline);
  }
  expect(
    wire.split(`event: ${SERVER_EVENTS.ORCHESTRATION_SESSIONS_CHANGED}`)[1],
  ).toMatch(/^\r?\ndata: \{\}/);
  const observerWire = await observer.until(
    `event: ${SERVER_EVENTS.ORCHESTRATION_SESSIONS_CHANGED}`,
  );
  expect(observerWire).toContain('data: {}');
  bus.emit(SERVER_EVENTS.ORCHESTRATION_SESSION_PROJECTION_UPDATED, {
    threadId: 'other-thread',
  });
  const strangerWire = await stranger.until(
    'orchestration:session-projection-updated',
  );
  expect(strangerWire).not.toContain(
    SERVER_EVENTS.ORCHESTRATION_SESSIONS_CHANGED,
  );
  expect(strangerWire).not.toContain(SERVER_EVENTS.ORCHESTRATION_INBOX_CHANGED);
  const filteredWire = await filtered.until(
    'orchestration:session-projection-updated',
  );
  expect(filteredWire).not.toContain(
    SERVER_EVENTS.ORCHESTRATION_SESSIONS_CHANGED,
  );
  bus.emit(SERVER_EVENTS.CONFIG_CHANGED, { marker: 'after-delete' });
  await bareUntil('after-delete');
  expect(bareWire).not.toContain(SERVER_EVENTS.ORCHESTRATION_SESSIONS_CHANGED);
  expect(bareWire).not.toContain(SERVER_EVENTS.ORCHESTRATION_INBOX_CHANGED);
  const listed = await (await app.request('/sessions/read-model')).json();
  expect(listed).toMatchObject({ success: true });
  expect(JSON.stringify(listed)).not.toContain(threadId);
  expect(store.conversationSessions(threadId)).toEqual([]);
  expect(store.listCommandReceipts(threadId)).toHaveLength(1);
  // Other delete callers share the same post-commit notification boundary.
  notices.length = 0;
  store.deleteThread('abandoned-alias');
  expect(notices).toEqual([]);
});

test('the same principal on another tenant receives neither inbox nor deletion timing', async () => {
  const store = new EventStore(
    join(temp('session-notice-tenants-'), 'events.sqlite'),
  );
  const registry = parseHostedTenantRegistry({
    schemaVersion: 1,
    tenants: [
      { id: 'alpha', authority: 'alpha.example.test' },
      { id: 'bravo', authority: 'bravo.example.test' },
    ],
  });
  for (const [threadId, tenant] of [
    ['delete-alpha', 'alpha'],
    ['marker-alpha', 'alpha'],
    ['marker-bravo', 'bravo'],
  ] as const) {
    store.upsertSession({
      provider: 'claude',
      threadId,
      status: 'closed',
      createdAt: '2026-10-22T00:00:00Z',
      updatedAt: '2026-10-22T00:00:00Z',
      tenantExecutionContext: { tenantId: tenantId(tenant), source: 'request' },
    });
    store.appendEvent({
      eventId: threadId,
      provider: 'claude',
      threadId,
      method: 'session.started',
      sessionId: threadId,
      createdAt: '2026-10-22T00:00:00Z',
      metadata: { userId: 'same-principal' },
    });
  }
  const bus = new EventBus();
  const service = new OrchestrationService({
    adapterRegistry: { register() {}, get: () => undefined, list: () => [] },
    eventBus: bus,
    eventStore: store,
    logger: { debug() {}, warn() {} },
    requireTenantExecutionContext: () => true,
    validateRecoveredTenantExecutionContext: (context) =>
      context &&
      registry.tenants.some((tenant) => tenant.id === context.tenantId)
        ? tenantExecutionContextFromSession(context)
        : undefined,
  });
  cleanups.push(async () => {
    await service.shutdown();
    store.close();
  });
  service.initialize();
  await awaitSessionAttachmentSettled(service);
  const routes = createOrchestrationRoutes(service, {
    eventBus: bus,
    getUserId: () => 'same-principal',
    hostedTenantRegistry: registry,
    logger: { debug() {} },
  });
  const app = new Hono();
  app.use('*', createHostedTenantMiddleware(registry));
  app.route('', routes);
  const open = async (tenant: string) => {
    const controller = new AbortController();
    cleanups.push(() => controller.abort());
    const response = await app.fetch(
      new Request('http://station.test/events', {
        signal: controller.signal,
        headers: {
          [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
          [INTERNAL_TENANT_HEADER]: tenant,
        },
      }),
      { incoming: { socket: { remoteAddress: '127.0.0.1' } } },
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    cleanups.push(() => reader.cancel());
    let wire = '';
    const until = async (marker: string) => {
      while (!wire.includes(marker)) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`Missing ${tenant} marker ${marker}`);
        wire += new TextDecoder().decode(chunk.value);
      }
      return wire;
    };
    await until('orchestration:caughtUp');
    wire = '';
    return { until };
  };
  const alpha = await open('alpha');
  const bravo = await open('bravo');
  store.threadInboxStore().submit({
    conversationId: 'delete-alpha',
    clientTurnId: 'held',
    payload: { message: 'held', actor: { userId: 'same-principal' } },
    now: 1,
  });
  store.deleteThread('delete-alpha');
  const alphaWire = await alpha.until(
    SERVER_EVENTS.ORCHESTRATION_SESSIONS_CHANGED,
  );
  expect(alphaWire).toContain(SERVER_EVENTS.ORCHESTRATION_INBOX_CHANGED);
  expect(
    alphaWire.split(
      `event: ${SERVER_EVENTS.ORCHESTRATION_SESSIONS_CHANGED}`,
    )[1],
  ).toMatch(/^\r?\ndata: \{\}/);
  bus.emit(SERVER_EVENTS.ORCHESTRATION_SESSION_PROJECTION_UPDATED, {
    threadId: 'marker-bravo',
  });
  const bravoWire = await bravo.until(
    SERVER_EVENTS.ORCHESTRATION_SESSION_PROJECTION_UPDATED,
  );
  expect(bravoWire).not.toContain(SERVER_EVENTS.ORCHESTRATION_INBOX_CHANGED);
  expect(bravoWire).not.toContain(SERVER_EVENTS.ORCHESTRATION_SESSIONS_CHANGED);
});

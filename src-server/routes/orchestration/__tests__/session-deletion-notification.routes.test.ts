import { join } from 'node:path';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { afterEach, expect, test } from 'vitest';
import { awaitSessionAttachmentSettled } from '../../../__test-utils__/session-runtime-barriers.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { createOrchestrationRoutes } from '../orchestration.js';

const temp = trackTempDirs();
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test('discard through the command route notifies connected readers only after deletion, without retaining private identity', async () => {
  const store = new EventStore(
    join(temp('session-delete-notification-'), 'events.sqlite'),
  );
  const bus = new EventBus();
  const service = new OrchestrationService({
    adapterRegistry: { register() {}, get: () => undefined, list: () => [] },
    eventBus: bus,
    eventStore: store,
    logger: { debug() {}, warn() {} },
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
  let actor = 'owner';
  const app = createOrchestrationRoutes(service, {
    eventBus: bus,
    getUserId: () => actor,
    logger: { debug() {} },
  });
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
  const notices: unknown[] = [];
  cleanups.push(
    bus.subscribe((event) => {
      if (event.event !== SERVER_EVENTS.ORCHESTRATION_SESSIONS_CHANGED) return;
      notices.push({
        data: event.data,
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
    { data: undefined, session: undefined, events: [] },
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
  const listed = await (await app.request('/sessions/read-model')).json();
  expect(listed).toMatchObject({ success: true, data: [] });
  expect(store.conversationSessions(threadId)).toEqual([]);
  expect(store.listCommandReceipts(threadId)).toHaveLength(1);
  // Other delete callers share the same post-commit notification boundary.
  notices.length = 0;
  store.deleteThread('abandoned-alias');
  expect(notices).toEqual([
    { data: undefined, session: undefined, events: [] },
  ]);
});

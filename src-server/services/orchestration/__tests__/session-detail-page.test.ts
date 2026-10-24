import { join } from 'node:path';
import type { OrchestrationSessionEventWindow } from '@kontourai/station-contracts/orchestration';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { createOrchestrationRoutes } from '../../../routes/orchestration/orchestration.js';
import { EventBus } from '../event-bus.js';
import {
  EventStore,
  SESSION_EVENT_WINDOW_MAX_RESPONSE_BYTES,
} from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';

const makeTempDir = trackTempDirs();
const stores: EventStore[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
});

// The route must reach the real store's existing cursor and byte budgets.
// A full-detail fallback fails both the bounded response and no-replay assertions.
test('detail pages keep newest-turn cursors, lazy images and authorization across history growth', async () => {
  const store = new EventStore(
    join(makeTempDir('session-detail-page-'), 'events.sqlite'),
  );
  stores.push(store);
  const createdAt = '2026-10-22T00:00:00.000Z';
  store.upsertSession({
    provider: 'claude',
    threadId: 'thread',
    status: 'closed',
    createdAt,
    updatedAt: createdAt,
  });
  let ordinal = 0;
  const append = (event: Record<string, unknown>) =>
    store.appendEvent({
      eventId: `page-event-${++ordinal}`,
      provider: 'claude',
      threadId: 'thread',
      createdAt,
      ...event,
    } as CanonicalRuntimeEvent);
  append({
    method: 'session.started',
    sessionId: 'thread',
    metadata: { userId: 'owner' },
  });
  const pixels = Buffer.alloc(6 * 1024, 7);
  for (let turn = 0; turn < 3; turn++) {
    append({
      method: 'turn.started',
      turnId: `turn-${turn}`,
      prompt: `Prompt ${turn}`,
      attachments: [
        {
          kind: 'image',
          name: 'image.png',
          mimeType: 'image/png',
          size: pixels.length,
          dataUrl: `data:image/png;base64,${pixels.toString('base64')}`,
        },
      ],
    });
    for (let n = 0; n < 160; n++)
      append({
        method: 'content.text-delta',
        turnId: `turn-${turn}`,
        delta: 'text '.repeat(50),
      });
    append({
      method: 'turn.completed',
      turnId: `turn-${turn}`,
      finishReason: 'stop',
      outputText: `Answer ${turn}`,
    });
  }
  const bus = new EventBus();
  const service = new OrchestrationService({
    eventStore: store,
    eventBus: bus,
    adapterRegistry: { register() {}, get: () => undefined, list: () => [] },
    logger: { debug() {}, warn() {}, info() {}, error() {} },
  } as never);
  service.initialize();
  let caller = 'owner';
  const app = createOrchestrationRoutes(service, {
    eventBus: bus,
    logger: { debug() {} },
    getUserId: () => caller,
  });
  const replay = vi.spyOn(store, 'listEvents');
  const blobs = vi.spyOn(store['attachmentBlobs'], 'read');
  const inventory = vi.spyOn(service, 'listSessions');
  const firstResponse = await app.request(
    '/sessions/thread?view=window-v1&turnLimit=1',
  );
  expect(firstResponse.status).toBe(200);
  const text = await firstResponse.text();
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(
    SESSION_EVENT_WINDOW_MAX_RESPONSE_BYTES,
  );
  const first = (JSON.parse(text) as { data: OrchestrationSessionEventWindow })
    .data;
  expect(first.protocolVersion).toBe(1);
  expect(first.hasMore).toBe(true);
  expect(first.events.length).toBeLessThanOrEqual(150);
  expect(
    first.events.some(
      ({ event }) =>
        event.method === 'turn.completed' && event.turnId === 'turn-2',
    ),
  ).toBe(true);
  expect(text).toContain('blobRef');
  expect(text).not.toContain('data:image');
  const watermark = first.watermark;
  append({
    method: 'turn.started',
    turnId: 'late-turn',
    prompt: 'Written after the snapshot',
  });
  const ids = new Set(first.events.map(({ event }) => event.eventId));
  let page = first;
  let pages = 1;
  while (page.hasMore) {
    expect(page.nextCursor).toBeTruthy();
    expect(pages++).toBeLessThan(12);
    const response = await app.request(
      `/sessions/thread?view=window-v1&turnLimit=1&cursor=${encodeURIComponent(page.nextCursor!)}`,
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(
      SESSION_EVENT_WINDOW_MAX_RESPONSE_BYTES,
    );
    page = (JSON.parse(body) as { data: OrchestrationSessionEventWindow }).data;
    expect(page.watermark).toBe(watermark);
    for (const { sequence, event } of page.events) {
      expect(sequence).toBeLessThanOrEqual(watermark);
      expect(event.turnId).not.toBe('late-turn');
      ids.add(event.eventId);
    }
  }
  // The turn window includes all 3 starts, 480 deltas and 3 completions;
  // the session.started binding lives in the authoritative summary.
  expect(ids.size).toBe(486);
  // Existing conversation-window consumers also avoid full history per lineage member.
  const conversation = await service.readConversationEventWindow('thread', {
    direction: 'newest',
    turnLimit: 1,
    authority: sessionReadAuthorityFromRequest('owner', undefined, undefined),
  });
  expect(conversation?.session.eventCount).toBe(watermark + 1);
  expect(replay).not.toHaveBeenCalled();
  expect(blobs).not.toHaveBeenCalled();
  expect(inventory).not.toHaveBeenCalled();
  caller = 'stranger';
  expect((await app.request('/sessions/thread?view=window-v1')).status).toBe(
    404,
  );
  expect((await app.request('/sessions/missing?view=window-v1')).status).toBe(
    404,
  );
  expect(
    (await app.request('/sessions/thread?view=window-v1&turnLimit=0')).status,
  ).toBe(400);
  expect((await app.request('/sessions/thread?view=other')).status).toBe(400);
  caller = 'owner';
  const legacy = await app.request('/sessions/thread');
  expect(legacy.status).toBe(200);
  const detail = (await legacy.json()) as { data: { events: unknown[] } };
  expect(detail.data.events).toHaveLength(watermark + 1);
});

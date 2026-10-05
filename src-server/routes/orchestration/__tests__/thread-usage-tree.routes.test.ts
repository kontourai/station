/**
 * The conversation usage-tree route: authorized like the conversation's other
 * reads, `no-store`, and refused (422) past its bound rather than cut.
 */
import { join } from 'node:path';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import type { ThreadUsageTree } from '@kontourai/station-contracts/thread-usage-tree';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventBus } from '../../../services/orchestration/event-bus';
import { EventStore } from '../../../services/orchestration/event-store';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service';
import { createOrchestrationRoutes } from '../orchestration';

// Created before the cleanup hook below, so its directories are removed
// after the service and store close (after-hooks run in reverse order).
const makeTempDir = trackTempDirs();
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function start(
  store: EventStore,
  threadId: string,
  metadata: Record<string, unknown> = {},
  userId = 'owner',
) {
  store.upsertSession({
    provider: 'claude',
    threadId,
    status: 'closed',
    createdAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:01.000Z',
  });
  store.appendEvent({
    eventId: `${threadId}:start`,
    threadId,
    sessionId: threadId,
    provider: 'claude',
    method: 'session.started',
    createdAt: '2026-09-23T00:00:00.000Z',
    metadata: { userId, ...metadata },
  } as CanonicalRuntimeEvent);
}

function fixture(options: { user?: string; principalCurrent?: boolean } = {}) {
  const directory = makeTempDir('station-usage-tree-route-');
  const store = new EventStore(join(directory, 'events.sqlite'));
  const service = new OrchestrationService({
    adapterRegistry: { register() {}, get: () => undefined, list: () => [] },
    eventBus: new EventBus(),
    eventStore: store,
    logger: { debug: vi.fn(), warn: vi.fn() },
  } as never);
  service.initialize();
  start(store, 'conv');
  store.appendEvent({
    eventId: 'conv:usage',
    threadId: 'conv',
    turnId: 'turn-1',
    provider: 'claude',
    method: 'token-usage.updated',
    createdAt: '2026-09-23T00:00:02.000Z',
    promptTokens: 30,
    completionTokens: 12,
    reportedCostUsd: 0.5,
  } as CanonicalRuntimeEvent);
  const app = createOrchestrationRoutes(service, {
    eventBus: new EventBus(),
    logger: { debug: vi.fn() },
    getUserId: () => options.user ?? 'owner',
    isRequestPrincipalCurrent: () => options.principalCurrent ?? true,
  } as never);
  cleanups.push(async () => {
    await service.shutdown();
    store.close();
  });
  return { app, store };
}

describe('GET /conversations/:conversationId/usage-tree', () => {
  test('returns the tree to a reader of the conversation, uncached', async () => {
    const { app } = fixture();
    const response = await app.request('/conversations/conv/usage-tree');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = (await response.json()) as {
      success: boolean;
      data: ThreadUsageTree;
    };
    expect(body.data.root.own).toMatchObject({
      inputTokens: 30,
      outputTokens: 12,
      totalTokens: 42,
      reportedCost: [{ amount: 0.5, currency: 'USD' }],
    });
    expect(body.data.total.tokens).toMatchObject({
      totalTokens: 42,
      complete: true,
    });
  });

  test('is a 404 for a caller who cannot read the conversation, or whose principal is stale', async () => {
    const stranger = fixture({ user: 'stranger' });
    expect(
      (await stranger.app.request('/conversations/conv/usage-tree')).status,
    ).toBe(404);
    const stale = fixture({ principalCurrent: false });
    expect(
      (await stale.app.request('/conversations/conv/usage-tree')).status,
    ).toBe(404);
  });

  test('refuses a tree past its bound with 422', async () => {
    const { app, store } = fixture();
    for (let index = 0; index < 200; index += 1)
      start(store, `task-${index}`, {
        taskId: `task-${index}`,
        parentTaskId: 'conv',
      });
    const response = await app.request('/conversations/conv/usage-tree');
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      success: false,
      error: "This conversation's usage tree is past its nodes limit (200).",
    });
  });
});

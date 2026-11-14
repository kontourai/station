/**
 * The conversation stats' engine MCP status comes from the usage fold over
 * the event store's usage read (`listUsageEventPayloads`). That read selects
 * methods in SQL, so an `engine-mcp.status` it leaves out never reaches the
 * fold: this test goes through the real store, not a stubbed event list.
 */
import { join } from 'node:path';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { foldUsageEvents } from '@kontourai/station-shared/usage-fold';
import { expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventStore } from '../event-store.js';

const makeHome = trackTempDirs();

test('a persisted engine MCP report reaches the usage fold with its servers and reconnect bit', () => {
  const store = new EventStore(
    join(makeHome('usage-engine-mcp-'), 'events.sqlite'),
  );
  try {
    const threadId = 'scripted:1';
    const base = {
      threadId,
      provider: 'acp',
      createdAt: '2026-11-13T00:00:00.000Z',
    } as const;
    store.upsertSession({
      provider: 'acp',
      threadId,
      status: 'ready',
      model: 'auto',
      createdAt: base.createdAt,
      updatedAt: base.createdAt,
    });
    // The store also keeps a thread's first and newest rows whatever their
    // method: events on both sides keep the report from being either.
    store.appendEvent({
      ...base,
      eventId: 'turn-0',
      method: 'turn.started',
      turnId: 't1',
    } as CanonicalRuntimeEvent);
    const report: CanonicalRuntimeEvent = {
      ...base,
      eventId: 'mcp-1',
      method: 'engine-mcp.status',
      complete: true,
      reconnect: true,
      servers: [
        { name: 'docs', state: 'needs-auth', scope: 'engine-config' },
        { name: 'tracker', state: 'ready', toolCount: 2, scope: 'session' },
      ],
    };
    store.appendEvent(report);
    store.appendEvent({
      ...base,
      eventId: 'turn-1',
      method: 'turn.completed',
      turnId: 't1',
      status: 'completed',
    } as CanonicalRuntimeEvent);
    expect(
      foldUsageEvents(store.listUsageEventPayloads(threadId)).engineMcp,
    ).toEqual({
      servers: [
        { name: 'docs', state: 'needs-auth', scope: 'engine-config' },
        { name: 'tracker', state: 'ready', toolCount: 2, scope: 'session' },
      ],
      reconnect: true,
    });
  } finally {
    store.close();
  }
});

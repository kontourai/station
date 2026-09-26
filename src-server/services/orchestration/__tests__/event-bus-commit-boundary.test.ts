import { join } from 'node:path';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';

const makeTempDir = trackTempDirs();

test('the service refuses to broadcast an event held by an outer transaction', async () => {
  const root = makeTempDir('event-bus-commit-');
  const store = new EventStore(join(root, 'orchestration.sqlite'));
  const bus = new EventBus();
  const emitted: string[] = [];
  bus.subscribe(({ event, data }) => {
    if (event === 'orchestration:event')
      emitted.push(String((data?.event as { eventId?: string })?.eventId));
  });
  const service = new OrchestrationService({
    adapterRegistry: {
      register() {},
      get() {
        return undefined;
      },
      list() {
        return [];
      },
    } as any,
    eventBus: bus,
    eventStore: store,
    logger: { debug: vi.fn(), warn: vi.fn() } as any,
  });
  const event = (eventId: string) =>
    ({
      eventId,
      provider: 'claude',
      threadId: 'thread-1',
      createdAt: '2026-09-24T00:00:00.000Z',
      method: 'session.configured',
      sessionId: 'thread-1',
      metadata: { agentSlug: 'claude' },
    }) as CanonicalRuntimeEvent;
  const db = (store as any).db as { exec(sql: string): void };
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      expect(() =>
        (service as any).publishCanonicalEvent(event('held')),
      ).toThrow(/outer transaction/);
      expect(emitted).toEqual([]);
    } finally {
      db.exec('ROLLBACK');
    }
    expect(store.readGlobalSequence('held')).toBeUndefined();
    (service as any).publishCanonicalEvent(event('committed'));
    expect(emitted).toEqual(['committed']);
    expect(store.readGlobalSequence('committed')).toBeGreaterThan(0);
  } finally {
    await service.shutdown();
    store.close();
  }
});

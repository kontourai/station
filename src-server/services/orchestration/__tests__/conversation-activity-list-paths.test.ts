/**
 * #2309: the inbox's `hasActiveTurn` comes from the conversation activity
 * projection through the service's OWN wiring — both list paths, with a turn
 * whose `turn.started` is older than the 1,000-event tail the history
 * reader's summary fold reads. (Ported from the independent verifier's probe.)
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { expect, test, vi } from 'vitest';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';

test('both service list paths report a turn with more than 1,000 events since it started as active, with its activity', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'conversation-activity-list-'));
  const eventStore = new EventStore(join(tmp, 'o.sqlite'));
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
    eventBus: new EventBus(),
    eventStore,
    logger: { debug: vi.fn(), warn: vi.fn() } as any,
  });
  try {
    const threadId = 'long-turn';
    const at = '2026-08-08T15:00:00.000Z';
    eventStore.upsertSession({
      provider: 'claude',
      threadId,
      status: 'running',
      createdAt: at,
      updatedAt: at,
    });
    eventStore.appendEvent({
      eventId: 's',
      provider: 'claude',
      threadId,
      createdAt: at,
      method: 'session.started',
      sessionId: threadId,
      metadata: { userId: 'owner-alpha', agentSlug: 'claude' },
    } as any);
    eventStore.appendEvent({
      eventId: 't',
      provider: 'claude',
      threadId,
      createdAt: at,
      method: 'turn.started',
      turnId: 'long',
      prompt: 'a long turn',
    } as any);
    for (let index = 0; index < 1_001; index += 1)
      eventStore.appendEvent({
        eventId: `d-${index}`,
        provider: 'claude',
        threadId,
        createdAt: at,
        turnId: 'long',
        method: 'content.text-delta',
        itemId: 'item',
        delta: 'x',
      } as any);
    const authority = sessionReadAuthorityFromRequest(
      'owner-alpha',
      undefined,
      undefined,
    );
    const page = await service.listConversationHistoryPage(authority, {
      limit: 10,
    });
    expect(page.items[0]?.hasActiveTurn).toBe(true);
    expect(page.items[0]?.activity?.openTurn?.turnId).toBe('long');
    const all = await service.listAllSessionConversations(authority);
    expect(all[0]?.hasActiveTurn).toBe(true);
  } finally {
    await service.shutdown().catch(() => {});
    eventStore.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}, 60_000);

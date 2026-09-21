// @vitest-environment jsdom

import { describe, expect, test } from 'vitest';
import {
  SEMANTIC_DELIVERY_SPILL_CHARS,
  SemanticDeliveryBuffer,
} from '../semanticDeliveryBuffer';
import type { OrchestrationEvent } from '../types';

function event(
  method: string,
  overrides: Record<string, unknown> = {},
): OrchestrationEvent {
  return {
    provider: 'claude',
    threadId: 'thread-1',
    turnId: 'turn-1',
    createdAt: '2026-09-20T00:00:00.000Z',
    method,
    ...overrides,
  } as OrchestrationEvent;
}

function names(events: readonly OrchestrationEvent[]) {
  return events.map((item) =>
    item.method.includes('delta')
      ? `${item.method}:${(item as { delta: string }).delta}`
      : item.method,
  );
}

describe('SemanticDeliveryBuffer', () => {
  test('one canonical sequence yields independent immediate and buffered projections without changing raw capture', () => {
    const raw: OrchestrationEvent[] = [];
    const immediate: OrchestrationEvent[] = [];
    const buffered: OrchestrationEvent[] = [];
    const immediateProjection = new SemanticDeliveryBuffer(
      (next) => immediate.push(next),
      () => false,
    );
    const bufferedProjection = new SemanticDeliveryBuffer(
      (next) => buffered.push(next),
      () => true,
    );
    const canonical = [
      event('content.text-delta', { itemId: 'answer', delta: 'Hello ' }),
      event('content.text-delta', { itemId: 'answer', delta: 'world' }),
      event('tool.started', { itemId: 'tool', toolName: 'read' }),
      event('content.text-delta', { itemId: 'answer', delta: 'After tool' }),
      event('request.opened', { requestId: 'approval-1' }),
      event('content.reasoning-delta', { itemId: 'reason', delta: 'Done' }),
      event('turn.completed'),
    ];

    for (const next of canonical) {
      raw.push(next);
      immediateProjection.offer(next);
      bufferedProjection.offer(next);
    }

    expect(raw).toEqual(canonical);
    expect(names(immediate)).toEqual(names(canonical));
    expect(names(buffered)).toEqual([
      'content.text-delta:Hello world',
      'tool.started',
      'content.text-delta:After tool',
      'request.opened',
      'content.reasoning-delta:Done',
      'turn.completed',
    ]);
    // The projection created merged copies; canonical capture remains exact.
    expect(canonical[0]).toHaveProperty('delta', 'Hello ');
    expect(canonical[1]).toHaveProperty('delta', 'world');
  });

  test('flushes hidden text on a mode change and keeps the next delta behind it', () => {
    let buffered = true;
    const delivered: OrchestrationEvent[] = [];
    const projection = new SemanticDeliveryBuffer(
      (next) => delivered.push(next),
      () => buffered,
    );
    projection.offer(
      event('content.text-delta', { itemId: 'a', delta: 'old' }),
    );
    expect(delivered).toEqual([]);

    buffered = false;
    projection.flushAll();
    projection.offer(
      event('content.text-delta', { itemId: 'a', delta: 'new' }),
    );
    expect(names(delivered)).toEqual([
      'content.text-delta:old',
      'content.text-delta:new',
    ]);
  });

  test('spills before crossing 24,000 characters and isolates threads', () => {
    const delivered: OrchestrationEvent[] = [];
    const projection = new SemanticDeliveryBuffer(
      (next) => delivered.push(next),
      () => true,
    );
    projection.offer(
      event('content.text-delta', {
        itemId: 'a',
        delta: 'a'.repeat(SEMANTIC_DELIVERY_SPILL_CHARS - 1),
      }),
    );
    projection.offer(event('content.text-delta', { itemId: 'a', delta: 'bc' }));
    projection.offer(
      event('content.text-delta', {
        threadId: 'thread-2',
        itemId: 'b',
        delta: 'other',
      }),
    );

    expect(names(delivered)).toEqual([
      `content.text-delta:${'a'.repeat(SEMANTIC_DELIVERY_SPILL_CHARS - 1)}`,
    ]);
    projection.offer(event('runtime.error', { message: 'failed' }));
    expect(names(delivered).slice(-2)).toEqual([
      'content.text-delta:bc',
      'runtime.error',
    ]);
    expect(projection.pendingThreadCount()).toBe(1);
    projection.flushAll();
    expect(names(delivered).at(-1)).toBe('content.text-delta:other');
  });

  test('authority loss cancels the transient flush and drops only the matching API origin', async () => {
    const delivered: OrchestrationEvent[] = [];
    const projection = new SemanticDeliveryBuffer(
      (next) => delivered.push(next),
      () => true,
    );
    projection.offer(
      event('content.text-delta', { itemId: 'a', delta: 'lost' }),
      'origin-a',
    );
    projection.offer(
      event('content.text-delta', {
        threadId: 'thread-2',
        itemId: 'b',
        delta: 'kept',
      }),
      'origin-b',
    );
    projection.interruptApiBase('origin-a', false);
    projection.interruptApiBase('origin-a', true);
    await Promise.resolve();
    projection.flushAll();
    expect(names(delivered)).toEqual(['content.text-delta:kept']);
  });
});

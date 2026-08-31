import { describe, expect, test } from 'vitest';
import type {
  CanonicalRuntimeEvent,
  ExtensionEvent,
  PlanEntry,
  PlanUpdatedEvent,
} from '../runtime-events.js';

const BASE = {
  eventId: 'evt-1',
  provider: 'acp' as const, // use whatever EngineId literal is valid — confirm against packages/contracts/src/provider.ts; 'acp' expected to already be a member given ADR-0008's `acp` provider adapter
  threadId: 'thread-1',
  createdAt: '2026-07-03T00:00:00.000Z',
};

describe('runtime-events contract: plan update + extension (#147, AC1)', () => {
  test('AC1: constructs a PlanUpdatedEvent and narrows it via the union discriminant', () => {
    const entries: PlanEntry[] = [
      { content: 'Draft the plan', status: 'completed' },
      { content: 'Execute the plan', status: 'in_progress' },
      { content: 'Verify the result', status: 'pending' },
    ];
    const event: CanonicalRuntimeEvent = {
      ...BASE,
      method: 'plan.updated',
      entries,
    };

    expect(event.method).toBe('plan.updated');
    if (event.method === 'plan.updated') {
      // Narrowed: TS now knows `event` is PlanUpdatedEvent — `entries` is accessible.
      const narrowed: PlanUpdatedEvent = event;
      expect(narrowed.entries).toHaveLength(3);
      expect(narrowed.entries.map((e) => e.status)).toEqual([
        'completed',
        'in_progress',
        'pending',
      ]);
    } else {
      throw new Error('expected plan.updated to narrow');
    }
  });

  test('AC1: constructs an ExtensionEvent and narrows it via the union discriminant', () => {
    const event: CanonicalRuntimeEvent = {
      ...BASE,
      method: 'extension.notification',
      namespace: '_kiro.dev',
      type: 'mcp/server_initialized',
      payload: { serverName: 'example-mcp' },
    };

    expect(event.method).toBe('extension.notification');
    if (event.method === 'extension.notification') {
      const narrowed: ExtensionEvent = event;
      expect(narrowed.namespace).toBe('_kiro.dev');
      expect(narrowed.type).toBe('mcp/server_initialized');
      expect(narrowed.payload).toEqual({ serverName: 'example-mcp' });
    } else {
      throw new Error('expected extension.notification to narrow');
    }
  });

  test('PlanEntry status is restricted to the three canonical states', () => {
    const statuses: PlanEntry['status'][] = [
      'pending',
      'in_progress',
      'completed',
    ];
    expect(statuses).toHaveLength(3);
    // @ts-expect-error — not a valid PlanEntry status
    const invalid: PlanEntry['status'] = 'done';
    void invalid;
  });
});

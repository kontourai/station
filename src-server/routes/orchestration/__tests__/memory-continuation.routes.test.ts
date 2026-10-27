import { Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import type { MemoryContinuationOutcome } from '../../../services/orchestration/memory-exhaustion-continuation.js';
import { createOrchestrationRoutes } from '../orchestration.js';

/** The memory-continuation route's mapping of each coordinator outcome. */
function app(outcome: MemoryContinuationOutcome) {
  return new Hono().route(
    '/api/orchestration',
    createOrchestrationRoutes(
      { hasReadableSession: async () => true } as never,
      {
        eventBus: new EventBus(),
        logger: { debug: vi.fn(), warn: vi.fn() },
        getUserId: () => 'person-1',
        memoryContinuation: { continueOnRequest: () => outcome },
      } as never,
    ),
  );
}

const post = (outcome: MemoryContinuationOutcome) =>
  app(outcome).request(
    '/api/orchestration/conversations/c-1/memory-continuation',
    { method: 'POST' },
  );

describe('POST /conversations/:id/memory-continuation outcome mapping', () => {
  test.each([
    [
      { kind: 'queued', conversationId: 'c-1', clientTurnId: 'k' },
      202,
      undefined,
    ],
    [
      { kind: 'skipped', reason: 'already-claimed' },
      409,
      'memory_continuation_already_started',
    ],
    [
      { kind: 'failed', reason: 'conflict' },
      409,
      'memory_continuation_already_started',
    ],
    [
      { kind: 'skipped', reason: 'withdrawn' },
      409,
      'memory_continuation_retries_exhausted',
    ],
    [
      { kind: 'skipped', reason: 'not-memory-exhausted' },
      409,
      'memory_continuation_not_applicable',
    ],
    [
      { kind: 'failed', reason: 'not-permitted' },
      403,
      'memory_continuation_not_permitted',
    ],
  ] as const)('%o answers %i %s', async (outcome, status, code) => {
    const response = await post(outcome as MemoryContinuationOutcome);
    expect(response.status).toBe(status);
    const body = (await response.json()) as { code?: string; error?: string };
    expect(body.code).toBe(code);
    if (code === 'memory_continuation_retries_exhausted')
      expect(body.error).not.toMatch(/did not end because/);
  });
});

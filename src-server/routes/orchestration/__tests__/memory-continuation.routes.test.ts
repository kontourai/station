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

test('authorized conversation window carries the coordinator decision', async () => {
  const eligibility = vi.fn(() => ({ eligible: true, turnId: 'turn-1' }));
  const route = new Hono().route(
    '/api/orchestration',
    createOrchestrationRoutes(
      {
        readConversationEventWindow: async () => ({
          conversationId: 'c-1',
          currentSessionId: 's-1',
          events: [],
          hasMore: false,
          watermark: 1,
          handoffs: [],
          contextBoundaries: [],
        }),
      } as never,
      {
        eventBus: new EventBus(),
        logger: { debug: vi.fn(), warn: vi.fn() },
        getUserId: () => 'person-1',
        memoryContinuation: { continuationEligibility: eligibility },
        threadInbox: { mayContinue: () => true },
        mayRequestMemoryContinuation: () => true,
      } as never,
    ),
  );
  const response = await route.request(
    '/api/orchestration/conversations/c-1/event-window',
  );
  expect(response.status).toBe(200);
  expect((await response.json()).data.memoryContinuation).toEqual({
    eligible: true,
    turnId: 'turn-1',
  });
  expect(eligibility).toHaveBeenCalledWith('c-1');
});

test('reader without send authority is not eligible to continue', async () => {
  const mayContinue = vi.fn(() => false);
  const route = new Hono().route(
    '/api/orchestration',
    createOrchestrationRoutes(
      {
        readConversationEventWindow: async () => ({
          conversationId: 'c-1',
          events: [],
        }),
      } as never,
      {
        eventBus: new EventBus(),
        logger: { debug: vi.fn(), warn: vi.fn() },
        getUserId: () => 'reader',
        memoryContinuation: {
          continuationEligibility: () => ({ eligible: true, turnId: 'turn-1' }),
        },
        threadInbox: { mayContinue },
        mayRequestMemoryContinuation: () => true,
      } as never,
    ),
  );
  const response = await route.request(
    '/api/orchestration/conversations/c-1/event-window',
  );
  expect(response.status).toBe(200);
  expect((await response.json()).data.memoryContinuation.eligible).toBe(false);
  expect(mayContinue).toHaveBeenCalledWith('c-1', 'reader');
});

test('read-only credential cannot be offered continuation through the HTTP scope boundary', async () => {
  const { configureRuntimeHttp } = await import(
    '../../../runtime/bootstrap/runtime-http.js'
  );
  const { runtimeRequestPrincipalMayAccessHttpRoute } = await import(
    '../../../security/runtime-request-security.js'
  );
  const { pairingScopePresetString } = await import(
    '@kontourai/station-contracts'
  );
  const security = {
    authorizeCredential: () => true,
    resolveGrantedScope: () => pairingScopePresetString('read-only'),
  };
  const route = new Hono();
  configureRuntimeHttp({
    app: route as never,
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
      trace() {},
      fatal() {},
      child() {
        return this;
      },
      setLevel() {},
      getLevel() {
        return 'info';
      },
    } as never,
    eventBus: { emit() {} } as never,
    security: {
      verifyCredential: () => true,
      resolveGrantedScope: security.resolveGrantedScope,
      allowedOrigins: [],
    },
  });
  route.route(
    '/api/orchestration',
    createOrchestrationRoutes(
      {
        readConversationEventWindow: async () => ({
          conversationId: 'c-1',
          events: [],
        }),
        hasReadableSession: async () => true,
      } as never,
      {
        eventBus: new EventBus(),
        logger: { debug: vi.fn(), warn: vi.fn() },
        getUserId: () => 'person-1',
        memoryContinuation: {
          continuationEligibility: () => ({ eligible: true, turnId: 'turn-1' }),
        },
        threadInbox: { mayContinue: () => true },
        mayRequestMemoryContinuation: (request: Request, id: string) =>
          runtimeRequestPrincipalMayAccessHttpRoute(request, security, {
            method: 'POST',
            path: `/api/orchestration/conversations/${encodeURIComponent(id)}/memory-continuation`,
          }),
      } as never,
    ),
  );
  const headers = { Authorization: 'Bearer read-only-credential' };
  const env = { incoming: { socket: { remoteAddress: '100.96.12.7' } } };
  const get = await route.request(
    '/api/orchestration/conversations/c-1/event-window',
    { headers },
    env,
  );
  expect(get.status).toBe(200);
  const post = await route.request(
    '/api/orchestration/conversations/c-1/memory-continuation',
    { method: 'POST', headers },
    env,
  );
  expect(post.status).toBe(403);
  expect(await post.json()).toEqual({ error: { code: 'insufficient_scope' } });
  expect((await get.json()).data.memoryContinuation.eligible).toBe(false);
});

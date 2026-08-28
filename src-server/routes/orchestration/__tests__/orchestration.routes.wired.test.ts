/**
 * Wired-real-function regression test (archive#977, AC12). Closes the
 * pull-work record's recorded risk that only hand-rolled `vi.fn()` mocks ever
 * exercised the delegation route layer, never the real
 * `station-control-delegation.ts` implementations.
 *
 * Every one of the eight delegation functions
 * (`delegateTask`, `discoverDelegationOptions`, `continueDelegatedTask`,
 * `respondToDelegatedTaskRequest`, `interruptDelegatedTask`,
 * `listDelegatedTasks`, `observeDelegatedTask`, `observeDelegatedTaskEvents`)
 * is imported here as the REAL implementation — no `vi.fn()` stands in for
 * any of them — and wired into `createOrchestrationRoutes` exactly as
 * `src-server/runtime/routes/runtime-routes.ts` does in production. Only the
 * network boundary (`fetch`) is stubbed, so each call still runs through the
 * real function's own validation, binding assertions, and error messages.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readJson } from '../../../__test-utils__/read-json.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import {
  continueDelegatedTask,
  delegateTask,
  discoverDelegationOptions,
  interruptDelegatedTask,
  listDelegatedTasks,
  observeDelegatedTask,
  observeDelegatedTaskEvents,
  respondToDelegatedTaskRequest,
} from '../../../tools/station-control-delegation.js';
import { createOrchestrationRoutes } from '../orchestration.js';

function buildApp() {
  return createOrchestrationRoutes({} as any, {
    eventBus: new EventBus(),
    logger: { debug: vi.fn() },
    getUserId: () => 'brian',
    delegateTask,
    discoverDelegationOptions,
    continueDelegatedTask,
    respondToDelegatedTaskRequest,
    interruptDelegatedTask,
    listDelegatedTasks,
    observeDelegatedTask,
    observeDelegatedTaskEvents,
  });
}

/**
 * A minimal fake Station backend for the real functions' own outbound
 * `fetch` calls. Every branch here mirrors a real server response shape just
 * enough to reach a distinctive, real-function-only error or success value —
 * proving the route -> service -> transport chain is genuinely wired, not
 * just type-compatible.
 */
function stubStationBackend(): void {
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });

    if (url.pathname === '/.well-known/station/v1') {
      return json(200, { environmentId: 'env-current' });
    }
    if (url.pathname === '/api/connections/codex-runtime') {
      // No `error` field on purpose: readConnection() must fall back to its
      // own distinctive unavailableMessage, not a body-supplied string.
      return json(404, { success: false });
    }
    if (
      method === 'POST' &&
      url.pathname === '/api/orchestration/delegations'
    ) {
      return json(400, {
        success: false,
        error: "Agent 'codex' is unavailable",
      });
    }
    if (
      method === 'POST' &&
      url.pathname === '/api/orchestration/delegations/unbound-task/continue'
    ) {
      return json(400, {
        success: false,
        error: 'Delegated task not found',
      });
    }
    if (
      method === 'GET' &&
      url.pathname === '/api/orchestration/delegations/unbound-task'
    ) {
      // archive#3963: the 'current' environment reads its own delegation
      // read path over its canonical HTTP API (this is how `get_task`/
      // `get_task_events` call it — see station-control-operations-tools.ts
      // — since a tool invocation has no live `orchestrationService`
      // reference). The self-served response for a taskId nothing binds to
      // is this exact envelope, so this mirrors what the real loop-back
      // call actually returns rather than leaving it unhandled.
      return json(400, {
        success: false,
        error: 'Delegated task not found',
      });
    }
    if (
      method === 'GET' &&
      url.pathname === '/api/orchestration/delegations/unbound-task/events'
    ) {
      return json(400, {
        success: false,
        error: 'Delegated task not found',
      });
    }
    if (
      method === 'GET' &&
      url.pathname ===
        '/api/orchestration/delegations/foreign-bound-task/events'
    ) {
      // This models the JSON envelope the real loop-back call carries when
      // the SAME server's own binding check fires for this taskId — it does
      // NOT exercise that derivation here. `loadDelegatedTask`'s own
      // not-found-vs-binding-mismatch check is unit-tested directly in
      // station-control-delegation.test.ts ("still rejects a
      // production-shaped task bound to another environment", archive#2843).
      // What THIS fixture proves is narrower: `getCanonical` preserves a
      // backend-supplied message across the canonical HTTP branch, and that
      // message stays distinct from the sibling not-found case above rather
      // than collapsing into one generic sentence.
      return json(400, {
        success: false,
        error:
          'The requested task does not match a delegated-task binding in the selected environment',
      });
    }
    if (
      method === 'GET' &&
      /^\/api\/orchestration\/sessions\/[^/]+$/.test(url.pathname)
    ) {
      return json(404, { success: false, error: 'Session not found' });
    }
    if (url.pathname.endsWith('/event-page')) {
      return json(200, {
        success: true,
        data: {
          session: { threadId: 'unbound-task', eventCount: 0 },
          events: [],
          hasMore: false,
          nextSequence: 0,
        },
      });
    }
    if (url.pathname === '/api/orchestration/sessions/read-model') {
      return json(200, { success: false, error: 'boom' });
    }
    if (url.pathname === '/api/connections/agents') {
      return json(200, { success: true, data: [] });
    }
    if (url.pathname === '/api/agents') {
      return json(200, { success: true, data: [] });
    }
    throw new Error(`Unhandled fetch in wired regression test: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
}

describe('Orchestration routes wired to the real delegation service (#977 AC12)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('POST /delegations reaches the real canonical delegation transport', async () => {
    stubStationBackend();
    const app = buildApp();

    const res = await app.request('/delegations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Ship it',
        target: {
          environment: { kind: 'current' },
          agent: 'codex',
        },
      }),
    });

    expect(res.status).toBe(400);
    expect(await readJson(res)).toMatchObject({
      success: false,
      error: "Agent 'codex' is unavailable",
    });
  });

  test('POST /delegations/options reaches the real discoverDelegationOptions end to end', async () => {
    stubStationBackend();
    const app = buildApp();

    const res = await app.request('/delegations/options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    expect(await readJson(res)).toMatchObject({
      success: true,
      data: {
        environment: { id: 'env-current', kind: 'current' },
        targets: [],
      },
    });
  });

  test('GET /delegations/:taskId reaches the real observeDelegatedTask not-found error', async () => {
    stubStationBackend();
    const app = buildApp();

    const res = await app.request('/delegations/unbound-task');

    expect(res.status).toBe(400);
    expect(await readJson(res)).toMatchObject({
      success: false,
      error: 'Delegated task not found',
    });
  });

  test('GET /delegations/:taskId/events reaches the real observeDelegatedTaskEvents not-found error', async () => {
    stubStationBackend();
    const app = buildApp();

    const res = await app.request('/delegations/unbound-task/events');

    expect(res.status).toBe(400);
    expect(await readJson(res)).toMatchObject({
      success: false,
      error: 'Delegated task not found',
    });
  });

  test('GET /delegations/:taskId/events propagates a backend-supplied binding-mismatch message through the canonical HTTP path, distinct from not-found', async () => {
    stubStationBackend();
    const app = buildApp();

    const res = await app.request('/delegations/foreign-bound-task/events');

    expect(res.status).toBe(400);
    expect(await readJson(res)).toMatchObject({
      success: false,
      error:
        'The requested task does not match a delegated-task binding in the selected environment',
    });
  });

  test('POST /delegations/:taskId/continue reaches the real continueDelegatedTask via loadDelegatedTask', async () => {
    stubStationBackend();
    const app = buildApp();

    const res = await app.request('/delegations/unbound-task/continue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Keep going' }),
    });

    expect(res.status).toBe(400);
    expect(await readJson(res)).toMatchObject({
      success: false,
      error: 'Delegated task not found',
    });
  });

  test('POST /delegations/:taskId/respond preserves the generic cross-Station action error', async () => {
    stubStationBackend();
    const app = buildApp();

    const res = await app.request('/delegations/unbound-task/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: 'req-1', decision: 'accept' }),
    });

    expect(res.status).toBe(400);
    expect(await readJson(res)).toMatchObject({
      success: false,
      error:
        'The selected Station could not resolve the delegated task request',
    });
  });

  test('POST /delegations/:taskId/interrupt preserves the generic cross-Station action error', async () => {
    stubStationBackend();
    const app = buildApp();

    const res = await app.request('/delegations/unbound-task/interrupt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    expect(await readJson(res)).toMatchObject({
      success: false,
      error: 'The selected Station could not interrupt the delegated task',
    });
  });

  test('GET /delegations reaches the real listDelegatedTasks and its inventory-unavailable error', async () => {
    stubStationBackend();
    const app = buildApp();

    const res = await app.request('/delegations');

    expect(res.status).toBe(400);
    expect(await readJson(res)).toMatchObject({
      success: false,
      error: 'Delegated task inventory is unavailable on the selected Station',
    });
  });
});

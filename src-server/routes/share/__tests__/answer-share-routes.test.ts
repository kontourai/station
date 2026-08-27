import type { AnswerShareViewResult } from '@kontourai/station-contracts/answer-share';
import {
  parseHostedTenantRegistry,
  sessionReadAuthorityFromRequest,
  tenantId,
} from '@kontourai/station-contracts/tenancy';
import { describe, expect, it, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import type { AnswerShareService } from '../../../services/share/answer-share-service.js';
import {
  createAnswerShareRoutes,
  createAnswerShareViewBudget,
  handleAnswerShareView,
} from '../answer-share-routes.js';

/**
 * Route-level concerns only: envelope shape, status mapping, and the
 * indistinguishability of every refusal a caller without a token can reach.
 *
 * The state ladder itself is proven in
 * `services/share/__tests__/answer-share-service.test.ts`, and the
 * `access:manage` gate on `/api/shares` is proven in
 * `security/__tests__/pairing-route-scopes.test.ts` — deliberately not
 * re-derived here, because a handler that re-checks its own scope is how the
 * table and the route drift apart.
 */

const SUMMARY = {
  id: 'share-1',
  sessionId: 'thread-1',
  turnId: 'turn-1',
  createdAt: '2026-08-01T00:00:00.000Z',
  expiresAt: '2026-08-08T00:00:00.000Z',
  state: 'active' as const,
};

function mockService(overrides: Partial<AnswerShareService> = {}) {
  return {
    list: vi.fn(() => [SUMMARY]),
    mint: vi.fn(async () => ({ share: SUMMARY, token: 'the-token' })),
    revoke: vi.fn(async () => ({ ...SUMMARY, state: 'revoked' as const })),
    view: vi.fn(),
    ...overrides,
  } as unknown as AnswerShareService;
}

function post(app: ReturnType<typeof createAnswerShareRoutes>, body: unknown) {
  return app.request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('createAnswerShareRoutes', () => {
  it('lists the operator shares in the standard envelope', async () => {
    const response = await createAnswerShareRoutes(mockService()).request('/');
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ success: true, data: [SUMMARY] });
  });

  it('requires hosted request authority before share list or revoke reaches the service', async () => {
    const registry = parseHostedTenantRegistry({
      schemaVersion: 1,
      tenants: [{ id: 'alpha', authority: 'alpha.station.test' }],
    });
    const list = vi.fn(() => [SUMMARY]);
    const revoke = vi.fn(async () => ({
      ...SUMMARY,
      state: 'revoked' as const,
    }));
    const app = createAnswerShareRoutes(mockService({ list, revoke }), {
      readAuthorityForRequest: (request) =>
        sessionReadAuthorityFromRequest(
          'shared-user',
          request.headers.get('x-test-tenant') === 'alpha'
            ? { tenantId: tenantId('alpha') }
            : undefined,
          registry,
        ),
    });

    const alphaList = await app.request('/', {
      headers: { 'x-test-tenant': 'alpha' },
    });
    const missingList = await app.request('/');
    const alphaRevoke = await app.request('/share-1', {
      method: 'DELETE',
      headers: { 'x-test-tenant': 'alpha' },
    });
    const missingRevoke = await app.request('/share-1', { method: 'DELETE' });

    expect(alphaList.status).toBe(200);
    expect(missingList.status).toBe(200);
    expect(await json(missingList)).toEqual({ success: true, data: [] });
    expect(alphaRevoke.status).toBe(200);
    expect(missingRevoke.status).toBe(404);
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'hosted',
        tenantExecutionContext: { tenantId: 'alpha', source: 'request' },
      }),
    );
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith(
      'share-1',
      expect.objectContaining({
        mode: 'hosted',
        tenantExecutionContext: { tenantId: 'alpha', source: 'request' },
      }),
    );
  });

  it('mints and returns the one-time token', async () => {
    const response = await post(createAnswerShareRoutes(mockService()), {
      sessionId: 'thread-1',
      turnId: 'turn-1',
    });
    expect(response.status).toBe(201);
    expect((await json(response)).data.token).toBe('the-token');
  });

  it('mints with the request authority rather than a route singleton identity', async () => {
    const authority = sessionReadAuthorityFromRequest(
      'alpha',
      undefined,
      undefined,
    );
    const mint = vi.fn(async () => ({ share: SUMMARY, token: 'the-token' }));
    const app = createAnswerShareRoutes(
      mockService({ mint } as Partial<AnswerShareService>),
      { readAuthorityForRequest: () => authority },
    );

    await post(app, { sessionId: 'alpha-session', turnId: 'turn-1' });

    expect(mint).toHaveBeenCalledWith(
      expect.objectContaining({ ownerUserId: 'alpha' }),
      authority,
    );
  });

  it('returns no permalink and no server-derived origin (H-2)', async () => {
    const service = mockService();
    const response = await post(createAnswerShareRoutes(service), {
      sessionId: 'thread-1',
      turnId: 'turn-1',
    });

    const body = await json(response);
    expect(body.data.permalink).toBeUndefined();
    // The Host header the request arrived on must not reach the response in
    // any form: behind the UI proxy it names the backend, and a link built
    // from it cannot serve the share page.
    expect(JSON.stringify(body)).not.toContain('http');
    // And the service is never handed one to compose from.
    expect(service.mint).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'thread-1', turnId: 'turn-1' }),
    );
    expect(
      (service.mint as unknown as { mock: { calls: unknown[][] } }).mock
        .calls[0],
    ).toHaveLength(1);
  });

  it.each([
    ['a missing turnId', { sessionId: 'thread-1' }],
    ['a missing sessionId', { turnId: 'turn-1' }],
    ['a non-string turnId', { sessionId: 'thread-1', turnId: 7 }],
    [
      'a lifetime past the declared ceiling',
      { sessionId: 't', turnId: 'x', ttlMs: 400 * 24 * 60 * 60 * 1000 },
    ],
    ['a negative lifetime', { sessionId: 't', turnId: 'x', ttlMs: -1 }],
  ])('refuses to mint from %s', async (_label, body) => {
    const service = mockService();
    const response = await post(createAnswerShareRoutes(service), body);
    expect(response.status).toBe(400);
    expect(service.mint).not.toHaveBeenCalled();
  });

  it('404s a mint for a turn with no answer, and names why', async () => {
    const service = mockService({
      mint: vi.fn(async () => ({ error: 'answer-not-found' as const })),
    } as Partial<AnswerShareService>);
    const response = await post(createAnswerShareRoutes(service), {
      sessionId: 'thread-1',
      turnId: 'gone',
    });
    expect(response.status).toBe(404);
    expect((await json(response)).error).toContain('nothing to share');
  });

  it('404s a revoke of an id it does not hold', async () => {
    const { AnswerShareStoreError } = await import(
      '../../../services/share/answer-share-store.js'
    );
    const service = mockService({
      revoke: vi.fn(() => {
        throw new AnswerShareStoreError('share_not_found', 'Share not found');
      }),
    } as Partial<AnswerShareService>);
    const response = await createAnswerShareRoutes(service).request(
      '/share-nope',
      { method: 'DELETE' },
    );
    expect(response.status).toBe(404);
  });

  it('429s a mint that would exceed the store ceiling', async () => {
    const { AnswerShareStoreError } = await import(
      '../../../services/share/answer-share-store.js'
    );
    const service = mockService({
      mint: vi.fn(() => {
        throw new AnswerShareStoreError('capacity_reached', 'Too many shares');
      }),
    } as Partial<AnswerShareService>);
    const response = await post(createAnswerShareRoutes(service), {
      sessionId: 'thread-1',
      turnId: 'turn-1',
    });
    expect(response.status).toBe(429);
  });
});

function viewRequest(body: string, url = 'http://station.test/x'): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

const readBoundedBody = async (request: Request) => ({
  status: 'ok' as const,
  body: await request.text(),
});

/** A budget that never refuses — the default for tests about other concerns. */
function openBudget() {
  return {
    consumeForToken: vi.fn((_tokenKey: string) => true),
    reserveUnknownToken: vi.fn(() => true),
    refundUnknownToken: vi.fn(() => undefined),
  };
}

describe('handleAnswerShareView', () => {
  it('maps each refusal to its declared status', async () => {
    const cases: Array<[string, number]> = [
      ['share-not-found', 404],
      ['share-revoked', 403],
      ['share-expired', 410],
      ['answer-no-longer-available', 404],
    ];
    for (const [reason, status] of cases) {
      const outcome = await handleAnswerShareView({
        request: viewRequest(JSON.stringify({ token: 'x'.repeat(43) })),
        service: mockService({
          view: vi.fn(
            () => ({ state: 'refused', reason }) as AnswerShareViewResult,
          ),
        } as Partial<AnswerShareService>),
        budget: openBudget(),
        readBoundedBody,
      });
      // Carry the case into the assertion so a failure names it.
      expect([reason, outcome.kind === 'result' && outcome.status]).toEqual([
        reason,
        status,
      ]);
    }
  });

  it.each([
    ['a body that is not JSON', 'not json'],
    ['a JSON body with no token', '{}'],
    ['a JSON body whose token is not a string', '{"token":42}'],
    ['an empty body', ''],
    ['a JSON array', '[]'],
  ])(
    'answers %s with the SAME bytes and status as an unknown token',
    async (_label, body) => {
      const service = mockService();
      const outcome = await handleAnswerShareView({
        request: viewRequest(body),
        service,
        budget: openBudget(),
        readBoundedBody,
      });
      // The enumeration guard at the HTTP boundary: a prober must not learn
      // that their guess was at least well-formed.
      expect(outcome).toEqual({
        kind: 'result',
        result: { state: 'refused', reason: 'share-not-found' },
        status: 404,
      });
      expect(service.view).not.toHaveBeenCalled();
    },
  );

  it('answers an over-sized body identically, without parsing it', async () => {
    const outcome = await handleAnswerShareView({
      request: viewRequest('{"token":"x"}'),
      service: mockService(),
      budget: openBudget(),
      readBoundedBody: async () => ({ status: 'too-large' as const }),
    });
    expect(outcome).toEqual({
      kind: 'result',
      result: { state: 'refused', reason: 'share-not-found' },
      status: 404,
    });
  });

  it('refuses a query string outright, charging only the unknown-token budget', async () => {
    const budget = openBudget();
    const outcome = await handleAnswerShareView({
      request: viewRequest('{}', 'http://station.test/x?token=leaked'),
      service: mockService(),
      budget,
      readBoundedBody,
    });
    expect(outcome).toEqual({
      kind: 'result',
      result: { state: 'refused', reason: 'share-not-found' },
      status: 404,
    });
    expect(budget.consumeForToken).not.toHaveBeenCalled();
  });

  it('reports a spent per-token budget without touching the store', async () => {
    const service = mockService();
    const outcome = await handleAnswerShareView({
      request: viewRequest(JSON.stringify({ token: 'x'.repeat(43) })),
      service,
      budget: { ...openBudget(), consumeForToken: () => false },
      readBoundedBody,
    });
    expect(outcome).toEqual({ kind: 'rate-limited' });
    expect(service.view).not.toHaveBeenCalled();
  });

  it('keys the per-token budget on a DIGEST, never the token itself', async () => {
    const budget = openBudget();
    const token = 'x'.repeat(43);
    await handleAnswerShareView({
      request: viewRequest(JSON.stringify({ token })),
      service: mockService({
        view: vi.fn(
          () =>
            ({
              state: 'refused',
              reason: 'share-revoked',
            }) as AnswerShareViewResult,
        ),
      } as Partial<AnswerShareService>),
      budget,
      readBoundedBody,
    });
    // The map outlives the request by minutes; a raw capability has no
    // business sitting in it.
    const key = budget.consumeForToken.mock.calls[0]?.[0];
    expect(key).not.toBe(token);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses past the global budget WITHOUT touching the store (N-1)', async () => {
    // The work bound. Charging the global budget after the lookup left every
    // guess paying a full existsSync+lstat+readFile+parse+validate — ~0.59ms
    // of synchronous event-loop time each at the record ceiling — so the
    // limiter bounded responses while the runtime still saturated.
    const service = mockService();
    const outcome = await handleAnswerShareView({
      request: viewRequest(JSON.stringify({ token: 'x'.repeat(43) })),
      service,
      budget: { ...openBudget(), reserveUnknownToken: () => false },
      readBoundedBody,
    });

    expect(outcome).toEqual({ kind: 'rate-limited' });
    expect(service.view).not.toHaveBeenCalled();
  });

  it('reserves the global slot BEFORE the lookup, not after', async () => {
    const budget = openBudget();
    const order: string[] = [];
    budget.reserveUnknownToken.mockImplementation(() => {
      order.push('reserve');
      return true;
    });
    await handleAnswerShareView({
      request: viewRequest(JSON.stringify({ token: 'x'.repeat(43) })),
      service: mockService({
        view: vi.fn(() => {
          order.push('lookup');
          return {
            state: 'refused',
            reason: 'share-not-found',
          } as AnswerShareViewResult;
        }),
      } as Partial<AnswerShareService>),
      budget,
      readBoundedBody,
    });
    expect(order).toEqual(['reserve', 'lookup']);
  });

  it('never reaches the store for a request carrying no token at all', async () => {
    const service = mockService();
    await handleAnswerShareView({
      request: viewRequest('not json'),
      service,
      budget: openBudget(),
      readBoundedBody,
    });
    expect(service.view).not.toHaveBeenCalled();
  });

  it('does NOT charge the global budget for a token that resolves (M-1)', async () => {
    const budget = openBudget();
    await handleAnswerShareView({
      request: viewRequest(JSON.stringify({ token: 'x'.repeat(43) })),
      service: mockService({
        view: vi.fn(
          () =>
            ({
              state: 'refused',
              reason: 'share-expired',
            }) as AnswerShareViewResult,
        ),
      } as Partial<AnswerShareService>),
      budget,
      readBoundedBody,
    });
    expect(budget.refundUnknownToken).toHaveBeenCalledTimes(1);
  });

  it('charges the global budget for a token that does not resolve', async () => {
    const budget = openBudget();
    await handleAnswerShareView({
      request: viewRequest(JSON.stringify({ token: 'x'.repeat(43) })),
      service: mockService({
        view: vi.fn(
          () =>
            ({
              state: 'refused',
              reason: 'share-not-found',
            }) as AnswerShareViewResult,
        ),
      } as Partial<AnswerShareService>),
      budget,
      readBoundedBody,
    });
    expect(budget.refundUnknownToken).not.toHaveBeenCalled();
  });

  it('serves a resolvable share at 200', async () => {
    const outcome = await handleAnswerShareView({
      request: viewRequest(JSON.stringify({ token: 'x'.repeat(43) })),
      service: mockService({
        view: vi.fn(
          () =>
            ({
              state: 'ok',
              schemaVersion: 1,
              share: {
                id: 'share-1',
                createdAt: SUMMARY.createdAt,
                expiresAt: SUMMARY.expiresAt,
              },
              answer: {
                sessionId: 'thread-1',
                turnId: 'turn-1',
                blocks: [{ type: 'text', text: 'Hello.' }],
                omittedBlocks: 0,
              },
            }) as AnswerShareViewResult,
        ),
      } as Partial<AnswerShareService>),
      budget: openBudget(),
      readBoundedBody,
    });
    expect(outcome.kind === 'result' && outcome.status).toBe(200);
  });
});

describe('createAnswerShareViewBudget (station#1423 M-1)', () => {
  it('bounds guessing globally, because a brute-forcer never repeats a token', () => {
    const budget = createAnswerShareViewBudget({
      unknownTokenLimit: 3,
      now: () => 1_000,
    });
    expect([1, 2, 3].map(() => budget.reserveUnknownToken())).toEqual([
      true,
      true,
      true,
    ]);
    expect(budget.reserveUnknownToken()).toBe(false);
  });

  it('bounds one viewer hammering their own link, per token', () => {
    const budget = createAnswerShareViewBudget({
      perTokenLimit: 2,
      now: () => 1_000,
    });
    expect(budget.consumeForToken('a')).toBe(true);
    expect(budget.consumeForToken('a')).toBe(true);
    expect(budget.consumeForToken('a')).toBe(false);
    // A different share is untouched by the first one's spending.
    expect(budget.consumeForToken('b')).toBe(true);
  });

  it('lets a real holder through after an attacker has burned the guess budget', () => {
    // THE starvation property M-1 named. With one shared bucket, the loop
    // below locked every legitimate viewer out for the whole window.
    const budget = createAnswerShareViewBudget({
      unknownTokenLimit: 2,
      perTokenLimit: 5,
      now: () => 1_000,
    });
    while (budget.reserveUnknownToken()) {
      /* attacker spends the global budget */
    }
    expect(budget.reserveUnknownToken()).toBe(false);
    expect(budget.consumeForToken('a-real-share-digest')).toBe(true);
  });

  it('returns a refunded reservation to the window, so holders cost nothing', () => {
    const budget = createAnswerShareViewBudget({
      unknownTokenLimit: 1,
      now: () => 1_000,
    });
    // A holder reserves and is refunded; the guessing budget must be intact.
    expect(budget.reserveUnknownToken()).toBe(true);
    budget.refundUnknownToken();
    expect(budget.reserveUnknownToken()).toBe(true);
  });

  it('cannot be made to mint budget by refunding what was never reserved', () => {
    const budget = createAnswerShareViewBudget({
      unknownTokenLimit: 1,
      now: () => 1_000,
    });
    budget.refundUnknownToken();
    budget.refundUnknownToken();
    expect(budget.reserveUnknownToken()).toBe(true);
    expect(budget.reserveUnknownToken()).toBe(false);
  });

  it('drops a refund whose window has already rolled over', () => {
    let clock = 1_000;
    const budget = createAnswerShareViewBudget({
      unknownTokenLimit: 1,
      windowMs: 500,
      now: () => clock,
    });
    expect(budget.reserveUnknownToken()).toBe(true);
    clock += 501;
    // The reservation belonged to a window that no longer exists; returning
    // it must not credit the new one.
    budget.refundUnknownToken();
    expect(budget.reserveUnknownToken()).toBe(true);
    expect(budget.reserveUnknownToken()).toBe(false);
  });

  it('reopens the window once it elapses', () => {
    let clock = 1_000;
    const budget = createAnswerShareViewBudget({
      unknownTokenLimit: 1,
      windowMs: 500,
      now: () => clock,
    });
    expect(budget.reserveUnknownToken()).toBe(true);
    expect(budget.reserveUnknownToken()).toBe(false);
    clock += 501;
    expect(budget.reserveUnknownToken()).toBe(true);
  });

  it('bounds its own key map so guessing cannot grow it without limit', () => {
    const budget = createAnswerShareViewBudget({
      maxTrackedTokens: 2,
      perTokenLimit: 1,
      now: () => 1_000,
    });
    expect(budget.consumeForToken('a')).toBe(true);
    expect(budget.consumeForToken('b')).toBe(true);
    expect(budget.consumeForToken('c')).toBe(true);
    // 'a' was evicted to make room, so it starts a fresh window rather than
    // the map growing forever. Bounded memory is the property; perfect
    // fairness across more than `maxTrackedTokens` live shares is not.
    expect(budget.consumeForToken('a')).toBe(true);
  });
});

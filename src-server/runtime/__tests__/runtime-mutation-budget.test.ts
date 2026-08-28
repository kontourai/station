import { type HttpBindings } from '@hono/node-server';
import { DEFAULT_GRANT_PAIRING_SCOPE } from '@kontourai/station-contracts';
import { CHAT_ATTACHMENT_MAX_COMMAND_JSON_BYTES } from '@kontourai/station-contracts/chat-attachment';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  INTERACTIVE_WORKSPACE_TIMING_MODE,
  INTERACTIVE_WORKSPACE_TIMING_REQUEST_HEADER,
} from '../../../src-shared/interactive-workspace-performance-timing.js';
import type { EventBus } from '../../services/orchestration/event-bus.js';
import type { Logger } from '../../utils/logger.js';

// Partial mock: only the budget counter is observed. Spreading the real module
// keeps every other instrument `runtime-http.ts` imports intact — a blanket
// mock would silently stub `deviceSessionAuthorizations` and friends.
vi.mock('../../telemetry/metrics.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../telemetry/metrics.js')>()),
  requestBudgetOutcomes: { add: vi.fn() },
}));

import { requestBudgetOutcomes } from '../../telemetry/metrics.js';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_PROXY_CALLER_HEADER,
} from '../../utils/internal-api-token.js';
import { configureRuntimeHttp } from '../bootstrap/runtime-http.js';

const BEARER_CREDENTIAL = 'a'.repeat(43);
const BEARER_CREDENTIAL_2 = 'b'.repeat(43);
const COOKIE_CREDENTIAL = 'c'.repeat(43);
const ALLOWED_ORIGIN = 'https://station.example.test';

type TestBindings = HttpBindings & {
  incoming: HttpBindings['incoming'] & {
    socket: HttpBindings['incoming']['socket'] & { remoteAddress?: string };
  };
};

function createBudgetHarness(
  options: {
    now?: () => number;
    maxMutationsPerWindow?: number;
    maxStreamingPerWindow?: number;
    maxPerformanceDiagnosticPerWindow?: number;
    maxMutationBodyBytes?: number;
    maxStreamingBodyBytes?: number;
    mutationWindowMs?: number;
    /**
     * Extra mutation routes to register behind the boundary, each with a
     * side-effect counter so tests can prove a blocked request left no
     * persisted state.
     */
    extraMutationRoutes?: ReadonlyArray<{
      method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
      path: string;
    }>;
  } = {},
) {
  const logger: Logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
    setLevel: vi.fn(),
    getLevel: vi.fn(() => 'info' as const),
  };
  const app = new Hono<{ Bindings: TestBindings }>();
  const sideEffects = new Map<string, number>();

  configureRuntimeHttp({
    app: app as never,
    logger,
    eventBus: { emit: vi.fn() } as unknown as EventBus,
    security: {
      verifyCredential: (candidate: string) =>
        candidate === BEARER_CREDENTIAL ||
        candidate === BEARER_CREDENTIAL_2 ||
        candidate === COOKIE_CREDENTIAL,
      resolveGrantedScope: (candidate: string) =>
        candidate === BEARER_CREDENTIAL ||
        candidate === BEARER_CREDENTIAL_2 ||
        candidate === COOKIE_CREDENTIAL
          ? DEFAULT_GRANT_PAIRING_SCOPE
          : undefined,
      now: options.now ?? (() => Date.now()),
      maxMutationsPerWindow: options.maxMutationsPerWindow ?? 5,
      maxStreamingPerWindow: options.maxStreamingPerWindow ?? 3,
      maxPerformanceDiagnosticPerWindow:
        options.maxPerformanceDiagnosticPerWindow ?? 4,
      maxMutationBodyBytes: options.maxMutationBodyBytes ?? 100,
      maxStreamingBodyBytes: options.maxStreamingBodyBytes ?? 200,
      mutationWindowMs: options.mutationWindowMs ?? 60_000,
      allowedOrigins: [ALLOWED_ORIGIN],
    },
  } as Parameters<typeof configureRuntimeHttp>[0]);

  // Register mutation routes with side-effect tracking.
  const routes = options.extraMutationRoutes ?? [
    { method: 'POST' as const, path: '/api/projects' },
    { method: 'POST' as const, path: '/api/tasks' },
  ];
  for (const route of routes) {
    app.on(route.method, route.path, async (c) => {
      // Read the body to exercise the bounded-read path.
      await c.req.text();
      const key = `${route.method} ${route.path}`;
      sideEffects.set(key, (sideEffects.get(key) ?? 0) + 1);
      return c.json({ reached: true });
    });
  }
  // A streaming mutation route (classified as 'streaming' by the budget).
  app.post('/api/agents/:slug/chat', async (c) => {
    await c.req.text();
    const key = 'POST /api/agents/:slug/chat';
    sideEffects.set(key, (sideEffects.get(key) ?? 0) + 1);
    return c.json({ reached: true });
  });
  // A GET handler on the same path — GETs are never mutations.
  app.get('/api/projects', (c) => c.json({ reached: true }));
  // A public route.
  app.get('/api/system/liveness', (c) => c.json({ ok: true }));
  app.options('*', (c) => c.body(null, 204));

  async function request(
    path: string,
    init: RequestInit = {},
    peerAddress?: string,
    rawRequest?: Request,
  ): Promise<Response> {
    const socket = { remoteAddress: peerAddress };
    const incoming = { socket };
    return app.request(
      rawRequest ?? path,
      // Passing a truthy requestInit makes Hono reconstruct the input via
      // `new Request(input, init)`, which would defeat the lightweight-proxy
      // scenario under test — leave init undefined so Hono adopts the raw
      // request object as c.req.raw directly.
      rawRequest ? undefined : init,
      { incoming } as TestBindings,
    );
  }

  return { request, sideEffects };
}

/**
 * Reproduces the `@hono/node-server` adapter's "lightweight Request": an
 * object created via `Object.create` whose prototype chain ends at
 * `Request.prototype` (so `instanceof Request` is true and Hono adopts it as
 * `c.req.raw`) but which never ran the Request constructor — so it carries NO
 * `#state` private slot. When the runtime and the middleware resolve to
 * different module copies of the adapter, the middleware's `new Request(...)`
 * cannot recognize this object through the adapter's own unwrap symbol, and
 * undici's cross-construction reads the missing `#state` slot and throws
 * (archive#1881 — every body-reading POST 500'd in the brian-media deploy).
 */
function createLightweightAdapterRequest(backing: Request): Request {
  const proto: Record<string, unknown> = {
    get body() {
      return backing.body;
    },
    get bodyUsed() {
      return backing.bodyUsed;
    },
    get method() {
      return backing.method;
    },
    get url() {
      return backing.url;
    },
    get headers() {
      return backing.headers;
    },
    get signal() {
      return backing.signal;
    },
  };
  Object.setPrototypeOf(proto, Request.prototype);
  return Object.create(proto) as Request;
}

function bearerAuth(token: string = BEARER_CREDENTIAL): RequestInit {
  return { method: 'POST', headers: { authorization: `Bearer ${token}` } };
}

function cookieAuth(
  token: string = COOKIE_CREDENTIAL,
  origin = ALLOWED_ORIGIN,
): RequestInit {
  return {
    method: 'POST',
    headers: {
      cookie: `__Host-station-device=${token}`,
      origin,
    },
  };
}

function internalProxyAuth(): RequestInit {
  return {
    method: 'POST',
    headers: {
      [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
      [INTERNAL_PROXY_CALLER_HEADER]: 'local',
    },
  };
}

describe('station#514: authenticated mutation budget', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ── AC: Limits apply before mutation side effects ──
  describe('body-size budget rejects before side effects', () => {
    it('returns 413 and leaves no persisted state for an oversized body', async () => {
      const { request, sideEffects } = createBudgetHarness({
        maxMutationBodyBytes: 50,
      });
      const oversized = 'x'.repeat(200);
      const response = await request(
        '/api/projects',
        {
          ...bearerAuth(),
          body: JSON.stringify({ data: oversized }),
        },
        '192.168.1.50',
      );
      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'request_too_large', limit_bytes: 50 },
      });
      // The handler never ran — no side effect.
      expect(sideEffects.get('POST /api/projects')).toBeUndefined();
    });

    it('allows a within-budget body and records the side effect', async () => {
      const { request, sideEffects } = createBudgetHarness({
        maxMutationBodyBytes: 200,
      });
      const response = await request(
        '/api/projects',
        {
          ...bearerAuth(),
          body: JSON.stringify({ name: 'small' }),
        },
        '192.168.1.50',
      );
      expect(response.status).toBe(200);
      expect(sideEffects.get('POST /api/projects')).toBe(1);
    });

    it('handles a bodyless POST without breaking the handler', async () => {
      const { request, sideEffects } = createBudgetHarness();
      // No body at all — the bounded read returns 'no-stream' and does not
      // touch c.req.raw.
      const response = await request(
        '/api/projects',
        {
          method: 'POST',
          headers: { authorization: `Bearer ${BEARER_CREDENTIAL}` },
        },
        '192.168.1.50',
      );
      expect(response.status).toBe(200);
      expect(sideEffects.get('POST /api/projects')).toBe(1);
    });

    it('handles an empty-body POST (Content-Length 0)', async () => {
      const { request, sideEffects } = createBudgetHarness();
      // Empty body — the stream is consumed and re-wrapped.
      const response = await request(
        '/api/projects',
        {
          method: 'POST',
          headers: { authorization: `Bearer ${BEARER_CREDENTIAL}` },
          body: '',
        },
        '192.168.1.50',
      );
      expect(response.status).toBe(200);
      expect(sideEffects.get('POST /api/projects')).toBe(1);
    });

    it('rejects a chunked body that exceeds the ceiling despite no Content-Length', async () => {
      const { request, sideEffects } = createBudgetHarness({
        maxMutationBodyBytes: 50,
      });
      // Construct a streaming body with no Content-Length by using a
      // ReadableStream — this exercises the byte-counting path, not the
      // Content-Length pre-check.
      const largeBody = 'x'.repeat(200);
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(largeBody));
          controller.close();
        },
      });
      const response = await request(
        '/api/projects',
        {
          method: 'POST',
          headers: { authorization: `Bearer ${BEARER_CREDENTIAL}` },
          body: stream,
          duplex: 'half',
        } as RequestInit,
        '192.168.1.50',
      );
      expect(response.status).toBe(413);
      expect(sideEffects.get('POST /api/projects')).toBeUndefined();
    });
  });

  // ── AC: One principal cannot evade through multiple routes ──
  describe('rate budget keyed on principal, not route', () => {
    it('keeps the exact enabled Task performance diagnostic bounded and separate', async () => {
      const prior = process.env.STATION_PERFORMANCE_REFERENCE;
      process.env.STATION_PERFORMANCE_REFERENCE = '1';
      try {
        const { request } = createBudgetHarness({
          maxMutationsPerWindow: 1,
          maxPerformanceDiagnosticPerWindow: 2,
          extraMutationRoutes: [
            {
              method: 'POST',
              path: '/api/tasks/:taskId/room/edit-plan',
            },
            {
              method: 'POST',
              path: '/api/tasks/:taskId/room/batches',
            },
            {
              method: 'POST',
              path: '/api/tasks/:taskId/room/live',
            },
            { method: 'POST', path: '/api/projects' },
          ],
        });
        const diagnostic = {
          ...bearerAuth(),
          headers: {
            authorization: `Bearer ${BEARER_CREDENTIAL}`,
            [INTERACTIVE_WORKSPACE_TIMING_REQUEST_HEADER]:
              INTERACTIVE_WORKSPACE_TIMING_MODE,
          },
          body: '{}',
        };
        expect(
          (
            await request(
              '/api/projects',
              { ...bearerAuth(), body: '{}' },
              '192.168.1.50',
            )
          ).status,
        ).toBe(200);
        expect(
          (
            await request(
              '/api/tasks/task-1/room/edit-plan',
              diagnostic,
              '192.168.1.50',
            )
          ).status,
        ).toBe(200);
        expect(
          (
            await request(
              '/api/tasks/task-1/room/live',
              diagnostic,
              '192.168.1.50',
            )
          ).status,
        ).toBe(200);
        expect(
          (
            await request(
              '/api/tasks/task-1/room/batches',
              diagnostic,
              '192.168.1.50',
            )
          ).status,
        ).toBe(429);
        expect(
          (
            await request(
              '/api/tasks/task-1/room/edit-plan',
              { ...bearerAuth(), body: '{}' },
              '192.168.1.50',
            )
          ).status,
        ).toBe(429);
      } finally {
        if (prior === undefined)
          delete process.env.STATION_PERFORMANCE_REFERENCE;
        else process.env.STATION_PERFORMANCE_REFERENCE = prior;
      }
    });

    it('exhausting the budget on one route blocks all other routes for the same principal', async () => {
      const { request } = createBudgetHarness({ maxMutationsPerWindow: 3 });
      // Exhaust via /api/projects.
      for (let i = 0; i < 3; i++) {
        const r = await request(
          '/api/projects',
          { ...bearerAuth(), body: '{}' },
          '192.168.1.50',
        );
        expect(r.status).toBe(200);
      }
      // A different route, same bearer principal → rate-limited.
      const blocked = await request(
        '/api/tasks',
        { ...bearerAuth(), body: '{}' },
        '192.168.1.50',
      );
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get('retry-after')).toBeTruthy();
    });

    it('two different bearer credentials get independent budgets', async () => {
      const { request } = createBudgetHarness({ maxMutationsPerWindow: 2 });
      // Exhaust bearer 1.
      for (let i = 0; i < 2; i++) {
        await request(
          '/api/projects',
          { ...bearerAuth(BEARER_CREDENTIAL), body: '{}' },
          '192.168.1.50',
        );
      }
      // Bearer 1 is limited.
      const b1Blocked = await request(
        '/api/projects',
        { ...bearerAuth(BEARER_CREDENTIAL), body: '{}' },
        '192.168.1.50',
      );
      expect(b1Blocked.status).toBe(429);
      // Bearer 2 is independent — not limited.
      const b2ok = await request(
        '/api/projects',
        { ...bearerAuth(BEARER_CREDENTIAL_2), body: '{}' },
        '192.168.1.50',
      );
      expect(b2ok.status).toBe(200);
    });
  });

  // ── AC: Budget identity follows the credential, not the transport ──
  describe('budget identity per credential', () => {
    it('different credentials (one bearer, one cookie) get independent budgets', async () => {
      const { request } = createBudgetHarness({ maxMutationsPerWindow: 2 });
      // Exhaust BEARER_CREDENTIAL's budget.
      for (let i = 0; i < 2; i++) {
        await request(
          '/api/projects',
          { ...bearerAuth(), body: '{}' },
          '192.168.1.50',
        );
      }
      // BEARER_CREDENTIAL is limited.
      expect(
        (
          await request(
            '/api/projects',
            { ...bearerAuth(), body: '{}' },
            '192.168.1.50',
          )
        ).status,
      ).toBe(429);
      // A DIFFERENT credential via a device-session cookie has its OWN budget
      // — not limited. Two distinct secrets are two distinct principals.
      const cookieResponse = await request(
        '/api/projects',
        { ...cookieAuth(), body: '{}' },
        '192.168.1.50',
      );
      expect(cookieResponse.status).toBe(200);
    });

    it('the SAME secret through bearer and cookie shares one budget (transport cannot double it)', async () => {
      // archive#514 security review (HIGH): the budget key must follow the
      // credential value, not which extraction branch fired. One valid
      // credential presented as a bearer token and then as a device-session
      // cookie must resolve to ONE budget — otherwise the caller doubles its
      // mutation quota every window by simply omitting the Authorization
      // header. This is the integration-level negative control that the
      // source-prefixed derivation failed: under that derivation the cookie
      // request below returned 200 (a brand-new `session:` bucket) after the
      // bearer bucket was already exhausted.
      const { request } = createBudgetHarness({ maxMutationsPerWindow: 2 });
      // BEARER_CREDENTIAL is 'a'.repeat(43) — valid as both a bearer token
      // and a device-session cookie value (matches the 43-char base64url
      // cookie pattern). Exhaust its budget via the bearer transport.
      for (let i = 0; i < 2; i++) {
        const r = await request(
          '/api/projects',
          { ...bearerAuth(BEARER_CREDENTIAL), body: '{}' },
          '192.168.1.50',
        );
        expect(r.status).toBe(200);
      }
      // Bearer is at ceiling.
      expect(
        (
          await request(
            '/api/projects',
            { ...bearerAuth(BEARER_CREDENTIAL), body: '{}' },
            '192.168.1.50',
          )
        ).status,
      ).toBe(429);
      // The SAME secret via a device-session cookie is the SAME budget —
      // also at ceiling. This assertion goes red under source-prefixed keys.
      const cookieResponse = await request(
        '/api/projects',
        { ...cookieAuth(BEARER_CREDENTIAL), body: '{}' },
        '192.168.1.50',
      );
      expect(cookieResponse.status).toBe(429);
    });

    it('token-attested internal proxy requests get a shared internal budget', async () => {
      const { request } = createBudgetHarness({ maxMutationsPerWindow: 2 });
      // Exhaust the per-boot internal-token budget. This is not a bare
      // loopback exception: the direct socket plus the token and local-caller
      // marker are all required by the runtime authentication middleware.
      for (let i = 0; i < 2; i++) {
        const r = await request(
          '/api/projects',
          { ...internalProxyAuth(), body: '{}' },
          '127.0.0.1',
        );
        expect(r.status).toBe(200);
      }
      // All requests authenticated with that internal credential share one
      // budget → rate-limited.
      const blocked = await request(
        '/api/projects',
        { ...internalProxyAuth(), body: '{}' },
        '127.0.0.1',
      );
      expect(blocked.status).toBe(429);
    });

    it('internal-token and bearer budgets are independent', async () => {
      const { request } = createBudgetHarness({ maxMutationsPerWindow: 1 });
      // Exhaust the internal-token budget.
      await request(
        '/api/projects',
        { ...internalProxyAuth(), body: '{}' },
        '127.0.0.1',
      );
      expect(
        (
          await request(
            '/api/projects',
            { ...internalProxyAuth(), body: '{}' },
            '127.0.0.1',
          )
        ).status,
      ).toBe(429);
      // Remote bearer has its own budget — not limited.
      const remoteBearer = await request(
        '/api/projects',
        { ...bearerAuth(), body: '{}' },
        '192.168.1.50',
      );
      expect(remoteBearer.status).toBe(200);
    });
  });

  // ── AC: Chat/SSE behaviour under documented limits ──
  describe('streaming routes', () => {
    it('streaming mutation routes get a separate, more generous rate bucket', async () => {
      const { request } = createBudgetHarness({
        maxMutationsPerWindow: 1,
        maxStreamingPerWindow: 5,
      });
      // Exhaust the standard budget.
      await request(
        '/api/projects',
        { ...bearerAuth(), body: '{}' },
        '192.168.1.50',
      );
      expect(
        (
          await request(
            '/api/projects',
            { ...bearerAuth(), body: '{}' },
            '192.168.1.50',
          )
        ).status,
      ).toBe(429);
      // The streaming route has its OWN bucket — still allowed.
      const chatResponse = await request(
        '/api/agents/mybot/chat',
        { ...bearerAuth(), body: '{}' },
        '192.168.1.50',
      );
      expect(chatResponse.status).toBe(200);
    });

    it('streaming mutation body-size uses the streaming ceiling', async () => {
      const { request, sideEffects } = createBudgetHarness({
        maxMutationBodyBytes: 50,
        maxStreamingBodyBytes: 150,
      });
      // 100-byte body: too large for standard (50) but within streaming (150).
      const body = JSON.stringify({ input: 'x'.repeat(80) });
      const response = await request(
        '/api/agents/mybot/chat',
        { ...bearerAuth(), body },
        '192.168.1.50',
      );
      expect(response.status).toBe(200);
      expect(sideEffects.get('POST /api/agents/:slug/chat')).toBe(1);
    });

    it('SSE GET read routes are unbudgeted (no rate accounting)', async () => {
      const { request } = createBudgetHarness({ maxMutationsPerWindow: 1 });
      // Register an SSE-like GET route.
      // GETs are never mutations — they should pass freely even after the
      // mutation budget is exhausted.
      await request(
        '/api/projects',
        { ...bearerAuth(), body: '{}' },
        '192.168.1.50',
      );
      // Budget exhausted for mutations, but a GET on the same path is fine.
      const getResponse = await request(
        '/api/projects',
        {
          method: 'GET',
          headers: { authorization: `Bearer ${BEARER_CREDENTIAL}` },
        },
        '192.168.1.50',
      );
      expect(getResponse.status).toBe(200);
    });

    // archive#1885 review HIGH: the station-agent relay composes a JSON body
    // whose payload is the base64-expanded attachment data URL. A ~1.5 MB raw
    // phone screenshot expands to ~2 MB of base64 — which exceeded the former
    // hardcoded 2 MiB streaming default and 413'd mid-flight, in the exact
    // size range image attachments were supposed to fix. The streaming
    // ceiling is now derived from the attachment contract
    // (CHAT_ATTACHMENT_MAX_COMMAND_JSON_BYTES). This test proves a
    // realistically-sized relay body passes under that ceiling, where it
    // would have been rejected under the old one.
    it('a realistic image-attachment relay body passes the derived streaming ceiling (station#1885)', async () => {
      // Build a relay body shaped exactly like buildRelayInput's output for a
      // single ~1.5 MB raw image: base64 expands to ~2 MB.
      const rawBytes = Math.round(1.5 * 1024 * 1024);
      const base64Length = Math.ceil(rawBytes / 3) * 4;
      const dataUrl = `data:image/png;base64,${'A'.repeat(base64Length)}`;
      const body = JSON.stringify({
        input: [
          {
            id: 'msg-1',
            role: 'user',
            parts: [
              { type: 'text', text: 'describe this image' },
              { type: 'file', url: dataUrl, mediaType: 'image/png' },
            ],
          },
        ],
        options: { conversationId: 'conv-1' },
      });
      // Sanity: this body is bigger than the OLD 2 MiB hardcoded ceiling...
      expect(body.length).toBeGreaterThan(2_097_152);
      // ...but well within the contract-derived ceiling.
      expect(body.length).toBeLessThanOrEqual(
        CHAT_ATTACHMENT_MAX_COMMAND_JSON_BYTES,
      );
      // Wire the harness with the same derived ceiling production uses (the
      // RuntimeMutationBudget default, which the relationship test pins).
      const { request, sideEffects } = createBudgetHarness({
        maxStreamingBodyBytes: CHAT_ATTACHMENT_MAX_COMMAND_JSON_BYTES,
      });
      const response = await request(
        '/api/agents/bot/chat',
        { ...bearerAuth(), body },
        '192.168.1.50',
      );
      expect(response.status).toBe(200);
      expect(sideEffects.get('POST /api/agents/:slug/chat')).toBe(1);
    });
  });

  // ── AC: Public routes behave as decided ──
  describe('public routes', () => {
    it('public routes are unbudgeted — no body-size or rate check', async () => {
      const { request } = createBudgetHarness({
        maxMutationBodyBytes: 10,
        maxMutationsPerWindow: 1,
      });
      // A public route (GET /api/system/liveness) is classified 'public' →
      // 'unbudgeted'. It never reaches the budget middleware.
      const response = await request('/api/system/liveness', {}, '127.0.0.1');
      expect(response.status).toBe(200);
    });
  });

  // ── AC: Rate-limited request leaves no persisted state ──
  describe('rate budget rejects before side effects', () => {
    it('a rate-limited request does not reach the handler', async () => {
      const { request, sideEffects } = createBudgetHarness({
        maxMutationsPerWindow: 2,
      });
      for (let i = 0; i < 2; i++) {
        await request(
          '/api/projects',
          { ...bearerAuth(), body: '{}' },
          '192.168.1.50',
        );
      }
      // Third request is rate-limited.
      const response = await request(
        '/api/projects',
        { ...bearerAuth(), body: '{}' },
        '192.168.1.50',
      );
      expect(response.status).toBe(429);
      // Only 2 side-effects recorded — the rate-limited request did not reach the handler.
      expect(sideEffects.get('POST /api/projects')).toBe(2);
    });
  });

  /**
   * `source` is deliberately excluded from the budget KEY (keying on it let one
   * credential draw two budgets by choosing a transport). It is retained on
   * `BudgetPrincipal` to be reported here — so this is what stops the field
   * decaying back into a decorative label nothing computes.
   *
   * A sibling counter shipped wired to the wrong instrument because no test in
   * that suite imported `metrics.ts` at all (archive#1872). Same shape, same guard.
   */
  describe('budget telemetry', () => {
    it('reports the authentication mode the decision applied to', async () => {
      const { request } = createBudgetHarness();

      await request(
        '/api/projects',
        { ...bearerAuth(), body: '{}' },
        '192.168.1.50',
      );
      expect(requestBudgetOutcomes.add).toHaveBeenLastCalledWith(1, {
        outcome: 'allowed',
        class: 'standard',
        source: 'bearer',
      });

      await request(
        '/api/projects',
        { ...cookieAuth(), body: '{}' },
        '192.168.1.50',
      );
      expect(requestBudgetOutcomes.add).toHaveBeenLastCalledWith(1, {
        outcome: 'allowed',
        class: 'standard',
        source: 'session',
      });

      // The per-boot internal-token credential must remain distinguishable
      // from a paired device in telemetry. A bare loopback request never
      // reaches this middleware: runtime authentication refuses it first.
      await request(
        '/api/projects',
        { ...internalProxyAuth(), body: '{}' },
        '127.0.0.1',
      );
      expect(requestBudgetOutcomes.add).toHaveBeenLastCalledWith(1, {
        outcome: 'allowed',
        class: 'standard',
        source: 'loopback',
      });
    });
  });

  // ── archive#1881: cross-module lightweight adapter request re-wrap ──
  describe('cross-module adapter lightweight request re-wrap', () => {
    it('rewraps a body-bearing lightweight request without reading a missing #state slot', async () => {
      const { request, sideEffects } = createBudgetHarness({
        maxMutationBodyBytes: 200,
      });
      // The backing request carries the real bytes; the lightweight proxy is
      // what the adapter hands to Hono as c.req.raw.
      const backing = new Request(`${ALLOWED_ORIGIN}/api/projects`, {
        method: 'POST',
        headers: { authorization: `Bearer ${BEARER_CREDENTIAL}` },
        body: JSON.stringify({ name: 'small' }),
      });
      const rawRequest = createLightweightAdapterRequest(backing);
      const response = await request(
        '/api/projects',
        {},
        '192.168.1.50',
        rawRequest,
      );
      // Under the old `new Request(c.req.raw, { body })` this dispatch threw
      // the private-`#state` TypeError inside undici and returned a 500 from
      // app.onError. The bounded body must be readable by the handler.
      expect(response.status).toBe(200);
      expect(sideEffects.get('POST /api/projects')).toBe(1);
    });

    it('still rejects an oversized lightweight-request body with 413', async () => {
      const { request, sideEffects } = createBudgetHarness({
        maxMutationBodyBytes: 50,
      });
      const backing = new Request(`${ALLOWED_ORIGIN}/api/projects`, {
        method: 'POST',
        headers: { authorization: `Bearer ${BEARER_CREDENTIAL}` },
        body: JSON.stringify({ data: 'x'.repeat(200) }),
      });
      const rawRequest = createLightweightAdapterRequest(backing);
      const response = await request(
        '/api/projects',
        {},
        '192.168.1.50',
        rawRequest,
      );
      expect(response.status).toBe(413);
      expect(sideEffects.get('POST /api/projects')).toBeUndefined();
    });
  });
});

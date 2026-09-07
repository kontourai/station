import { DEFAULT_GRANT_PAIRING_SCOPE } from '@kontourai/station-contracts/environment-security';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  getRuntimeAuthenticatedRequestPrincipal,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../../../security/runtime-request-security.js';
import type { EventBus } from '../../../services/orchestration/event-bus.js';
import type { Logger } from '../../../utils/logger.js';
import {
  configureRuntimeHttp,
  resolveRuntimeCorsOrigin,
} from '../runtime-http.js';

describe('resolveRuntimeCorsOrigin', () => {
  const originalAllowedOrigins = process.env.ALLOWED_ORIGINS;

  afterEach(() => {
    if (originalAllowedOrigins === undefined) {
      delete process.env.ALLOWED_ORIGINS;
    } else {
      process.env.ALLOWED_ORIGINS = originalAllowedOrigins;
    }
    vi.restoreAllMocks();
  });

  test('allows localhost, tauri, and private-network origins', () => {
    expect(resolveRuntimeCorsOrigin('http://localhost:5173')).toBe(
      'http://localhost:5173',
    );
    expect(resolveRuntimeCorsOrigin('http://tauri.localhost')).toBe(
      'http://tauri.localhost',
    );
    expect(resolveRuntimeCorsOrigin('https://tauri.localhost')).toBe(
      'https://tauri.localhost',
    );
    expect(resolveRuntimeCorsOrigin('http://192.168.1.14:3000')).toBe(
      'http://192.168.1.14:3000',
    );
    expect(resolveRuntimeCorsOrigin('http://10.0.0.8:3000')).toBe(
      'http://10.0.0.8:3000',
    );
    expect(resolveRuntimeCorsOrigin('http://172.20.1.20:3000')).toBe(
      'http://172.20.1.20:3000',
    );
  });

  test('allows configured origins and rejects everything else', () => {
    process.env.ALLOWED_ORIGINS =
      'https://app.example.com,https://ops.example.com';

    expect(resolveRuntimeCorsOrigin('https://app.example.com')).toBe(
      'https://app.example.com',
    );
    expect(resolveRuntimeCorsOrigin('https://unknown.example.com')).toBeNull();
  });

  test('keeps the middleware-authenticated cookie or bearer principal on its exact request', () => {
    const request = new Request('http://station.test/api/tasks/task/room');
    setRuntimeAuthenticatedRequestPrincipal(request, {
      credential: 'paired-device-credential',
      authority: 'device-credential',
      source: 'session',
    });
    expect(getRuntimeAuthenticatedRequestPrincipal(request)).toEqual({
      credential: 'paired-device-credential',
      authority: 'device-credential',
      source: 'session',
    });
    expect(
      getRuntimeAuthenticatedRequestPrincipal(
        new Request('http://station.test/api/tasks/task/room'),
      ),
    ).toBeUndefined();
  });

  test('station#169: the preflight allowlist admits Last-Event-ID so cross-origin SSE reconnects survive', async () => {
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
    const app = new Hono();
    // The SECURITY path is the one with the static allowlist; the no-security
    // fallback uses hono/cors, which reflects whatever the request asks for
    // and can never block a header. This regression is only expressible here.
    configureRuntimeHttp({
      app: app as never,
      logger,
      eventBus: { emit: vi.fn() } as unknown as EventBus,
      security: {
        allowedOrigins: ['http://localhost:5173'],
        verifyCredential: () => true,
        resolveGrantedScope: () => DEFAULT_GRANT_PAIRING_SCOPE,
      },
    });

    const response = await app.request(
      'http://station.test/api/orchestration/events',
      {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://localhost:5173',
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'last-event-id',
        },
      },
      { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as never,
    );

    expect(response.status).toBe(204);
    const allowed = (response.headers.get('Access-Control-Allow-Headers') ?? '')
      .split(',')
      .map((header) => header.trim().toLowerCase());
    // Browsers match preflight headers case-insensitively; membership in the
    // normalized list is the property the SSE reconnect depends on.
    expect(allowed).toContain('last-event-id');
    expect(allowed).toContain('authorization');
  });

  test('station#1848: the access log never reports a stream-open time as a request duration', async () => {
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
    const app = new Hono();
    configureRuntimeHttp({
      app: app as never,
      logger,
      eventBus: { emit: vi.fn() } as unknown as EventBus,
    } as Parameters<typeof configureRuntimeHttp>[0]);
    // A handler that returns immediately while its body keeps writing — the
    // exact shape of `streamSSE`, and the reason a 15-minute connection used
    // to log an indistinguishable `200 1ms`.
    app.get('/stream', (c) => {
      c.header('Content-Type', 'text/event-stream');
      return c.body(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(': open\n\n'));
          },
        }),
      );
    });
    app.get('/plain', (c) => c.json({ ok: true }));

    await app.request('http://station.test/stream');
    await app.request('http://station.test/plain');

    const lines = vi
      .mocked(logger.info)
      .mock.calls.map(([message]) => String(message));
    const streamLine = lines.find((line) => line.includes('/stream')) ?? '';
    const plainLine = lines.find((line) => line.includes('/plain')) ?? '';

    expect(streamLine).toContain('stream-open-after=');
    // The failure this pins: a bare `<n>ms` in the duration position on a
    // streaming response is read as the request having completed in that time.
    expect(streamLine).not.toMatch(/ 200 \d+ms /);
    expect(plainLine).toMatch(/ 200 \d+ms /);
    expect(plainLine).not.toContain('stream-open-after=');
  });

  test('contains an unexpected external error behind a generic correlated envelope', async () => {
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
    const app = new Hono();
    configureRuntimeHttp({
      app: app as never,
      logger,
      eventBus: { emit: vi.fn() } as unknown as EventBus,
    } as Parameters<typeof configureRuntimeHttp>[0]);
    const unsafeUrl = `https://${'provider'}.example.test/private/path?${'token'}=secret-value#fragment`;
    app.get('/boom', () => {
      throw new Error(`engine stderr: ${unsafeUrl}`);
    });
    app.get('/auth', () => {
      throw new Error('authentication failed');
    });

    const response = await app.request('http://station.test/boom');
    const body = (await response.json()) as {
      success: boolean;
      error: { code: string; correlationId: string };
    };
    const rendered = JSON.stringify(body);

    expect(response.status).toBe(500);
    expect(body).toMatchObject({
      success: false,
      error: { code: 'internal_error', correlationId: expect.any(String) },
    });
    for (const fragment of [
      'provider',
      'private/path',
      'token',
      'secret-value',
      'fragment',
    ]) {
      expect(rendered).not.toContain(fragment);
    }
    const context = vi.mocked(logger.error).mock.calls[0]?.[1];
    expect(JSON.stringify(context)).not.toContain('provider');
    expect(context).toMatchObject({ correlationId: body.error.correlationId });

    const authResponse = await app.request('http://station.test/auth');
    expect(authResponse.status).toBe(401);
    await expect(authResponse.json()).resolves.toEqual({
      success: false,
      error: 'Authentication failed',
    });
  });

  test('contains a foreign thrown value before Hono can coerce it', async () => {
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
    const app = new Hono();
    configureRuntimeHttp({
      app: app as never,
      logger,
      eventBus: { emit: vi.fn() } as unknown as EventBus,
    } as Parameters<typeof configureRuntimeHttp>[0]);
    const foreignThrow = {
      provider: 'provider.example.test',
      token: 'secret-value',
      [Symbol.toPrimitive]: () => {
        throw new Error('must not coerce foreign throw');
      },
    };
    app.get('/foreign-throw', () => {
      throw foreignThrow;
    });

    const response = await app.request('http://station.test/foreign-throw');
    const body = (await response.json()) as {
      success: boolean;
      error: { code: string; correlationId: string };
    };

    expect(response.status).toBe(500);
    expect(body).toMatchObject({
      success: false,
      error: { code: 'internal_error', correlationId: expect.any(String) },
    });
    expect(JSON.stringify(body)).not.toContain('provider');
    expect(JSON.stringify(body)).not.toContain('secret-value');
    expect(logger.error).toHaveBeenCalledWith(
      'Unhandled runtime HTTP non-Error throw',
      { correlationId: body.error.correlationId },
    );
  });
});

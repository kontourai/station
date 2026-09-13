import {
  APPLICATION_SESSION_HEADER,
  APPLICATION_SESSION_PROOF_HEADER,
} from '@kontourai/station-contracts/application-session';
import { DEFAULT_GRANT_PAIRING_SCOPE } from '@kontourai/station-contracts/environment-security';
import { Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';
import { configureRuntimeHttp } from '../../../runtime/bootstrap/runtime-http.js';
import {
  getDirectSocketAddress,
  getRuntimeAuthenticatedRequestPrincipal,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../../../security/runtime-request-security.js';
import type { Logger } from '../../../utils/logger.js';
import type { EventBus } from '../../orchestration/event-bus.js';
import { VirtualApplicationIngress } from '../virtual-application.js';

const origin = 'https://station.example';
const clientOrigin = 'https://client.example';
function setup(handler: (request: Request) => Response | Promise<Response>) {
  const owner = new VirtualApplicationIngress(origin);
  owner.bind({ fetch: handler });
  return { owner, application: owner.activate() };
}
const request = (path = '/api/projects', init?: RequestInit) =>
  new Request(origin + path, init);

describe('virtual application ingress', () => {
  test('uses real runtime admission without inventing socket or inherited authority', async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn(),
      setLevel: vi.fn(),
      getLevel: () => 'info',
    } as Logger;
    const app = new Hono();
    const verify = vi.fn(
      (credential: string) => credential === 'approved-device',
    );
    configureRuntimeHttp({
      app: app as never,
      logger,
      eventBus: { emit: vi.fn() } as unknown as EventBus,
      security: {
        allowedOrigins: [clientOrigin],
        verifyCredential: verify,
        resolveGrantedScope: () => DEFAULT_GRANT_PAIRING_SCOPE,
      },
    });
    const reached = vi.fn();
    app.get('/api/projects', (c) => {
      reached(
        getDirectSocketAddress(c.env),
        getRuntimeAuthenticatedRequestPrincipal(c.req.raw),
      );
      return c.json({ data: ['permitted'] });
    });
    const { application, owner } = setup((r) => app.fetch(r));
    const forged = request();
    setRuntimeAuthenticatedRequestPrincipal(forged, {
      kind: 'internal',
      credential: 'internal',
      authority: undefined,
      source: 'bearer',
    });
    const denied = await application.fetch(forged);
    expect(denied.status).toBe(401);
    expect(reached).not.toHaveBeenCalled();
    const allowed = await application.fetch(
      request('/api/projects', {
        headers: {
          Authorization: 'Bearer approved-device',
          Origin: clientOrigin,
        },
      }),
    );
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ data: ['permitted'] });
    expect(reached.mock.calls[0]?.[0]).toBeUndefined();
    expect(verify).toHaveBeenCalled();
    owner.stop();
  });
  test.each([
    'cookie',
    'host',
    'x-forwarded-for',
    'x-station-internal-token',
    'x-station-proxy-peer',
    'x-station-ingress-identity',
    'tailscale-user-login',
    'connection',
    'content-length',
  ])('rejects %s before dispatch', async (header) => {
    const handler = vi.fn(() => Response.json({}));
    const { application, owner } = setup(handler);
    const response = await application.fetch(
      request('/api/projects', { headers: { [header]: 'untrusted' } }),
    );
    expect(response.status).toBe(400);
    expect(handler).not.toHaveBeenCalled();
    owner.stop();
  });
  test('preserves opaque account proofs, Device credential and actual Origin', async () => {
    const headers = {
      Authorization: 'Bearer approved-device',
      Origin: clientOrigin,
      [APPLICATION_SESSION_HEADER]: 'opaque-continuation',
      [APPLICATION_SESSION_PROOF_HEADER]: 'sdk-proof',
    };
    const handler = vi.fn((r) => Response.json(Object.fromEntries(r.headers)));
    const { application, owner } = setup(handler);
    const response = await application.fetch(
      request('/api/account-auth/continuations/login', {
        method: 'POST',
        headers,
        body: '{}',
      }),
    );
    const result = await response.json();
    for (const [name, value] of Object.entries(headers))
      expect(result).toHaveProperty(name.toLowerCase(), value);
    expect(handler.mock.calls[0]?.[0].credentials).toBe('omit');
    owner.stop();
  });
  test('rejects cookie operations and foreign targets and never follows redirects', async () => {
    const handler = vi.fn(
      () =>
        new Response(null, {
          status: 307,
          headers: { Location: 'https://foreign.example' },
        }),
    );
    const { application, owner } = setup(handler);
    expect(
      (await application.fetch(request('/api/account-auth/local/sign-in')))
        .status,
    ).toBe(400);
    expect(
      (
        await application.fetch(
          new Request('https://foreign.example/api/projects'),
        )
      ).status,
    ).toBe(400);
    expect(handler).not.toHaveBeenCalled();
    expect((await application.fetch(request())).status).toBe(307);
    expect(handler).toHaveBeenCalledTimes(1);
    owner.stop();
  });
  test('never exposes cookie-setting responses to virtual clients', async () => {
    const { application, owner } = setup(
      () =>
        new Response('secret', {
          headers: { 'Set-Cookie': 'session=secret; HttpOnly' },
        }),
    );
    const response = await application.fetch(request());
    expect(response.status).toBe(502);
    expect(response.headers.has('set-cookie')).toBe(false);
    expect(await response.text()).not.toContain('secret');
    owner.stop();
  });
  test('retirement fences an open stream and every later request', async () => {
    const cancel = vi.fn();
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const { application, owner } = setup(
      () =>
        new Response(
          new ReadableStream({
            start(c) {
              body = c;
            },
            cancel,
          }),
        ),
    );
    const response = await application.fetch(request());
    const reader = response.body!.getReader();
    body.enqueue(new Uint8Array([1]));
    expect((await reader.read()).value).toEqual(new Uint8Array([1]));
    const next = reader.read();
    owner.stop();
    await expect(next).rejects.toThrow('retired');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(application.signal.aborted).toBe(true);
    expect((await application.fetch(request())).status).toBe(503);
  });
  test('admission counts open bodies and consumer cancellation releases capacity', async () => {
    const { application, owner } = setup(
      () => new Response(new ReadableStream()),
    );
    const responses = await Promise.all(
      Array.from({ length: 32 }, () => application.fetch(request())),
    );
    expect((await application.fetch(request())).status).toBe(429);
    await responses[0]!.body!.cancel();
    const replacement = await application.fetch(request());
    expect(replacement.status).toBe(200);
    owner.stop();
  });
  test('retirement settles a request before headers and discards its late body', async () => {
    let finish!: (response: Response) => void;
    let started!: () => void;
    const reached = new Promise<void>((resolve) => {
      started = resolve;
    });
    const late = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const { application, owner } = setup(() => {
      started();
      return late;
    });
    const pending = application.fetch(request());
    await reached;
    owner.stop();
    await expect(pending).rejects.toThrow('retired');
    const cancelled = vi.fn();
    finish(new Response(new ReadableStream({ cancel: cancelled })));
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledTimes(1));
  });
  test('cancelling callers cannot create unbounded handlers that ignore abort', async () => {
    const finishes: Array<(response: Response) => void> = [];
    const { application, owner } = setup(
      () =>
        new Promise((resolve) => {
          finishes.push(resolve);
        }),
    );
    const controllers = Array.from({ length: 32 }, () => new AbortController());
    const pending = controllers.map((controller) =>
      application.fetch(
        request('/api/projects', { signal: controller.signal }),
      ),
    );
    const outcomes = Promise.allSettled(pending);
    await vi.waitFor(() => expect(finishes).toHaveLength(32));
    controllers.forEach((controller) => controller.abort());
    expect(
      (await outcomes).every((result) => result.status === 'rejected'),
    ).toBe(true);
    expect((await application.fetch(request())).status).toBe(429);
    finishes.forEach((finish) => finish(new Response(null, { status: 204 })));
    await Promise.resolve();
    await Promise.resolve();
    const next = application.fetch(request());
    await vi.waitFor(() => expect(finishes).toHaveLength(33));
    finishes[32]!(new Response(null, { status: 204 }));
    expect((await next).status).toBe(204);
    owner.stop();
  });
  test('cannot publish an unbound or retired application', () => {
    const owner = new VirtualApplicationIngress(origin);
    expect(() => owner.activate()).toThrow();
    owner.bind({ fetch: () => Response.json({}) });
    owner.stop();
    expect(() => owner.activate()).toThrow();
    expect(() => owner.bind({ fetch: () => Response.json({}) })).toThrow();
  });
});

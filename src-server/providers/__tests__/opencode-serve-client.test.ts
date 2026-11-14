import { readFileSync } from 'node:fs';
import { describe, expect, test, vi } from 'vitest';
import {
  assertOpenCodeServePathAllowed,
  OpenCodeEventStreamStalledError,
  OpenCodeServeClient,
  OpenCodeServeDeniedPathError,
  OpenCodeServeHttpError,
  redactOpenCodeSecrets,
} from '../adapters/opencode-serve-client.js';

const BASE = 'http://127.0.0.1:47999';

function fetchSpy(respond: () => Response = () => Response.json({ data: 1 })) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    respond(),
  );
}

/** The `basic` capture's SSE frames, as OpenCode 2.3.0 sent them. */
function capturedFrames(): string[] {
  return readFileSync(
    new URL('./fixtures/opencode-serve-2.3.0-basic.jsonl', import.meta.url),
    'utf8',
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((line) => line.kind === 'sse')
    .map((line) => `data: ${JSON.stringify(line.event)}\n\n`);
}

/** A response body that sends `chunks`, then stays open until cancelled. */
function openStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
    },
  });
}

describe('OpenCodeServeClient requests', () => {
  test.each([
    '/api/credential',
    '/api/credential/cred_1',
    '/api/credential/cred_1/activate',
    '/api/credential?x=1',
    '/API/Credential',
    '/api/integration/anthropic/connect/key',
    '/api/integration/anthropic/connect/oauth/att_1/complete',
    '/api/pair',
    '/auth/connect/abc',
    '/api/session/../credential',
    '/api/session/%2e%2e/credential',
    '/api%2fcredential',
    '//evil.example/api/info',
    'api/info',
    // Encodings, empty segments and matrix parameters a router may normalise.
    '/api/%63redential',
    '/api//credential',
    '/api/credential;x',
    '/api/session/ses_1/%2e%2e/../credential',
    '/api/info#frag',
    // Real routes the transport never calls.
    '/api/config',
    '/api/session',
    '/api/provider',
    '/api/experimental/client-mcp',
    '/api/fs/read/etc/passwd',
    '/api/agent',
    '/api/session/ses_1/message?x=%2F',
  ])('%s is refused before any network I/O', async (path) => {
    const fetch = fetchSpy();
    const client = new OpenCodeServeClient({
      baseUrl: BASE,
      password: 'p',
      fetch: fetch as never,
    });
    await expect(client.request('GET', path)).rejects.toBeInstanceOf(
      OpenCodeServeDeniedPathError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each([
    ['GET', '/api/credential'],
    ['POST', '/api/integration/anthropic/connect/key'],
    ['POST', '/api/pair'],
    ['GET', '/auth/connect/abc'],
    ['POST', '/api/experimental/client-mcp/token'],
    ['POST', '/api/pty/pty_1/connect-token'],
    ['POST', '/api/experimental/persistent-pty/pty_1/connect-token'],
    ['PATCH', '/api/config'],
    ['PUT', '/api/config'],
    ['PATCH', '/api/experimental/config'],
  ] as const)(
    'the never-allow list refuses %s %s even when a route lists it',
    (method, path) => {
      const permissive = [
        { operationId: 'x', method, template: path.split('?')[0]! },
      ];
      expect(() =>
        assertOpenCodeServePathAllowed(method, path, permissive),
      ).toThrow(OpenCodeServeDeniedPathError);
    },
  );

  test('a listed route with another method is refused', async () => {
    const fetch = fetchSpy();
    const client = new OpenCodeServeClient({
      baseUrl: BASE,
      password: 'p',
      fetch: fetch as never,
    });
    await expect(
      client.request('DELETE', '/api/session/ses_1'),
    ).rejects.toBeInstanceOf(OpenCodeServeDeniedPathError);
    await expect(client.request('GET', '/api/session')).rejects.toBeInstanceOf(
      OpenCodeServeDeniedPathError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  test('every request the transport makes is in the route table', async () => {
    const fetch = fetchSpy();
    const client = new OpenCodeServeClient({
      baseUrl: BASE,
      password: 'p',
      fetch: fetch as never,
    });
    for (const [method, path] of [
      ['GET', '/openapi.json'],
      ['GET', '/api/info'],
      ['GET', '/api/agent/build'],
      ['GET', '/api/permission/saved'],
      ['GET', '/api/session/active'],
      ['POST', '/api/session'],
      ['PATCH', '/api/session/ses_1'],
      ['GET', '/api/session/ses_1/message?order=asc'],
      ['POST', '/api/session/ses_1/permission/per_1/reply'],
      ['DELETE', '/api/session/ses_1/form/frm_1'],
      ['DELETE', '/api/session/ses_1/inbox/inb_1'],
      ['DELETE', '/api/session/ses_1/revert'],
      ['GET', '/api/model'],
      ['GET', '/api/mcp'],
    ] as const)
      await client.request(method, path);
    expect(fetch).toHaveBeenCalledTimes(14);
  });

  test('model settings secrets are redacted before the answer leaves the client', async () => {
    const line = readFileSync(
      new URL('./fixtures/opencode-serve-2.3.0-catalog.jsonl', import.meta.url),
      'utf8',
    )
      .split('\n')
      .find((text) => text.includes('"apiKey":"mock-key"'));
    const exchange = JSON.parse(line!);
    expect(exchange.path).toBe('/api/model');
    const client = new OpenCodeServeClient({
      baseUrl: BASE,
      password: 'p',
      fetch: fetchSpy(() => Response.json(exchange.response)) as never,
    });
    const answer = await client.request('GET', '/api/model');
    const text = JSON.stringify(answer);
    expect(text).not.toContain('mock-key');
    expect(text).toContain('"apiKey":"[redacted]"');
    // Non-secret settings survive.
    expect(text).toContain('"baseURL":"http://127.0.0.1:47300/v1"');
    expect(
      JSON.stringify(
        redactOpenCodeSecrets({
          options: { headers: { authorization: 'x' }, accessToken: 't' },
          settings: { clientSecret: 's', password: 'p', name: 'kept' },
          token: 'top-level ids are not settings',
        }),
      ),
    ).toBe(
      JSON.stringify({
        options: { headers: { authorization: 'x' }, accessToken: '[redacted]' },
        settings: {
          clientSecret: '[redacted]',
          password: '[redacted]',
          name: 'kept',
        },
        token: 'top-level ids are not settings',
      }),
    );
  });

  test('a request with no answer times out by default', async () => {
    const client = new OpenCodeServeClient({
      baseUrl: BASE,
      password: 'p',
      fetch: (async (_url: unknown, init?: RequestInit) =>
        new Promise((_, reject) =>
          init?.signal?.addEventListener('abort', () =>
            reject(init.signal!.reason),
          ),
        )) as never,
    });
    await expect(
      client.request('GET', '/api/info', undefined, { timeoutMs: 20 }),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  test('allowed paths go to the loopback server with Basic auth', async () => {
    const fetch = fetchSpy();
    const client = new OpenCodeServeClient({
      baseUrl: BASE,
      password: 'secret',
      fetch: fetch as never,
    });
    await expect(
      client.request('POST', '/api/session/ses_1/prompt', { text: 'hi' }),
    ).resolves.toEqual({ data: 1 });
    await client.request('GET', '/api/session/ses_1/permission');
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${BASE}/api/session/ses_1/prompt`);
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{"text":"hi"}');
    expect((init!.headers as Record<string, string>).authorization).toBe(
      `Basic ${Buffer.from('opencode:secret').toString('base64')}`,
    );
  });

  test('a non-2xx answer throws with its status and body', async () => {
    const client = new OpenCodeServeClient({
      baseUrl: BASE,
      password: 'p',
      fetch: fetchSpy(() =>
        Response.json({ name: 'PermissionNotFoundError' }, { status: 404 }),
      ) as never,
    });
    await expect(
      client.request('POST', '/api/session/s/permission/p/reply', {
        decision: 'once',
      }),
    ).rejects.toMatchObject({
      constructor: OpenCodeServeHttpError,
      status: 404,
      body: { name: 'PermissionNotFoundError' },
    });
  });

  test('only a loopback http origin is accepted', () => {
    for (const baseUrl of [
      'http://example.com:4096',
      'https://127.0.0.1:1',
      'http://user:pw@127.0.0.1:1',
      'http://127.0.0.1:1/prefix',
    ])
      expect(() => new OpenCodeServeClient({ baseUrl, password: 'p' })).toThrow(
        /Not a loopback/,
      );
  });
});

describe('OpenCodeServeClient events', () => {
  test('yields the captured feed as parsed events, skipping heartbeats', async () => {
    const frames = capturedFrames();
    const fetch = fetchSpy(
      () =>
        new Response(openStream([': heartbeat\n\n', ...frames]), {
          headers: { 'content-type': 'text/event-stream' },
        }),
    );
    const client = new OpenCodeServeClient({
      baseUrl: BASE,
      password: 'p',
      fetch: fetch as never,
    });
    const controller = new AbortController();
    const seen: string[] = [];
    for await (const event of client.events({ signal: controller.signal })) {
      seen.push(event.type);
      if (seen.length === frames.length) controller.abort();
    }
    expect(seen[0]).toBe('server.connected');
    expect(seen).toContain('session.execution.succeeded');
    expect(seen).toHaveLength(frames.length);
  });

  test('a frame split across chunks is read whole', async () => {
    const [frame] = capturedFrames();
    const half = Math.floor(frame!.length / 2);
    const client = new OpenCodeServeClient({
      baseUrl: BASE,
      password: 'p',
      fetch: fetchSpy(
        () =>
          new Response(openStream([frame!.slice(0, half), frame!.slice(half)])),
      ) as never,
    });
    const controller = new AbortController();
    for await (const event of client.events({ signal: controller.signal })) {
      expect(event.type).toBe('server.connected');
      controller.abort();
    }
  });

  // A short test bound: with the stall check gone this fails in 2s, not at
  // the suite's default timeout.
  test('a feed silent past the heartbeat bound ends with a stall', async () => {
    const client = new OpenCodeServeClient({
      baseUrl: BASE,
      password: 'p',
      fetch: fetchSpy(
        () => new Response(openStream([': heartbeat\n\n'])),
      ) as never,
    });
    const read = async () => {
      for await (const _event of client.events({ heartbeatTimeoutMs: 30 })) {
        // nothing arrives
      }
    };
    await expect(read()).rejects.toBeInstanceOf(
      OpenCodeEventStreamStalledError,
    );
  }, 2_000);

  test('aborting ends the iteration without an error', async () => {
    const client = new OpenCodeServeClient({
      baseUrl: BASE,
      password: 'p',
      fetch: (async (_url: unknown, init?: RequestInit) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"type":"server.connected"}\n\n',
                ),
              );
              init?.signal?.addEventListener('abort', () =>
                controller.error(init.signal!.reason),
              );
            },
          }),
        )) as never,
    });
    const controller = new AbortController();
    const seen: string[] = [];
    for await (const event of client.events({ signal: controller.signal })) {
      seen.push(event.type);
      setTimeout(() => controller.abort(), 5);
    }
    expect(seen).toEqual(['server.connected']);
  });

  test('aborting while waiting for headers ends the iteration', async () => {
    const client = new OpenCodeServeClient({
      baseUrl: BASE,
      password: 'p',
      fetch: (async (_url: unknown, init?: RequestInit) =>
        new Promise((_, reject) =>
          init?.signal?.addEventListener('abort', () =>
            reject(init.signal!.reason),
          ),
        )) as never,
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);
    const seen: unknown[] = [];
    for await (const event of client.events({ signal: controller.signal }))
      seen.push(event);
    expect(seen).toEqual([]);
  });

  test('headers that never arrive count as a stall', async () => {
    const client = new OpenCodeServeClient({
      baseUrl: BASE,
      password: 'p',
      fetch: (async () => new Promise(() => undefined)) as never,
    });
    const read = async () => {
      for await (const _event of client.events({ connectTimeoutMs: 20 })) {
        // nothing arrives
      }
    };
    await expect(read()).rejects.toBeInstanceOf(
      OpenCodeEventStreamStalledError,
    );
  }, 2_000);
});

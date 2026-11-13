import { readFileSync } from 'node:fs';
import { describe, expect, test, vi } from 'vitest';
import {
  OpenCodeEventStreamStalledError,
  OpenCodeServeClient,
  OpenCodeServeDeniedPathError,
  OpenCodeServeHttpError,
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
    // Neighbours of denied prefixes are not caught by them.
    await client.request('GET', '/api/integration');
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
  });
});

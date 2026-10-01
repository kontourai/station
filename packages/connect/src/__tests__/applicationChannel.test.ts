// @vitest-environment node
import { describe, expect, test, vi } from 'vitest';
import {
  type ApplicationChannel,
  ApplicationChannelError,
  createApplicationChannelFetch,
  serveApplicationChannel,
} from '../core/applicationChannel.js';

function pair() {
  const listeners: Array<
    { message: (value: unknown) => void; closed: () => void } | undefined
  > = [];
  const sent: string[][] = [[], []];
  let closed = false;
  const channels = [0, 1].map(
    (index) =>
      ({
        send(message: string) {
          if (closed) throw new Error('Channel closed');
          sent[index]!.push(message);
          queueMicrotask(() => {
            if (!closed) listeners[1 - index]?.message(message);
          });
        },
        close() {
          if (closed) return;
          closed = true;
          queueMicrotask(() =>
            listeners.forEach((listener) => listener?.closed()),
          );
        },
        subscribe(message: (value: unknown) => void, onClose: () => void) {
          listeners[index] = { message, closed: onClose };
          return () => {
            listeners[index] = undefined;
          };
        },
      }) satisfies ApplicationChannel,
  );
  return {
    client: channels[0]!,
    server: channels[1]!,
    sent,
    isClosed: () => closed,
  };
}
function fixture(
  handler: (request: Request) => Promise<Response> | Response,
  options: {
    prepareRequest?: ApplicationChannel['prepareRequest'];
    assertCurrent?: () => void | Promise<void>;
  } = {},
) {
  const lifetime = new AbortController();
  const requests: Request[] = [];
  const pairs: ReturnType<typeof pair>[] = [];
  const open = vi.fn(async () => {
    const channels = pair();
    pairs.push(channels);
    serveApplicationChannel(channels.server, 'https://station.test', {
      signal: lifetime.signal,
      fetch: async (request) => {
        requests.push(request);
        return handler(request);
      },
    });
    return { ...channels.client, prepareRequest: options.prepareRequest };
  });
  const fetch = createApplicationChannelFetch({
    origin: 'https://station.test',
    signal: lifetime.signal,
    open,
    assertCurrent: options.assertCurrent ?? (() => {}),
  });
  return { fetch, requests, pairs, open, stop: () => lifetime.abort() };
}

describe('application channel request and streaming response', () => {
  test('round trips a mutation and its opaque account proof without interpreting authority', async () => {
    const h = fixture(async (request) =>
      Response.json({
        method: request.method,
        body: await request.text(),
        origin: request.headers.get('Origin'),
        proof: request.headers.get('X-Station-Account-Proof'),
      }),
    );
    const response = await h.fetch('https://station.test/api/projects', {
      method: 'POST',
      headers: {
        Origin: 'https://client.test',
        'X-Station-Account-Proof': 'opaque-sdk-proof',
      },
      body: '{"name":"project"}',
    });
    expect(await response.json()).toEqual({
      method: 'POST',
      body: '{"name":"project"}',
      origin: 'https://client.test',
      proof: 'opaque-sdk-proof',
    });
    expect(h.open).toHaveBeenCalledTimes(1);
    expect(h.requests).toHaveLength(1);
    h.stop();
  });
  test('prepares after opening and dispatches the original query, binary bytes and headers', async () => {
    const events: string[] = [];
    let entered!: () => void;
    const preparing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = fixture(
      async (request) => {
        events.push('dispatch');
        return Response.json({
          method: request.method,
          path: new URL(request.url).pathname + new URL(request.url).search,
          body: [...new Uint8Array(await request.arrayBuffer())],
          original: request.headers.get('X-Original'),
          proof: request.headers.get('X-Peer-Proof'),
        });
      },
      {
        prepareRequest: async (input) => {
          events.push('prepare');
          expect(input.method).toBe('POST');
          expect(input.path).toBe('/api/action?mode=exact%2Bbytes&n=2');
          expect([...input.body]).toEqual([0, 255, 128, 13, 10]);
          expect(input.headers.get('X-Original')).toBe('retained');
          expect(Reflect.set(input, 'method', 'DELETE')).toBe(false);
          expect(Reflect.set(input, 'path', '/changed')).toBe(false);
          input.body.fill(7);
          input.headers.set('X-Original', 'changed');
          entered();
          await held;
          events.push('prepared');
          return [['X-Peer-Proof', 'channel-owned-proof']];
        },
      },
    );
    const open = h.open.getMockImplementation()!;
    h.open.mockImplementation(async () => {
      events.push('open');
      return open();
    });
    const pending = h.fetch(
      'https://station.test/api/action?mode=exact%2Bbytes&n=2',
      {
        method: 'POST',
        headers: { 'X-Original': 'retained' },
        body: Uint8Array.of(0, 255, 128, 13, 10),
      },
    );
    await preparing;
    expect(events).toEqual(['open', 'prepare']);
    expect(h.pairs[0]!.sent[0]).toEqual([]);
    expect(h.requests).toHaveLength(0);
    release();
    const response = await pending;
    expect(await response.json()).toEqual({
      method: 'POST',
      path: '/api/action?mode=exact%2Bbytes&n=2',
      body: [0, 255, 128, 13, 10],
      original: 'retained',
      proof: 'channel-owned-proof',
    });
    expect(events).toEqual(['open', 'prepare', 'prepared', 'dispatch']);
    expect(h.open).toHaveBeenCalledTimes(1);
    h.stop();
  });

  test.each([
    {
      name: 'signer failure',
      prepare: async () => {
        throw new Error('signing failed');
      },
      error: 'signing failed',
    },
    {
      name: 'header collision',
      prepare: async () =>
        [['X-Station-Native-Device-Proof', 'overwrite']] as const,
      error: 'header_collision',
    },
    {
      name: 'frame limit',
      prepare: async () => [['X-Proof', 'x'.repeat(16385)]] as const,
      error: 'Application frame invalid',
    },
  ])(
    '$name during preparation closes without dispatch',
    async ({ prepare, error }) => {
      const h = fixture(() => Response.json({}), { prepareRequest: prepare });
      await expect(
        h.fetch('https://station.test/api/action', {
          headers: { 'x-station-native-device-proof': 'supplied-proof' },
        }),
      ).rejects.toThrow(error);
      expect(h.open).toHaveBeenCalledTimes(1);
      expect(h.pairs[0]!.sent[0]).toEqual([]);
      expect(h.requests).toHaveLength(0);
      expect(h.pairs[0]!.isClosed()).toBe(true);
      h.stop();
    },
  );

  test('caller abort closes a hanging preparation and ignores its late proof', async () => {
    let entered!: () => void;
    const preparing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finish!: (headers: readonly (readonly [string, string])[]) => void;
    const held = new Promise<readonly (readonly [string, string])[]>(
      (resolve) => {
        finish = resolve;
      },
    );
    let signal: AbortSignal | undefined;
    const h = fixture(() => Response.json({}), {
      prepareRequest: async (input) => {
        signal = input.signal;
        entered();
        return held;
      },
    });
    const controller = new AbortController();
    const reason = new Error('caller retired');
    const pending = h.fetch('https://station.test/api/action', {
      signal: controller.signal,
    });
    const rejected = expect(pending).rejects.toBe(reason);
    await preparing;
    controller.abort(reason);
    await rejected;
    expect(signal?.aborted).toBe(true);
    expect(h.pairs[0]!.isClosed()).toBe(true);
    finish([['X-Proof', 'late-proof']]);
    await held;
    expect(h.pairs[0]!.sent[0]).toEqual([]);
    expect(h.requests).toHaveLength(0);
    expect(h.open).toHaveBeenCalledTimes(1);
    h.stop();
  });

  test.each(['trust', 'authority'] as const)(
    'retired %s during preparation prevents dispatch',
    async (owner) => {
      let current = true;
      const check = () => {
        if (!current) throw new Error('authority retired');
      };
      let entered!: () => void;
      const preparing = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const h = fixture(() => Response.json({}), {
        assertCurrent: owner === 'trust' ? check : undefined,
        prepareRequest: async () => {
          entered();
          await held;
          return [['X-Proof', 'late-proof']];
        },
      });
      const pending = h.fetch('https://station.test/api/action', {
        authorityGuard: owner === 'authority' ? check : undefined,
      });
      const rejected = expect(pending).rejects.toThrow('authority retired');
      await preparing;
      current = false;
      release();
      await rejected;
      expect(h.pairs[0]!.sent[0]).toEqual([]);
      expect(h.requests).toHaveLength(0);
      expect(h.pairs[0]!.isClosed()).toBe(true);
      h.stop();
    },
  );

  test('streams binary content in bounded chunks only when consumed', async () => {
    const bytes = Uint8Array.from(
      { length: 120000 },
      (_, index) => index % 251,
    );
    const pull = vi.fn();
    const h = fixture(
      () =>
        new Response(
          new ReadableStream(
            {
              pull(controller) {
                pull();
                controller.enqueue(bytes);
                controller.close();
              },
            },
            { highWaterMark: 0 },
          ),
        ),
    );
    const response = await h.fetch('https://station.test/api/artifact');
    expect(pull).not.toHaveBeenCalled();
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    const chunks = h.pairs[0]!.sent[1]!.map((value) =>
      JSON.parse(value),
    ).filter((frame) => frame.type === 'chunk');
    expect(chunks).toHaveLength(8);
    expect(chunks.every((frame) => atob(frame.bytes).length <= 16384)).toBe(
      true,
    );
    h.stop();
  });
  test('refuses oversized request bodies and foreign targets before opening a channel', async () => {
    const h = fixture(() => Response.json({}));
    await expect(
      h.fetch('https://station.test/api/projects', {
        method: 'POST',
        body: 'x'.repeat(16385),
      }),
    ).rejects.toThrow('16 KiB');
    await expect(
      h.fetch('https://foreign.test/api/projects'),
    ).rejects.toMatchObject({ dispatched: false });
    expect(h.open).not.toHaveBeenCalled();
    h.stop();
  });
  test('cancellation settles a stalled opener and closes its eventual channel', async () => {
    const controller = new AbortController();
    const channels = pair();
    const close = vi.spyOn(channels.client, 'close');
    let finish!: (channel: ApplicationChannel) => void;
    const opened = new Promise<ApplicationChannel>((resolve) => {
      finish = resolve;
    });
    const open = vi.fn(() => opened);
    const fetch = createApplicationChannelFetch({
      origin: 'https://station.test',
      signal: controller.signal,
      open,
      assertCurrent: () => {},
    });
    const pending = fetch('https://station.test/api/projects');
    const rejected = expect(pending).rejects.toMatchObject({
      dispatched: false,
      code: 'cancelled',
    });
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    controller.abort();
    await rejected;
    finish(channels.client);
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(channels.sent[0]).toEqual([]);
  });
  test('lost trust after asynchronous channel opening sends no request', async () => {
    const channels = pair();
    const assertCurrent = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('revoked'));
    const fetch = createApplicationChannelFetch({
      origin: 'https://station.test',
      signal: new AbortController().signal,
      open: async () => channels.client,
      assertCurrent,
    });
    await expect(fetch('https://station.test/api/projects')).rejects.toThrow(
      'revoked',
    );
    expect(channels.sent[0]).toEqual([]);
  });
  test('a connection loss leaves a dispatched mutation uncertain and never retries it', async () => {
    const h = fixture(() => new Promise(() => {}));
    const pending = h.fetch('https://station.test/api/projects', {
      method: 'POST',
      body: '{}',
    });
    const rejected = expect(pending).rejects.toMatchObject({
      dispatched: true,
      code: 'transport_closed',
    });
    await vi.waitFor(() => expect(h.requests).toHaveLength(1));
    h.pairs[0]!.server.close();
    await rejected;
    expect(h.open).toHaveBeenCalledTimes(1);
    h.stop();
  });
  test('caller cancellation reaches the server request and a pending stream read', async () => {
    const cancelled = vi.fn();
    const h = fixture(
      () => new Response(new ReadableStream({ cancel: cancelled })),
    );
    const controller = new AbortController();
    const response = await h.fetch('https://station.test/api/events', {
      signal: controller.signal,
    });
    const next = response.body!.getReader().read();
    controller.abort();
    await expect(next).rejects.toMatchObject({
      dispatched: true,
      code: 'cancelled',
    });
    await vi.waitFor(() => expect(h.requests[0]?.signal.aborted).toBe(true));
    expect(cancelled).toHaveBeenCalledTimes(1);
    h.stop();
  });
  test('an empty producer cannot spin indefinitely without byte progress', async () => {
    const pull = vi.fn(
      (controller: ReadableStreamDefaultController<Uint8Array>) =>
        controller.enqueue(new Uint8Array(0)),
    );
    const h = fixture(
      () => new Response(new ReadableStream({ pull }, { highWaterMark: 0 })),
    );
    const response = await h.fetch('https://station.test/api/events');
    await expect(response.text()).rejects.toBeInstanceOf(
      ApplicationChannelError,
    );
    expect(pull.mock.calls.length).toBeLessThanOrEqual(16);
    h.stop();
  });
  test('cookie responses and server failures never become successful responses', async () => {
    const h = fixture(
      () =>
        new Response('secret', {
          headers: { 'Set-Cookie': 'account=secret; HttpOnly' },
        }),
    );
    await expect(
      h.fetch('https://station.test/api/projects'),
    ).rejects.toBeInstanceOf(ApplicationChannelError);
    h.stop();
  });
  test.each([204, 205, 304])('supports null-body status %i', async (status) => {
    const h = fixture(() => new Response(null, { status }));
    const response = await h.fetch('https://station.test/api/projects');
    expect(response.status).toBe(status);
    expect(response.body).toBeNull();
    h.stop();
  });
});

describe('application channel malformed peer boundaries', () => {
  test.each([
    { version: 'foreign', type: 'response', status: 200, headers: [] },
    { type: 'response', status: 0, headers: [] },
    {
      type: 'response',
      status: 200,
      headers: [['set-cookie', 'private=secret']],
    },
    {
      type: 'response',
      status: 200,
      headers: [
        ['x-name', 'a'],
        ['x-name', 'b'],
      ],
    },
    { type: 'chunk', bytes: 'eA==' },
    { type: 'response', status: 200, headers: [], extraAuthority: true },
  ])('refuses malformed or out-of-order response %j', async (malformed) => {
    const channels = pair();
    channels.server.subscribe(
      () =>
        channels.server.send(
          JSON.stringify({
            version: 'station.application-channel/v1',
            ...malformed,
          }),
        ),
      () => {},
    );
    const fetch = createApplicationChannelFetch({
      origin: 'https://station.test',
      signal: new AbortController().signal,
      open: async () => channels.client,
      assertCurrent: () => {},
    });
    await expect(
      fetch('https://station.test/api/projects'),
    ).rejects.toMatchObject({ dispatched: true, code: 'protocol_invalid' });
  });
  test('rejects a second mutation on an already used channel', async () => {
    const channels = pair();
    const handler = vi.fn(async () => new Response(null, { status: 204 }));
    const lifetime = new AbortController();
    serveApplicationChannel(channels.server, 'https://station.test', {
      signal: lifetime.signal,
      fetch: handler,
    });
    const frame = JSON.stringify({
      version: 'station.application-channel/v1',
      type: 'request',
      method: 'POST',
      path: '/api/projects',
      headers: [],
      body: null,
    });
    channels.client.send(frame);
    channels.client.send(frame);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    lifetime.abort();
  });
});

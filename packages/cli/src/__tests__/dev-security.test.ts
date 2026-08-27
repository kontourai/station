import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer, request as nodeHttpRequest } from 'node:http';
import {
  createServer as createHttpsServer,
  request as nodeHttpsRequest,
} from 'node:https';
import type { AddressInfo } from 'node:net';
import { describe, expect, test, vi } from 'vitest';
import {
  createPinnedLookup,
  DEV_HEADERS_TIMEOUT_MS,
  DEV_REQUEST_TIMEOUT_MS,
  DEV_SERVER_HOST,
  type DevFetchDependencies,
  FETCH_TIMEOUT_MS,
  isPublicIp,
  MAX_FETCH_REDIRECTS,
  MAX_FETCH_RESPONSE_BYTES,
  MAX_JSON_BODY_BYTES,
  MAX_RELOAD_CLIENTS,
  proxyPublicHttp,
  resolvePublicAddress,
  sanitizeProxyHeaders,
} from '../dev/security.js';

function localTransportDependencies(
  port: number,
  capture?: (url: URL, options: any) => void,
): DevFetchDependencies {
  const requestFactory = ((url: URL, options: any, callback: any) => {
    capture?.(url, options);
    return nodeHttpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path: `${url.pathname}${url.search}`,
        method: options.method,
        headers: { ...options.headers, Host: url.host },
      },
      callback,
    );
  }) as DevFetchDependencies['httpRequest'];
  return {
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    httpRequest: requestFactory,
    httpsRequest: requestFactory as DevFetchDependencies['httpsRequest'],
  };
}

describe('plugin dev security policy', () => {
  test('pinned lookup honors scalar and all-address callback overloads', async () => {
    const lookup = createPinnedLookup({ address: '127.0.0.1', family: 4 });
    const scalar = await new Promise<unknown[]>((resolve) =>
      (lookup as any)('logical.test', {}, (...args: unknown[]) =>
        resolve(args),
      ),
    );
    const all = await new Promise<unknown[]>((resolve) =>
      (lookup as any)('logical.test', { all: true }, (...args: unknown[]) =>
        resolve(args),
      ),
    );
    expect(scalar).toEqual([null, '127.0.0.1', 4]);
    expect(all).toEqual([null, [{ address: '127.0.0.1', family: 4 }]]);
  });

  test('real Node HTTP transport retains logical Host through the pinned lookup', async () => {
    let observedHost = '';
    const upstream = createServer((req, res) => {
      observedHost = req.headers.host || '';
      res.end('real-http');
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, '127.0.0.1', resolve),
    );
    const port = (upstream.address() as AddressInfo).port;
    let requestedAll = false;
    const pinnedLookup = createPinnedLookup({
      address: '127.0.0.1',
      family: 4,
    });
    try {
      const body = await new Promise<string>((resolve, reject) => {
        const req = nodeHttpRequest(
          new URL(`http://logical.test:${port}/transport`),
          {
            agent: false,
            autoSelectFamily: true,
            lookup: (hostname: string, options: any, callback: any) => {
              requestedAll = options?.all === true;
              (pinnedLookup as any)(hostname, options, callback);
            },
          } as any,
          (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => resolve(data));
          },
        );
        req.on('error', reject);
        req.end();
      });
      expect(body).toBe('real-http');
      expect(observedHost).toBe(`logical.test:${port}`);
      expect(requestedAll).toBe(true);
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  test('real Node HTTPS transport verifies logical SAN/SNI through the pinned lookup', async () => {
    const cert = readFileSync(
      new URL('./fixtures/logical.test-cert.pem', import.meta.url),
    );
    const key = readFileSync(
      new URL('./fixtures/logical.test-key.pem', import.meta.url),
    );
    let observedHost = '';
    let observedSni = '';
    const upstream = createHttpsServer({ cert, key }, (req, res) => {
      observedHost = req.headers.host || '';
      res.end('real-https');
    });
    upstream.on('secureConnection', (socket) => {
      observedSni = socket.servername || '';
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, '127.0.0.1', resolve),
    );
    const port = (upstream.address() as AddressInfo).port;
    try {
      const body = await new Promise<string>((resolve, reject) => {
        const req = nodeHttpsRequest(
          new URL(`https://logical.test:${port}/transport`),
          {
            agent: false,
            autoSelectFamily: true,
            ca: cert,
            lookup: createPinnedLookup({ address: '127.0.0.1', family: 4 }),
            rejectUnauthorized: true,
            servername: 'logical.test',
          } as any,
          (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => resolve(data));
          },
        );
        req.on('error', reject);
        req.end();
      });
      expect(body).toBe('real-https');
      expect(observedHost).toBe(`logical.test:${port}`);
      expect(observedSni).toBe('logical.test');
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
  test('exports the binding limits', () => {
    expect({
      DEV_SERVER_HOST,
      MAX_JSON_BODY_BYTES,
      MAX_FETCH_RESPONSE_BYTES,
      FETCH_TIMEOUT_MS,
      MAX_FETCH_REDIRECTS,
      MAX_RELOAD_CLIENTS,
      DEV_HEADERS_TIMEOUT_MS,
      DEV_REQUEST_TIMEOUT_MS,
    }).toEqual({
      DEV_SERVER_HOST: '127.0.0.1',
      MAX_JSON_BODY_BYTES: 1_048_576,
      MAX_FETCH_RESPONSE_BYTES: 10_485_760,
      FETCH_TIMEOUT_MS: 10_000,
      MAX_FETCH_REDIRECTS: 5,
      MAX_RELOAD_CLIENTS: 32,
      DEV_HEADERS_TIMEOUT_MS: 10_000,
      DEV_REQUEST_TIMEOUT_MS: 15_000,
    });
  });

  test.each([
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.0.1',
    '198.18.0.1',
    '192.0.2.1',
    '224.0.0.1',
    '240.0.0.1',
    '::',
    '::1',
    'fc00::1',
    'fe80::1',
    '2001:db8::1',
    '2001::1',
    '2001:2::1',
    '2001:10::1',
    '2001:20::1',
    '2002::1',
    '64:ff9b::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:192.168.1.1',
    '::ffff:7f00:1',
    '::ffff:c0a8:101',
    '2606:4700:4700::1111%en0',
  ])('rejects non-public address %s', (address) => {
    expect(isPublicIp(address)).toBe(false);
  });

  test.each([
    '8.8.8.8',
    '1.1.1.1',
    '2606:4700:4700::1111',
    '2606:4700:4700:0000:0000:0000:0000:1111',
  ])('allows public address %s', (address) => {
    expect(isPublicIp(address)).toBe(true);
  });

  test('rejects the complete DNS target if any answer is private', async () => {
    const dependencies = {
      lookup: async () => [
        { address: '8.8.8.8', family: 4 as const },
        { address: '127.0.0.1', family: 4 as const },
      ],
    } as unknown as DevFetchDependencies;
    await expect(
      resolvePublicAddress('mixed.example', dependencies),
    ).rejects.toMatchObject({
      status: 403,
      code: 'disallowed_target',
    });
  });

  test('strips credentials and hop-by-hop headers case-insensitively', () => {
    expect(
      sanitizeProxyHeaders({
        Authorization: 'secret',
        Cookie: 'session=secret',
        HOST: 'evil',
        Connection: 'upgrade',
        'X-Safe': 'yes',
        TE: 'trailers',
      }),
    ).toEqual({ 'Accept-Encoding': 'identity', 'X-Safe': 'yes' });
  });

  test.each([
    'FC00:0:0:0:0:0:0:1',
    'fd00:0000:0000:0000:0000:0000:0000:0001',
    'FE80::1%en0',
    '2001:0DB8:0000:0000:0000:0000:0000:0001',
    '2001:DB8::1',
    '0:0:0:0:0:ffff:7f00:1',
    '::FFFF:127.0.0.1',
    '0:0:0:0:0:ffff:c0a8:101',
  ])('numerically rejects alternate IPv6 spelling %s', (address) => {
    expect(isPublicIp(address)).toBe(false);
  });

  test('the per-hop deadline includes stalled DNS lookup', async () => {
    vi.useFakeTimers();
    const hanging = new Promise<never>(() => {});
    const dependencies = {
      lookup: () => hanging,
      httpRequest: vi.fn(),
      httpsRequest: vi.fn(),
    } as unknown as DevFetchDependencies;
    const pending = proxyPublicHttp(
      { url: 'http://stalled.example/' },
      dependencies,
    );
    const assertion = expect(pending).rejects.toMatchObject({
      status: 504,
      code: 'upstream_timeout',
    });
    await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS);
    await assertion;
    expect(dependencies.httpRequest).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  test.each([
    [{ url: 'http://public.example', method: 42 }, 'invalid_method'],
    [{ url: 'http://public.example', method: 'BAD METHOD' }, 'invalid_method'],
    [{ url: 'http://public.example', headers: [] }, 'invalid_headers'],
    [
      { url: 'http://public.example', headers: { Good: 42 } },
      'invalid_headers',
    ],
    [
      { url: 'http://public.example', headers: { 'Bad Header': 'x' } },
      'invalid_headers',
    ],
    [
      { url: 'http://public.example', headers: { Good: 'bad\r\nvalue' } },
      'invalid_headers',
    ],
    [{ url: 'http://public.example', body: 1n }, 'invalid_body'],
  ])(
    'rejects malformed proxy shape %# with stable 400',
    async (input, code) => {
      await expect(proxyPublicHttp(input as any)).rejects.toMatchObject({
        status: 400,
        code,
      });
    },
  );

  test('pins the validated address into the actual request lookup and preserves the logical Host', async () => {
    let receivedHost = '';
    let pinned: unknown;
    const upstream = createServer((req, res) => {
      receivedHost = req.headers.host || '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, '127.0.0.1', resolve),
    );
    const port = (upstream.address() as AddressInfo).port;
    const requestFactory = ((url: URL, options: any, callback: any) => {
      options.lookup(
        url.hostname,
        {},
        (_error: unknown, address: string, family: number) => {
          pinned = { address, family };
        },
      );
      return nodeHttpRequest(
        {
          hostname: '127.0.0.1',
          port,
          path: url.pathname,
          method: options.method,
          headers: { ...options.headers, Host: url.host },
        },
        callback,
      );
    }) as DevFetchDependencies['httpRequest'];
    const dependencies = {
      lookup: async () => [{ address: '8.8.8.8', family: 4 as const }],
      httpRequest: requestFactory,
      httpsRequest: requestFactory as DevFetchDependencies['httpsRequest'],
    };
    try {
      await expect(
        proxyPublicHttp({ url: 'http://public.example/data' }, dependencies),
      ).resolves.toEqual({
        success: true,
        status: 200,
        contentType: 'application/json',
        body: '{"ok":true}',
      });
      expect(pinned).toEqual({ address: '8.8.8.8', family: 4 });
      expect(receivedHost).toBe('public.example');
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  test('revalidates redirect DNS and rejects a redirect to a private answer', async () => {
    const upstream = createServer((_req, res) => {
      res.writeHead(302, { Location: 'http://private.example/secret' });
      res.end();
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, '127.0.0.1', resolve),
    );
    const port = (upstream.address() as AddressInfo).port;
    const requestFactory = ((url: URL, options: any, callback: any) =>
      nodeHttpRequest(
        {
          hostname: '127.0.0.1',
          port,
          path: url.pathname,
          method: options.method,
        },
        callback,
      )) as DevFetchDependencies['httpRequest'];
    const dependencies: DevFetchDependencies = {
      lookup: async (hostname) => [
        {
          address: hostname === 'private.example' ? '127.0.0.1' : '8.8.8.8',
          family: 4,
        },
      ],
      httpRequest: requestFactory,
      httpsRequest: requestFactory as DevFetchDependencies['httpsRequest'],
    };
    try {
      await expect(
        proxyPublicHttp({ url: 'http://public.example/start' }, dependencies),
      ).rejects.toMatchObject({
        status: 403,
        code: 'disallowed_target',
      });
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  test.each([
    [301, 'GET', ''],
    [302, 'GET', ''],
    [303, 'GET', ''],
    [307, 'POST', 'payload'],
    [308, 'POST', 'payload'],
  ])(
    'follows relative %s redirect with %s semantics',
    async (status, expectedMethod, expectedBody) => {
      let observed = { body: '', method: '' };
      const upstream = createServer((req, res) => {
        if (req.url === '/start') {
          res.writeHead(status, { Location: '/next' });
          res.end();
          return;
        }
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          observed = { body, method: req.method || '' };
          res.end('done');
        });
      });
      await new Promise<void>((resolve) =>
        upstream.listen(0, '127.0.0.1', resolve),
      );
      const port = (upstream.address() as AddressInfo).port;
      try {
        await proxyPublicHttp(
          {
            url: 'http://public.example/start',
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: 'payload',
          },
          localTransportDependencies(port),
        );
        expect(observed).toEqual({
          body: expectedBody,
          method: expectedMethod,
        });
      } finally {
        await new Promise<void>((resolve) => upstream.close(() => resolve()));
      }
    },
  );

  test('caps redirects after five followed hops', async () => {
    const upstream = createServer((req, res) => {
      const hop = Number(
        new URL(req.url || '/', 'http://local').searchParams.get('hop') || 0,
      );
      res.writeHead(302, { Location: `/loop?hop=${hop + 1}` });
      res.end();
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, '127.0.0.1', resolve),
    );
    const port = (upstream.address() as AddressInfo).port;
    try {
      await expect(
        proxyPublicHttp(
          { url: 'http://public.example/loop?hop=0' },
          localTransportDependencies(port),
        ),
      ).rejects.toMatchObject({ status: 502, code: 'too_many_redirects' });
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  test('forces identity encoding and does not expose upstream response headers', async () => {
    let acceptEncoding = '';
    const upstream = createServer((req, res) => {
      acceptEncoding = String(req.headers['accept-encoding'] || '');
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'Set-Cookie': 'secret=value',
        'X-Internal': 'secret',
      });
      res.end('identity body');
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, '127.0.0.1', resolve),
    );
    const port = (upstream.address() as AddressInfo).port;
    try {
      const result = await proxyPublicHttp(
        {
          url: 'http://public.example/',
          headers: { 'Accept-Encoding': 'gzip' },
        },
        localTransportDependencies(port),
      );
      expect(acceptEncoding).toBe('identity');
      expect(result).toEqual({
        success: true,
        status: 200,
        contentType: 'text/plain',
        body: 'identity body',
      });
      expect(result).not.toHaveProperty('headers');
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  test('rejects encoded and oversized upstream responses', async () => {
    const upstream = createServer((req, res) => {
      if (req.url === '/encoded') {
        res.writeHead(200, { 'Content-Encoding': 'gzip' });
        res.end('compressed');
      } else {
        res.end(Buffer.alloc(MAX_FETCH_RESPONSE_BYTES + 1, 97));
      }
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, '127.0.0.1', resolve),
    );
    const port = (upstream.address() as AddressInfo).port;
    try {
      await expect(
        proxyPublicHttp(
          { url: 'http://public.example/encoded' },
          localTransportDependencies(port),
        ),
      ).rejects.toMatchObject({
        status: 502,
        code: 'unsupported_content_encoding',
      });
      await expect(
        proxyPublicHttp(
          { url: 'http://public.example/large' },
          localTransportDependencies(port),
        ),
      ).rejects.toMatchObject({ status: 502, code: 'response_too_large' });
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  test('uses the HTTPS factory with the original hostname and pinned lookup', async () => {
    const upstream = createServer((_req, res) => res.end('secure seam'));
    await new Promise<void>((resolve) =>
      upstream.listen(0, '127.0.0.1', resolve),
    );
    const port = (upstream.address() as AddressInfo).port;
    const observed: {
      hostname?: string;
      pinned?: unknown;
      protocol?: string;
      rejectUnauthorized?: boolean;
      servername?: string;
    } = {};
    const dependencies = localTransportDependencies(port, (url, options) => {
      observed.hostname = url.hostname;
      observed.protocol = url.protocol;
      observed.rejectUnauthorized = options.rejectUnauthorized;
      observed.servername = options.servername;
      options.lookup(
        url.hostname,
        {},
        (_error: unknown, address: string, family: number) => {
          observed.pinned = { address, family };
        },
      );
    });
    try {
      await proxyPublicHttp(
        { url: 'https://secure.example/path' },
        dependencies,
      );
      expect(observed).toEqual({
        hostname: 'secure.example',
        protocol: 'https:',
        pinned: { address: '8.8.8.8', family: 4 },
        rejectUnauthorized: true,
        servername: 'secure.example',
      });
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  test.each(['error', 'aborted', 'close'])(
    'settles once and cleans the deadline after response %s',
    async (event) => {
      vi.useFakeTimers();
      const fakeRequest = new EventEmitter() as any;
      fakeRequest.write = vi.fn();
      fakeRequest.end = vi.fn();
      fakeRequest.destroy = vi.fn();
      const response = new EventEmitter() as any;
      response.headers = {};
      response.statusCode = 200;
      response.destroy = vi.fn();
      const requestFactory = vi.fn((_url, _options, callback) => {
        queueMicrotask(() => {
          callback(response);
          response.emit(
            event,
            ...(event === 'error' ? [new Error('upstream')] : []),
          );
          response.emit('close');
        });
        return fakeRequest;
      });
      const dependencies = {
        lookup: async () => [{ address: '8.8.8.8', family: 4 }],
        httpRequest: requestFactory,
        httpsRequest: requestFactory,
      } as unknown as DevFetchDependencies;
      await expect(
        proxyPublicHttp({ url: 'http://public.example/' }, dependencies),
      ).rejects.toMatchObject({ status: 502, code: 'upstream_error' });
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
    },
  );

  test('times out a connected request that never receives a response', async () => {
    vi.useFakeTimers();
    const fakeRequest = new EventEmitter() as any;
    fakeRequest.write = vi.fn();
    fakeRequest.end = vi.fn();
    fakeRequest.destroy = vi.fn();
    const dependencies = {
      lookup: async () => [{ address: '8.8.8.8', family: 4 }],
      httpRequest: vi.fn(() => fakeRequest),
      httpsRequest: vi.fn(() => fakeRequest),
    } as unknown as DevFetchDependencies;
    const pending = proxyPublicHttp(
      { url: 'http://public.example/' },
      dependencies,
    );
    const assertion = expect(pending).rejects.toMatchObject({
      status: 504,
      code: 'upstream_timeout',
    });
    await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS);
    await assertion;
    expect(fakeRequest.destroy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  test.each(['file:///etc/passwd', 'http://user:secret@public.example/'])(
    'rejects disallowed URL %s',
    async (url) => {
      await expect(proxyPublicHttp({ url })).rejects.toMatchObject({
        status: 403,
        code: 'disallowed_target',
      });
    },
  );

  test.each(['http://127.0.0.1/', 'http://[::1]/', 'http://[::ffff:7f00:1]/'])(
    'rejects literal private target %s before creating a request',
    async (url) => {
      await expect(proxyPublicHttp({ url })).rejects.toMatchObject({
        status: 403,
        code: 'disallowed_target',
      });
    },
  );
});

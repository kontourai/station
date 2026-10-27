import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { ifNoneMatchIncludes, jsonRevalidation } from '../conditional-get.js';

describe('ifNoneMatchIncludes', () => {
  test('compares weakly, across a list, and honours *', () => {
    expect(ifNoneMatchIncludes('"a"', '"a"')).toBe(true);
    expect(ifNoneMatchIncludes('W/"a"', '"a"')).toBe(true);
    expect(ifNoneMatchIncludes('"b", W/"a"', 'W/"a"')).toBe(true);
    expect(ifNoneMatchIncludes('*', '"a"')).toBe(true);
    expect(ifNoneMatchIncludes('"b"', '"a"')).toBe(false);
    expect(ifNoneMatchIncludes(undefined, '"a"')).toBe(false);
  });
});

describe('jsonRevalidation', () => {
  function app() {
    let body: unknown = { sessions: [1, 2, 3] };
    const server = new Hono();
    server.use('*', jsonRevalidation());
    server.get('/json', (c) => c.json(body as object));
    server.post('/json', (c) => c.json(body as object));
    server.get('/missing', (c) => c.json({ error: 'gone' }, 404));
    server.get('/own', (c) => c.json({ a: 1 }, 200, { ETag: '"own"' }));
    server.get('/private', (c) =>
      c.json({ token: 'x' }, 200, { 'Cache-Control': 'no-store' }),
    );
    server.get('/varied', (c) => {
      c.header('Vary', 'Origin');
      return c.json({ a: 1 });
    });
    server.get('/cookie-varied', (c) =>
      c.json({ a: 1 }, 200, { Vary: 'cookie' }),
    );
    // A passed-through `fetch` response has immutable headers.
    server.get('/proxied', () =>
      fetch('data:application/json,%7B%22a%22%3A1%7D'),
    );
    server.get('/stream', (c) =>
      c.body('data: 1\n\n', 200, { 'Content-Type': 'text/event-stream' }),
    );
    return {
      server,
      setBody: (next: unknown) => {
        body = next;
      },
    };
  }

  test('an unchanged read revalidates to an empty 304 with the same headers', async () => {
    const { server } = app();
    const first = await server.request('/json');
    const etag = first.headers.get('etag');
    expect(first.status).toBe(200);
    expect(etag).toMatch(/^W\/"[\w-]{32}"$/);
    expect(first.headers.get('cache-control')).toBe('private, no-cache');
    expect(first.headers.get('vary')).toBe('Authorization, Cookie');

    const again = await server.request('/json', {
      headers: { 'If-None-Match': etag! },
    });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe('');
    expect(again.headers.get('etag')).toBe(etag);
    expect(again.headers.get('content-length')).toBeNull();
    expect(again.headers.get('vary')).toBe('Authorization, Cookie');
  });

  test('a changed body is sent whole under a new tag', async () => {
    const { server, setBody } = app();
    const etag = (await server.request('/json')).headers.get('etag')!;
    setBody({ sessions: [1, 2, 3, 4] });
    const changed = await server.request('/json', {
      headers: { 'If-None-Match': etag },
    });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toEqual({ sessions: [1, 2, 3, 4] });
    expect(changed.headers.get('etag')).not.toBe(etag);
  });

  test("keeps the credential headers in Vary beside a handler's own", async () => {
    const { server } = app();
    const first = await server.request('/varied');
    expect(first.headers.get('vary')).toBe('Origin, Authorization, Cookie');
    const again = await server.request('/varied', {
      headers: { 'If-None-Match': first.headers.get('etag')! },
    });
    expect(again.status).toBe(304);
    // The 304 must name every header the 200 varied on, or a cache that
    // updates its stored copy from it would forget the credentials.
    expect(again.headers.get('vary')).toBe('Origin, Authorization, Cookie');
    expect((await server.request('/cookie-varied')).headers.get('vary')).toBe(
      'cookie, Authorization',
    );
  });

  test('revalidates a response passed through from fetch', async () => {
    const { server } = app();
    const first = await server.request('/proxied');
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ a: 1 });
    const again = await server.request('/proxied', {
      headers: { 'If-None-Match': first.headers.get('etag')! },
    });
    expect(again.status).toBe(304);
  });

  test('leaves writes, errors, own validators, no-store and streams alone', async () => {
    const { server } = app();
    const etagFor = async (path: string, method = 'GET') =>
      (await server.request(path, { method })).headers.get('etag');
    expect(await etagFor('/json', 'POST')).toBeNull();
    expect(await etagFor('/missing')).toBeNull();
    expect(await etagFor('/own')).toBe('"own"');
    expect(await etagFor('/private')).toBeNull();
    expect(await etagFor('/stream')).toBeNull();
  });
});

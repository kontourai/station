import { describe, expect, test } from 'vitest';
import { createCatalogByteBudget, readBoundedJson } from '../catalog-http.js';

describe('readBoundedJson', () => {
  test('rejects a declared response larger than the configured byte budget', async () => {
    const response = new Response('{"models":[]}', {
      status: 200,
      headers: { 'content-length': '4096' },
    });

    await expect(
      readBoundedJson(response, { maxResponseBytes: 32 }),
    ).rejects.toThrow('byte limit');
  });

  test('rejects a streamed response once it crosses the byte budget', async () => {
    const response = new Response('x'.repeat(64), { status: 200 });

    await expect(
      readBoundedJson(response, { maxResponseBytes: 16 }),
    ).rejects.toThrow('byte limit');
  });

  test('shares one byte budget across paginated responses', async () => {
    const options = { maxResponseBytes: 10 };
    const budget = createCatalogByteBudget(options);

    await expect(
      readBoundedJson(new Response('{"a":1}'), options, budget),
    ).resolves.toEqual({ a: 1 });
    await expect(
      readBoundedJson(new Response('{"b":2}'), options, budget),
    ).rejects.toThrow('byte limit');
  });

  test('cancels an unsuccessful response body before rejecting', async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      { status: 503 },
    );

    await expect(readBoundedJson(response)).rejects.toThrow('HTTP 503');
    expect(cancelled).toBe(true);
  });
});

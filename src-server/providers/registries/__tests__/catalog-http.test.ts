import { describe, expect, test } from 'vitest';
import {
  createCatalogByteBudget,
  DEFAULT_MODEL_CATALOG_MAX_RESPONSE_BYTES,
  readBoundedJson,
} from '../catalog-http.js';

describe('readBoundedJson', () => {
  test('keeps the hard streaming ceiling when a requested byte limit is NaN', async () => {
    const response = new Response(
      `${' '.repeat(DEFAULT_MODEL_CATALOG_MAX_RESPONSE_BYTES + 1)}{}`,
    );
    await expect(
      readBoundedJson(response, { maxResponseBytes: Number.NaN }),
    ).rejects.toThrow('byte limit');
  });

  test('keeps the cumulative ceiling when the shared budget was requested with NaN', async () => {
    const budget = createCatalogByteBudget({ maxResponseBytes: Number.NaN });
    await expect(
      readBoundedJson(new Response('{}'), undefined, budget),
    ).resolves.toEqual({});
    const response = new Response(
      `${' '.repeat(DEFAULT_MODEL_CATALOG_MAX_RESPONSE_BYTES - 2)}{}`,
    );
    await expect(readBoundedJson(response, undefined, budget)).rejects.toThrow(
      'byte limit',
    );
  });

  test.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects and cancels a response when its shared budget is %s',
    async (remainingBytes) => {
      let cancelled = false;
      const response = new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{}'));
            controller.close();
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
      await expect(
        readBoundedJson(response, undefined, { remainingBytes }),
      ).rejects.toThrow('byte limit');
      expect(cancelled).toBe(true);
    },
  );

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

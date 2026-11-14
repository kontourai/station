/**
 * The vendor HTTP client's bounds: an answer larger than Station reads is
 * refused whether the vendor declares its length or streams it, and an
 * oversized error body is read only as far as its cap.
 */
import { describe, expect, test } from 'vitest';
import { RemoteTaskError } from '../remote-task-error.js';
import { VENDOR_RESPONSE_MAX_BYTES, VendorHttp } from '../vendor-http.js';

const TOKEN = 'secret_token_0123456789';

function client(respond: () => Response) {
  let calls = 0;
  const http = new VendorHttp({
    vendorName: 'Vendor',
    baseUrl: 'https://vendor.example',
    headers: { authorization: `Bearer ${TOKEN}` },
    secret: TOKEN,
    fetch: async () => {
      calls += 1;
      return respond();
    },
    now: () => 0,
    readError: (body) => {
      const record = (body ?? {}) as { message?: unknown };
      return typeof record.message === 'string'
        ? { message: record.message }
        : {};
    },
  });
  return { http, calls: () => calls };
}

/** A body streamed in chunks, with no length declared. */
function streamed(bytes: number, status = 200): Response {
  const chunk = new Uint8Array(64 * 1024).fill(0x20);
  let sent = 0;
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      if (sent >= bytes) return controller.close();
      const size = Math.min(chunk.byteLength, bytes - sent);
      sent += size;
      controller.enqueue(chunk.subarray(0, size));
    },
  });
  const response = new Response(body, { status });
  Object.defineProperty(response, 'pulled', { get: () => pulled });
  return response;
}

describe('VendorHttp bounds', () => {
  test('a streamed answer over the cap is refused without reading it all', async () => {
    let response: Response | undefined;
    const { http } = client(() => {
      response = streamed(VENDOR_RESPONSE_MAX_BYTES * 3);
      return response;
    });
    const error = await http
      .json({ method: 'GET', path: '/big' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RemoteTaskError);
    expect(error).toMatchObject({
      code: 'remote-task-vendor-malformed',
      status: 502,
    });
    // Reading stopped just past the cap, not at the end of the body.
    const pulled = (response as unknown as { pulled: number }).pulled;
    expect(pulled).toBeLessThan((VENDOR_RESPONSE_MAX_BYTES * 3) / (64 * 1024));
  });

  test('an answer just under the cap is read', async () => {
    const payload = JSON.stringify({
      text: 'x'.repeat(VENDOR_RESPONSE_MAX_BYTES - 100),
    });
    const { http } = client(() => new Response(payload, { status: 200 }));
    const { body } = await http.json({ method: 'GET', path: '/ok' });
    expect((body as { text: string }).text).toHaveLength(
      VENDOR_RESPONSE_MAX_BYTES - 100,
    );
  });

  test('a declared length over the cap is refused before the body is read', async () => {
    let read = false;
    const { http } = client(() => {
      // highWaterMark 0: pull runs only when someone reads.
      const body = new ReadableStream<Uint8Array>(
        {
          pull() {
            read = true;
          },
        },
        { highWaterMark: 0 },
      );
      return new Response(body, {
        status: 200,
        headers: { 'content-length': String(VENDOR_RESPONSE_MAX_BYTES + 1) },
      });
    });
    await expect(
      http.json({ method: 'GET', path: '/declared' }),
    ).rejects.toMatchObject({
      code: 'remote-task-vendor-malformed',
    });
    expect(read).toBe(false);
  });

  test('an error body over its cap is not parsed; the refusal stays generic', async () => {
    const huge = JSON.stringify({ message: 'y'.repeat(200 * 1024) });
    const { http } = client(() => new Response(huge, { status: 400 }));
    const error = (await http
      .json({ method: 'GET', path: '/bad' })
      .catch((caught: unknown) => caught)) as RemoteTaskError;
    expect(error.code).toBe('remote-task-vendor-refused');
    expect(error.message).toBe('Vendor refused the request (400).');
  });
});

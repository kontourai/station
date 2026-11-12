import { describe, expect, test } from 'vitest';
import {
  readBoundedRequestBody,
  readBoundedRequestBodyBytes,
} from '../bounded-request-body.js';

function streamedRequest(stream: ReadableStream<Uint8Array>): Request {
  return new Request('https://station.example.test/api/hook', {
    method: 'POST',
    body: stream,
    duplex: 'half',
  } as RequestInit);
}

describe('readBoundedRequestBody', () => {
  test('joins a multibyte character split across body chunks', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.of(0xf0, 0x9f));
        controller.enqueue(Uint8Array.of(0x8c, 0x90));
        controller.close();
      },
    });
    const request = new Request('https://station.example.test/api/pairing', {
      method: 'POST',
      body: stream,
      duplex: 'half',
    } as RequestInit);

    await expect(readBoundedRequestBody(request, 4096)).resolves.toEqual({
      status: 'ok',
      body: '🌐',
    });
    expect(request.body?.locked).toBe(false);
  });

  test('cancels an unfinished invalid UTF-8 stream and releases its reader lock', async () => {
    let cancelled = false;
    let sent = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(Uint8Array.of(0xff));
        } else {
          return new Promise<void>(() => {});
        }
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request('https://station.example.test/api/pairing', {
      method: 'POST',
      body: stream,
      duplex: 'half',
    } as RequestInit);

    await expect(readBoundedRequestBody(request, 4096)).resolves.toEqual({
      status: 'invalid',
    });
    expect(cancelled).toBe(true);
    expect(request.body?.locked).toBe(false);
  });
});

describe('readBoundedRequestBodyBytes', () => {
  test('returns the exact bytes of a chunked body and releases the reader', async () => {
    const request = streamedRequest(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Uint8Array.of(1, 2));
          controller.enqueue(Uint8Array.of(0xff, 4));
          controller.close();
        },
      }),
    );

    await expect(readBoundedRequestBodyBytes(request, 4)).resolves.toEqual({
      status: 'ok',
      bytes: Uint8Array.of(1, 2, 0xff, 4),
    });
    expect(request.body?.locked).toBe(false);
  });

  test('reports a request with no body stream as no-body', async () => {
    const request = new Request('https://station.example.test/api/hook');
    await expect(readBoundedRequestBodyBytes(request, 16)).resolves.toEqual({
      status: 'no-body',
    });
  });

  test('cancels at the first byte past the limit without trusting any declared length', async () => {
    let cancelled = false;
    let sent = 0;
    const request = streamedRequest(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          sent += 1;
          controller.enqueue(new Uint8Array(3));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );

    await expect(readBoundedRequestBodyBytes(request, 4)).resolves.toEqual({
      status: 'too-large',
    });
    expect(cancelled).toBe(true);
    // Five bytes were enough to refuse; the unbounded source was not drained.
    expect(sent).toBeLessThan(10);
    expect(request.body?.locked).toBe(false);
  });

  test('a body that fails part-way is invalid, not a rejection, and releases the reader', async () => {
    let sent = false;
    const request = streamedRequest(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(Uint8Array.of(1));
          } else {
            controller.error(new Error('client went away'));
          }
        },
      }),
    );

    await expect(readBoundedRequestBodyBytes(request, 4096)).resolves.toEqual({
      status: 'invalid',
    });
    expect(request.body?.locked).toBe(false);
  });
});

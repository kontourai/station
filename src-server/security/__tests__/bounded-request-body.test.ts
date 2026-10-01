import { describe, expect, test } from 'vitest';
import { readBoundedRequestBody } from '../bounded-request-body.js';

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

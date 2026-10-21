import assert from 'node:assert/strict';
import { test } from 'vitest';
import { readRawProviderSse } from '../bounded-api-sse-response.js';

const limits = { maxBytes: 4096, maxFrameBytes: 1024, maxFrames: 8 };
const signal = () => new AbortController().signal;
function response(text: string, bytewise = false) {
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream({
      start(c) {
        if (bytewise) for (const byte of bytes) c.enqueue(Uint8Array.of(byte));
        else c.enqueue(bytes);
        c.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream; charset=utf-8' } },
  );
}
test('retains raw provider fields through split UTF8 and CRLF frames', async () => {
  const data = {
    type: 'message_start',
    message: { model: 'é', usage: { input_tokens: 3 }, unknown_scope: true },
  };
  const frames = await readRawProviderSse(
    response(
      `: keepalive\r\n\r\nevent: message_start\r\ndata: ${JSON.stringify(data)}\r\n\r\n`,
      true,
    ),
    limits,
    signal(),
  );
  assert.deepEqual(frames, [{ event: 'message_start', data }]);
});
test('refuses incomplete terminal frame and malformed UTF8', async () => {
  await assert.rejects(
    readRawProviderSse(response('data: {}\n'), limits, signal()),
    { code: 'usage_unknown' },
  );
  const bad = new Response(Uint8Array.of(0xff), {
    headers: { 'content-type': 'text/event-stream' },
  });
  await assert.rejects(readRawProviderSse(bad, limits, signal()), {
    code: 'usage_unknown',
  });
});
test('caps valid complete bytes independently from frame size', async () => {
  const text = 'data: {"x":"' + 'a'.repeat(50) + '"}\n\n';
  await assert.rejects(
    readRawProviderSse(response(text), { ...limits, maxBytes: 32 }, signal()),
    { code: 'usage_unknown' },
  );
});
test('caps unterminated frames before EOF', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode('data: ' + 'a'.repeat(100)));
    },
    cancel() {
      cancelled = true;
      return new Promise(() => {});
    },
  });
  await assert.rejects(
    readRawProviderSse(
      new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
      { ...limits, maxFrameBytes: 32 },
      signal(),
    ),
    { code: 'usage_unknown' },
  );
  assert.equal(cancelled, true);
});
test('caps complete frame count and refuses nonobject JSON', async () => {
  await assert.rejects(
    readRawProviderSse(
      response('data: {}\n\ndata: {}\n\n'),
      { ...limits, maxFrames: 1 },
      signal(),
    ),
    { code: 'usage_unknown' },
  );
  await assert.rejects(
    readRawProviderSse(response('data: null\n\n'), limits, signal()),
    { code: 'usage_unknown' },
  );
});
test('abort settles a stalled read without trusting remote cancel completion', async () => {
  const controller = new AbortController();
  const body = new ReadableStream({
    cancel() {
      return new Promise(() => {});
    },
  });
  const pending = readRawProviderSse(
    new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    limits,
    controller.signal,
  );
  controller.abort();
  await assert.rejects(pending, { code: 'usage_unknown' });
});
test('non-success HTTP status cannot qualify an otherwise complete SSE body', async () => {
  const source = response('data: {}\n\n');
  const failed = new Response(source.body, {
    status: 500,
    headers: source.headers,
  });
  await assert.rejects(readRawProviderSse(failed, limits, signal()), {
    code: 'usage_unknown',
  });
});

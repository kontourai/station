import assert from 'node:assert/strict';
import { test } from 'vitest';
import { observeRawProviderSseResponse } from '../bounded-api-sse-response.js';

const limits = { maxBytes: 4096, maxFrameBytes: 1024, maxFrames: 8 };
function bodyOf(response: Response): ReadableStream<Uint8Array> {
  assert.ok(response.body);
  return response.body;
}
function source() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let pulls = 0,
    cancelled = 0;
  const response = new Response(
    new ReadableStream<Uint8Array>(
      {
        start(c) {
          controller = c;
        },
        pull() {
          pulls++;
        },
        cancel() {
          cancelled++;
          return new Promise(() => {});
        },
      },
      { highWaterMark: 0 },
    ),
    { headers: { 'content-type': 'text/event-stream' } },
  );
  return {
    response,
    controller,
    get pulls() {
      return pulls;
    },
    get cancelled() {
      return cancelled;
    },
  };
}
test('forwards a partial valid frame before EOF while raw completion stays pending', async () => {
  const s = source(),
    seen = observeRawProviderSseResponse(
      s.response,
      limits,
      new AbortController().signal,
    );
  let settled = false;
  void seen.complete
    .finally(() => {
      settled = true;
    })
    .catch(() => {});
  const reader = bodyOf(seen.response).getReader();
  const pending = reader.read();
  const bytes = new TextEncoder().encode('data: {"text":"O');
  s.controller.enqueue(bytes);
  assert.deepEqual((await pending).value, bytes);
  assert.equal(settled, false);
  s.controller.enqueue(new TextEncoder().encode('K"}\n\n'));
  s.controller.close();
  assert.equal(
    new TextDecoder().decode((await reader.read()).value),
    'K"}\n\n',
  );
  assert.equal((await reader.read()).done, true);
  assert.deepEqual((await seen.complete).frames, [{ data: { text: 'OK' } }]);
  assert.equal(settled, true);
});
test('backpressure holds upstream reads to one pending pull when SDK does not consume', async () => {
  const s = source(),
    seen = observeRawProviderSseResponse(
      s.response,
      limits,
      new AbortController().signal,
    );
  s.controller.enqueue(new TextEncoder().encode('data: {}\n\n'));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(s.pulls <= 1);
  await bodyOf(seen.response).cancel();
  await assert.rejects(seen.complete, { code: 'usage_unknown' });
  assert.equal(s.cancelled, 1);
});
test('consumer cancellation and abort reject raw completion without waiting for underlying cleanup', async () => {
  for (const mode of ['cancel', 'abort']) {
    const s = source(),
      stop = new AbortController(),
      seen = observeRawProviderSseResponse(s.response, limits, stop.signal);
    if (mode === 'cancel') await bodyOf(seen.response).cancel();
    else stop.abort();
    await assert.rejects(seen.complete, { code: 'usage_unknown' });
    assert.equal(s.cancelled, 1);
  }
});
test('incomplete final framing errors both SDK stream and raw completion', async () => {
  const s = source(),
    seen = observeRawProviderSseResponse(
      s.response,
      limits,
      new AbortController().signal,
    ),
    reader = bodyOf(seen.response).getReader();
  s.controller.enqueue(new TextEncoder().encode('data: {}'));
  assert.equal((await reader.read()).done, false);
  s.controller.close();
  await assert.rejects(reader.read(), { code: 'usage_unknown' });
  await assert.rejects(seen.complete, { code: 'usage_unknown' });
});
test('pre-read HTTP refusal cancels the physical response body', () => {
  let cancelled = 0;
  const response = new Response(
    new ReadableStream({
      cancel() {
        cancelled++;
        return new Promise(() => {});
      },
    }),
    { status: 500, headers: { 'content-type': 'text/event-stream' } },
  );
  assert.throws(
    () =>
      observeRawProviderSseResponse(
        response,
        limits,
        new AbortController().signal,
      ),
    { code: 'usage_unknown' },
  );
  assert.equal(cancelled, 1);
});
test('retains exact raw body digest independently of parsed semantic frames', async () => {
  const { createHash } = await import('node:crypto');
  const outputs = [];
  for (const raw of ['data: {"x":1}\n\n', 'data: { "x": 1 }\n\n']) {
    const seen = observeRawProviderSseResponse(
      new Response(raw, { headers: { 'content-type': 'text/event-stream' } }),
      limits,
      new AbortController().signal,
    );
    assert.equal(await seen.response.text(), raw);
    const evidence = await seen.complete;
    assert.equal(
      evidence.rawBodySha256,
      createHash('sha256').update(raw).digest('hex'),
    );
    assert.equal(evidence.byteLength, Buffer.byteLength(raw));
    assert.equal(Object.isFrozen(evidence), true);
    assert.equal(Object.isFrozen(evidence.frames[0].data), true);
    outputs.push(evidence);
  }
  assert.deepEqual(outputs[0].frames, outputs[1].frames);
  assert.notEqual(outputs[0].rawBodySha256, outputs[1].rawBodySha256);
});
test('oversized decoded evidence complexity is refused within the byte allowance', async () => {
  const raw = `data: ${JSON.stringify({ x: Array.from({ length: 100001 }, () => ({})) })}\n\n`;
  const seen = observeRawProviderSseResponse(
    new Response(raw, { headers: { 'content-type': 'text/event-stream' } }),
    { maxBytes: 1048576, maxFrameBytes: 1048576, maxFrames: 8 },
    new AbortController().signal,
  );
  await assert.rejects(seen.response.text(), { code: 'usage_unknown' });
  await assert.rejects(seen.complete, { code: 'usage_unknown' });
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'vitest';
import { observeBoundedApiJsonResponse } from '../bounded-api-json-response.js';

test('retains original raw counters and exact SDK bytes before normalization', async () => {
  const bytes =
    '{ "usage": { "input_tokens": 9, "output_tokens": 2 }, "cache": null }\n';
  const observed = await observeBoundedApiJsonResponse(
    new Response(bytes, {
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': 'fixture',
      },
    }),
    1024,
    new AbortController().signal,
  );
  assert.deepEqual(observed.raw, {
    usage: { input_tokens: 9, output_tokens: 2 },
    cache: null,
  });
  assert.equal(await observed.response.text(), bytes);
  assert.equal(
    observed.rawBodySha256,
    createHash('sha256').update(bytes).digest('hex'),
  );
  assert.equal(observed.byteLength, Buffer.byteLength(bytes));
  assert.equal(observed.response.headers.get('x-request-id'), 'fixture');
});

test('oversized unterminated JSON refuses and cancels the reader', async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(65));
      },
      cancel() {
        cancelled = true;
      },
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  await assert.rejects(
    observeBoundedApiJsonResponse(response, 64, new AbortController().signal),
    { code: 'usage_unknown' },
  );
  assert.equal(cancelled, true);
});

test('oversized complete valid JSON refuses before it can become known usage', async () => {
  const bytes = JSON.stringify({
    usage: { input_tokens: 1, output_tokens: 1 },
    text: 'x'.repeat(70),
  });
  await assert.rejects(
    observeBoundedApiJsonResponse(
      new Response(bytes, { headers: { 'Content-Type': 'application/json' } }),
      64,
      new AbortController().signal,
    ),
    { code: 'usage_unknown' },
  );
});

test('truncated, invalid UTF8, wrong framing and null responses retain uncertainty', async () => {
  for (const bytes of ['{', 'null', new Uint8Array([0xff])]) {
    await assert.rejects(
      observeBoundedApiJsonResponse(
        new Response(bytes, {
          headers: { 'Content-Type': 'application/json' },
        }),
        1024,
        new AbortController().signal,
      ),
      { code: 'usage_unknown' },
    );
  }
  await assert.rejects(
    observeBoundedApiJsonResponse(
      new Response('data: {}\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      }),
      1024,
      new AbortController().signal,
    ),
    { code: 'usage_unknown' },
  );
});

test('abort before or during read does not become an empty successful response', async () => {
  for (const alreadyAborted of [true, false]) {
    const stop = new AbortController();
    let cancelled = false;
    const response = new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
    if (alreadyAborted) stop.abort();
    const observing = observeBoundedApiJsonResponse(
      response,
      1024,
      stop.signal,
    );
    if (!alreadyAborted) stop.abort();
    await assert.rejects(observing, { code: 'usage_unknown' });
    assert.equal(cancelled, true);
  }
});

test('a noncooperative cancellation callback cannot retain the accounting caller', async () => {
  const stop = new AbortController();
  const response = new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(65));
      },
      cancel() {
        return new Promise<void>(() => {});
      },
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  const observing = observeBoundedApiJsonResponse(
    response,
    64,
    stop.signal,
  ).then(
    () => 'accepted',
    (error) => error.code,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    assert.equal(
      await Promise.race([
        observing,
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve('still pending'), 100);
        }),
      ]),
      'usage_unknown',
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
});
test('non-success status retains unknown usage even with a valid JSON object', async () => {
  await assert.rejects(
    observeBoundedApiJsonResponse(
      new Response('{"usage":{"output_tokens":0}}', {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }),
      1024,
      new AbortController().signal,
    ),
    { code: 'usage_unknown' },
  );
});

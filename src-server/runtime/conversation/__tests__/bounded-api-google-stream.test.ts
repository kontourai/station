import assert from 'node:assert/strict';
import { test } from 'vitest';
import { assembleGoogleStream } from '../bounded-api-google-stream.js';
import type { RawProviderFrame } from '../bounded-api-sse-response.js';

function frames(): RawProviderFrame[] {
  return [
    {
      data: {
        modelVersion: 'exact-revision',
        responseId: 'response',
        candidates: [
          { content: { role: 'model', parts: [{ text: 'O' }] }, index: 0 },
        ],
        usageMetadata: {
          promptTokenCount: 4,
          candidatesTokenCount: 1,
          totalTokenCount: 5,
        },
      },
    },
    {
      data: {
        modelVersion: 'exact-revision',
        responseId: 'response',
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'K' }] },
            index: 0,
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 4,
          candidatesTokenCount: 2,
          totalTokenCount: 6,
        },
      },
    },
  ];
}
test('retains content and takes final cumulative counters without summing', () => {
  const r = assembleGoogleStream(frames());
  assert.deepEqual(r.usageMetadata, {
    promptTokenCount: 4,
    candidatesTokenCount: 2,
    totalTokenCount: 6,
  });
  assert.deepEqual(r.candidates, [
    {
      index: 0,
      finishReason: 'STOP',
      content: { role: 'model', parts: [{ text: 'O' }, { text: 'K' }] },
    },
  ]);
});
test('refuses missing finish or usage', () => {
  assert.throws(() => assembleGoogleStream(frames().slice(0, 1)), {
    code: 'usage_unknown',
  });
  const f = frames();
  for (const item of f) delete item.data.usageMetadata;
  assert.throws(() => assembleGoogleStream(f), { code: 'usage_unknown' });
});
test('refuses changed served model and decreasing cumulative counter', () => {
  const a = frames();
  a[1].data.modelVersion = 'other';
  assert.throws(() => assembleGoogleStream(a), { code: 'usage_unknown' });
  const b = frames();
  b[1].data.usageMetadata = { promptTokenCount: 3, totalTokenCount: 5 };
  assert.throws(() => assembleGoogleStream(b), { code: 'usage_unknown' });
});
test('refuses hidden continuation rather than allowing SDK to start another physical request', () => {
  const a = frames();
  a[1].data.candidates = [
    { finishReason: 'CONTINUATION', continuationToken: 'next' },
  ];
  assert.throws(() => assembleGoogleStream(a), { code: 'usage_unknown' });
});
test('retains unknown usage metadata for pure qualifier and refuses multicandidate', () => {
  const a = frames();
  a[0].data.usageMetadata = {
    promptTokenCount: 4,
    totalTokenCount: 5,
    hiddenWork: true,
  };
  assert.equal(
    (assembleGoogleStream(a).usageMetadata as Record<string, unknown>)
      .hiddenWork,
    true,
  );
  const b = frames();
  b[1].data.candidates = [{ finishReason: 'STOP' }, { finishReason: 'STOP' }];
  assert.throws(() => assembleGoogleStream(b), { code: 'usage_unknown' });
});
test('requires usage at or after finish instead of retaining earlier partial counters', () => {
  const f = frames();
  delete f[1].data.usageMetadata;
  assert.throws(() => assembleGoogleStream(f), { code: 'usage_unknown' });
});

for (const final of [
  {},
  { candidatesTokenCount: 2 },
  { promptTokenCount: 4, totalTokenCount: 6 },
  { totalTokenCount: 6 },
]) {
  test(`refuses incomplete final usage ${JSON.stringify(final)} after earlier counters`, () => {
    const f = frames();
    f[1].data.usageMetadata = final;
    assert.throws(() => assembleGoogleStream(f), { code: 'usage_unknown' });
  });
}

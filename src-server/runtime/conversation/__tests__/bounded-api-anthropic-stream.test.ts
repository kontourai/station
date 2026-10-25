import assert from 'node:assert/strict';
import { test } from 'vitest';
import { assembleAnthropicStream } from '../bounded-api-anthropic-stream.js';
import type { RawProviderFrame } from '../bounded-api-sse-response.js';

function frames(): RawProviderFrame[] {
  return [
    {
      data: {
        type: 'message_start',
        message: {
          id: 'm',
          type: 'message',
          role: 'assistant',
          model: 'exact-model',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 4,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      },
    },
    {
      data: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
    },
    {
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'OK' },
      },
    },
    { data: { type: 'content_block_stop', index: 0 } },
    {
      data: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 2 },
      },
    },
    { data: { type: 'message_stop' } },
  ];
}
test('assembles exact message and cumulative usage only after provider semantic stop', () => {
  const value = assembleAnthropicStream(frames());
  assert.deepEqual(value.content, [{ type: 'text', text: 'OK' }]);
  assert.deepEqual(value.usage, {
    input_tokens: 4,
    output_tokens: 2,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  });
  assert.equal(value.stop_reason, 'end_turn');
  assert.equal(value.model, 'exact-model');
});
test('refuses EOF without message_stop and a complete frame after stop', () => {
  assert.throws(() => assembleAnthropicStream(frames().slice(0, -1)), {
    code: 'usage_unknown',
  });
  assert.throws(
    () => assembleAnthropicStream([...frames(), { data: { type: 'ping' } }]),
    { code: 'usage_unknown' },
  );
});
test('refuses out of order content or duplicate message start', () => {
  const a = frames();
  a.splice(3, 1);
  assert.throws(() => assembleAnthropicStream(a), { code: 'usage_unknown' });
  const b = frames();
  b.splice(1, 0, b[0]);
  assert.throws(() => assembleAnthropicStream(b), { code: 'usage_unknown' });
});
test('preserves allowed hidden-work metadata for later pricing refusal and rejects unknown usage keys', () => {
  const a = frames();
  a[4].data.usage = {
    output_tokens: 2,
    server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 },
  };
  assert.deepEqual(
    (assembleAnthropicStream(a).usage as Record<string, unknown>)
      .server_tool_use,
    { web_search_requests: 1, web_fetch_requests: 0 },
  );
  const b = frames();
  b[0].data.message = {
    ...(b[0].data.message as Record<string, unknown>),
    usage: { input_tokens: 4, iterations: [{ type: 'fallback_message' }] },
  };
  assert.throws(() => assembleAnthropicStream(b), { code: 'usage_unknown' });
});
test('refuses decreasing counters and mismatched SSE event names', () => {
  const a = frames();
  a[4].data.usage = { input_tokens: 3, output_tokens: 2 };
  assert.throws(() => assembleAnthropicStream(a), { code: 'usage_unknown' });
  const b = frames();
  b[2].event = 'message_stop';
  assert.throws(() => assembleAnthropicStream(b), { code: 'usage_unknown' });
});
test('requires explicit final cumulative output count rather than reusing initial zero', () => {
  const a = frames();
  a[4].data.usage = {};
  assert.throws(() => assembleAnthropicStream(a), { code: 'usage_unknown' });
});

for (const argumentsJson of [
  '{"question":"Which scope?"}',
  '{"question":"first","question":"second"}',
  '{"question":"ok","endpoint":"https://untrusted.invalid"}',
])
  test(`fixed input tool requires complete unambiguous arguments: ${argumentsJson}`, () => {
    const chunks = frames();
    chunks[1].data.content_block = {
      type: 'tool_use',
      id: 'call-input',
      name: 'station_request_input',
      input: {},
    };
    chunks[2].data.delta = {
      type: 'input_json_delta',
      partial_json: argumentsJson,
    };
    chunks[4].data.delta = { stop_reason: 'tool_use', stop_sequence: null };
    assert.throws(() => assembleAnthropicStream(chunks), {
      code: 'usage_unknown',
    });
    if (argumentsJson === '{"question":"Which scope?"}') {
      const value = assembleAnthropicStream(chunks, true);
      assert.deepEqual(value.content, [
        {
          type: 'tool_use',
          id: 'call-input',
          name: 'station_request_input',
          input: { question: 'Which scope?' },
        },
      ]);
    } else
      assert.throws(() => assembleAnthropicStream(chunks, true), {
        code: 'usage_unknown',
      });
  });

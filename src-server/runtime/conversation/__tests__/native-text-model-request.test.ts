import { expect, test } from 'vitest';
import type { NativeModelRequest } from '../../../services/connections/native-model-stdio-protocol.js';
import { prepareNativeTextModelRequest } from '../native-text-model-request.js';

function request(
  provider: 'anthropic' | 'openai',
  changes: Record<string, unknown> = {},
): NativeModelRequest {
  return {
    id: 'request-1',
    method: 'POST',
    path: provider === 'anthropic' ? '/v1/messages' : '/v1/responses',
    headers: [],
    body: Buffer.from(
      JSON.stringify(
        provider === 'anthropic'
          ? {
              model: 'fixture',
              max_tokens: 32000,
              messages: [
                {
                  role: 'user',
                  content: [{ type: 'text', text: 'private source' }],
                },
              ],
              stream: true,
              tools: [{ type: 'web_search' }],
              thinking: {
                type: 'enabled',
                budget_tokens: 31999,
                display: 'omitted',
              },
              ...changes,
            }
          : {
              model: 'fixture',
              input: [
                {
                  type: 'message',
                  id: 'client-item',
                  role: 'user',
                  content: [{ type: 'input_text', text: 'private source' }],
                },
              ],
              stream: true,
              store: false,
              tools: [{ type: 'web_search' }],
              tool_choice: 'auto',
              parallel_tool_calls: true,
              reasoning: { summary: 'auto' },
              include: ['reasoning.encrypted_content'],
              ...changes,
            },
      ),
    ),
  };
}
const policy = { modelId: 'fixture', maxOutputTokens: 2048 };

test.each(['anthropic', 'openai'] as const)(
  '%s final native text bytes have a finite cap and no advertised provider tools',
  (provider) => {
    const native = request(provider);
    const original = Buffer.from(native.body);
    const final = prepareNativeTextModelRequest(native, {
      ...policy,
      provider,
    });
    expect(native.body).toEqual(original);
    expect(final.body).not.toBe(native.body);
    const body = JSON.parse(final.body.toString());
    expect(body.tools).toEqual([]);
    if (provider === 'anthropic') {
      expect(body.max_tokens).toBe(2048);
      expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 2047 });
      expect(body.messages[0].content[0].text).toBe('private source');
      expect(body.service_tier).toBe('standard_only');
    } else {
      expect(body.max_output_tokens).toBe(2048);
      expect(body.tool_choice).toBe('none');
      expect(body.parallel_tool_calls).toBe(false);
      expect(body.store).toBe(false);
      expect(body.truncation).toBe('disabled');
      expect(body.input[0]).toEqual({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'private source' }],
      });
      expect(body).not.toHaveProperty('include');
    }
  },
);

test.each(['anthropic', 'openai'] as const)(
  '%s preserves a smaller native output cap',
  (provider) => {
    const native = request(
      provider,
      provider === 'anthropic'
        ? { max_tokens: 1500, thinking: { type: 'disabled' } }
        : { max_output_tokens: 1500 },
    );
    const body = JSON.parse(
      prepareNativeTextModelRequest(native, {
        ...policy,
        provider,
      }).body.toString(),
    );
    expect(
      provider === 'anthropic' ? body.max_tokens : body.max_output_tokens,
    ).toBe(1500);
  },
);

test.each([
  { previous_response_id: 'hidden-state' },
  { conversation: 'hidden-state' },
  { reasoning: { mode: 'pro' } },
  { input: [{ type: 'reasoning', encrypted_content: 'opaque' }] },
  {
    input: [
      { type: 'function_call_output', call_id: 'foreign', output: 'text' },
    ],
  },
  { max_output_tokens: 0 },
  { model: 'foreign-model' },
])(
  'Responses native narrowing refuses unqualified state or options: %j',
  (changes) => {
    expect(() =>
      prepareNativeTextModelRequest(request('openai', changes), {
        ...policy,
        provider: 'openai',
      }),
    ).toThrow('native_text_model_request_refused');
  },
);

test('native wire refuses duplicate fields, invalid UTF-8, non-model paths and impossible thinking budgets', () => {
  const duplicate = request('openai');
  duplicate.body = Buffer.from(
    duplicate.body
      .toString()
      .replace('"model":"fixture"', '"model":"foreign","model":"fixture"'),
  );
  const invalidUtf8 = { ...request('openai'), body: Buffer.from([0xff]) };
  for (const input of [
    duplicate,
    invalidUtf8,
    { ...request('openai'), path: '/v1/responses/compact' },
  ])
    expect(() =>
      prepareNativeTextModelRequest(input, { ...policy, provider: 'openai' }),
    ).toThrow('native_text_model_request_refused');
  expect(() =>
    prepareNativeTextModelRequest(request('anthropic'), {
      ...policy,
      provider: 'anthropic',
      maxOutputTokens: 1024,
    }),
  ).toThrow('native_text_model_request_refused');
});

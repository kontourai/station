import { expect, test } from 'vitest';
import type { NativeModelRequest } from '../../../services/connections/native-model-stdio-protocol.js';
import {
  prepareNativeBrokeredModelRequest,
  prepareNativeTextModelRequest,
} from '../native-text-model-request.js';

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
const brokerTool = {
  name: 'report_probe',
  description: 'Return the controlled receipt.',
  inputSchema: { type: 'object', properties: { nonce: { type: 'string' } } },
};
function brokeredRequest(provider: 'anthropic' | 'openai', followup = false) {
  const native = request(provider);
  const body = JSON.parse(native.body.toString());
  body.tools.push(
    provider === 'anthropic'
      ? {
          name: 'mcp__station_delegation__report_probe',
          description: 'Untrusted native description',
          input_schema: { type: 'object' },
        }
      : {
          type: 'namespace',
          name: 'mcp__station_delegation',
          tools: [{ type: 'function', name: 'report_probe' }],
        },
  );
  if (followup) {
    if (provider === 'anthropic')
      body.messages.push(
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'call-1',
              name: 'mcp__station_delegation__report_probe',
              input: { nonce: 'controlled' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call-1', content: 'receipt' },
          ],
        },
      );
    else
      body.input.push(
        {
          type: 'function_call',
          call_id: 'call-1',
          name: 'report_probe',
          namespace: 'mcp__station_delegation',
          arguments: '{"nonce":"controlled"}',
        },
        { type: 'function_call_output', call_id: 'call-1', output: 'receipt' },
      );
  }
  return { ...native, body: Buffer.from(JSON.stringify(body)) };
}

test.each(['anthropic', 'openai'] as const)(
  '%s brokered wire keeps only the host catalog and caps each physical request',
  (provider) => {
    const native = brokeredRequest(provider);
    native.headers = [
      ['authorization', 'Bearer native-scoped-key'],
      ['anthropic-beta', 'native-feature'],
      ['x-codex-turn-state', 'unbound-state'],
    ];
    const final = prepareNativeBrokeredModelRequest(native, {
      ...policy,
      provider,
      tools: [brokerTool],
    });
    expect(final.headers).toEqual([['content-type', 'application/json']]);
    const body = JSON.parse(final.body.toString());
    expect(body.tools).toHaveLength(1);
    const tool =
      provider === 'anthropic' ? body.tools[0] : body.tools[0].tools[0];
    expect(tool.description).toBe(brokerTool.description);
    expect(
      provider === 'anthropic' ? tool.input_schema : tool.parameters,
    ).toEqual(brokerTool.inputSchema);
    expect(
      provider === 'anthropic' ? body.max_tokens : body.max_output_tokens,
    ).toBe(2048);
    expect(body.tools).not.toEqual(JSON.parse(native.body.toString()).tools);
  },
);

test.each(['anthropic', 'openai'] as const)(
  '%s brokered wire retains paired text tool history while the sealed leaf refuses it',
  (provider) => {
    const native = brokeredRequest(provider, true);
    const body = JSON.parse(
      prepareNativeBrokeredModelRequest(native, {
        ...policy,
        provider,
        tools: [brokerTool],
      }).body.toString(),
    );
    const history = provider === 'anthropic' ? body.messages : body.input;
    expect(history.slice(1)).toEqual(
      JSON.parse(native.body.toString())[
        provider === 'anthropic' ? 'messages' : 'input'
      ].slice(1),
    );
    if (provider === 'openai') expect(history[0]).not.toHaveProperty('id');
    expect(() =>
      prepareNativeTextModelRequest(native, { ...policy, provider }),
    ).toThrow('native_text_model_request_refused');
  },
);

test('brokered Responses preserves an explicit native no-tools choice', () => {
  const native = brokeredRequest('openai');
  const body = JSON.parse(native.body.toString());
  body.tool_choice = 'none';
  native.body = Buffer.from(JSON.stringify(body));
  const prepared = prepareNativeBrokeredModelRequest(native, {
    ...policy,
    provider: 'openai',
    tools: [brokerTool],
  });
  expect(JSON.parse(prepared.body.toString()).tool_choice).toBe('none');
});

test.each(['anthropic', 'openai'] as const)(
  '%s brokered wire refuses orphaned, incomplete, duplicated or foreign tool history',
  (provider) => {
    for (const fault of [
      'orphan',
      'incomplete',
      'duplicate',
      'duplicate-result',
      'foreign',
      'state',
    ] as const) {
      const native = brokeredRequest(provider, true);
      const body = JSON.parse(native.body.toString());
      const history = provider === 'anthropic' ? body.messages : body.input;
      if (fault === 'state')
        body.previous_response_id = 'hidden-provider-state';
      else if (fault === 'incomplete') history.pop();
      else if (fault === 'duplicate-result') history.push(history[2]);
      else if (provider === 'anthropic') {
        if (fault === 'orphan') history[2].content[0].tool_use_id = 'unseen';
        else if (fault === 'duplicate') history.splice(2, 0, history[1]);
        else history[1].content[0].name = 'mcp__foreign__report_probe';
      } else {
        if (fault === 'orphan') history[2].call_id = 'unseen';
        else if (fault === 'duplicate') history.splice(2, 0, history[1]);
        else history[1].namespace = 'mcp__foreign';
      }
      native.body = Buffer.from(JSON.stringify(body));
      expect(
        () =>
          prepareNativeBrokeredModelRequest(native, {
            ...policy,
            provider,
            tools: [brokerTool],
          }),
        fault,
      ).toThrow('native_brokered_model_request_refused');
    }
  },
);

test.each(['anthropic', 'openai'] as const)(
  '%s brokered wire refuses a missing or ambiguous host catalog',
  (provider) => {
    const native = brokeredRequest(provider);
    for (const tools of [
      [brokerTool, brokerTool],
      [{ ...brokerTool, name: 'not_advertised' }],
    ])
      expect(() =>
        prepareNativeBrokeredModelRequest(native, {
          ...policy,
          provider,
          tools,
        }),
      ).toThrow('native_brokered_model_request_refused');
    const body = JSON.parse(native.body.toString());
    body.tools.push(body.tools[1]);
    native.body = Buffer.from(JSON.stringify(body));
    expect(() =>
      prepareNativeBrokeredModelRequest(native, {
        ...policy,
        provider,
        tools: [brokerTool],
      }),
    ).toThrow('native_brokered_model_request_refused');
  },
);

test.each(['anthropic', 'openai'] as const)(
  '%s applies the selected effort to final request bytes',
  (provider) => {
    const body = JSON.parse(
      prepareNativeTextModelRequest(request(provider), {
        ...policy,
        provider,
        modelOptions:
          provider === 'openai'
            ? { reasoningEffort: 'high' }
            : { effort: 'high' },
      }).body.toString(),
    );
    expect(
      provider === 'anthropic'
        ? body.output_config.effort
        : body.reasoning.effort,
    ).toBe('high');
  },
);

test('selected Claude thinking can be disabled or enabled within the inclusive output cap', () => {
  const disabled = JSON.parse(
    prepareNativeTextModelRequest(request('anthropic'), {
      ...policy,
      provider: 'anthropic',
      modelOptions: { thinking: false },
    }).body.toString(),
  );
  expect(disabled.thinking).toEqual({ type: 'disabled' });
  const enabled = JSON.parse(
    prepareNativeTextModelRequest(
      request('anthropic', { thinking: { type: 'disabled' } }),
      { ...policy, provider: 'anthropic', modelOptions: { thinking: true } },
    ).body.toString(),
  );
  expect(enabled.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
  expect(() =>
    prepareNativeTextModelRequest(
      request('anthropic', { thinking: { type: 'disabled' } }),
      {
        ...policy,
        provider: 'anthropic',
        maxOutputTokens: 1024,
        modelOptions: { thinking: true },
      },
    ),
  ).toThrow('native_text_model_request_refused');
});

test.each([
  ['openai', { effort: 'low', reasoningEffort: 'high' }],
  ['openai', { fastMode: true }],
  ['openai', { serviceTier: 'priority' }],
  ['openai', { thinking: true }],
  ['anthropic', { effort: 'none' }],
  ['anthropic', { reasoningEffort: 'high' }],
  ['anthropic', { unknownSetting: true }],
] as const)(
  '%s refuses an unsupported or contradictory model selection: %j',
  (provider, modelOptions) => {
    expect(() =>
      prepareNativeTextModelRequest(request(provider), {
        ...policy,
        provider,
        modelOptions,
      }),
    ).toThrow('native_text_model_request_refused');
  },
);

test('native beta routing and provider state headers never survive text preparation', () => {
  const native = request('anthropic');
  native.path = '/v1/messages?beta=true';
  native.headers = [
    ['anthropic-version', '2023-06-01'],
    ['anthropic-beta', 'native-feature'],
  ];
  const final = prepareNativeTextModelRequest(native, {
    ...policy,
    provider: 'anthropic',
  });
  expect(final.path).toBe('/v1/messages');
  expect(final.headers).toEqual([
    ['content-type', 'application/json'],
    ['anthropic-version', '2023-06-01'],
  ]);
  const responses = request('openai');
  responses.headers = [
    ['x-codex-turn-state', 'hidden-state'],
    ['openai-beta', 'native-feature'],
  ];
  expect(
    prepareNativeTextModelRequest(responses, { ...policy, provider: 'openai' })
      .headers,
  ).toEqual([['content-type', 'application/json']]);
});

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

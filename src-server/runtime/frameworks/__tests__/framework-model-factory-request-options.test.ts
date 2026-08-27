import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const chatModel = vi.hoisted(() =>
  vi.fn((modelId: string) => ({ kind: 'openai-compat-model', modelId })),
);
const createOpenAICompatible = vi.hoisted(() =>
  vi.fn((..._args: unknown[]) => ({ chatModel })),
);
const anthropicLanguageModel = vi.hoisted(() =>
  vi.fn((modelId: string) => ({ kind: 'anthropic-model', modelId })),
);
const createAnthropic = vi.hoisted(() =>
  vi.fn((..._args: unknown[]) => ({ languageModel: anthropicLanguageModel })),
);
const googleLanguageModel = vi.hoisted(() =>
  vi.fn((modelId: string) => ({ kind: 'google-model', modelId })),
);
const createGoogleGenerativeAI = vi.hoisted(() =>
  vi.fn((..._args: unknown[]) => ({ languageModel: googleLanguageModel })),
);
vi.mock('@ai-sdk/openai-compatible', () => ({ createOpenAICompatible }));
vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic }));
vi.mock('@ai-sdk/google', () => ({ createGoogleGenerativeAI }));
vi.mock('@ai-sdk/amazon-bedrock', () => ({ createAmazonBedrock: vi.fn() }));
vi.mock('@strands-agents/sdk', () => ({ BedrockModel: class {} }));
vi.mock('@strands-agents/sdk/models/vercel', () => ({
  VercelModel: class {},
}));
vi.mock('../../../providers/llm/bedrock.js', () => ({
  createBedrockProvider: vi.fn(),
}));

import {
  buildAiSdkLanguageModel,
  createAiSdkManagedModel,
  requestBodyDefaultsFetch,
  resolveModelRequestOptions,
} from '../framework-model-factory.js';

describe('resolveModelRequestOptions', () => {
  test('returns a non-empty plain object as-is', () => {
    const options = { reasoning_effort: 'low' };
    expect(resolveModelRequestOptions({ modelRequestOptions: options })).toBe(
      options,
    );
  });

  test.each([
    ['absent', {}],
    ['undefined config', undefined],
    ['null', { modelRequestOptions: null }],
    ['array', { modelRequestOptions: ['reasoning_effort'] }],
    ['scalar', { modelRequestOptions: 'low' }],
    ['empty object', { modelRequestOptions: {} }],
  ])('resolves undefined for %s', (_label, config) => {
    expect(
      resolveModelRequestOptions(config as Record<string, unknown> | undefined),
    ).toBeUndefined();
  });
});

describe('requestBodyDefaultsFetch', () => {
  const upstream = vi.fn(async () => new Response('{}', { status: 200 }));

  beforeEach(() => {
    upstream.mockClear();
    vi.stubGlobal('fetch', upstream);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function sentBody(): Record<string, unknown> {
    const [, init] = upstream.mock.calls.at(-1) as unknown as [
      unknown,
      RequestInit,
    ];
    return JSON.parse(String(init.body));
  }

  test('returns undefined for empty or missing defaults (no wrapper installed)', () => {
    expect(requestBodyDefaultsFetch(undefined)).toBeUndefined();
    expect(requestBodyDefaultsFetch({})).toBeUndefined();
  });

  test('injects an absent key into an OpenAI-wire completion body', async () => {
    const wrapped = requestBodyDefaultsFetch({ reasoning_effort: 'low' })!;
    await wrapped('http://127.0.0.1:8317/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-haiku', messages: [] }),
    });
    expect(sentBody()).toEqual({
      model: 'claude-haiku',
      messages: [],
      reasoning_effort: 'low',
    });
  });

  // Verifier follow-up: the Object.hasOwn comment in the merge promises
  // prototype-member-named defaults stay injectable — pin it, or a revert
  // to `key in merged` silently loses this property.
  test('injects a default named after a prototype member', async () => {
    const wrapped = requestBodyDefaultsFetch({ toString: 'x-marker' })!;
    await wrapped('http://host/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'm' }),
    });
    expect(sentBody()).toEqual({ model: 'm', toString: 'x-marker' });
  });

  test('never overrides a key the request already carries', async () => {
    const wrapped = requestBodyDefaultsFetch({ reasoning_effort: 'low' })!;
    const body = JSON.stringify({ model: 'm', reasoning_effort: 'high' });
    await wrapped('http://host/v1/chat/completions', {
      method: 'POST',
      body,
    });
    // Nothing to change → the original init passes through untouched.
    const [, init] = upstream.mock.calls.at(-1) as unknown as [
      unknown,
      RequestInit,
    ];
    expect(init.body).toBe(body);
  });

  test('applies to the Anthropic and Google completion wires', async () => {
    const wrapped = requestBodyDefaultsFetch({
      thinking: { type: 'enabled', budget_tokens: 2000 },
    })!;
    await wrapped('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({ model: 'm' }),
    });
    expect(sentBody()).toMatchObject({
      thinking: { type: 'enabled', budget_tokens: 2000 },
    });
    await wrapped(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini:streamGenerateContent?alt=sse',
      { method: 'POST', body: JSON.stringify({}) },
    );
    expect(sentBody()).toMatchObject({ thinking: expect.anything() });
  });

  // Review M1 pin: today's ai-sdk providers always call
  // `(stringUrl, { method: 'POST', body: string })`; a Request-object input
  // carries its body internally and must pass through untouched (the
  // defaults deliberately do not apply rather than risk corrupting a shape
  // the wrapper doesn't own). If an SDK bump makes this fail, extend the
  // wrapper for Request inputs instead of loosening the test.
  test('Request-object inputs pass through unmodified (calling-convention pin)', async () => {
    const wrapped = requestBodyDefaultsFetch({ reasoning_effort: 'low' })!;
    const request = new Request('http://host/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'm' }),
    });
    await wrapped(request);
    const [forwarded, forwardedInit] = upstream.mock.calls.at(
      -1,
    ) as unknown as [unknown, RequestInit | undefined];
    expect(forwarded).toBe(request);
    expect(forwardedInit).toBeUndefined();
  });

  test.each([
    ['catalog GET', 'http://host/v1/models', 'GET', undefined],
    [
      'embeddings POST',
      'http://host/v1/embeddings',
      'POST',
      JSON.stringify({ input: 'x' }),
    ],
    [
      'non-JSON completion body',
      'http://host/v1/chat/completions',
      'POST',
      'not-json',
    ],
  ])('passes %s through unmodified', async (_label, url, method, body) => {
    const wrapped = requestBodyDefaultsFetch({ reasoning_effort: 'low' })!;
    const init: RequestInit = { method, ...(body ? { body } : {}) };
    await wrapped(url, init);
    const [, forwardedInit] = upstream.mock.calls.at(-1) as unknown as [
      unknown,
      RequestInit,
    ];
    expect(forwardedInit).toBe(init);
  });
});

describe('buildAiSdkLanguageModel — requestBodyDefaults wiring (station#1994)', () => {
  beforeEach(() => {
    createOpenAICompatible.mockClear();
    createAnthropic.mockClear();
    createGoogleGenerativeAI.mockClear();
  });

  // Review M2: the managed-runtime path must READ the connection's
  // config.modelRequestOptions — this is the wiring the live proof used, and
  // deleting the resolveModelRequestOptions call in
  // createManagedLanguageModel must turn this red.
  test('managed path resolves modelRequestOptions from the provider connection config', () => {
    createOpenAICompatible.mockClear();
    createAiSdkManagedModel({
      providerConnection: {
        id: 'conn-1',
        type: 'openai-compat',
        name: 'Proxy',
        config: {
          baseUrl: 'http://127.0.0.1:9/v1',
          modelRequestOptions: { reasoning_effort: 'low' },
        },
        enabled: true,
        capabilities: ['llm'] as Array<'llm' | 'embedding' | 'vectordb'>,
      },
      modelId: 'claude-haiku',
      spec: { guardrails: undefined, region: undefined },
      appConfig: { defaultMaxOutputTokens: 1024, region: undefined },
    });
    expect(createOpenAICompatible.mock.calls.at(-1)?.[0]).toMatchObject({
      fetch: expect.any(Function),
    });

    createOpenAICompatible.mockClear();
    createAiSdkManagedModel({
      providerConnection: {
        id: 'conn-2',
        type: 'openai-compat',
        name: 'Plain',
        config: { baseUrl: 'http://127.0.0.1:9/v1' },
        enabled: true,
        capabilities: ['llm'] as Array<'llm' | 'embedding' | 'vectordb'>,
      },
      modelId: 'claude-haiku',
      spec: { guardrails: undefined, region: undefined },
      appConfig: { defaultMaxOutputTokens: 1024, region: undefined },
    });
    const plainCall = createOpenAICompatible.mock.calls.at(-1) as unknown as [
      Record<string, unknown>,
    ];
    expect(plainCall[0].fetch).toBeUndefined();
  });

  test.each([
    ['openai-compat', createOpenAICompatible],
    ['anthropic', createAnthropic],
    ['google', createGoogleGenerativeAI],
  ])('%s: passes a fetch override only when defaults exist', (type, create) => {
    buildAiSdkLanguageModel({
      type,
      modelId: 'm',
      baseUrl: 'http://127.0.0.1:9/v1',
      requestBodyDefaults: { reasoning_effort: 'low' },
    });
    expect(create.mock.calls.at(-1)?.[0]).toMatchObject({
      fetch: expect.any(Function),
    });

    buildAiSdkLanguageModel({
      type,
      modelId: 'm',
      baseUrl: 'http://127.0.0.1:9/v1',
    });
    const lastCall = create.mock.calls.at(-1) as unknown as [
      Record<string, unknown>,
    ];
    expect(lastCall[0].fetch).toBeUndefined();
  });
});

import { beforeEach, describe, expect, test, vi } from 'vitest';

const amazonBedrockLanguageModel = vi.hoisted(() =>
  vi.fn((modelId: string) => ({ kind: 'ai-sdk-bedrock-model', modelId })),
);
const createAmazonBedrock = vi.hoisted(() =>
  vi.fn((..._args: unknown[]) => ({
    languageModel: amazonBedrockLanguageModel,
  })),
);
vi.mock('@ai-sdk/amazon-bedrock', () => ({ createAmazonBedrock }));
vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: vi.fn() }));
vi.mock('@ai-sdk/google', () => ({ createGoogleGenerativeAI: vi.fn() }));
vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: vi.fn(),
}));

const bedrockModelCtor = vi.hoisted(() => vi.fn());
vi.mock('@strands-agents/sdk', () => ({
  BedrockModel: class {
    constructor(options: unknown) {
      bedrockModelCtor(options);
    }
  },
}));
vi.mock('@strands-agents/sdk/models/vercel', () => ({
  VercelModel: class {},
}));

const createBedrockProvider = vi.hoisted(() =>
  vi.fn(() => ({ kind: 'volt-bedrock' })),
);
vi.mock('../../../providers/llm/bedrock.js', () => ({ createBedrockProvider }));

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  buildAiSdkLanguageModel,
  createAiSdkManagedModel,
  createStrandsManagedModel,
  createVoltAgentManagedModel,
} from '../framework-model-factory.js';

function bedrockOptions(config: Record<string, unknown>) {
  return {
    providerConnection: {
      id: 'conn-1',
      type: 'bedrock',
      name: 'Bedrock',
      config,
      enabled: true,
      capabilities: ['llm'] as Array<'llm' | 'embedding' | 'vectordb'>,
    },
    modelId: 'anthropic.claude-3',
    spec: { guardrails: undefined, region: undefined },
    appConfig: { defaultMaxOutputTokens: 1024, region: undefined },
  };
}

// HIGH-3 (review fix round): every Station-agent execution path that special
// -cases Bedrock must thread the connection's auth mode instead of always
// running chain-only.
describe('framework-model-factory — Bedrock auth threading across execution paths', () => {
  beforeEach(() => {
    createAmazonBedrock.mockClear();
    amazonBedrockLanguageModel.mockClear();
    bedrockModelCtor.mockClear();
    createBedrockProvider.mockClear();
  });

  describe('createAiSdkManagedModel (ai-sdk / Dispatch path)', () => {
    test('chain mode (default/absent authMode) is unchanged: no credential override', () => {
      createAiSdkManagedModel(bedrockOptions({ region: 'us-east-1' }));

      expect(createAmazonBedrock).toHaveBeenCalledWith(
        expect.objectContaining({ region: 'us-east-1' }),
      );
      const [args] = createAmazonBedrock.mock.calls.at(-1)!;
      expect(args).not.toHaveProperty('apiKey');
    });

    test('profile mode threads a credentialProvider derived from the connection', () => {
      createAiSdkManagedModel(
        bedrockOptions({
          region: 'us-east-1',
          authMode: 'profile',
          profile: 'work',
        }),
      );

      expect(createAmazonBedrock).toHaveBeenCalledWith(
        expect.objectContaining({
          region: 'us-east-1',
          credentialProvider: expect.any(Function),
        }),
      );
    });

    test('api-key mode threads the bearer apiKey from the connection', () => {
      createAiSdkManagedModel(
        bedrockOptions({
          region: 'us-east-1',
          authMode: 'api-key',
          apiKey: 'bedrock-key-abc',
        }),
      );

      expect(createAmazonBedrock).toHaveBeenCalledWith(
        expect.objectContaining({
          region: 'us-east-1',
          apiKey: 'bedrock-key-abc',
        }),
      );
    });

    test('fail-closed: a misconfigured profile connection throws rather than running chain-authenticated', () => {
      expect(() =>
        createAiSdkManagedModel(
          bedrockOptions({ region: 'us-east-1', authMode: 'profile' }),
        ),
      ).toThrow(/no named AWS profile/i);
      expect(createAmazonBedrock).not.toHaveBeenCalled();
    });

    test('fail-closed: a misconfigured api-key connection throws rather than running chain-authenticated', () => {
      expect(() =>
        createAiSdkManagedModel(
          bedrockOptions({ region: 'us-east-1', authMode: 'api-key' }),
        ),
      ).toThrow(/no API key/i);
      expect(createAmazonBedrock).not.toHaveBeenCalled();
    });
  });

  describe('createStrandsManagedModel (Strands BedrockModel path)', () => {
    test('chain mode (default) constructs BedrockModel with no credential override', () => {
      createStrandsManagedModel(bedrockOptions({ region: 'us-east-1' }));

      expect(bedrockModelCtor).toHaveBeenCalledWith(
        expect.objectContaining({ modelId: 'anthropic.claude-3' }),
      );
      const [options] = bedrockModelCtor.mock.calls.at(-1)!;
      expect(options).not.toHaveProperty('apiKey');
      expect(options).not.toHaveProperty('clientConfig');
    });

    test('profile mode threads clientConfig.credentials into the real BedrockModel constructor', () => {
      createStrandsManagedModel(
        bedrockOptions({
          region: 'us-east-1',
          authMode: 'profile',
          profile: 'work',
        }),
      );

      expect(bedrockModelCtor).toHaveBeenCalledWith(
        expect.objectContaining({
          clientConfig: { credentials: expect.any(Function) },
        }),
      );
    });

    test('api-key mode threads the bearer apiKey into the real BedrockModel constructor', () => {
      createStrandsManagedModel(
        bedrockOptions({
          region: 'us-east-1',
          authMode: 'api-key',
          apiKey: 'bedrock-key-xyz',
        }),
      );

      expect(bedrockModelCtor).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: 'bedrock-key-xyz' }),
      );
    });

    test('fail-closed: a misconfigured connection throws before BedrockModel is ever constructed', () => {
      expect(() =>
        createStrandsManagedModel(
          bedrockOptions({ region: 'us-east-1', authMode: 'api-key' }),
        ),
      ).toThrow(/no API key/i);
      expect(bedrockModelCtor).not.toHaveBeenCalled();
    });
  });

  describe('createVoltAgentManagedModel (VoltAgent createBedrockProvider path)', () => {
    test('threads the resolved auth config through to createBedrockProvider', () => {
      createVoltAgentManagedModel(
        bedrockOptions({
          region: 'us-east-1',
          authMode: 'profile',
          profile: 'work',
        }),
      );

      expect(createBedrockProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          auth: { authMode: 'profile', profile: 'work', apiKey: undefined },
        }),
      );
    });

    test('chain mode (default/no connection) resolves to an undefined authMode', () => {
      createVoltAgentManagedModel(bedrockOptions({ region: 'us-east-1' }));

      expect(createBedrockProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          auth: { authMode: undefined, profile: undefined, apiKey: undefined },
        }),
      );
    });
  });
});

// archive#4197 delta review: the include_usage request is scoped to ollama —
// generic openai-compat fronts gateways where an unrecognized stream_options
// param can 400 a previously-working streamed turn. Pinned in both
// directions so a factory refactor cannot silently drop or widen the flag.
describe('framework-model-factory — stream usage request scope (station#4197)', () => {
  const compatFactory = vi.mocked(createOpenAICompatible);

  beforeEach(() => {
    compatFactory.mockReset();
    compatFactory.mockReturnValue({
      chatModel: vi.fn().mockReturnValue({}),
    } as unknown as ReturnType<typeof createOpenAICompatible>);
  });

  test('ollama models request stream usage (includeUsage: true)', () => {
    buildAiSdkLanguageModel({ type: 'ollama', modelId: 'llama3' });
    expect(compatFactory).toHaveBeenCalledTimes(1);
    expect(compatFactory.mock.calls[0][0]).toMatchObject({
      includeUsage: true,
    });
  });

  test('generic openai-compat models do NOT send the flag', () => {
    buildAiSdkLanguageModel({ type: 'openai-compat', modelId: 'gpt-x' });
    expect(compatFactory).toHaveBeenCalledTimes(1);
    expect('includeUsage' in compatFactory.mock.calls[0][0]).toBe(false);
  });
});

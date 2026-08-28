import { beforeEach, describe, expect, test, vi } from 'vitest';

const bedrockClient = vi.hoisted(() => ({ send: vi.fn(), destroy: vi.fn() }));
const listFoundationModelsCommand = vi.hoisted(() =>
  vi.fn(function MockListFoundationModelsCommand(input) {
    return { kind: 'foundation-models', input };
  }),
);
const listInferenceProfilesCommand = vi.hoisted(() =>
  vi.fn(function MockListInferenceProfilesCommand(input) {
    return { kind: 'inference-profiles', input };
  }),
);
const pricingClient = vi.hoisted(() => ({ send: vi.fn(), destroy: vi.fn() }));
const getProductsCommand = vi.hoisted(() =>
  vi.fn(function MockGetProductsCommand(input) {
    return { kind: 'pricing', input };
  }),
);

vi.mock('@aws-sdk/client-bedrock', () => ({
  BedrockClient: vi.fn().mockImplementation(function MockBedrockClient() {
    return bedrockClient;
  }),
  ListFoundationModelsCommand: listFoundationModelsCommand,
  ListInferenceProfilesCommand: listInferenceProfilesCommand,
}));
/**
 * archive#3654: the credential chain is mocked as RESOLVABLE on purpose. Health used
 * to be derived from exactly this — "a credential resolved on this laptop" —
 * and the tests below only discriminate against that old derivation if the
 * resolution succeeds.
 */
vi.mock('@aws-sdk/credential-providers', () => ({
  fromIni: vi.fn(() => async () => ({
    accessKeyId: 'test-access-key-id',
    secretAccessKey: 'secret',
  })),
  fromNodeProviderChain: vi.fn(() => async () => ({
    accessKeyId: 'test-access-key-id',
    secretAccessKey: 'secret',
  })),
}));
vi.mock('@aws-sdk/client-pricing', () => ({
  PricingClient: vi.fn().mockImplementation(function MockPricingClient() {
    return pricingClient;
  }),
  GetProductsCommand: getProductsCommand,
}));

import { BedrockClient } from '@aws-sdk/client-bedrock';
import { PricingClient } from '@aws-sdk/client-pricing';
import { BedrockLLMProvider } from '../bedrock-llm-provider.js';
import { BedrockModelCatalog } from '../bedrock-models.js';

describe('BedrockLLMProvider catalog provenance', () => {
  beforeEach(() => {
    bedrockClient.send.mockReset();
    listFoundationModelsCommand.mockClear();
    listInferenceProfilesCommand.mockClear();
  });

  // archive#1430 (deliberately re-pinned, not an oversight): AWS Bedrock's
  // ListFoundationModels/GetFoundationModel/ListInferenceProfiles responses
  // (checked against the installed @aws-sdk/client-bedrock type defs) carry
  // no tool/function-calling capability field at all — only modality,
  // streaming, customization, inference-type, and lifecycle metadata. There
  // is therefore still no truthful source for `supportsTools` on a Bedrock
  // foundation model, so the property stays genuinely absent (not `false`,
  // not a hardcoded per-family guess) rather than becoming derivable by this
  // issue. See the inline comment in `bedrock-llm-provider.ts`'s
  // `listModelCatalog` for the exact fields checked.
  test('publishes live capabilities without treating provisioning mode as tool support', async () => {
    bedrockClient.send.mockResolvedValueOnce({
      modelSummaries: [
        {
          modelId: 'anthropic.test',
          modelName: 'Anthropic Test',
          responseStreamingSupported: true,
          outputModalities: ['TEXT'],
          inferenceTypesSupported: ['ON_DEMAND'],
          inputModalities: ['TEXT', 'IMAGE'],
        },
      ],
    });
    bedrockClient.send.mockResolvedValueOnce({
      inferenceProfileSummaries: [],
    });

    const catalog = await new BedrockLLMProvider().listModelCatalog();

    expect(catalog).toEqual({
      source: 'live',
      models: [
        {
          id: 'anthropic.test',
          name: 'Anthropic Test',
          supportsVision: true,
        },
      ],
    });
    expect(catalog.models[0]).not.toHaveProperty('supportsTools');
  });

  test('publishes the same inference-profile selector used by invocation', async () => {
    bedrockClient.send.mockResolvedValueOnce({
      modelSummaries: [
        {
          modelId: 'anthropic.profiled-v1:0',
          modelArn:
            'arn:aws:bedrock:us-east-1::foundation-model/anthropic.profiled-v1:0',
          modelName: 'Profiled model',
          responseStreamingSupported: true,
          outputModalities: ['TEXT'],
          inferenceTypesSupported: ['PROVISIONED'],
        },
      ],
    });
    bedrockClient.send.mockResolvedValueOnce({
      inferenceProfileSummaries: [
        {
          inferenceProfileId: 'eu.anthropic.profiled-v1:0',
          inferenceProfileName: 'Profiled model',
          status: 'ACTIVE',
          models: [
            {
              modelArn:
                'arn:aws:bedrock:eu-west-1::foundation-model/anthropic.profiled-v1:0',
            },
          ],
        },
      ],
    });

    const catalog = await new BedrockLLMProvider().listModelCatalog();

    expect(catalog.models[0]?.id).toBe('eu.anthropic.profiled-v1:0');
  });

  test('publishes every matching profile selector without choosing by AWS result order', async () => {
    bedrockClient.send.mockResolvedValueOnce({
      modelSummaries: [
        {
          modelId: 'anthropic.profiled-v1:0',
          modelArn:
            'arn:aws:bedrock:us-east-1::foundation-model/anthropic.profiled-v1:0',
          modelName: 'Profiled model',
          responseStreamingSupported: true,
          outputModalities: ['TEXT'],
          inferenceTypesSupported: ['PROVISIONED'],
        },
      ],
    });
    bedrockClient.send.mockResolvedValueOnce({
      inferenceProfileSummaries: [
        {
          inferenceProfileId: 'user.application-profile',
          inferenceProfileName: 'Application profile',
          status: 'ACTIVE',
          models: [
            {
              modelArn:
                'arn:aws:bedrock:us-west-2::foundation-model/anthropic.profiled-v1:0',
            },
          ],
        },
        {
          inferenceProfileId: 'us.anthropic.profiled-v1:0',
          inferenceProfileName: 'Cross-region profile',
          status: 'ACTIVE',
          models: [
            {
              modelArn:
                'arn:aws:bedrock:us-east-1::foundation-model/anthropic.profiled-v1:0',
            },
          ],
        },
      ],
    });

    const catalog = await new BedrockLLMProvider().listModelCatalog();

    expect(catalog.models).toEqual([
      {
        id: 'us.anthropic.profiled-v1:0',
        name: 'Cross-region profile',
        supportsVision: undefined,
      },
      {
        id: 'user.application-profile',
        name: 'Application profile',
        supportsVision: undefined,
      },
    ]);
  });

  test('omits inactive inference profiles from launchable selectors', async () => {
    bedrockClient.send.mockResolvedValueOnce({
      modelSummaries: [
        {
          modelId: 'anthropic.inactive',
          modelArn:
            'arn:aws:bedrock:us-east-1::foundation-model/anthropic.inactive',
          modelName: 'Inactive model',
          responseStreamingSupported: true,
          outputModalities: ['TEXT'],
          inferenceTypesSupported: ['PROVISIONED'],
        },
      ],
    });
    bedrockClient.send.mockResolvedValueOnce({
      inferenceProfileSummaries: [
        {
          inferenceProfileId: 'us.anthropic.inactive',
          inferenceProfileName: 'Inactive profile',
          status: 'INACTIVE',
          models: [
            {
              modelArn:
                'arn:aws:bedrock:us-east-1::foundation-model/anthropic.inactive',
            },
          ],
        },
      ],
    });

    await expect(new BedrockLLMProvider().listModelCatalog()).resolves.toEqual({
      source: 'live',
      models: [],
    });
  });

  test('omits a profile-only model when AWS returns no matching profile evidence', async () => {
    bedrockClient.send.mockResolvedValueOnce({
      modelSummaries: [
        {
          modelId: 'anthropic.profile-required',
          modelArn:
            'arn:aws:bedrock:ap-southeast-1::foundation-model/anthropic.profile-required',
          modelName: 'Profile required',
          responseStreamingSupported: true,
          outputModalities: ['TEXT'],
          inferenceTypesSupported: ['PROVISIONED'],
        },
      ],
    });
    bedrockClient.send.mockResolvedValueOnce({
      inferenceProfileSummaries: [],
    });

    const catalog = await new BedrockLLMProvider({
      region: 'ap-southeast-1',
    }).listModelCatalog();

    expect(catalog).toEqual({ source: 'live', models: [] });
  });

  test('follows bounded inference-profile pagination to find evidence', async () => {
    bedrockClient.send.mockImplementation((command) => {
      if (command.kind === 'foundation-models') {
        return Promise.resolve({
          modelSummaries: [
            {
              modelId: 'anthropic.paged',
              modelArn:
                'arn:aws:bedrock:ap-southeast-2::foundation-model/anthropic.paged',
              modelName: 'Paged',
              responseStreamingSupported: true,
              outputModalities: ['TEXT'],
              inferenceTypesSupported: ['PROVISIONED'],
            },
          ],
        });
      }
      if (!command.input.nextToken) {
        return Promise.resolve({
          inferenceProfileSummaries: [],
          nextToken: 'page-2',
        });
      }
      return Promise.resolve({
        inferenceProfileSummaries: [
          {
            inferenceProfileId: 'apac.anthropic.paged',
            inferenceProfileName: 'Paged',
            status: 'ACTIVE',
            models: [
              {
                modelArn:
                  'arn:aws:bedrock:ap-southeast-1::foundation-model/anthropic.paged',
              },
            ],
          },
        ],
      });
    });

    const catalog = await new BedrockLLMProvider({
      region: 'ap-southeast-2',
    }).listModelCatalog({ maxEntries: 10 });

    expect(catalog.models[0]?.id).toBe('apac.anthropic.paged');
    expect(listInferenceProfilesCommand).toHaveBeenNthCalledWith(2, {
      maxResults: 10,
      nextToken: 'page-2',
    });
  });

  test('omits a profile that references more than one foundation model', async () => {
    bedrockClient.send.mockResolvedValueOnce({
      modelSummaries: [
        {
          modelId: 'anthropic.a',
          modelArn: 'arn:aws:bedrock:us-east-1::foundation-model/anthropic.a',
          modelName: 'A',
          responseStreamingSupported: true,
          outputModalities: ['TEXT'],
          inferenceTypesSupported: ['PROVISIONED'],
        },
        {
          modelId: 'anthropic.b',
          modelArn: 'arn:aws:bedrock:us-east-1::foundation-model/anthropic.b',
          modelName: 'B',
          responseStreamingSupported: true,
          outputModalities: ['TEXT'],
          inferenceTypesSupported: ['PROVISIONED'],
        },
      ],
    });
    bedrockClient.send.mockResolvedValueOnce({
      inferenceProfileSummaries: [
        {
          inferenceProfileId: 'multi-model-profile',
          inferenceProfileName: 'Multi-model',
          status: 'ACTIVE',
          models: [
            {
              modelArn:
                'arn:aws:bedrock:us-east-1::foundation-model/anthropic.a',
            },
            {
              modelArn:
                'arn:aws:bedrock:us-east-1::foundation-model/anthropic.b',
            },
          ],
        },
      ],
    });

    await expect(new BedrockLLMProvider().listModelCatalog()).resolves.toEqual({
      source: 'live',
      models: [],
    });
  });

  test('omits a streaming Bedrock model without text output', async () => {
    bedrockClient.send.mockResolvedValueOnce({
      modelSummaries: [
        {
          modelId: 'image-only',
          modelName: 'Image only',
          responseStreamingSupported: true,
          outputModalities: ['IMAGE'],
          inferenceTypesSupported: ['ON_DEMAND'],
        },
      ],
    });
    bedrockClient.send.mockResolvedValueOnce({
      inferenceProfileSummaries: [],
    });

    await expect(new BedrockLLMProvider().listModelCatalog()).resolves.toEqual({
      source: 'live',
      models: [],
    });
  });

  test('publishes no selectors when live discovery fails', async () => {
    bedrockClient.send.mockRejectedValue(new Error('discovery unavailable'));

    const catalog = await new BedrockLLMProvider().listModelCatalog();

    expect(catalog).toEqual({
      source: 'unavailable',
      models: [],
      reason: 'discovery unavailable',
      // archive#3654: an unnamed, statusless failure is not an observation of what
      // AWS thinks of these settings, so it must not read as a refusal.
      reasonKind: 'unreachable',
    });
  });

  test('waits for the sibling AWS request to clean up after discovery fails', async () => {
    let cleanupComplete = false;
    bedrockClient.send.mockImplementation(
      (command: { kind: string }, options?: { abortSignal?: AbortSignal }) => {
        if (command.kind === 'foundation-models') {
          return Promise.reject(new Error('foundation discovery failed'));
        }
        return new Promise((_resolve, reject) => {
          options?.abortSignal?.addEventListener(
            'abort',
            () => {
              setTimeout(() => {
                cleanupComplete = true;
                reject(options.abortSignal?.reason);
              }, 25);
            },
            { once: true },
          );
        });
      },
    );

    await expect(new BedrockLLMProvider().listModelCatalog()).resolves.toEqual({
      source: 'unavailable',
      models: [],
      reason: 'foundation discovery failed',
      reasonKind: 'unreachable',
    });
    expect(cleanupComplete).toBe(true);
  });

  test('rejects partial discovery when an inference-profile token repeats', async () => {
    bedrockClient.send.mockImplementation((command) => {
      if (command.kind === 'foundation-models') {
        return Promise.resolve({ modelSummaries: [] });
      }
      return Promise.resolve({
        inferenceProfileSummaries: [],
        nextToken: 'repeated-token',
      });
    });

    await expect(new BedrockLLMProvider().listModelCatalog()).resolves.toEqual({
      source: 'unavailable',
      models: [],
      reason: 'Bedrock inference profile pagination token did not advance.',
      // Station's own guard tripping, not AWS refusing these settings.
      reasonKind: 'unreachable',
    });
    expect(listInferenceProfilesCommand).toHaveBeenCalledTimes(2);
  });

  test('rejects partial discovery when inference profiles exceed the page limit', async () => {
    let profilePage = 0;
    bedrockClient.send.mockImplementation((command) => {
      if (command.kind === 'foundation-models') {
        return Promise.resolve({ modelSummaries: [] });
      }
      profilePage += 1;
      return Promise.resolve({
        inferenceProfileSummaries: [],
        nextToken: `page-${profilePage + 1}`,
      });
    });

    await expect(new BedrockLLMProvider().listModelCatalog()).resolves.toEqual({
      source: 'unavailable',
      models: [],
      reason: 'Bedrock inference profiles exceeded the page limit.',
      reasonKind: 'unreachable',
    });
    expect(listInferenceProfilesCommand).toHaveBeenCalledTimes(32);
  });

  test('propagates catalog cancellation instead of returning built-in models', async () => {
    const controller = new AbortController();
    bedrockClient.send.mockImplementation((_command, options) => {
      return new Promise((_resolve, reject) => {
        if (options?.abortSignal?.aborted) {
          reject(options.abortSignal.reason);
          return;
        }
        options?.abortSignal?.addEventListener(
          'abort',
          () => reject(options.abortSignal.reason),
          { once: true },
        );
      });
    });

    const pending = new BedrockLLMProvider().listModelCatalog({
      signal: controller.signal,
    });
    controller.abort(new Error('catalog cancelled'));

    await expect(pending).rejects.toThrow('catalog cancelled');
  });
});

// TESTS(a) (review fix round): pin mode-threading at the real BedrockClient
// constructor boundary through the public listModelCatalog entry point —
// not just the bedrock-credentials.ts unit — so a regression that quietly
// goes back to chain-always auth fails here even if the credentials helper
// itself is untouched.
describe('BedrockLLMProvider.listModelCatalog threads auth to the real BedrockClient constructor', () => {
  beforeEach(() => {
    vi.mocked(BedrockClient).mockClear();
    bedrockClient.send.mockReset();
    bedrockClient.send.mockResolvedValue({ modelSummaries: [] });
  });

  test('chain mode (default) constructs BedrockClient with no credential override', async () => {
    await new BedrockLLMProvider({ region: 'us-east-1' }).listModelCatalog();

    expect(BedrockClient).toHaveBeenCalledWith({ region: 'us-east-1' });
  });

  test('profile mode threads SigV4 credentials into the real BedrockClient constructor', async () => {
    await new BedrockLLMProvider({
      region: 'us-east-1',
      authMode: 'profile',
      profile: 'work',
    }).listModelCatalog();

    expect(BedrockClient).toHaveBeenCalledWith(
      expect.objectContaining({
        region: 'us-east-1',
        credentials: expect.any(Function),
      }),
    );
    const [callArgs] = vi.mocked(BedrockClient).mock.calls.at(-1)!;
    expect(callArgs).not.toHaveProperty('token');
  });

  test('api-key mode threads a bearer token into the real BedrockClient constructor', async () => {
    await new BedrockLLMProvider({
      region: 'us-east-1',
      authMode: 'api-key',
      apiKey: 'bedrock-key-123',
    }).listModelCatalog();

    expect(BedrockClient).toHaveBeenCalledWith({
      region: 'us-east-1',
      token: { token: 'bedrock-key-123' },
      authSchemePreference: ['httpBearerAuth'],
    });
  });

  test('a misconfigured profile mode never falls back to constructing a chain-auth BedrockClient', async () => {
    vi.mocked(BedrockClient).mockClear();

    // No profile name configured — must surface as an unavailable catalog
    // (fail-closed inside listModelCatalog's catch), never a silent
    // chain-authenticated construction.
    await expect(
      new BedrockLLMProvider({
        region: 'us-east-1',
        authMode: 'profile',
      }).listModelCatalog(),
    ).resolves.toEqual({
      source: 'unavailable',
      models: [],
      reason:
        'Bedrock connection is set to "profile" auth but has no named AWS profile configured.',
      // archive#3654: settings that cannot produce a request are a failed check with
      // a fixable reason, never a claim that AWS could not be reached.
      reasonKind: 'refused',
    });
    expect(BedrockClient).not.toHaveBeenCalled();
  });
});

describe('BedrockModelCatalog profile pagination', () => {
  beforeEach(() => {
    bedrockClient.send.mockReset();
    listInferenceProfilesCommand.mockClear();
  });

  test('reuses and bounds execution-region catalogs', () => {
    const catalog = new BedrockModelCatalog('us-east-1');
    const first = catalog.forRegion('aa-r0-test-1');

    expect(catalog.forRegion('us-east-1')).toBe(catalog);
    expect(catalog.forRegion('aa-r0-test-1')).toBe(first);
    for (let index = 1; index < 33; index += 1) {
      catalog.forRegion(`aa-r${index}-test-1`);
    }

    expect((catalog as any).regionalCatalogs.size).toBe(32);
    expect(catalog.forRegion('aa-r0-test-1')).not.toBe(first);
  });

  test('rejects a non-advancing profile token instead of caching partial data', async () => {
    bedrockClient.send.mockResolvedValue({
      inferenceProfileSummaries: [],
      nextToken: 'repeated-token',
    });

    await expect(
      new BedrockModelCatalog().listInferenceProfiles(),
    ).rejects.toThrow('did not advance');
    expect(listInferenceProfilesCommand).toHaveBeenCalledTimes(2);
  });

  test('refreshes model evidence after the bounded cache lifetime', async () => {
    let now = 0;
    bedrockClient.send
      .mockResolvedValueOnce({
        modelSummaries: [{ modelId: 'model-a', modelName: 'Model A' }],
      })
      .mockResolvedValueOnce({
        modelSummaries: [{ modelId: 'model-b', modelName: 'Model B' }],
      });
    const catalog = new BedrockModelCatalog('us-east-1', { now: () => now });

    await expect(catalog.listModels()).resolves.toEqual([
      expect.objectContaining({ modelId: 'model-a' }),
    ]);
    await expect(catalog.listModels()).resolves.toEqual([
      expect.objectContaining({ modelId: 'model-a' }),
    ]);
    expect(bedrockClient.send).toHaveBeenCalledTimes(1);

    now = 15 * 60 * 1000 + 1;
    await expect(catalog.listModels()).resolves.toEqual([
      expect.objectContaining({ modelId: 'model-b' }),
    ]);
    expect(bedrockClient.send).toHaveBeenCalledTimes(2);
  });

  test('rejects profile pagination beyond the page limit', async () => {
    let page = 0;
    bedrockClient.send.mockImplementation(() => {
      page += 1;
      return Promise.resolve({
        inferenceProfileSummaries: [],
        nextToken: `page-${page + 1}`,
      });
    });

    await expect(
      new BedrockModelCatalog().listInferenceProfiles(),
    ).rejects.toThrow('exceeded the page limit');
    expect(listInferenceProfilesCommand).toHaveBeenCalledTimes(32);
  });

  test('refuses to choose among multiple matching profile selectors', async () => {
    const catalog = new BedrockModelCatalog();
    vi.spyOn(catalog, 'listModels').mockResolvedValue([
      {
        modelId: 'anthropic.ambiguous',
        modelArn:
          'arn:aws:bedrock:us-east-1::foundation-model/anthropic.ambiguous',
        modelName: 'Ambiguous',
        providerName: 'Anthropic',
        inputModalities: ['TEXT'],
        outputModalities: ['TEXT'],
        responseStreamingSupported: true,
        customizationsSupported: [],
        inferenceTypesSupported: ['PROVISIONED'],
      },
    ]);
    vi.spyOn(catalog, 'listInferenceProfiles').mockResolvedValue([
      {
        inferenceProfileId: 'application-profile',
        inferenceProfileArn: '',
        inferenceProfileName: 'Application',
        type: 'APPLICATION',
        status: 'ACTIVE',
        models: [
          {
            modelArn:
              'arn:aws:bedrock:us-west-2::foundation-model/anthropic.ambiguous',
          },
        ],
      },
      {
        inferenceProfileId: 'us.anthropic.ambiguous',
        inferenceProfileArn: '',
        inferenceProfileName: 'System',
        type: 'SYSTEM_DEFINED',
        status: 'ACTIVE',
        models: [
          {
            modelArn:
              'arn:aws:bedrock:us-east-1::foundation-model/anthropic.ambiguous',
          },
        ],
      },
    ]);

    await expect(catalog.resolveModelId('anthropic.ambiguous')).rejects.toThrow(
      'multiple matching inference profiles',
    );
    await expect(catalog.validateModelId('anthropic.ambiguous')).resolves.toBe(
      false,
    );
  });

  test('validates a profile-required base id only when it resolves uniquely', async () => {
    const catalog = new BedrockModelCatalog();
    vi.spyOn(catalog, 'listModels').mockResolvedValue([
      {
        modelId: 'anthropic.profile-required',
        modelArn:
          'arn:aws:bedrock:us-east-1::foundation-model/anthropic.profile-required',
        modelName: 'Profile required',
        providerName: 'Anthropic',
        inputModalities: ['TEXT'],
        outputModalities: ['TEXT'],
        responseStreamingSupported: true,
        customizationsSupported: [],
        inferenceTypesSupported: ['PROVISIONED'],
      },
    ]);
    vi.spyOn(catalog, 'listInferenceProfiles').mockResolvedValue([
      {
        inferenceProfileId: 'us.anthropic.profile-required',
        inferenceProfileArn: '',
        inferenceProfileName: 'Profile required',
        type: 'SYSTEM_DEFINED',
        status: 'ACTIVE',
        models: [
          {
            modelArn:
              'arn:aws:bedrock:us-west-2::foundation-model/anthropic.profile-required',
          },
        ],
      },
    ]);

    await expect(
      catalog.validateModelId('anthropic.profile-required'),
    ).resolves.toBe(true);
    await expect(
      catalog.resolveModelId('anthropic.profile-required'),
    ).resolves.toBe('us.anthropic.profile-required');
  });

  test('keeps an on-demand selector when multiple profiles also reference it', async () => {
    const catalog = new BedrockModelCatalog();
    vi.spyOn(catalog, 'listModels').mockResolvedValue([
      {
        modelId: 'anthropic.on-demand',
        modelArn:
          'arn:aws:bedrock:us-east-1::foundation-model/anthropic.on-demand',
        modelName: 'On demand',
        providerName: 'Anthropic',
        inputModalities: ['TEXT'],
        outputModalities: ['TEXT'],
        responseStreamingSupported: true,
        customizationsSupported: [],
        inferenceTypesSupported: ['ON_DEMAND'],
      },
    ]);
    vi.spyOn(catalog, 'listInferenceProfiles').mockResolvedValue(
      ['us', 'eu'].map((region) => ({
        inferenceProfileId: `${region}.anthropic.on-demand`,
        inferenceProfileArn: '',
        inferenceProfileName: region,
        type: 'SYSTEM_DEFINED',
        status: 'ACTIVE',
        models: [
          {
            modelArn: `arn:aws:bedrock:${region}-region::foundation-model/anthropic.on-demand`,
          },
        ],
      })),
    );

    await expect(catalog.resolveModelId('anthropic.on-demand')).resolves.toBe(
      'anthropic.on-demand',
    );
  });

  test('rejects exact selectors without streaming text foundation evidence', async () => {
    const catalog = new BedrockModelCatalog();
    vi.spyOn(catalog, 'listModels').mockResolvedValue([
      {
        modelId: 'example.image-only',
        modelArn:
          'arn:aws:bedrock:us-east-1::foundation-model/example.image-only',
        modelName: 'Image only',
        providerName: 'Example',
        inputModalities: ['TEXT'],
        outputModalities: ['IMAGE'],
        responseStreamingSupported: true,
        customizationsSupported: [],
        inferenceTypesSupported: ['ON_DEMAND'],
      },
    ]);
    vi.spyOn(catalog, 'listInferenceProfiles').mockResolvedValue([
      {
        inferenceProfileId: 'us.example.image-only',
        inferenceProfileArn: '',
        inferenceProfileName: 'Image only profile',
        type: 'SYSTEM_DEFINED',
        status: 'ACTIVE',
        models: [
          {
            modelArn:
              'arn:aws:bedrock:us-west-2::foundation-model/example.image-only',
          },
        ],
      },
    ]);

    await expect(catalog.validateModelId('example.image-only')).resolves.toBe(
      false,
    );
    await expect(
      catalog.validateModelId('us.example.image-only'),
    ).resolves.toBe(false);
    await expect(
      catalog.resolveModelId('us.example.image-only'),
    ).rejects.toThrow('AWS launchability evidence');
    await expect(catalog.resolveModelId('unknown-selector')).rejects.toThrow(
      'AWS launchability evidence',
    );
  });
});

describe('BedrockModelCatalog pricing bounds', () => {
  beforeEach(() => {
    pricingClient.send.mockReset();
    getProductsCommand.mockClear();
    vi.mocked(PricingClient).mockClear();
  });

  // MED (review fix round): the Pricing API has no bearer-token equivalent
  // to Bedrock's own httpBearerAuth scheme, so an api-key connection must
  // never silently query Pricing under the default chain identity — it must
  // fail closed instead.
  test('gates pricing off for api-key auth mode instead of querying under a different identity', async () => {
    const catalog = new BedrockModelCatalog('us-east-1', {
      authMode: 'api-key',
      apiKey: 'bedrock-key-123',
    });

    await expect(catalog.getModelPricing()).rejects.toThrow(
      /api-key.*Pricing API/i,
    );
    expect(pricingClient.send).not.toHaveBeenCalled();
  });

  test('threads profile-mode SigV4 credentials into the Pricing client', () => {
    new BedrockModelCatalog('us-east-1', {
      authMode: 'profile',
      profile: 'work',
    });

    expect(PricingClient).toHaveBeenCalledWith(
      expect.objectContaining({
        region: 'us-east-1',
        credentials: expect.any(Function),
      }),
    );
  });

  test('chain mode (default) constructs the Pricing client with no credential override', () => {
    new BedrockModelCatalog('us-east-1');

    expect(PricingClient).toHaveBeenCalledWith({ region: 'us-east-1' });
  });

  test('rejects a non-advancing pricing token', async () => {
    pricingClient.send.mockResolvedValue({
      PriceList: [],
      NextToken: 'repeated-token',
    });

    await expect(new BedrockModelCatalog().getModelPricing()).rejects.toThrow(
      'did not advance',
    );
    expect(getProductsCommand).toHaveBeenCalledTimes(2);
  });

  test('rejects malformed pricing regions before calling AWS', async () => {
    await expect(
      new BedrockModelCatalog().getModelPricing('not a region'),
    ).rejects.toThrow('valid bounded AWS region id');
    expect(pricingClient.send).not.toHaveBeenCalled();
  });

  test('bounds the per-region pricing cache with LRU eviction', async () => {
    pricingClient.send.mockResolvedValue({ PriceList: [] });
    const catalog = new BedrockModelCatalog();

    for (let index = 0; index < 33; index += 1) {
      await catalog.getModelPricing(`aa-r${index}-test-1`);
    }

    const cache = (catalog as any).pricingCache as Map<string, unknown>;
    expect(cache.size).toBe(32);
    expect(cache.has('aa-r0-test-1')).toBe(false);
    expect(cache.has('aa-r32-test-1')).toBe(true);
  });

  test('shares concurrent pricing discovery for the same region', async () => {
    let resolvePricing!: (value: { PriceList: never[] }) => void;
    pricingClient.send.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePricing = resolve;
        }),
    );
    const catalog = new BedrockModelCatalog();

    const first = catalog.getModelPricing('us-east-1');
    const second = catalog.getModelPricing('us-east-1');
    expect(pricingClient.send).toHaveBeenCalledTimes(1);
    resolvePricing({ PriceList: [] });

    await expect(Promise.all([first, second])).resolves.toEqual([[], []]);
  });

  test('isolates caller cancellation from shared pricing discovery', async () => {
    let resolvePricing!: (value: { PriceList: never[] }) => void;
    pricingClient.send.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePricing = resolve;
        }),
    );
    const catalog = new BedrockModelCatalog();
    const cancelled = new AbortController();

    const first = catalog.getModelPricing('us-east-1', {
      signal: cancelled.signal,
    });
    const second = catalog.getModelPricing('us-east-1');
    cancelled.abort(new Error('caller cancelled'));

    await expect(first).rejects.toThrow('caller cancelled');
    expect(pricingClient.send).toHaveBeenCalledTimes(1);
    const third = catalog.getModelPricing('us-east-1');
    expect(pricingClient.send).toHaveBeenCalledTimes(1);
    resolvePricing({ PriceList: [] });
    await expect(Promise.all([second, third])).resolves.toEqual([[], []]);
  });

  test('aborts shared pricing ownership and prevents late cache resurrection on clear', async () => {
    let resolvePricing!: (value: { PriceList: never[] }) => void;
    let ownerSignal: AbortSignal | undefined;
    pricingClient.send.mockImplementation(
      (_command, options?: { abortSignal?: AbortSignal }) => {
        ownerSignal = options?.abortSignal;
        return new Promise((resolve) => {
          resolvePricing = resolve;
        });
      },
    );
    const catalog = new BedrockModelCatalog();

    const pending = catalog.getModelPricing('us-east-1');
    catalog.clearCache();

    await expect(pending).rejects.toThrow('invalidated');
    expect(ownerSignal?.aborted).toBe(true);
    resolvePricing({ PriceList: [] });
    await Promise.resolve();
    expect((catalog as any).pricingCache.size).toBe(0);
    expect((catalog as any).pricingInflight.size).toBe(0);
  });

  test('disposes AWS clients and aborts shared pricing ownership', async () => {
    let ownerSignal: AbortSignal | undefined;
    pricingClient.send.mockImplementation(
      (_command, options?: { abortSignal?: AbortSignal }) => {
        ownerSignal = options?.abortSignal;
        return new Promise(() => {});
      },
    );
    const catalog = new BedrockModelCatalog();
    const pending = catalog.getModelPricing('us-east-1');

    catalog.dispose();

    await expect(pending).rejects.toThrow('invalidated');
    expect(ownerSignal?.aborted).toBe(true);
    expect(bedrockClient.destroy).toHaveBeenCalled();
    expect(pricingClient.destroy).toHaveBeenCalled();
  });

  test('times out a hung pricing owner and releases the concurrency slot', async () => {
    vi.useFakeTimers();
    try {
      pricingClient.send.mockImplementation(() => new Promise(() => {}));
      const catalog = new BedrockModelCatalog();
      const pending = catalog.getModelPricing('us-east-1');
      const timedOut = expect(pending).rejects.toThrow('timed out');

      await vi.advanceTimersByTimeAsync(30_000);
      await timedOut;
      expect((catalog as any).pricingInflight.size).toBe(0);

      pricingClient.send.mockResolvedValue({ PriceList: [] });
      await expect(catalog.getModelPricing('us-east-1')).resolves.toEqual([]);
      expect(pricingClient.send).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test('bounds concurrent cold pricing regions', async () => {
    const resolvers: Array<(value: { PriceList: never[] }) => void> = [];
    pricingClient.send.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const catalog = new BedrockModelCatalog();
    const pending = Array.from({ length: 8 }, (_, index) =>
      catalog.getModelPricing(`aa-r${index}-test-1`),
    );

    await expect(catalog.getModelPricing('aa-r8-test-1')).rejects.toThrow(
      'pricing concurrency limit exceeded',
    );
    for (const resolve of resolvers) resolve({ PriceList: [] });
    await expect(Promise.all(pending)).resolves.toEqual(
      Array.from({ length: 8 }, () => []),
    );
  });

  test('rejects pricing pagination beyond the page limit', async () => {
    let page = 0;
    pricingClient.send.mockImplementation(() => {
      page += 1;
      return Promise.resolve({ PriceList: [], NextToken: `page-${page + 1}` });
    });

    await expect(new BedrockModelCatalog().getModelPricing()).rejects.toThrow(
      'exceeded the page limit',
    );
    expect(getProductsCommand).toHaveBeenCalledTimes(32);
  });

  test('rejects pricing responses beyond entry and byte limits', async () => {
    pricingClient.send.mockResolvedValueOnce({
      PriceList: Array.from({ length: 1001 }, () => '{}'),
    });
    await expect(new BedrockModelCatalog().getModelPricing()).rejects.toThrow(
      'exceeded the entry limit',
    );

    pricingClient.send.mockResolvedValueOnce({
      PriceList: [`{"padding":"${'x'.repeat(2 * 1024 * 1024)}"}`],
    });
    await expect(new BedrockModelCatalog().getModelPricing()).rejects.toThrow(
      'exceeded the response byte limit',
    );
  });

  test('refreshes pricing evidence after the bounded cache lifetime', async () => {
    let now = 0;
    const priceEntry = (model: string) =>
      JSON.stringify({
        product: {
          attributes: {
            model,
            provider: 'Example',
            inferenceType: 'Input',
            feature: 'On-demand Inference',
          },
        },
        terms: {
          OnDemand: {
            term: {
              priceDimensions: {
                dimension: { pricePerUnit: { USD: '0.1' } },
              },
            },
          },
        },
      });
    pricingClient.send
      .mockResolvedValueOnce({ PriceList: [priceEntry('model-a')] })
      .mockResolvedValueOnce({ PriceList: [priceEntry('model-b')] });
    const catalog = new BedrockModelCatalog('us-east-1', { now: () => now });

    await expect(catalog.getModelPricing()).resolves.toEqual([
      expect.objectContaining({ modelId: 'model-a' }),
    ]);
    await catalog.getModelPricing();
    expect(pricingClient.send).toHaveBeenCalledTimes(1);

    now = 15 * 60 * 1000 + 1;
    await expect(catalog.getModelPricing()).resolves.toEqual([
      expect.objectContaining({ modelId: 'model-b' }),
    ]);
    expect(pricingClient.send).toHaveBeenCalledTimes(2);
  });
});

/**
 * archive#3654 — Bedrock recorded no check receipts.
 *
 * Two defects met here. The catalogue catch discarded the AWS error, so no
 * `reason`/`reasonKind` ever reached `recordModelCatalogDiscovery`, which
 * drops an observation missing either — the connection therefore read
 * "Saved — not verified" whatever had happened. And `healthCheck` was
 * overridden to answer "did a credential resolve on this device", which
 * `testConnection` records as a PASSED check: a verified connection with no
 * request having left the machine, and a short-circuit that made the
 * classified outcome unreachable in the common case.
 */
describe('BedrockLLMProvider check receipts (#3654)', () => {
  beforeEach(() => {
    bedrockClient.send.mockReset();
    listFoundationModelsCommand.mockClear();
    listInferenceProfilesCommand.mockClear();
  });

  function denied(): Error {
    const error = new Error(
      'User: arn:aws:iam::123456789012:user/station is not authorized to perform: bedrock:ListFoundationModels',
    );
    error.name = 'AccessDeniedException';
    (error as Error & { $metadata?: unknown }).$metadata = {
      httpStatusCode: 403,
    };
    return error;
  }

  test('a denied catalogue is classified as no-catalog and carries a redacted reason', async () => {
    bedrockClient.send.mockRejectedValue(denied());

    const catalog = await new BedrockLLMProvider().listModelCatalog();

    expect(catalog.source).toBe('unavailable');
    // no-catalog is what lets the explicit test go on to the chat probe, which
    // is the only thing that can prove a list-denied connection still works.
    expect(catalog.reasonKind).toBe('no-catalog');
    expect(catalog.reason).toContain('bedrock:ListFoundationModels');
    expect(catalog.reason).not.toContain('123456789012');
    expect(catalog.reason).not.toContain('user/station');
  });

  test('a rejected credential is classified as a refusal', async () => {
    const error = new Error('The security token included is not valid.');
    error.name = 'UnrecognizedClientException';
    bedrockClient.send.mockRejectedValue(error);

    const catalog = await new BedrockLLMProvider().listModelCatalog();

    expect(catalog.reasonKind).toBe('refused');
  });

  test('health is what AWS answered, not what resolved on this device', async () => {
    bedrockClient.send.mockRejectedValue(denied());

    await expect(new BedrockLLMProvider().healthCheck()).resolves.toBe(false);
  });

  test('health passes when AWS answers with a launchable model', async () => {
    bedrockClient.send.mockImplementation((command: { kind: string }) => {
      if (command.kind === 'foundation-models') {
        return Promise.resolve({
          modelSummaries: [
            {
              modelId: 'anthropic.claude-3-haiku',
              modelName: 'Claude 3 Haiku',
              inferenceTypesSupported: ['ON_DEMAND'],
              inputModalities: ['TEXT'],
              outputModalities: ['TEXT'],
              responseStreamingSupported: true,
              modelLifecycle: { status: 'ACTIVE' },
            },
          ],
        });
      }
      return Promise.resolve({ inferenceProfileSummaries: [] });
    });

    await expect(new BedrockLLMProvider().healthCheck()).resolves.toBe(true);
  });

  test('prerequisites still report the credentials this device can resolve', async () => {
    // The question `getPrerequisites` was always asking, kept separate from
    // health: a credential that resolves is setup done, even while AWS is
    // refusing the catalogue.
    bedrockClient.send.mockRejectedValue(denied());

    const [prerequisite] = await new BedrockLLMProvider().getPrerequisites();

    expect(prerequisite?.status).toBe('installed');
  });
});

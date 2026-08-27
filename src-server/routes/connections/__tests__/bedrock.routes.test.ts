import { describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  bedrockOps: { add: vi.fn() },
}));

const { createBedrockRoutes } = await import('../bedrock.js');

function createMockCatalog() {
  return {
    listModels: vi.fn().mockResolvedValue([
      {
        modelId: 'anthropic.claude-3',
        modelArn:
          'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3',
        modelName: 'Claude 3',
        providerName: 'Anthropic',
        inputModalities: ['TEXT', 'IMAGE'],
        outputModalities: ['TEXT'],
        responseStreamingSupported: true,
        inferenceTypesSupported: ['ON_DEMAND'],
      },
    ]),
    listInferenceProfiles: vi.fn().mockResolvedValue([]),
    getModelPricing: vi.fn().mockResolvedValue({
      'anthropic.claude-3': { input: 0.003, output: 0.015 },
    }),
    validateModelId: vi.fn().mockResolvedValue(true),
  };
}

const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
const appConfig = { region: 'us-east-1' };

function setup(catalog = createMockCatalog()) {
  const app = createBedrockRoutes(
    () => catalog as any,
    appConfig as any,
    logger as any,
  );
  return { app, catalog };
}

describe('Bedrock Routes', () => {
  // SDK useModelsQuery expects { success, data } and reads data as model array
  test('GET /models returns { success, data } with model objects', async () => {
    const { app } = setup();
    const body = await json(await app.request('/models'));
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data[0]).toHaveProperty('modelId');
    expect(body.data[0]).toHaveProperty('modelName');
  });

  test('GET /models preserves on-demand selectors and exposes only active inference profiles', async () => {
    const catalog = createMockCatalog();
    catalog.listInferenceProfiles.mockResolvedValue([
      {
        inferenceProfileId: 'eu.anthropic.claude-3',
        inferenceProfileArn:
          'arn:aws:bedrock:eu-west-1:123:inference-profile/eu.anthropic.claude-3',
        inferenceProfileName: 'EU Claude 3',
        type: 'SYSTEM_DEFINED',
        status: 'ACTIVE',
        models: [
          {
            modelArn:
              'arn:aws:bedrock:eu-west-1::foundation-model/anthropic.claude-3',
          },
        ],
      },
      {
        inferenceProfileId: 'us.anthropic.claude-3',
        inferenceProfileArn:
          'arn:aws:bedrock:us-east-1:123:inference-profile/us.anthropic.claude-3',
        inferenceProfileName: 'Retired Claude 3',
        type: 'SYSTEM_DEFINED',
        status: 'INACTIVE',
        models: [
          {
            modelArn:
              'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3',
          },
        ],
      },
      {
        inferenceProfileId: 'active.unrelated-profile',
        inferenceProfileArn:
          'arn:aws:bedrock:us-east-1:123:inference-profile/active.unrelated-profile',
        inferenceProfileName: 'Unrelated profile',
        type: 'APPLICATION',
        status: 'ACTIVE',
        models: [],
      },
    ]);
    const { app } = setup(catalog);

    const body = await json(await app.request('/models'));

    expect(
      body.data.map((model: { modelId: string }) => model.modelId),
    ).toEqual(['anthropic.claude-3', 'eu.anthropic.claude-3']);
    expect(body.data[1]).toMatchObject({
      inputModalities: ['TEXT', 'IMAGE'],
      outputModalities: ['TEXT'],
      responseStreamingSupported: true,
    });
  });

  test('GET /models omits on-demand models that are not streaming text models', async () => {
    const catalog = createMockCatalog();
    catalog.listModels.mockResolvedValue([
      ...(await catalog.listModels()),
      {
        modelId: 'image-only',
        modelArn: 'arn:aws:bedrock:us-east-1::foundation-model/image-only',
        modelName: 'Image only',
        providerName: 'Example',
        inputModalities: ['TEXT'],
        outputModalities: ['IMAGE'],
        responseStreamingSupported: true,
        inferenceTypesSupported: ['ON_DEMAND'],
      },
      {
        modelId: 'non-streaming',
        modelArn: 'arn:aws:bedrock:us-east-1::foundation-model/non-streaming',
        modelName: 'Non streaming',
        providerName: 'Example',
        inputModalities: ['TEXT'],
        outputModalities: ['TEXT'],
        responseStreamingSupported: false,
        inferenceTypesSupported: ['ON_DEMAND'],
      },
    ]);
    const { app } = setup(catalog);

    const body = await json(await app.request('/models'));

    expect(
      body.data.map((model: { modelId: string }) => model.modelId),
    ).toEqual(['anthropic.claude-3']);
  });

  test('GET /models returns 500 when catalog not initialized', async () => {
    const app = createBedrockRoutes(
      () => undefined,
      appConfig as any,
      logger as any,
    );
    const res = await app.request('/models');
    expect(res.status).toBe(500);
    const body = await json(res);
    expect(body.success).toBe(false);
  });

  test('GET /models rejects an oversized response projection', async () => {
    const catalog = createMockCatalog();
    catalog.listModels.mockResolvedValue([
      {
        modelId: 'oversized',
        modelArn: '',
        modelName: 'x'.repeat(2 * 1024 * 1024),
        providerName: 'Example',
        inputModalities: ['TEXT'],
        outputModalities: ['TEXT'],
        responseStreamingSupported: true,
        inferenceTypesSupported: ['ON_DEMAND'],
      },
    ]);
    const { app } = setup(catalog);

    const res = await app.request('/models');

    expect(res.status).toBe(500);
    expect(await json(res)).toMatchObject({
      success: false,
      error: 'Bedrock model catalog exceeded the response byte limit.',
    });
  });

  test('GET /pricing returns { success, data }', async () => {
    const { app } = setup();
    const body = await json(await app.request('/pricing'));
    expect(body.success).toBe(true);
    expect(body.data).toBeDefined();
  });

  test('GET /pricing rejects unbounded or malformed region keys', async () => {
    const { app, catalog } = setup();

    const response = await app.request(
      `/pricing?region=${encodeURIComponent('x'.repeat(1000))}`,
    );

    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({
      success: false,
      error: 'Bedrock region must be a valid bounded AWS region id.',
    });
    expect(catalog.getModelPricing).not.toHaveBeenCalled();
  });

  test('GET /models/:modelId/validate returns { success, data: { modelId, isValid } }', async () => {
    const { app } = setup();
    const body = await json(
      await app.request('/models/anthropic.claude-3/validate'),
    );
    expect(body.success).toBe(true);
    expect(body.data).toEqual({ modelId: 'anthropic.claude-3', isValid: true });
  });

  test('GET /models/:modelId returns model detail', async () => {
    const { app } = setup();
    const body = await json(await app.request('/models/anthropic.claude-3'));
    expect(body.success).toBe(true);
    expect(body.data.modelId).toBe('anthropic.claude-3');
    expect(body.data.modelName).toBe('Claude 3');
  });

  test('GET /models/:modelId returns detail for a listed inference profile selector', async () => {
    const catalog = createMockCatalog();
    catalog.listInferenceProfiles.mockResolvedValue([
      {
        inferenceProfileId: 'eu.anthropic.claude-3',
        inferenceProfileArn:
          'arn:aws:bedrock:eu-west-1:123:inference-profile/eu.anthropic.claude-3',
        inferenceProfileName: 'EU Claude 3',
        type: 'SYSTEM_DEFINED',
        status: 'ACTIVE',
        models: [
          {
            modelArn:
              'arn:aws:bedrock:eu-west-1::foundation-model/anthropic.claude-3',
          },
        ],
      },
    ]);
    const { app } = setup(catalog);

    const body = await json(await app.request('/models/eu.anthropic.claude-3'));

    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      modelId: 'eu.anthropic.claude-3',
      modelName: 'EU Claude 3',
      isInferenceProfile: true,
    });
  });

  test('GET /models/:modelId returns 404 for unknown model', async () => {
    const { app } = setup();
    const res = await app.request('/models/nonexistent');
    expect(res.status).toBe(404);
    const body = await json(res);
    expect(body.success).toBe(false);
  });
});

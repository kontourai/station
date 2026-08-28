import { beforeEach, describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';

const defaultModelSummaries = () => ({
  modelSummaries: [
    {
      modelId: 'anthropic.claude-3-sonnet',
      modelName: 'Claude 3 Sonnet',
      providerName: 'Anthropic',
      inputModalities: ['TEXT', 'IMAGE'],
      outputModalities: ['TEXT'],
      responseStreamingSupported: true,
      modelLifecycle: { status: 'ACTIVE' },
    },
  ],
});

const bedrockClientMock = vi.hoisted(() => ({
  send: vi.fn(),
}));

vi.mock('../../../telemetry/metrics.js', () => ({
  bedrockOps: { add: vi.fn() },
}));

const awsProfilesMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ profiles: ['default', 'work'], available: true }),
);

vi.mock('../../../providers/llm/aws-profiles.js', () => ({
  listAwsProfiles: awsProfilesMock,
}));

const bedrockClientCtor = vi.hoisted(() =>
  vi.fn().mockImplementation(function MockBedrockClient() {
    return bedrockClientMock;
  }),
);

vi.mock('@aws-sdk/client-bedrock', () => ({
  BedrockClient: bedrockClientCtor,
  ListFoundationModelsCommand: vi.fn(),
}));

vi.mock('@aws-sdk/client-pricing', () => ({
  PricingClient: vi.fn().mockImplementation(function MockPricingClient() {
    return {
      send: vi.fn().mockResolvedValue({ PriceList: [] }),
    };
  }),
  GetProductsCommand: vi.fn(),
}));

describe('Models Routes', () => {
  // archive#1557: the route is a factory taking the stored config, so each
  // test gets its own instance with its own caches. It used to be a module
  // singleton whose caches had to be cleared with `vi.resetModules()`.
  const appConfig = {
    defaultModel: 'claude-3',
    invokeModel: 'nova',
    structureModel: 'nova-micro',
    region: 'eu-west-1',
  } as const;

  const buildApp = async (
    config: Record<string, unknown> = { ...appConfig },
  ) => {
    const { createModelsRoutes } = await import('../models.js');
    return createModelsRoutes({ getAppConfig: () => config as never });
  };

  beforeEach(() => {
    vi.resetModules();
    bedrockClientMock.send.mockReset();
    bedrockClientMock.send.mockResolvedValue(defaultModelSummaries());
    bedrockClientCtor.mockClear();
  });

  test('GET / returns { success, data } with model catalog entries', async () => {
    const app = await buildApp();
    const body = await json(await app.request('/'));

    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data[0]).toMatchObject({
      modelId: 'anthropic.claude-3-sonnet',
      modelName: 'Claude 3 Sonnet',
      outputModalities: ['TEXT'],
    });
  });

  test('GET /capabilities returns empty success when AWS credentials are unavailable', async () => {
    bedrockClientMock.send.mockRejectedValueOnce(
      Object.assign(new Error('missing credentials'), {
        name: 'CredentialsProviderError',
      }),
    );

    const app = await buildApp();
    const body = await json(await app.request('/capabilities'));

    expect(body.success).toBe(true);
    expect(body.data).toEqual([]);
    expect(body.warning).toContain('AWS credentials not configured');
    // archive#3373: the empty list on its own cannot say whether Bedrock
    // reported no models or was never asked. `complete: false` is what makes
    // this answer "unknown" rather than "none".
    expect(body.source).toBe('bedrock');
    expect(body.complete).toBe(false);
  });

  test('GET /capabilities marks an enumerated catalogue complete and names its source (#3373)', async () => {
    const app = await buildApp();
    const body = await json(await app.request('/capabilities'));

    expect(body.source).toBe('bedrock');
    expect(body.complete).toBe(true);
  });

  test('GET /capabilities keeps its provenance when the answer is served from cache (#3373)', async () => {
    const app = await buildApp();
    await json(await app.request('/capabilities'));
    bedrockClientMock.send.mockRejectedValue(
      new Error('cache hit must not re-query Bedrock'),
    );

    const body = await json(await app.request('/capabilities'));

    expect(body.data).toHaveLength(1);
    expect(body.source).toBe('bedrock');
    expect(body.complete).toBe(true);
  });

  // SDK useModelCapabilitiesQuery expects { success, data } where data is array
  // UI reads: modelId, supportsImages, supportsStreaming, etc.
  test('GET /capabilities returns { success, data } with capability fields', async () => {
    const app = await buildApp();
    const body = await json(await app.request('/capabilities'));
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    const model = body.data[0];
    expect(model).toHaveProperty('modelId');
    expect(model).toHaveProperty('modelName');
    expect(model).toHaveProperty('provider');
    expect(model).toHaveProperty('supportsImages');
    expect(model).toHaveProperty('supportsStreaming');
    expect(model.supportsImages).toBe(true);
  });

  test("consults the connection's configured auth, not the default chain (#3399)", async () => {
    const { createModelsRoutes } = await import('../models.js');
    const app = createModelsRoutes({
      getAppConfig: () => ({ ...appConfig }) as never,
      getBedrockAuth: () => ({ authMode: 'profile', profile: 'work' }),
    });

    await json(await app.request('/capabilities'));

    // A user who configured a named profile must have capability discovery
    // answered by those credentials, not by whatever the ambient chain finds.
    expect(bedrockClientCtor).toHaveBeenCalledWith(
      expect.objectContaining({ credentials: expect.anything() }),
    );
  });

  test('falls back to the default chain when the auth source throws', async () => {
    const { createModelsRoutes } = await import('../models.js');
    const app = createModelsRoutes({
      getAppConfig: () => ({ ...appConfig }) as never,
      getBedrockAuth: () => {
        throw new Error('connection store unavailable');
      },
    });

    const body = await json(await app.request('/capabilities'));

    // A connection store that cannot answer must not take the catalogue down.
    expect(body.success).toBe(true);
    expect(body.complete).toBe(true);
  });

  test('GET /aws-profiles returns { success, data: { profiles, available } }', async () => {
    const app = await buildApp();
    const body = await json(await app.request('/aws-profiles'));

    expect(body.success).toBe(true);
    expect(body.data).toEqual({
      profiles: ['default', 'work'],
      available: true,
    });
  });

  test('GET /aws-profiles reports failure without leaking file contents', async () => {
    awsProfilesMock.mockRejectedValueOnce(new Error('unexpected read failure'));
    const app = await buildApp();
    const body = await json(await app.request('/aws-profiles'));

    expect(body.success).toBe(false);
  });

  test('GET /pricing/:modelId returns { success, data } with pricing fields', async () => {
    const app = await buildApp();
    const body = await json(
      await app.request('/pricing/anthropic.claude-3-sonnet'),
    );
    expect(body.success).toBe(true);
    expect(body.data).toHaveProperty('modelId');
    expect(body.data).toHaveProperty('region');
    expect(body.data).toHaveProperty('currency');
  });
  // archive#1557. The catalogue used to be fetched from
  // `process.env.AWS_REGION || 'us-east-1'` with no reference to the stored
  // setting, so Settings could display eu-west-1 while the model list a user
  // picked from came out of us-east-1.
  test('GET / fetches the catalogue from the stored region, not from AWS_REGION', async () => {
    const previous = process.env.AWS_REGION;
    process.env.AWS_REGION = 'us-east-2';
    try {
      const app = await buildApp();
      await json(await app.request('/'));
      expect(bedrockClientCtor).toHaveBeenCalledWith(
        expect.objectContaining({ region: 'eu-west-1' }),
      );
    } finally {
      if (previous === undefined) delete process.env.AWS_REGION;
      else process.env.AWS_REGION = previous;
    }
  });

  test('GET / falls back to AWS_REGION only when nothing is stored', async () => {
    const previous = process.env.AWS_REGION;
    process.env.AWS_REGION = 'us-east-2';
    try {
      const app = await buildApp({
        defaultModel: 'claude-3',
        invokeModel: 'nova',
        structureModel: 'nova-micro',
      });
      await json(await app.request('/'));
      expect(bedrockClientCtor).toHaveBeenCalledWith(
        expect.objectContaining({ region: 'us-east-2' }),
      );
    } finally {
      if (previous === undefined) delete process.env.AWS_REGION;
      else process.env.AWS_REGION = previous;
    }
  });

  test('the catalogue cache does not serve another region’s models', async () => {
    // A region-blind cache would report the old region's catalogue for up to
    // an hour after a change — the same disagreement, time-delayed.
    let config: Record<string, unknown> = { ...appConfig };
    const { createModelsRoutes } = await import('../models.js');
    const app = createModelsRoutes({ getAppConfig: () => config as never });

    await json(await app.request('/'));
    expect(bedrockClientCtor).toHaveBeenLastCalledWith(
      expect.objectContaining({ region: 'eu-west-1' }),
    );

    config = { ...appConfig, region: 'ap-south-1' };
    await json(await app.request('/'));
    expect(bedrockClientCtor).toHaveBeenLastCalledWith(
      expect.objectContaining({ region: 'ap-south-1' }),
    );
  });
});

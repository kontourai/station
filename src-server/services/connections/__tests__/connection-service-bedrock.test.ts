/**
 * #3654 — a Bedrock connection records check receipts like every other model
 * provider.
 *
 * It recorded none: the catalogue catch discarded the AWS error, so no
 * `reason`/`reasonKind` reached `recordModelCatalogDiscovery`, which drops any
 * observation missing either — and the connection read "Saved — not verified"
 * no matter what had actually been observed.
 *
 * These drive the REAL `BedrockLLMProvider` through the real
 * `createLLMProvider` factory and the real service; only the AWS SDK's own
 * answers are faked, at the client boundary.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';

const bedrockClient = vi.hoisted(() => ({ send: vi.fn(), destroy: vi.fn() }));

vi.mock('@aws-sdk/client-bedrock', () => ({
  BedrockClient: vi.fn().mockImplementation(function MockBedrockClient() {
    return bedrockClient;
  }),
  ListFoundationModelsCommand: vi.fn(function MockListFoundationModels(input) {
    return { kind: 'foundation-models', input };
  }),
  ListInferenceProfilesCommand: vi.fn(
    function MockListInferenceProfiles(input) {
      return { kind: 'inference-profiles', input };
    },
  ),
}));
// Resolvable on purpose: "a credential resolved on this device" is exactly
// what used to be recorded as a passed check, so these tests only
// discriminate against that derivation while resolution succeeds.
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

import type { ILLMProvider } from '../../../providers/llm/model-provider-types.js';
import { createConnectionServiceForTest } from './connection-service-test-helper.js';

function serviceFor(config: Record<string, unknown> = { region: 'us-east-1' }) {
  return serviceAndConnection(config).service;
}

function serviceAndConnection(
  config: Record<string, unknown> = { region: 'us-east-1' },
) {
  const connection = {
    id: 'bedrock-1',
    type: 'bedrock',
    name: 'Bedrock',
    enabled: true,
    capabilities: ['llm'],
    config,
  };
  const providerService = {
    listProviderConnections: () => [connection],
    saveProviderConnection: async () => undefined,
    deleteProviderConnection: async () => undefined,
    // `ProviderService.checkHealth` minus its metric.
    checkHealth: async (provider: ILLMProvider) =>
      (await provider.healthCheck?.()) ?? false,
  } as any;
  return {
    connection,
    service: createConnectionServiceForTest(
      providerService,
      () => [] as any,
      async () => [],
      () => ({ connections: [] }),
      async () => ({}) as any,
      async (updates: any) => updates,
    ),
  };
}

/** `ListFoundationModels` denied for this principal. */
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

function liveCatalog() {
  return (command: { kind: string }) => {
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
  };
}

describe('Bedrock check receipts', () => {
  beforeEach(() => {
    bedrockClient.send.mockReset();
  });

  test('a listing records a receipt for a denied catalogue instead of none', async () => {
    bedrockClient.send.mockRejectedValue(denied());
    const service = serviceFor();

    const [view] = await service.listModelConnections();

    // Not `not-checked` — which is what rendered "Saved — not verified" for
    // every Bedrock connection regardless of what had been observed.
    expect(view?.readinessEvidence?.check).toMatchObject({
      status: 'catalog-unavailable',
      source: 'catalog-discovery',
    });
    expect(view?.readinessEvidence?.check?.reason).not.toContain(
      '123456789012',
    );
  });

  test('an explicit test on a refused credential records a failed receipt and gates the connection', async () => {
    const error = new Error('The security token included is not valid.');
    error.name = 'UnrecognizedClientException';
    bedrockClient.send.mockRejectedValue(error);
    const service = serviceFor();

    const result = await service.testConnection('bedrock-1');

    expect(result.healthy).toBe(false);
    expect(result.reason).toContain('security token');
    const [view] = await service.listModelConnections();
    expect(view?.readinessEvidence?.check?.status).toBe('failed');
    expect(service.checkGatedModelConnectionIds()).toEqual(
      new Map([['bedrock-1', 'failed']]),
    );
  });

  test('a denied catalogue is not a refusal: the connection stays recommendable and is asked to chat', async () => {
    bedrockClient.send.mockRejectedValue(denied());
    const service = serviceFor();

    const result = await service.testConnection('bedrock-1');

    expect(result.healthy).toBe(false);
    // The explicit test went on to the chat route, which is the only evidence
    // a list-denied connection could ever produce — and said what it needs to
    // do so.
    expect(result.reason).toContain('Set a default model');
    // ...and it names the field that does it (review M1): every provider form
    // that can reach this instruction now has one.
    expect(result.reason).toContain('"Default model" field');
    const [view] = await service.listModelConnections();
    expect(view?.readinessEvidence?.check?.status).toBe('catalog-unavailable');
    expect(service.checkGatedModelConnectionIds().size).toBe(0);
  });

  test('a live catalogue passes and the receipt records it', async () => {
    bedrockClient.send.mockImplementation(liveCatalog());
    const service = serviceFor();

    const result = await service.testConnection('bedrock-1');

    expect(result.healthy).toBe(true);
    // The listing that follows re-runs discovery, whose live non-empty
    // catalogue is news of its own and records again — the receipt stays
    // `passed` either way, which is the claim this test makes.
    const [view] = await service.listModelConnections();
    expect(view?.readinessEvidence?.check?.status).toBe('passed');
  });

  test('credentials that merely resolve on this device cannot pass the check', async () => {
    // The short-circuit this change removes: `testConnection` passes on
    // `healthCheck`, and Bedrock's `healthCheck` answered "a credential
    // resolved here" — a passed receipt with no request having left the
    // machine, and one that made the classified outcome unreachable.
    bedrockClient.send.mockRejectedValue(denied());
    const service = serviceFor();

    const result = await service.testConnection('bedrock-1');

    expect(result.healthy).toBe(false);
  });
});

/**
 * #3654 review round 2 — the standing receipt for ONE connection, read rather
 * than probed.
 *
 * `GET /api/providers/:id/health` used to reach this through the whole model
 * listing, which runs catalogue discovery against every configured provider at
 * concurrency 4: one targeted read of a documented public endpoint amplified
 * into network traffic to all of them, at whatever rate an external client
 * polls.
 */
describe('getModelConnectionCheck', () => {
  beforeEach(() => {
    bedrockClient.send.mockReset();
  });

  test('returns the recorded check without asking the provider anything', async () => {
    bedrockClient.send.mockImplementation(liveCatalog());
    const service = serviceFor();
    await service.testConnection('bedrock-1');
    const callsAfterTheTest = bedrockClient.send.mock.calls.length;
    expect(callsAfterTheTest).toBeGreaterThan(0);

    const check = service.getModelConnectionCheck('bedrock-1');

    expect(check?.status).toBe('passed');
    expect(
      bedrockClient.send.mock.calls.length,
      'reading a receipt reached the provider',
    ).toBe(callsAfterTheTest);
  });

  test('retires the receipt when the configuration it observed changes', async () => {
    bedrockClient.send.mockImplementation(liveCatalog());
    const { service, connection } = serviceAndConnection();
    await service.testConnection('bedrock-1');
    expect(service.getModelConnectionCheck('bedrock-1')?.status).toBe('passed');

    connection.config = { ...connection.config, region: 'eu-west-1' };

    expect(
      service.getModelConnectionCheck('bedrock-1')?.status,
      'a pass for the previous settings vouched for the new ones',
    ).toBe('not-checked');
  });

  test('answers null for an id that is not a model connection', () => {
    expect(serviceFor().getModelConnectionCheck('nope')).toBeNull();
  });
});

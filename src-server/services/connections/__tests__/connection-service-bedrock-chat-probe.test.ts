/**
 * #3654 review, H3 — the reason a Bedrock CHAT probe records must not carry
 * the identity AWS echoes back.
 *
 * The catalogue path redacted where it produced its text, which left the other
 * path that quotes AWS verbatim uncovered: an `InvokeModel`
 * `AccessDeniedException` names the principal, the assumed-role session, the
 * account and the resource, and that string is stored in a check receipt and
 * rendered in a connection notice.
 *
 * This drives the real `BedrockLLMProvider` and the real service; only the AWS
 * client and the ai-sdk stream are faked, at their own boundaries.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';

const bedrockClient = vi.hoisted(() => ({ send: vi.fn(), destroy: vi.fn() }));
const streamTextMock = vi.hoisted(() => vi.fn());

vi.mock('ai', () => ({
  streamText: (...args: unknown[]) => streamTextMock(...args),
}));
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

/** What AWS says when a principal may not invoke a model, near-verbatim. */
const INVOKE_DENIED =
  'User: arn:aws:sts::123456789012:assumed-role/StationRole/session-name is not authorized to perform: bedrock:InvokeModelWithResponseStream on resource: arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-haiku-20240307-v1:0 because no identity-based policy allows the bedrock:InvokeModelWithResponseStream action';

/** `ListFoundationModels` denied — the classification that reaches the chat probe. */
function catalogDenied(): Error {
  const error = new Error(
    'User: arn:aws:iam::123456789012:user/station is not authorized to perform: bedrock:ListFoundationModels',
  );
  error.name = 'AccessDeniedException';
  (error as Error & { $metadata?: unknown }).$metadata = {
    httpStatusCode: 403,
  };
  return error;
}

/** An ai-sdk stream that enqueues an error part, the way a real refusal does. */
function erroringStream(message: string) {
  return {
    fullStream: (async function* () {
      yield { type: 'error', error: new Error(message) };
    })(),
    response: Promise.resolve({}),
    finishReason: Promise.resolve('error'),
  };
}

function serviceFor(config: Record<string, unknown>) {
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
    checkHealth: async (provider: ILLMProvider) =>
      (await provider.healthCheck?.()) ?? false,
  } as any;
  return createConnectionServiceForTest(
    providerService,
    () => [] as any,
    async () => [],
    () => ({ connections: [] }),
    async () => ({}) as any,
    async (updates: any) => updates,
  );
}

describe('Bedrock chat-probe reasons', () => {
  beforeEach(() => {
    bedrockClient.send.mockReset();
    streamTextMock.mockReset();
  });

  test('redacts the principal, account and resource AWS quotes back', async () => {
    bedrockClient.send.mockRejectedValue(catalogDenied());
    streamTextMock.mockReturnValue(erroringStream(INVOKE_DENIED));
    const service = serviceFor({
      region: 'us-east-1',
      defaultModel: 'anthropic.claude-3-haiku-20240307-v1:0',
    });

    const result = await service.testConnection('bedrock-1');

    expect(streamTextMock, 'the chat probe never ran').toHaveBeenCalled();
    expect(result.healthy).toBe(false);
    // The action is kept — it is the whole diagnostic value and identifies
    // nobody.
    expect(result.reason).toContain('bedrock:InvokeModelWithResponseStream');
    expect(result.reason).toContain('arn:[redacted]');
    expect(result.reason).not.toContain('123456789012');
    expect(result.reason).not.toContain('assumed-role/StationRole');
    expect(result.reason).not.toMatch(/arn:aws:/);

    // ...and the receipt the UI renders carries the redacted text, not the
    // original: this is stored evidence, not a one-off response body.
    const [view] = await service.listModelConnections();
    const reason = view?.readinessEvidence?.check?.reason ?? '';
    expect(reason).toContain('arn:[redacted]');
    expect(reason).not.toContain('123456789012');
    expect(reason).not.toMatch(/arn:aws:/);
  });

  test('a chat probe that succeeds still earns a pass for a list-denied identity', async () => {
    // The reason the denial is classified `no-catalog` at all: an IAM policy
    // may withhold the listing and allow invocation.
    bedrockClient.send.mockRejectedValue(catalogDenied());
    streamTextMock.mockReturnValue({
      fullStream: (async function* () {
        yield { type: 'text-delta', text: 'ok' };
      })(),
      response: Promise.resolve({}),
      finishReason: Promise.resolve('stop'),
    });
    const service = serviceFor({
      region: 'us-east-1',
      defaultModel: 'anthropic.claude-3-haiku-20240307-v1:0',
    });

    const result = await service.testConnection('bedrock-1');

    expect(result.healthy).toBe(true);
  });
});

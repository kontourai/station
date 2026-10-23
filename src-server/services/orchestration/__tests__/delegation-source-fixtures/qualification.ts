import { createHash } from 'node:crypto';
import {
  type BoundedApiFinalWire,
  type BoundedApiProvider,
  type BoundedApiProviderBinding,
  type BoundedApiQualificationRegistryOwner,
  boundedApiWireOptionsSha256,
  resolveBoundedApiProviderContract,
} from '../../../../runtime/conversation/bounded-api-provider-contract.js';

// Synthetic fixtures only: none of these names, tariffs, source hashes or
// approvals is provider evidence. The fake registry is test-local and not exported.
const NOW = 1000;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const rate = (n: string, d = '1') => ({ numerator: n, denominator: d });
const _remaining = {
  inputTokens: 1000,
  outputTokens: 1000,
  costMicros: 100000,
  currency: 'USD' as const,
};
type RecordValue = NonNullable<
  ReturnType<BoundedApiQualificationRegistryOwner['read']>
>;
export function fixture(provider: BoundedApiProvider = 'anthropic') {
  const body =
    provider === 'anthropic'
      ? {
          model: 'fixture-model',
          max_tokens: 10,
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
          inference_geo: 'global',
          service_tier: 'standard_only',
        }
      : {
          contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
          generationConfig: { maxOutputTokens: 10 },
          serviceTier: 'standard',
        };
  const wire: BoundedApiFinalWire = {
    url:
      provider === 'anthropic'
        ? 'https://api.anthropic.com/v1/messages'
        : 'https://generativelanguage.googleapis.com/v1beta/models/fixture-model:generateContent',
    method: 'POST',
    redirect: 'error',
    requestOrdinal: 1,
    headers:
      provider === 'anthropic'
        ? {
            'content-type': 'application/json',
            'x-api-key': 'synthetic-not-a-credential',
            'anthropic-version': '2023-06-01',
          }
        : {
            'content-type': 'application/json',
            'x-goog-api-key': 'synthetic-not-a-credential',
          },
    body: JSON.stringify(body),
  };
  const binding: BoundedApiProviderBinding = {
    provider,
    endpointUrl: wire.url,
    apiVersion: provider === 'anthropic' ? '2023-06-01' : 'v1beta',
    modelId: 'fixture-model',
    modelRevision: 'fixture-revision',
    connectionId: 'connection-1',
    connectionRevision: 'connection-r1',
    credentialRevision: 'key-r1',
    principalId: 'principal-1',
    tenantId: 'tenant-1',
    sourceId: 'source-1',
    sourceRevision: 'source-r1',
    optionsSha256: boundedApiWireOptionsSha256(provider, wire),
    sdkPackage:
      provider === 'anthropic' ? '@ai-sdk/anthropic' : '@ai-sdk/google',
    sdkVersion: 'fixture-version',
  };
  const evidence = {
    authorityKind: 'provider-public-contract' as const,
    authorityRef: 'synthetic-authority',
    revision: 'evidence-r1',
    sourceSha256s: [sha('synthetic-source')],
    validFromMs: 900,
    expiresAtMs: 1100,
  };
  const tariff = {
    currency: 'USD',
    scope: 'provider-inference-before-tax',
    geography: provider === 'anthropic' ? 'global' : 'developer-api',
    serviceTier: 'standard',
    speed: 'standard',
    cacheMode:
      provider === 'anthropic' ? 'anthropic-ephemeral' : 'google-implicit',
    bands: [
      {
        minInputTokens: 0,
        maxInputTokens: 100,
        rates: {
          input: rate('1', '3'),
          cacheRead: rate('1', '10'),
          cacheWrite5m: rate('1', '2'),
          cacheWrite1h: rate('2', '3'),
          output: rate('5', '2'),
        },
      },
    ],
    fixedFee: rate('1', '3'),
  };
  const raw = {
    schema: 'direct-text-single-request-v1',
    id: 'qualification-1',
    revision: 'contract-r1',
    binding,
    evidence,
    limits: {
      inputTokens: 100,
      outputTokens: 20,
      thinkingModes:
        provider === 'anthropic'
          ? ['adaptive', 'disabled', 'enabled', 'omitted']
          : ['budget', 'level', 'omitted'],
    },
    tariff,
  };
  let record: RecordValue | undefined;
  const publishFixture = (serialized = JSON.stringify(raw)) => {
    record = {
      serializedContract: serialized,
      contractSha256: sha(serialized),
      authorityKind: evidence.authorityKind,
      authorityRef: evidence.authorityRef,
      evidenceRevision: evidence.revision,
      sourceSha256s: [...evidence.sourceSha256s],
      validFromMs: evidence.validFromMs,
      expiresAtMs: evidence.expiresAtMs,
    };
  };
  publishFixture();
  const owner: BoundedApiQualificationRegistryOwner = {
    read: (id) => (id === raw.id ? record : undefined),
  };
  const resolve = (expected = binding, now = NOW) =>
    resolveBoundedApiProviderContract(raw.id, expected, owner, now);
  return {
    provider,
    wire,
    body,
    raw,
    binding,
    owner,
    resolve,
    publishFixture,
    revoke: () => {
      record = undefined;
    },
    replaceRecord: (change: (value: RecordValue) => RecordValue) => {
      record = change(record!);
    },
  };
}

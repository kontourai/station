import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'vitest';
import {
  type BoundedApiContractFailure,
  type BoundedApiFinalWire,
  type BoundedApiProvider,
  type BoundedApiProviderBinding,
  BoundedApiProviderContractError,
  type BoundedApiQualificationRegistryOwner,
  boundedApiWireOptionsSha256,
  priceBoundedApiProviderRawUsage,
  quoteBoundedApiProviderAttempt,
  resolveBoundedApiProviderContract,
} from '../bounded-api-provider-contract.js';

// Synthetic fixtures only: none of these names, tariffs, source hashes or
// approvals is provider evidence. The fake registry is test-local and not exported.
const NOW = 1000;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const rate = (n: string, d = '1') => ({ numerator: n, denominator: d });
const remaining = {
  inputTokens: 1000,
  outputTokens: 1000,
  costMicros: 100000,
  currency: 'USD' as const,
};
type RecordValue = NonNullable<
  ReturnType<BoundedApiQualificationRegistryOwner['read']>
>;
function fixture(provider: BoundedApiProvider = 'anthropic') {
  const body =
    provider === 'anthropic'
      ? {
          model: 'fixture-model',
          max_tokens: 10,
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
          inference_geo: 'global',
          service_tier: 'standard_only',
          thinking: { type: 'adaptive' },
        }
      : {
          contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
          generationConfig: { maxOutputTokens: 10, candidateCount: 1 },
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
function refused(action: () => unknown, code: BoundedApiContractFailure): void {
  assert.throws(
    action,
    (error: unknown) =>
      error instanceof BoundedApiProviderContractError && error.code === code,
  );
}
const quoteFixture = (f: ReturnType<typeof fixture>) =>
  quoteBoundedApiProviderAttempt(f.resolve(), f.wire, remaining, NOW);

test('reserves the FULL model input ceiling and inclusive final output, with exact cache-write and fractional fixed-fee ceiling', () => {
  const f = fixture();
  const quote = quoteFixture(f);
  // 100*(2/3) + 10*(5/2) + 1/3 = 92 exactly; tiny prompt does not reduce U.
  assert.equal(quote.inputUpperBoundTokens, 100);
  assert.equal(quote.outputUpperBoundTokens, 10);
  assert.equal(quote.costMicros, 92);
  assert.equal(quote.currency, 'USD');
  assert.equal(quote.contractSha256, sha(JSON.stringify(f.raw)));
  assert.equal(Object.isFrozen(quote), true);
  const contract = f.resolve();
  for (const capacity of [
    { ...remaining, inputTokens: 99 },
    { ...remaining, outputTokens: 9 },
    { ...remaining, costMicros: 91 },
  ])
    refused(
      () => quoteBoundedApiProviderAttempt(contract, f.wire, capacity, NOW),
      'insufficient_envelope',
    );
});

test('uses worst output tier and cache rate across EVERY reachable prompt band, without floating-point truncation', () => {
  const f = fixture('google');
  f.raw.tariff.bands[0]!.maxInputTokens = 49;
  f.raw.tariff.bands.push({
    minInputTokens: 50,
    maxInputTokens: 100,
    rates: {
      input: rate('1', '3'),
      cacheRead: rate('7', '3'),
      cacheWrite5m: rate('0'),
      cacheWrite1h: rate('0'),
      output: rate('13', '3'),
    },
  });
  f.publishFixture();
  // 100*(7/3) + 10*(13/3) + 1/3 = 277.
  assert.equal(quoteFixture(f).costMicros, 277);
  f.raw.tariff.bands[1]!.rates.cacheRead = rate(
    '70000000000000001',
    '30000000000000000',
  );
  f.publishFixture();
  // Same amount plus 1/300000000000000: must round UP to 278, not 277.
  assert.equal(quoteFixture(f).costMicros, 278);
});

test('client labels, hashes and changed bytes cannot replace server approval; operator attestation is not public qualification', () => {
  const f = fixture();
  refused(
    () =>
      resolveBoundedApiProviderContract(
        'qualification-1',
        f.binding,
        { read: () => undefined },
        NOW,
      ),
    'untrusted_contract',
  );
  f.replaceRecord((value) => ({
    ...value,
    serializedContract: value.serializedContract.replace(
      'contract-r1',
      'contract-r2',
    ),
  }));
  refused(() => f.resolve(), 'untrusted_contract');
  f.publishFixture();
  f.replaceRecord((value) => ({
    ...value,
    authorityKind: 'operator-attestation' as 'provider-public-contract',
  }));
  refused(() => f.resolve(), 'untrusted_contract');
  f.publishFixture();
  f.raw.evidence.sourceSha256s = [sha('substituted-source')];
  const text = JSON.stringify(f.raw);
  f.replaceRecord((value) => ({
    ...value,
    serializedContract: text,
    contractSha256: sha(text),
  }));
  refused(() => f.resolve(), 'untrusted_contract');
  refused(
    () =>
      quoteBoundedApiProviderAttempt(
        {
          id: 'qualification-1',
          revision: 'contract-r1',
          contractSha256: sha(text),
          evidenceDigest: sha('x'),
        },
        f.wire,
        remaining,
        NOW,
      ),
    'untrusted_contract',
  );
});

test('every execution binding must match, and approved record revocation/expiry is checked again at the quote boundary', () => {
  const f = fixture();
  for (const key of Object.keys(f.binding) as Array<
    keyof BoundedApiProviderBinding
  >) {
    refused(
      () => f.resolve({ ...f.binding, [key]: `${f.binding[key]}-changed` }),
      'binding_mismatch',
    );
  }
  refused(() => f.resolve(f.binding, 899), 'stale_contract');
  refused(() => f.resolve(f.binding, 1100), 'stale_contract');
  const contract = f.resolve();
  refused(
    () => quoteBoundedApiProviderAttempt(contract, f.wire, remaining, 1100),
    'stale_contract',
  );
  f.revoke();
  refused(
    () => quoteBoundedApiProviderAttempt(contract, f.wire, remaining, NOW),
    'untrusted_contract',
  );
});

test('unknown fields, partial/foreign tariffs, gaps/overlaps, duplicate keys and unsafe rational charges fail closed', () => {
  const changes = [
    (f: ReturnType<typeof fixture>) => {
      f.raw.binding = Object.assign({}, f.raw.binding, {
        billingContextId: 'unverified-invoice-label',
      });
    },
    (f: ReturnType<typeof fixture>) => {
      f.raw.tariff.currency = 'EUR';
    },
    (f: ReturnType<typeof fixture>) => {
      f.raw.tariff.bands[0]!.minInputTokens = 1;
    },
    (f: ReturnType<typeof fixture>) => {
      f.raw.tariff.bands[0]!.maxInputTokens = 99;
    },
    (f: ReturnType<typeof fixture>) => {
      f.raw.tariff.bands.push(structuredClone(f.raw.tariff.bands[0]!));
    },
    (f: ReturnType<typeof fixture>) => {
      delete (
        f.raw.tariff.bands[0]!.rates as Partial<
          (typeof f.raw.tariff.bands)[0]['rates']
        >
      ).cacheWrite1h;
    },
    (f: ReturnType<typeof fixture>) => {
      f.raw.tariff.bands[0]!.rates.input.denominator = '0';
    },
    (f: ReturnType<typeof fixture>) => {
      Object.assign(f.raw.limits, { hiddenExtraTokens: 0 });
    },
    (f: ReturnType<typeof fixture>) => {
      f.raw.limits.inputTokens = Number.MAX_SAFE_INTEGER + 1;
    },
    (f: ReturnType<typeof fixture>) => {
      f.raw.binding.endpointUrl =
        'https://api.anthropic.com.evil.test/v1/messages';
    },
  ];
  for (const change of changes) {
    const f = fixture();
    change(f);
    f.publishFixture();
    refused(() => f.resolve(), 'invalid_contract');
  }
  const duplicate = fixture();
  duplicate.publishFixture(
    JSON.stringify(duplicate.raw).replace(
      '"schema":',
      '"id":"other","schema":',
    ),
  );
  refused(() => duplicate.resolve(), 'invalid_contract');
  const unsafe = fixture();
  unsafe.raw.tariff.bands[0]!.rates.cacheWrite1h = rate('9007199254740991');
  unsafe.publishFixture();
  refused(() => quoteFixture(unsafe), 'invalid_contract');
});

test('refuses final-wire extras even if synthetic approval binds their options hash', () => {
  const variants: Array<
    [BoundedApiProvider, (body: Record<string, unknown>) => void]
  > = [
    [
      'anthropic',
      (body) => {
        body.tools = [];
      },
    ],
    [
      'anthropic',
      (body) => {
        body.fallbacks = 'default';
      },
    ],
    [
      'anthropic',
      (body) => {
        body.context_management = {};
      },
    ],
    [
      'anthropic',
      (body) => {
        body.inference_geo = 'us';
      },
    ],
    [
      'anthropic',
      (body) => {
        body.service_tier = 'auto';
      },
    ],
    [
      'anthropic',
      (body) => {
        body.speed = 'fast';
      },
    ],
    [
      'anthropic',
      (body) => {
        body.messages = [
          { role: 'user', content: [{ type: 'image', source: {} }] },
        ];
      },
    ],
    [
      'google',
      (body) => {
        body.continuationToken = 'synthetic-continuation';
      },
    ],
    [
      'google',
      (body) => {
        body.cachedContent = 'cachedContents/fixture';
      },
    ],
    [
      'google',
      (body) => {
        body.tools = [];
      },
    ],
    [
      'google',
      (body) => {
        body.generationConfig = { maxOutputTokens: 10, candidateCount: 2 };
      },
    ],
    [
      'google',
      (body) => {
        body.generationConfig = { maxOutputTokens: 10, responseSchema: {} };
      },
    ],
  ];
  for (const [provider, change] of variants) {
    const f = fixture(provider);
    const body = JSON.parse(f.wire.body) as Record<string, unknown>;
    change(body);
    f.wire.body = JSON.stringify(body);
    f.binding.optionsSha256 = boundedApiWireOptionsSha256(provider, f.wire);
    f.publishFixture();
    refused(() => quoteFixture(f), 'unsupported_wire');
  }
});

test('checks final SDK-expanded cap, request ordinal, redirect and semantic header identity; prompt growth never reduces U', () => {
  const f = fixture();
  const contract = f.resolve();
  for (const wire of [
    { ...f.wire, requestOrdinal: 2 },
    { ...f.wire, redirect: 'follow' as 'error' },
    { ...f.wire, method: 'GET' },
    { ...f.wire, url: f.wire.url + '?key=synthetic' },
    {
      ...f.wire,
      headers: { ...f.wire.headers, 'anthropic-beta': 'unqualified-feature' },
    },
    {
      ...f.wire,
      headers: { ...f.wire.headers, 'anthropic-version': '2099-01-01' },
    },
    { ...f.wire, headers: { ...f.wire.headers, 'X-API-KEY': 'duplicate' } },
  ])
    refused(
      () => quoteBoundedApiProviderAttempt(contract, wire, remaining, NOW),
      'unsupported_wire',
    );
  const body = JSON.parse(f.wire.body);
  body.max_tokens = 11;
  refused(
    () =>
      quoteBoundedApiProviderAttempt(
        contract,
        { ...f.wire, body: JSON.stringify(body) },
        remaining,
        NOW,
      ),
    'unsupported_wire',
  );
  body.max_tokens = 21;
  f.wire.body = JSON.stringify(body);
  f.binding.optionsSha256 = boundedApiWireOptionsSha256('anthropic', f.wire);
  f.publishFixture();
  refused(() => quoteFixture(f), 'unsupported_wire');
  body.max_tokens = 10;
  body.messages[0].content[0].text = 'changed prompt '.repeat(100);
  f.wire.body = JSON.stringify(body);
  f.binding.optionsSha256 = boundedApiWireOptionsSha256('anthropic', f.wire);
  f.publishFixture();
  assert.equal(quoteFixture(f).inputUpperBoundTokens, 100);
});

function anthropicResponse() {
  return {
    id: 'msg_fixture',
    type: 'message',
    role: 'assistant',
    container: null,
    content: [{ type: 'text', text: 'answer', citations: null }],
    model: 'fixture-model',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 5,
      cache_creation_input_tokens: 30,
      cache_read_input_tokens: 20,
      cache_creation: {
        ephemeral_5m_input_tokens: 10,
        ephemeral_1h_input_tokens: 20,
      },
      output_tokens: 8,
      output_tokens_details: { thinking_tokens: 6 },
      service_tier: 'standard',
      inference_geo: 'global',
      speed: 'standard',
    },
  };
}
function googleResponse() {
  return {
    modelVersion: 'fixture-revision',
    candidates: [
      {
        finishReason: 'STOP',
        index: 0,
        content: { role: 'model', parts: [{ text: 'answer' }] },
      },
    ],
    usageMetadata: {
      promptTokenCount: 60,
      cachedContentTokenCount: 30,
      candidatesTokenCount: 2,
      thoughtsTokenCount: 6,
      toolUsePromptTokenCount: 0,
      totalTokenCount: 68,
      serviceTier: 'standard',
    },
  };
}
test('prices COMPLETE raw component usage with inclusive thinking and TTL writes without double counting', () => {
  const a = fixture();
  const ac = a.resolve();
  const aq = quoteBoundedApiProviderAttempt(ac, a.wire, remaining, NOW);
  const resultA = priceBoundedApiProviderRawUsage(
    ac,
    aq,
    JSON.stringify(anthropicResponse()),
    NOW,
  );
  assert.equal(resultA.inputTokens, 55);
  assert.equal(resultA.outputTokens, 8); // 6 thinking is a subset, not 8+6.
  // 5/3 + 20/10 + 10/2 + 20*2/3 + 8*5/2 + 1/3 = 42 1/3 -> 43.
  assert.equal(resultA.costMicros, 43);
  const g = fixture('google');
  const gc = g.resolve();
  const gq = quoteBoundedApiProviderAttempt(gc, g.wire, remaining, NOW);
  const resultG = priceBoundedApiProviderRawUsage(
    gc,
    gq,
    JSON.stringify(googleResponse()),
    NOW,
  );
  assert.equal(resultG.inputTokens, 60); // cache already included in prompt.
  assert.equal(resultG.outputTokens, 8); // 2 response + 6 thoughts.
  // 30/3 + 30/10 + 8*5/2 + 1/3 = 33 1/3 -> 34.
  assert.equal(resultG.costMicros, 34);
});

test('missing raw counters, model/tier/geo drift, inconsistent totals and hidden usage remain UNKNOWN, never normalized zero', () => {
  for (const provider of ['anthropic', 'google'] as const) {
    const f = fixture(provider);
    const c = f.resolve();
    const q = quoteBoundedApiProviderAttempt(c, f.wire, remaining, NOW);
    const base =
      provider === 'anthropic' ? anthropicResponse() : googleResponse();
    const usageKey = provider === 'anthropic' ? 'usage' : 'usageMetadata';
    const raw = base as unknown as Record<string, unknown>;
    for (const key of provider === 'anthropic'
      ? [
          'input_tokens',
          'output_tokens',
          'cache_creation_input_tokens',
          'cache_read_input_tokens',
        ]
      : ['promptTokenCount', 'totalTokenCount']) {
      const altered = structuredClone(raw);
      delete (altered[usageKey] as Record<string, unknown>)[key];
      refused(
        () =>
          priceBoundedApiProviderRawUsage(c, q, JSON.stringify(altered), NOW),
        'usage_unknown',
      );
    }
    const altered = structuredClone(raw);
    altered[provider === 'anthropic' ? 'model' : 'modelVersion'] =
      'different-model';
    refused(
      () => priceBoundedApiProviderRawUsage(c, q, JSON.stringify(altered), NOW),
      'usage_unknown',
    );
    const unknownExtra = structuredClone(raw);
    Object.assign(unknownExtra[usageKey] as object, { hiddenFee: 1 });
    refused(
      () =>
        priceBoundedApiProviderRawUsage(
          c,
          q,
          JSON.stringify(unknownExtra),
          NOW,
        ),
      'usage_unknown',
    );
  }
  const f = fixture();
  const c = f.resolve();
  const q = quoteBoundedApiProviderAttempt(c, f.wire, remaining, NOW);
  for (const changes of [
    { service_tier: 'priority' },
    { inference_geo: 'us' },
    { speed: 'fast' },
    { output_tokens: 11 },
    { input_tokens: 101 },
    { cache_creation_input_tokens: 29 },
    { iterations: [] },
  ]) {
    const raw = anthropicResponse();
    Object.assign(raw.usage, changes);
    refused(
      () => priceBoundedApiProviderRawUsage(c, q, JSON.stringify(raw), NOW),
      'usage_unknown',
    );
  }
  const g = fixture('google');
  const gc = g.resolve();
  const gq = quoteBoundedApiProviderAttempt(gc, g.wire, remaining, NOW);
  for (const changes of [
    { totalTokenCount: 67 },
    { toolUsePromptTokenCount: 1 },
    { serviceTier: 'priority' },
    { cachedContentTokenCount: 61 },
  ]) {
    const raw = googleResponse();
    Object.assign(raw.usageMetadata, changes);
    refused(
      () => priceBoundedApiProviderRawUsage(gc, gq, JSON.stringify(raw), NOW),
      'usage_unknown',
    );
  }
  const raw = googleResponse();
  raw.candidates[0]!.finishReason = 'CONTINUATION';
  refused(
    () => priceBoundedApiProviderRawUsage(gc, gq, JSON.stringify(raw), NOW),
    'usage_unknown',
  );
  refused(
    () =>
      priceBoundedApiProviderRawUsage(
        gc,
        { ...gq },
        JSON.stringify(googleResponse()),
        NOW,
      ),
    'usage_unknown',
  );
  refused(
    () =>
      priceBoundedApiProviderRawUsage(
        gc,
        gq,
        JSON.stringify(googleResponse()),
        1100,
      ),
    'usage_unknown',
  );
});

test('schema-shaped Anthropic stable response uses pinned scope and zero aggregate writes despite absent speed and nullable breakdown', () => {
  const f = fixture();
  const c = f.resolve();
  const q = quoteBoundedApiProviderAttempt(c, f.wire, remaining, NOW);
  const raw = anthropicResponse();
  const usage: Record<string, unknown> = raw.usage;
  Object.assign(usage, {
    input_tokens: 5,
    output_tokens: 2,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation: null,
    output_tokens_details: null,
    server_tool_use: null,
    inference_geo: null,
    service_tier: null,
  });
  delete usage.speed;
  const result = priceBoundedApiProviderRawUsage(
    c,
    q,
    JSON.stringify(raw),
    NOW,
  );
  assert.equal(result.inputTokens, 5);
  assert.equal(result.outputTokens, 2);
  assert.equal(result.costMicros, 7); // 5/3 + 2*5/2 + 1/3 = 7.
  delete usage.cache_creation;
  delete usage.service_tier;
  delete usage.inference_geo;
  assert.equal(
    priceBoundedApiProviderRawUsage(c, q, JSON.stringify(raw), NOW).costMicros,
    7,
  );
  usage.cache_creation_input_tokens = 4; // Missing positive-write split uses maximum possible TTL tariff.
  assert.equal(
    priceBoundedApiProviderRawUsage(c, q, JSON.stringify(raw), NOW).costMicros,
    10,
  );
});

test('schema-shaped Google omitted components derive inclusive output from total identity and conservatively price unknown cache split', () => {
  const f = fixture('google');
  const c = f.resolve();
  const q = quoteBoundedApiProviderAttempt(c, f.wire, remaining, NOW);
  const raw = googleResponse();
  const usage: Record<string, unknown> = raw.usageMetadata;
  Object.assign(usage, {
    promptTokenCount: 5,
    candidatesTokenCount: 2,
    totalTokenCount: 7,
  });
  for (const key of [
    'cachedContentTokenCount',
    'thoughtsTokenCount',
    'toolUsePromptTokenCount',
    'serviceTier',
  ])
    delete usage[key];
  assert.equal(
    priceBoundedApiProviderRawUsage(c, q, JSON.stringify(raw), NOW).costMicros,
    7,
  );
  usage.totalTokenCount = 9; // Missing thinking is derived as 9 - 5 - 2 = 2, not assumed zero.
  assert.equal(
    priceBoundedApiProviderRawUsage(c, q, JSON.stringify(raw), NOW)
      .outputTokens,
    4,
  );
  usage.thoughtsTokenCount = 3; // Contradicts total identity.
  refused(
    () => priceBoundedApiProviderRawUsage(c, q, JSON.stringify(raw), NOW),
    'usage_unknown',
  );
  delete usage.thoughtsTokenCount;
  delete usage.candidatesTokenCount;
  assert.equal(
    priceBoundedApiProviderRawUsage(c, q, JSON.stringify(raw), NOW)
      .outputTokens,
    4,
  );
  // A cache-read tariff can exceed ordinary input: absence must use the greater rate.
  f.raw.tariff.bands[0]!.rates.cacheRead = rate('2');
  f.publishFixture();
  const c2 = f.resolve();
  const q2 = quoteBoundedApiProviderAttempt(c2, f.wire, remaining, NOW);
  assert.equal(
    priceBoundedApiProviderRawUsage(c2, q2, JSON.stringify(raw), NOW)
      .costMicros,
    21,
  );
});

{
  const googleChanges: Array<(raw: ReturnType<typeof googleResponse>) => void> =
    [
      (r) => {
        Object.assign(r.candidates[0]!, {
          continuationToken: 'unexpected-hop',
        });
      },
      (r) => {
        Object.assign(r.candidates[0]!, {
          groundingMetadata: { webSearchQueries: ['paid-search'] },
        });
      },
      (r) => {
        Object.assign(r.candidates[0]!, { groundingAttributions: [] });
      },
      (r) => {
        Object.assign(r.candidates[0]!, {
          urlContextMetadata: { urlMetadata: [] },
        });
      },
      (r) => {
        Object.assign(r.candidates[0]!, { billingSurprise: 1 });
      },
      (r) => {
        Object.assign(r.candidates[0]!.content, {
          parts: [{ functionCall: { name: 'unexpected', args: {} } }],
        });
      },
      (r) => {
        Object.assign(r.candidates[0]!.content, {
          parts: [
            {
              text: 'answer',
              executableCode: { language: 'PYTHON', code: 'pass' },
            },
          ],
        });
      },
      (r) => {
        Object.assign(r.candidates[0]!.content, { hidden: true });
      },
      (r) => {
        Object.assign(r.candidates[0]!, {
          safetyRatings: [
            {
              category: 'HARM_CATEGORY_HARASSMENT',
              probability: 'NEGLIGIBLE',
              paidExtra: 1,
            },
          ],
        });
      },
      (r) => {
        Object.assign(r, { promptFeedback: { safetyRatings: [], hidden: 1 } });
      },
      (r) => {
        Object.assign(r, { modelStatus: { modelStage: 'STABLE', hidden: 1 } });
      },
    ];
  const g = fixture('google');
  const gc = g.resolve();
  const gq = quoteBoundedApiProviderAttempt(gc, g.wire, remaining, NOW);
  for (const [index, change] of googleChanges.entries()) {
    test(`complete nested response scope rejects Google hidden response marker ${index + 1}`, () => {
      const raw = googleResponse();
      change(raw);
      refused(
        () => priceBoundedApiProviderRawUsage(gc, gq, JSON.stringify(raw), NOW),
        'usage_unknown',
      );
    });
  }
  const a = fixture();
  const ac = a.resolve();
  const aq = quoteBoundedApiProviderAttempt(ac, a.wire, remaining, NOW);
  for (const block of [
    { type: 'fallback', model: 'other' },
    { type: 'server_tool_use', id: 'hidden', name: 'web_search', input: {} },
    { type: 'tool_use', id: 'hidden', name: 'unexpected', input: {} },
    { type: 'text', text: 'answer', hidden: 1 },
    {
      type: 'text',
      text: 'answer',
      citations: [{ type: 'web_search_result_location' }],
    },
  ]) {
    test(`complete nested response scope rejects Anthropic unsupported ${JSON.stringify(block)}`, () => {
      const raw = anthropicResponse();
      Object.assign(raw, { content: [block] });
      refused(
        () => priceBoundedApiProviderRawUsage(ac, aq, JSON.stringify(raw), NOW),
        'usage_unknown',
      );
    });
  }
}

test('ordinary text/thinking/safety metadata remains supported while reported scope contradictions remain unknown', () => {
  const g = fixture('google');
  const gc = g.resolve();
  const gq = quoteBoundedApiProviderAttempt(gc, g.wire, remaining, NOW);
  const rawG = googleResponse();
  Object.assign(rawG.candidates[0]!.content, {
    parts: [
      { text: 'thinking', thought: true, thoughtSignature: 'opaque' },
      { text: 'answer' },
    ],
  });
  Object.assign(rawG.candidates[0]!, {
    safetyRatings: [
      {
        category: 'HARM_CATEGORY_HARASSMENT',
        probability: 'NEGLIGIBLE',
        blocked: false,
      },
    ],
  });
  Object.assign(rawG, {
    promptFeedback: { safetyRatings: [] },
    modelStatus: { modelStage: 'STABLE' },
  });
  assert.equal(
    priceBoundedApiProviderRawUsage(gc, gq, JSON.stringify(rawG), NOW)
      .outputTokens,
    8,
  );
  const a = fixture();
  const ac = a.resolve();
  const aq = quoteBoundedApiProviderAttempt(ac, a.wire, remaining, NOW);
  const rawA = anthropicResponse();
  Object.assign(rawA, {
    content: [
      { type: 'thinking', thinking: 'summary', signature: 'opaque' },
      { type: 'redacted_thinking', data: 'opaque' },
      { type: 'text', text: '' },
    ],
  });
  const tools = { web_search_requests: 0, web_fetch_requests: 0 };
  Object.assign(rawA.usage, { server_tool_use: tools });
  assert.equal(
    priceBoundedApiProviderRawUsage(ac, aq, JSON.stringify(rawA), NOW)
      .outputTokens,
    8,
  );
  tools.web_fetch_requests = 1;
  refused(
    () => priceBoundedApiProviderRawUsage(ac, aq, JSON.stringify(rawA), NOW),
    'usage_unknown',
  );
});

{
  const contradictions: Array<{
    name: string;
    candidate: number;
    components: Record<string, number | undefined>;
    modalityCount?: number;
  }> = [
    {
      name: 'zero candidate versus reported response total',
      candidate: 0,
      components: { candidatesTokenCount: 2, thoughtsTokenCount: undefined },
    },
    {
      name: 'candidate versus modality and explicit zero thoughts',
      candidate: 1,
      components: { candidatesTokenCount: undefined, thoughtsTokenCount: 0 },
      modalityCount: 2,
    },
    {
      name: 'candidate versus modality with absent aggregate and thoughts',
      candidate: 1,
      components: {
        candidatesTokenCount: undefined,
        thoughtsTokenCount: undefined,
      },
      modalityCount: 2,
    },
    {
      name: 'candidate versus inclusive output minus reported thoughts',
      candidate: 3,
      components: {
        candidatesTokenCount: undefined,
        thoughtsTokenCount: 2,
        totalTokenCount: 9,
      },
    },
    {
      name: 'candidate versus reported aggregate with unreported residual thoughts',
      candidate: 3,
      components: {
        candidatesTokenCount: 2,
        thoughtsTokenCount: undefined,
        totalTokenCount: 9,
      },
    },
    {
      name: 'candidate versus explicit zero modality count',
      candidate: 2,
      components: {
        candidatesTokenCount: undefined,
        thoughtsTokenCount: undefined,
      },
      modalityCount: 0,
    },
  ];
  for (const entry of contradictions) {
    test(`reported Google count contradiction remains unknown: ${entry.name}`, () => {
      const f = fixture('google');
      const c = f.resolve();
      const q = quoteBoundedApiProviderAttempt(c, f.wire, remaining, NOW);
      const raw = googleResponse();
      const usage: Record<string, unknown> = raw.usageMetadata;
      Object.assign(
        usage,
        {
          promptTokenCount: 5,
          cachedContentTokenCount: 0,
          candidatesTokenCount: 2,
          thoughtsTokenCount: 0,
          totalTokenCount: 7,
        },
        entry.components,
      );
      Object.assign(raw.candidates[0]!, { tokenCount: entry.candidate });
      if (entry.modalityCount !== undefined)
        usage.candidatesTokensDetails = [
          { modality: 'TEXT', tokenCount: entry.modalityCount },
        ];
      refused(
        () => priceBoundedApiProviderRawUsage(c, q, JSON.stringify(raw), NOW),
        'usage_unknown',
      );
    });
  }
}

test('Google candidate/modality counts may be matching or absent while complete total identity remains authoritative', () => {
  const f = fixture('google');
  const c = f.resolve();
  const q = quoteBoundedApiProviderAttempt(c, f.wire, remaining, NOW);
  for (const candidate of [undefined, null, 2]) {
    for (const includeAggregate of [true, false]) {
      const raw = googleResponse();
      const usage: Record<string, unknown> = raw.usageMetadata;
      Object.assign(usage, {
        promptTokenCount: 5,
        cachedContentTokenCount: 0,
        candidatesTokenCount: 2,
        thoughtsTokenCount: 0,
        totalTokenCount: 7,
      });
      if (!includeAggregate) {
        delete usage.candidatesTokenCount;
        delete usage.thoughtsTokenCount;
      }
      if (candidate !== undefined)
        Object.assign(raw.candidates[0]!, { tokenCount: candidate });
      usage.candidatesTokensDetails = [{ modality: 'TEXT', tokenCount: 2 }];
      assert.equal(
        priceBoundedApiProviderRawUsage(c, q, JSON.stringify(raw), NOW)
          .outputTokens,
        2,
      );
    }
  }
  const empty = googleResponse();
  Object.assign(empty.usageMetadata, {
    promptTokenCount: 5,
    cachedContentTokenCount: 0,
    candidatesTokenCount: 0,
    thoughtsTokenCount: 0,
    totalTokenCount: 5,
  });
  Object.assign(empty.candidates[0]!, {
    tokenCount: 0,
    content: { role: 'model', parts: [] },
  });
  assert.equal(
    priceBoundedApiProviderRawUsage(c, q, JSON.stringify(empty), NOW)
      .outputTokens,
    0,
  );
  const fallback = googleResponse();
  const usage: Record<string, unknown> = fallback.usageMetadata;
  delete usage.candidatesTokenCount;
  delete usage.thoughtsTokenCount;
  assert.equal(
    priceBoundedApiProviderRawUsage(c, q, JSON.stringify(fallback), NOW)
      .outputTokens,
    8,
  );
});

function thinkingFixture(
  provider: BoundedApiProvider,
  mode: 'disabled' | 'permitted' | 'omitted',
  googleZeroMeaning?: 'disables-thinking' | 'does-not-disable-thinking',
) {
  const f = fixture(provider);
  const body = JSON.parse(f.wire.body);
  if (provider === 'anthropic') {
    if (mode === 'omitted') delete body.thinking;
    else
      body.thinking = { type: mode === 'disabled' ? 'disabled' : 'adaptive' };
  } else {
    if (mode !== 'omitted')
      body.generationConfig.thinkingConfig = {
        thinkingBudget: mode === 'disabled' ? 0 : 10,
      };
    if (googleZeroMeaning !== undefined)
      Object.assign(f.raw.limits, { thinkingBudgetZero: googleZeroMeaning });
  }
  f.wire.body = JSON.stringify(body);
  f.binding.optionsSha256 = boundedApiWireOptionsSha256(provider, f.wire);
  f.publishFixture();
  return f;
}

for (const provider of ['anthropic', 'google'] as const) {
  test(`${provider} positive reported thinking contradicts the exact disabled-thinking quote`, () => {
    const f = thinkingFixture(
      provider,
      'disabled',
      provider === 'google' ? 'disables-thinking' : undefined,
    );
    const c = f.resolve();
    const q = quoteBoundedApiProviderAttempt(c, f.wire, remaining, NOW);
    const raw =
      provider === 'anthropic' ? anthropicResponse() : googleResponse();
    refused(
      () => priceBoundedApiProviderRawUsage(c, q, JSON.stringify(raw), NOW),
      'usage_unknown',
    );
    // Mutating the caller's wire object after quotation cannot change the
    // response invariant captured for the original physical attempt.
    const changed = JSON.parse(f.wire.body);
    if (provider === 'anthropic') changed.thinking = { type: 'adaptive' };
    else changed.generationConfig.thinkingConfig = { thinkingBudget: 10 };
    f.wire.body = JSON.stringify(changed);
    refused(
      () => priceBoundedApiProviderRawUsage(c, q, JSON.stringify(raw), NOW),
      'usage_unknown',
    );
  });

  test(`${provider} quoted permitted and omitted thinking preserves positive usage and disabled omission controls`, () => {
    for (const mode of ['permitted', 'omitted', 'disabled'] as const) {
      const f = thinkingFixture(
        provider,
        mode,
        provider === 'google' ? 'disables-thinking' : undefined,
      );
      const c = f.resolve();
      const q = quoteBoundedApiProviderAttempt(c, f.wire, remaining, NOW);
      const raw =
        provider === 'anthropic' ? anthropicResponse() : googleResponse();
      if (mode === 'disabled') {
        if ('usage' in raw) raw.usage.output_tokens_details.thinking_tokens = 0;
        else {
          raw.usageMetadata.thoughtsTokenCount = 0;
          raw.usageMetadata.candidatesTokenCount = 8;
        }
      }
      assert.equal(
        priceBoundedApiProviderRawUsage(c, q, JSON.stringify(raw), NOW)
          .outputTokens,
        8,
      );
      if ('usage' in raw)
        delete (raw.usage as Partial<typeof raw.usage>).output_tokens_details;
      else {
        delete (raw.usageMetadata as Partial<typeof raw.usageMetadata>)
          .thoughtsTokenCount;
        delete (raw.usageMetadata as Partial<typeof raw.usageMetadata>)
          .candidatesTokenCount;
      }
      assert.equal(
        priceBoundedApiProviderRawUsage(c, q, JSON.stringify(raw), NOW)
          .outputTokens,
        8,
      );
    }
  });
}

test('Google zero budget requires approved model semantics and never implies a universal thinking-off rule', () => {
  const unqualified = thinkingFixture('google', 'disabled');
  const c = unqualified.resolve();
  refused(
    () => quoteBoundedApiProviderAttempt(c, unqualified.wire, remaining, NOW),
    'unsupported_wire',
  );
  const mapsToThinking = thinkingFixture(
    'google',
    'disabled',
    'does-not-disable-thinking',
  );
  const c2 = mapsToThinking.resolve();
  const q2 = quoteBoundedApiProviderAttempt(
    c2,
    mapsToThinking.wire,
    remaining,
    NOW,
  );
  assert.equal(
    priceBoundedApiProviderRawUsage(
      c2,
      q2,
      JSON.stringify(googleResponse()),
      NOW,
    ).outputTokens,
    8,
  );
});

test('disabled-thinking quotes reject positive residual thoughts and explicit thought content without optional usage details', () => {
  const g = thinkingFixture('google', 'disabled', 'disables-thinking');
  const gc = g.resolve();
  const gq = quoteBoundedApiProviderAttempt(gc, g.wire, remaining, NOW);
  const rawG = googleResponse();
  delete (rawG.usageMetadata as Partial<typeof rawG.usageMetadata>)
    .thoughtsTokenCount;
  refused(
    () => priceBoundedApiProviderRawUsage(gc, gq, JSON.stringify(rawG), NOW),
    'usage_unknown',
  );
  delete (rawG.usageMetadata as Partial<typeof rawG.usageMetadata>)
    .candidatesTokenCount;
  Object.assign(rawG.candidates[0]!.content, {
    parts: [{ text: 'reasoning', thought: true }],
  });
  refused(
    () => priceBoundedApiProviderRawUsage(gc, gq, JSON.stringify(rawG), NOW),
    'usage_unknown',
  );
  const a = thinkingFixture('anthropic', 'disabled');
  const ac = a.resolve();
  const aq = quoteBoundedApiProviderAttempt(ac, a.wire, remaining, NOW);
  const rawA = anthropicResponse();
  delete (rawA.usage as Partial<typeof rawA.usage>).output_tokens_details;
  Object.assign(rawA, {
    content: [{ type: 'thinking', thinking: 'reasoning', signature: 'opaque' }],
  });
  refused(
    () => priceBoundedApiProviderRawUsage(ac, aq, JSON.stringify(rawA), NOW),
    'usage_unknown',
  );
});

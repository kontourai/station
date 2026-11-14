import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, test, vi } from 'vitest';
import { GoogleSealedPreparation } from '../../../runtime/conversation/google-sealed-preparation.js';
import {
  createSealedProviderPreparation,
  isSealedProviderPreparation,
} from '../../../runtime/conversation/sealed-provider-preparation.js';
import {
  createPreparedSdkSourceWireOwner,
  inspectSdkSourceWire,
  sdkDisposalPromise,
} from '../delegation-group-sdk-source-wire-owner.js';
import { publicFenceFixture } from './delegation-source-fixtures/fence.js';
import {
  fixture,
  sdkCredentialFixture,
  selection,
  subject,
} from './delegation-source-fixtures/source.js';

const NOW = Date.parse('2026-11-13T20:31:00Z');
const MODEL = 'gemini-2.5-flash-lite';
const remaining = {
  inputTokens: 1048576,
  outputTokens: 10,
  costMicros: 104862,
  currency: 'USD' as const,
};
afterEach(() => vi.restoreAllMocks());

async function prepare(
  observed = { starts: 0 },
  errorStatus?: 'UNAVAILABLE' | 'RESOURCE_EXHAUSTED',
) {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  const f = await fixture();
  const initial = await sdkCredentialFixture(f, 'google');
  await f.loader.saveAgent('worker', {
    name: 'Google report worker',
    prompt: 'Configured Google report instructions',
    execution: { modelConnectionId: 'connection-1', modelId: MODEL },
  });
  const selected = await initial.owner.captureAgentSdkCredential(
    f.req,
    'worker',
  );
  const preparation = await GoogleSealedPreparation.create();
  const configuration = {
    provider: 'google' as const,
    ...(errorStatus ? { outputDelivery: 'streamed' as const } : {}),
    modelId: selected.modelId,
    credential: selected.credential,
    preparation,
    brief: 'inspect exactly this source',
    instructions: selected.instructions,
    maxOutputTokens: 10,
    remaining,
    now: Date.now,
    signal: new AbortController().signal,
    rawFetch: async () => {
      observed.starts++;
      if (errorStatus)
        return new Response(
          `data: ${JSON.stringify({ error: { code: null, message: 'Controlled stream failure', status: errorStatus } })}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        );
      return new Response(
        JSON.stringify({
          modelVersion: MODEL,
          candidates: [
            {
              index: 0,
              finishReason: 'STOP',
              content: { role: 'model', parts: [{ text: 'OK' }] },
            },
          ],
          usageMetadata: {
            promptTokenCount: 100,
            candidatesTokenCount: 2,
            thoughtsTokenCount: 0,
            totalTokenCount: 102,
            cachedContentTokenCount: 0,
            serviceTier: 'standard',
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    },
  };
  const owner = createPreparedSdkSourceWireOwner(configuration);
  const sealed = await f.owner.captureSnapshot(f.context(), subject, selection);
  const prepared = await f.owner.prepareSdkSnapshot(
    f.context(),
    subject,
    sealed.capability,
    owner,
  );
  return {
    f,
    selected,
    preparation,
    configuration,
    owner,
    sealed,
    prepared,
    observed,
  };
}

async function driverFor(
  p: Awaited<ReturnType<typeof prepare>>,
  captured = inspectSdkSourceWire(p.owner, p.prepared.sdkHandle),
) {
  return publicFenceFixture(
    p.f,
    p.prepared.source,
    p.owner,
    p.prepared.sdkHandle,
    captured.wire,
    () => {},
    {
      protocol: 'rounds',
      provider: 'google',
      modelId: MODEL,
      allocation: {
        inputTokens: remaining.inputTokens,
        outputTokens: remaining.outputTokens,
        costMicros: remaining.costMicros,
      },
      contract: captured.contract,
      now: Date.now,
    },
  );
}

test('Google issuer binds real source and credentials to budget-zero final wire and retained round accounting', async () => {
  const p = await prepare();
  const captured = inspectSdkSourceWire(p.owner, p.prepared.sdkHandle);
  const body = JSON.parse(captured.wire.body);
  assert.deepEqual(body.generationConfig, {
    maxOutputTokens: 10,
    thinkingConfig: { thinkingBudget: 0 },
  });
  assert.equal(body.serviceTier, 'standard');
  assert.ok(
    !new Headers(Object.fromEntries(captured.wire.headers)).has(
      'anthropic-version',
    ),
  );
  const record = p.preparation.read(captured.contract.id);
  assert.ok(record);
  const facts = JSON.parse(record.serializedContract);
  assert.equal(facts.binding.provider, 'google');
  assert.equal(facts.binding.modelRevision, MODEL);
  assert.equal(
    facts.binding.sourceRevision,
    p.prepared.source.source_admission_receipt.digest,
  );
  assert.equal(captured.quote.costMicros, remaining.costMicros);
  const serialized = record.serializedContract;
  Reflect.set(record, 'serializedContract', '{}');
  assert.equal(
    p.preparation.read(captured.contract.id)?.serializedContract,
    serialized,
  );
  assert.equal(isSealedProviderPreparation({}), false);
  const unissued = Reflect.construct(GoogleSealedPreparation, [[]]);
  assert.equal(isSealedProviderPreparation(unissued), false);
  assert.throws(
    () =>
      createPreparedSdkSourceWireOwner({
        ...p.configuration,
        preparation: unissued,
      }),
    { code: 'sdk_configuration_unsupported' },
  );
  assert.throws(() => p.preparation.assertSelection('anthropic', MODEL));
  const driver = await driverFor(p, captured);
  await driver.run();
  assert.equal(p.observed.starts, 1, String(driver.invocationFailure));
  assert.equal(driver.relayCalls, 0);
  assert.deepEqual((await driver.ledger()).invocations[0].usage, {
    inputTokens: 100,
    outputTokens: 2,
    costMicros: 11,
  });
  await sdkDisposalPromise(p.owner, p.prepared.sdkHandle);
  const installed = JSON.parse(
    readFileSync(
      new URL(import.meta.resolve('@ai-sdk/google/package.json')),
      'utf8',
    ),
  );
  assert.equal(facts.binding.sdkVersion, installed.version);
});

test('Google profile freshness is fixed to retained public snapshots and cannot renew at startup', async () => {
  const p = await prepare();
  vi.mocked(Date.now).mockReturnValue(Date.parse('2026-11-13T20:30:00Z') - 1);
  await assert.rejects(() => createSealedProviderPreparation('google'), {
    code: 'stale_contract',
  });
  vi.mocked(Date.now).mockReturnValue(
    Date.parse('2026-11-14T08:18:00.046Z') - 1,
  );
  p.preparation.assertCurrent();
  vi.mocked(Date.now).mockReturnValue(Date.parse('2026-11-14T08:18:00.046Z'));
  assert.throws(() => p.preparation.assertCurrent(), {
    code: 'stale_contract',
  });
  await assert.rejects(() => createSealedProviderPreparation('google'), {
    code: 'stale_contract',
  });
  vi.mocked(Date.now).mockReturnValue(NOW);
  p.f.owner.releaseSnapshot(p.sealed.capability);
  await sdkDisposalPromise(p.owner, p.prepared.sdkHandle);
  assert.equal(p.observed.starts, 0);
});

test.each(['thinking', 'tools', 'source', 'tier'] as const)(
  'Google source preparation refuses unqualified %s before provider entry',
  async (defect) => {
    const qualify = GoogleSealedPreparation.prototype.qualifySourceWire;
    let refused = false;
    vi.spyOn(
      GoogleSealedPreparation.prototype,
      'qualifySourceWire',
    ).mockImplementation(function (
      this: GoogleSealedPreparation,
      token,
      credential,
      wire,
    ) {
      const body = JSON.parse(wire.body);
      if (defect === 'thinking')
        body.generationConfig.thinkingConfig.thinkingBudget = -1;
      if (defect === 'tools') body.tools = [];
      if (defect === 'source')
        body.contents[0].parts[1].text = 'foreign source';
      if (defect === 'tier') body.serviceTier = 'priority';
      try {
        return qualify.call(this, token, credential, {
          ...wire,
          body: JSON.stringify(body),
        });
      } catch (error) {
        refused =
          !!error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'unsupported_wire';
        throw error;
      }
    });
    const observed = { starts: 0 };
    await assert.rejects(() => prepare(observed), {
      code: 'sdk_prepare_failed',
    });
    assert.equal(refused, true);
    assert.equal(observed.starts, 0);
  },
);

test.each(['UNAVAILABLE', 'RESOURCE_EXHAUSTED'] as const)(
  'Google retryable streamed %s error retains unknown usage without another physical request',
  async (status) => {
    const p = await prepare({ starts: 0 }, status);
    try {
      const driver = await driverFor(p);
      await driver.run();
      assert.ok(driver.invocationFailure);
      assert.equal(p.observed.starts, 1);
      assert.equal(driver.relayCalls, 0);
      const ledger = await driver.ledger();
      assert.equal(ledger.invocations.length, 1);
      assert.equal(ledger.invocations[0].usage, null);
      assert.deepEqual(ledger.invocations[0].allocation, {
        inputTokens: remaining.inputTokens,
        outputTokens: remaining.outputTokens,
        costMicros: remaining.costMicros,
      });
    } finally {
      await sdkDisposalPromise(p.owner, p.prepared.sdkHandle);
      p.f.owner.releaseSnapshot(p.sealed.capability);
    }
  },
);

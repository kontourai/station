import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, test, vi } from 'vitest';
import { AnthropicSealedPreparation } from '../../../runtime/conversation/anthropic-sealed-preparation.js';
import { boundedApiWireOptionsSha256 } from '../../../runtime/conversation/bounded-api-provider-contract.js';
import { readObservedSdkProviderCredential } from '../../../runtime/conversation/provider-credential-observation.js';
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
afterEach(() => vi.restoreAllMocks());
const remaining = {
  inputTokens: 1048576,
  outputTokens: 10,
  costMicros: 3145878,
  currency: 'USD' as const,
};

async function prepare(observed = { starts: 0 }, inputTool?: true) {
  vi.spyOn(Date, 'now').mockReturnValue(inputTool ? NOW + 1000 : NOW);
  const f = await fixture();
  const credentials = await sdkCredentialFixture(f, 'anthropic');
  const preparation = await AnthropicSealedPreparation.create();
  const abort = new AbortController();
  let body = '';
  const configuration = {
    ...(inputTool ? { inputTool, outputDelivery: 'streamed' as const } : {}),
    provider: 'anthropic' as const,
    modelId: credentials.selection.modelId,
    credential: credentials.credential,
    preparation,
    brief: 'inspect exactly this source',
    instructions: credentials.selection.instructions,
    maxOutputTokens: 10,
    remaining,
    now: Date.now,
    signal: abort.signal,
    rawFetch: async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      observed.starts++;
      body = String(init?.body);
      return new Response(
        JSON.stringify({
          id: 'msg-controlled',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: 'OK' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: {
            input_tokens: 4,
            output_tokens: 2,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
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
    credentials,
    preparation,
    configuration,
    owner,
    sealed,
    prepared,
    abort,
    get starts() {
      return observed.starts;
    },
    get sentBody() {
      return body;
    },
  };
}

test('real preparation derives public profile from actual request/source/credential and settles the reserved Station turn', async () => {
  const p = await prepare();
  const captured = inspectSdkSourceWire(p.owner, p.prepared.sdkHandle);
  const wire = {
    ...captured.wire,
    headers: Object.fromEntries(captured.wire.headers),
    redirect: 'error' as const,
    requestOrdinal: 1,
  };
  assert.equal(wire.headers['anthropic-version'], '2026-10-21');
  const record = p.preparation.read(captured.contract.id);
  assert.ok(record);
  const facts = JSON.parse(record.serializedContract);
  const serialized = record.serializedContract;
  Reflect.set(record, 'serializedContract', '{}');
  assert.equal(
    p.preparation.read(captured.contract.id)?.serializedContract,
    serialized,
  );
  assert.throws(
    () =>
      createPreparedSdkSourceWireOwner({
        ...p.configuration,
        preparation: JSON.parse('{}'),
      }),
    { code: 'sdk_configuration_unsupported' },
  );
  const unissued = Reflect.construct(AnthropicSealedPreparation, [[]]);
  assert.equal(AnthropicSealedPreparation.isOwner(unissued), false);
  assert.throws(
    () =>
      createPreparedSdkSourceWireOwner({
        ...p.configuration,
        preparation: unissued,
      }),
    { code: 'sdk_configuration_unsupported' },
  );
  const observed = readObservedSdkProviderCredential(
    p.credentials.credential,
    'anthropic',
    p.f.req,
  );
  assert.equal(facts.binding.connectionRevision, observed.connectionRevision);
  assert.equal(facts.binding.credentialRevision, observed.credentialRevision);
  assert.equal(
    facts.binding.sourceRevision,
    p.prepared.source.source_admission_receipt.digest,
  );
  assert.equal(
    facts.binding.optionsSha256,
    boundedApiWireOptionsSha256('anthropic', wire),
  );
  assert.equal(facts.binding.tenantId, `personal:${observed.hostContextId}`);
  assert.equal(facts.limits.inputTokens, 1048576);
  assert.equal(captured.quote.costMicros, remaining.costMicros);
  assert.equal(p.starts, 0);
  const driver = await publicFenceFixture(
    p.f,
    p.prepared.source,
    p.owner,
    p.prepared.sdkHandle,
    captured.wire,
    () => {},
    {
      protocol: 'rounds',
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-6',
      allocation: {
        inputTokens: remaining.inputTokens,
        outputTokens: remaining.outputTokens,
        costMicros: remaining.costMicros,
      },
      contract: captured.contract,
      now: Date.now,
    },
  );
  await driver.run();
  assert.equal(p.starts, 1, String(driver.invocationFailure));
  assert.equal(p.sentBody, captured.wire.body);
  assert.equal(driver.relayCalls, 0);
  assert.deepEqual((await driver.ledger()).invocations[0].usage, {
    inputTokens: 4,
    outputTokens: 2,
    costMicros: 42,
  });
  assert.equal(driver.observed[0].usage.costBasis, 'tariff-upper-bound');
  await sdkDisposalPromise(p.owner, p.prepared.sdkHandle);
  const installed = JSON.parse(
    readFileSync(
      new URL(import.meta.resolve('@ai-sdk/anthropic/package.json')),
      'utf8',
    ),
  );
  assert.equal(facts.binding.sdkVersion, installed.version);
});

test('snapshot-anchored profile expiry refuses without extending validity at startup', async () => {
  const p = await prepare();
  vi.mocked(Date.now).mockReturnValue(Date.parse('2026-11-13T20:30:00Z') - 1);
  assert.throws(() => p.preparation.assertCurrent(), {
    code: 'stale_contract',
  });
  await assert.rejects(() => AnthropicSealedPreparation.create(), {
    code: 'stale_contract',
  });
  vi.mocked(Date.now).mockReturnValue(Date.parse('2026-11-13T20:30:00Z'));
  p.preparation.assertCurrent();
  vi.mocked(Date.now).mockReturnValue(
    Date.parse('2026-11-14T08:12:15.083Z') - 1,
  );
  p.preparation.assertCurrent();
  vi.mocked(Date.now).mockReturnValue(Date.parse('2026-11-14T08:12:15.083Z'));
  assert.throws(() => p.preparation.assertCurrent(), {
    code: 'stale_contract',
  });
  await assert.rejects(() => AnthropicSealedPreparation.create(), {
    code: 'stale_contract',
  });
  vi.mocked(Date.now).mockReturnValue(NOW);
  assert.equal(p.starts, 0);
  p.f.owner.releaseSnapshot(p.sealed.capability);
  await sdkDisposalPromise(p.owner, p.prepared.sdkHandle);
});

test.each([
  { thinking: { type: 'disabled' } },
  { cache_control: { type: 'ephemeral' } },
  { tools: [] },
  { output_config: { effort: 'low' } },
])(
  'real source preparation refuses unqualified feature %j before HTTP',
  async (extra) => {
    const qualify = AnthropicSealedPreparation.prototype.qualifySourceWire;
    let refusedByIssuer = false;
    vi.spyOn(
      AnthropicSealedPreparation.prototype,
      'qualifySourceWire',
    ).mockImplementation(function (
      this: AnthropicSealedPreparation,
      token,
      credential,
      wire,
    ) {
      try {
        return qualify.call(this, token, credential, {
          ...wire,
          body: JSON.stringify({ ...JSON.parse(wire.body), ...extra }),
        });
      } catch (error) {
        refusedByIssuer = Boolean(
          error &&
            typeof error === 'object' &&
            'code' in error &&
            error.code === 'unsupported_wire',
        );
        throw error;
      }
    });
    const observed = { starts: 0 };
    await assert.rejects(() => prepare(observed), {
      code: 'sdk_prepare_failed',
    });
    assert.equal(refusedByIssuer, true);
    assert.equal(observed.starts, 0);
  },
);

test('production preparation cannot mix credential and source leases from different authenticated Requests', async () => {
  const p = await prepare();
  const other = p.f.request();
  assert.notEqual(other, p.f.req);
  const context = p.f.context(other);
  const otherSubject = { ...subject, workItemId: 'other-request' };
  const sealed = await p.f.owner.captureSnapshot(
    context,
    otherSubject,
    selection,
  );
  const owner = createPreparedSdkSourceWireOwner(p.configuration);
  await assert.rejects(
    () =>
      p.f.owner.prepareSdkSnapshot(
        context,
        otherSubject,
        sealed.capability,
        owner,
      ),
    { code: 'sdk_prepare_failed' },
  );
  assert.equal(p.starts, 0);
  p.f.owner.releaseSnapshot(p.sealed.capability);
  await sdkDisposalPromise(p.owner, p.prepared.sdkHandle);
});

test('shared issuer keeps fresh identical-source preparations independent of expired older leases', async () => {
  const p = await prepare();
  const first = inspectSdkSourceWire(p.owner, p.prepared.sdkHandle);
  vi.mocked(Date.now).mockReturnValue(NOW + 1000);
  const sealed = await p.f.owner.captureSnapshot(
    p.f.context(),
    subject,
    selection,
  );
  const owner = createPreparedSdkSourceWireOwner(p.configuration);
  const prepared = await p.f.owner.prepareSdkSnapshot(
    p.f.context(),
    subject,
    sealed.capability,
    owner,
  );
  const second = inspectSdkSourceWire(owner, prepared.sdkHandle);
  assert.equal(
    prepared.source.source_state_id,
    p.prepared.source.source_state_id,
  );
  assert.notEqual(second.contract.id, first.contract.id);
  p.f.owner.releaseSnapshot(p.sealed.capability);
  vi.mocked(Date.now).mockReturnValue(NOW + 300_000);
  assert.throws(() => p.preparation.read(first.contract.id));
  assert.ok(p.preparation.read(second.contract.id));
  assert.equal(p.starts, 0);
  p.f.owner.releaseSnapshot(sealed.capability);
  await sdkDisposalPromise(p.owner, p.prepared.sdkHandle);
  await sdkDisposalPromise(owner, prepared.sdkHandle);
});

test('input-tool issuance uses a distinct fixed-freshness profile with no new effect authority', async () => {
  const p = await prepare({ starts: 0 }, true);
  const captured = inspectSdkSourceWire(p.owner, p.prepared.sdkHandle);
  const record = p.preparation.read(captured.contract.id);
  assert.ok(record);
  const contract = JSON.parse(record.serializedContract);
  assert.equal(contract.schema, 'report-input-single-request-v1');
  assert.ok(
    !new Headers(Object.fromEntries(captured.wire.headers)).has(
      'anthropic-beta',
    ),
  );
  assert.equal(
    contract.evidence.validFromMs,
    Date.parse('2026-11-13T20:30:00Z'),
  );
  assert.equal(
    contract.evidence.expiresAtMs,
    Date.parse('2026-11-14T08:12:15.083Z'),
  );
  assert.ok(captured.contract.id.startsWith('anthropic-input:'));
  assert.equal(captured.quote.inputUpperBoundTokens, 1048576);
  assert.equal(captured.quote.costMicros, remaining.costMicros);
  assert.equal(
    JSON.parse(captured.wire.body).tools[0].name,
    'station_request_input',
  );
  assert.equal(p.starts, 0);
  p.f.owner.releaseSnapshot(p.sealed.capability);
  await sdkDisposalPromise(p.owner, p.prepared.sdkHandle);
});

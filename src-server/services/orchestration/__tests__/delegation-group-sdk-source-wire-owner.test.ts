import assert from 'node:assert/strict';
import { readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RESERVED_SOURCE_EXECUTION_METADATA_KEY } from '@kontourai/station-contracts/provider';
import { test } from 'vitest';
import {
  createPreparedSdkSourceWireOwner,
  deliverSdkResponse,
  disposeSdkSourceWire,
  enterFinalFetch,
  inspectSdkSourceWire,
  SdkSourceRefusal,
  sdkDisposalPromise,
  sdkResultPromise,
  takeResponsePromise,
} from '../delegation-group-sdk-source-wire-owner.js';
import { fixture as qualification } from './delegation-source-fixtures/qualification.js';
import {
  code,
  fixture,
  selection,
  subject,
} from './delegation-source-fixtures/source.js';

const fixtureSdkCredential = () => 'synthetic-not-a-credential';
const sdkCode = (code: string) => (e: unknown) =>
  e instanceof SdkSourceRefusal && e.code === code;
function mockResponse(provider: 'anthropic' | 'google') {
  return new Response(
    JSON.stringify(
      provider === 'anthropic'
        ? {
            id: 'msg-fixture',
            type: 'message',
            role: 'assistant',
            model: 'fixture-model',
            content: [{ type: 'text', text: 'OK' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: {
              input_tokens: 4,
              output_tokens: 2,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          }
        : {
            modelVersion: 'fixture-revision',
            candidates: [
              {
                finishReason: 'STOP',
                index: 0,
                content: { role: 'model', parts: [{ text: 'OK' }] },
              },
            ],
            usageMetadata: {
              promptTokenCount: 4,
              candidatesTokenCount: 2,
              totalTokenCount: 6,
            },
          },
    ),
    { headers: { 'content-type': 'application/json' } },
  );
}
async function sdkFixture(
  provider: 'anthropic' | 'google' = 'anthropic',
  path = '/api/orchestration/chat',
  response: () => Response | Promise<Response> = () => mockResponse(provider),
) {
  const f = await fixture();
  const request = f.request(path);
  f.req = request;
  f.context = () => ({
    env: undefined,
    req: {
      raw: request,
      header: (name: string) => request.headers.get(name) ?? undefined,
    },
  });
  const q = qualification(provider);
  let starts = 0;
  let sentBody = '';
  const abort = new AbortController();
  const configuration = {
    provider,
    modelId: 'fixture-model',
    apiKey: fixtureSdkCredential(),
    brief: 'inspect exactly this source',
    instructions: 'report only',
    maxOutputTokens: 10,
    contract: q.resolve(),
    remaining: {
      inputTokens: 1000,
      outputTokens: 1000,
      costMicros: 100000,
      currency: 'USD' as const,
    },
    now: () => 1000,
    signal: abort.signal,
    rawFetch: (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      starts++;
      sentBody = String(init?.body);
      return Promise.resolve(response());
    },
  };
  const owner = createPreparedSdkSourceWireOwner(configuration);
  const sealed = await f.owner.captureSnapshot(f.context(), subject, selection);
  return {
    ...f,
    q,
    sdkOwner: owner,
    configuration,
    sealed,
    abort,
    get starts() {
      return starts;
    },
    get sentBody() {
      return sentBody;
    },
  };
}
for (const provider of ['anthropic', 'google'] as const)
  test(`SDK ${provider} captures before response, embeds exact bytes, consumes once and resolves actual SDK`, async () => {
    const f = await sdkFixture(provider);
    const prepared = await Promise.race([
      f.owner.prepareSdkSnapshot(
        f.context(),
        subject,
        f.sealed.capability,
        f.sdkOwner,
      ),
      new Promise<never>((_, no) => {
        const timer = setTimeout(() => no(Error('prepare deadlocked')), 5000);
        timer.unref();
      }),
    ]);
    assert.equal(f.starts, 0);
    const { wire } = inspectSdkSourceWire(f.sdkOwner, prepared.sdkHandle);
    const body = JSON.parse(wire.body);
    const text =
      provider === 'anthropic'
        ? body.messages[0].content[1].text
        : body.contents[0].parts[1].text;
    const payload = JSON.parse(text);
    assert.equal(
      Buffer.from(payload.files[0].content, 'base64').toString(),
      'original source\n',
    );
    assert.ok(!Object.hasOwn(body, 'tools'));
    assert.ok(!Object.hasOwn(body, 'cwd'));
    assert.ok(!Object.hasOwn(body, 'filesystem'));
    const response = enterFinalFetch(f.sdkOwner, prepared.sdkHandle, wire.url, {
      method: 'POST',
      headers: Object.fromEntries(wire.headers),
      body: wire.body,
      redirect: 'error',
      signal: f.abort.signal,
    });
    assert.equal(f.starts, 1);
    assert.equal(f.sentBody, wire.body);
    assert.equal(takeResponsePromise(f.sdkOwner, prepared.sdkHandle), response);
    assert.throws(
      () => takeResponsePromise(f.sdkOwner, prepared.sdkHandle),
      sdkCode('sdk_response_unavailable'),
    );
    deliverSdkResponse(f.sdkOwner, prepared.sdkHandle, await response);
    assert.equal(
      (await sdkResultPromise(f.sdkOwner, prepared.sdkHandle)).text,
      'OK',
    );
    await sdkDisposalPromise(f.sdkOwner, prepared.sdkHandle);
    assert.throws(() =>
      enterFinalFetch(f.sdkOwner, prepared.sdkHandle, wire.url, {
        method: 'POST',
        headers: Object.fromEntries(wire.headers),
        body: wire.body,
        redirect: 'error',
      }),
    );
  });

import { publicFenceFixture } from './delegation-source-fixtures/fence.js';

for (const provider of ['anthropic', 'google'] as const)
  test(`public FinalFetchLaunchFence ${provider} starts exact SDK wire only after durable intent`, async () => {
    const f = await sdkFixture(provider);
    const prepared = await f.owner.prepareSdkSnapshot(
      f.context(),
      subject,
      f.sealed.capability,
      f.sdkOwner,
    );
    const { wire } = inspectSdkSourceWire(f.sdkOwner, prepared.sdkHandle);
    const driver = await publicFenceFixture(
      f,
      prepared.source,
      f.sdkOwner,
      prepared.sdkHandle,
      wire,
      () => assert.equal(f.starts, 0),
    );
    const result = await driver.run();
    assert.equal(f.starts, 1);
    assert.equal(driver.intentCount, 1);
    assert.equal(f.sentBody, wire.body);
    assert.equal(
      (await sdkResultPromise(f.sdkOwner, prepared.sdkHandle)).text,
      'OK',
    );
    assert.ok(result);
  });

import {
  bindRuntimeLocalOperator,
  isRuntimeRequestPrincipalCurrent,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../../../security/runtime-request-security.js';

test.each([
  'source-block',
  'body',
  'headers',
  'url',
  'tools',
  'cwd',
  'clone-handle',
  'clone-owner',
] as const)(
  'actual SDK final wire rejects changed source block, other bytes, tools, cwd and cloned capabilities before HTTP (%s)',
  async (variant) => {
    const f = await sdkFixture();
    const prepared = await f.owner.prepareSdkSnapshot(
      f.context(),
      subject,
      f.sealed.capability,
      f.sdkOwner,
    );
    const { wire } = inspectSdkSourceWire(f.sdkOwner, prepared.sdkHandle);
    const body = JSON.parse(wire.body);
    let url = wire.url;
    let headers = Object.fromEntries(wire.headers);
    if (variant === 'source-block')
      body.messages[0].content[1].text = 'wrong exact source';
    if (variant === 'body') body.max_tokens = 9;
    if (variant === 'tools')
      body.tools = [{ name: 'shell', input_schema: { type: 'object' } }];
    if (variant === 'cwd') body.cwd = '/tmp';
    if (variant === 'headers') headers = { '...': 'wrong' };
    if (variant === 'url') url += '/wrong';
    const bytes = ['source-block', 'body', 'tools', 'cwd'].includes(variant)
      ? JSON.stringify(body)
      : wire.body;
    assert.throws(() =>
      enterFinalFetch(
        variant === 'clone-owner' ? {} : f.sdkOwner,
        variant === 'clone-handle' ? {} : prepared.sdkHandle,
        url,
        { method: 'POST', headers, body: bytes, redirect: 'error' },
      ),
    );
    assert.equal(f.starts, 0);
    disposeSdkSourceWire(f.sdkOwner, prepared.sdkHandle);
    await sdkDisposalPromise(f.sdkOwner, prepared.sdkHandle);
  },
);

test.each(['prepare', 'disclose', 'consume'] as const)(
  'actual source operation scope is rechecked at SDK prepare, disclose and final consume despite a current preview request (%s)',
  async (boundary) => {
    const f = await sdkFixture(
      'anthropic',
      '/api/projects/source/file-preview',
    );
    let prepared:
      | Awaited<ReturnType<typeof f.owner.prepareSdkSnapshot>>
      | undefined;
    if (boundary !== 'prepare')
      prepared = await f.owner.prepareSdkSnapshot(
        f.context(),
        subject,
        f.sealed.capability,
        f.sdkOwner,
      );
    const wire = prepared
      ? inspectSdkSourceWire(f.sdkOwner, prepared.sdkHandle).wire
      : undefined;
    f.environment.devicePairing.setDeviceScope(
      f.paired.device.id,
      ['orchestration:read'],
      { kind: 'local-grant' },
    );
    assert.equal(isRuntimeRequestPrincipalCurrent(f.req, f.environment), true);
    if (boundary === 'prepare')
      await assert.rejects(
        () =>
          f.owner.prepareSdkSnapshot(
            f.context(),
            subject,
            f.sealed.capability,
            f.sdkOwner,
          ),
        code('source_grant_action_not_authorized'),
      );
    else if (prepared && wire) {
      if (boundary === 'disclose')
        assert.throws(
          () => inspectSdkSourceWire(f.sdkOwner, prepared.sdkHandle),
          code('source_grant_action_not_authorized'),
        );
      else
        assert.throws(
          () =>
            enterFinalFetch(f.sdkOwner, prepared.sdkHandle, wire.url, {
              method: 'POST',
              headers: Object.fromEntries(wire.headers),
              body: wire.body,
              redirect: 'error',
            }),
          code('source_grant_action_not_authorized'),
        );
      disposeSdkSourceWire(f.sdkOwner, prepared.sdkHandle);
      await sdkDisposalPromise(f.sdkOwner, prepared.sdkHandle);
    }
    assert.equal(f.starts, 0);
  },
);

test.each([
  'foreign-principal',
  'revoked',
  'key-replaced',
  'qualification-revoked',
] as const)(
  'foreign valid principal cannot disclose another sealed source; revoked credentials cannot start SDK wire (%s)',
  async (variant) => {
    const f = await sdkFixture();
    if (variant === 'foreign-principal') {
      const offer = f.environment.devicePairing.createOffer({
        endpoint: 'http://127.0.0.1:43979',
      });
      const requested = f.environment.devicePairing.requestPairing({
        offerId: offer.offerId,
        proof: offer.challenge,
        deviceName: 'second valid credential',
        requesterPosition: 'unproven',
      });
      f.environment.devicePairing.confirmRequest(requested.requestId, {
        kind: 'presented-credential',
      });
      const paired = f.environment.devicePairing.exchange({
        offerId: offer.offerId,
        proof: offer.challenge,
        requestId: requested.requestId,
        locality: 'home-possession',
        mintKind: 'local-grant',
      });
      const req = new Request(f.req.url, { method: 'POST' });
      setRuntimeAuthenticatedRequestPrincipal(req, {
        kind: 'credential',
        authority: 'device-credential',
        credential: paired.credential,
        source: 'bearer',
        locality: 'home-possession',
        mintKind: 'local-grant',
      });
      bindRuntimeLocalOperator(req);
      assert.equal(isRuntimeRequestPrincipalCurrent(req, f.environment), true);
      await assert.rejects(
        () =>
          f.owner.prepareSdkSnapshot(
            {
              env: undefined,
              req: { raw: req, header: (n) => req.headers.get(n) ?? undefined },
            },
            subject,
            f.sealed.capability,
            f.sdkOwner,
          ),
        code('snapshot_binding_mismatch'),
      );
    } else {
      const prepared = await f.owner.prepareSdkSnapshot(
        f.context(),
        subject,
        f.sealed.capability,
        f.sdkOwner,
      );
      const { wire } = inspectSdkSourceWire(f.sdkOwner, prepared.sdkHandle);
      if (variant === 'revoked')
        f.environment.devicePairing.revokeDevice(
          f.paired.device.id,
          'operator-credential',
        );
      if (variant === 'qualification-revoked') f.q.revoke();
      if (variant === 'key-replaced') {
        const { writeFileSync } = await import('node:fs');
        const { randomBytes } = await import('node:crypto');
        const { join } = await import('node:path');
        writeFileSync(
          join(
            f.home,
            'security',
            `revision-evidence-${f.record.environmentId}.key`,
          ),
          randomBytes(32).toString('base64url'),
          { mode: 0o600 },
        );
      }
      assert.throws(() =>
        enterFinalFetch(f.sdkOwner, prepared.sdkHandle, wire.url, {
          method: 'POST',
          headers: Object.fromEntries(wire.headers),
          body: wire.body,
          redirect: 'error',
        }),
      );
      await sdkDisposalPromise(f.sdkOwner, prepared.sdkHandle);
    }
    assert.equal(f.starts, 0);
  },
);

test('SDK prepare release cannot resurrect capability; started disposal waits for SDK terminal response', async () => {
  const f = await sdkFixture();
  const pending = f.owner.prepareSdkSnapshot(
    f.context(),
    subject,
    f.sealed.capability,
    f.sdkOwner,
  );
  f.owner.releaseSnapshot(f.sealed.capability);
  f.owner.releaseSnapshot(f.sealed.capability);
  await assert.rejects(() => pending, code('snapshot_unavailable'));
  const g = await sdkFixture();
  const prepared = await g.owner.prepareSdkSnapshot(
    g.context(),
    subject,
    g.sealed.capability,
    g.sdkOwner,
  );
  const { wire } = inspectSdkSourceWire(g.sdkOwner, prepared.sdkHandle);
  let disposed = false;
  void sdkDisposalPromise(g.sdkOwner, prepared.sdkHandle).then(() => {
    disposed = true;
  });
  const response = enterFinalFetch(g.sdkOwner, prepared.sdkHandle, wire.url, {
    method: 'POST',
    headers: Object.fromEntries(wire.headers),
    body: wire.body,
    redirect: 'error',
  });
  disposeSdkSourceWire(g.sdkOwner, prepared.sdkHandle);
  g.owner.releaseSnapshot(g.sealed.capability);
  assert.equal(disposed, false);
  deliverSdkResponse(g.sdkOwner, prepared.sdkHandle, await response);
  assert.equal(
    (await sdkResultPromise(g.sdkOwner, prepared.sdkHandle)).text,
    'OK',
  );
  await sdkDisposalPromise(g.sdkOwner, prepared.sdkHandle);
  assert.equal(disposed, true);
});

test('public final fence revocation during intent wait prevents actual SDK HTTP and retains no replay path', async () => {
  const f = await sdkFixture('google');
  const prepared = await f.owner.prepareSdkSnapshot(
    f.context(),
    subject,
    f.sealed.capability,
    f.sdkOwner,
  );
  const { wire } = inspectSdkSourceWire(f.sdkOwner, prepared.sdkHandle);
  const driver = await publicFenceFixture(
    f,
    prepared.source,
    f.sdkOwner,
    prepared.sdkHandle,
    wire,
    () =>
      f.environment.devicePairing.revokeDevice(
        f.paired.device.id,
        'operator-credential',
      ),
  );
  await assert.rejects(() => driver.run());
  assert.equal(driver.intentCount, 1);
  assert.equal(f.starts, 0);
  disposeSdkSourceWire(f.sdkOwner, prepared.sdkHandle);
  await sdkDisposalPromise(f.sdkOwner, prepared.sdkHandle);
});

test('finished SDK result disclosure still requires the actual source action after preview scope narrows', async () => {
  const f = await sdkFixture('anthropic', '/api/projects/source/file-preview');
  const prepared = await f.owner.prepareSdkSnapshot(
    f.context(),
    subject,
    f.sealed.capability,
    f.sdkOwner,
  );
  const { wire } = inspectSdkSourceWire(f.sdkOwner, prepared.sdkHandle);
  const response = enterFinalFetch(f.sdkOwner, prepared.sdkHandle, wire.url, {
    method: 'POST',
    headers: Object.fromEntries(wire.headers),
    body: wire.body,
    redirect: 'error',
  });
  deliverSdkResponse(f.sdkOwner, prepared.sdkHandle, await response);
  assert.equal(
    (await sdkResultPromise(f.sdkOwner, prepared.sdkHandle)).text,
    'OK',
  );
  await sdkDisposalPromise(f.sdkOwner, prepared.sdkHandle);
  f.environment.devicePairing.setDeviceScope(
    f.paired.device.id,
    ['orchestration:read'],
    { kind: 'local-grant' },
  );
  assert.equal(isRuntimeRequestPrincipalCurrent(f.req, f.environment), true);
  assert.throws(
    () => sdkResultPromise(f.sdkOwner, prepared.sdkHandle),
    code('source_grant_action_not_authorized'),
  );
});

test.each(['tools', 'cwd', 'filesystem', 'validate'] as const)(
  'SDK configuration does not accept caller tools, filesystem, cwd or client validation callbacks (%s)',
  (key) => {
    const q = qualification();
    const options = {
      provider: 'anthropic' as const,
      modelId: 'fixture-model',
      apiKey: fixtureSdkCredential(),
      brief: 'brief',
      instructions: 'instructions',
      maxOutputTokens: 10,
      contract: q.resolve(),
      remaining: {
        inputTokens: 1000,
        outputTokens: 1000,
        costMicros: 100000,
        currency: 'USD' as const,
      },
      now: () => 1000,
      signal: new AbortController().signal,
      rawFetch: (() => {
        throw Error('must not fetch');
      }) satisfies typeof fetch,
      [key]: key === 'validate' ? () => true : ['shell'],
    };
    assert.throws(
      () => createPreparedSdkSourceWireOwner(options),
      sdkCode('sdk_configuration_unsupported'),
    );
  },
);

test('SDK brief and instructions are immutable before SDK serialization and checkout drift cannot rewrite source input', async () => {
  const f = await sdkFixture('google');
  f.configuration.brief = 'changed caller brief';
  f.configuration.instructions = 'changed caller instructions';
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  writeFileSync(join(f.repo, 'source.txt'), 'after seal');
  const prepared = await f.owner.prepareSdkSnapshot(
    f.context(),
    subject,
    f.sealed.capability,
    f.sdkOwner,
  );
  const { wire } = inspectSdkSourceWire(f.sdkOwner, prepared.sdkHandle);
  const body = JSON.parse(wire.body);
  assert.deepEqual(JSON.parse(body.contents[0].parts[0].text), {
    brief: 'inspect exactly this source',
    instructions: 'report only',
  });
  assert.equal(
    Buffer.from(
      JSON.parse(body.contents[0].parts[1].text).files[0].content,
      'base64',
    ).toString(),
    'original source\n',
  );
  disposeSdkSourceWire(f.sdkOwner, prepared.sdkHandle);
  await sdkDisposalPromise(f.sdkOwner, prepared.sdkHandle);
  assert.equal(f.starts, 0);
});

for (const [provider, protocol] of [
  ['anthropic', 'legacy'],
  ['google', 'legacy'],
  ['anthropic', 'rounds'],
  ['google', 'rounds'],
] as const)
  test(`reserved raw observer ${provider}/${protocol} settles retained tariff usage through published AccountingV1`, async () => {
    const f = await sdkFixture(provider);
    const prepared = await f.owner.prepareSdkSnapshot(
      f.context(),
      subject,
      f.sealed.capability,
      f.sdkOwner,
    );
    const { wire } = inspectSdkSourceWire(f.sdkOwner, prepared.sdkHandle);
    const driver = await publicFenceFixture(
      f,
      prepared.source,
      f.sdkOwner,
      prepared.sdkHandle,
      wire,
      () => assert.equal(f.starts, 0),
      {
        provider,
        protocol,
        contract: f.configuration.contract,
        now: () => 1000,
      },
    );
    await driver.run();
    assert.equal(f.starts, 1, String(driver.invocationFailure));
    assert.equal(driver.intentCount, 1);
    assert.equal(driver.relayCalls, 0);
    const canonical = driver.canonicalEvents();
    assert.ok(canonical.some((event) => event.method === 'session.started'));
    assert.ok(canonical.some((event) => event.method === 'turn.started'));
    const completed = canonical.find(
      (event) => event.method === 'turn.completed',
    );
    assert.ok(completed?.method === 'turn.completed');
    assert.equal(completed.outputText, 'OK');
    const delivery =
      completed.metadata?.[RESERVED_SOURCE_EXECUTION_METADATA_KEY];
    assert.ok(delivery && typeof delivery === 'object');
    assert.ok(
      'mode' in delivery &&
        'outputDelivery' in delivery &&
        'providerEvidence' in delivery,
    );
    assert.equal(delivery.mode, 'sealed-source-no-tools');
    assert.equal(delivery.outputDelivery, 'buffered');
    assert.deepEqual(delivery.providerEvidence, driver.retainedReference());
    assert.ok(
      !canonical.some(
        (event) =>
          event.method === 'tool.started' || event.method === 'request.opened',
      ),
    );
    assert.equal(f.sentBody, wire.body);
    assert.equal(driver.observed.length, 1);
    assert.equal(driver.observed[0].usage.inputTokens, 4);
    assert.equal(driver.observed[0].usage.outputTokens, 2);
    assert.equal(driver.observed[0].usage.costMicros, 7);
    assert.equal(driver.observed[0].usage.costBasis, 'tariff-upper-bound');
    assert.deepEqual(driver.retainedEvidence(), driver.observed[0]);
    const retained = driver.observed[0];
    assert.equal(
      retained.intent.invocationId,
      (await driver.ledger()).invocations[0].invocationId,
    );
    const firstReference = await driver.retainAgain(retained);
    assert.deepEqual(await driver.retainAgain(retained), firstReference);
    await assert.rejects(
      () =>
        driver.retainAgain({
          ...retained,
          rawResponseJson: '{}',
        }),
      { code: 'delegation_provider_evidence_conflict' },
    );
    assert.deepEqual(driver.retainedEvidence(), retained);
    const ledger = await driver.ledger();
    assert.deepEqual(ledger.invocations[0].usage, {
      inputTokens: 4,
      outputTokens: 2,
      costMicros: 7,
    });
    assert.equal(ledger.invocations[0].terminal, true);
    await assert.rejects(
      () => driver.sendWithoutReservation(),
      /reserved Station turn/,
    );
    await assert.rejects(
      () => driver.sendWithForgedReservation(),
      /Reserved Station turn is unavailable/,
    );
    await assert.rejects(
      () => driver.sendAfterAdapterRecoveryWithoutReservation(),
      /reserved Station turn/,
    );
    assert.equal(driver.relayCalls, 0);
    assert.equal(f.starts, 1);
    await assert.rejects(() => driver.reserveAnother(), {
      code: 'invocation_budget_exhausted',
    });
    const file = join(
      driver.evidenceDirectory,
      readdirSync(driver.evidenceDirectory).find((name) =>
        name.endsWith('.json'),
      )!,
    );
    const bytes = readFileSync(file);
    writeFileSync(file, '{}');
    await assert.rejects(() => driver.readReservedResult(), {
      code: 'delegation_provider_evidence_unavailable',
    });
    unlinkSync(file);
    await assert.rejects(() => driver.readReservedResult(), {
      code: 'delegation_provider_evidence_unavailable',
    });
    writeFileSync(file, bytes, { mode: 0o600 });
    assert.equal((await driver.readReservedResult()).sdkResult.text, 'OK');
    assert.equal(f.starts, 1);
    assert.deepEqual((await driver.ledger()).invocations[0].usage, {
      inputTokens: 4,
      outputTokens: 2,
      costMicros: 7,
    });
    await sdkDisposalPromise(f.sdkOwner, prepared.sdkHandle);
  });

test('failed durable provider evidence publication retains the unknown reservation', async () => {
  const f = await sdkFixture('anthropic');
  const prepared = await f.owner.prepareSdkSnapshot(
    f.context(),
    subject,
    f.sealed.capability,
    f.sdkOwner,
  );
  const { wire } = inspectSdkSourceWire(f.sdkOwner, prepared.sdkHandle);
  const driver = await publicFenceFixture(
    f,
    prepared.source,
    f.sdkOwner,
    prepared.sdkHandle,
    wire,
    () => {},
    {
      provider: 'anthropic',
      contract: f.configuration.contract,
      now: () => 1000,
    },
  );
  driver.blockEvidencePublication();
  await driver.run();
  assert.equal(f.starts, 1);
  assert.equal(driver.observed.length, 0);
  const ledger = await driver.ledger();
  assert.equal(ledger.invocations.length, 1);
  assert.equal(ledger.invocations[0].usage, null);
  assert.equal(ledger.invocations[0].terminal, false);
  await assert.rejects(() => driver.reserveAnother(), {
    code: 'active_slot_exhausted',
  });
  await sdkDisposalPromise(f.sdkOwner, prepared.sdkHandle);
});

test('reserved Google response with empty final counters refuses settlement and releases the completed SDK waiter', async () => {
  const f = await sdkFixture(
    'google',
    '/api/orchestration/chat',
    () =>
      new Response(
        JSON.stringify({
          modelVersion: 'fixture-revision',
          candidates: [
            {
              finishReason: 'STOP',
              index: 0,
              content: { role: 'model', parts: [{ text: 'OK' }] },
            },
          ],
          usageMetadata: {},
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
  );
  const prepared = await f.owner.prepareSdkSnapshot(
    f.context(),
    subject,
    f.sealed.capability,
    f.sdkOwner,
  );
  const { wire } = inspectSdkSourceWire(f.sdkOwner, prepared.sdkHandle);
  const result = sdkResultPromise(f.sdkOwner, prepared.sdkHandle);
  void result.catch(() => {});
  const driver = await publicFenceFixture(
    f,
    prepared.source,
    f.sdkOwner,
    prepared.sdkHandle,
    wire,
    () => {},
    { provider: 'google', contract: f.configuration.contract, now: () => 1000 },
  );
  await driver.run();
  assert.equal(f.starts, 1);
  assert.equal(driver.intentCount, 1);
  assert.equal(driver.observed.length, 0);
  await assert.rejects(result, sdkCode('sdk_attempt_failed'));
  await sdkDisposalPromise(f.sdkOwner, prepared.sdkHandle);
  const ledger = await driver.ledger();
  assert.equal(ledger.invocations.length, 1);
  assert.equal(ledger.invocations[0].usage, null);
  assert.equal(ledger.invocations[0].terminal, false);
  const next = await f.owner.captureSnapshot(f.context(), subject, selection);
  f.owner.releaseSnapshot(next.capability);
});

test('duplicate reserved source entry cannot terminate its original pending HTTP or SDK waiter', async () => {
  let finish!: (response: Response) => void;
  let entered!: () => void;
  const started = new Promise<void>((yes) => {
    entered = yes;
  });
  const pending = new Promise<Response>((yes) => {
    finish = yes;
  });
  const f = await sdkFixture('google', '/api/orchestration/chat', () => {
    entered();
    return pending;
  });
  const prepared = await f.owner.prepareSdkSnapshot(
    f.context(),
    subject,
    f.sealed.capability,
    f.sdkOwner,
  );
  const { wire } = inspectSdkSourceWire(f.sdkOwner, prepared.sdkHandle);
  const driver = await publicFenceFixture(
    f,
    prepared.source,
    f.sdkOwner,
    prepared.sdkHandle,
    wire,
    () => {},
    { provider: 'google', contract: f.configuration.contract, now: () => 1000 },
  );
  const original = driver.run().then(
    () => undefined,
    (error) => error,
  );
  await Promise.race([
    started,
    original.then(() => {
      throw Error(`HTTP was not entered: ${String(driver.invocationFailure)}`);
    }),
  ]);
  let disposed = false;
  void sdkDisposalPromise(f.sdkOwner, prepared.sdkHandle).then(() => {
    disposed = true;
  });
  await assert.rejects(() => driver.repeatAttempt(), /already claimed/);
  assert.equal(disposed, false);
  assert.equal(f.starts, 1);
  finish(mockResponse('google'));
  assert.equal(await original, undefined);
  assert.equal(driver.observed.length, 1);
  assert.equal(
    (await sdkResultPromise(f.sdkOwner, prepared.sdkHandle)).text,
    'OK',
  );
  await sdkDisposalPromise(f.sdkOwner, prepared.sdkHandle);
});

test('reserved Station interruption reports uncertain termination and keeps unknown accounting held', async () => {
  let finish!: (response: Response) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const response = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const f = await sdkFixture('google', '/api/orchestration/chat', () => {
    entered();
    return response;
  });
  const prepared = await f.owner.prepareSdkSnapshot(
    f.context(),
    subject,
    f.sealed.capability,
    f.sdkOwner,
  );
  const { wire } = inspectSdkSourceWire(f.sdkOwner, prepared.sdkHandle);
  const driver = await publicFenceFixture(
    f,
    prepared.source,
    f.sdkOwner,
    prepared.sdkHandle,
    wire,
    () => {},
    { provider: 'google', contract: f.configuration.contract, now: () => 1000 },
  );
  const running = driver.run();
  await Promise.race([
    started,
    running.then(() => {
      throw Error(`HTTP was not entered: ${String(driver.invocationFailure)}`);
    }),
  ]);
  const interruption = await driver.interrupt();
  assert.deepEqual(interruption.result, {
    outcome: 'termination-unconfirmed',
    threadId: 'reserved-sdk-session',
    turnId: driver
      .canonicalEvents()
      .find((event) => event.method === 'turn.started')?.turnId,
  });
  assert.equal(driver.observed.length, 0);
  assert.equal(driver.relayCalls, 0);
  assert.ok(
    !driver
      .canonicalEvents()
      .some((event) => event.method === 'turn.completed'),
  );
  finish(mockResponse('google'));
  await running;
  assert.equal(f.starts, 1);
  assert.equal(driver.observed.length, 0);
  const invocation = (await driver.ledger()).invocations[0];
  assert.equal(invocation.usage, null);
  assert.equal(invocation.terminal, false);
  await assert.rejects(() => driver.reserveAnother(), {
    code: 'active_slot_exhausted',
  });
  await sdkDisposalPromise(f.sdkOwner, prepared.sdkHandle);
});

import assert from 'node:assert/strict';
import {
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { startRun } from '@kontourai/flow';
import { RESERVED_SOURCE_EXECUTION_METADATA_KEY } from '@kontourai/station-contracts/provider';
import { onTestFinished, test, vi } from 'vitest';
import { StationAgentAdapter } from '../../../providers/adapters/station-agent-adapter.js';
import { reservedStationSessionRecipient } from '../../../runtime/conversation/reserved-station-turn.js';
import { RoundsFinalFetchLaunchFence } from '../delegation-group-launch-fence.js';
import {
  createContextSyncSdkSourceWireOwner,
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
import * as sourceAdmission from '../delegation-group-source-admission.js';
import { fixture as qualification } from './delegation-source-fixtures/qualification.js';
import { findReachableString } from './delegation-source-fixtures/reachable-values.js';
import {
  code,
  fixture,
  sdkCredentialFixture,
  selection,
  subject,
} from './delegation-source-fixtures/source.js';

const sdkCode = (code: string) => (e: unknown) =>
  e instanceof SdkSourceRefusal && e.code === code;
function mockResponse(provider: 'anthropic' | 'google', continued = false) {
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
                finishReason: continued ? 'CONTINUATION' : 'STOP',
                ...(continued
                  ? { continuationToken: 'controlled-continuation' }
                  : {}),
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
function requestContext(request: Request) {
  return () => ({
    env: undefined,
    req: {
      raw: request,
      header: (name: string) => request.headers.get(name) ?? undefined,
    },
  });
}
async function sdkFixture(
  provider: 'anthropic' | 'google' = 'anthropic',
  path = '/api/orchestration/chat',
  response: () => Response | Promise<Response> = () => mockResponse(provider),
  requestSignal?: AbortSignal,
) {
  const f = await fixture();
  const request = f.request(path, { signal: requestSignal });
  f.req = request;
  f.context = requestContext(request);
  const q = qualification(provider);
  const credentialOwner = await sdkCredentialFixture(f, provider);
  Object.assign(q.binding, {
    connectionId: credentialOwner.observed.connectionId,
    connectionRevision: credentialOwner.observed.connectionRevision,
    credentialRevision: credentialOwner.observed.credentialRevision,
  });
  q.publishFixture();
  let starts = 0;
  let sentBody = '';
  const abort = new AbortController();
  const configuration = {
    provider,
    modelId: 'fixture-model',
    credential: credentialOwner.credential,
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
    credentialOwner,
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

test('Google SDK automatic continuation cannot send another physical request from a consumed source', async () => {
  let responses = 0;
  const f = await sdkFixture('google', '/api/orchestration/chat', () =>
    mockResponse('google', ++responses === 1),
  );
  const prepared = await f.owner.prepareSdkSnapshot(
    f.context(),
    subject,
    f.sealed.capability,
    f.sdkOwner,
  );
  try {
    const { wire } = inspectSdkSourceWire(f.sdkOwner, prepared.sdkHandle);
    const response = enterFinalFetch(f.sdkOwner, prepared.sdkHandle, wire.url, {
      method: 'POST',
      headers: Object.fromEntries(wire.headers),
      body: wire.body,
      redirect: 'error',
    });
    deliverSdkResponse(f.sdkOwner, prepared.sdkHandle, await response);
    await assert.rejects(
      sdkResultPromise(f.sdkOwner, prepared.sdkHandle),
      sdkCode('sdk_attempt_failed'),
    );
    assert.equal(f.starts, 1);
    assert.equal(responses, 1);
  } finally {
    f.owner.releaseSnapshot(f.sealed.capability);
    disposeSdkSourceWire(f.sdkOwner, prepared.sdkHandle);
    await sdkDisposalPromise(f.sdkOwner, prepared.sdkHandle);
  }
});

test.each(['release', 'revoke'] as const)(
  'Flow admission survives consumed SDK bytes but still refuses explicit %s',
  async (control) => {
    const f = await sdkFixture();
    f.owner.releaseSnapshot(f.sealed.capability);
    const definitionPath = join(f.repo, 'source-flow.json');
    writeFileSync(
      definitionPath,
      JSON.stringify({
        id: 'source-lifetime',
        version: '1',
        execution: { mode: 'multi-cursor', claim_contract_version: '1' },
        steps: [{ id: 'report', next: null, mutable_resources: [] }],
        gates: {
          report: {
            step: 'report',
            expects: [
              {
                id: 'optional',
                kind: 'trust.bundle',
                required: false,
                description: 'No acceptance claim',
                bundle_claim: { claimType: 'fixture.optional' },
              },
            ],
          },
        },
      }),
    );
    writeFileSync(join(f.repo, '.gitignore'), '.kontourai/\n');
    await f.git('add', 'source-flow.json', '.gitignore');
    await f.git('commit', '-qm', 'controlled Flow source lifetime');
    const run = await startRun(definitionPath, {
      cwd: f.repo,
      runId: 'source-lifetime',
    });
    const sealed = await f.owner.captureSnapshot(
      f.context(),
      subject,
      selection,
    );
    const flow = await f.owner.prepareFlowSnapshot(
      f.context(),
      subject,
      sealed.capability,
      run.runId,
    );
    const prepared = await f.owner.prepareSdkSnapshot(
      f.context(),
      subject,
      sealed.capability,
      f.sdkOwner,
    );
    const { wire } = inspectSdkSourceWire(f.sdkOwner, prepared.sdkHandle);
    const encodedSource = Buffer.from('original source\n').toString('base64');
    try {
      if (control === 'release')
        assert.notEqual(
          await findReachableString(flow.assertCurrent, encodedSource),
          null,
        );
      const response = enterFinalFetch(
        f.sdkOwner,
        prepared.sdkHandle,
        wire.url,
        {
          method: 'POST',
          headers: Object.fromEntries(wire.headers),
          body: wire.body,
          redirect: 'error',
          signal: f.abort.signal,
        },
      );
      deliverSdkResponse(f.sdkOwner, prepared.sdkHandle, await response);
      assert.equal(
        (await sdkResultPromise(f.sdkOwner, prepared.sdkHandle)).text,
        'OK',
      );
      await sdkDisposalPromise(f.sdkOwner, prepared.sdkHandle);
      assert.equal(f.starts, 1);
      assert.doesNotThrow(() => flow.assertCurrent());
      assert.deepEqual((await flow.readSchedule()).readySteps, ['report']);
      if (control === 'release')
        assert.equal(
          await findReachableString(flow.assertCurrent, encodedSource),
          null,
        );
      assert.throws(() =>
        enterFinalFetch(f.sdkOwner, prepared.sdkHandle, wire.url, {
          method: 'POST',
          headers: Object.fromEntries(wire.headers),
          body: wire.body,
          redirect: 'error',
        }),
      );
      assert.equal(f.starts, 1);
      if (control === 'release') f.owner.releaseSnapshot(sealed.capability);
      else
        f.environment.devicePairing.revokeDevice(
          f.paired.device.id,
          'operator-credential',
        );
      assert.throws(() => flow.assertCurrent());
    } finally {
      f.owner.releaseSnapshot(sealed.capability);
      disposeSdkSourceWire(f.sdkOwner, prepared.sdkHandle);
      await sdkDisposalPromise(f.sdkOwner, prepared.sdkHandle);
    }
  },
);

test('sealed receipt re-admission authenticates a new request and SDK handle without reviving retired custody', async () => {
  const originalRequest = new AbortController();
  const f = await sdkFixture(
    'anthropic',
    '/api/orchestration/chat',
    () => mockResponse('anthropic'),
    originalRequest.signal,
  );
  const first = await f.owner.prepareSdkSnapshot(
    f.context(),
    subject,
    f.sealed.capability,
    f.sdkOwner,
  );
  const { wire } = inspectSdkSourceWire(f.sdkOwner, first.sdkHandle);
  const response = enterFinalFetch(f.sdkOwner, first.sdkHandle, wire.url, {
    method: 'POST',
    headers: Object.fromEntries(wire.headers),
    body: wire.body,
    redirect: 'error',
  });
  deliverSdkResponse(f.sdkOwner, first.sdkHandle, await response);
  assert.equal(
    (await sdkResultPromise(f.sdkOwner, first.sdkHandle)).text,
    'OK',
  );
  await sdkDisposalPromise(f.sdkOwner, first.sdkHandle);
  originalRequest.abort();
  const nextRequest = f.request();
  const nextContext = requestContext(nextRequest)();
  const owner = new sourceAdmission.LocalSourceAdmissionOwner(
    f.home,
    f.environment,
    f.store,
  );
  const next = await owner.readmitSnapshot(
    nextContext,
    subject,
    f.sealed.source,
  );
  const selection = await f.credentialOwner.owner.captureAgentSdkCredential(
    nextRequest,
    'worker',
  );
  const sdkOwner = createPreparedSdkSourceWireOwner({
    ...f.configuration,
    credential: selection.credential,
  });
  let nextHandle: object | undefined;
  try {
    assert.deepEqual(next.source, f.sealed.source);
    assert.notEqual(next.capability, f.sealed.capability);
    const prepared = await owner.prepareSdkSnapshot(
      nextContext,
      subject,
      next.capability,
      sdkOwner,
    );
    nextHandle = prepared.sdkHandle;
    assert.notEqual(prepared.sdkHandle, first.sdkHandle);
    const captured = inspectSdkSourceWire(sdkOwner, prepared.sdkHandle);
    assert.equal(captured.sourceBinding.request, nextRequest);
    assert.deepEqual(captured.sourceBinding.source, f.sealed.source);
    assert.equal(
      captured.sourceBinding.expiresAtMs,
      JSON.parse(
        readFileSync(
          join(
            f.store,
            `snapshot-${f.sealed.source.source_admission_receipt.id}.json`,
          ),
          'utf8',
        ),
      ).payload.provenance.expiresAt,
    );
    assert.equal(captured.wire.body, wire.body);
    assert.equal(f.starts, 1);
    const secondResponse = enterFinalFetch(
      sdkOwner,
      prepared.sdkHandle,
      captured.wire.url,
      {
        method: 'POST',
        headers: Object.fromEntries(captured.wire.headers),
        body: captured.wire.body,
        redirect: 'error',
      },
    );
    deliverSdkResponse(sdkOwner, prepared.sdkHandle, await secondResponse);
    assert.equal(
      (await sdkResultPromise(sdkOwner, prepared.sdkHandle)).text,
      'OK',
    );
    await sdkDisposalPromise(sdkOwner, prepared.sdkHandle);
    assert.equal(f.starts, 2);
    assert.throws(() =>
      enterFinalFetch(f.sdkOwner, first.sdkHandle, wire.url, {
        method: 'POST',
        headers: Object.fromEntries(wire.headers),
        body: wire.body,
        redirect: 'error',
      }),
    );
    assert.equal(f.starts, 2);
  } finally {
    owner.releaseSnapshot(next.capability);
    if (nextHandle) {
      disposeSdkSourceWire(sdkOwner, nextHandle);
      await sdkDisposalPromise(sdkOwner, nextHandle);
    }
  }
});

test.each([
  'signature',
  'missing-receipt',
  'aborted-request',
  'physical-root',
  'tuple',
  'subject',
  'expired',
  'revoked',
  'bytes',
  'same-byte-rewrite',
  'head',
  'metadata',
] as const)(
  'sealed re-admission refuses %s before any SDK call',
  async (control) => {
    const f = await sdkFixture();
    f.owner.releaseSnapshot(f.sealed.capability);
    const receiptPath = join(
      f.store,
      `snapshot-${f.sealed.source.source_admission_receipt.id}.json`,
    );
    const originalReceipt = readFileSync(receiptPath, 'utf8');
    const stored = JSON.parse(originalReceipt);
    const source = { ...structuredClone(f.sealed.source) };
    const requestedSubject = { ...subject };
    if (control === 'signature') {
      const changed =
        (stored.signature[0] === 'A' ? 'B' : 'A') + stored.signature.slice(1);
      writeFileSync(
        receiptPath,
        originalReceipt.replace(stored.signature, changed),
      );
    }
    if (control === 'missing-receipt') unlinkSync(receiptPath);
    const abort = new AbortController();
    if (control === 'aborted-request') abort.abort();
    if (control === 'physical-root') {
      const previous = `${f.repo}-original`;
      renameSync(f.repo, previous);
      mkdirSync(f.repo, { mode: 0o700 });
      cpSync(join(previous, 'source.txt'), join(f.repo, 'source.txt'));
      renameSync(join(previous, '.git'), join(f.repo, '.git'));
    }
    if (control === 'tuple') source.execution_worktree_id = 'foreign-slot';
    if (control === 'subject') requestedSubject.workItemId = 'other-child';
    if (control === 'revoked')
      f.environment.devicePairing.revokeDevice(
        f.paired.device.id,
        'operator-credential',
      );
    if (control === 'bytes') {
      writeFileSync(join(f.repo, 'source.txt'), 'changed committed bytes\n');
      await f.git('add', 'source.txt');
      await f.git('commit', '-qm', 'source changed');
    }
    if (control === 'same-byte-rewrite')
      writeFileSync(join(f.repo, 'source.txt'), 'original source\n');
    if (control === 'head')
      await f.git('commit', '--allow-empty', '-qm', 'new head same source');
    if (control === 'metadata') {
      const manifest = JSON.parse(readFileSync(f.manifestPath, 'utf8'));
      manifest.name = 'Changed project';
      writeFileSync(f.manifestPath, JSON.stringify(manifest));
    }
    const clock =
      control === 'expired'
        ? vi
            .spyOn(Date, 'now')
            .mockReturnValue(stored.payload.provenance.expiresAt)
        : undefined;
    try {
      const owner = new sourceAdmission.LocalSourceAdmissionOwner(
        f.home,
        f.environment,
        f.store,
      );
      const readmission = owner.readmitSnapshot(
        requestContext(
          f.request('/api/orchestration/chat', { signal: abort.signal }),
        )(),
        requestedSubject,
        source,
      );
      if (control === 'revoked' || control === 'aborted-request')
        await assert.rejects(readmission);
      else {
        const expected =
          control === 'signature' || control === 'missing-receipt'
            ? 'receipt_unavailable'
            : control === 'tuple' || control === 'subject'
              ? 'receipt_binding_mismatch'
              : control === 'expired'
                ? 'receipt_expired'
                : 'source_changed';
        await assert.rejects(readmission, code(expected));
      }
      assert.equal(f.starts, 0);
    } finally {
      clock?.mockRestore();
    }
  },
);

test.each([
  'aborted-after-admission',
  'foreign-request',
  'replaced-receipt',
] as const)(
  'fresh sealed custody refuses %s before SDK preparation',
  async (control) => {
    const f = await sdkFixture();
    f.owner.releaseSnapshot(f.sealed.capability);
    const abort = new AbortController();
    const request = f.request('/api/orchestration/chat', {
      signal: abort.signal,
    });
    const context = requestContext(request)();
    const owner = new sourceAdmission.LocalSourceAdmissionOwner(
      f.home,
      f.environment,
      f.store,
    );
    const admitted = await owner.readmitSnapshot(
      context,
      subject,
      f.sealed.source,
    );
    try {
      if (control === 'aborted-after-admission') abort.abort();
      if (control === 'replaced-receipt') {
        const path = join(
          f.store,
          `snapshot-${f.sealed.source.source_admission_receipt.id}.json`,
        );
        writeFileSync(path, readFileSync(path));
      }
      const prepared = owner.prepareSdkSnapshot(
        control === 'foreign-request' ? requestContext(f.request())() : context,
        subject,
        admitted.capability,
        f.sdkOwner,
      );
      if (control === 'aborted-after-admission') await assert.rejects(prepared);
      else
        await assert.rejects(
          prepared,
          code(
            control === 'foreign-request'
              ? 'snapshot_request_mismatch'
              : 'snapshot_receipt_changed',
          ),
        );
      assert.equal(f.starts, 0);
    } finally {
      owner.releaseSnapshot(admitted.capability);
    }
  },
);

test('retiring one re-admitted SDK holder leaves another independently revocable', async () => {
  const f = await sdkFixture();
  f.owner.releaseSnapshot(f.sealed.capability);
  const owner = new sourceAdmission.LocalSourceAdmissionOwner(
    f.home,
    f.environment,
    f.store,
  );
  const request = f.request();
  const context = requestContext(request)();
  const first = await owner.readmitSnapshot(
    f.context(),
    subject,
    f.sealed.source,
  );
  const second = await owner.readmitSnapshot(context, subject, f.sealed.source);
  const credential = await f.credentialOwner.owner.captureAgentSdkCredential(
    request,
    'worker',
  );
  const secondOwner = createPreparedSdkSourceWireOwner({
    ...f.configuration,
    credential: credential.credential,
  });
  const a = await owner.prepareSdkSnapshot(
    f.context(),
    subject,
    first.capability,
    f.sdkOwner,
  );
  const b = await owner.prepareSdkSnapshot(
    context,
    subject,
    second.capability,
    secondOwner,
  );
  const resultB = sdkResultPromise(secondOwner, b.sdkHandle);
  void resultB.catch(() => {});
  try {
    const { wire } = inspectSdkSourceWire(f.sdkOwner, a.sdkHandle);
    const response = enterFinalFetch(f.sdkOwner, a.sdkHandle, wire.url, {
      method: 'POST',
      headers: Object.fromEntries(wire.headers),
      body: wire.body,
      redirect: 'error',
    });
    deliverSdkResponse(f.sdkOwner, a.sdkHandle, await response);
    await sdkResultPromise(f.sdkOwner, a.sdkHandle);
    await sdkDisposalPromise(f.sdkOwner, a.sdkHandle);
    const pending = inspectSdkSourceWire(secondOwner, b.sdkHandle);
    assert.equal(pending.sourceBinding.request, request);
    owner.releaseSnapshot(second.capability);
    await assert.rejects(resultB);
    await sdkDisposalPromise(secondOwner, b.sdkHandle);
    assert.throws(() =>
      enterFinalFetch(secondOwner, b.sdkHandle, pending.wire.url, {
        method: 'POST',
        headers: Object.fromEntries(pending.wire.headers),
        body: pending.wire.body,
        redirect: 'error',
      }),
    );
    assert.equal(f.starts, 1);
  } finally {
    owner.releaseSnapshot(first.capability);
    owner.releaseSnapshot(second.capability);
    disposeSdkSourceWire(f.sdkOwner, a.sdkHandle);
    disposeSdkSourceWire(secondOwner, b.sdkHandle);
    await Promise.all([
      sdkDisposalPromise(f.sdkOwner, a.sdkHandle),
      sdkDisposalPromise(secondOwner, b.sdkHandle),
    ]);
  }
});

test('concurrent sealed re-admission retains distinct custody within the existing four-holder capacity', async () => {
  const f = await sdkFixture();
  f.owner.releaseSnapshot(f.sealed.capability);
  const owner = new sourceAdmission.LocalSourceAdmissionOwner(
    f.home,
    f.environment,
    f.store,
  );
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, () =>
      owner.readmitSnapshot(
        requestContext(f.request())(),
        subject,
        f.sealed.source,
      ),
    ),
  );
  const admitted = results.flatMap((r) =>
    r.status === 'fulfilled' ? [r.value] : [],
  );
  try {
    assert.equal(admitted.length, 4);
    assert.equal(new Set(admitted.map((a) => a.capability)).size, 4);
    for (const a of admitted) assert.deepEqual(a.source, f.sealed.source);
    const refused = results.filter((r) => r.status === 'rejected');
    assert.equal(refused.length, 1);
    assert.ok(refused[0].reason instanceof sourceAdmission.SourceRefusal);
    assert.equal(refused[0].reason.code, 'snapshot_capacity_exceeded');
    assert.equal(f.starts, 0);
  } finally {
    for (const a of admitted) owner.releaseSnapshot(a.capability);
  }
});

import { publicFenceFixture } from './delegation-source-fixtures/fence.js';

test.each(['funded', 'replaced-record', 'unadmitted-epoch'] as const)(
  'fresh reserved SDK turn preserves its actual Session and budget boundary (%s)',
  async (control) => {
    const f = await sdkFixture();
    const startSession = StationAgentAdapter.prototype.startSession;
    let original:
      | {
          adapter: StationAgentAdapter;
          input: Parameters<StationAgentAdapter['startSession']>[0];
          session: Awaited<ReturnType<StationAgentAdapter['startSession']>>;
        }
      | undefined;
    const intercepted = vi
      .spyOn(StationAgentAdapter.prototype, 'startSession')
      .mockImplementation(async function (this: StationAgentAdapter, input) {
        const session = await startSession.call(this, input);
        original = { adapter: this, input, session };
        return session;
      });
    onTestFinished(() => {
      intercepted.mockRestore();
    });
    const fetchBoundary = vi.spyOn(
      RoundsFinalFetchLaunchFence.prototype,
      'start',
    );
    onTestFinished(() => {
      fetchBoundary.mockRestore();
    });
    const first = await f.owner.prepareSdkSnapshot(
      f.context(),
      subject,
      f.sealed.capability,
      f.sdkOwner,
    );
    const initial = inspectSdkSourceWire(f.sdkOwner, first.sdkHandle);
    const driver = await publicFenceFixture(
      f,
      initial.sourceBinding.source,
      f.sdkOwner,
      first.sdkHandle,
      initial.wire,
      () => {},
      {
        protocol: 'rounds',
        provider: 'anthropic',
        contract: initial.contract,
        now: () => 1000,
        maxAttempts: 2,
      },
    );
    await driver.run();
    assert.equal(driver.invocationFailure, undefined);
    assert.equal(f.starts, 1);
    const started = driver
      .canonicalEvents()
      .find((event) => event.method === 'session.started');
    assert.ok(started?.method === 'session.started');
    const sessionId = started.threadId;
    const originalRecipient =
      driver.orchestration.captureReservedStationSession(sessionId, {
        userId: 'fixture-owner',
      });
    const observation = {
      principalId: 'fixture-owner',
      environmentId: f.record.environmentId,
      threadId: sessionId,
    };
    const identity = reservedStationSessionRecipient(
      originalRecipient,
      observation,
    );
    const originalMode =
      started.metadata?.[RESERVED_SOURCE_EXECUTION_METADATA_KEY];
    assert.ok(originalMode);
    const request = f.request();
    const context = requestContext(request)();
    const source = await f.owner.readmitSnapshot(
      context,
      subject,
      f.sealed.source,
    );
    const selected = await f.credentialOwner.owner.captureAgentSdkCredential(
      request,
      'worker',
    );
    const owner = createPreparedSdkSourceWireOwner({
      ...f.configuration,
      credential: selected.credential,
      brief: 'A second bounded report',
    });
    let handle: object | undefined;
    try {
      const fresh = await f.owner.prepareSdkSnapshot(
        context,
        subject,
        source.capability,
        owner,
      );
      handle = fresh.sdkHandle;
      const captured = inspectSdkSourceWire(owner, handle);
      if (control === 'replaced-record') {
        assert.ok(original);
        await startSession.call(original.adapter, {
          ...original.input,
          resumeCursor: structuredClone(original.session.resumeCursor),
        });
      }
      await driver.runNext({
        sdkOwner: owner,
        handle,
        wire: captured.wire,
        contract: captured.contract,
        brief: 'A second bounded report',
        clientTurnId: 'second-reserved-client-turn',
        ...(control === 'unadmitted-epoch' ? { authorityEpoch: 2 } : {}),
      });
      if (control === 'funded') {
        assert.equal(driver.invocationFailure, undefined);
        assert.equal(f.starts, 2);
        assert.equal(
          driver.orchestration.captureReservedStationSession(sessionId, {
            userId: 'fixture-owner',
          }),
          originalRecipient,
        );
        assert.deepEqual(
          reservedStationSessionRecipient(originalRecipient, observation),
          identity,
        );
        const starts = driver
          .canonicalEvents()
          .filter((event) => event.method === 'session.started');
        assert.equal(starts.length, 1);
        assert.deepEqual(
          starts[0].method === 'session.started' &&
            starts[0].metadata?.[RESERVED_SOURCE_EXECUTION_METADATA_KEY],
          originalMode,
        );
        const turns = driver
          .canonicalEvents()
          .filter((event) => event.method === 'turn.started');
        assert.equal(turns.length, 2);
        assert.notEqual(turns[0].turnId, turns[1].turnId);
        assert.equal(driver.relayCalls, 0);
        const ledger = await driver.ledger();
        assert.equal(ledger.invocations.length, 2);
        assert.ok(
          ledger.invocations.every(
            (invocation) => invocation.terminal && invocation.usage !== null,
          ),
        );
      } else if (control === 'unadmitted-epoch') {
        assert.ok(driver.invocationFailure);
        assert.equal(fetchBoundary.mock.calls.length, 2);
        assert.equal(f.starts, 1);
        assert.equal(
          driver.canonicalEvents().filter((e) => e.method === 'turn.started')
            .length,
          2,
        );
        assert.deepEqual(
          reservedStationSessionRecipient(originalRecipient, observation),
          identity,
        );
        assert.equal(
          driver.canonicalEvents().filter((e) => e.method === 'session.started')
            .length,
          1,
        );
      } else {
        assert.ok(driver.invocationFailure);
        assert.equal(f.starts, 1);
        assert.throws(() =>
          reservedStationSessionRecipient(originalRecipient, observation),
        );
      }
    } finally {
      fetchBoundary.mockRestore();
      intercepted.mockRestore();
      f.owner.releaseSnapshot(source.capability);
      if (handle) {
        disposeSdkSourceWire(owner, handle);
        await sdkDisposalPromise(owner, handle);
      }
    }
  },
  60000,
);

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
      credential: JSON.parse('{}'),
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

for (const provider of ['anthropic', 'google'] as const)
  test(`SDK ${provider} refuses credential rotation after durable wire intent without releasing unknown accounting`, async () => {
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
      () => {
        const path = join(f.home, 'config', 'providers.json');
        const rows = JSON.parse(readFileSync(path, 'utf8'));
        rows.find(
          (row: { id: string }) => row.id === 'connection-1',
        ).config.apiKey = 'rotated-synthetic-key';
        writeFileSync(path, JSON.stringify(rows));
      },
      {
        provider,
        protocol: 'rounds',
        contract: f.configuration.contract,
        now: () => 1000,
      },
    );
    await driver.run();
    assert.equal(driver.intentCount, 1);
    assert.equal(f.starts, 0);
    assert.equal(driver.observed.length, 0);
    const ledger = await driver.ledger();
    assert.equal(ledger.invocations[0].usage, null);
    assert.equal(ledger.invocations[0].terminal, false);
    await assert.rejects(() => driver.reserveAnother(), {
      code: 'active_slot_exhausted',
    });
    await sdkDisposalPromise(f.sdkOwner, prepared.sdkHandle);
  });

test.each(['credential', 'qualification'] as const)(
  'SDK refuses %s revoked by source consumption and cannot resend the consumed snapshot',
  async (kind) => {
    const f = await sdkFixture();
    const prepared = await f.owner.prepareSdkSnapshot(
      f.context(),
      subject,
      f.sealed.capability,
      f.sdkOwner,
    );
    const { wire } = inspectSdkSourceWire(f.sdkOwner, prepared.sdkHandle);
    const claim = sourceAdmission.claimSdkSourceLease;
    let consumed = false;
    // Inject only the race after REAL source consumption, not an alternate source grant.
    const probe = vi
      .spyOn(sourceAdmission, 'claimSdkSourceLease')
      .mockImplementation((token) => {
        const lease = claim(token);
        return {
          ...lease,
          consumeExactSync(owner, handle, digest) {
            const value = lease.consumeExactSync(owner, handle, digest);
            consumed = true;
            if (kind === 'credential') {
              const path = join(f.home, 'config', 'providers.json');
              const rows = JSON.parse(readFileSync(path, 'utf8'));
              rows.find(
                (row: { id: string }) => row.id === 'connection-1',
              ).config.apiKey = 'rotated-during-consumption';
              writeFileSync(path, JSON.stringify(rows));
            } else f.q.revoke();
            return value;
          },
        };
      });
    const driver = await publicFenceFixture(
      f,
      prepared.source,
      f.sdkOwner,
      prepared.sdkHandle,
      wire,
      () => {},
      {
        provider: 'anthropic',
        protocol: 'rounds',
        contract: f.configuration.contract,
        now: () => 1000,
      },
    );
    try {
      await driver.run();
      assert.equal(consumed, true);
      assert.equal(driver.intentCount, 1);
      assert.equal(f.starts, 0);
      assert.equal(driver.observed.length, 0);
      const ledger = await driver.ledger();
      assert.equal(ledger.invocations[0].usage, null);
      assert.equal(ledger.invocations[0].terminal, false);
      await assert.rejects(() => driver.reserveAnother(), {
        code: 'active_slot_exhausted',
      });
      await assert.rejects(
        () =>
          f.owner.prepareSdkSnapshot(
            f.context(),
            subject,
            f.sealed.capability,
            f.sdkOwner,
          ),
        { code: 'snapshot_unavailable' },
      );
      await sdkDisposalPromise(f.sdkOwner, prepared.sdkHandle);
    } finally {
      probe.mockRestore();
    }
  },
);

test('SDK preparation refuses serialized credentials, wrong providers and qualified credential mismatches', async () => {
  const f = await sdkFixture();
  assert.equal(JSON.stringify(f.credentialOwner.credential), '{}');
  assert.ok(
    !JSON.stringify(f.credentialOwner.observed).includes(
      'synthetic-not-credential',
    ),
  );
  assert.throws(
    () =>
      createPreparedSdkSourceWireOwner({
        ...f.configuration,
        credential: JSON.parse('{}'),
      }),
    { code: 'observation_unavailable' },
  );
  assert.throws(
    () =>
      createPreparedSdkSourceWireOwner({
        ...f.configuration,
        provider: 'google',
      }),
    { code: 'unsupported_source' },
  );
  f.q.binding.credentialRevision = 'another-credential';
  f.q.publishFixture();
  assert.throws(
    () =>
      createPreparedSdkSourceWireOwner({
        ...f.configuration,
        contract: f.q.resolve(),
      }),
    { code: 'binding_mismatch' },
  );
  assert.equal(f.starts, 0);
  f.owner.releaseSnapshot(f.sealed.capability);
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

for (const text of ['x'.repeat(65_536), '\0'.repeat(65_536)])
  test(`context carriage admits the complete UTF-8 bound without using report brief allowance: ${text[0] === 'x' ? 'ASCII' : 'escaped'}`, async () => {
    const f = await sdkFixture('anthropic');
    const { brief: _brief, ...configuration } = f.configuration;
    const instructions = 'i'.repeat(65_535);
    assert.throws(
      () =>
        createPreparedSdkSourceWireOwner({
          ...configuration,
          brief: 'xx',
          instructions,
        }),
      sdkCode('sdk_configuration_unsupported'),
    );
    assert.throws(
      () =>
        createContextSyncSdkSourceWireOwner({
          ...configuration,
          runId: 'sync-bound',
          text: `${text}x`,
        }),
      sdkCode('sdk_context_unsupported'),
    );
    const context = createContextSyncSdkSourceWireOwner({
      ...configuration,
      instructions,
      runId: 'sync-bound',
      text,
    });
    const prepared = await f.owner.prepareSdkSnapshot(
      f.context(),
      subject,
      f.sealed.capability,
      context.owner,
    );
    try {
      const captured = inspectSdkSourceWire(context.owner, prepared.sdkHandle);
      const payload = JSON.parse(
        JSON.parse(captured.wire.body).messages[0].content[0].text,
      );
      assert.equal(payload.context, text);
      assert.equal(payload.instructions, instructions);
      assert.equal(payload.brief, context.input);
      assert.equal(Buffer.byteLength(payload.context), 65_536);
      assert.ok(Buffer.byteLength(context.input) < 512);
      assert.ok(Buffer.byteLength(captured.wire.body) < 2_097_152);
      assert.equal(f.starts, 0);
    } finally {
      f.owner.releaseSnapshot(f.sealed.capability);
      disposeSdkSourceWire(context.owner, prepared.sdkHandle);
      await sdkDisposalPromise(context.owner, prepared.sdkHandle);
    }
  });

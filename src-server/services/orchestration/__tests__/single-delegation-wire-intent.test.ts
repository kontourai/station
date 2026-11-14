import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDelegationAuthorityServiceV3 } from '@kontourai/flow-agents/delegation-authority-service-v3';
import {
  delegationEnvelopeDigestV2,
  rootAuthorityReferenceV2,
} from '@kontourai/flow-agents/delegation-envelope-v2';
import { onTestFinished, test, vi } from 'vitest';
import { isRuntimePublicationParticipant } from '../../../runtime/bootstrap/runtime-publication-participant.js';
import { StationRuntime } from '../../../runtime/bootstrap/station-runtime.js';
import { HomeWriterOwner } from '../../ssh/home-writer-owner.js';
import {
  type FinalWire,
  SingleDelegationFinalFetchLaunchFence,
  type SingleReservedWireBinding,
} from '../delegation-group-launch-fence.js';
import {
  FileFinalWireIntentStore,
  type SingleFinalWireIntentIdentity,
  wireIdentityDigest,
} from '../delegation-group-wire-intent-store.js';
import {
  type ReportRoundsScope,
  withReportRoundsPublication,
} from '../report-rounds-publication.js';
import { setup } from './delegation-source-fixtures/report.js';

async function fixture(reserve = true) {
  const h = await setup();
  const handle = await h.owner.prepare(h.f.context(), {
    ...h.input,
    members: h.input.members.slice(0, 1),
    maxConcurrent: 1,
  });
  const prepared = h.owner.read(handle, h.f.req);
  const sourceCurrent = (): undefined => {
    h.owner.assertCurrent(handle, h.f.req);
    return undefined;
  };
  const runtime = new StationRuntime({ projectHomeDir: h.f.home });
  const participant = Reflect.get(runtime, 'runtimePublicationParticipant');
  assert.ok(isRuntimePublicationParticipant(participant));
  const owner = await HomeWriterOwner.forHome(h.f.home);
  let ready!: (scope: ReportRoundsScope) => void;
  let failed!: (error: unknown) => void;
  let release!: () => void;
  const entered = new Promise<ReportRoundsScope>((resolve, reject) => {
    ready = resolve;
    failed = reject;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const lifetime = withReportRoundsPublication(
    { participant, home: h.f.home, signal: h.f.req.signal },
    (publication) =>
      publication.withHome({ owner, current: sourceCurrent }, async (scope) => {
        ready(scope);
        await gate;
      }),
  );
  void lifetime.catch(failed);
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      release();
      try {
        await lifetime;
      } finally {
        h.owner.close(handle);
        await runtime.shutdown();
      }
    })());
  onTestFinished(close);
  const scope = await entered;
  const current = scope.current;
  const host = {
    now: () => new Date(Date.now()).toISOString(),
    authorize: async (
      _action: unknown,
      root: typeof prepared.root,
      envelope: Parameters<typeof h.owner.authorizes>[3],
    ) => h.owner.authorizes(handle, h.f.req, root, envelope),
    confirmExecution: async (
      envelope: Parameters<typeof h.owner.confirmsExecution>[2],
    ) => h.owner.confirmsExecution(handle, h.f.req, envelope),
    authenticateRenewal: async () => null,
  };
  const authorities = h.custodyOwners.persistence.roundsAuthorityStore(
    current,
    current,
    scope,
  );
  const scopedHost = {
    ...host,
    authorize: (...args: Parameters<typeof host.authorize>) =>
      scope.check(() => ({ value: host.authorize(...args) })).value,
    confirmExecution: (...args: Parameters<typeof host.confirmExecution>) =>
      scope.check(() => ({ value: host.confirmExecution(...args) })).value,
  };
  const service = createDelegationAuthorityServiceV3(authorities, scopedHost, {
    maxRenewals: 0,
  });
  await service.issue(prepared.root);
  for (const envelope of prepared.envelopes)
    await service.derive(prepared.root.authority_id, envelope);
  const envelope = prepared.envelopes.find((entry) => entry.parent !== null);
  assert.ok(envelope);
  const seat = prepared.spec.seats[0];
  assert.ok(seat);
  if (reserve)
    await service.reserveInvocation(
      prepared.root.authority_id,
      envelope.envelope_id,
      'single-request',
      seat.allocation,
    );
  const wire: FinalWire = {
    url: 'https://provider.example.test/v1/messages',
    method: 'POST',
    headers: [['content-type', 'application/json']],
    body: '{"prompt":"controlled"}',
  };
  const binding: SingleReservedWireBinding = {
    authority: rootAuthorityReferenceV2(prepared.root),
    envelope: {
      id: envelope.envelope_id,
      generation: envelope.generation,
      digest: delegationEnvelopeDigestV2(envelope),
    },
    invocationId: 'single-request',
    effect: 'report',
    allocation: seat.allocation,
    expectedWireDigest: wireIdentityDigest(wire),
  };
  const intents = new FileFinalWireIntentStore(join(h.f.home, 'report-groups'));
  const transport = vi.fn<typeof fetch>(
    async () => new Response('controlled response'),
  );
  const owners = {
    authorities,
    host,
    intents,
    finalizeCurrent: current,
    fetch: transport,
    scope,
  };
  return {
    h,
    handle,
    prepared,
    envelope,
    current,
    service,
    binding,
    wire,
    intents,
    transport,
    owners,
    close,
  };
}

test('one reserved single execution sends once, survives reopen and conflicts with a group-shaped retry', async () => {
  const f = await fixture();
  try {
    const legacy = {
      groupId: 'legacy-group',
      controller: { id: 'legacy-controller', generation: 1 },
      seatId: 'legacy-seat',
      root: f.binding.authority,
      envelope: f.binding.envelope,
      executionId: f.envelope.execution_id,
      invocationId: 'legacy-request',
      effect: f.binding.effect,
      allocation: f.binding.allocation,
      executionBindingDigest: wireIdentityDigest(f.envelope.execution_binding),
      principalDigest: f.prepared.root.authenticated_principal_ref.digest,
      subjectDigest: f.prepared.root.authenticated_subject_ref.digest,
      finalWireDigest: f.binding.expectedWireDigest,
    };
    await f.intents.consume(legacy, f.current);
    const ledgerPath = join(
      f.intents.root,
      'final-wire-intents',
      'intents.json',
    );
    assert.equal(JSON.parse(readFileSync(ledgerPath, 'utf8')).version, 1);
    const fence = new SingleDelegationFinalFetchLaunchFence(f.owners);
    const identity = await fence.start(
      f.binding,
      f.wire,
      new AbortController().signal,
    );
    assert.equal(fence.invoked, true);
    assert.equal(await (await fence.response).text(), 'controlled response');
    assert.equal(f.transport.mock.calls.length, 1);
    const reopened = new FileFinalWireIntentStore(f.intents.root);
    assert.deepEqual(
      await reopened.lookup(legacy.root.id, legacy.invocationId, f.current),
      legacy,
    );
    await assert.rejects(
      reopened.lookupSingle(legacy.root.id, legacy.invocationId, f.current),
      { code: 'wire_intent_kind_mismatch' },
    );
    assert.deepEqual(
      await reopened.lookupSingle(
        f.binding.authority.id,
        f.binding.invocationId,
        f.current,
      ),
      identity,
    );
    const stored = JSON.parse(
      readFileSync(
        join(f.intents.root, 'final-wire-intents', 'intents.json'),
        'utf8',
      ),
    );
    assert.equal(stored.version, 2);
    const replay = new SingleDelegationFinalFetchLaunchFence({
      ...f.owners,
      intents: reopened,
    });
    await assert.rejects(
      replay.start(f.binding, f.wire, new AbortController().signal),
      { code: 'wire_intent_already_consumed' },
    );
    await assert.rejects(replay.response, {
      code: 'wire_intent_already_consumed',
    });
    const { scope: _scope, ...shared } = identity;
    await assert.rejects(
      reopened.consume(
        {
          ...shared,
          groupId: 'foreign-group',
          controller: { id: 'foreign-controller', generation: 1 },
          seatId: 'foreign-seat',
        },
        f.current,
      ),
      { code: 'wire_intent_conflict' },
    );
    await assert.rejects(
      reopened.lookup(
        f.binding.authority.id,
        f.binding.invocationId,
        f.current,
      ),
      { code: 'wire_intent_kind_mismatch' },
    );
    assert.equal(f.transport.mock.calls.length, 1);
    const ledger = await f.service.inspect(f.binding.authority.id);
    assert.equal(ledger.invocations[0]?.usage, null);
    assert.equal(ledger.invocations[0]?.terminal, false);
  } finally {
    await f.close();
  }
});

for (const mode of [
  'missing-reservation',
  'generation',
  'wire',
  'cancelled',
] as const) {
  test(`single fetch refuses ${mode} before transport`, async () => {
    const f = await fixture(mode !== 'missing-reservation');
    try {
      const binding = structuredClone(f.binding);
      const wire = structuredClone(f.wire);
      if (mode === 'generation') binding.envelope.generation++;
      if (mode === 'wire') wire.body = '{"prompt":"changed"}';
      if (mode === 'cancelled') await f.service.cancel(binding.authority.id);
      const fence = new SingleDelegationFinalFetchLaunchFence(f.owners);
      await assert.rejects(
        fence.start(binding, wire, new AbortController().signal),
      );
      await assert.rejects(fence.response);
      assert.equal(fence.invoked, false);
      assert.equal(f.transport.mock.calls.length, 0);
    } finally {
      await f.close();
    }
  });
}

test('a single response remains owned when authority acknowledgement fails after invocation', async () => {
  const f = await fixture();
  const failure = Error('controlled post-invocation acknowledgement loss');
  try {
    let invoked = false;
    const fence = new SingleDelegationFinalFetchLaunchFence({
      ...f.owners,
      authorities: {
        transact: async (id, body) => {
          const result = await f.owners.authorities.transact(id, body);
          if (invoked) throw failure;
          return result;
        },
      },
      fetch: async (input, init) => {
        invoked = true;
        return f.transport(input, init);
      },
    });
    await assert.rejects(
      fence.start(f.binding, f.wire, new AbortController().signal),
      (error) => error === failure,
    );
    assert.equal(fence.invoked, true);
    assert.equal(await (await fence.response).text(), 'controlled response');
    assert.equal(f.transport.mock.calls.length, 1);
    const retained: SingleFinalWireIntentIdentity | undefined =
      await f.intents.lookupSingle(
        f.binding.authority.id,
        f.binding.invocationId,
        f.current,
      );
    assert.ok(retained);
    const replay = new SingleDelegationFinalFetchLaunchFence(f.owners);
    await assert.rejects(
      replay.start(f.binding, f.wire, new AbortController().signal),
      { code: 'wire_intent_already_consumed' },
    );
    assert.equal(f.transport.mock.calls.length, 1);
  } finally {
    await f.close();
  }
});

test('cancellation after durable single intent prevents transport and retains the no-resend fact', async () => {
  const f = await fixture();
  const controller = new AbortController();
  const cancelled = Error('cancelled after durable intent');
  class CancellingIntents extends FileFinalWireIntentStore {
    override async consumeSingle(
      ...args: Parameters<FileFinalWireIntentStore['consumeSingle']>
    ): Promise<void> {
      await super.consumeSingle(...args);
      controller.abort(cancelled);
    }
  }
  try {
    const fence = new SingleDelegationFinalFetchLaunchFence({
      ...f.owners,
      intents: new CancellingIntents(f.intents.root),
    });
    await assert.rejects(
      fence.start(f.binding, f.wire, controller.signal),
      (error) => error === cancelled,
    );
    await assert.rejects(fence.response, (error) => error === cancelled);
    assert.equal(fence.invoked, false);
    assert.equal(f.transport.mock.calls.length, 0);
    const reopened = new FileFinalWireIntentStore(f.intents.root);
    assert.ok(
      await reopened.lookupSingle(
        f.binding.authority.id,
        f.binding.invocationId,
        f.current,
      ),
    );
    const replay = new SingleDelegationFinalFetchLaunchFence({
      ...f.owners,
      intents: reopened,
    });
    await assert.rejects(
      replay.start(f.binding, f.wire, new AbortController().signal),
      { code: 'wire_intent_already_consumed' },
    );
    await assert.rejects(replay.response, {
      code: 'wire_intent_already_consumed',
    });
    assert.equal(replay.invoked, false);
    assert.equal(f.transport.mock.calls.length, 0);
    const ledger = await f.service.inspect(f.binding.authority.id);
    assert.equal(ledger.invocations[0]?.usage, null);
    assert.equal(ledger.invocations[0]?.terminal, false);
  } finally {
    await f.close();
  }
});

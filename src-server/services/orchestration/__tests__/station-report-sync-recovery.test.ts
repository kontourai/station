import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { FileAuthorizationLedger } from '@kontourai/dispatch';
import { flowRunHead, loadRun } from '@kontourai/flow';
import { createDelegationAuthorityServiceV3 } from '@kontourai/flow-agents/delegation-authority-service-v3';
import {
  type DelegationEnvelopeV2,
  delegationParentReferenceV2,
  rootAuthorityReferenceV2,
} from '@kontourai/flow-agents/delegation-envelope-v2';
import {
  createDelegationRoundsController,
  type DelegationRoundsExecutionHost,
  preparedRoundsSyncDigest,
} from '@kontourai/flow-agents/delegation-group-rounds';
import type { ModelRuntime } from '@kontourai/relay';
import { canonicalJson } from '@kontourai/relay';
import { test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { StationDelegationPersistence } from '../delegation-group-persistence.js';
import { EventBus } from '../event-bus.js';
import { OrchestrationService } from '../orchestration-service.js';
import {
  signReportContinuationTurn,
  signReportInterrupt,
  verifyReportContinuationTurn,
} from '../station-report-group-cancellation.js';
import { StationReportGroupCustody } from '../station-report-group-custody.js';
import { createReportFlow } from './delegation-source-fixtures/flow.js';
import { requestFor, setup } from './delegation-source-fixtures/report.js';

const temporary = trackTempDirs();

test('private context storage round-trips the complete escaped byte bound and refuses one byte over', async () => {
  const persistence = new StationDelegationPersistence(
    realpathSync(temporary('report-context-bound-')),
  );
  const current = (): undefined => undefined;
  const text = '\0'.repeat(65_536);
  const reference = await persistence.retainReportContext(
    'bounded-context',
    text,
    current,
  );
  assert.equal(
    await persistence.readReportContext('bounded-context', reference, current),
    text,
  );
  await assert.rejects(
    persistence.retainReportContext('bounded-context', `${text}x`, current),
    { code: 'report_context_too_large' },
  );
  await assert.rejects(
    persistence.readReportContext('foreign-group', reference, current),
    { code: 'report_flow_observation_reference_mismatch' },
  );
  assert.equal(
    await persistence.readReportContext('bounded-context', reference, current),
    text,
  );
});

test('current sync finalization passes null-state preflight and reaches prepared-receipt validation without execution', async () => {
  const h = await setup();
  const flow = await createReportFlow(h.f, 'finalize-preflight', [
    { id: 'review' },
  ]);
  const handle = await h.owner.prepare(h.f.context(), {
    ...h.input,
    maxConcurrent: 1,
    members: h.input.members.slice(0, 1),
    flow: { runId: flow.runId, steps: { left: 'review' } },
    continuation: {
      attemptsPerMember: 3,
      maxRounds: 3,
      maxSyncs: 1,
      maxRenewals: 0,
      maxEvaluations: 2,
      maxRecoveries: 0,
    },
    budget: {
      inputTokens: 3 * 1_048_576,
      outputTokens: 30,
      costMicros: 3 * 3_145_878,
    },
  });
  try {
    const prepared = h.owner.read(handle, h.f.req);
    const groupId = await h.custody.retain(h.f.context(), h.owner, handle);
    const persistence = h.custodyOwners.persistence;
    const current = (): undefined => {
      h.owner.assertCurrent(handle, h.f.req);
      return undefined;
    };
    const service = createDelegationAuthorityServiceV3(
      persistence.roundsAuthorityStore(current),
      {
        now: () => new Date(Date.now()).toISOString(),
        authorize: async (_action, root, envelope) =>
          h.owner.authorizes(handle, h.f.req, root, envelope),
        confirmExecution: async (envelope) =>
          h.owner.confirmsExecution(handle, h.f.req, envelope),
        authenticateRenewal: async () => null,
      },
      { maxRenewals: 0 },
    );
    await service.issue(prepared.root);
    for (const envelope of prepared.envelopes)
      await service.derive(prepared.root.authority_id, envelope);
    const dispatchLedger = new FileAuthorizationLedger({
      root: temporary('finalize-dispatch-'),
    });
    const forbid = (): never => {
      throw Error('finalization must not execute');
    };
    let modelCalls = 0;
    const controlled: ModelRuntime = {
      id: 'controlled-failing-context',
      capabilities: () => ({
        structuredTools: false,
        streaming: false,
        abort: true,
        usage: true,
        outputTokenLimitFidelity: 'native',
      }),
      invoke: async () => {
        modelCalls++;
        throw Error('controlled execution lost before a provider response');
      },
    };
    const physical: DelegationRoundsExecutionHost = {
      resolveRuntime: async (
        envelope: (typeof prepared.envelopes)[number],
      ) => ({
        runtime: controlled,
        runtimeReceipt: envelope.execution_binding.runtime.runtime_receipt_ref,
        modelReceipt: envelope.execution_binding.runtime.model_receipt_ref,
      }),
      invokeFenced: async (_envelope, _id, launch) => launch(),
      retainResult: async () => undefined,
      retainFailure: async () => {},
    };
    const controller = createDelegationRoundsController({
      store: persistence.roundsStore(current),
      authorityService: service,
      dispatchLedger,
      cwd: h.f.repo,
      host: {
        authorize: async () => prepared.root.authenticated_principal_ref,
        executionHost: forbid,
        prepareRequest: async () => forbid(),
        retainObservation: async () => forbid(),
        confirmTerminal: async () => forbid(),
        requestDescendantCancellation: async () => forbid(),
        flow: {
          executionHost: forbid,
          confirmRetainedResult: async () => forbid(),
          retainEvaluation: async () => forbid(),
        },
        recipient: {
          resolve: async (spec, seat, envelope) => ({
            identity: {
              hostId: prepared.root.issuer_host_id,
              recipientId: 'controlled-unavailable-session',
              generation: 1,
              executionId: envelope.execution_id,
              authority: spec.rootAuthorityRef,
              envelope: { id: seat.envelope.id, digest: seat.envelope.digest },
              runtimeReceipt:
                envelope.execution_binding.runtime.runtime_receipt_ref,
              modelReceipt:
                envelope.execution_binding.runtime.model_receipt_ref,
              sessionReceipt: {
                id: 'controlled-session',
                domain: 'fixture-only',
                digest: `sha256:${'1'.repeat(64)}`,
              },
            },
            runtime: controlled,
            invokeFenced: physical.invokeFenced,
            retainResult: physical.retainResult,
            retainFailure: physical.retainFailure,
          }),
        },
        context: {
          executionHost: () => physical,
          confirmTerminal: async () => forbid(),
          load: (ref) => persistence.readReportContext(groupId, ref, current),
        },
        retainContinuation: async () => {
          throw Error('controlled receipt sidecar outage');
        },
      },
    });
    const created = await controller.create({
      kind: 'create',
      groupId,
      operationKey: 'create',
      expectedRevision: 0,
      controller: prepared.spec.controller,
      spec: prepared.spec,
    });
    await assert.rejects(
      h.custody.finalizeSync(
        h.f.context(requestFor(h, 'POST')),
        groupId,
        {
          operationKey: 'finish-absent',
          expectedRevision: created.projection.revision,
          syncOperationKey: 'absent',
          preparedDigest: `sha256:${'0'.repeat(64)}`,
        },
        dispatchLedger,
      ),
      /rounds_prepared_sync_required/,
    );
    assert.equal(h.rawFetch.mock.calls.length, 0);
    assert.equal(
      (await controller.get(groupId)).revision,
      created.projection.revision,
    );
    const contextRef = await persistence.retainReportContext(
      groupId,
      'Controlled held sync',
      current,
    );
    const snapshot = await loadRun(flow.runId, h.f.repo);
    await assert.rejects(
      controller.sync({
        kind: 'sync',
        groupId,
        operationKey: 'held-sync',
        expectedRevision: created.projection.revision,
        controller: prepared.spec.controller,
        checkpoint: prepared.root.revisions.policy,
        flowHead: flowRunHead(snapshot.state),
        seatId: 'left',
        contextRef,
      }),
      /receipt persistence failed/,
    );
    assert.equal(modelCalls, 1);
    const held = await controller.get(groupId);
    const originalLedger = (await service.inspect(prepared.root.authority_id))
      .invocations;
    assert.equal(originalLedger.length, 1);
    assert.equal(originalLedger[0].usage, null);
    assert.equal(originalLedger[0].terminal, false);
    const receipt = held.continuations[0].prepared;
    assert.ok(receipt);
    h.owner.close(handle);
    const reader = new StationReportGroupCustody(h.custodyOwners);
    const command = {
      operationKey: 'recover-held',
      expectedRevision: held.revision,
      syncOperationKey: 'held-sync',
      preparedDigest: preparedRoundsSyncDigest(receipt),
    };
    await assert.rejects(
      reader.finalizeSync(
        h.f.context(requestFor(h, 'POST')),
        groupId,
        {
          ...command,
          operationKey: 'wrong-digest',
          preparedDigest: `sha256:${'0'.repeat(64)}`,
        },
        dispatchLedger,
      ),
      /rounds_prepared_sync_identity/,
    );
    await assert.rejects(
      reader.finalizeSync(
        h.f.context(requestFor(h, 'POST')),
        groupId,
        {
          ...command,
          operationKey: 'wrong-revision',
          expectedRevision: held.revision - 1,
        },
        dispatchLedger,
      ),
      /rounds_revision_conflict/,
    );
    const finished = await reader.finalizeSync(
      h.f.context(requestFor(h, 'POST')),
      groupId,
      command,
      dispatchLedger,
    );
    assert.equal(finished.replayed, false);
    assert.equal(
      finished.projection.continuations[0].receipt?.acknowledged,
      false,
    );
    const replay = await reader.finalizeSync(
      h.f.context(requestFor(h, 'POST')),
      groupId,
      command,
      dispatchLedger,
    );
    assert.equal(replay.replayed, true);
    const retained = await reader.inspect(h.f.context(requestFor(h)), groupId);
    assert.deepEqual(retained?.authority?.invocations, originalLedger);
    assert.equal(modelCalls, 1);
    assert.equal(h.rawFetch.mock.calls.length, 0);
    assert.ok(retained?.group);
    const orchestration = new OrchestrationService({
      adapterRegistry: { register: forbid, get: forbid, list: () => [] },
      eventBus: new EventBus(),
      logger: { debug() {}, warn() {} },
    });
    const cancel = {
      operationKey: 'cancel-held-context',
      expectedRevision: retained.group.revision,
    };
    await assert.rejects(
      reader.cancel(
        h.f.context(requestFor(h, 'POST')),
        groupId,
        cancel,
        orchestration,
        dispatchLedger,
      ),
      { code: 'group_custody_unavailable' },
    );
    const cancelled = await reader.inspect(h.f.context(requestFor(h)), groupId);
    assert.equal(cancelled?.group?.cancellation, 'pending');
    assert.equal(cancelled?.authority?.cancelled, true);
    assert.deepEqual(cancelled?.authority?.invocations, originalLedger);
    assert.ok(cancelled?.group);
    await assert.rejects(
      reader.finalizeCancel(
        h.f.context(requestFor(h, 'POST')),
        groupId,
        {
          operationKey: 'finish-held-cancel',
          expectedRevision: cancelled.group.revision,
          cancelOperationKey: cancel.operationKey,
        },
        orchestration,
        dispatchLedger,
      ),
      { code: 'group_custody_unavailable' },
    );
    assert.equal(
      (await reader.inspect(h.f.context(requestFor(h)), groupId))?.group
        ?.cancellation,
      'pending',
    );
    assert.equal(modelCalls, 1);
    h.f.environment.devicePairing.revokeDevice(
      h.f.paired.device.id,
      'operator-credential',
    );
    await assert.rejects(
      reader.finalizeSync(
        h.f.context(requestFor(h, 'POST')),
        groupId,
        command,
        dispatchLedger,
      ),
    );
    assert.equal(modelCalls, 1);
  } finally {
    h.owner.close(handle);
  }
});

test('continuation turn custody refuses rebinds and retains distinct interrupt receipts for two turns on one seat', async () => {
  const h = await setup();
  const persistence = h.custodyOwners.persistence;
  const current = (): undefined => undefined;
  // Storage contract fixture only; this does not stand in for an actual Session activation.
  const intent = {
    groupId: 'binding-group',
    seatId: 'left',
    invocationId: 'sync-one',
    hostId: h.f.record.environmentId,
    principalId: 'human:local:operator',
    admissionSignature: 'a'.repeat(43),
    taskId: 'task:storage-fixture',
    clientTurnId: 'context:first',
    recipient: {
      hostId: h.f.record.environmentId,
      recipientId: 'recipient:storage-fixture',
      generation: 1,
      executionId: 'task:storage-fixture',
      sessionReceipt: {
        id: 'recipient:storage-fixture',
        domain: 'station.reserved-session.v1' as const,
        digest: `sha256:${'a'.repeat(64)}`,
      },
    },
  };
  const signed = signReportContinuationTurn(intent, h.f.environment);
  assert.equal(verifyReportContinuationTurn(signed, h.f.environment), true);
  await persistence.retainReportContinuationTurn(signed, current);
  intent.clientTurnId = 'caller-mutated';
  const returning = new StationDelegationPersistence(h.f.root);
  assert.deepEqual(
    await returning.readReportContinuationTurn(
      'binding-group',
      'sync-one',
      current,
    ),
    signed,
  );
  await returning.retainReportContinuationTurn(signed, current);
  for (const changed of [
    { ...signed.intent, clientTurnId: 'context:replacement' },
    { ...signed.intent, seatId: 'foreign-seat' },
    {
      ...signed.intent,
      recipient: { ...signed.intent.recipient, generation: 2 },
    },
  ]) {
    await assert.rejects(
      returning.retainReportContinuationTurn(
        signReportContinuationTurn(changed, h.f.environment),
        current,
      ),
      { code: 'report_continuation_turn_conflict' },
    );
  }
  assert.equal(
    await returning.readReportContinuationTurn(
      'foreign-group',
      'sync-one',
      current,
    ),
    null,
  );
  assert.equal(
    verifyReportContinuationTurn(
      { ...signed, intent: { ...signed.intent, clientTurnId: 'tampered' } },
      h.f.environment,
    ),
    false,
  );
  let issued = 0;
  for (const [clientTurnId, turnId] of [
    ['context:first', 'turn:first'],
    ['context:second', 'turn:second'],
  ]) {
    const interrupt = signReportInterrupt(
      {
        groupId: 'binding-group',
        seatId: 'left',
        operationId: 'cancel-group',
        hostId: signed.intent.hostId,
        principalId: signed.intent.principalId,
        admissionSignature: signed.intent.admissionSignature,
        taskId: signed.intent.taskId,
        sessionId: signed.intent.taskId,
        clientTurnId,
        turnId,
      },
      null,
      h.f.environment,
    );
    const issue = async () => {
      issued++;
      return signReportInterrupt(
        interrupt.intent,
        {
          outcome: 'termination-unconfirmed',
          threadId: interrupt.intent.taskId,
          turnId,
        },
        h.f.environment,
      );
    };
    const first = await returning.recordReportInterrupt(
      interrupt,
      current,
      issue,
    );
    assert.equal(first.replayed, false);
    assert.equal(
      (await returning.recordReportInterrupt(interrupt, current, issue))
        .replayed,
      true,
    );
    assert.deepEqual(
      await returning.readReportInterrupt(
        'binding-group',
        'left',
        current,
        clientTurnId,
      ),
      first.record,
    );
  }
  assert.equal(issued, 2);
  assert.deepEqual(
    await returning.readReportContinuationTurn(
      'binding-group',
      'sync-one',
      current,
    ),
    signed,
  );
});

test.each([
  'authority',
  'group-before-adoption',
  'group-after-adoption',
] as const)(
  'current-epoch report cancellation preserves original admission (%s)',
  async (operation) => {
    const h = await setup();
    const flow = await createReportFlow(h.f, 'renewal-cancellation', [
      { id: 'review' },
    ]);
    const handle = await h.owner.prepare(h.f.context(), {
      ...h.input,
      maxConcurrent: 1,
      members: h.input.members.slice(0, 1),
      flow: { runId: flow.runId, steps: { left: 'review' } },
      continuation: {
        attemptsPerMember: 1,
        maxRounds: 1,
        maxSyncs: 0,
        maxRenewals: 1,
        maxEvaluations: 0,
        maxRecoveries: 0,
      },
    });
    const forbid = (): never => {
      throw Error('Cancellation must not invoke an engine.');
    };
    const orchestration = new OrchestrationService({
      adapterRegistry: { register: forbid, get: forbid, list: () => [] },
      eventBus: new EventBus(),
      logger: { debug() {}, warn() {} },
    });
    try {
      const prepared = h.owner.read(handle, h.f.req);
      const groupId = await h.custody.retain(h.f.context(), h.owner, handle);
      const current = (): undefined => {
        h.owner.assertCurrent(handle, h.f.req);
        return undefined;
      };
      const root = {
        ...prepared.root,
        authority_epoch: prepared.root.authority_epoch + 1,
      };
      const envelopes: DelegationEnvelopeV2[] = [];
      for (const previous of prepared.envelopes) {
        const parent = envelopes.find(
          (entry) => entry.envelope_id === previous.parent?.id,
        );
        envelopes.push({
          ...structuredClone(previous),
          root_authority_ref: rootAuthorityReferenceV2(root),
          parent: parent ? delegationParentReferenceV2(parent) : null,
        });
      }
      const receipt = {
        domain: 'fixture.current-epoch-cancellation',
        id: 'renew',
        digest: `sha256:${'9'.repeat(64)}`,
      };
      // The fixture host admits a same-binding epoch; this does not qualify Station's renewal issuer.
      const service = createDelegationAuthorityServiceV3(
        h.custodyOwners.persistence.roundsAuthorityStore(current),
        {
          now: () => new Date(Date.now()).toISOString(),
          authorize: async (_action, candidate, child) =>
            canonicalJson(candidate) === canonicalJson(root)
              ? child === null ||
                envelopes.some(
                  (entry) => canonicalJson(entry) === canonicalJson(child),
                )
              : h.owner.authorizes(handle, h.f.req, candidate, child),
          confirmExecution: async (candidate, candidateRoot) =>
            canonicalJson(candidateRoot) === canonicalJson(root)
              ? envelopes.some(
                  (entry) => canonicalJson(entry) === canonicalJson(candidate),
                )
              : h.owner.confirmsExecution(handle, h.f.req, candidate),
          authenticateRenewal: async ({ command }) =>
            canonicalJson(command.root) === canonicalJson(root) &&
            canonicalJson(command.envelopes) === canonicalJson(envelopes) &&
            canonicalJson(command.hostReceipt) === canonicalJson(receipt)
              ? receipt
              : null,
        },
        { maxRenewals: 1 },
      );
      await service.issue(prepared.root);
      for (const envelope of prepared.envelopes)
        await service.derive(groupId, envelope);
      const dispatchLedger = new FileAuthorizationLedger({
        root: temporary('renewal-cancel-dispatch-'),
      });
      const controller = createDelegationRoundsController({
        store: h.custodyOwners.persistence.roundsStore(current),
        authorityService: service,
        dispatchLedger,
        cwd: h.f.repo,
        host: {
          authorize: async () => prepared.root.authenticated_principal_ref,
          executionHost: forbid,
          prepareRequest: async () => forbid(),
          retainObservation: async () => forbid(),
          confirmTerminal: async () => forbid(),
          requestDescendantCancellation: async () => forbid(),
          flow: {
            executionHost: forbid,
            confirmRetainedResult: async () => forbid(),
            retainEvaluation: async () => forbid(),
          },
        },
      });
      const created = await controller.create({
        kind: 'create',
        groupId,
        operationKey: 'create',
        expectedRevision: 0,
        controller: prepared.spec.controller,
        spec: prepared.spec,
      });
      if (operation === 'authority') {
        await service.reserveInvocation(
          groupId,
          prepared.envelopes[1].envelope_id,
          'unconfirmed-before-renewal',
          prepared.spec.seats[0].allocation,
        );
      }
      const before = await h.custody.inspect(
        h.f.context(requestFor(h)),
        groupId,
      );
      assert.ok(before?.authority);
      await service.renew({
        schemaVersion: '3.0',
        authorityId: groupId,
        operationKey: 'renew',
        expectedRevision: before.authority.revision,
        previousAuthority: rootAuthorityReferenceV2(prepared.root),
        root,
        envelopes,
        hostReceipt: receipt,
      });
      let revision = created.projection.revision;
      if (operation === 'group-after-adoption') {
        const adopted = await controller.adoptRenewal({
          kind: 'adoptRenewal',
          groupId,
          operationKey: 'adopt',
          expectedRevision: revision,
          controller: prepared.spec.controller,
          renewalOperationKey: 'renew',
          authority: rootAuthorityReferenceV2(root),
        });
        revision = adopted.projection.revision;
      }
      const context = h.f.context(requestFor(h, 'POST'));
      if (operation === 'authority') {
        await h.custody.revokeExecutionAuthority(context, groupId);
      } else {
        const cancelled = await h.custody.cancel(
          context,
          groupId,
          { operationKey: 'cancel', expectedRevision: revision },
          orchestration,
          dispatchLedger,
        );
        assert.equal(cancelled.projection.cancellation, 'requested');
      }
      const after = await h.custody.inspect(
        h.f.context(requestFor(h)),
        groupId,
      );
      assert.equal(after?.authority?.cancelled, true);
      assert.deepEqual(after?.authority?.epochs[0].root, prepared.root);
      assert.deepEqual(after?.authority?.epochs.at(-1)?.root, root);
      assert.deepEqual(after?.admission.root, prepared.root);
      assert.deepEqual(
        after?.authority?.invocations,
        before.authority.invocations,
      );
      if (operation === 'authority') {
        assert.equal(after?.authority?.invocations.length, 1);
        assert.equal(after?.authority?.invocations[0].usage, null);
        assert.equal(after?.authority?.invocations[0].terminal, false);
      }
      assert.equal(h.rawFetch.mock.calls.length, 0);
    } finally {
      h.owner.close(handle);
      await orchestration.shutdown();
    }
  },
);

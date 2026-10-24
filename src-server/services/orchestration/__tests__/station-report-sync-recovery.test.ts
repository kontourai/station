import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { FileAuthorizationLedger } from '@kontourai/dispatch';
import { flowRunHead, loadRun } from '@kontourai/flow';
import { createDelegationAuthorityServiceV3 } from '@kontourai/flow-agents/delegation-authority-service-v3';
import {
  createDelegationRoundsController,
  type DelegationRoundsExecutionHost,
  preparedRoundsSyncDigest,
} from '@kontourai/flow-agents/delegation-group-rounds';
import type { ModelRuntime } from '@kontourai/relay';
import { test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { StationDelegationPersistence } from '../delegation-group-persistence.js';
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

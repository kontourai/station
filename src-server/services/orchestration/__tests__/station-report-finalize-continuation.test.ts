import assert from 'node:assert/strict';
import fs, { readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { FileAuthorizationLedger } from '@kontourai/dispatch';
import {
  claimReadyStep,
  evaluateClaimedStep,
  flowRunHead,
  flowTransitionRef,
  loadRun,
} from '@kontourai/flow';
import { createDelegationAuthorityServiceV3 } from '@kontourai/flow-agents/delegation-authority-service-v3';
import { createDelegationRoundsController } from '@kontourai/flow-agents/delegation-group-rounds';
import {
  acquireStationHomeMaintenanceLease,
  StationHomeActiveError,
} from '@kontourai/station-shared/station-home-lifecycle';
import { test, vi } from 'vitest';
import { RuntimePublicationParticipant } from '../../../runtime/bootstrap/runtime-publication-participant.js';
import { StationRuntime } from '../../../runtime/bootstrap/station-runtime.js';
import { HomeWriterOwner } from '../../ssh/home-writer-owner.js';
import { createReportFlow } from './delegation-source-fixtures/flow.js';
import { requestFor, setup } from './delegation-source-fixtures/report.js';

test('a lost reappraisal receipt can be finalized and replayed through Station custody', async () => {
  const h = await setup();
  const flow = await createReportFlow(h.f, 'lost-reappraisal', [
    { id: 'first' },
    {
      id: 'review',
      needs: ['first'],
      requiredEvidence: true,
      routeBack: 'first',
    },
  ]);
  const handle = await h.owner.prepare(h.f.context(), {
    ...h.input,
    maxConcurrent: 1,
    budget: {
      inputTokens: 4 * 1_048_576,
      outputTokens: 40,
      costMicros: 4 * 3_145_878,
    },
    flow: { runId: flow.runId, steps: { left: 'first', right: 'review' } },
    continuation: {
      attemptsPerMember: 2,
      maxRounds: 4,
      maxSyncs: 0,
      maxRenewals: 0,
      maxEvaluations: 2,
      maxRecoveries: 2,
    },
  });
  let runtime = new StationRuntime({ projectHomeDir: h.f.home });
  let participant = Reflect.get(
    runtime,
    'runtimePublicationParticipant',
  ) as RuntimePublicationParticipant;
  try {
    const prepared = h.owner.read(handle, h.f.req);
    const groupId = await h.custody.retain(h.f.context(), h.owner, handle);
    const current = (): undefined => {
      h.owner.assertCurrent(handle, h.f.req);
      return undefined;
    };
    const persistence = h.custodyOwners.persistence;
    const authority = createDelegationAuthorityServiceV3(
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
    await authority.issue(prepared.root);
    for (const envelope of prepared.envelopes)
      await authority.derive(prepared.root.authority_id, envelope);
    const dispatch = new FileAuthorizationLedger({
      root: join(h.f.root, 'finalizer-dispatch'),
    });
    const refuse = (): never => {
      throw Error('unexpected execution');
    };
    const retentionFails = true;
    const controller = createDelegationRoundsController({
      store: persistence.roundsStore(current),
      authorityService: authority,
      dispatchLedger: dispatch,
      cwd: h.f.repo,
      host: {
        authorize: async () => prepared.root.authenticated_principal_ref,
        executionHost: refuse,
        prepareRequest: async () => refuse(),
        retainObservation: async () => refuse(),
        confirmTerminal: async () => refuse(),
        requestDescendantCancellation: async () => refuse(),
        retainContinuation: async (spec, receipt) => {
          if (retentionFails) throw Error('injected receipt retention outage');
          return persistence.retainReportContinuation(
            spec.groupId,
            receipt,
            current,
          );
        },
        flow: {
          executionHost: refuse,
          confirmRetainedResult: async () => false,
          retainEvaluation: async () => refuse(),
          acquireContinuationPublication: async () => {
            const parent = participant.acquire();
            return {
              assertCurrent: () => {
                parent.assertCurrent();
                return undefined;
              },
              flowAdmission: {
                acquire: async () => {
                  const child = parent.borrow();
                  return {
                    assertCurrent: () => {
                      child.assertCurrent();
                      return undefined;
                    },
                    release: async () => child.release(),
                  };
                },
              },
              release: async () => parent.release(),
            };
          },
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
    const actor = { key: 'fixture-evaluator', kind: 'test' };
    for (const [id, step] of [
      ['a', 'first'],
      ['b', 'review'],
      ['c', 'first'],
      ['d', 'review'],
    ]) {
      const { claim } = await claimReadyStep(flow.runId, {
        cwd: h.f.repo,
        step_id: step,
        claim_id: id,
        liveness_id: `${id}-live`,
        actor,
      });
      await evaluateClaimedStep(flow.runId, {
        cwd: h.f.repo,
        claim_id: claim.claim_id,
        liveness_id: claim.liveness_id,
        actor,
      });
    }
    const before = await loadRun(flow.runId, h.f.repo);
    const blocked = before.state.transitions.at(-1);
    assert.equal(blocked?.status, 'blocked');
    assert.equal(
      before.state.status,
      'blocked',
      JSON.stringify(before.state.transitions),
    );
    assert.equal(blocked.gate_id, 'review');
    await assert.rejects(
      controller.reappraise({
        kind: 'reappraise',
        groupId,
        operationKey: 'lost',
        expectedRevision: created.projection.revision,
        controller: prepared.spec.controller,
        checkpoint: prepared.root.revisions.policy,
        flowHead: flowRunHead(before.state),
        gate: 'review',
        blockedTransitionRef: flowTransitionRef(blocked),
      }),
      /injected receipt retention outage/,
    );
    const held = await controller.get(groupId);
    const flowAfterLoss = await loadRun(flow.runId, h.f.repo);
    const authorityBefore = await authority.inspect(prepared.root.authority_id);
    const forbiddenPreparation = [
      vi.spyOn(h.f.owner, 'prepareFlowSnapshot'),
      vi.spyOn(h.f.owner, 'prepareSdkSnapshot'),
      vi.spyOn(h.f.owner, 'readmitSnapshot'),
      vi.spyOn(h.f.owner, 'observe'),
    ];
    const retain = persistence.retainReportContinuation.bind(persistence);
    let retainedBeforeFault: Awaited<ReturnType<typeof retain>> | undefined;
    const retentionFault = vi
      .spyOn(persistence, 'retainReportContinuation')
      .mockImplementationOnce(async (...args) => {
        retainedBeforeFault = await retain(...args);
        throw new Error('injected fault after retention');
      });
    await assert.rejects(
      h.custody.finalizeContinuation(
        h.f.context(requestFor(h, 'POST')),
        groupId,
        {
          operationKey: 'finish',
          expectedRevision: held.revision,
          continuationOperationKey: 'lost',
        },
        dispatch,
        h.f.owner,
        participant,
        (historical) => historical.group,
      ),
      /injected fault after retention/,
    );
    retentionFault.mockRestore();
    assert.ok(retainedBeforeFault);
    assert.equal((await controller.get(groupId)).revision, held.revision);
    let callbackReached!: () => void, releaseCallback!: () => void;
    let durableReached!: () => void, releaseDurable!: () => void;
    const callbackReady = new Promise<void>((resolve) => {
      callbackReached = resolve;
    });
    const callbackGate = new Promise<void>((resolve) => {
      releaseCallback = resolve;
    });
    const durableReady = new Promise<void>((resolve) => {
      durableReached = resolve;
    });
    const durableGate = new Promise<void>((resolve) => {
      releaseDurable = resolve;
    });
    const originalStore = persistence.roundsStore.bind(persistence);
    let transactions = 0;
    const storeSpy = vi
      .spyOn(persistence, 'roundsStore')
      .mockImplementation((...args) => {
        const store = originalStore(...args);
        return {
          transact: async (id, body) => {
            const ordinal = ++transactions;
            const result = await store.transact(id, async (journal) => {
              const outcome = await body(journal);
              if (ordinal === 2) {
                callbackReached();
                await callbackGate;
              }
              return outcome;
            });
            if (ordinal === 2) {
              durableReached();
              await durableGate;
            }
            return result;
          },
        };
      });
    const close = vi.spyOn(
      Reflect.get(runtime, 'orchestrationEventStore'),
      'close',
    );
    const pending = h.custody.finalizeContinuation(
      h.f.context(requestFor(h, 'POST')),
      groupId,
      {
        operationKey: 'finish',
        expectedRevision: held.revision,
        continuationOperationKey: 'lost',
      },
      dispatch,
      h.f.owner,
      participant,
      (historical) => historical.group,
    );
    await callbackReady;
    const shutdown = runtime.shutdown();
    assert.throws(() => participant.acquire());
    assert.throws(
      () => acquireStationHomeMaintenanceLease(h.f.home),
      StationHomeActiveError,
    );
    assert.equal(close.mock.calls.length, 0);
    releaseCallback();
    await durableReady;
    assert.equal(close.mock.calls.length, 0);
    assert.throws(
      () => acquireStationHomeMaintenanceLease(h.f.home),
      StationHomeActiveError,
    );
    releaseDurable();
    const finalized = await pending;
    await shutdown;
    assert.equal(close.mock.calls.length, 1);
    storeSpy.mockRestore();
    runtime = new StationRuntime({ projectHomeDir: h.f.home });
    participant = Reflect.get(
      runtime,
      'runtimePublicationParticipant',
    ) as RuntimePublicationParticipant;
    assert.equal(finalized.result.replayed, false);
    assert.ok(finalized.group?.continuations[0].receipt);
    const winner = finalized.group.continuations[0].receipt.reference;
    assert.deepEqual(winner, retainedBeforeFault);
    const winnerPath = join(
      h.f.root,
      'station-report-flow-observations-v1',
      `${winner.id}.json`,
    );
    const winnerBytes = readFileSync(winnerPath);
    const replay = await h.custody.finalizeContinuation(
      h.f.context(requestFor(h, 'POST')),
      groupId,
      {
        operationKey: 'finish',
        expectedRevision: held.revision,
        continuationOperationKey: 'lost',
      },
      dispatch,
      h.f.owner,
      participant,
      (historical) => historical.group,
    );
    assert.equal(replay.result.replayed, true);
    assert.deepEqual(readFileSync(winnerPath), winnerBytes);
    assert.equal(
      flowRunHead((await loadRun(flow.runId, h.f.repo)).state),
      flowRunHead(flowAfterLoss.state),
    );
    assert.deepEqual(
      (await h.custody.inspect(h.f.context(requestFor(h)), groupId))?.authority
        ?.invocations,
      authorityBefore.invocations,
    );
    const reappraised = await loadRun(flow.runId, h.f.repo);
    const retryCheckpoint = await persistence.retainReportContext(
      groupId,
      'retry checkpoint',
      current,
    );
    const retry = {
      kind: 'authorizeRetry' as const,
      groupId,
      operationKey: 'lost-retry',
      expectedRevision: finalized.group.revision,
      controller: prepared.spec.controller,
      checkpoint: retryCheckpoint,
      flowHead: flowRunHead(reappraised.state),
      reappraisalKey: 'lost',
      request: {
        reason: 'Controlled retry authorization',
        target_step: 'first',
        blocked_transition_ref: flowTransitionRef(
          reappraised.state.transitions.at(-1),
        ),
        expected_run_head: flowRunHead(reappraised.state),
        authority: {
          kind: 'operator_request' as const,
          actor: 'fixture-operator',
          request_ref: 'fixture:retry',
          requested_at: new Date(Date.now()).toISOString(),
        },
      },
    };
    await assert.rejects(
      controller.authorizeRetry(retry),
      /injected receipt retention outage/,
    );
    const beforeCancel = await controller.get(groupId);
    await assert.rejects(
      controller.cancel({
        kind: 'cancel',
        groupId,
        operationKey: 'cancel-after-retry',
        expectedRevision: beforeCancel.revision,
        controller: prepared.spec.controller,
      }),
      /unexpected execution/,
    );
    const retryHeld = await controller.get(groupId);
    assert.equal(retryHeld.cancellation, 'pending');
    const retryFlow = await loadRun(flow.runId, h.f.repo);
    const retryCommand = {
      operationKey: 'finish-retry',
      expectedRevision: retryHeld.revision,
      continuationOperationKey: retry.operationKey,
    };
    h.owner.close(handle);
    let acquired = false;
    const acquire = HomeWriterOwner.prototype.acquire;
    const acquireSpy = vi
      .spyOn(HomeWriterOwner.prototype, 'acquire')
      .mockImplementation(async function (this: HomeWriterOwner, ...args) {
        const lease = await acquire.apply(this, args);
        acquired = true;
        return lease;
      });
    const remove = fs.rmSync;
    const releaseFault = vi
      .spyOn(fs, 'rmSync')
      .mockImplementation((path, options) => {
        if (
          acquired &&
          String(path).includes('.home-writer.mutation.guard.stale-')
        )
          throw new Error('injected home release fault');
        return remove(path, options);
      });
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        h.custody.finalizeContinuation(
          h.f.context(requestFor(h, 'POST')),
          groupId,
          retryCommand,
          dispatch,
          h.f.owner,
          participant,
          (historical) => historical.group,
        ),
        {
          code: 'rounds_continuation_publication_uncertain',
          status: 'published-cleanup-unknown',
        },
      );
      assert.throws(
        () => acquireStationHomeMaintenanceLease(h.f.home),
        StationHomeActiveError,
      );
    } finally {
      releaseFault.mockRestore();
      acquireSpy.mockRestore();
      syncBuiltinESMExports();
    }
    await runtime.shutdown();
    runtime = new StationRuntime({ projectHomeDir: h.f.home });
    participant = Reflect.get(
      runtime,
      'runtimePublicationParticipant',
    ) as RuntimePublicationParticipant;
    const retryReplay = await h.custody.finalizeContinuation(
      h.f.context(requestFor(h, 'POST')),
      groupId,
      retryCommand,
      dispatch,
      h.f.owner,
      participant,
      (historical) => historical.group,
    );
    assert.equal(retryReplay.result.replayed, true);
    for (const preparation of forbiddenPreparation)
      assert.equal(preparation.mock.calls.length, 0);
    assert.equal(
      flowRunHead((await loadRun(flow.runId, h.f.repo)).state),
      flowRunHead(retryFlow.state),
    );
    writeFileSync(winnerPath, '{}');
    try {
      await assert.rejects(
        h.custody.finalizeContinuation(
          h.f.context(requestFor(h, 'POST')),
          groupId,
          {
            operationKey: 'finish',
            expectedRevision: held.revision,
            continuationOperationKey: 'lost',
          },
          dispatch,
          h.f.owner,
          participant,
          (historical) => historical.group,
        ),
        { code: 'rounds_continuation_winner_unavailable' },
      );
    } finally {
      writeFileSync(winnerPath, winnerBytes);
    }
    const locatorPath = join(
      h.f.store,
      `snapshot-${prepared.envelopes[0].execution_binding.source.source_admission_receipt.id}.json`,
    );
    const locatorBytes = readFileSync(locatorPath);
    writeFileSync(locatorPath, '{}');
    try {
      await assert.rejects(
        h.custody.finalizeContinuation(
          h.f.context(requestFor(h, 'POST')),
          groupId,
          {
            operationKey: 'finish',
            expectedRevision: held.revision,
            continuationOperationKey: 'lost',
          },
          dispatch,
          h.f.owner,
          participant,
          (historical) => historical.group,
        ),
        { code: 'flow_location_unavailable' },
      );
      assert.deepEqual(readFileSync(winnerPath), winnerBytes);
    } finally {
      writeFileSync(locatorPath, locatorBytes);
    }
    h.f.environment.devicePairing.revokeDevice(
      h.f.paired.device.id,
      'operator-credential',
    );
    await assert.rejects(
      h.custody.finalizeContinuation(
        h.f.context(requestFor(h, 'POST')),
        groupId,
        {
          operationKey: 'finish',
          expectedRevision: held.revision,
          continuationOperationKey: 'lost',
        },
        dispatch,
        h.f.owner,
        participant,
        (historical) => historical.group,
      ),
    );
    assert.deepEqual(readFileSync(winnerPath), winnerBytes);
  } finally {
    h.owner.close(handle);
    await runtime.shutdown();
  }
}, 60_000);

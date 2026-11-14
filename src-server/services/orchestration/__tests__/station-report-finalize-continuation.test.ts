import assert from 'node:assert/strict';
import fs, { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { flowRunHead, flowTransitionRef, loadRun } from '@kontourai/flow';
import { createDelegationAuthorityServiceV3 } from '@kontourai/flow-agents/delegation-authority-service-v3';
import {
  DelegationRoundsTransactionParentError,
  type DelegationRoundsTransactionScope,
} from '@kontourai/flow-agents/delegation-group-rounds';
import { finalizeReportGroupContinuation } from '@kontourai/station-sdk/client';
import {
  acquireStationHomeMaintenanceLease,
  StationHomeActiveError,
} from '@kontourai/station-shared/station-home-lifecycle';
import { Hono } from 'hono';
import { vi } from 'vitest';
import { createReportGroupRoutes } from '../../../routes/orchestration/report-groups.js';
import { RuntimePublicationParticipant } from '../../../runtime/bootstrap/runtime-publication-participant.js';
import type { StationRuntime } from '../../../runtime/bootstrap/station-runtime.js';
import {
  bindRuntimeLocalOperator,
  getRuntimeAuthenticatedRequestPrincipal,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../../../security/runtime-request-security.js';
import { FeaturePreviewRegistry } from '../../feature-previews/feature-preview-registry.js';
import {
  HomeWriterOwner,
  HomeWriterUnavailableError,
} from '../../ssh/home-writer-owner.js';
import { StationDelegationPersistence } from '../delegation-group-persistence.js';
import { EventBus } from '../event-bus.js';
import { OrchestrationService } from '../orchestration-service.js';
import {
  type ReportRoundsScope,
  withReportRoundsPublication,
} from '../report-rounds-publication.js';
import { StationReportGroupRuntime } from '../station-report-group-runtime.js';
import {
  createFinalizerRuntime,
  setupFinalizer,
  finalizerTest as test,
} from './delegation-source-fixtures/finalizer.js';
import { requestFor, setup } from './delegation-source-fixtures/report.js';

test('a lost reappraisal receipt can be finalized and replayed through Station custody', async ({
  signal,
}) => {
  const {
    h,
    reportRoot,
    dispatch,
    prepared,
    handle,
    groupId,
    current,
    phase,
    persistence,
    controller,
    held,
    flow,
    flowAfterLoss,
    authorityBefore,
    refuse,
    setParticipant,
    runtime: initialRuntime,
    participant: initialParticipant,
  } = await setupFinalizer(signal);
  let runtime = initialRuntime;
  let participant = initialParticipant;
  try {
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
    phase('initial-finalize-with-retention-fault');
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
    phase('read-after-retention-fault');
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
    const authorityStoreSpy = vi.spyOn(persistence, 'roundsAuthorityStore');
    const physicalHome = await HomeWriterOwner.forHome(h.f.home);
    const lateGuards: Array<() => void> = [];
    let transactions = 0;
    const storeSpy = vi
      .spyOn(persistence, 'roundsStore')
      .mockImplementation((...args) => {
        const store = originalStore(...args);
        return {
          transact: async (id, body) => {
            const within = args[2];
            assert.ok(
              within,
              'actual finalizer store must bind the transaction Home lease',
            );
            const authorityWithin = authorityStoreSpy.mock.calls.find(
              (call) => call[0] === args[0],
            )?.[2];
            assert.equal(authorityWithin?.owner, within.owner);
            assert.equal(authorityWithin?.lease, within.lease);
            assert.ok(
              args[1],
              'actual finalizer must retain its independent commit guard',
            );
            lateGuards.push(args[0], args[1]);
            const ordinal = ++transactions;
            const result = await store.transact(id, async (journal) => {
              const outcome = await body(journal);
              if (ordinal === 2) {
                within.lease.assertCurrent();
                assert.throws(
                  () => physicalHome.runSynchronous(() => undefined),
                  { reason: 'busy' },
                );
                callbackReached();
                await callbackGate;
              }
              return outcome;
            });
            if (ordinal === 2) {
              within.lease.assertCurrent();
              assert.throws(
                () => physicalHome.runSynchronous(() => undefined),
                { reason: 'busy' },
              );
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
    phase('held-finalize');
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
    const earlySettlement = pending.then(
      () => {
        throw new Error(
          'Finalizer completed before its held phase was released',
        );
      },
      (error) => {
        throw error;
      },
    );
    void earlySettlement.catch(() => {});
    let shutdown: ReturnType<StationRuntime['shutdown']> | undefined;
    let finalized: Awaited<typeof pending> | undefined;
    let cleanupFailures: unknown[] = [];
    try {
      await Promise.race([callbackReady, earlySettlement]);
      phase('held-callback-ready');
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
        {
          name: 'HomeWriterUnavailableError',
          reason: 'busy',
          operationRan: false,
        },
      );
      phase('shutdown-with-held-callback');
      shutdown = runtime.shutdown();
      void shutdown.catch(() => {});
      assert.throws(() => participant.acquire());
      assert.throws(
        () => acquireStationHomeMaintenanceLease(h.f.home),
        StationHomeActiveError,
      );
      assert.equal(close.mock.calls.length, 0);
      releaseCallback();
      await Promise.race([durableReady, earlySettlement]);
      phase('held-durable-return-ready');
      assert.throws(() => physicalHome.runSynchronous(() => undefined), {
        reason: 'busy',
      });
      assert.equal(close.mock.calls.length, 0);
      assert.throws(
        () => acquireStationHomeMaintenanceLease(h.f.home),
        StationHomeActiveError,
      );
      releaseDurable();
      finalized = await pending;
      phase('held-finalize-returned');
      for (const guard of lateGuards)
        assert.throws(
          guard,
          (error) =>
            error instanceof DelegationRoundsTransactionParentError ||
            (error instanceof HomeWriterUnavailableError &&
              error.reason === 'borrow-unavailable'),
        );
      await shutdown;
      assert.equal(close.mock.calls.length, 1);
    } finally {
      releaseCallback();
      releaseDurable();
      const settled = await Promise.allSettled([
        pending,
        shutdown ?? runtime.shutdown(),
      ]);
      storeSpy.mockRestore();
      authorityStoreSpy.mockRestore();
      cleanupFailures = settled.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      );
    }
    if (cleanupFailures.length)
      throw new AggregateError(
        cleanupFailures,
        'Finalizer scenario cleanup failed',
      );
    assert.ok(finalized);
    phase('recovery-runtime');
    runtime = createFinalizerRuntime({ projectHomeDir: h.f.home }, signal);
    participant = Reflect.get(
      runtime,
      'runtimePublicationParticipant',
    ) as RuntimePublicationParticipant;
    setParticipant(participant);
    assert.equal(finalized.result.replayed, false);
    assert.ok(finalized.group?.continuations[0].receipt);
    const previews = Reflect.get(
      runtime,
      'featurePreviews',
    ) as FeaturePreviewRegistry;
    const preview = previews.bind({
      id: 'report-continuation-finalizer',
      label: 'Report continuation recovery',
      description:
        'Recover already-recorded Flow continuation metadata for a report group.',
    });
    const orchestration = new OrchestrationService({
      adapterRegistry: { register: refuse, get: refuse, list: () => [] },
      eventBus: new EventBus(),
      logger: { debug() {}, warn() {} },
    });
    const reportRuntime = new StationReportGroupRuntime({
      runtime: h.preparationOwners.runtime,
      orchestration,
      rawFetch: h.rawFetch,
      delegationAttemptClaimStore: h.delegationAttemptClaimStore,
      publicationParticipant: participant,
      continuationFinalizerPreview: preview,
    });
    const principal = getRuntimeAuthenticatedRequestPrincipal(h.f.req);
    assert.ok(principal && principal.kind !== 'internal');
    const app = new Hono();
    app.use('*', async (c, next) => {
      setRuntimeAuthenticatedRequestPrincipal(c.req.raw, principal);
      bindRuntimeLocalOperator(c.req.raw);
      await next();
    });
    app.route(
      '/api/orchestration/report-groups',
      createReportGroupRoutes(reportRuntime),
    );
    const transport = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input, init) =>
        app.fetch(new Request(input, init)),
      );
    const sdkCommand = {
      operationKey: 'finish',
      expectedRevision: held.revision,
      continuationOperationKey: 'lost',
    };
    const lookup = vi.spyOn(
      StationDelegationPersistence.prototype,
      'readReportAdmission',
    );
    await assert.rejects(
      finalizeReportGroupContinuation(
        'http://127.0.0.1:43979',
        groupId,
        sdkCommand,
      ),
      { status: 503, code: 'report_continuation_finalizer_unavailable' },
    );
    assert.equal(lookup.mock.calls.length, 0);
    lookup.mockRestore();
    await previews.setEnabled('report-continuation-finalizer', true);
    const missingOwner = new StationReportGroupRuntime({
      runtime: h.preparationOwners.runtime,
      orchestration,
      rawFetch: h.rawFetch,
      delegationAttemptClaimStore: h.delegationAttemptClaimStore,
      continuationFinalizerPreview: preview,
    });
    for (const unavailable of [missingOwner, null]) {
      const unavailableApp = new Hono();
      unavailableApp.use('*', async (c, next) => {
        setRuntimeAuthenticatedRequestPrincipal(c.req.raw, principal);
        bindRuntimeLocalOperator(c.req.raw);
        await next();
      });
      unavailableApp.route(
        '/api/orchestration/report-groups',
        createReportGroupRoutes(unavailable),
      );
      const lookupUnavailable = vi.spyOn(
        StationDelegationPersistence.prototype,
        'readReportAdmission',
      );
      const response = await unavailableApp.request(
        `http://127.0.0.1:43979/api/orchestration/report-groups/${groupId}/continuation/finalize`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(sdkCommand),
        },
      );
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        success: false,
        code: unavailable
          ? 'report_continuation_finalizer_unavailable'
          : 'report_groups_unavailable',
      });
      assert.equal(lookupUnavailable.mock.calls.length, 0);
      lookupUnavailable.mockRestore();
    }
    await assert.rejects(
      finalizeReportGroupContinuation(
        'http://127.0.0.1:43979',
        groupId,
        sdkCommand,
      ),
      { status: 503, code: 'report_continuation_finalizer_unavailable' },
    );
    const winner = finalized.group.continuations[0].receipt.reference;
    assert.deepEqual(winner, retainedBeforeFault);
    const winnerPath = join(
      reportRoot,
      'station-report-flow-observations-v1',
      `${winner.id}.json`,
    );
    const winnerBytes = readFileSync(winnerPath);
    phase('replay-finalize');
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
    phase('stale-finalize-refusal');
    await assert.rejects(
      h.custody.finalizeContinuation(
        h.f.context(requestFor(h, 'POST')),
        groupId,
        {
          operationKey: 'stale-finish',
          expectedRevision: held.revision,
          continuationOperationKey: 'lost',
        },
        dispatch,
        h.f.owner,
        participant,
        (historical) => historical.group,
      ),
      { code: 'rounds_continuation_already_completed' },
    );
    assert.deepEqual(readFileSync(winnerPath), winnerBytes);
    phase('read-after-first-finalization');
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
    phase('retry-context-retention');
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
    phase('retry-authorization-with-retention-fault');
    await assert.rejects(
      controller.authorizeRetry(retry),
      /injected receipt retention outage/,
    );
    phase('cancel-after-retry');
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
    phase('read-pending-retry');
    const retryHeld = await controller.get(groupId);
    assert.equal(retryHeld.cancellation, 'pending');
    const retryFlow = await loadRun(flow.runId, h.f.repo);
    const retryCommand = {
      operationKey: 'finish-retry',
      expectedRevision: retryHeld.revision,
      continuationOperationKey: retry.operationKey,
    };
    phase('close-original-preparation');
    h.owner.close(handle);
    await assert.rejects(
      finalizeReportGroupContinuation(
        'http://127.0.0.1:43979',
        groupId,
        retryCommand,
      ),
      { status: 503, code: 'report_continuation_finalizer_unavailable' },
    );
    transport.mockRestore();
    await orchestration.shutdown();
    let retainedForReleaseFault = false;
    const retainForReleaseFault =
      persistence.retainReportContinuation.bind(persistence);
    const retainedSpy = vi
      .spyOn(persistence, 'retainReportContinuation')
      .mockImplementation(async (...args) => {
        const result = await retainForReleaseFault(...args);
        retainedForReleaseFault = true;
        return result;
      });
    const remove = fs.rmSync;
    const releaseFault = vi
      .spyOn(fs, 'rmSync')
      .mockImplementation((path, options) => {
        if (
          retainedForReleaseFault &&
          String(path).includes('.home-writer.mutation.guard.stale-')
        )
          throw new Error('injected home release fault');
        return remove(path, options);
      });
    syncBuiltinESMExports();
    phase('retry-finalize-with-release-fault');
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
      assert.equal(retainedForReleaseFault, true);
      assert.throws(
        () => acquireStationHomeMaintenanceLease(h.f.home),
        StationHomeActiveError,
      );
    } finally {
      releaseFault.mockRestore();
      retainedSpy.mockRestore();
      syncBuiltinESMExports();
    }
    phase('retry-recovery-runtime');
    await runtime.shutdown();
    runtime = createFinalizerRuntime({ projectHomeDir: h.f.home }, signal);
    participant = Reflect.get(
      runtime,
      'runtimePublicationParticipant',
    ) as RuntimePublicationParticipant;
    setParticipant(participant);
    phase('retry-replay-finalize');
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
    phase('corrupt-winner-refusal');
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
      writeFileSync(winnerPath, winnerBytes, { mode: 0o600 });
    }
    phase('missing-winner-refusal');
    unlinkSync(winnerPath);
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
      writeFileSync(winnerPath, winnerBytes, { mode: 0o600 });
    }
    phase('corrupt-source-refusal');
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
      writeFileSync(locatorPath, locatorBytes, { mode: 0o600 });
    }
    phase('missing-source-refusal');
    unlinkSync(locatorPath);
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
    } finally {
      writeFileSync(locatorPath, locatorBytes, { mode: 0o600 });
    }
    phase('revoked-credential-refusal');
    h.f.environment.devicePairing.revokeDevice(
      h.f.paired.device.id,
      'operator-credential',
    );
    const reopenedPreviews = Reflect.get(
      runtime,
      'featurePreviews',
    ) as FeaturePreviewRegistry;
    const reopenedPreview = reopenedPreviews.bind({
      id: 'report-continuation-finalizer',
      label: 'Report continuation recovery',
      description:
        'Recover already-recorded Flow continuation metadata for a report group.',
    });
    const reopenedOwner = new StationReportGroupRuntime({
      runtime: h.preparationOwners.runtime,
      orchestration,
      rawFetch: h.rawFetch,
      delegationAttemptClaimStore: h.delegationAttemptClaimStore,
      publicationParticipant: participant,
      continuationFinalizerPreview: reopenedPreview,
    });
    const reopenedApp = new Hono();
    reopenedApp.use('*', async (c, next) => {
      setRuntimeAuthenticatedRequestPrincipal(c.req.raw, principal);
      bindRuntimeLocalOperator(c.req.raw);
      await next();
    });
    reopenedApp.route(
      '/api/orchestration/report-groups',
      createReportGroupRoutes(reopenedOwner),
    );
    const revokedLookup = vi.spyOn(
      StationDelegationPersistence.prototype,
      'readReportAdmission',
    );
    const revokedResponse = await reopenedApp.request(
      `http://127.0.0.1:43979/api/orchestration/report-groups/${groupId}/continuation/finalize`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sdkCommand),
      },
    );
    assert.equal(revokedResponse.status, 503);
    assert.deepEqual(await revokedResponse.json(), {
      success: false,
      code: 'report_continuation_finalizer_unavailable',
    });
    assert.equal(revokedLookup.mock.calls.length, 0);
    revokedLookup.mockRestore();
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
      { code: 'group_custody_unavailable' },
    );
    assert.deepEqual(readFileSync(winnerPath), winnerBytes);
    phase('scenario-complete');
  } finally {
    phase('scenario-cleanup');
    h.owner.close(handle);
    await runtime.shutdown();
  }
}, 60_000);

test('continuation publication binds exact operation parents and isolates transaction and Flow children', async ({
  signal,
}) => {
  const h = await setup('local-grant', undefined, signal);
  const runtime = createFinalizerRuntime({ projectHomeDir: h.f.home }, signal);
  const participant = Reflect.get(
    runtime,
    'runtimePublicationParticipant',
  ) as RuntimePublicationParticipant;
  const owner = await HomeWriterOwner.forHome(h.f.home);
  const current = (): undefined => undefined;
  const build = (
    scope: ReportRoundsScope,
  ): Pick<
    DelegationRoundsTransactionScope,
    'store' | 'host' | 'authorityService'
  > => ({
    store: h.custodyOwners.persistence.roundsStore(
      scope.current,
      scope.current,
      scope,
    ),
    authorityService: createDelegationAuthorityServiceV3(
      h.custodyOwners.persistence.roundsAuthorityStore(
        scope.current,
        scope.current,
        scope,
      ),
      {
        now: () => new Date().toISOString(),
        authorize: async () => false,
        confirmExecution: async () => false,
        authenticateRenewal: async () => null,
      },
      { maxRenewals: 0 },
    ),
    host: {
      authorize: async () => null,
      executionHost: () => {
        throw new Error('No execution');
      },
      prepareRequest: async () => {
        throw new Error('No preparation');
      },
      retainObservation: async () => {
        throw new Error('No observation');
      },
      confirmTerminal: async () => {
        throw new Error('No terminal');
      },
      requestDescendantCancellation: async () => {
        throw new Error('No cancellation');
      },
    },
  });
  const input = {
    participant,
    home: h.f.home,
    signal: new AbortController().signal,
  };
  try {
    await withReportRoundsPublication(input, async (publication) => {
      let preparedScope: ReportRoundsScope | undefined;
      const options = {
        owner,
        current,
        groupId: 'parent-group',
        build,
        prepare: async (scope: ReportRoundsScope) => {
          preparedScope = scope;
        },
      };
      const transactions = publication.transactionOwner(options);
      const token = await publication.acquireContinuationPublication(options);
      const request = {
        groupId: 'parent-group',
        action: 'finalizeContinuation' as const,
        command: null,
        publicationLease: token,
      };
      await assert.rejects(
        transactions.acquire({ ...request, publicationLease: { ...token } }),
        DelegationRoundsTransactionParentError,
      );
      await assert.rejects(
        transactions.acquire({ ...request, groupId: 'foreign-group' }),
        DelegationRoundsTransactionParentError,
      );
      await withReportRoundsPublication(input, async (otherPublication) => {
        await assert.rejects(
          otherPublication.transactionOwner(options).acquire(request),
          DelegationRoundsTransactionParentError,
        );
      });
      const foreignOwner = await HomeWriterOwner.forHome(h.f.home);
      await assert.rejects(
        publication
          .transactionOwner({ ...options, owner: foreignOwner })
          .acquire(request),
        DelegationRoundsTransactionParentError,
      );
      await assert.rejects(
        publication
          .transactionOwner({ ...options, current: (): undefined => undefined })
          .acquire(request),
        DelegationRoundsTransactionParentError,
      );
      const releases: Array<() => void | Promise<void>> = [];
      try {
        const first = await transactions.acquire(request);
        releases.push(first.release);
        const firstScope = preparedScope;
        assert.ok(firstScope);
        firstScope.assertLifetimeCurrent();
        const sibling = await transactions.acquire(request);
        releases.push(sibling.release);
        const flowChild = await token.flowAdmission.acquire();
        releases.push(flowChild.release);
        assert.throws(() => owner.runSynchronous(() => undefined), {
          reason: 'busy',
        });
        await assert.rejects(
          token.release(),
          DelegationRoundsTransactionParentError,
        );
        token.assertCurrent();
        first.assertCurrent();
        sibling.assertCurrent();
        await first.release();
        assert.throws(
          first.assertCurrent,
          DelegationRoundsTransactionParentError,
        );
        assert.throws(
          firstScope.assertLifetimeCurrent,
          DelegationRoundsTransactionParentError,
        );
        sibling.assertCurrent();
        flowChild.assertCurrent();
        await sibling.release();
        token.assertCurrent();
        await flowChild.release();
        assert.throws(
          flowChild.assertCurrent,
          DelegationRoundsTransactionParentError,
        );
        token.assertCurrent();
        await token.release();
        await assert.rejects(
          transactions.acquire(request),
          DelegationRoundsTransactionParentError,
        );
        assert.throws(
          token.assertCurrent,
          DelegationRoundsTransactionParentError,
        );
        owner.runSynchronous(() => undefined);
      } finally {
        for (const release of releases.reverse()) await release();
        await token.release();
      }
      const preparationError = new Error(
        'Controlled parent preparation failure',
      );
      await assert.rejects(
        publication.acquireContinuationPublication({
          ...options,
          prepare: async (scope) => {
            scope.current();
            throw preparationError;
          },
        }),
        (error) => error === preparationError,
      );
      owner.runSynchronous(() => undefined);
    });
  } finally {
    await runtime.shutdown();
  }
});

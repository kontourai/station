import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FileAuthorizationLedger } from '@kontourai/dispatch';
import { flowRunHead, loadRun } from '@kontourai/flow';
import { createDelegationAuthorityServiceV3 } from '@kontourai/flow-agents/delegation-authority-service-v3';
import { createDelegationRoundsController } from '@kontourai/flow-agents/delegation-group-rounds';
import { test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { AnthropicSealedPreparation } from '../../../runtime/conversation/anthropic-sealed-preparation.js';
import { EventBus } from '../event-bus.js';
import { OrchestrationService } from '../orchestration-service.js';
import { StationReportRetainedTurns } from '../station-report-retained-turn.js';
import { createReportFlow } from './delegation-source-fixtures/flow.js';
import { requestFor, setup } from './delegation-source-fixtures/report.js';

const temporary = trackTempDirs();

test('current report checkpoint reads authenticated source and Flow without SDK/runtime resolution or accounting changes', async () => {
  const h = await setup();
  const topology = await createReportFlow(h.f, 'checkpoint-source', [
    { id: 'review' },
  ]);
  const handle = await h.owner.prepare(h.f.context(), {
    ...h.input,
    maxConcurrent: 1,
    members: h.input.members.slice(0, 1),
    flow: { runId: topology.runId, steps: { left: 'review' } },
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
  const forbidden = (): never => {
    throw Error('Checkpoint must not resolve an execution runtime.');
  };
  const orchestration = new OrchestrationService({
    adapterRegistry: { register: forbidden, get: forbidden, list: () => [] },
    eventBus: new EventBus(),
    logger: { debug() {}, warn() {} },
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
    const controller = createDelegationRoundsController({
      store: persistence.roundsStore(current),
      authorityService: service,
      dispatchLedger: new FileAuthorizationLedger({
        root: temporary('checkpoint-dispatch-'),
      }),
      cwd: h.f.repo,
      host: {
        authorize: async () => prepared.root.authenticated_principal_ref,
        executionHost: forbidden,
        prepareRequest: async () => forbidden(),
        retainObservation: async () => forbidden(),
        confirmTerminal: async () => forbidden(),
        requestDescendantCancellation: async () => forbidden(),
        flow: {
          executionHost: forbidden,
          confirmRetainedResult: async () => forbidden(),
          retainEvaluation: async () => forbidden(),
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
    const ledger = await service.inspect(prepared.root.authority_id);
    const qualifies = vi.spyOn(AnthropicSealedPreparation, 'create');
    h.owner.close(handle);
    const turns = new StationReportRetainedTurns({
      ...h.preparationOwners,
      custody: h.custody,
      persistence,
      orchestration,
    });
    const observation = await turns.checkpoint(
      h.f.context(requestFor(h, 'POST')),
      groupId,
      'left',
      created.projection.revision,
    );
    const run = await loadRun(topology.runId, h.f.repo);
    assert.deepEqual(observation, {
      groupId,
      seatId: 'left',
      revision: created.projection.revision,
      flowHead: flowRunHead(run.state),
    });
    assert.equal(qualifies.mock.calls.length, 0);
    assert.equal(h.rawFetch.mock.calls.length, 0);
    assert.deepEqual(
      (await h.custody.inspect(h.f.context(requestFor(h)), groupId))?.authority
        ?.invocations,
      ledger.invocations,
    );
    await assert.rejects(
      turns.checkpoint(
        h.f.context(requestFor(h, 'POST')),
        groupId,
        'left',
        created.projection.revision + 1,
      ),
    );
    writeFileSync(
      join(h.f.repo, 'source.txt'),
      'source changed after checkpoint',
    );
    await assert.rejects(
      turns.checkpoint(
        h.f.context(requestFor(h, 'POST')),
        groupId,
        'left',
        created.projection.revision,
      ),
      { code: 'dirty_source_unsupported' },
    );
    assert.equal(qualifies.mock.calls.length, 0);
    assert.equal(h.rawFetch.mock.calls.length, 0);
  } finally {
    h.owner.close(handle);
    await orchestration.shutdown();
  }
});

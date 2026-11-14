import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { FileAuthorizationLedger } from '@kontourai/dispatch';
import {
  type FlowMultiCursorClaimEvent,
  loadRun,
  pauseRun,
} from '@kontourai/flow';
import { test, vi } from 'vitest';
import { createGateTestRegistry } from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { StationAgentAdapter } from '../../../providers/adapters/station-agent-adapter.js';
import { captureEnvironmentLocalGrantObservationOwner } from '../../../runtime/conversation/local-grant-observation-owner.js';
import { ApprovalRegistry } from '../../approvals/approval-registry.js';
import { StationDelegationPersistence } from '../delegation-group-persistence.js';
import { FileFinalWireIntentStore } from '../delegation-group-wire-intent-store.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';
import { PortableGroupAdmissionStore } from '../portable-group-admission-store.js';
import { PortableGroupExecution } from '../portable-group-execution.js';
import { PortableGroupPreparation } from '../portable-group-preparation.js';
import { createSessionAgentResolver } from '../session-agent-resolution.js';
import { createReportFlow } from './delegation-source-fixtures/flow.js';
import {
  installControl,
  NOW,
  requestFor,
  setup,
} from './delegation-source-fixtures/report.js';

test.each(['frontier', 'paused'] as const)(
  'V2 Flow enforces real frontier and current run: %s',
  async (mode) => {
    const wallNow = Date.now;
    const h = await setup();
    const started = wallNow();
    vi.mocked(Date.now).mockImplementation(() => NOW + wallNow() - started);
    installControl(h);
    const root = join(h.f.root, 'portable');
    const admissionsRoot = join(root, 'admissions');
    const dispatchRoot = join(root, 'dispatch');
    mkdirSync(root, { mode: 0o700 });
    mkdirSync(admissionsRoot, { mode: 0o700 });
    mkdirSync(dispatchRoot, { mode: 0o700 });
    const bus = new EventBus();
    const eventStore = new EventStore(
      join(h.f.root, 'portable-execution.sqlite'),
    );
    const logger = { debug() {}, warn() {} };
    const relay = vi.fn<typeof fetch>(async () => {
      throw Error('reserved execution must not relay');
    });
    const adapter = new StationAgentAdapter({
      apiBase: 'http://report-control.test',
      hasAgent: () => true,
      eventBus: bus,
      approvalRegistry: new ApprovalRegistry(logger, { eventBus: bus }),
      fetch: relay,
    });
    const orchestration = new OrchestrationService({
      adapterRegistry: createGateTestRegistry(adapter),
      eventBus: bus,
      eventStore,
      logger,
      resolveSessionAgent: createSessionAgentResolver({
        loadAgentSpec: (slug) => h.f.loader.loadAgent(slug),
        resolveToolServer: async () => null,
        resolveSkillDir: async () => null,
      }),
    });
    const preparation = new PortableGroupPreparation(h.preparationOwners);
    const persistence = new StationDelegationPersistence(root);
    const owners: ConstructorParameters<typeof PortableGroupExecution>[0] = {
      preparation,
      admissions: new PortableGroupAdmissionStore(admissionsRoot),
      persistence,
      dispatchLedger: new FileAuthorizationLedger({ root: dispatchRoot }),
      wireIntents: new FileFinalWireIntentStore(root),
      orchestration,
      authorize: async (context) => {
        const authority = await captureEnvironmentLocalGrantObservationOwner(
          context.req.raw,
          h.f.environment,
          h.f.environment,
        );
        const lease = authority.requireCurrentLocalGrant(context.req.raw);
        return () => {
          lease.assertCurrent();
          return undefined;
        };
      },
    };
    const owner = new PortableGroupExecution(owners);
    const flow = await createReportFlow(h.f, 'portable-flow', [
      { id: 'left' },
      { id: 'right' },
      { id: 'join', needs: ['left', 'right'] },
    ]);
    const input = {
      ...h.input,
      deadlineAt: NOW + 240_000,
      budget: {
        inputTokens: 3 * 1048576,
        outputTokens: 30,
        costMicros: 3 * 3145878,
      },
      flow,
      members: [
        ...h.input.members,
        {
          ...h.input.members[0],
          seatId: 'join',
          brief: 'Review combined findings',
        },
      ],
    };
    try {
      const created = await owner.create(h.f.context(), input);
      assert.equal(h.rawFetch.mock.calls.length, 0);
      if (mode === 'paused') {
        assert.equal(created.projection.spec.topology.kind, 'flow');
        if (created.projection.spec.topology.kind !== 'flow')
          throw Error('Flow topology missing');
        await pauseRun(flow.runId, {
          cwd: h.f.repo,
          reason: 'Pause before fresh source admission',
          authority: {
            kind: 'operator_request',
            actor: created.projection.spec.topology.actor.key,
            request_ref: 'portable-paused-control',
            requested_at: new Date(Date.now()).toISOString(),
          },
        });
        await assert.rejects(() =>
          owner.run(
            h.f.context(requestFor(h, 'POST')),
            created.projection.spec.groupId,
            'run-paused',
            created.projection.revision,
          ),
        );
        assert.equal(h.rawFetch.mock.calls.length, 0);
        return;
      }
      const result = await owner.run(
        h.f.context(requestFor(h, 'POST')),
        created.projection.spec.groupId,
        'run-flow',
        created.projection.revision,
      );
      assert.equal(result.projection.execution, 'returned');
      assert.equal(h.rawFetch.mock.calls.length, 3);
      assert.equal(relay.mock.calls.length, 0);
      const run = await loadRun(flow.runId, h.f.repo);
      assert.equal(run.state.status, 'completed');
      const history: FlowMultiCursorClaimEvent[] =
        run.state.multi_cursor.claim_history;
      const claimed = history.filter((event) => event.action === 'claimed');
      const settled = history.filter((event) => event.action === 'settled');
      assert.deepEqual(claimed.map((event) => event.step_id).sort(), [
        'join',
        'left',
        'right',
      ]);
      assert.equal(new Set(claimed.map((event) => event.claim_id)).size, 3);
      assert.deepEqual(
        settled.map((event) => event.claim_id).sort(),
        claimed.map((event) => event.claim_id).sort(),
      );
      const joinClaim = history.findIndex(
        (event) => event.action === 'claimed' && event.step_id === 'join',
      );
      for (const predecessor of ['left', 'right'])
        assert.ok(
          history.findIndex(
            (event) =>
              event.action === 'settled' && event.step_id === predecessor,
          ) < joinClaim,
        );
      assert.deepEqual(run.state.multi_cursor.active_claims, []);
    } finally {
      await orchestration.shutdown();
      eventStore.close();
    }
  },
  250_000,
);

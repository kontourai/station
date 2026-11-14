import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { FileAuthorizationLedger } from '@kontourai/dispatch';
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
import {
  installControl,
  NOW,
  requestFor,
  setup,
} from './delegation-source-fixtures/report.js';

test('V2 create and later run dispatch admitted source through real tasks and retain accounted output', async () => {
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
  try {
    // Simulate interruption after durable admission and before authority/journal publication.
    const initial = await preparation.prepare(h.f.context(), h.input);
    const admission = preparation.admission(initial, h.f.req);
    await owners.admissions.retain(
      admission.payload.spec.groupId,
      admission,
      () => undefined,
    );
    preparation.close(initial);
    const created = await owner.create(h.f.context(), h.input);
    assert.equal(created.projection.revision, 1);
    const replay = await owner.create(
      h.f.context(requestFor(h, 'POST')),
      h.input,
    );
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.projection.spec, created.projection.spec);
    const restarted = new PortableGroupExecution({
      ...owners,
      preparation: new PortableGroupPreparation(h.preparationOwners),
    });
    const afterRestart = await restarted.create(
      h.f.context(requestFor(h, 'POST')),
      h.input,
    );
    assert.equal(afterRestart.replayed, true);
    assert.deepEqual(afterRestart.projection.spec, created.projection.spec);
    await assert.rejects(() =>
      owner.create(h.f.context(requestFor(h, 'POST')), {
        ...h.input,
        maxConcurrent: 1,
      }),
    );
    assert.equal(h.rawFetch.mock.calls.length, 0);
    const result = await owner.run(
      h.f.context(requestFor(h, 'POST')),
      created.projection.spec.groupId,
      'run-1',
      created.projection.revision,
    );
    assert.equal(result.projection.execution, 'returned');
    assert.equal(result.projection.members.length, 2);
    assert.equal(h.rawFetch.mock.calls.length, 2);
    assert.ok(result.projection.members.every((member) => member.observation));
    assert.equal(relay.mock.calls.length, 0);
    // A retry arriving after admission publication joins the in-flight create.
    let release!: () => void;
    let published!: () => void;
    const publication = new Promise<void>((resolve) => {
      published = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const retain = owners.admissions.retain.bind(owners.admissions);
    vi.spyOn(owners.admissions, 'retain').mockImplementation(
      async (...args) => {
        await retain(...args);
        published();
        await hold;
      },
    );
    const secondInput = { ...h.input, operationId: 'concurrent-create' };
    const first = owner.create(h.f.context(requestFor(h, 'POST')), secondInput);
    await publication;
    const second = owner.create(
      h.f.context(requestFor(h, 'POST')),
      secondInput,
    );
    release();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.deepEqual(secondResult.projection.spec, firstResult.projection.spec);
    assert.equal(secondResult.replayed, true);
    assert.equal(h.rawFetch.mock.calls.length, 2);

    const current = (): undefined => undefined;
    const ledger = await persistence
      .authorityStore(current)
      .transact(result.projection.spec.groupId, async (value) => {
        assert.ok(value);
        return { ledger: value, result: value };
      });
    assert.equal(ledger.invocations.length, 2);
    for (const invocation of ledger.invocations) {
      assert.equal(invocation.terminal, true);
      assert.ok(invocation.usage);
      assert.deepEqual(
        {
          inputTokens: invocation.usage.inputTokens,
          outputTokens: invocation.usage.outputTokens,
        },
        { inputTokens: 4, outputTokens: 2 },
      );
      const record = await persistence.findReportObservationByInvocation(
        result.projection.spec.groupId,
        invocation.invocationId,
        'result',
        current,
      );
      assert.ok(record && record.observation.kind === 'result');
      assert.equal(record.observation.text, 'Controlled report');
      assert.equal(record.observation.costMicros, invocation.usage.costMicros);
    }
  } finally {
    eventStore.close();
  }
}, 130_000);

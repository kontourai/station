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
import {
  PortableGroupBudgetInsufficient,
  PortableGroupPreparation,
} from '../portable-group-preparation.js';
import { createSessionAgentResolver } from '../session-agent-resolution.js';
import {
  installControl,
  NOW,
  requestFor,
  setup,
} from './delegation-source-fixtures/report.js';

test('underfunded three-seat admission refuses before Task or provider effects; funded two-seat control creates', async () => {
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
  const starts = vi.spyOn(orchestration, 'startSessionInternal');
  const input = {
    ...h.input,
    operationId: 'underfunded-three',
    members: [
      ...h.input.members,
      {
        ...h.input.members[0],
        seatId: 'third',
        brief: 'Review aggregate limit',
      },
    ],
  };
  try {
    await assert.rejects(
      () => owner.create(h.f.context(), input),
      (error: unknown) =>
        error instanceof PortableGroupBudgetInsufficient &&
        error.code === 'group_budget_insufficient' &&
        error.phase === 'refused',
    );
    assert.equal(starts.mock.calls.length, 0);
    assert.equal(h.rawFetch.mock.calls.length, 0);
    assert.equal(relay.mock.calls.length, 0);
    const funded = await owner.create(h.f.context(requestFor(h, 'POST')), {
      ...h.input,
      operationId: 'funded-two',
    });
    assert.equal(funded.projection.spec.seats.length, 2);
    assert.equal(starts.mock.calls.length, 0);
    assert.equal(h.rawFetch.mock.calls.length, 0);
  } finally {
    await orchestration.shutdown();
    eventStore.close();
  }
}, 130_000);

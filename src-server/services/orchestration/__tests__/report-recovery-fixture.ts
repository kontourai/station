import assert from 'node:assert/strict';
import { join } from 'node:path';
import { onTestFinished, vi } from 'vitest';
import { createGateTestRegistry } from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { StationAgentAdapter } from '../../../providers/adapters/station-agent-adapter.js';
import { isRuntimePublicationParticipant } from '../../../runtime/bootstrap/runtime-publication-participant.js';
import { StationRuntime } from '../../../runtime/bootstrap/station-runtime.js';
import { ApprovalRegistry } from '../../approvals/approval-registry.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';
import { createSessionAgentResolver } from '../session-agent-resolution.js';
import {
  installControl,
  NOW,
  setup,
} from './delegation-source-fixtures/report.js';

export async function recoveryFixture() {
  const h = await setup();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  onTestFinished(() => {
    vi.useRealTimers();
  });
  installControl(h);
  const bus = new EventBus();
  const eventStore = new EventStore(
    join(h.f.root, 'accounting-recovery.sqlite'),
  );
  const logger = { debug() {}, warn() {} };
  const relay = vi.fn<typeof fetch>(async () => {
    throw Error('reserved request must not relay');
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
  const runtimeOwner = new StationRuntime({ projectHomeDir: h.f.home });
  const publicationParticipant = Reflect.get(
    runtimeOwner,
    'runtimePublicationParticipant',
  );
  assert.ok(isRuntimePublicationParticipant(publicationParticipant));
  const owners = {
    publicationParticipant,
    runtime: h.preparationOwners.runtime,
    orchestration,
    rawFetch: h.rawFetch,
    delegationAttemptClaimStore: h.delegationAttemptClaimStore,
  };
  return { h, adapter, orchestration, eventStore, owners, relay, runtimeOwner };
}

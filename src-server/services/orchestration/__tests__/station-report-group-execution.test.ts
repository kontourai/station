import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { FileAuthorizationLedger } from '@kontourai/dispatch';
import { test, vi } from 'vitest';
import { createGateTestRegistry } from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { StationAgentAdapter } from '../../../providers/adapters/station-agent-adapter.js';
import { AnthropicSealedPreparation } from '../../../runtime/conversation/anthropic-sealed-preparation.js';
import {
  bindRuntimeLocalOperator,
  getRuntimeAuthenticatedRequestPrincipal,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../../../security/runtime-request-security.js';
import { ApprovalRegistry } from '../../approvals/approval-registry.js';
import { FileFinalWireIntentStore } from '../delegation-group-wire-intent-store.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';
import { createSessionAgentResolver } from '../session-agent-resolution.js';
import { StationReportGroupExecution } from '../station-report-group-execution.js';
import {
  installControl,
  NOW,
  newGrant,
  requestFor,
  setup,
} from './delegation-source-fixtures/report.js';

test('report execution owner runs the issued roster through canonical tasks and actual retained tariffs, and fresh replay only reads', async () => {
  const wallNow = Date.now;
  const h = await setup();
  const startedAt = wallNow();
  vi.mocked(Date.now).mockImplementation(() => NOW + wallNow() - startedAt);
  installControl(h);
  const bus = new EventBus();
  const eventStore = new EventStore(join(h.f.root, 'report-execution.sqlite'));
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
  const dispatchRoot = join(h.f.root, 'actual-report-dispatch');
  mkdirSync(dispatchRoot, { mode: 0o700 });
  const owners = {
    preparation: h.owner,
    custody: h.custody,
    persistence: h.custodyOwners.persistence,
    orchestration,
    dispatchLedger: new FileAuthorizationLedger({ root: dispatchRoot }),
    wireIntents: new FileFinalWireIntentStore(h.f.root),
  };
  const prepares = vi.spyOn(h.owner, 'prepare');
  const abort = new AbortController();
  const stamped = requestFor(h, 'POST');
  const controlled = new Request(stamped, { signal: abort.signal });
  const principal = getRuntimeAuthenticatedRequestPrincipal(stamped);
  assert.ok(principal);
  setRuntimeAuthenticatedRequestPrincipal(controlled, principal);
  bindRuntimeLocalOperator(controlled);
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const runner = new StationReportGroupExecution(owners);
    const result = await Promise.race([
      runner.execute(h.f.context(controlled), h.input),
      new Promise<never>((_resolve, reject) => {
        watchdog = setTimeout(() => {
          const status = {
            rawCalls: h.rawFetch.mock.calls.length,
            sessions: eventStore.readSessions().map((session) => ({
              threadId: session.threadId,
              events: eventStore
                .listEvents(session.threadId)
                .map((event) => event.payload.method),
            })),
          };
          abort.abort();
          reject(Error(`report execution stalled: ${JSON.stringify(status)}`));
        }, h.input.deadlineAt - Date.now());
      }),
    ]);
    if (watchdog) clearTimeout(watchdog);
    assert.equal(result.replayed, false);
    assert.ok(result.group?.authority && result.group.group);
    assert.equal(h.rawFetch.mock.calls.length, 2);
    assert.equal(relay.mock.calls.length, 0);
    assert.equal(result.group.authority.invocations.length, 2);
    for (const invocation of result.group.authority.invocations) {
      assert.deepEqual(invocation.usage, {
        inputTokens: 4,
        outputTokens: 2,
        costMicros: 42,
      });
      assert.equal(invocation.terminal, true);
    }
    assert.equal(result.group.group.attempts.length, 2);
    assert.equal(result.group.group.acceptance, 'unassessed');
    assert.ok(
      result.group.group.attempts.every((attempt) => attempt.terminal !== null),
    );
    assert.equal(prepares.mock.calls.length, 1);
    vi.mocked(Date.now).mockReturnValue(Date.parse('2026-10-24T01:04:42Z'));
    await assert.rejects(() => AnthropicSealedPreparation.create(), {
      code: 'stale_contract',
    });
    const returning = newGrant(h);
    h.f.environment.devicePairing.revokeDevice(
      h.f.paired.device.id,
      'operator-credential',
    );
    const restarted = new StationReportGroupExecution(owners);
    const replay = await restarted.execute(
      h.f.context(requestFor(h, 'POST', returning.credential)),
      h.input,
    );
    assert.equal(prepares.mock.calls.length, 1);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.group, result.group);
    assert.equal(h.rawFetch.mock.calls.length, 2);
    await assert.rejects(
      () =>
        restarted.execute(
          h.f.context(requestFor(h, 'POST', returning.credential)),
          {
            ...h.input,
            members: h.input.members.map((member, index) =>
              index === 0
                ? { ...member, brief: 'Changed request must not reseal' }
                : member,
            ),
          },
        ),
      { code: 'group_execution_unavailable' },
    );
    assert.equal(h.rawFetch.mock.calls.length, 2);
    const groupId = result.group.admission.spec.groupId;
    const cancelCommand = {
      operationKey: 'cancel-completed',
      expectedRevision: result.group.group.revision,
    };
    const interrupt = vi.spyOn(orchestration, 'dispatchWithReceipt');
    for (const request of [
      requestFor(h, 'GET', returning.credential),
      requestFor(h, 'POST'),
    ]) {
      await assert.rejects(() =>
        h.custody.cancel(
          h.f.context(request),
          groupId,
          cancelCommand,
          orchestration,
          owners.dispatchLedger,
        ),
      );
    }
    const cancel = () =>
      h.custody.cancel(
        h.f.context(requestFor(h, 'POST', returning.credential)),
        groupId,
        cancelCommand,
        orchestration,
        owners.dispatchLedger,
      );
    const canceled = await cancel();
    assert.equal(canceled.replayed, false);
    assert.equal(canceled.projection.cancellation, 'requested');
    assert.equal(canceled.projection.acceptance, 'unassessed');
    const canceledReplay = await cancel();
    assert.equal(canceledReplay.replayed, true);
    assert.deepEqual(canceledReplay.projection, canceled.projection);
    const afterCancel = await h.custody.inspect(
      h.f.context(requestFor(h, 'GET', returning.credential)),
      groupId,
    );
    assert.equal(afterCancel?.authority?.cancelled, true);
    assert.deepEqual(
      afterCancel?.authority?.invocations,
      result.group.authority.invocations,
    );
    assert.equal(interrupt.mock.calls.length, 0);
    assert.equal(h.rawFetch.mock.calls.length, 2);
  } finally {
    if (watchdog) clearTimeout(watchdog);
    abort.abort();
    await orchestration.shutdown();
    eventStore.close();
  }
}, 150_000);

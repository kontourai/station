import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FileAuthorizationLedger } from '@kontourai/dispatch';
import { delegationAccountingDollarsV1 } from '@kontourai/flow-agents/delegation-dispatch';
import { onTestFinished, test, vi } from 'vitest';
import { createGateTestRegistry } from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { StationAgentAdapter } from '../../../providers/adapters/station-agent-adapter.js';
import { ApprovalRegistry } from '../../approvals/approval-registry.js';
import { HomeWriterUnavailableError } from '../../ssh/home-writer-owner.js';
import { StationDelegationPersistence } from '../delegation-group-persistence.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';
import { createSessionAgentResolver } from '../session-agent-resolution.js';
import { StationReportGroupRuntime } from '../station-report-group-runtime.js';
import {
  installControl,
  NOW,
  requestFor,
  setup,
} from './delegation-source-fixtures/report.js';

async function recoveryFixture() {
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
  const owners = {
    runtime: h.preparationOwners.runtime,
    orchestration,
    rawFetch: h.rawFetch,
  };
  return { h, adapter, orchestration, eventStore, owners, relay };
}

test('accounting recovery resumes a Dispatch-only commit after Session deletion without another invocation or reservation', async () => {
  const { h, adapter, orchestration, eventStore, owners, relay } =
    await recoveryFixture();
  const starts = vi.spyOn(adapter, 'startSession');
  const sends = vi.spyOn(adapter, 'sendTurn');
  const reserve = vi.spyOn(FileAuthorizationLedger.prototype, 'reserve');
  const lost = vi
    .spyOn(FileAuthorizationLedger.prototype, 'settle')
    .mockRejectedValueOnce(Error('controlled lost normal settlement'));
  const store = StationDelegationPersistence.prototype.roundsAuthorityStore;
  const publication = vi
    .spyOn(StationDelegationPersistence.prototype, 'roundsAuthorityStore')
    .mockImplementation(function (this: StationDelegationPersistence, ...args) {
      const actual = store.apply(this, args);
      return {
        transact: (id, body) =>
          actual.transact(id, async (previous) => {
            const unresolved = new Set(
              previous?.invocations
                .filter((entry) => entry.usage === null)
                .map((entry) => entry.invocationId),
            );
            const next = await body(previous);
            if (
              next.ledger.invocations.some(
                (entry) =>
                  unresolved.has(entry.invocationId) && entry.usage !== null,
              )
            )
              throw Error('controlled lost Flow reconciliation');
            return next;
          }),
      };
    });
  try {
    const runtime = new StationReportGroupRuntime(owners);
    await assert.rejects(
      runtime.create(h.f.context(), {
        ...h.input,
        maxConcurrent: 1,
        members: h.input.members.slice(0, 1),
      }),
      /rounds_terminal_accounting_required/,
    );
    const inventory = await runtime.list(h.f.context(requestFor(h)));
    assert.equal(inventory.groups.length, 1);
    const created = { group: inventory.groups[0] };
    lost.mockRestore();
    assert.equal(h.rawFetch.mock.calls.length, 1);
    assert.equal(reserve.mock.calls.length, 1);
    const member = created.group.members[0];
    const attempt = member.attempts[0];
    assert.ok(attempt);
    assert.equal(attempt.usage, null);
    const dispatch = new FileAuthorizationLedger({
      root: join(h.f.home, 'report-groups', 'dispatch'),
    });
    const reservation = reserve.mock.calls[0][0];
    const inspect = () =>
      dispatch.inspectInvocation({
        authorizationId: reservation.authorizationId,
        invocationId: reservation.invocationId,
      });
    assert.equal((await inspect())[0].state, 'reserved');
    const command = {
      operationKey: 'recover-original',
      seatId: member.seatId,
      invocationId: attempt.invocationId,
    };
    const settle = FileAuthorizationLedger.prototype.settleChecked;
    const exclusion = vi
      .spyOn(FileAuthorizationLedger.prototype, 'settleChecked')
      .mockImplementation(async function (
        this: FileAuthorizationLedger,
        input,
      ) {
        assert.throws(
          () =>
            h.f.environment.devicePairing.revokeDevice(
              h.f.paired.device.id,
              'operator-credential',
            ),
          HomeWriterUnavailableError,
        );
        return settle.call(this, input);
      });
    await assert.rejects(
      runtime.recoverAccounting(
        h.f.context(requestFor(h, 'POST')),
        created.group.groupId,
        command,
      ),
      /controlled lost Flow reconciliation/,
    );
    publication.mockRestore();
    exclusion.mockRestore();
    const partial = (await inspect())[0];
    assert.equal(partial.state, 'settled');
    assert.deepEqual(partial.usage, {
      attempts: 1,
      totalTokens: 6,
      costUsd: delegationAccountingDollarsV1(42),
    });
    eventStore.deleteThread(member.taskId);
    const returning = new StationReportGroupRuntime(owners);
    const recovered = await returning.recoverAccounting(
      h.f.context(requestFor(h, 'POST')),
      created.group.groupId,
      command,
    );
    assert.equal(recovered.recovered.replayed, true);
    assert.equal(recovered.recovered.status, 'settled');
    assert.equal(recovered.recovered.reason, 'exact-settlement');
    assert.deepEqual(recovered.group.members[0].attempts[0].usage, {
      inputTokens: 4,
      outputTokens: 2,
      costMicros: 42,
    });
    const replay = await returning.recoverAccounting(
      h.f.context(requestFor(h, 'POST')),
      created.group.groupId,
      command,
    );
    assert.equal(replay.recovered.replayed, true);
    assert.deepEqual(await inspect(), [partial]);
    assert.equal(h.rawFetch.mock.calls.length, 1);
    assert.equal(reserve.mock.calls.length, 1);
    assert.equal(starts.mock.calls.length, 1);
    assert.equal(sends.mock.calls.length, 1);
    assert.equal(relay.mock.calls.length, 0);
    const persistence = new StationDelegationPersistence(
      join(h.f.home, 'report-groups'),
    );
    const intent = await persistence.readReportAccountingRecovery(
      created.group.groupId,
      command.operationKey,
      () => undefined,
    );
    assert.ok(intent?.data.terminal);
    const intentFile = join(
      h.f.home,
      'report-groups',
      'station-report-accounting-recoveries-v1',
      `${recovered.recovered.receipt.id}.json`,
    );
    const originalIntent = readFileSync(intentFile);
    try {
      const changed = JSON.parse(originalIntent.toString('utf8'));
      changed.signature =
        (changed.signature[0] === 'A' ? 'B' : 'A') + changed.signature.slice(1);
      writeFileSync(intentFile, JSON.stringify(changed));
      await assert.rejects(
        returning.recoverAccounting(
          h.f.context(requestFor(h, 'POST')),
          created.group.groupId,
          command,
        ),
      );
    } finally {
      writeFileSync(intentFile, originalIntent);
    }
    const evidenceFile = join(
      h.f.home,
      'report-groups',
      'station-provider-evidence',
      `${intent.data.terminal.data.evidence.id}.json`,
    );
    const original = readFileSync(evidenceFile);
    try {
      const altered = JSON.parse(original.toString('utf8'));
      altered.evidence.rawResponseJson = '{}';
      writeFileSync(evidenceFile, JSON.stringify(altered));
      await assert.rejects(
        returning.recoverAccounting(
          h.f.context(requestFor(h, 'POST')),
          created.group.groupId,
          command,
        ),
      );
    } finally {
      writeFileSync(evidenceFile, original);
    }
    h.f.environment.devicePairing.revokeDevice(
      h.f.paired.device.id,
      'operator-credential',
    );
    await assert.rejects(
      returning.recoverAccounting(
        h.f.context(requestFor(h, 'POST')),
        created.group.groupId,
        command,
      ),
    );
    assert.equal(h.rawFetch.mock.calls.length, 1);
    assert.equal(reserve.mock.calls.length, 1);
  } finally {
    await orchestration.shutdown();
    eventStore.close();
  }
}, 300_000);

test('unknown physical usage stays reserved across accounting recovery and exact replay', async () => {
  const { h, owners, orchestration, eventStore } = await recoveryFixture();
  h.rawFetch.mockRejectedValueOnce(
    Error('controlled unknown physical response'),
  );
  const reserve = vi.spyOn(FileAuthorizationLedger.prototype, 'reserve');
  const settle = vi.spyOn(FileAuthorizationLedger.prototype, 'settleChecked');
  const release = vi.spyOn(FileAuthorizationLedger.prototype, 'release');
  try {
    const runtime = new StationReportGroupRuntime(owners);
    await assert.rejects(
      runtime.create(h.f.context(), {
        ...h.input,
        maxConcurrent: 1,
        members: h.input.members.slice(0, 1),
      }),
      /rounds_terminal_accounting_required/,
    );
    const inventory = await runtime.list(h.f.context(requestFor(h)));
    assert.equal(inventory.groups.length, 1);
    const group = inventory.groups[0];
    const member = group.members[0];
    const attempt = member.attempts[0];
    assert.equal(h.rawFetch.mock.calls.length, 1);
    assert.equal(reserve.mock.calls.length, 1);
    const reservation = reserve.mock.calls[0][0];
    const dispatch = new FileAuthorizationLedger({
      root: join(h.f.home, 'report-groups', 'dispatch'),
    });
    const before = await dispatch.inspectInvocation(reservation);
    assert.equal(before[0].state, 'reserved');
    const command = {
      operationKey: 'observe-unknown',
      seatId: member.seatId,
      invocationId: attempt.invocationId,
    };
    const result = await runtime.recoverAccounting(
      h.f.context(requestFor(h, 'POST')),
      group.groupId,
      command,
    );
    assert.equal(result.recovered.status, 'held');
    assert.equal(result.recovered.reason, 'usage-unknown');
    assert.equal(result.recovered.accounting, null);
    assert.equal(result.group.members[0].attempts[0].usage, null);
    assert.equal(result.group.members[0].attempts[0].accountingTerminal, false);
    assert.equal(result.group.revision, group.revision);
    const replay = await runtime.recoverAccounting(
      h.f.context(requestFor(h, 'POST')),
      group.groupId,
      command,
    );
    assert.equal(replay.recovered.replayed, true);
    assert.equal(replay.recovered.status, 'held');
    assert.deepEqual(await dispatch.inspectInvocation(reservation), before);
    assert.equal(settle.mock.calls.length, 0);
    assert.equal(release.mock.calls.length, 0);
    assert.equal(reserve.mock.calls.length, 1);
    assert.equal(h.rawFetch.mock.calls.length, 1);
  } finally {
    await orchestration.shutdown();
    eventStore.close();
  }
}, 180_000);

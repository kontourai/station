import assert from 'node:assert/strict';
import { readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FileAuthorizationLedger } from '@kontourai/dispatch';
import { flowRunHead, loadRun } from '@kontourai/flow';
import { delegationAccountingDollarsV1 } from '@kontourai/flow-agents/delegation-dispatch';
import { recoverReportGroupAccounting } from '@kontourai/station-sdk/client';
import { Hono } from 'hono';
import { onTestFinished, test, vi } from 'vitest';
import { createGateTestRegistry } from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { StationAgentAdapter } from '../../../providers/adapters/station-agent-adapter.js';
import { createReportGroupRoutes } from '../../../routes/orchestration/report-groups.js';
import { isRuntimePublicationParticipant } from '../../../runtime/bootstrap/runtime-publication-participant.js';
import { StationRuntime } from '../../../runtime/bootstrap/station-runtime.js';
import {
  bindRuntimeLocalOperator,
  getRuntimeAuthenticatedRequestPrincipal,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../../../security/runtime-request-security.js';
import { ApprovalRegistry } from '../../approvals/approval-registry.js';
import { HomeWriterUnavailableError } from '../../ssh/home-writer-owner.js';
import { StationDelegationPersistence } from '../delegation-group-persistence.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';
import { createSessionAgentResolver } from '../session-agent-resolution.js';
import { StationReportGroupRuntime } from '../station-report-group-runtime.js';
import { createReportFlow } from './delegation-source-fixtures/flow.js';
import {
  installControl,
  NOW,
  requestFor,
  setup,
} from './delegation-source-fixtures/report.js';
import { controlledTextStream } from './delegation-source-fixtures/streamed-text.js';

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
  };
  return { h, adapter, orchestration, eventStore, owners, relay, runtimeOwner };
}

test('accounting recovery refuses aborted admission and resumes a Dispatch-only commit after expiry and Session deletion without another invocation or reservation', async () => {
  const { h, adapter, orchestration, eventStore, owners, relay, runtimeOwner } =
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
    const abort = new AbortController();
    const unbound = requestFor(h, 'POST');
    const aborted = new Request(unbound, { signal: abort.signal });
    const abortedPrincipal = getRuntimeAuthenticatedRequestPrincipal(unbound);
    assert.ok(abortedPrincipal);
    setRuntimeAuthenticatedRequestPrincipal(aborted, abortedPrincipal);
    bindRuntimeLocalOperator(aborted);
    abort.abort(new Error('controlled recovery aborted before admission'));
    await assert.rejects(
      runtime.recoverAccounting(
        h.f.context(aborted),
        created.group.groupId,
        command,
      ),
      /controlled recovery aborted before admission/,
    );
    assert.equal((await inspect())[0].state, 'reserved');
    assert.equal(h.rawFetch.mock.calls.length, 1);
    assert.equal(reserve.mock.calls.length, 1);
    const wireFile = join(
      h.f.home,
      'report-groups',
      'final-wire-intents',
      'intents.json',
    );
    const originalWire = readFileSync(wireFile);
    try {
      const changed = JSON.parse(originalWire.toString('utf8'));
      changed.records[0].identity.controller.generation++;
      writeFileSync(wireFile, JSON.stringify(changed));
      await assert.rejects(
        runtime.recoverAccounting(
          h.f.context(requestFor(h, 'POST')),
          created.group.groupId,
          command,
        ),
        /report_recovery_wire_mismatch/,
      );
      assert.equal((await inspect())[0].state, 'reserved');
    } finally {
      writeFileSync(wireFile, originalWire);
    }
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
    vi.setSystemTime(h.input.deadlineAt + 1);
    eventStore.deleteThread(member.taskId);
    const returning = new StationReportGroupRuntime(owners);
    const request = requestFor(h, 'POST');
    const principal = getRuntimeAuthenticatedRequestPrincipal(request);
    assert.ok(principal && principal.kind !== 'internal');
    const app = new Hono();
    app.use('*', async (c, next) => {
      setRuntimeAuthenticatedRequestPrincipal(c.req.raw, principal);
      bindRuntimeLocalOperator(c.req.raw);
      await next();
    });
    app.route(
      '/api/orchestration/report-groups',
      createReportGroupRoutes(returning),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (url, init) =>
        app.fetch(new Request(url, init)),
      ),
    );
    const recovered = await recoverReportGroupAccounting(
      'http://recovery.test',
      created.group.groupId,
      command,
      { credential: h.f.paired.credential },
    );
    assert.deepEqual(Object.keys(recovered).sort(), [
      'accounting',
      'groupId',
      'invocationId',
      'operationKey',
      'reason',
      'receipt',
      'replayed',
      'seatId',
      'status',
    ]);

    assert.equal(recovered.replayed, true);
    assert.equal(recovered.status, 'settled');
    assert.equal(recovered.reason, 'exact-settlement');
    assert.deepEqual(recovered.accounting, {
      inputTokens: 4,
      outputTokens: 2,
      costMicros: 42,
    });
    const replay = await returning.recoverAccounting(
      h.f.context(requestFor(h, 'POST')),
      created.group.groupId,
      command,
    );
    assert.equal(replay.replayed, true);
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
      `${recovered.receipt.id}.json`,
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
    await runtimeOwner.shutdown();
  }
}, 300_000);

test.each(['exact-replay', 'shutdown-custody'] as const)(
  'unknown physical usage stays reserved during %s',
  async (mode) => {
    const { h, owners, orchestration, eventStore, runtimeOwner } =
      await recoveryFixture();
    h.rawFetch.mockRejectedValueOnce(
      Error('controlled unknown physical response'),
    );
    const reserve = vi.spyOn(FileAuthorizationLedger.prototype, 'reserve');
    const settle = vi.spyOn(FileAuthorizationLedger.prototype, 'settleChecked');
    const release = vi.spyOn(FileAuthorizationLedger.prototype, 'release');
    const ownedStore: unknown = Reflect.get(
      runtimeOwner,
      'orchestrationEventStore',
    );
    assert.ok(ownedStore instanceof EventStore);
    const close = vi.spyOn(ownedStore, 'close');
    let resumeRecovery = () => {};
    let restoreRecovery = () => {};
    let recovering:
      | ReturnType<StationReportGroupRuntime['recoverAccounting']>
      | undefined;
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
      let recoveryEntered!: () => void;
      const entered = new Promise<void>((resolve) => {
        recoveryEntered = resolve;
      });
      const resume = new Promise<void>((resolve) => {
        resumeRecovery = resolve;
      });
      if (mode === 'shutdown-custody') {
        const retain =
          StationDelegationPersistence.prototype.retainReportAccountingRecovery;
        const held = vi
          .spyOn(
            StationDelegationPersistence.prototype,
            'retainReportAccountingRecovery',
          )
          .mockImplementation(async function (
            this: StationDelegationPersistence,
            ...args
          ) {
            recoveryEntered();
            await resume;
            return retain.apply(this, args);
          });
        restoreRecovery = () => held.mockRestore();
      }
      recovering = runtime.recoverAccounting(
        h.f.context(requestFor(h, 'POST')),
        group.groupId,
        command,
      );
      void recovering.catch(() => {});
      if (mode === 'shutdown-custody') {
        await Promise.race([
          entered,
          recovering.then(() => {
            throw Error('recovery returned before intent retention');
          }),
        ]);
        try {
          await assert.rejects(
            runtimeOwner.shutdown(),
            /Runtime publication remains pending/,
          );
          assert.equal(
            close.mock.calls.length,
            0,
            'runtime storage stays open while recovery is admitted',
          );
        } finally {
          resumeRecovery();
        }
      }
      const result = await recovering;
      assert.equal(result.status, 'held');
      assert.equal(result.reason, 'usage-unknown');
      assert.equal(result.accounting, null);
      const after = await runtime.get(
        h.f.context(requestFor(h)),
        group.groupId,
      );
      assert.ok(after);
      assert.equal(after.members[0].attempts[0].usage, null);
      assert.equal(after.members[0].attempts[0].accountingTerminal, false);
      assert.equal(after.revision, group.revision);
      if (mode === 'shutdown-custody') {
        await runtimeOwner.shutdown();
        assert.equal(close.mock.calls.length, 1);
        assert.deepEqual(await dispatch.inspectInvocation(reservation), before);
        assert.equal(settle.mock.calls.length, 0);
        assert.equal(release.mock.calls.length, 0);
        assert.equal(reserve.mock.calls.length, 1);
        assert.equal(h.rawFetch.mock.calls.length, 1);
        return;
      }
      const replay = await runtime.recoverAccounting(
        h.f.context(requestFor(h, 'POST')),
        group.groupId,
        command,
      );
      assert.equal(replay.replayed, true);
      assert.equal(replay.status, 'held');
      assert.deepEqual(await dispatch.inspectInvocation(reservation), before);
      assert.equal(settle.mock.calls.length, 0);
      assert.equal(release.mock.calls.length, 0);
      assert.equal(reserve.mock.calls.length, 1);
      assert.equal(h.rawFetch.mock.calls.length, 1);
    } finally {
      resumeRecovery();
      await recovering?.catch(() => {});
      restoreRecovery();
      await orchestration.shutdown();
      eventStore.close();
      await runtimeOwner.shutdown();
    }
  },
  180_000,
);

test('a later invocation with missing turn proofs cannot acquire the original turn as its recovery witness', async () => {
  const { h, owners, orchestration, eventStore, runtimeOwner } =
    await recoveryFixture();
  h.rawFetch.mockImplementation(async (_url, options) => {
    const body = JSON.parse(String(options?.body));
    const prompt = JSON.parse(body.messages[0].content[0].text);
    const text = Object.hasOwn(prompt, 'context')
      ? prompt.brief.split('Reply exactly ')[1]
      : 'Controlled initial report';
    return controlledTextStream('anthropic', 'claude-sonnet-4-6', text, {
      input_tokens: 4,
      output_tokens: 32,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
  });
  const flow = await createReportFlow(h.f, 'recovery-continuation', [
    { id: 'left', requiredEvidence: true },
  ]);
  try {
    const runtime = new StationReportGroupRuntime(owners);
    const initial = await runtime.create(h.f.context(), {
      ...h.input,
      flow,
      maxConcurrent: 1,
      members: [{ ...h.input.members[0], maxOutputTokens: 256 }],
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
        outputTokens: 3 * 256,
        costMicros: 3 * (1_048_576 * 3 + 256 * 15),
      },
    });
    const run = await loadRun(flow.runId, h.f.repo);
    const synced = await runtime.sync(
      h.f.context(requestFor(h, 'POST')),
      initial.group.groupId,
      {
        operationKey: 'later-turn',
        expectedRevision: initial.group.revision,
        seatId: 'left',
        flowHead: flowRunHead(run.state),
        text: 'Controlled later context',
      },
    );
    const attempt = synced.group.contextSyncs?.[0].attempts?.[0];
    assert.ok(attempt?.terminal);
    const command = {
      seatId: 'left',
      invocationId: attempt.invocationId,
      operationKey: 'bound-later-proof',
    };
    const before = await runtime.recoverAccounting(
      h.f.context(requestFor(h, 'POST')),
      initial.group.groupId,
      command,
    );
    assert.equal(before.status, 'settled');
    const root = join(h.f.home, 'report-groups');
    const directory = join(root, 'station-report-continuation-turns-v1');
    const files = readdirSync(directory).filter((name) =>
      name.endsWith('.json'),
    );
    assert.equal(files.length, 1);
    const bindingFile = join(directory, files[0]);
    const ledger = JSON.parse(readFileSync(bindingFile, 'utf8'));
    assert.equal(
      ledger.entries.filter(
        (entry: { intent: { invocationId: string } }) =>
          entry.intent.invocationId === attempt.invocationId,
      ).length,
      1,
    );
    ledger.entries = ledger.entries.filter(
      (entry: { intent: { invocationId: string } }) =>
        entry.intent.invocationId !== attempt.invocationId,
    );
    writeFileSync(bindingFile, JSON.stringify(ledger));
    const retainedWitness = await runtime.recoverAccounting(
      h.f.context(requestFor(h, 'POST')),
      initial.group.groupId,
      { ...command, operationKey: 'retained-later-witness' },
    );
    assert.equal(retainedWitness.status, 'settled');
    unlinkSync(
      join(
        root,
        'station-report-observations-v1',
        `${attempt.terminal.id}.json`,
      ),
    );
    await assert.rejects(
      runtime.recoverAccounting(
        h.f.context(requestFor(h, 'POST')),
        initial.group.groupId,
        { ...command, operationKey: 'missing-later-proof' },
      ),
      /report_recovery_turn_binding_missing/,
    );
    assert.equal(h.rawFetch.mock.calls.length, 2);
  } finally {
    await orchestration.shutdown();
    eventStore.close();
    await runtimeOwner.shutdown();
  }
}, 300_000);

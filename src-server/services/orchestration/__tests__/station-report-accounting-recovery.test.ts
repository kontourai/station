import assert from 'node:assert/strict';
import fs, {
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { FileAuthorizationLedger } from '@kontourai/dispatch';
import { flowRunHead, loadRun } from '@kontourai/flow';
import { delegationAccountingDollarsV1 } from '@kontourai/flow-agents/delegation-dispatch';
import { DelegationRoundsTransactionUncertainError } from '@kontourai/flow-agents/delegation-group-rounds';
import { recoverReportGroupAccounting } from '@kontourai/station-sdk/client';
import { prepareFileMutationOwner } from '@kontourai/station-shared/lifecycle-events';
import { Hono } from 'hono';
import { test, vi } from 'vitest';
import { createReportGroupRoutes } from '../../../routes/orchestration/report-groups.js';
import {
  bindRuntimeLocalOperator,
  getRuntimeAuthenticatedRequestPrincipal,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../../../security/runtime-request-security.js';
import { HomeWriterUnavailableError } from '../../ssh/home-writer-owner.js';
import { StationDelegationPersistence } from '../delegation-group-persistence.js';
import { EventStore } from '../event-store.js';
import { StationReportGroupCustody } from '../station-report-group-custody.js';
import { StationReportGroupRuntime } from '../station-report-group-runtime.js';
import { createReportFlow } from './delegation-source-fixtures/flow.js';
import { requestFor } from './delegation-source-fixtures/report.js';
import { controlledTextStream } from './delegation-source-fixtures/streamed-text.js';
import { recoveryFixture } from './report-recovery-fixture.js';

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

test.each([
  'exact-replay',
  'shutdown-custody',
  'shutdown-tail',
  'release-failed',
  'body-and-release-failed',
] as const)(
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
    const cleanupFailure = Error('controlled recovery Home retirement failure');
    const bodyFailure = Error(
      'controlled recovery body failure after retention',
    );
    const failedRetirements: string[] = [];
    let blockRelease = false;
    const remove = fs.rmSync;
    const releaseFault = vi
      .spyOn(fs, 'rmSync')
      .mockImplementation((path, options) => {
        if (
          blockRelease &&
          String(path).startsWith(
            join(h.f.home, 'security', '.home-writer.mutation.guard.stale-'),
          )
        ) {
          failedRetirements.push(String(path));
          throw cleanupFailure;
        }
        return remove(path, options);
      });
    syncBuiltinESMExports();
    let resumeRecovery = () => {};
    let restoreRecovery = () => {};
    let closeProbe = async () => {};
    const lateChecks: Array<() => undefined> = [];
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
      const releaseFailure =
        mode === 'release-failed' || mode === 'body-and-release-failed';
      if (releaseFailure) {
        const retain =
          StationDelegationPersistence.prototype.retainReportAccountingRecovery;
        const retained = vi
          .spyOn(
            StationDelegationPersistence.prototype,
            'retainReportAccountingRecovery',
          )
          .mockImplementation(async function (
            this: StationDelegationPersistence,
            ...args
          ) {
            const result = await retain.apply(this, args);
            blockRelease = true;
            if (mode === 'body-and-release-failed') throw bodyFailure;
            return result;
          });
        restoreRecovery = () => retained.mockRestore();
      }
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
      if (mode === 'shutdown-tail') {
        const probe = await prepareFileMutationOwner(
          join(h.f.home, 'security', '.home-writer.mutation'),
        );
        closeProbe = () => probe.close();
        let trailing = false;
        const inspect = StationReportGroupCustody.prototype.inspectForMutation;
        const tail = vi
          .spyOn(StationReportGroupCustody.prototype, 'inspectForMutation')
          .mockImplementation(async function (
            this: StationReportGroupCustody,
            ...args
          ) {
            trailing = true;
            try {
              return await inspect.apply(this, args);
            } finally {
              trailing = false;
            }
          });
        const read = StationDelegationPersistence.prototype.readReportExecution;
        const hold = vi
          .spyOn(StationDelegationPersistence.prototype, 'readReportExecution')
          .mockImplementation(async function (
            this: StationDelegationPersistence,
            ...args
          ) {
            const result = await read.apply(this, args);
            if (trailing) {
              const physical = probe.tryAcquire();
              if (physical.kind === 'acquired') await physical.lease.release();
              assert.equal(
                physical.kind,
                'busy',
                'trailing recovery read must keep exact Home custody through return',
              );
              args[2]();
              lateChecks.push(args[2]);
              recoveryEntered();
              await resume;
            }
            return result;
          });
        restoreRecovery = () => {
          hold.mockRestore();
          tail.mockRestore();
        };
      }
      recovering = runtime.recoverAccounting(
        h.f.context(requestFor(h, 'POST')),
        group.groupId,
        command,
      );
      void recovering.catch(() => {});
      if (releaseFailure) {
        await assert.rejects(recovering, (error: unknown) => {
          assert.ok(error instanceof DelegationRoundsTransactionUncertainError);
          assert.equal(error.status, 'publication-unknown');
          const inner = error.errors[0];
          assert.ok(inner instanceof DelegationRoundsTransactionUncertainError);
          assert.equal(
            inner.status,
            mode === 'release-failed'
              ? 'returned-cleanup-unknown'
              : 'publication-unknown',
          );
          assert.deepEqual(
            inner.errors,
            mode === 'body-and-release-failed'
              ? [bodyFailure, cleanupFailure]
              : [cleanupFailure],
          );
          assert.deepEqual(error.errors, [inner, cleanupFailure]);
          return true;
        });
        assert.ok(
          failedRetirements.length > 0,
          'physical Home cleanup fault must fire',
        );
        const failedBeforeShutdown = failedRetirements.length;
        await assert.rejects(runtimeOwner.shutdown(), {
          code: 'runtime_publication_pending',
        });
        assert.equal(close.mock.calls.length, 0);
        assert.ok(
          failedRetirements.length > failedBeforeShutdown,
          'shutdown must retry owned cleanup',
        );
        assert.equal(
          new Set(failedRetirements).size,
          1,
          'retry must target the same guard quarantine',
        );
        blockRelease = false;
        await runtimeOwner.shutdown();
        assert.equal(close.mock.calls.length, 1);
        assert.equal(fs.existsSync(failedRetirements[0]), false);
        const probe = await prepareFileMutationOwner(
          join(h.f.home, 'security', '.home-writer.mutation'),
        );
        try {
          const physical = probe.tryAcquire();
          assert.equal(physical.kind, 'acquired');
          if (physical.kind === 'acquired') await physical.lease.release();
        } finally {
          await probe.close();
        }
        assert.deepEqual(await dispatch.inspectInvocation(reservation), before);
        assert.equal(settle.mock.calls.length, 0);
        assert.equal(release.mock.calls.length, 0);
        assert.equal(reserve.mock.calls.length, 1);
        assert.equal(h.rawFetch.mock.calls.length, 1);
        return;
      }
      if (mode !== 'exact-replay') {
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
      if (mode === 'shutdown-tail') {
        assert.equal(lateChecks.length, 1);
        for (const current of lateChecks)
          assert.throws(current, { reason: 'borrow-unavailable' });
      }
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
      if (mode !== 'exact-replay') {
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
      blockRelease = false;
      releaseFault.mockRestore();
      syncBuiltinESMExports();
      resumeRecovery();
      await recovering?.catch(() => {});
      restoreRecovery();
      await closeProbe();
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

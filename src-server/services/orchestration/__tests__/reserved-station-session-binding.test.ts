import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { StationAgentAdapter } from '../../../providers/adapters/station-agent-adapter.js';
import { reservedStationSessionRecipient } from '../../../runtime/conversation/reserved-station-turn.js';
import { StationDelegationPersistence } from '../delegation-group-persistence.js';
import { FileFinalWireIntentStore } from '../delegation-group-wire-intent-store.js';
import { installControl, setup } from './delegation-source-fixtures/report.js';
import { taskDriver } from './delegation-source-fixtures/report-task-driver.js';
import { deferred } from './delegation-source-fixtures/sdk.js';

test.each(['before-turn', 'final-fetch', 'after-response'] as const)(
  'reserved Session replacement preserves launch and evidence boundaries at %s',
  async (phase) => {
    const h = await setup();
    installControl(h);
    const handle = await h.owner.prepare(h.f.context(), {
      ...h.input,
      maxConcurrent: 1,
      members: h.input.members.slice(0, 1),
    });
    const started = deferred<{
      adapter: StationAgentAdapter;
      input: Parameters<StationAgentAdapter['startSession']>[0];
      session: Awaited<ReturnType<StationAgentAdapter['startSession']>>;
    }>();
    const release = deferred<void>();
    const consumed = deferred<void>();
    const observedResponse = deferred<void>();
    const retainEvidence =
      StationDelegationPersistence.prototype.retainProviderEvidence;
    const interceptedEvidence = vi
      .spyOn(StationDelegationPersistence.prototype, 'retainProviderEvidence')
      .mockImplementation(async function (
        this: StationDelegationPersistence,
        evidence,
        finalize,
      ) {
        if (phase === 'after-response') {
          observedResponse.resolve();
          await release.promise;
        }
        return retainEvidence.call(this, evidence, finalize);
      });
    const consume = FileFinalWireIntentStore.prototype.consume;
    const interceptedIntent = vi
      .spyOn(FileFinalWireIntentStore.prototype, 'consume')
      .mockImplementation(async function (
        this: FileFinalWireIntentStore,
        identity,
        finalize,
      ) {
        await consume.call(this, identity, finalize);
        if (phase === 'final-fetch') {
          consumed.resolve();
          await release.promise;
        }
      });
    const startSession = StationAgentAdapter.prototype.startSession;
    const intercepted = vi
      .spyOn(StationAgentAdapter.prototype, 'startSession')
      .mockImplementation(async function (this: StationAgentAdapter, input) {
        const session = await startSession.call(this, input);
        started.resolve({ adapter: this, input, session });
        if (phase === 'before-turn') await release.promise;
        return session;
      });
    const { driver } = await taskDriver(h, handle);
    const run = driver.run();
    try {
      const original = await Promise.race([
        started.promise,
        run.then(() => {
          throw new Error(
            `reserved Session start was not observed: ${String(driver.invocationFailure)}`,
          );
        }),
      ]);
      if (phase === 'final-fetch')
        await Promise.race([
          consumed.promise,
          run.then(() => {
            throw new Error(
              `final fetch intent was not observed: ${String(driver.invocationFailure)}`,
            );
          }),
        ]);
      if (phase === 'after-response')
        await Promise.race([
          observedResponse.promise,
          run.then(() => {
            throw new Error(
              `provider response was not observed: ${String(driver.invocationFailure)}`,
            );
          }),
        ]);
      assert.equal(
        h.rawFetch.mock.calls.length,
        phase === 'after-response' ? 1 : 0,
      );
      const replacement = await startSession.call(original.adapter, {
        ...original.input,
        resumeCursor: structuredClone(original.session.resumeCursor),
      });
      assert.equal(replacement.threadId, original.session.threadId);
      assert.deepEqual(replacement.resumeCursor, original.session.resumeCursor);
      release.resolve();
      await run;
      const ledger = await driver.ledger();
      assert.equal(ledger.invocations.length, 1);
      if (phase === 'after-response') {
        assert.equal(h.rawFetch.mock.calls.length, 1);
        const retained = await driver.readReservedResult();
        assert.equal(retained.sdkResult.text, 'Controlled report');
        assert.deepEqual(retained.accounting, {
          inputTokens: 4,
          outputTokens: 2,
          costMicros: 42,
          costBasis: 'tariff-upper-bound',
        });
        assert.equal(driver.retainedEvidence().usage.costMicros, 42);
        assert.equal(
          driver
            .canonicalEvents()
            .some((event) => event.method === 'turn.completed'),
          false,
        );
        assert.equal(ledger.invocations[0].usage, null);
        assert.equal(ledger.invocations[0].terminal, false);
      } else {
        assert.equal(
          h.rawFetch.mock.calls.length,
          0,
          'a matching string cannot authorize a replacement adapter Session',
        );
        assert.ok(driver.invocationFailure);
        assert.equal(ledger.invocations[0].usage, null);
        assert.equal(ledger.invocations[0].terminal, false);
      }
      assert.equal(driver.intentCount, phase === 'before-turn' ? 0 : 1);
    } finally {
      release.resolve();
      intercepted.mockRestore();
      interceptedIntent.mockRestore();
      interceptedEvidence.mockRestore();
      await run.catch(() => {});
      h.owner.close(handle);
    }
  },
  60000,
);

test.each(['replace-session', 'close-source'] as const)(
  'reserved Session capability keeps physical observation separate from %s',
  async (control) => {
    const h = await setup();
    installControl(h);
    const handle = await h.owner.prepare(h.f.context(), {
      ...h.input,
      maxConcurrent: 1,
      members: h.input.members.slice(0, 1),
    });
    const startSession = StationAgentAdapter.prototype.startSession;
    let original:
      | {
          adapter: StationAgentAdapter;
          input: Parameters<StationAgentAdapter['startSession']>[0];
          session: Awaited<ReturnType<StationAgentAdapter['startSession']>>;
        }
      | undefined;
    vi.spyOn(StationAgentAdapter.prototype, 'startSession').mockImplementation(
      async function (this: StationAgentAdapter, input) {
        const session = await startSession.call(this, input);
        original = { adapter: this, input, session };
        return session;
      },
    );
    const { driver, prepared } = await taskDriver(h, handle);
    try {
      await driver.run();
      assert.equal(h.rawFetch.mock.calls.length, 1);
      assert.equal(driver.invocationFailure, undefined);
      const expected = {
        principalId: prepared.root.authenticated_principal_ref.id,
        environmentId: prepared.root.issuer_host_id,
        threadId: prepared.members[0].taskId,
      };
      const capture = () =>
        driver.orchestration.captureReservedStationSession(expected.threadId, {
          userId: expected.principalId,
        });
      const session = capture();
      assert.throws(() =>
        driver.orchestration.captureReservedStationSession(expected.threadId, {
          userId: 'foreign-owner',
        }),
      );
      assert.throws(() =>
        reservedStationSessionRecipient(session, {
          ...expected,
          principalId: 'foreign-owner',
        }),
      );
      assert.throws(() =>
        Reflect.apply(reservedStationSessionRecipient, undefined, [
          {},
          expected,
        ]),
      );
      const recipient = driver.recipient();
      assert.deepEqual(
        reservedStationSessionRecipient(session, expected),
        recipient,
      );
      assert.equal(recipient.hostId, prepared.root.issuer_host_id);
      assert.equal(recipient.executionId, prepared.members[0].taskId);
      assert.deepEqual(driver.recipient(), recipient);
      const driverRecipientId = recipient.recipientId;
      Object.assign(recipient, { recipientId: 'forged' });
      assert.notEqual(driver.recipient().recipientId, 'forged');
      if (control === 'replace-session') {
        assert.ok(original);
        await startSession.call(original.adapter, {
          ...original.input,
          resumeCursor: structuredClone(original.session.resumeCursor),
        });
        assert.throws(
          () => driver.recipient(),
          /Reserved Station turn is unavailable/,
        );
        assert.throws(() => capture());
        assert.throws(() => reservedStationSessionRecipient(session, expected));
      } else {
        h.owner.close(handle);
        assert.equal(capture(), session);
        assert.equal(
          reservedStationSessionRecipient(session, expected).recipientId,
          driverRecipientId,
        );
        await assert.rejects(driver.repeatTaskDispatch());
      }
      if (control === 'replace-session') {
        const retained = await driver.readReservedResult();
        assert.equal(retained.accounting.costMicros, 42);
      }
      assert.equal(h.rawFetch.mock.calls.length, 1);
    } finally {
      h.owner.close(handle);
    }
  },
  60000,
);

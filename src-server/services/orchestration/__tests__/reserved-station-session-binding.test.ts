import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { StationAgentAdapter } from '../../../providers/adapters/station-agent-adapter.js';
import { FileFinalWireIntentStore } from '../delegation-group-wire-intent-store.js';
import { taskDriver } from './delegation-source-fixtures/report-task-driver.js';
import { installControl, setup } from './delegation-source-fixtures/report.js';
import { deferred } from './delegation-source-fixtures/sdk.js';

test.each(['before-turn', 'final-fetch'] as const)(
  'reserved report refuses a replacement adapter Session with a matching identity at %s',
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
      assert.equal(h.rawFetch.mock.calls.length, 0);
      const replacement = await startSession.call(original.adapter, {
        ...original.input,
        resumeCursor: structuredClone(original.session.resumeCursor),
      });
      assert.equal(replacement.threadId, original.session.threadId);
      assert.deepEqual(replacement.resumeCursor, original.session.resumeCursor);
      release.resolve();
      await run;
      assert.equal(
        h.rawFetch.mock.calls.length,
        0,
        'a matching string cannot authorize a replacement physical Session',
      );
      assert.ok(driver.invocationFailure);
      assert.equal(driver.intentCount, phase === 'final-fetch' ? 1 : 0);
      const ledger = await driver.ledger();
      assert.equal(ledger.invocations.length, 1);
      assert.equal(ledger.invocations[0].usage, null);
      assert.equal(ledger.invocations[0].terminal, false);
    } finally {
      release.resolve();
      intercepted.mockRestore();
      interceptedIntent.mockRestore();
      await run.catch(() => {});
      h.owner.close(handle);
    }
  },
  60000,
);

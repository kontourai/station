import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { DelegationRoundsTransactionUncertainError } from '@kontourai/flow-agents/delegation-group-rounds';
import { prepareFileMutationOwner } from '@kontourai/station-shared/lifecycle-events';
import { onTestFinished, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { isRuntimePublicationParticipant } from '../../../runtime/bootstrap/runtime-publication-participant.js';
import { StationRuntime } from '../../../runtime/bootstrap/station-runtime.js';
import { HomeWriterOwner } from '../../ssh/home-writer-owner.js';
import { withReportRoundsPublication } from '../report-rounds-publication.js';

const makeTempDir = trackTempDirs();

test('publication synchronous checks hold Home, refuse queued withdrawal and fence their return', async () => {
  const home = makeTempDir('report-publication-check-');
  const runtime = new StationRuntime({ projectHomeDir: home });
  onTestFinished(async () => {
    await runtime.shutdown();
  });
  const participant = Reflect.get(runtime, 'runtimePublicationParticipant');
  assert.ok(isRuntimePublicationParticipant(participant));
  const owner = await HomeWriterOwner.forHome(home);
  const physical = await prepareFileMutationOwner(
    join(home, 'security', '.home-writer.mutation'),
  );
  const failure = new Error('controlled source withdrawal');
  let withdrawn = false;
  const checks: string[] = [];
  const current = (): undefined => {
    checks.push('current');
    if (withdrawn) throw failure;
    return undefined;
  };
  await withReportRoundsPublication(
    { participant, home, signal: new AbortController().signal },
    async (publication) => {
      const value = await publication.check({ owner, current }, () => {
        const probe = physical.tryAcquire();
        if (probe.kind === 'acquired') probe.lease.tryRelease();
        assert.equal(probe.kind, 'busy');
        return 42;
      });
      assert.equal(value, 42);
      const open = fs.openSync;
      let inspections = 0;
      const observe = vi
        .spyOn(fs, 'openSync')
        .mockImplementation((path, flags, mode) => {
          if (
            String(path) ===
            join(owner.homeDir, 'security', '.home-writer.mutation')
          )
            inspections++;
          return open(path, flags, mode);
        });
      syncBuiltinESMExports();
      try {
        await publication.withHome({ owner, current }, async (scope) => {
          checks.length = 0;
          inspections = 0;
          const result = {
            get then() {
              checks.push('inspect-result');
              return undefined;
            },
          };
          assert.equal(
            scope.check(() => {
              checks.push('body');
              return result;
            }),
            result,
          );
          assert.deepEqual(checks, [
            'current',
            'body',
            'inspect-result',
            'current',
          ]);
          assert.ok(
            inspections > 0,
            'the real Home descriptor observer must run',
          );
          assert.ok(
            inspections <= 5,
            `one synchronous publication check inspected Home ${inspections} times; maximum 5`,
          );
          assert.throws(
            () =>
              scope.check(() => {
                withdrawn = true;
                return 'must not escape';
              }),
            (error) => error === failure,
          );
          withdrawn = false;
          assert.throws(() => scope.check(async () => 42), TypeError);
        });
      } finally {
        observe.mockRestore();
        syncBuiltinESMExports();
      }
      const released = physical.tryAcquire();
      assert.equal(released.kind, 'acquired');
      if (released.kind === 'acquired') await released.lease.release();
      const held = await owner.acquire();
      let entered = false;
      const queued = publication.check({ owner, current }, () => {
        entered = true;
      });
      withdrawn = true;
      await held.release();
      await assert.rejects(queued, (error) => error === failure);
      assert.equal(entered, false);
      withdrawn = false;
      await assert.rejects(
        publication.check({ owner, current }, () => {
          withdrawn = true;
          return 'must not escape';
        }),
        (error: unknown) =>
          error instanceof DelegationRoundsTransactionUncertainError &&
          error.status === 'returned-cleanup-unknown' &&
          error.errors[0] === failure,
      );
      withdrawn = false;
      await assert.rejects(
        publication.check({ owner, current }, async () => 42),
      );
    },
  );
  await owner.runRequest(new AbortController().signal, () => undefined);
});

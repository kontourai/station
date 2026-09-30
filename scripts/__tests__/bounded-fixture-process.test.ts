import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  FIXTURE_TEST_TIMEOUT_MS,
  runBoundedFixture,
} from './helpers/bounded-fixture-process.mjs';

// The release fixture runner shared by the mobile-feed transaction and release
// workflow suites. Its fail-closed paths are owned here so those suites cover
// only the shell transactions they drive.
const makeTempDir = trackTempDirs();

describe('runBoundedFixture', () => {
  test('fails closed when a fixture command cannot launch', async () => {
    await expect(
      runBoundedFixture('/definitely/not/a/fixture-command', []),
    ).rejects.toMatchObject({ code: 'ENOENT', status: null });
  });

  test('fails closed when bounded fixture output is truncated', async () => {
    await expect(
      runBoundedFixture('bash', ['-c', "printf 'overflow'"], {
        maxOutputBytes: 4,
      }),
    ).rejects.toThrow('fixture process output was truncated');
  });

  test.runIf(process.platform !== 'win32')(
    'rejects a hung root process at its deadline',
    async () => {
      await expect(
        runBoundedFixture('bash', ['-c', 'exec sleep 60'], {
          timeoutMs: 250,
        }),
      ).rejects.toMatchObject({ code: 'ETIMEDOUT', status: null });
    },
    FIXTURE_TEST_TIMEOUT_MS,
  );

  test.runIf(process.platform !== 'win32')(
    'reaps a timed-out fixture descendant process group',
    async () => {
      const root = makeTempDir('station-fixture-descendant-');
      const childPidPath = join(root, 'child.pid');
      const result = await runBoundedFixture(
        'bash',
        [
          '-c',
          `sleep 60 </dev/null >/dev/null 2>&1 & echo $! > ${JSON.stringify(childPidPath)}; wait`,
        ],
        { allowTimeoutResult: true, timeoutMs: 250 },
      );
      const childPid = Number(readFileSync(childPidPath, 'utf8').trim());
      expect(Number.isSafeInteger(childPid)).toBe(true);
      expect((result.error as NodeJS.ErrnoException | undefined)?.code).toBe(
        'ETIMEDOUT',
      );
      expect(result.status).toBeNull();
      expect(() => process.kill(childPid, 0)).toThrow();
    },
    FIXTURE_TEST_TIMEOUT_MS,
  );
});

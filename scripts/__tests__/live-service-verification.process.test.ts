import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { spawnSyncBounded } from '../lib/bounded-capture.mjs';
import { CI_FAST_INFRASTRUCTURE_EXIT_CODE } from '../run-ci-fast.mjs';

const root = resolve(import.meta.dirname, '../..');
const tempDir = trackTempDirs();
const entrypoints = ['run-ci-fast.mjs', 'typecheck-aggregate.mjs'];

function run(script: string, membership: string | null) {
  const dir = tempDir('station-live-verification-');
  const marker = join(dir, 'subprocess-started');
  const preload = join(dir, 'membership.mjs');
  writeFileSync(
    preload,
    `import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const read = fs.readFileSync;
fs.readFileSync = function(file, ...args) {
  if (file === '/proc/self/cgroup') {
    const membership = ${JSON.stringify(membership)};
    if (membership === null) throw new Error('cgroup membership unavailable');
    return membership;
  }
  return read.call(this, file, ...args);
};
function reachedSubprocess() {
  fs.writeFileSync(${JSON.stringify(marker)}, 'started');
  throw new Error('subprocess admission probe');
}
childProcess.spawn = reachedSubprocess;
childProcess.spawnSync = reachedSubprocess;
syncBuiltinESMExports();
`,
  );
  const result = spawnSyncBounded(
    process.execPath,
    ['--import', preload, join(root, 'scripts', script)],
    { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 15_000 },
  );
  return { result, started: existsSync(marker) };
}

describe.skipIf(process.platform !== 'linux')(
  'live Station verification admission',
  () => {
    test.each(entrypoints)(
      '%s refuses a live Station service before launching work',
      (script) => {
        const { result, started } = run(
          script,
          '0::/user.slice/user-1002.slice/user@1002.service/app.slice/station-default.service\n',
        );
        expect(result.status).toBe(
          script === 'run-ci-fast.mjs' ? CI_FAST_INFRASTRUCTURE_EXIT_CODE : 1,
        );
        expect(result.stderr).toContain(
          'live Station service station-default.service',
        );
        expect(started).toBe(false);
      },
    );

    test.each(entrypoints)(
      '%s also refuses a non-default Station instance',
      (script) => {
        const { result, started } = run(
          script,
          '0::/user.slice/user-1002.slice/user@1002.service/app.slice/station-dogfood.service/agent\n',
        );
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          'live Station service station-dogfood.service',
        );
        expect(started).toBe(false);
      },
    );

    test.each(entrypoints)(
      '%s admits a hosted runner to its first subprocess',
      (script) => {
        const { result, started } = run(
          script,
          '0::/system.slice/actions.runner.station.service\n',
        );
        expect(started, result.stderr).toBe(true);
        expect(result.stderr).not.toContain('live Station service');
      },
    );

    test.each(entrypoints)(
      '%s refuses work when cgroup membership cannot be read',
      (script) => {
        const { result, started } = run(script, null);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('cgroup membership unavailable');
        expect(started).toBe(false);
      },
    );
  },
);

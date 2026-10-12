/**
 * Real-runner process-tree kill test (archive#583 review finding, HIGH): the
 * default CLI runner must terminate the WHOLE process tree on timeout, not
 * just the immediate Node wrapper — `pull-work-provider` synchronously
 * spawns `gh`, and killing only the wrapper would orphan it, holding the
 * inherited stdio pipes open and starving the wrapper's own 'close' event
 * (the timeout would appear to do nothing).
 *
 * This test spawns a REAL child process (no `runCli` injection) whose
 * script itself spawns a sleeping grandchild that inherits the wrapper's
 * stdio, and whose own SIGTERM handler is a no-op — forcing the runner to
 * escalate from SIGTERM to SIGKILL to reap it. Skipped on win32 (this repo
 * has no CI runner to exercise the taskkill path; the POSIX process-group
 * path is exercised here).
 */
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { createDefaultFlowAgentsCliRunner } from '../work-item-providers/flow-agents-work-item-provider.js';

const tmpDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A script that: (1) spawns a long-sleeping grandchild that INHERITS this
 * process's stdio (simulating `gh` inheriting `pull-work-provider`'s pipes),
 * (2) records both pids to a file so the test can verify termination, and
 * (3) ignores SIGTERM on itself, forcing the runner's SIGKILL escalation. */
const HANG_WITH_CHILD_SCRIPT = `
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');

process.on('SIGTERM', () => { /* ignore — forces SIGKILL escalation */ });

const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
  stdio: 'inherit',
});

writeFileSync(process.argv[2], JSON.stringify({ parentPid: process.pid, childPid: child.pid }));

setInterval(() => {}, 1000);
`;

describe.skipIf(process.platform === 'win32')(
  'createDefaultFlowAgentsCliRunner (real process-tree kill)',
  () => {
    test('terminates the whole process tree on timeout and settles the promise within bound', async () => {
      const dir = makeTempDir('flow-agents-hang-');
      const scriptPath = join(dir, 'hang-with-child.cjs');
      const pidFilePath = join(dir, 'pids.json');
      writeFileSync(scriptPath, HANG_WITH_CHILD_SCRIPT);

      const runner = createDefaultFlowAgentsCliRunner({
        killGracePeriodMs: 300,
        hardDeadlineSlackMs: 200,
      });

      const startedAt = Date.now();
      const result = await runner(scriptPath, [pidFilePath], {
        cwd: dir,
        timeoutMs: 500,
      });
      const elapsedMs = Date.now() - startedAt;

      // Bound: soft timeout (500) + kill grace (300) + hard-deadline slack
      // (200) = 1000ms, plus generous headroom for process spawn/reap
      // overhead under CI load.
      expect(elapsedMs).toBeLessThan(5_000);
      expect(result.exitCode).toBeNull();
      expect(result.stderr).toMatch(/timed out after 500ms/);

      expect(existsSync(pidFilePath)).toBe(true);
      const { parentPid, childPid } = JSON.parse(
        readFileSync(pidFilePath, 'utf-8'),
      ) as { parentPid: number; childPid: number };

      expect(isAlive(parentPid)).toBe(false);
      expect(isAlive(childPid)).toBe(false);
    }, 15_000);
  },
);

/**
 * #776: a CLI that exits before reading its input leaves the runner writing
 * into a pipe with no reader. The write fails with EPIPE on the stdin stream,
 * which the ChildProcess 'error' listener never sees; unlistened, it is an
 * uncaught exception that ends the server. The 4 MiB input outlasts any pipe
 * buffer, so part of it is still queued when the child is gone.
 */
describe.skipIf(process.platform === 'win32')(
  'createDefaultFlowAgentsCliRunner (child exits before reading stdin)',
  () => {
    test('settles with the child exit code and lets no stdin EPIPE escape', async () => {
      const dir = makeTempDir('flow-agents-epipe-');
      const scriptPath = join(dir, 'exit-early.cjs');
      writeFileSync(scriptPath, 'process.exit(3);\n');

      const escaped: unknown[] = [];
      const onUncaught = (error: unknown) => escaped.push(error);
      process.on('uncaughtException', onUncaught);
      try {
        const result = await createDefaultFlowAgentsCliRunner()(
          scriptPath,
          [],
          { cwd: dir, input: 'x'.repeat(4 * 1024 * 1024), timeoutMs: 10_000 },
        );
        expect(result.exitCode).toBe(3);
        // Let a late stream error land before asserting none escaped.
        await new Promise((resolve) => setTimeout(resolve, 100));
      } finally {
        process.off('uncaughtException', onUncaught);
      }
      expect(escaped).toEqual([]);
    }, 15_000);
  },
);

/**
 * #561: the CLI child is detached so a timeout can kill its whole tree, but
 * that timeout lives in this process. A SIGKILLed Station used to leave the
 * child running with no registry record for the startup sweep. The stub CLI
 * starts a grandchild in its group and exits on request, leaving the
 * grandchild behind; both are killed by exact pid in afterEach.
 */
const OWNED_STUB_SCRIPT = `
const { spawn } = require('node:child_process');
const { existsSync, renameSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const dir = process.argv[2];
// Bounded, so a cleanup that never ran leaks nothing for long.
const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
// Renamed into place, so the test never reads a half-written file.
writeFileSync(join(dir, 'pids.tmp'), JSON.stringify({ leaderPid: process.pid, grandchildPid: grandchild.pid }));
renameSync(join(dir, 'pids.tmp'), join(dir, 'pids.json'));
const deadline = Date.now() + 60000;
const poll = setInterval(() => {
  if (existsSync(join(dir, 'release')) || Date.now() > deadline) { clearInterval(poll); process.exit(0); }
}, 20);
`;

/**
 * Only a positive pid other than 1 and this process names one process.
 * `process.kill(0, …)` signals this runner's whole process group, so a pid
 * misread as 0 would kill an attached CI shell and hide the failure.
 */
function isSignalablePid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 1 && pid !== process.pid;
}

describe.skipIf(process.platform === 'win32')(
  'createDefaultFlowAgentsCliRunner (owned-process registration, #561)',
  () => {
    const makeTrackedDir = trackTempDirs();
    let registryDir: string;
    const pids: number[] = [];

    beforeEach(() => {
      registryDir = makeTrackedDir('station-flow-agents-owned-registry-');
      vi.stubEnv('STATION_OWNED_PROCESS_REGISTRY', registryDir);
    });

    afterEach(async () => {
      for (const pid of pids.splice(0)) {
        if (!isSignalablePid(pid)) continue;
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
        for (let i = 0; i < 200 && isAlive(pid); i++) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      vi.unstubAllEnvs();
    });

    async function waitUntil(check: () => boolean, ms = 5_000) {
      const deadline = Date.now() + ms;
      while (!check() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return check();
    }

    function groupAlive(pgid: number): boolean {
      try {
        process.kill(-pgid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
      }
    }

    test('a registry write that fails does not block the spawn', async () => {
      // A trusted (0700) directory made read-only: the record write throws
      // EACCES after the child is spawned. The CLI must still run and settle.
      const dir = makeTrackedDir('flow-agents-owned-readonly-');
      const scriptPath = join(dir, 'echo.cjs');
      writeFileSync(scriptPath, "process.stdout.write('ran');\n");
      chmodSync(registryDir, 0o500);
      try {
        const result = await createDefaultFlowAgentsCliRunner()(
          scriptPath,
          [],
          { cwd: dir, timeoutMs: 10_000 },
        );
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe('ran');
      } finally {
        chmodSync(registryDir, 0o700);
      }
    }, 15_000);

    test('a record that cannot be removed after the group exits does not throw out of the release', async () => {
      // The release runs from an 'exit' listener or a timer, where a throw is
      // an uncaught exception that ends the server. Make the record
      // unremovable (read-only registry) while the CLI runs.
      const dir = makeTrackedDir('flow-agents-owned-unremovable-');
      const scriptPath = join(dir, 'wait.cjs');
      writeFileSync(
        scriptPath,
        [
          "const { existsSync } = require('node:fs');",
          "const release = require('node:path').join(process.argv[2], 'release');",
          'const deadline = Date.now() + 60000;',
          'const poll = setInterval(() => {',
          '  if (existsSync(release) || Date.now() > deadline) { clearInterval(poll); process.exit(0); }',
          '}, 20);',
        ].join('\n'),
      );
      const escaped: unknown[] = [];
      const onUncaught = (error: unknown) => escaped.push(error);
      process.on('uncaughtException', onUncaught);
      try {
        const running = createDefaultFlowAgentsCliRunner()(scriptPath, [dir], {
          cwd: dir,
          timeoutMs: 10_000,
        });
        expect(
          await waitUntil(() =>
            readdirSync(registryDir).some((name) => name.startsWith('engine-')),
          ),
        ).toBe(true);
        const [recordName] = readdirSync(registryDir);
        pids.push(Number(/engine-(\d+)\.json/.exec(recordName)?.[1]));
        chmodSync(registryDir, 0o500);
        writeFileSync(join(dir, 'release'), '');
        expect((await running).exitCode).toBe(0);
        // Let the group-exit release poll run and fail.
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(existsSync(join(registryDir, recordName))).toBe(true);
      } finally {
        process.off('uncaughtException', onUncaught);
        chmodSync(registryDir, 0o700);
      }
      expect(escaped).toEqual([]);
    }, 15_000);

    test('a running CLI child is registered, and the record is released only after its whole group exits', async () => {
      const dir = makeTrackedDir('flow-agents-owned-');
      const scriptPath = join(dir, 'owned-stub.cjs');
      writeFileSync(scriptPath, OWNED_STUB_SCRIPT);

      const running = createDefaultFlowAgentsCliRunner()(scriptPath, [dir], {
        cwd: dir,
        timeoutMs: 30_000,
      });
      const pidFile = join(dir, 'pids.json');
      expect(await waitUntil(() => existsSync(pidFile))).toBe(true);
      const { leaderPid, grandchildPid } = JSON.parse(
        readFileSync(pidFile, 'utf8'),
      ) as { leaderPid: number; grandchildPid: number };
      pids.push(grandchildPid, leaderPid);
      expect(isSignalablePid(leaderPid)).toBe(true);
      expect(isSignalablePid(grandchildPid)).toBe(true);

      // While the CLI runs, its record names it.
      const recordFile = join(registryDir, `engine-${leaderPid}.json`);
      expect(existsSync(recordFile)).toBe(true);
      expect(JSON.parse(readFileSync(recordFile, 'utf8')).enginePid).toBe(
        leaderPid,
      );

      // The CLI exits; the grandchild keeps its group alive, so the record
      // must stay for a later sweep.
      writeFileSync(join(dir, 'release'), '');
      const result = await running;
      expect(result.exitCode).toBe(0);
      expect(isAlive(grandchildPid)).toBe(true);
      expect(groupAlive(leaderPid)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(existsSync(recordFile)).toBe(true);

      // Once the group is empty, the record is released.
      process.kill(grandchildPid, 'SIGKILL');
      expect(await waitUntil(() => !groupAlive(leaderPid))).toBe(true);
      expect(await waitUntil(() => !existsSync(recordFile))).toBe(true);
    }, 30_000);
  },
);

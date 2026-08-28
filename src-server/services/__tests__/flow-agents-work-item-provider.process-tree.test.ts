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
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
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

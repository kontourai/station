/**
 * #561: a Flow shell command is spawned detached (its own process group) so
 * its timeout can kill the whole tree. That timeout lives in this process, so
 * a SIGKILLed Station used to leave the command running with no registry
 * record for the startup sweep to find. The spawn must register the group
 * while it runs and release the record only once the whole group has exited.
 *
 * The command is a stub shell script that starts a grandchild in its own
 * group and exits on request, leaving the grandchild behind. Every process it
 * starts is killed by exact pid (or by the exact group id the record names)
 * in afterEach. Spawns processes, so it is classified process-heavy in
 * `scripts/vitest-resource-manifest.mjs`.
 */
import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  lookupProcessBirthFingerprint,
  probeExactProcessIdentity as realProbe,
} from '@kontourai/station-shared/process-identity';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { sweepOrphanedOwnedProcesses } from '../../infra/process-utils.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  flowRunsStarted: { add: vi.fn() },
  flowEvidenceAttached: { add: vi.fn() },
  flowEvidenceAutoSuperseded: { add: vi.fn() },
  flowGateEvaluations: { add: vi.fn() },
  flowRunLocationDiagnostics: { add: vi.fn() },
  flowExceptionsAccepted: { add: vi.fn() },
  flowReportsGenerated: { add: vi.fn() },
  flowRunConsoleProjections: { add: vi.fn() },
}));

const { FlowRunService } = await import('../flow-run-service.js');

const DEFINITION = {
  id: 'owned-flow',
  version: '1',
  steps: [{ id: 'build', next: null }],
  gates: {
    'build-gate': {
      step: 'build',
      expects: [
        {
          id: 'tests-passed',
          kind: 'trust.bundle',
          required: true,
          description: 'Tests pass for the change.',
          bundle_claim: {
            claimType: 'quality.tests',
            accepted_statuses: ['assumed'],
          },
        },
      ],
    },
  },
};

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitFor(check: () => boolean, ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return check();
}

/**
 * Only a positive pid other than 1 and this process names one process.
 * `process.kill(0, …)` signals this runner's whole process group, and an
 * empty pid file parses as `Number('') === 0`: an attached CI shell would
 * be killed and the failure hidden.
 */
function isSignalablePid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 1 && pid !== process.pid;
}

/** Wait for a stub's pid file to hold one complete, signalable pid. */
async function readPidFile(file: string): Promise<number> {
  let pid = Number.NaN;
  await waitFor(() => {
    if (!existsSync(file)) return false;
    const text = readFileSync(file, 'utf8');
    pid = /^\d+\n$/.test(text) ? Number(text.trim()) : Number.NaN;
    return isSignalablePid(pid);
  });
  expect(isSignalablePid(pid), `pid file ${file}`).toBe(true);
  return pid;
}

function processGroupOf(pid: number): number {
  return Number(
    execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5_000,
    }).trim(),
  );
}

describe.skipIf(process.platform === 'win32')(
  'Flow shell command owned-process registration (#561)',
  () => {
    const makeTempDir = trackTempDirs();
    let registryDir: string;
    const pids: number[] = [];
    const groups: number[] = [];

    beforeEach(() => {
      registryDir = makeTempDir('station-flow-owned-registry-');
      vi.stubEnv('STATION_OWNED_PROCESS_REGISTRY', registryDir);
    });

    afterEach(async () => {
      // Kill by exact pid: the stub shell, its grandchild, any helper.
      for (const pid of pids.splice(0)) {
        if (!isSignalablePid(pid)) continue;
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
      // Never the runner's own group: a regression that stops detaching the
      // command would otherwise make cleanup SIGKILL this test process.
      const ownGroup = processGroupOf(process.pid);
      for (const pgid of groups.splice(0)) {
        if (!isSignalablePid(pgid) || pgid === ownGroup) continue;
        try {
          process.kill(-pgid, 'SIGKILL');
        } catch {
          // Already gone.
        }
        await waitFor(() => !groupAlive(pgid));
      }
      vi.unstubAllEnvs();
    });

    function records(): Array<{
      file: string;
      enginePid: number;
      engineBirth: string | null;
      ownerPid: number;
    }> {
      return readdirSync(registryDir)
        .filter((name) => name.startsWith('engine-') && name.endsWith('.json'))
        .map((name) => {
          const file = join(registryDir, name);
          const record = JSON.parse(readFileSync(file, 'utf8'));
          return {
            file,
            enginePid: record.enginePid as number,
            engineBirth: record.engineBirth as string | null,
            ownerPid: record.owner.pid as number,
          };
        });
    }

    /**
     * Run a stub command through the real FlowRunService. It starts a
     * grandchild in the command's group (stdio detached from the pipes, so
     * the command's 'close' can fire), reports both pids, and waits for a
     * release file before exiting without the grandchild.
     */
    async function startStubCommand() {
      const cwd = makeTempDir('station-flow-owned-run-');
      mkdirSync(join(cwd, '.flow', 'definitions'), { recursive: true });
      writeFileSync(
        join(cwd, '.flow', 'definitions', 'owned-flow.json'),
        JSON.stringify(DEFINITION),
      );
      const stubDir = makeTempDir('station-flow-owned-stub-');
      const stub = join(stubDir, 'stub-command.sh');
      writeFileSync(
        stub,
        [
          '#!/bin/sh',
          // Pid files are renamed into place, never read half-written.
          `echo $$ > '${stubDir}/shell.tmp' && mv '${stubDir}/shell.tmp' '${stubDir}/shell.pid'`,
          // Bounded, so a cleanup that never ran leaks nothing for long.
          'sleep 120 >/dev/null 2>&1 &',
          `echo $! > '${stubDir}/grandchild.tmp' && mv '${stubDir}/grandchild.tmp' '${stubDir}/grandchild.pid'`,
          'i=0',
          `while [ ! -e '${stubDir}/release' ] && [ $i -lt 1200 ]; do sleep 0.05; i=$((i + 1)); done`,
          'exit 0',
        ].join('\n'),
      );
      chmodSync(stub, 0o755);
      const svc = new FlowRunService();
      await svc.startRun(cwd, { definition: 'owned-flow', runId: 'run-1' });

      const attached = svc.attachCommandEvidence(cwd, 'run-1', {
        gate: 'build-gate',
        command: `'${stub}'`,
        claimType: 'quality.tests',
        timeoutMs: 30_000,
      });
      const shellPid = await readPidFile(join(stubDir, 'shell.pid'));
      pids.push(shellPid);
      // The shell leads the command's group. Hand that group to cleanup
      // first, so a grandchild whose pid file is unreadable is still reached
      // through it, but never this runner's own group (a command that was
      // not detached); then the grandchild is killed by its exact pid.
      const pgid = processGroupOf(shellPid);
      const ownGroup = processGroupOf(process.pid);
      if (pgid !== ownGroup) groups.push(pgid);
      const grandchildPid = await readPidFile(join(stubDir, 'grandchild.pid'));
      pids.push(grandchildPid);
      expect(pgid).not.toBe(ownGroup);
      expect(processGroupOf(grandchildPid)).toBe(pgid);
      return { attached, stubDir, grandchildPid, pgid };
    }

    test('a running command is registered, and the record is released only after its whole group exits', async () => {
      const { attached, stubDir, grandchildPid, pgid } =
        await startStubCommand();

      // While the command runs, exactly one record names its process group.
      const running = records();
      expect(running.map((record) => record.enginePid)).toEqual([pgid]);

      // The command exits; its grandchild keeps the group alive, so the
      // record must stay for a later sweep.
      writeFileSync(join(stubDir, 'release'), '');
      const result = await attached;
      expect(result.exitCode).toBe(0);
      expect(isAlive(grandchildPid)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(existsSync(running[0].file)).toBe(true);

      // Once the group is empty, the record is released.
      process.kill(grandchildPid, 'SIGKILL');
      expect(await waitFor(() => !groupAlive(pgid))).toBe(true);
      expect(await waitFor(() => !existsSync(running[0].file))).toBe(true);
    }, 30_000);

    test('the real sweep reaps the recorded group once this owner is gone', async () => {
      const { attached, grandchildPid, pgid } = await startStubCommand();
      const [record] = records();
      // The record must be actionable: owned by this process, with the
      // engine birth a live lookup reads. A null birth would make the sweep
      // drop it as unverifiable and never reap the group.
      expect(record.enginePid).toBe(pgid);
      expect(record.ownerPid).toBe(process.pid);
      expect(record.engineBirth).not.toBeNull();
      expect(record.engineBirth).toBe(lookupProcessBirthFingerprint(pgid));
      const unrelated = spawn(
        process.execPath,
        ['-e', 'setInterval(() => {}, 86400000)'],
        { stdio: 'ignore', detached: true },
      );
      pids.push(unrelated.pid!);

      // Simulate the SIGKILLed Station: only this owner's liveness answer is
      // replaced; the command group is probed for real.
      const swept = await sweepOrphanedOwnedProcesses({
        registryDir,
        probeIdentity: (candidate) =>
          candidate === process.pid ? { state: 'dead' } : realProbe(candidate),
      });

      expect(swept.reaped).toEqual([pgid]);
      expect(swept.unverifiable).toBe(0);
      expect(await waitFor(() => !groupAlive(pgid))).toBe(true);
      expect(isAlive(grandchildPid)).toBe(false);
      expect(isAlive(unrelated.pid!)).toBe(true);
      expect(existsSync(record.file)).toBe(false);
      // The killed command settles as a failed, non-zero run.
      expect((await attached).exitCode).not.toBe(0);
    }, 30_000);
  },
);

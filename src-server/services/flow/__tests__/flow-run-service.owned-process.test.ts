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
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';

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
      for (const pid of pids.splice(0)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
      for (const pgid of groups.splice(0)) {
        try {
          process.kill(-pgid, 'SIGKILL');
        } catch {
          // Already gone.
        }
        await waitFor(() => !groupAlive(pgid));
      }
      vi.unstubAllEnvs();
    });

    function records(): Array<{ file: string; enginePid: number }> {
      return readdirSync(registryDir)
        .filter((name) => name.startsWith('engine-') && name.endsWith('.json'))
        .map((name) => {
          const file = join(registryDir, name);
          const record = JSON.parse(readFileSync(file, 'utf8'));
          return { file, enginePid: record.enginePid as number };
        });
    }

    test('a running command is registered, and the record is released only after its whole group exits', async () => {
      const cwd = makeTempDir('station-flow-owned-run-');
      mkdirSync(join(cwd, '.flow', 'definitions'), { recursive: true });
      writeFileSync(
        join(cwd, '.flow', 'definitions', 'owned-flow.json'),
        JSON.stringify(DEFINITION),
      );
      const stubDir = makeTempDir('station-flow-owned-stub-');
      const stub = join(stubDir, 'stub-command.sh');
      // Starts a grandchild in the command's group (stdio detached from the
      // pipes, so the command's 'close' can fire), reports it, and waits for
      // the release file before exiting without it.
      writeFileSync(
        stub,
        [
          '#!/bin/sh',
          'sleep 600 >/dev/null 2>&1 &',
          `echo $! > '${stubDir}/grandchild.pid'`,
          `while [ ! -e '${stubDir}/release' ]; do sleep 0.05; done`,
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
      const grandchildFile = join(stubDir, 'grandchild.pid');
      expect(await waitFor(() => existsSync(grandchildFile))).toBe(true);
      const grandchildPid = Number(readFileSync(grandchildFile, 'utf8').trim());
      pids.push(grandchildPid);
      const pgid = processGroupOf(grandchildPid);
      groups.push(pgid);
      expect(pgid).not.toBe(processGroupOf(process.pid));

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
  },
);

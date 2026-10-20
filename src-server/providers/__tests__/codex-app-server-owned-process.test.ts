import { spawn } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { probeExactProcessIdentity as realProbe } from '@kontourai/station-shared/process-identity';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';

/**
 * #561: the real Codex `app-server` spawn (`spawnCodexProcess`, reached via
 * the exported `createCodexProcess` with no `processFactory`) is detached, so
 * a SIGKILLed Station leaves it running. It must write an owned-process
 * registry record that the startup sweep can find and reap, and a graceful
 * termination must release that record.
 *
 * The binary is a stub shell script that starts a grandchild in its own
 * process group, never a real Codex. Every process is reaped in afterEach.
 */

function isAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
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

async function waitFor(predicate: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe.skipIf(process.platform === 'win32')(
  'Codex app-server owned-process registration (#561)',
  () => {
    const makeTempDir = trackTempDirs();
    let registryDir: string;
    let stubPath: string;
    let grandchildFile: string;
    const spawned: Array<{ readonly pid?: number }> = [];

    /** Replace the stub `codex` with a shell script body. */
    function writeStub(body: string): void {
      writeFileSync(stubPath, `#!/bin/sh\n${body}\n`);
      chmodSync(stubPath, 0o755);
    }

    beforeEach(() => {
      vi.resetModules();
      const home = makeTempDir('station-codex-owned-home-');
      registryDir = makeTempDir('station-codex-owned-registry-');
      const binDir = makeTempDir('station-codex-owned-bin-');
      grandchildFile = join(binDir, 'grandchild.pid');
      stubPath = join(binDir, 'codex');
      // Ignores its `app-server` argv; starts a grandchild in the same group
      // and reports its pid, then idles on stdin like the real app-server.
      writeStub(`sleep 600 &\necho $! > '${grandchildFile}'\nexec cat`);
      vi.stubEnv('STATION_HOME', home);
      vi.stubEnv('STATION_OWNED_PROCESS_REGISTRY', registryDir);
      vi.doMock('../auth/cli-auth.js', () => ({
        findCliBinary: () => stubPath,
        resolveAugmentedPathSync: () => '/usr/bin:/bin',
      }));
    });

    afterEach(async () => {
      for (const child of spawned.splice(0)) {
        if (child.pid !== undefined) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            // The group is already gone.
          }
          await waitFor(() => !groupAlive(child.pid!));
        }
      }
      vi.doUnmock('../auth/cli-auth.js');
      vi.unstubAllEnvs();
      vi.resetModules();
    });

    async function spawnStubCodex() {
      const { createCodexProcess } = await import(
        '../adapters/codex-adapter-transport.js'
      );
      const proc = createCodexProcess(undefined, {});
      spawned.push(proc);
      expect(typeof proc.pid).toBe('number');
      const pid = proc.pid!;
      await waitFor(() => existsSync(grandchildFile));
      const grandchildPid = Number(readFileSync(grandchildFile, 'utf8').trim());
      expect(isAlive(grandchildPid)).toBe(true);
      return {
        proc,
        pid,
        grandchildPid,
        recordFile: join(registryDir, `engine-${pid}.json`),
      };
    }

    test('the app-server spawn writes a registry record naming this Station as owner', async () => {
      const { pid, recordFile } = await spawnStubCodex();

      expect(existsSync(recordFile)).toBe(true);
      const record = JSON.parse(readFileSync(recordFile, 'utf8'));
      expect(record.enginePid).toBe(pid);
      expect(record.owner.pid).toBe(process.pid);
      expect(typeof record.engineBirth).toBe('string');
      expect(record.command).toBe(stubPath);
    });

    test('the sweep finds the record: retained while the owner lives, reaped once it is gone', async () => {
      const { pid, grandchildPid, recordFile } = await spawnStubCodex();
      const unrelated = spawn(
        process.execPath,
        ['-e', 'setInterval(() => {}, 86400000)'],
        { stdio: 'ignore', detached: true },
      );
      spawned.push(unrelated);
      const { sweepOrphanedOwnedProcesses } = await import(
        '../../services/infra/process-utils.js'
      );

      const live = await sweepOrphanedOwnedProcesses({ registryDir });
      expect(live.retained).toBe(1);
      expect(live.reaped).toEqual([]);
      expect(isAlive(pid)).toBe(true);

      // Simulate the SIGKILLed Station: this test process is the recorded
      // owner, so only the owner's liveness answer is replaced. The app-server
      // and its grandchild are probed for real.
      const ownerGone = await sweepOrphanedOwnedProcesses({
        registryDir,
        probeIdentity: (candidate) =>
          candidate === process.pid ? { state: 'dead' } : realProbe(candidate),
      });
      expect(ownerGone.reaped).toEqual([pid]);
      await waitFor(() => !isAlive(pid) && !isAlive(grandchildPid));
      expect(isAlive(pid)).toBe(false);
      expect(isAlive(grandchildPid)).toBe(false);
      expect(existsSync(recordFile)).toBe(false);
      expect(isAlive(unrelated.pid)).toBe(true);
    });

    test('a graceful termination releases the record once the group is gone', async () => {
      const { proc, grandchildPid, recordFile } = await spawnStubCodex();
      expect(existsSync(recordFile)).toBe(true);
      const { terminateCodexProcess } = await import(
        '../adapters/codex-process-termination.js'
      );

      await terminateCodexProcess(proc);

      // The group SIGTERM has been sent and the leader confirmed gone; the
      // reparented grandchild is reaped by init on its own schedule.
      await waitFor(() => !isAlive(grandchildPid));
      expect(isAlive(grandchildPid)).toBe(false);
      await waitFor(() => !existsSync(recordFile));
      expect(existsSync(recordFile)).toBe(false);
    });

    test('a leader that exits while its grandchild lives keeps the record until the group is gone', async () => {
      // The app-server exits on its own and leaves a grandchild in its group.
      writeStub(
        `sleep 600 >/dev/null 2>&1 &\necho $! > '${grandchildFile}'\nexit 0`,
      );
      const { pid, grandchildPid, recordFile } = await spawnStubCodex();
      await waitFor(() => !isAlive(pid));
      expect(isAlive(pid)).toBe(false);
      expect(groupAlive(pid)).toBe(true);

      // Ten release polls (50 ms each) later the group is still alive, so the
      // record must still be there for a later sweep.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(existsSync(recordFile)).toBe(true);

      process.kill(grandchildPid, 'SIGKILL');
      await waitFor(() => !groupAlive(pid));
      await waitFor(() => !existsSync(recordFile));
      expect(existsSync(recordFile)).toBe(false);
    });
  },
);

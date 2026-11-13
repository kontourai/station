import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { runStationWeight } from '../bench/station-weight.mjs';
import { STATION_WEIGHT_BUDGETS } from '../bench/station-weight-budgets.mjs';

const makeTempDir = trackTempDirs();
const posix = ['darwin', 'linux'].includes(process.platform);
const BASELINE = JSON.parse(
  readFileSync(
    join(__dirname, '../bench/station-weight-baseline.json'),
    'utf8',
  ),
);
const strays: number[] = [];

afterEach(() => {
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone (the run is expected to have ended it).
    }
  }
});

/**
 * Stands in for an instance process that leaks during shutdown: started with
 * the run's environment after the pre-stop snapshot, it detaches a daemon and
 * exits, so nothing but the inherited environment ties the daemon to the run.
 */
function leakDuringShutdown(env: NodeJS.ProcessEnv) {
  const helper = spawn(
    process.execPath,
    [
      '-e',
      `const { spawn } = require('node:child_process');
       const daemon = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
       daemon.unref();
       process.stdout.write(String(daemon.pid));`,
    ],
    { env, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  return new Promise<number>((resolveDaemon) =>
    helper.stdout.once('data', (chunk) => {
      const pid = Number(String(chunk));
      strays.push(pid);
      helper.once('exit', () => resolveDaemon(pid));
    }),
  );
}

// Owns a real build, an isolated Station, its stub-answered Claude turn, the
// control engine run and `station stop`. Short windows: this proves the
// mechanics and the host-independent request budgets, not idle magnitudes.
describe.skipIf(!posix)('station-weight end to end', () => {
  test(
    'measures an isolated instance, finds a process leaked during shutdown, and keeps request overhead within budget',
    async () => {
      const out = makeTempDir('station-weight-test-');
      let leaked: number | undefined;
      const result = await runStationWeight({
        out,
        allowDirty: true,
        settings: {
          settleMs: 2_000,
          settleIntervalMs: 2_000,
          settleMaxMs: 180_000,
          cpuWindowMs: 2_000,
          idleSessions: 1,
          stopGraceMs: 2_000,
          sideCallWindowMs: 2_000,
          readyLaunches: 1,
        },
        hooks: {
          beforeStop: async ({ env }: { env: NodeJS.ProcessEnv }) => {
            leaked = await leakDuringShutdown(env);
          },
        },
      });
      expect(result.error).toBeUndefined();
      expect(result.outcome).toBe('completed');
      // The mechanics happened: every budgeted metric was measured.
      for (const budget of STATION_WEIGHT_BUDGETS)
        expect(result.metrics[budget.id], budget.id).toMatchObject({
          status: 'measured',
        });
      expect(result.metrics.restMemoryBytes.processCount).toBeGreaterThan(0);
      expect(result.metrics.idleCpuPercent.samples).toBeGreaterThan(2);

      // The leaked daemon is counted and ended, though no ancestry ties it
      // to the instance.
      const leftover = result.metrics.leftoverAfterStopMemoryBytes;
      expect(leaked).toBeGreaterThan(0);
      expect(
        leftover.processes.map((row: { pid: number }) => row.pid),
      ).toContain(leaked);
      expect(leftover.value).toBeGreaterThan(0);
      expect(leftover.killed).toContain(leaked);

      expect(result.repoRules).toMatchObject({ claudeMd: true });
      // Host-dependent budgets compare only against this host's own
      // fingerprint; request budgets are host-independent.
      const hostBaseline = BASELINE.hosts[result.host.fingerprint];
      for (const budget of STATION_WEIGHT_BUDGETS) {
        const entry = result.budgets.find(
          (verdict: { id: string }) => verdict.id === budget.id,
        );
        if (budget.scope === 'request')
          expect(entry, JSON.stringify(entry)).toMatchObject({
            verdict: 'PASS',
          });
        else if (!hostBaseline)
          expect(entry).toMatchObject({
            verdict: 'NOT_MEASURED',
            reason: expect.stringContaining(result.host.fingerprint),
          });
        else expect(['PASS', 'FAIL']).toContain(entry.verdict);
      }
      const written = JSON.parse(
        readFileSync(join(out, 'result.json'), 'utf8'),
      );
      expect(written.runId).toBe(result.runId);
      expect(written.baselineRecorded).toBeUndefined();
    },
    15 * 60_000,
  );
});

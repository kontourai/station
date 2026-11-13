import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  endRunProcesses,
  killEligibility,
  LEFTOVER_GAP,
  processTable,
  runStationWeight,
  runTagging,
  taggedRows,
} from '../bench/station-weight.mjs';
import { STATION_WEIGHT_BUDGETS } from '../bench/station-weight-budgets.mjs';

const makeTempDir = trackTempDirs();
const posix = ['darwin', 'linux'].includes(process.platform);
const BASELINE = JSON.parse(
  readFileSync(
    join(__dirname, '../bench/station-weight-baseline.json'),
    'utf8',
  ),
);
let leakedCleanup: (() => void) | undefined;

// The run is expected to have ended the daemon already. Cleanup follows the
// run's own rule (contract A): the daemon is signalled only if its exact
// environment entry is still the run's nonce, its exact birth rechecked
// right before the signal.
afterEach(() => {
  leakedCleanup?.();
  leakedCleanup = undefined;
});

/**
 * Stands in for an instance process that leaks during shutdown: started with
 * the run's environment after the pre-stop snapshot, it detaches a daemon and
 * exits, so nothing but the inherited environment ties the daemon to the run.
 */
function leakDuringShutdown(
  env: NodeJS.ProcessEnv,
  scratch: string,
  startedAtMs: number,
) {
  const helper = spawn(
    process.execPath,
    [
      '-e',
      `const { spawn } = require('node:child_process');
       const daemon = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
       daemon.unref();
       process.stdout.write(String(daemon.pid));`,
    ],
    { env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
  );
  return new Promise<number>((resolveDaemon) =>
    helper.stdout.once('data', (chunk) => {
      const pid = Number(String(chunk));
      const tagging = runTagging({
        nonce: String(env.STATION_WEIGHT_RUN),
        scratch,
        startedAtMs,
      });
      leakedCleanup = () => {
        const daemon = taggedRows(processTable(), tagging).filter(
          (row) => row.pid === pid && row.tag === 'nonce',
        );
        endRunProcesses(killEligibility(daemon, daemon));
      };
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
      const startedAtMs = Date.now();
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
          beforeStop: async ({
            env,
            scratch,
          }: {
            env: NodeJS.ProcessEnv;
            scratch: string;
          }) => {
            leaked = await leakDuringShutdown(env, scratch, startedAtMs);
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
      // Linux: switches counted across the window, not the end read twice.
      if (process.platform === 'linux')
        expect(result.metrics.idleContextSwitches.value).toBeGreaterThan(0);

      // The leaked daemon is counted and ended, though no ancestry ties it
      // to the instance.
      const leftover = result.metrics.leftoverAfterStopMemoryBytes;
      expect(leaked).toBeGreaterThan(0);
      expect(
        leftover.processes.map((row: { pid: number }) => row.pid),
      ).toContain(leaked);
      expect(leftover.value).toBeGreaterThan(0);
      expect(leftover.killed).toContain(leaked);
      expect(
        leftover.processes.find((row: { pid: number }) => row.pid === leaked),
      ).toMatchObject({ killEligible: true });
      expect(leftover.gap).toBe(LEFTOVER_GAP(result.follow));
      // The follower was connected while station start ran: it learned the
      // record's roots before launch returned, and its own reads found each
      // of them alive. Only following that started from the record can
      // satisfy both.
      expect(result.follow.instanceRoots.length).toBeGreaterThan(0);
      expect(result.follow.rootsLearnedAfterLaunch).toBe(0);
      expect(result.follow.rootsFollowed).toEqual(
        expect.arrayContaining(result.follow.instanceRoots),
      );
      expect(result.follow.reads).toBeGreaterThan(2);
      expect(result.follow.errors).toEqual([]);
      expect(leftover.gap).toContain(
        `${Math.ceil(result.follow.maxIntervalMs)} ms`,
      );
      // Every process of the pre-stop tree, and more seen while the run was
      // followed, is remembered by identity, whatever its environment.
      expect(leftover.seenProcessCount).toBeGreaterThanOrEqual(
        leftover.beforeStopProcessCount,
      );
      expect(leftover.beforeStopProcessCount).toBeGreaterThan(0);
      expect(result.metrics.idleCpuPercent.gap).toContain(
        `up to ${Math.ceil(result.metrics.idleCpuPercent.maxReadSpanMs)} ms`,
      );

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
        else if (budget.scope === 'report')
          expect(entry).toMatchObject({ verdict: 'REPORTED' });
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

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { afterEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  DEFAULT_BASELINE_PATH,
  ownedTree,
  processTable,
  runStationWeight,
  survivors,
} from '../bench/station-weight.mjs';

const makeTempDir = trackTempDirs();
const posix = ['darwin', 'linux'].includes(process.platform);
const strays: number[] = [];

afterEach(() => {
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
});

describe.skipIf(!posix)('station-weight process tree ownership', () => {
  test('finds a detached grandchild that outlives its parent by ownership, not by name', async () => {
    // The parent starts a detached child that ignores the parent's exit, then
    // reports the child's pid and waits to be killed.
    const parent = spawn(
      process.execPath,
      [
        '-e',
        `const { spawn } = require('node:child_process');
         const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', windowsHide: true });
         child.unref();
         process.stdout.write(String(child.pid) + '\\n');
         setInterval(() => {}, 1000);`,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
    );
    strays.push(parent.pid as number);
    const childPid = await new Promise<number>((resolve) =>
      parent.stdout.once('data', (chunk) =>
        resolve(Number(String(chunk).trim())),
      ),
    );
    strays.push(childPid);
    const before = ownedTree(processTable(), [parent.pid as number]);
    expect(before.map((row) => row.pid).sort()).toEqual(
      [parent.pid, childPid].sort(),
    );
    parent.kill('SIGKILL');
    await new Promise((resolve) => parent.once('exit', resolve));
    await wait(200);
    const after = processTable();
    expect(survivors(before, after).map((row) => row.pid)).toEqual([childPid]);
    // Same pid with a different start time is a reused pid, not a survivor.
    const reused = before.map((row) => ({
      ...row,
      started: 'Thu Jan  1 00:00:00 1970',
    }));
    expect(survivors(reused, after)).toEqual([]);
  });
});

// Owns a real build, an isolated Station, its stub-answered Claude turn, the
// control engine run and `station stop`. Short windows: this proves the seams
// and the request budgets, not idle magnitudes.
describe.skipIf(!posix)('station-weight end to end', () => {
  test(
    'measures an isolated instance and keeps request overhead within the committed baseline',
    async () => {
      const out = makeTempDir('station-weight-test-');
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
        },
      });
      expect(result.error).toBeUndefined();
      expect(result.outcome).toBe('completed');
      for (const id of [
        'serverReadyMs',
        'restRssBytes',
        'idleSessionsRssBytes',
        'idleCpuPercent',
        'leftoverAfterStopRssBytes',
        'request.stationAddedTextBytes',
        'request.stationAddedToolCount',
        'request.stationAddedToolDefinitionBytes',
        'request.sideCallCount',
      ])
        expect(result.metrics[id], id).toMatchObject({ status: 'measured' });
      expect(result.metrics.leftoverAfterStopRssBytes.value).toBe(0);
      expect(result.repoRules).toMatchObject({ claudeMd: true });
      // The comparison the per-PR check makes: Station's additions to the
      // first model request must stay inside the committed request budgets.
      const requestVerdicts = result.budgets.filter((entry) =>
        entry.id.startsWith('request.'),
      );
      expect(requestVerdicts.length).toBeGreaterThan(0);
      for (const entry of requestVerdicts)
        expect(entry, JSON.stringify(entry)).toMatchObject({ verdict: 'PASS' });
      const written = JSON.parse(
        readFileSync(join(out, 'result.json'), 'utf8'),
      );
      expect(written.runId).toBe(result.runId);
      expect(written.baselineRecorded).toBeUndefined();
      expect(DEFAULT_BASELINE_PATH).toMatch(/station-weight-baseline\.json$/);
    },
    15 * 60_000,
  );
});

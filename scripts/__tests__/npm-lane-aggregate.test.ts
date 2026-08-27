import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  firstLaneDiagnostic,
  mapWithConcurrency,
  planConcurrency,
  runLane,
  runLanesToCompletion,
  summarizeLaneResults,
} from '../lib/npm-lane-aggregate.mjs';

type MockChild = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
function mockChild(): MockChild {
  const child = new EventEmitter() as MockChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

describe('planConcurrency', () => {
  test('never exceeds the requested concurrency, the CPU count, or the lane count', () => {
    expect(planConcurrency(12, { concurrency: 4, cpuCount: 8 })).toBe(4);
    expect(planConcurrency(2, { concurrency: 4, cpuCount: 8 })).toBe(2);
    expect(planConcurrency(12, { concurrency: 4, cpuCount: 2 })).toBe(2);
  });

  test('falls back to the default when concurrency is not a positive integer', () => {
    expect(planConcurrency(12, { concurrency: 0, cpuCount: 99 })).toBe(4);
    expect(planConcurrency(12, { concurrency: -1, cpuCount: 99 })).toBe(4);
    expect(planConcurrency(12, { cpuCount: 99 })).toBe(4);
  });

  test('is always at least 1, even for zero lanes', () => {
    expect(planConcurrency(0, { concurrency: 4, cpuCount: 8 })).toBe(1);
  });
});

describe('mapWithConcurrency', () => {
  test('preserves input order in the results regardless of completion order', async () => {
    const order = [30, 10, 20, 0];
    const results = await mapWithConcurrency(
      order,
      4,
      async (ms: number, index: number) => {
        await new Promise((resolve) => setTimeout(resolve, ms));
        return index;
      },
    );
    expect(results).toEqual([0, 1, 2, 3]);
  });

  test('never runs more than `limit` workers concurrently', async () => {
    let active = 0;
    let maxActive = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);
    await mapWithConcurrency(items, 3, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    });
    expect(maxActive).toBeLessThanOrEqual(3);
  });

  test('runs every item even though a limit of 1 makes it fully serial', async () => {
    const seen: number[] = [];
    await mapWithConcurrency([1, 2, 3], 1, async (item: number) => {
      seen.push(item);
    });
    expect(seen).toEqual([1, 2, 3]);
  });
});

describe('firstLaneDiagnostic', () => {
  test('finds a tsc-shaped error line', () => {
    const line = firstLaneDiagnostic({
      stdout:
        "src-ui/src/App.tsx(12,3): error TS2322: Type 'string' is not assignable.",
      stderr: '',
    });
    expect(line).toContain('TS2322');
  });

  test('finds a biome-shaped diagnostic header', () => {
    const line = firstLaneDiagnostic({
      stdout: 'src-ui/src/probe.ts:4:17 lint/suspicious/noRedeclare ━━━━━━━━━━',
      stderr: '',
    });
    expect(line).toContain('noRedeclare');
  });

  test('returns null when nothing diagnostic-shaped is present', () => {
    expect(
      firstLaneDiagnostic({
        stdout: 'the build step ended abnormally',
        stderr: '',
      }),
    ).toBeNull();
  });
});

describe('summarizeLaneResults (pure, station#4249)', () => {
  function lane(id: string, ok: boolean, extra: Record<string, unknown> = {}) {
    return {
      id,
      script: id,
      ok,
      exitCode: ok ? 0 : 2,
      seconds: 1.2,
      stdout: ok ? 'OK\n' : '',
      stderr: ok ? '' : `${id} failed\nerror TS9999: fixture failure`,
      ...extra,
    };
  }

  // The whole point of the change: report EVERY failing lane, not the first.
  test('names every failing lane, not only the first', () => {
    const results = [
      lane('typecheck:server', true),
      lane('typecheck:ui', false),
      lane('typecheck:server-tests', true),
      lane('typecheck:cli', false),
    ];
    const summary = summarizeLaneResults(results, { label: 'typecheck' });
    expect(summary.ok).toBe(false);
    expect(summary.failedLaneIds).toEqual(['typecheck:ui', 'typecheck:cli']);
    expect(summary.text).toContain('FAIL typecheck:ui');
    expect(summary.text).toContain('FAIL typecheck:cli');
    // A passing lane must never be reported as a FAIL line.
    expect(summary.text).not.toMatch(/FAIL typecheck:server\b/);
    expect(summary.text).not.toMatch(/FAIL typecheck:server-tests\b/);
  });

  test('is ok with an empty failedLaneIds list when every lane passed', () => {
    const summary = summarizeLaneResults([lane('a', true), lane('b', true)], {
      label: 'typecheck',
    });
    expect(summary.ok).toBe(true);
    expect(summary.failedLaneIds).toEqual([]);
    expect(summary.text).toContain('OK: typecheck');
  });

  test('a bare FAIL line still names the lane when the output has no diagnostic-shaped line', () => {
    const summary = summarizeLaneResults(
      [
        lane('docs:index:check', false, {
          stdout: '',
          stderr: 'the build step ended abnormally',
        }),
      ],
      { label: 'docs:truth:gate' },
    );
    expect(summary.text).toContain('FAIL docs:index:check');
  });
});

describe('runLane (child-process seam, mocked)', () => {
  test('reports a zero exit as ok, with captured stdout', async () => {
    const child = mockChild();
    const promise = runLane(
      { id: 'x', script: 'x' },
      {
        spawnFn: (() => child) as never,
        npmBin: 'npm',
      },
    );
    child.stdout.emit('data', Buffer.from('all good\n'));
    child.emit('close', 0);
    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('all good\n');
  });

  test('reports a non-zero exit as failed, with captured stderr', async () => {
    const child = mockChild();
    const promise = runLane(
      { id: 'x', script: 'x' },
      { spawnFn: (() => child) as never, npmBin: 'npm' },
    );
    child.stderr.emit('data', Buffer.from('error TS1234: broke\n'));
    child.emit('close', 2);
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('TS1234');
  });

  test('reports a spawn error as a failure rather than throwing', async () => {
    const child = mockChild();
    const promise = runLane(
      { id: 'x', script: 'x' },
      { spawnFn: (() => child) as never, npmBin: 'npm' },
    );
    child.emit('error', new Error('ENOENT'));
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.spawnError).toBe(true);
    expect(result.stderr).toContain('ENOENT');
  });
});

// station#4249 review: reproduced LIVE on a real self-hosted Windows box.
// `spawn(bin, args, { shell: false })` throws a SYNCHRONOUS `spawn EINVAL`
// for a `.cmd`/`.bat` target since Node's CVE-2024-27980 hardening, which
// `runLane`'s own try/catch swallowed into `{ ok: false, spawnError: true }`
// -- every lane failed on Windows regardless of whether the code compiled,
// and `.github/workflows/windows-verification.yml` runs `npm run typecheck`
// on that exact self-hosted runner as a required step. There is no Windows
// host in this test loop, so these tests inject `platform` directly rather
// than reasoning about the spawn shape only from source -- a reasoned-about
// spawn shape is exactly what shipped broken here.
describe('runLane spawn shape by platform (station#4249, no live Windows host in this loop)', () => {
  function capturingSpawnFn() {
    const calls: Array<{
      command: string;
      args: string[];
      options: Record<string, unknown>;
    }> = [];
    const spawnFn = (
      command: string,
      args: string[],
      options: Record<string, unknown>,
    ) => {
      calls.push({ command, args, options });
      const child = mockChild();
      // Never actually settle -- these tests only inspect the call shape.
      return child as never;
    };
    return { spawnFn, calls };
  }

  test('uses shell:true and npm.cmd on a simulated win32 platform, and still sets windowsHide', () => {
    const { spawnFn, calls } = capturingSpawnFn();
    void runLane(
      { id: 'typecheck:ui', script: 'typecheck:ui' },
      { spawnFn: spawnFn as never, platform: 'win32' },
    );
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.command).toBe('npm.cmd');
    // This is the exact assertion the missing coverage let regress: without
    // it, `shell: false` on a `.cmd` target throws synchronously on a real
    // Windows host before this test's fixture would ever have caught it,
    // because nothing in the suite previously simulated win32 at all.
    expect(call.options.shell).toBe(true);
    expect(call.options.windowsHide).toBe(true);
  });

  test('keeps shell:false and plain npm on POSIX platforms', () => {
    for (const platform of ['darwin', 'linux']) {
      const { spawnFn, calls } = capturingSpawnFn();
      void runLane(
        { id: 'typecheck:ui', script: 'typecheck:ui' },
        { spawnFn: spawnFn as never, platform },
      );
      const [call] = calls;
      expect(call.command).toBe('npm');
      expect(call.options.shell).toBe(false);
      expect(call.options.windowsHide).toBe(true);
    }
  });

  test('an explicit npmBin overrides the platform default on win32 too', () => {
    const { spawnFn, calls } = capturingSpawnFn();
    void runLane(
      { id: 'x', script: 'x' },
      { spawnFn: spawnFn as never, platform: 'win32', npmBin: 'npm' },
    );
    expect(calls[0].command).toBe('npm');
    // Overriding the binary does not change the platform-derived shell
    // decision -- a `.cmd`/`.bat` override still needs shell mediation.
    expect(calls[0].options.shell).toBe(true);
  });

  test('runLanesToCompletion threads platform through to every lane', () => {
    const { spawnFn, calls } = capturingSpawnFn();
    void runLanesToCompletion({
      lanes: [
        { id: 'a', script: 'a' },
        { id: 'b', script: 'b' },
      ],
      label: 'fixture',
      spawnFn: spawnFn as never,
      platform: 'win32',
      log: () => {},
      logError: () => {},
    });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.command).toBe('npm.cmd');
      expect(call.options.shell).toBe(true);
    }
  });
});

describe('runLanesToCompletion (mocked spawn, station#4249 core behaviour)', () => {
  test('runs every lane to completion after an earlier lane fails, and exits non-zero', async () => {
    const lanes = [
      { id: 'a', script: 'a' },
      { id: 'b', script: 'b' },
      { id: 'c', script: 'c' },
    ];
    const started: string[] = [];
    const spawnFn = (_bin: string, args: string[]) => {
      const script = args[args.indexOf('run') + 2] ?? args[2];
      started.push(script);
      const child = mockChild();
      // Settle asynchronously so all three are in flight together under the
      // default concurrency before any of them resolves.
      setTimeout(() => {
        if (script === 'b') {
          child.stderr.emit('data', Buffer.from('error TS0001: b broke\n'));
          child.emit('close', 1);
        } else {
          child.emit('close', 0);
        }
      }, 1);
      return child;
    };
    const log: string[] = [];
    const ok = await runLanesToCompletion({
      lanes,
      label: 'fixture',
      spawnFn: spawnFn as never,
      npmBin: 'npm',
      log: (line: string) => {
        log.push(line);
      },
      logError: (line: string) => {
        log.push(line);
      },
    });
    expect(ok).toBe(false);
    // Every lane ran -- the whole point of the change.
    expect(started.sort()).toEqual(['a', 'b', 'c']);
    const text = log.join('\n');
    expect(text).toContain('FAIL b');
    expect(text).not.toMatch(/FAIL a\b/);
    expect(text).not.toMatch(/FAIL c\b/);
  });

  test('returns true when every lane passes', async () => {
    const lanes = [
      { id: 'a', script: 'a' },
      { id: 'b', script: 'b' },
    ];
    const spawnFn = () => {
      const child = mockChild();
      setTimeout(() => child.emit('close', 0), 1);
      return child;
    };
    const ok = await runLanesToCompletion({
      lanes,
      label: 'fixture',
      spawnFn: spawnFn as never,
      npmBin: 'npm',
      log: () => {},
      logError: () => {},
    });
    expect(ok).toBe(true);
  });
});

// The fault-injection guard this repo's own doctrine names: a guardrail whose
// rejection path never executes is unproven. These two tests spawn REAL
// child processes (through an actual throwaway package.json + `npm run`, not
// a mock) and assert the REAL exit status, proving the aggregate runner's
// non-zero exit is a genuine child-process outcome and not only a mocked
// unit-level claim.
describe('runLanesToCompletion (real child processes)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  function realFixtureDir(scripts: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), 'station-npm-lane-aggregate-'));
    dirs.push(dir);
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '0.0.0', scripts }, null, 2),
    );
    return dir;
  }

  test('a real failing lane produces a real non-zero process exit, and a real passing lane produces exit 0', async () => {
    const cwd = realFixtureDir({
      pass: 'node -e "process.exit(0)"',
      fail: 'node -e "console.error(\'error TS1234: real failure\'); process.exit(1)"',
    });
    const ok = await runLanesToCompletion({
      lanes: [
        { id: 'pass', script: 'pass' },
        { id: 'fail', script: 'fail' },
      ],
      label: 'real-fixture',
      cwd,
      log: () => {},
      logError: () => {},
    });
    expect(ok).toBe(false);
  });

  test('every real lane still runs even though the FIRST one fails (no fail-fast between lanes)', async () => {
    const markerDir = mkdtempSync(join(tmpdir(), 'station-lane-marker-'));
    dirs.push(markerDir);
    const marker = join(markerDir, 'ran-second');
    const cwd = realFixtureDir({
      first: 'node -e "process.exit(3)"',
      // The marker path travels through an env var, not the command string,
      // so this fixture never has to reason about shell/JS quote collisions
      // for an arbitrary tmpdir path.
      second:
        "node -e \"require('node:fs').writeFileSync(process.env.STATION_LANE_MARKER, 'ran')\"",
    });
    const ok = await runLanesToCompletion({
      lanes: [
        { id: 'first', script: 'first' },
        { id: 'second', script: 'second' },
      ],
      label: 'real-fixture',
      cwd,
      env: { ...process.env, STATION_LANE_MARKER: marker },
      log: () => {},
      logError: () => {},
    });
    expect(ok).toBe(false);
    expect(existsSync(marker)).toBe(true);
  });
});

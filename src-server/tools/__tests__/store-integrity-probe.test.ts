// @vitest-environment node

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  corruptionMarkerPath,
  readCorruptionMarker,
} from '@kontourai/station-shared/sqlite-corruption-marker';
import type { StoreIntegrityReport } from '@kontourai/station-shared/sqlite-store-integrity';
import * as esbuild from 'esbuild';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { STATION_SERVER_EXTERNALS } from '../../../scripts/lib/server-build-config.mjs';
import {
  STORE_INTEGRITY_VERIFICATION_INTERVAL_MS,
  spawnStoreIntegrityProbe,
  startStoreIntegrityVerification,
} from '../../runtime/bootstrap/store-integrity-verification.js';

/**
 * archive#3218. The probe's contract is a PROCESS contract — stdout JSON plus
 * an exit status — and a returned number is not an exit status. So every case
 * here runs the real bundled artifact as a real child and reads what the
 * operating system reports.
 *
 * The stores are real, in WAL (what `event-store.ts` sets), and the corrupt
 * ones are corrupted by overwriting bytes. A thrown fixture would prove only
 * that the classifier classifies; the claim being made is about what SQLite
 * does to a damaged file.
 */

const moduleDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(moduleDir, '..', '..', '..');
const probeSource = join(
  repoRoot,
  'src-server',
  'tools',
  'store-integrity-probe.ts',
);

let workspace: string;
let probeBundle: string;
/** The directory holding the built probe, as `dist-server/` does in a real install. */
let bundleDir: string;

function seed(path: string, rows: number): InstanceType<typeof DatabaseSync> {
  mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  database.exec('PRAGMA journal_mode = WAL');
  database.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, a TEXT, b TEXT)');
  database.exec('CREATE INDEX ia ON t(a)');
  const insert = database.prepare('INSERT INTO t(a, b) VALUES (?, ?)');
  database.exec('BEGIN');
  for (let index = 0; index < rows; index += 1)
    insert.run(`a${index}${'x'.repeat(60)}`, `b${index}${'y'.repeat(60)}`);
  database.exec('COMMIT');
  return database;
}

/** Real damage past the header, in pages no ordinary query has read. */
function damageRowPages(path: string): void {
  const bytes = readFileSync(path);
  expect(bytes.byteLength).toBeGreaterThan(64 * 1024);
  bytes.fill(0x5a, Math.floor(bytes.byteLength * 0.5));
  writeFileSync(path, bytes);
}

function runProbe(...args: string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, [probeBundle, ...args], {
    encoding: 'utf8',
    stdio: 'pipe',
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function parse(stdout: string): StoreIntegrityReport {
  return JSON.parse(stdout.trim()) as StoreIntegrityReport;
}

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'store-integrity-probe-'));
  bundleDir = join(workspace, 'dist-server');
  probeBundle = join(bundleDir, 'store-integrity-probe.js');
  // Built exactly the way `esbuild.config.mjs` builds it. Running the SOURCE
  // through `tsx` would leave the shipped artifact — the one the runtime
  // spawns — unproven, including whether it bundles at all.
  await esbuild.build({
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    entryPoints: [probeSource],
    outfile: probeBundle,
    external: STATION_SERVER_EXTERNALS,
    banner: {
      js: "import { createRequire as __stationCreateRequire } from 'node:module'; const require = __stationCreateRequire(import.meta.url);",
    },
  });
}, 60_000);

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('the store integrity probe as a process', () => {
  test('exits 0 with an ok verdict for a healthy store held open by a writer', () => {
    const path = join(workspace, 'healthy', 'orchestration.sqlite');
    const writer = seed(path, 2_000);
    try {
      const run = runProbe(path);
      expect(run.status).toBe(0);
      const report = parse(run.stdout);
      expect(report.results).toHaveLength(1);
      expect(report.results[0]?.verdict).toBe('ok');
      expect(report.results[0]?.databasePath).toBe(path);
    } finally {
      writer.close();
    }
  });

  test('exits non-zero with a corrupt verdict against genuinely corrupted bytes', () => {
    const path = join(workspace, 'corrupt', 'orchestration.sqlite');
    seed(path, 20_000).close();
    damageRowPages(path);

    const run = runProbe(path);
    expect(run.status).toBe(1);
    const report = parse(run.stdout);
    expect(report.results[0]?.verdict).toBe('corrupt');
    // The verdict carries SQLite's own account of the damage, so an operator
    // reading the marker later has something more than the word "corrupt".
    expect(report.results[0]?.detail).toMatch(/page \d+/);
  });

  test('a store it cannot read exits differently from a corrupt one', () => {
    // The required negative control at the process boundary. Both are
    // failures; only one of them is a statement about the bytes, and a caller
    // that quarantines on any non-zero exit would destroy a user's history
    // the first time a store was merely unreadable. A directory where a
    // database was expected is a real unreadable store, not a fixture.
    const run = runProbe(workspace);
    expect(run.status).toBe(2);
    expect(run.status).not.toBe(1);
    expect(parse(run.stdout).results[0]?.verdict).toBe('unavailable');
  });

  test('a store that was never created is absent, and alone it is not a pass', () => {
    // Two halves of one rule. A home that has not used a subsystem yet has no
    // store for it, and failing on that would train everyone to ignore the
    // exit code — so `absent` costs nothing beside a store that WAS verified.
    const healthy = join(workspace, 'absent-pair', 'scheduler.sqlite');
    seed(healthy, 500).close();
    const paired = runProbe(
      healthy,
      join(workspace, 'absent-pair', 'orchestration.sqlite'),
    );
    expect(paired.status).toBe(0);
    expect(parse(paired.stdout).results.map((r) => r.verdict)).toEqual([
      'ok',
      'absent',
    ]);

    // But when NOTHING was verified, exit 0 would answer "is my data OK?"
    // with yes about a path that holds no stores at all — which is what a
    // mistyped `--base` looks like.
    const alone = runProbe(join(workspace, 'absent', 'orchestration.sqlite'));
    expect(alone.status).toBe(3);
    expect(alone.status).not.toBe(0);
    expect(parse(alone.stdout).results[0]?.verdict).toBe('absent');
  });

  test('reports every store it was given, and the worst verdict decides the exit', () => {
    const healthy = join(workspace, 'mixed', 'scheduler.sqlite');
    const damaged = join(workspace, 'mixed', 'orchestration.sqlite');
    seed(healthy, 500).close();
    seed(damaged, 20_000).close();
    damageRowPages(damaged);

    const run = runProbe(healthy, damaged);
    expect(run.status).toBe(1);
    const report = parse(run.stdout);
    // A probe that stopped at the first bad store would leave an operator
    // guessing about the rest of their home.
    expect(report.results.map((result) => result.verdict)).toEqual([
      'ok',
      'corrupt',
    ]);
  });

  test('exits 3 and prints no verdict when given nothing to check', () => {
    const run = runProbe();
    expect(run.status).toBe(3);
    expect(run.stdout.trim()).toBe('');
    expect(run.stderr).toMatch(/Usage: store-integrity-probe/);
  });
});

describe('the runtime refuses a probe answer it cannot trust', () => {
  /** A real child that prints `stdout` and exits with `code`. */
  function fakeProbe(stdout: string, code: number) {
    return (_command: string, _args: readonly string[], options: object) =>
      spawn(
        process.execPath,
        [
          '-e',
          `process.stdout.write(${JSON.stringify(stdout)}); process.exit(${code});`,
        ],
        options,
      );
  }

  test('a verdict its exit code contradicts is not acted on', async () => {
    // The two halves of the probe's answer are derived from the same results,
    // so a disagreement means something between them is wrong. Taking the
    // JSON anyway would let a truncated or interleaved stdout stand in for a
    // verdict about a user's history.
    const outcome = await spawnStoreIntegrityProbe({
      moduleDir: '/opt/station/dist-server',
      databasePath: '/x/orchestration.sqlite',
      spawnFn: fakeProbe(
        JSON.stringify({
          checkedAt: '2026-08-18T00:00:00.000Z',
          results: [
            {
              databasePath: '/x/orchestration.sqlite',
              verdict: 'ok',
              durationMs: 1,
            },
          ],
        }),
        1,
      ),
    });
    expect(outcome.results).toEqual([]);
    expect(outcome.unreadable).toMatch(/disagree/);
  });

  test('output that is not a report produces no verdict', async () => {
    const outcome = await spawnStoreIntegrityProbe({
      moduleDir: '/opt/station/dist-server',
      databasePath: '/x/orchestration.sqlite',
      spawnFn: fakeProbe('Cannot find module ...\n', 1),
    });
    expect(outcome.results).toEqual([]);
    expect(outcome.unreadable).toMatch(/printed no verdict/);
  });

  test('a report naming a verdict this runtime does not know is rejected whole', async () => {
    // Dropping the whole report rather than the unknown entry: a partial read
    // of a corruption report is the half nobody wants to be missing.
    const outcome = await spawnStoreIntegrityProbe({
      moduleDir: '/opt/station/dist-server',
      databasePath: '/x/orchestration.sqlite',
      spawnFn: fakeProbe(
        JSON.stringify({
          checkedAt: '2026-08-18T00:00:00.000Z',
          results: [
            {
              databasePath: '/x/orchestration.sqlite',
              verdict: 'fine',
              durationMs: 1,
            },
          ],
        }),
        0,
      ),
    });
    expect(outcome.results).toEqual([]);
    expect(outcome.unreadable).toMatch(/printed no verdict/);
  });
});

describe('a probe that outlives its usefulness is killed', () => {
  /** A real child that never finishes on its own. */
  const wedgedProbe = (
    _command: string,
    _args: readonly string[],
    options: object,
  ) =>
    spawn(
      process.execPath,
      [
        '-e',
        'process.stdout.write("started\\n"); setInterval(() => {}, 1000);',
      ],
      options,
    );

  test('the teardown signal kills a probe that is still running', async () => {
    // The shutdown case. `shutdownRuntimeServices` clears the interval, which
    // stops the NEXT probe; `gracefulShutdown` then calls `process.exit`,
    // taking the timeout valve below with it. Without this the child is
    // reparented to init, still reading the store, unbounded — and the window
    // is exactly when the probe is slowest.
    const teardown = new AbortController();
    let child: ChildProcess | undefined;
    const outcome = spawnStoreIntegrityProbe({
      moduleDir: '/opt/station/dist-server',
      databasePath: '/x/orchestration.sqlite',
      signal: teardown.signal,
      spawnFn: (command, args, options) => {
        child = wedgedProbe(command, args, options);
        return child;
      },
    });
    try {
      await once(child?.stdout as Readable, 'data');
      expect(child?.exitCode).toBeNull();

      teardown.abort();

      // Bounded, and asserted rather than awaited: an unkilled child never
      // ends, so a bare `await` would fail this as a suite timeout thirty
      // seconds later without naming what went wrong.
      const settled = await Promise.race([
        once(child as ChildProcess, 'close').then(
          () => 'child exited' as const,
        ),
        new Promise<'child still running'>((resolve) =>
          setTimeout(() => resolve('child still running'), 2_000),
        ),
      ]);
      expect(settled).toBe('child exited');
      expect(child?.killed).toBe(true);
      // The abort is not a verdict about the bytes.
      expect(await outcome).toEqual(expect.objectContaining({ results: [] }));
    } finally {
      if (child?.exitCode === null) child.kill('SIGKILL');
    }
  });

  test('the timeout valve kills a probe that never answers', async () => {
    // The wedged-child case with no shutdown to rescue it. Ten minutes in
    // production; a real bound here, fired against a real child.
    const startedAt = Date.now();
    let child: ChildProcess | undefined;
    const outcome = await spawnStoreIntegrityProbe({
      moduleDir: '/opt/station/dist-server',
      databasePath: '/x/orchestration.sqlite',
      timeoutMs: 250,
      spawnFn: (command, args, options) => {
        child = wedgedProbe(command, args, options);
        return child;
      },
    });
    try {
      expect(outcome.results).toEqual([]);
      expect(outcome.unreadable).toMatch(/exceeded 250ms/);
      // It must have waited for the deadline rather than given up
      // immediately, and it must not have waited for the child, which never
      // ends on its own.
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(200);
      const settled = await Promise.race([
        once(child as ChildProcess, 'close').then(
          () => 'child exited' as const,
        ),
        new Promise<'child still running'>((resolve) =>
          setTimeout(() => resolve('child still running'), 2_000),
        ),
      ]);
      expect(settled).toBe('child exited');
      expect(child?.killed).toBe(true);
    } finally {
      if (child?.exitCode === null) child.kill('SIGKILL');
    }
  });
});

describe("the scheduler's own default path, end to end", () => {
  test('the default probe spawns the real bundle and records what it finds', async () => {
    // Every other test of the scheduler injects `runProbe`, so the default —
    // the closure that binds `moduleDir` and the teardown signal, and the one
    // thing production actually runs — was never executed by the corpus. This
    // drives it against a real bundle and a really-corrupted store, with
    // nothing stubbed between the timer and the marker.
    const path = join(workspace, 'default-path', 'orchestration.sqlite');
    seed(path, 20_000).close();
    damageRowPages(path);
    expect(existsSync(corruptionMarkerPath(path))).toBe(false);

    const timers: NodeJS.Timeout[] = [];
    const logger = {
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const stop = startStoreIntegrityVerification({
      timers,
      databasePath: path,
      logger,
      moduleDir: bundleDir,
    });
    try {
      await vi.waitFor(
        () => expect(existsSync(corruptionMarkerPath(path))).toBe(true),
        { timeout: 30_000 },
      );
      const marker = readCorruptionMarker(path);
      expect(marker?.detail).toMatch(/page \d+/);
      expect(logger.error).toHaveBeenCalled();
      // The interval default is what ships; a `MS_PER_MINUTE` typo here would
      // turn a six-hourly diagnostic into a per-minute spawn storm.
      expect(logger.debug).toHaveBeenCalledWith(
        'Store integrity verification started',
        expect.objectContaining({
          interval: STORE_INTEGRITY_VERIFICATION_INTERVAL_MS,
        }),
      );
      expect(timers).toHaveLength(1);
    } finally {
      stop();
      for (const timer of timers) clearInterval(timer);
    }
  }, 60_000);

  test('with no moduleDir it looks for the probe beside itself', async () => {
    // The other half of the default: `dirname(fileURLToPath(import.meta.url))`
    // is `dist-server/` in the bundle, which is exactly where
    // `esbuild.config.mjs` writes the probe. Under vitest it resolves to the
    // source directory and finds nothing — which is what makes the resolved
    // path observable at all.
    const timers: NodeJS.Timeout[] = [];
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const stop = startStoreIntegrityVerification({
      timers,
      databasePath: join(workspace, 'no-module-dir.sqlite'),
      logger,
    });
    try {
      await vi.waitFor(() => expect(logger.warn).toHaveBeenCalled());
      const reason = String(
        (logger.warn.mock.calls[0]?.[1] as { reason?: string })?.reason ?? '',
      );
      expect(reason).toContain(
        join('runtime', 'bootstrap', 'store-integrity-probe.js'),
      );
      // A probe that could not be found says NOTHING about the bytes.
      expect(logger.error).not.toHaveBeenCalled();
    } finally {
      stop();
      for (const timer of timers) clearInterval(timer);
    }
  });

  test('the disposer kills a probe the DEFAULT closure spawned (the signal binding is live)', async () => {
    // Third recurrence of the same class in this branch: HIGH-1 was the
    // unwired start, a888d680a was the unreached disposer, and this is the
    // one link left — `signal: teardown.signal` inside the default `runProbe`
    // closure. Every abort-kill proof above injects the signal into
    // `spawnStoreIntegrityProbe` directly, so deleting that binding kept the
    // whole corpus green while shutdown quietly stopped reaching the child.
    // A wedge artifact in `moduleDir`'s place makes the binding observable:
    // the child publishes its pid, the disposer must end it.
    const wedgeDir = join(workspace, 'wedge-dist');
    mkdirSync(wedgeDir, { recursive: true });
    writeFileSync(
      join(wedgeDir, 'store-integrity-probe.js'),
      // CJS on purpose: the workspace tmpdir has no package.json, so `.js`
      // parses as CommonJS regardless of the repo's module type.
      'require("node:fs").writeFileSync(process.argv[2] + ".pid", String(process.pid));\n' +
        'setInterval(() => {}, 1000);\n',
    );
    const databasePath = join(wedgeDir, 'orchestration.sqlite');
    const pidFile = `${databasePath}.pid`;
    const timers: NodeJS.Timeout[] = [];
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const stop = startStoreIntegrityVerification({
      timers,
      databasePath,
      logger,
      moduleDir: wedgeDir,
    });
    let pid: number | undefined;
    try {
      await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), {
        timeout: 10_000,
      });
      pid = Number(readFileSync(pidFile, 'utf8'));
      // Alive before, dead after — `kill(pid, 0)` is the OS's answer, not a
      // flag of ours.
      expect(() => process.kill(pid as number, 0)).not.toThrow();

      stop();

      await vi.waitFor(
        () => expect(() => process.kill(pid as number, 0)).toThrow(),
        { timeout: 5_000 },
      );
    } finally {
      for (const timer of timers) clearInterval(timer);
      if (pid !== undefined) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already dead, which is the passing case.
        }
      }
    }
  });
});

describe('the runtime spawns the artifact the build produces', () => {
  test('the spawned filename is the one esbuild writes', async () => {
    // These two strings live in different files and nothing else couples
    // them. If they drift, the runtime spawns a path that does not exist and
    // every scheduled verification degrades to "no verdict" silently.
    const spawned: string[][] = [];
    const outcome = await spawnStoreIntegrityProbe({
      moduleDir: '/opt/station/dist-server',
      databasePath: '/opt/station/home/data/orchestration.sqlite',
      spawnFn: (_command, args) => {
        spawned.push([...args]);
        throw new Error('spawn refused by this test');
      },
    });
    expect(spawned[0]?.[0]).toBe(
      '/opt/station/dist-server/store-integrity-probe.js',
    );
    // A spawn that never ran says nothing about the bytes.
    expect(outcome.results).toEqual([]);
    expect(outcome.unreadable).toMatch(/could not be spawned/);

    const buildConfig = readFileSync(
      join(repoRoot, 'esbuild.config.mjs'),
      'utf8',
    );
    expect(buildConfig).toContain(
      "entryPoints: ['./src-server/tools/store-integrity-probe.ts']",
    );
    expect(buildConfig).toContain('/store-integrity-probe.js`');
  });
});

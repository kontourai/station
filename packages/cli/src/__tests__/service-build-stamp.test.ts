/**
 * station#2689: a source checkout built with `npm run build` has a current
 * bundle but no `dist-server/station-build.json`, so the supervised boot
 * expects sha `'unknown'` while the server reports its baked sha and every
 * boot fails "managed boot identity mismatch". These tests drive the REAL
 * lifecycle stamp check and the REAL `buildApplication` through their two
 * production callers — `service install` (rebuilds, re-checks, refuses only
 * when that did not help) and the `service run` supervisor (rebuilds) —
 * against real git checkout fixtures. Substituted: the OS service backend,
 * the checkout root (`CWD`), and the `npm run` build steps, which write the
 * bundle files a real build would.
 */
import { execFileSync } from 'node:child_process';
import * as nodeFs from 'node:fs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.js';
import type { ServiceFs } from '../commands/service.js';

const makeTempDir = trackTempDirs();

const installSystemd = vi.fn();
const BACKEND_REACHED = 'backend install reached';

function git(cwd: string, args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=Station Test',
      '-c',
      'user.email=station-test@example.invalid',
      ...args,
    ],
    {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  ).trim();
}

function buildDirs(instance: string) {
  return instance === 'default'
    ? { server: 'dist-server', ui: 'dist-ui' }
    : { server: `dist-server-${instance}`, ui: `dist-ui-${instance}` };
}

function writeBundle(root: string, instance: string): void {
  const dirs = buildDirs(instance);
  mkdirSync(join(root, dirs.server), { recursive: true });
  mkdirSync(join(root, dirs.ui), { recursive: true });
  writeFileSync(join(root, dirs.server, 'command-station.js'), '// bundle\n');
  writeFileSync(join(root, dirs.ui, 'index.html'), '<!doctype html>\n');
}

type CheckoutKind = 'repo' | 'linked-worktree' | 'unreadable-head' | 'none';

/**
 * A checkout whose bundle for `instance` exists and is mtime-current.
 * `linked-worktree` is a `git worktree add` checkout, whose `.git` is a FILE;
 * `unreadable-head` has a `.git` file pointing nowhere, so git cannot read
 * HEAD; `none` is a packaged tree with no `.git` at all.
 */
function makeCheckout(
  kind: CheckoutKind,
  instance = 'default',
): { root: string; head?: string } {
  let root = makeTempDir('station-build-stamp-checkout-');
  if (kind === 'repo' || kind === 'linked-worktree') {
    git(root, ['init', '--quiet', '--initial-branch=main']);
    git(root, ['commit', '--quiet', '--allow-empty', '-m', 'fixture']);
  }
  if (kind === 'linked-worktree') {
    const linked = join(makeTempDir('station-build-stamp-linked-'), 'lane');
    git(root, ['worktree', 'add', '--quiet', '-b', 'lane', linked]);
    git(linked, ['commit', '--quiet', '--allow-empty', '-m', 'lane']);
    root = linked;
    expect(nodeFs.statSync(join(root, '.git')).isFile()).toBe(true);
  }
  if (kind === 'unreadable-head') {
    writeFileSync(join(root, '.git'), `gitdir: ${join(root, 'no-such-git')}\n`);
  }
  writeBundle(root, instance);
  return kind === 'repo' || kind === 'linked-worktree'
    ? { root, head: git(root, ['rev-parse', 'HEAD']) }
    : { root };
}

/** The exact shape `buildApplication` writes. */
function writeStamp(root: string, sha: string, instance = 'default'): void {
  writeFileSync(
    join(root, buildDirs(instance).server, 'station-build.json'),
    `${JSON.stringify({ sha, branch: 'main', builtAt: '2026-09-26T00:00:00.000Z' }, null, 2)}\n`,
  );
}

function readStampSha(root: string, instance = 'default'): string {
  return JSON.parse(
    readFileSync(
      join(root, buildDirs(instance).server, 'station-build.json'),
      'utf8',
    ),
  ).sha;
}

interface LoadOptions {
  /**
   * What the build's own provenance read (`git rev-parse HEAD` through
   * execSync, after both bundles) reports — standing in for HEAD moving while
   * the build ran, so the stamp it writes does not match HEAD afterwards.
   */
  stampWriterSha?: string;
}

async function loadAt(cwd: string, options: LoadOptions = {}) {
  vi.resetModules();
  const buildSteps: string[] = [];
  vi.doMock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    const execSync = ((
      command: string,
      execOptions?: { env?: NodeJS.ProcessEnv },
    ) => {
      if (command.startsWith('npm run ')) {
        buildSteps.push(command);
        const env = execOptions?.env ?? {};
        if (command === 'npm run build:server') {
          const dir = join(cwd, String(env.STATION_BUILD_SERVER_DIR));
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, 'command-station.js'), '// rebuilt\n');
        }
        if (command === 'npm run build:ui') {
          const dir = join(cwd, String(env.STATION_BUILD_UI_DIR));
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, 'index.html'), '<!doctype html>\n');
        }
        return '';
      }
      if (command === 'git rev-parse HEAD' && options.stampWriterSha) {
        return `${options.stampWriterSha}\n`;
      }
      return actual.execSync(command, execOptions as never);
    }) as typeof actual.execSync;
    return { ...actual, execSync };
  });
  vi.doMock('../commands/helpers.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../commands/helpers.js')>()),
    CWD: cwd,
  }));
  vi.doMock('../commands/service-systemd.js', () => ({
    installSystemd,
    startSystemd: vi.fn(),
    stopSystemd: vi.fn(),
    systemdRegistration: (instanceId: string) => ({
      platform: 'linux',
      unitName: `station-${instanceId}.service`,
      unitPath: join(cwd, `station-${instanceId}.service`),
    }),
    systemdStatus: vi.fn(),
    uninstallSystemd: vi.fn(),
  }));
  vi.doMock('@kontourai/station-shared/node-runtime', () => ({
    assertSupportedNodeVersion: vi.fn(),
  }));
  return {
    buildSteps,
    service: await import('../commands/service.js'),
    serviceRun: await import('../commands/service-run.js'),
  };
}

// Keep install independent of the host runner's Node layout (see service.test.ts).
const serviceFs = {
  ...nodeFs,
  realpathSync: (path: nodeFs.PathLike) =>
    path === process.execPath ? '/usr/bin/node' : nodeFs.realpathSync(path),
} as unknown as ServiceFs;

function lifecycleFor(baseDir: string, instanceName = 'default') {
  return {
    baseDir,
    homeSource: '--base' as const,
    host: '127.0.0.1',
    instanceName,
    serverPort: 3242,
    uiPort: 5274,
  };
}

beforeEach(() => {
  installSystemd.mockReset();
  installSystemd.mockImplementation(() => {
    throw new Error(BACKEND_REACHED);
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.doUnmock('node:child_process');
  vi.doUnmock('../commands/helpers.js');
  vi.doUnmock('../commands/service-systemd.js');
  vi.doUnmock('@kontourai/station-shared/node-runtime');
  vi.resetModules();
  vi.restoreAllMocks();
});

const BUILD_STEPS = [
  'npm run basis:mcp:generate',
  'npm run build:server',
  'npm run build:ui',
];

describe('service install repairs or refuses a source build without a matching stamp (station#2689)', () => {
  const install = async (
    cwd: string,
    options: LoadOptions & { instance?: string } = {},
  ) => {
    const { buildSteps, service } = await loadAt(cwd, options);
    const failure = await service
      .runServiceCommand(
        ['install'],
        lifecycleFor(
          makeTempDir('station-build-stamp-home-'),
          options.instance,
        ),
        {
          fs: serviceFs,
          platform: 'linux',
          run: vi.fn(() => ({ status: 1, stdout: '' })),
        },
      )
      .then(
        () => null,
        (error: Error) => error,
      );
    return { buildSteps, failure };
  };

  test('a missing stamp (the `npm run build` tree) is rebuilt and stamped with HEAD before the backend', async () => {
    const { root, head } = makeCheckout('repo');

    const { buildSteps, failure } = await install(root);

    expect(buildSteps).toEqual(BUILD_STEPS);
    expect(readStampSha(root)).toBe(head);
    expect(failure?.message).toBe(BACKEND_REACHED);
  });

  test('a stamp recording another sha is rebuilt to HEAD', async () => {
    const { root, head } = makeCheckout('repo');
    writeStamp(root, 'a'.repeat(40));

    const { buildSteps, failure } = await install(root);

    expect(buildSteps).toEqual(BUILD_STEPS);
    expect(readStampSha(root)).toBe(head);
    expect(failure?.message).toBe(BACKEND_REACHED);
  });

  test('refuses, naming `station build`, when the rebuild still leaves the stamp off HEAD', async () => {
    const { root, head } = makeCheckout('repo');
    const movedSha = 'b'.repeat(40);

    const { buildSteps, failure } = await install(root, {
      stampWriterSha: movedSha,
    });

    expect(buildSteps).toEqual(BUILD_STEPS);
    expect(failure?.message).toBe(
      `Cannot install Station user service default: build stamp ${join(root, 'dist-server', 'station-build.json')} records sha ${movedSha}, but the checkout HEAD is ${head} (after rebuilding). Run \`station build\` in ${root}, then rerun \`station service install\`.`,
    );
    expect(installSystemd).not.toHaveBeenCalled();
  });

  test('a stamp matching HEAD proceeds without building', async () => {
    const { root, head } = makeCheckout('repo');
    writeStamp(root, head!);

    const { buildSteps, failure } = await install(root);

    expect(buildSteps).toEqual([]);
    expect(failure?.message).toBe(BACKEND_REACHED);
  });

  test("a non-default instance reads its own dist-server-<id> stamp, not dist-server's", async () => {
    const { root, head } = makeCheckout('repo', 'svc-x');
    writeBundle(root, 'default');
    // A matching stamp only at the DEFAULT path must not satisfy svc-x.
    writeStamp(root, head!, 'default');

    const first = await install(root, { instance: 'svc-x' });
    expect(first.buildSteps).toEqual(BUILD_STEPS);
    expect(readStampSha(root, 'svc-x')).toBe(head);
    expect(first.failure?.message).toBe(BACKEND_REACHED);

    const second = await install(root, { instance: 'svc-x' });
    expect(second.buildSteps).toEqual([]);
    expect(second.failure?.message).toBe(BACKEND_REACHED);
  });

  test('a linked worktree (`.git` is a file) is judged against its own HEAD', async () => {
    const { root, head } = makeCheckout('linked-worktree');

    const { buildSteps, failure } = await install(root);

    expect(buildSteps).toEqual(BUILD_STEPS);
    expect(readStampSha(root)).toBe(head);
    expect(failure?.message).toBe(BACKEND_REACHED);
  });

  test('an unreadable HEAD with no stamp refuses without a futile build', async () => {
    const { root } = makeCheckout('unreadable-head');

    const { buildSteps, failure } = await install(root);

    expect(buildSteps).toEqual([]);
    expect(failure?.message).toMatch(
      new RegExp(
        `^Cannot install Station user service default: build stamp ${join(root, 'dist-server', 'station-build.json').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is missing or invalid, and the checkout HEAD cannot be read \\(.+\\), so no build can write it\\. Run \`station build\` in `,
        's',
      ),
    );
    expect(installSystemd).not.toHaveBeenCalled();
  });

  test('an unreadable HEAD with a stamp present is no verdict: it proceeds without building', async () => {
    const { root } = makeCheckout('unreadable-head');
    writeStamp(root, 'c'.repeat(40));

    const { buildSteps, failure } = await install(root);

    expect(buildSteps).toEqual([]);
    expect(failure?.message).toBe(BACKEND_REACHED);
  });

  test('a packaged tree (no .git) is out of scope and proceeds without a stamp', async () => {
    const { root } = makeCheckout('none');

    const { buildSteps, failure } = await install(root);

    expect(buildSteps).toEqual([]);
    expect(failure?.message).toBe(BACKEND_REACHED);
  });
});

describe('the service supervisor rebuilds a source build without a matching stamp (station#2689)', () => {
  const supervise = async (cwd: string) => {
    const { serviceRun } = await loadAt(cwd);
    const start = vi.fn().mockResolvedValue(undefined);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const baseDir = makeTempDir('station-build-stamp-home-');
    await serviceRun.superviseService(lifecycleFor(baseDir), {
      collect: vi.fn().mockResolvedValue({
        bootId: 'boot-1',
        found: true,
        healthy: true,
        instanceId: 'default',
        server: { listening: true, pid: 10, probe: 'ok', reachable: true },
        sha: 'abc',
        ui: { listening: true, pid: 11, probe: 'ok', reachable: true },
      }) as never,
      desktopCompanion: { check: vi.fn() },
      exit: vi.fn(),
      listListeningPids: () => [],
      now: () => 0,
      onSignal: vi.fn(),
      processIsAlive: () => true,
      publishServiceLiveness: vi.fn(),
      // Captured, never run: only the pre-start build decision is under test.
      setTimer: vi.fn(() => 1 as never),
      start,
      stop: vi.fn(),
    });
    expect(start).toHaveBeenCalledTimes(1);
    return {
      build: start.mock.calls[0]![0].build,
      errors: errors.mock.calls.map((call) => String(call[0])),
    };
  };

  test('builds before start when the stamp is missing', async () => {
    const { root } = makeCheckout('repo');
    expect((await supervise(root)).build).toBe(true);
  });

  test('builds before start when the stamp records another sha', async () => {
    const { root } = makeCheckout('repo');
    writeStamp(root, 'a'.repeat(40));
    expect((await supervise(root)).build).toBe(true);
  });

  test('reuses the bundle when the stamp matches HEAD', async () => {
    const { root, head } = makeCheckout('repo');
    writeStamp(root, head!);
    expect(await supervise(root)).toEqual({ build: false, errors: [] });
  });

  test('does not rebuild-loop when HEAD is unreadable and the stamp is missing; says why', async () => {
    const { root } = makeCheckout('unreadable-head');

    const outcome = await supervise(root);

    expect(outcome.build).toBe(false);
    expect(outcome.errors).toHaveLength(1);
    expect(outcome.errors[0]).toMatch(
      /^Station service default: not rebuilding — build stamp .* is missing or invalid, and the checkout HEAD cannot be read \(.+\), so no build can write it\. Make git able to read HEAD for this checkout, then run `station build`\.$/s,
    );
  });

  test('an unreadable HEAD with a stamp present starts as-is, silently', async () => {
    const { root } = makeCheckout('unreadable-head');
    writeStamp(root, 'c'.repeat(40));
    expect(await supervise(root)).toEqual({ build: false, errors: [] });
  });
});

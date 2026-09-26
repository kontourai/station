/**
 * station#2689: a source checkout built with `npm run build` has a current
 * bundle but no `dist-server/station-build.json`, so the supervised boot
 * expects sha `'unknown'` while the server reports its baked sha and every
 * boot fails "managed boot identity mismatch". These tests drive the REAL
 * lifecycle stamp check through its two production callers — `service
 * install` (refuses up front) and the `service run` supervisor (rebuilds) —
 * against a real git checkout fixture. Only the OS service backends and the
 * checkout root (`CWD`) are substituted.
 */
import { execFileSync } from 'node:child_process';
import * as nodeFs from 'node:fs';
import { mkdirSync, writeFileSync } from 'node:fs';
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

/** A checkout whose default-instance bundle exists and is mtime-current. */
function makeCheckout(options: { git: boolean }): {
  root: string;
  head?: string;
} {
  const root = makeTempDir('station-build-stamp-checkout-');
  mkdirSync(join(root, 'dist-server'), { recursive: true });
  mkdirSync(join(root, 'dist-ui'), { recursive: true });
  writeFileSync(join(root, 'dist-server', 'command-station.js'), '// bundle\n');
  writeFileSync(join(root, 'dist-ui', 'index.html'), '<!doctype html>\n');
  if (!options.git) return { root };
  git(root, ['init', '--quiet', '--initial-branch=main']);
  git(root, ['commit', '--quiet', '--allow-empty', '-m', 'fixture']);
  return { root, head: git(root, ['rev-parse', 'HEAD']) };
}

/** The exact shape `buildApplication` writes. */
function writeStamp(root: string, sha: string): void {
  writeFileSync(
    join(root, 'dist-server', 'station-build.json'),
    `${JSON.stringify({ sha, branch: 'main', builtAt: '2026-09-26T00:00:00.000Z' }, null, 2)}\n`,
  );
}

async function loadAt(cwd: string) {
  vi.resetModules();
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

function lifecycleFor(baseDir: string) {
  return {
    baseDir,
    homeSource: '--base' as const,
    host: '127.0.0.1',
    instanceName: 'default',
    serverPort: 3242,
    uiPort: 5274,
  };
}

beforeEach(() => {
  installSystemd.mockReset();
  installSystemd.mockImplementation(() => {
    throw new Error(BACKEND_REACHED);
  });
});

afterEach(() => {
  vi.doUnmock('../commands/helpers.js');
  vi.doUnmock('../commands/service-systemd.js');
  vi.doUnmock('@kontourai/station-shared/node-runtime');
  vi.resetModules();
});

describe('service install refuses a source build without a matching stamp (station#2689)', () => {
  const install = async (cwd: string) => {
    const { service } = await loadAt(cwd);
    return service
      .runServiceCommand(
        ['install'],
        lifecycleFor(makeTempDir('station-build-stamp-home-')),
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
  };

  test('a missing stamp (the `npm run build` tree) refuses before the backend, naming `station build`', async () => {
    const { root } = makeCheckout({ git: true });

    const failure = await install(root);

    expect(failure?.message).toBe(
      `Cannot install Station user service default: build stamp ${join(root, 'dist-server', 'station-build.json')} is missing or invalid (a plain \`npm run build\` does not write it). Run \`station build\` in ${root}, then rerun \`station service install\`.`,
    );
    expect(installSystemd).not.toHaveBeenCalled();
  });

  test('a stamp recording another sha refuses and names both shas', async () => {
    const { root, head } = makeCheckout({ git: true });
    const otherSha = 'a'.repeat(40);
    writeStamp(root, otherSha);

    const failure = await install(root);

    expect(failure?.message).toContain(
      `records sha ${otherSha}, but the checkout HEAD is ${head}`,
    );
    expect(failure?.message).toContain('Run `station build`');
    expect(installSystemd).not.toHaveBeenCalled();
  });

  test('a stamp matching HEAD proceeds to the backend install', async () => {
    const { root, head } = makeCheckout({ git: true });
    writeStamp(root, head!);

    const failure = await install(root);

    expect(failure?.message).toBe(BACKEND_REACHED);
    expect(installSystemd).toHaveBeenCalledTimes(1);
  });

  test('a packaged tree (no .git) is out of scope and proceeds without a stamp', async () => {
    const { root } = makeCheckout({ git: false });

    const failure = await install(root);

    expect(failure?.message).toBe(BACKEND_REACHED);
    expect(installSystemd).toHaveBeenCalledTimes(1);
  });
});

describe('the service supervisor rebuilds a source build without a matching stamp (station#2689)', () => {
  const supervisedBuildFlag = async (cwd: string) => {
    const { serviceRun } = await loadAt(cwd);
    const start = vi.fn().mockResolvedValue(undefined);
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
    return start.mock.calls[0]![0].build;
  };

  test('builds before start when the stamp is missing', async () => {
    const { root } = makeCheckout({ git: true });
    expect(await supervisedBuildFlag(root)).toBe(true);
  });

  test('reuses the bundle when the stamp matches HEAD', async () => {
    const { root, head } = makeCheckout({ git: true });
    writeStamp(root, head!);
    expect(await supervisedBuildFlag(root)).toBe(false);
  });
});

import { type ChildProcess, spawn } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { upsertInstance } from '../../../packages/shared/src/instance-registry.js';
import { ensureStationHomeSchemaSync } from '../../../packages/shared/src/station-home-schema.js';

const repoRoot = resolve(import.meta.dirname, '../../..');
export const LAUNCHER_SOURCE = join(
  repoRoot,
  'packaging',
  'portable-server',
  'bin',
  'station-launcher.mjs',
);
const STATION_MJS = join(
  repoRoot,
  'packaging',
  'portable-server',
  'bin',
  'station.mjs',
);

/** The launcher-aware fixture CLI, bundled like the archive's real one. */
export async function bundleLauncherFixtureCli(): Promise<string> {
  const result = await build({
    entryPoints: [join(import.meta.dirname, 'launcher-fixture-cli.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    write: false,
    logLevel: 'silent',
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
  });
  return result.outputFiles[0].text;
}

export type FixtureBehavior = {
  trial?: 'prepare' | 'exit' | 'hang';
  ignoreTerm?: boolean;
  homeSchemaVersion?: number;
  stage?: string;
};

export type LauncherInstall = {
  root: string;
  installRoot: string;
  home: string;
  log: string;
  launcher: string;
};

export const INSTANCE = 'svc';

/** A stable-channel `.station-release.json` for `version`. */
export function releaseProvenance(version: string): string {
  return `${JSON.stringify({
    schemaVersion: 2,
    sha: 'a'.repeat(40),
    ref: `v${version}`,
    createdAt: '2026-09-26T00:00:00.000Z',
    channel: 'stable',
    releaseChannel: 'stable',
    prerelease: false,
  })}\n`;
}

/** A completed version in install.sh's layout, running the fixture CLI. */
export function addVersion(
  install: LauncherInstall,
  cli: string,
  version: string,
  behavior: FixtureBehavior = {},
  options: { complete?: boolean } = {},
): string {
  const dir = join(install.installRoot, 'versions', version);
  mkdirSync(join(dir, 'bin'), { recursive: true });
  mkdirSync(join(dir, 'lib'), { recursive: true });
  mkdirSync(join(dir, 'runtime', 'bin'), { recursive: true });
  copyFileSync(STATION_MJS, join(dir, 'bin', 'station.mjs'));
  copyFileSync(LAUNCHER_SOURCE, join(dir, 'bin', 'station-launcher.mjs'));
  writeFileSync(join(dir, 'lib', 'station-cli.mjs'), cli);
  writeFileSync(join(dir, '.station-release.json'), releaseProvenance(version));
  writeFileSync(join(dir, 'fixture.json'), JSON.stringify(behavior));
  symlinkSync(process.execPath, join(dir, 'runtime', 'bin', 'node'));
  if (options.complete !== false)
    writeFileSync(join(dir, '.station-install-complete'), 'f'.repeat(64));
  return dir;
}

/**
 * An install root whose `current` is `active`, a stopped service home with
 * its registry entry, and the fixed launcher where `service install` puts it.
 */
export function makeLauncherInstall(root: string): LauncherInstall {
  const installRoot = join(root, 'installs', 'stable');
  const home = join(root, 'instances', 'stable');
  mkdirSync(join(installRoot, 'versions'), { recursive: true });
  ensureStationHomeSchemaSync(home);
  mkdirSync(join(home, 'config'), { recursive: true });
  writeFileSync(join(home, 'config', 'app.json'), '{"model":"before"}\n');
  upsertInstance(INSTANCE, { port: 3999, uiPort: 3998, type: 'service' }, home);
  mkdirSync(join(installRoot, 'runtime'), { recursive: true });
  const launcher = join(installRoot, 'runtime', 'station-launcher.mjs');
  copyFileSync(LAUNCHER_SOURCE, launcher);
  chmodSync(launcher, 0o644);
  return { root, installRoot, home, log: join(root, 'fixture.log'), launcher };
}

export function pointCurrent(install: LauncherInstall, version: string): void {
  symlinkSync(
    join(install.installRoot, 'versions', version),
    join(install.installRoot, 'current'),
  );
}

/** Fast timings for tests; production values are pinned separately. */
export const TEST_TIMINGS = {
  stopGraceMs: 1_500,
  ownStopTimeoutMs: 30_000,
  handoffAckMs: 5_000,
  preparedTimeoutMs: 6_000,
};

export type RunningLauncher = {
  process: ChildProcess;
  output: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

export function startLauncher(
  install: LauncherInstall,
  env: Record<string, string> = {},
): RunningLauncher {
  const { STATION_CHANNEL: _channel, ...inherited } = process.env;
  const child = spawn(
    process.execPath,
    [
      install.launcher,
      'service',
      'run',
      `--instance=${INSTANCE}`,
      `--base=${install.home}`,
      '--port=3999',
      '--ui-port=3998',
    ],
    {
      env: {
        ...inherited,
        STATION_FIXTURE_LOG: install.log,
        STATION_LAUNCHER_TEST_TIMINGS: JSON.stringify(TEST_TIMINGS),
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  let output = '';
  child.stdout?.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr?.on('data', (chunk) => {
    output += chunk;
  });
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolvePromise) =>
    child.once('exit', (code, signal) => resolvePromise({ code, signal })),
  );
  return { process: child, output: () => output, exited };
}

export function fixtureLog(install: LauncherInstall): string[] {
  return existsSync(install.log)
    ? readFileSync(install.log, 'utf8').trim().split('\n').filter(Boolean)
    : [];
}

export function readState(install: LauncherInstall): {
  activeVersion: string;
  update?: Record<string, unknown> & {
    status: string;
    phase?: string;
    reason?: string;
    attempts: number;
    id: string;
  };
} | null {
  try {
    return JSON.parse(
      readFileSync(
        join(install.installRoot, 'runtime', 'service-state.json'),
        'utf8',
      ),
    );
  } catch {
    return null;
  }
}

export async function waitFor<T>(
  what: string,
  probe: () => T | undefined | null | false,
  timeoutMs = 30_000,
  diagnostics: () => string = () => '',
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}\n${diagnostics()}`);
}

export function homeSchemaVersion(install: LauncherInstall): unknown {
  return JSON.parse(
    readFileSync(join(install.home, '.station-home-schema.json'), 'utf8'),
  ).version;
}

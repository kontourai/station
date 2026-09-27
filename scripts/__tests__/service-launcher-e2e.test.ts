import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { writeServiceUpdateRequest } from '../../packages/cli/src/commands/service-launcher-link.js';
import { upsertInstance } from '../../packages/shared/src/instance-registry.js';
import { ensureStationHomeSchemaSync } from '../../packages/shared/src/station-home-schema.js';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  buildPrebuiltArchive,
  renameGuardedNode,
  signArchiveManifest,
} from './fixtures/prebuilt-archive.js';
import {
  bundleLauncherFixtureCli,
  fixtureLog,
  homeSchemaVersion,
  INSTANCE,
  type LauncherInstall,
  type RunningLauncher,
  readState,
  startLauncher,
  waitFor,
} from './fixtures/service-launcher-harness.js';

const installScript = resolve(import.meta.dirname, '../../install.sh');
const RELEASE_KEY_ID = 'station-portable-release-2026-09';
const makeTempDir = trackTempDirs();
let cli = '';
const running: RunningLauncher[] = [];

beforeAll(async () => {
  cli = await bundleLauncherFixtureCli();
}, 60_000);

afterEach(async () => {
  for (const launcher of running.splice(0)) {
    if (
      launcher.process.exitCode === null &&
      launcher.process.signalCode === null
    ) {
      launcher.process.kill('SIGTERM');
      await launcher.exited;
    }
  }
});

/**
 * Two real archives in the builder's layout, installed and updated the way a
 * host would: install.sh installs N from a signed manifest; the service's
 * launcher runs N; the rolling manifest then names N+1; a request makes N's
 * supervisor stage N+1 with N's own install.sh (stage-only), and the launcher
 * trials it. N+1 migrates the home schema (2 -> 3) on boot.
 */
async function twoArchiveInstall(nextTrial: 'prepare' | 'exit') {
  const root = makeTempDir('station-launcher-e2e-');
  const home = join(root, 'home');
  const stationRoot = join(home, '.station');
  const installRoot = join(stationRoot, 'installs', 'stable');
  const stationHome = join(stationRoot, 'instances', 'stable');
  mkdirSync(home, { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicKeyPath = join(root, 'test-public.pem');
  writeFileSync(
    publicKeyPath,
    publicKey.export({ format: 'pem', type: 'spki' }),
  );
  const guard = join(root, 'rename-guard');
  mkdirSync(guard);
  writeFileSync(join(guard, 'node'), renameGuardedNode(), { mode: 0o755 });

  const current = buildPrebuiltArchive(root, '1.0.0', {
    cli,
    extraFiles: { 'fixture.json': JSON.stringify({ stage: 'real' }) },
  });
  const next = buildPrebuiltArchive(root, '1.1.0', {
    cli,
    extraFiles: {
      'fixture.json': JSON.stringify({
        trial: nextTrial,
        homeSchemaVersion: 3,
      }),
    },
  });
  const rolling = 'rolling-manifest.json';
  const manifestPath = signArchiveManifest(
    root,
    current,
    privateKey,
    RELEASE_KEY_ID,
    { name: rolling },
  );
  const { STATION_CHANNEL: _channel, ...inherited } = process.env;
  const env = {
    ...inherited,
    PATH: `${guard}:${process.env.PATH ?? ''}`,
    HOME: home,
    GH_TOKEN: '',
    GITHUB_TOKEN: '',
    STATION_ROOT: stationRoot,
    STATION_HOME: stationHome,
    STATION_INSTALL_ROOT: installRoot,
    STATION_BIN_DIR: join(home, '.local', 'bin'),
    STATION_VERSION: '',
    STATION_INSTALL_ALLOW_ROLLBACK: '',
    STATION_INSTALL_PUBLIC_MANIFEST_URL: pathToFileURL(manifestPath).href,
    STATION_INSTALL_MANIFEST_PUBLIC_KEY_URL: pathToFileURL(publicKeyPath).href,
    STATION_INSTALL_ALLOW_INSECURE_TEST_URLS: '1',
    STATION_INSTALL_SERVER_PORT: '',
    STATION_INSTALL_UI_PORT: '',
    STATION_SERVER_PORT: '',
    STATION_UI_PORT: '',
  };
  const installed = spawnSync('sh', [installScript], {
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
    env: { ...env, STATION_INSTALL_NO_START: '1' },
  });
  expect(installed.status, installed.stderr).toBe(0);

  // What `station service install` leaves: the service's registry entry and
  // the fixed launcher copied out of the active version.
  ensureStationHomeSchemaSync(stationHome);
  upsertInstance(
    INSTANCE,
    { port: 3999, uiPort: 3998, type: 'service' },
    stationHome,
  );
  mkdirSync(join(installRoot, 'runtime'), { recursive: true });
  const launcherPath = join(installRoot, 'runtime', 'station-launcher.mjs');
  copyFileSync(
    join(installRoot, 'current', 'bin', 'station-launcher.mjs'),
    launcherPath,
  );
  const install: LauncherInstall = {
    root,
    installRoot,
    home: stationHome,
    log: join(root, 'fixture.log'),
    launcher: launcherPath,
  };
  // The staging install.sh reads the manifest URL from the install state,
  // not from this environment.
  const {
    STATION_INSTALL_PUBLIC_MANIFEST_URL: _url,
    STATION_ROOT: _root,
    STATION_HOME: _home,
    STATION_INSTALL_ROOT: _installRoot,
    ...launcherEnv
  } = env;
  const launcher = startLauncher(
    install,
    launcherEnv as Record<string, string>,
  );
  running.push(launcher);
  await waitFor(
    'N ready',
    () => {
      if (launcher.process.exitCode !== null)
        throw new Error(`the launcher exited:\n${launcher.output()}`);
      return fixtureLog(install).includes('1.0.0 ready');
    },
    30_000,
  );
  // The rolling manifest moves on to N+1.
  signArchiveManifest(root, next, privateKey, RELEASE_KEY_ID, {
    name: rolling,
  });
  return { install, launcher, env, manifestPath };
}

function finished(install: LauncherInstall) {
  const update = readState(install)?.update;
  return update && update.status !== 'pending' ? update : undefined;
}

describe('a service updates itself across two real archives (#2675 D)', {
  timeout: 180_000,
}, () => {
  it('stages N+1 with N’s own installer, trials it, and commits it with its schema bump', async () => {
    const { install, launcher } = await twoArchiveInstall('prepare');
    expect(homeSchemaVersion(install)).toBe(2);
    const request = writeServiceUpdateRequest(install.installRoot);
    const update = await waitFor(
      'the update to finish',
      () => finished(install),
      120_000,
      () => `${fixtureLog(install).join('\n')}\n${launcher.output()}`,
    );
    expect(update).toMatchObject({
      status: 'committed',
      fromVersion: '1.0.0',
      targetVersion: '1.1.0',
      requestId: request.id,
    });
    const staged = join(install.installRoot, 'versions', '1.1.0');
    // install.sh staged it exactly as an install would: complete and sealed.
    expect(
      readFileSync(join(staged, '.station-install-complete'), 'utf8'),
    ).toMatch(/^[0-9a-f]{64}\n$/);
    expect(lstatSync(staged).mode & 0o222).toBe(0);
    expect(realpathSync(join(install.installRoot, 'current'))).toBe(
      realpathSync(staged),
    );
    expect(homeSchemaVersion(install)).toBe(3);
    expect(readState(install)?.activeVersion).toBe('1.1.0');
  });

  it('rolls N+1 back after it bumped the schema and crashed, and N serves the restored home', async () => {
    const { install, launcher } = await twoArchiveInstall('exit');
    writeServiceUpdateRequest(install.installRoot);
    const update = await waitFor(
      'the update to finish',
      () => finished(install),
      120_000,
      () => `${fixtureLog(install).join('\n')}\n${launcher.output()}`,
    );
    expect(update).toMatchObject({
      status: 'rolled-back',
      reason: 'candidate-exited:3',
    });
    expect(fixtureLog(install)).toContain('1.1.0 schema 3');
    await waitFor(
      'N serving again',
      () =>
        fixtureLog(install).filter((line) => line === '1.0.0 ready').length ===
        2,
    );
    expect(homeSchemaVersion(install)).toBe(2);
    expect(existsSync(join(install.home, 'config', 'trial-wrote.json'))).toBe(
      false,
    );
    expect(realpathSync(join(install.installRoot, 'current'))).toBe(
      realpathSync(join(install.installRoot, 'versions', '1.0.0')),
    );
  });

  it('install.sh (station upgrade) hands the switch to a running launcher service and reports its verdict', async () => {
    const { install, env, manifestPath } = await twoArchiveInstall('prepare');
    const installRoot = realpathSync(install.installRoot);
    // The manifest `service install` records for this unit (#2675 C).
    mkdirSync(join(install.home, 'service'), { recursive: true });
    writeFileSync(
      join(install.home, 'service', `${INSTANCE}.json`),
      JSON.stringify({
        platform: process.platform,
        kind: 'archive',
        installRoot,
        instanceId: INSTANCE,
        repoPath: join(installRoot, 'current'),
        serverPort: 3999,
        uiPort: 3998,
      }),
    );
    const upgraded = spawnSync('sh', [installScript], {
      encoding: 'utf8',
      timeout: 120_000,
      windowsHide: true,
      env: {
        ...env,
        STATION_INSTALL_PUBLIC_MANIFEST_URL: pathToFileURL(manifestPath).href,
      },
    });
    expect(upgraded.status, `${upgraded.stdout}\n${upgraded.stderr}`).toBe(0);
    expect(upgraded.stdout).toContain('The Station service now runs 1.1.0.');
    expect(readState(install)).toMatchObject({
      activeVersion: '1.1.0',
      update: { status: 'committed', targetVersion: '1.1.0' },
    });
    // The service's own supervisor did not stage it a second time.
    expect(fixtureLog(install)).toContain('1.1.0 ready');
    expect(realpathSync(join(install.installRoot, 'current'))).toBe(
      realpathSync(join(install.installRoot, 'versions', '1.1.0')),
    );
  });
});

import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  buildWindowsArchive,
  extractInstallerCore,
  signWindowsManifest,
  type WindowsArchive,
} from './fixtures/windows-archive.js';

/**
 * install.ps1's full install and uninstall (#2675 slice W2), through the
 * installer core exactly as install.ps1 embeds it: the generated base64
 * block decoded and run with this Node.js as a child, as the PowerShell
 * bootstrap runs it. The fixture archives' runtime/node.exe wraps this
 * Node.js and their CLI records every run (fixtures/windows-archive.ts), so
 * the stop, switch, start and rollback of a real install run here; the
 * Windows-only pieces (the junction, ACLs, cmd.exe) run on the Windows
 * install-smoke leg.
 */

const makeTempDir = trackTempDirs();
const NIGHTLY_KEY_ID = 'station-portable-nightly-2026-09';
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) => new Promise((done) => server.close(() => done(undefined))),
      ),
  );
});

type Fixture = {
  dir: string;
  core: string;
  stationRoot: string;
  installRoot: string;
  home: string;
  binDir: string;
  launcher: string;
  log: string;
  keyUrl: string;
  key: KeyObject;
};

function fixture(): Fixture {
  const dir = makeTempDir('station-install-ps1-full-');
  const pair = generateKeyPairSync('ed25519');
  const keyPath = join(dir, 'test-key.pem');
  writeFileSync(
    keyPath,
    pair.publicKey.export({ format: 'pem', type: 'spki' }) as string,
  );
  const stationRoot = join(dir, 'root');
  const binDir = join(dir, 'bin');
  return {
    dir,
    core: extractInstallerCore(dir),
    stationRoot,
    installRoot: join(stationRoot, 'installs', 'nightly'),
    home: join(stationRoot, 'instances', 'nightly'),
    binDir,
    launcher: join(binDir, 'station-nightly.cmd'),
    log: join(dir, 'cli.log'),
    keyUrl: pathToFileURL(keyPath).href,
    key: pair.privateKey,
  };
}

/** Two loopback ports nothing listens on (the nightly port probe needs that). */
async function freePorts(): Promise<[number, number]> {
  const ports: number[] = [];
  for (let index = 0; index < 2; index += 1) {
    const server = createServer();
    await new Promise<void>((ready) =>
      server.listen(0, '127.0.0.1', () => ready()),
    );
    ports.push((server.address() as { port: number }).port);
    await new Promise((done) => server.close(done));
  }
  return [ports[0], ports[1]];
}

function core(
  f: Fixture,
  env: Record<string, string>,
  argv: string[] = ['install'],
) {
  const result = spawnSync(process.execPath, [f.core, ...argv], {
    cwd: f.dir,
    encoding: 'utf8',
    windowsHide: true,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: join(f.dir, 'home'),
      STATION_ROOT: f.stationRoot,
      STATION_BIN_DIR: f.binDir,
      STATION_CHANNEL: 'nightly',
      STATION_INSTALL_MANIFEST_PUBLIC_KEY_URL: f.keyUrl,
      STATION_INSTALL_ALLOW_INSECURE_TEST_URLS: '1',
      STATION_INSTALL_TEST_HOST_TARGET: 'win32-x64',
      STATION_TEST_CLI_LOG: f.log,
      ...env,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function install(
  f: Fixture,
  archive: WindowsArchive,
  env: Record<string, string> = {},
) {
  return core(f, {
    STATION_INSTALL_PUBLIC_MANIFEST_URL: signWindowsManifest(
      f.dir,
      archive,
      f.key,
      NIGHTLY_KEY_ID,
      { name: `manifest-${archive.version}-${Math.random()}.json` },
    ),
    ...env,
  });
}

type CliRun = {
  version: string;
  args: string[];
  cwd: string;
  channel: string;
  root: string;
  home: string;
  installRoot: string;
};

/** The CLI runs recorded since the last call, oldest first. */
function takeCliRuns(f: Fixture): CliRun[] {
  if (!existsSync(f.log)) return [];
  const runs = readFileSync(f.log, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CliRun);
  writeFileSync(f.log, '');
  return runs;
}

const verbs = (runs: CliRun[]) =>
  runs.map((run) => `${run.args[0]}@${run.version}`);

function currentVersion(f: Fixture): string | null {
  const current = join(f.installRoot, 'current');
  if (!existsSync(current)) return null;
  expect(lstatSync(current).isSymbolicLink()).toBe(true);
  return realpathSync(current).split(/[\\/]/).at(-1) ?? null;
}

function versionDirs(f: Fixture): string[] {
  const versions = join(f.installRoot, 'versions');
  return existsSync(versions) ? readdirSync(versions).sort() : [];
}

function state(f: Fixture) {
  return JSON.parse(
    readFileSync(join(f.installRoot, '.station-release-state.json'), 'utf8'),
  );
}

const real = (path: string) => realpathSync(path);

describe('install.ps1 installer core: full install (#2675 W2)', () => {
  it('installs: current, the owned launcher, schema 4 state and a start on the resolved ports', async () => {
    const f = fixture();
    const [server, ui] = await freePorts();
    const archive = buildWindowsArchive(f.dir, '0.7.0-nightly.12');
    const result = install(f, archive, {
      STATION_INSTALL_SERVER_PORT: String(server),
      STATION_INSTALL_UI_PORT: String(ui),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(currentVersion(f)).toBe('0.7.0-nightly.12');
    expect(
      readFileSync(
        join(f.installRoot, 'current', '.station-install-complete'),
        'utf8',
      ),
    ).toBe(`${archive.sha256}\n`);

    const root = real(f.stationRoot);
    const installRoot = real(f.installRoot);
    const home = real(f.home);
    expect(readFileSync(f.launcher, 'utf8')).toBe(
      [
        '@echo off',
        'rem station-owned-launcher-v2',
        'setlocal EnableExtensions DisableDelayedExpansion',
        'set "STATION_CHANNEL=nightly"',
        `set "STATION_ROOT=${root}"`,
        `set "STATION_HOME=${home}"`,
        `set "STATION_INSTALL_ROOT=${installRoot}"`,
        `"${join(installRoot, 'current', 'bin', 'station.cmd')}" %*`,
        '',
      ].join('\r\n'),
    );
    const manifestUrl = state(f).manifestUrl;
    expect(state(f)).toEqual({
      schemaVersion: 4,
      channel: 'nightly',
      releaseChannel: 'nightly',
      installRoot,
      stationRoot: root,
      stationHome: home,
      manifestUrl,
      serverPort: server,
      uiPort: ui,
    });
    expect(manifestUrl).toMatch(/^file:.*manifest-0\.7\.0-nightly\.12-/);
    expect(
      readFileSync(join(f.home, '.station-portable-data-root'), 'utf8'),
    ).toBe('station-portable-data-root-v1\n');

    // A first install has nothing to stop; it starts the version itself,
    // from its own directory, with the install's identity and ports.
    const runs = takeCliRuns(f);
    expect(verbs(runs)).toEqual(['start@0.7.0-nightly.12']);
    expect(runs[0]).toMatchObject({
      args: ['start', `--base=${home}`, `--port=${server}`, `--ui-port=${ui}`],
      cwd: real(join(f.installRoot, 'versions', '0.7.0-nightly.12')),
      channel: 'nightly',
      root,
      home,
      installRoot,
    });
    expect(result.stdout).toContain(`Open http://localhost:${ui}`);
    expect(result.stdout).toContain(`Add ${real(f.binDir)} to PATH`);
  });

  it('upgrades: stops the old version, switches, starts the new, keeps the previous and prunes the rest, on the recorded ports', async () => {
    const f = fixture();
    const [server, ui] = await freePorts();
    const ports = {
      STATION_INSTALL_SERVER_PORT: String(server),
      STATION_INSTALL_UI_PORT: String(ui),
    };
    for (const version of ['0.7.0-nightly.11', '0.7.0-nightly.12'])
      expect(
        install(f, buildWindowsArchive(f.dir, version), ports).status,
      ).toBe(0);
    takeCliRuns(f);

    // No ports named, and the CLI's bootstrap ports in the environment
    // (decision D8): the recorded ports win over both.
    const result = install(
      f,
      buildWindowsArchive(f.dir, '0.7.0-nightly.13', { sha: 'b'.repeat(40) }),
      { STATION_SERVER_PORT: '1111', STATION_UI_PORT: '2222' },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(currentVersion(f)).toBe('0.7.0-nightly.13');
    const runs = takeCliRuns(f);
    expect(verbs(runs)).toEqual([
      'stop@0.7.0-nightly.12',
      'start@0.7.0-nightly.13',
    ]);
    expect(runs[1].args).toEqual([
      'start',
      `--base=${real(f.home)}`,
      `--port=${server}`,
      `--ui-port=${ui}`,
    ]);
    expect(state(f)).toMatchObject({ serverPort: server, uiPort: ui });
    expect(versionDirs(f)).toEqual(['0.7.0-nightly.12', '0.7.0-nightly.13']);
  });

  it('returns once Station starts, though the started Station keeps running with output open', async () => {
    const f = fixture();
    const [server, ui] = await freePorts();
    const began = Date.now();
    const result = install(f, buildWindowsArchive(f.dir, '0.7.0-nightly.12'), {
      STATION_INSTALL_SERVER_PORT: String(server),
      STATION_INSTALL_UI_PORT: String(ui),
      STATION_TEST_CLI_LINGER_MS: '30000',
    });
    expect(result.status, result.stderr).toBe(0);
    // Had the started process inherited the installer's own output, reading
    // that output to its end would have waited the full 30 s.
    expect(Date.now() - began).toBeLessThan(20_000);
    expect(verbs(takeCliRuns(f))).toEqual(['start@0.7.0-nightly.12']);
  });

  it('uses the channel default ports when nothing is recorded or named', () => {
    const f = fixture();
    const result = install(f, buildWindowsArchive(f.dir, '0.7.0-nightly.12'), {
      STATION_INSTALL_NO_START: '1',
      STATION_SERVER_PORT: '1111',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(state(f)).toMatchObject({ serverPort: 38141, uiPort: 38000 });
    expect(takeCliRuns(f)).toEqual([]);
    expect(result.stdout).toContain(
      `Start it with: ${join(real(f.binDir), 'station-nightly.cmd')} start`,
    );
  });

  it('refuses a downgrade without the explicit opt-in, and changes nothing', async () => {
    const f = fixture();
    const [server, ui] = await freePorts();
    const ports = {
      STATION_INSTALL_SERVER_PORT: String(server),
      STATION_INSTALL_UI_PORT: String(ui),
    };
    expect(
      install(f, buildWindowsArchive(f.dir, '0.7.0-nightly.13'), ports).status,
    ).toBe(0);
    takeCliRuns(f);
    const before = readFileSync(
      join(f.installRoot, '.station-release-state.json'),
    );
    const refused = install(f, buildWindowsArchive(f.dir, '0.7.0-nightly.12'));
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(
      'Station install failed: refusing to downgrade Station from v0.7.0-nightly.13 to v0.7.0-nightly.12',
    );
    expect(currentVersion(f)).toBe('0.7.0-nightly.13');
    expect(versionDirs(f)).toEqual(['0.7.0-nightly.13']);
    expect(takeCliRuns(f)).toEqual([]);
    expect(
      readFileSync(join(f.installRoot, '.station-release-state.json')),
    ).toEqual(before);

    const again = install(f, buildWindowsArchive(f.dir, '0.7.0-nightly.13'));
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toContain(
      'Station v0.7.0-nightly.13 is already installed; nothing to do.',
    );
    expect(takeCliRuns(f)).toEqual([]);

    const rollback = install(
      f,
      buildWindowsArchive(f.dir, '0.7.0-nightly.12'),
      {
        ...ports,
        STATION_VERSION: 'v0.7.0-nightly.12',
        STATION_INSTALL_ALLOW_ROLLBACK: '1',
      },
    );
    expect(rollback.status, rollback.stderr).toBe(0);
    expect(currentVersion(f)).toBe('0.7.0-nightly.12');
  });

  it('replaces the active version with different bytes of the same version only when asked', async () => {
    const f = fixture();
    const [server, ui] = await freePorts();
    const ports = {
      STATION_INSTALL_SERVER_PORT: String(server),
      STATION_INSTALL_UI_PORT: String(ui),
    };
    expect(
      install(f, buildWindowsArchive(f.dir, '0.7.0-nightly.12'), ports).status,
    ).toBe(0);
    const republished = buildWindowsArchive(f.dir, '0.7.0-nightly.12', {
      variant: 'b',
    });
    const refused = install(f, republished, ports);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(
      'refusing to replace the installed Station v0.7.0-nightly.12 with different bytes published as the same version',
    );
    takeCliRuns(f);
    const replaced = install(f, republished, {
      ...ports,
      STATION_VERSION: 'v0.7.0-nightly.12',
      STATION_INSTALL_ALLOW_ROLLBACK: '1',
    });
    expect(replaced.status, replaced.stderr).toBe(0);
    expect(verbs(takeCliRuns(f))).toEqual([
      'stop@0.7.0-nightly.12',
      'start@0.7.0-nightly.12',
    ]);
    expect(existsSync(join(f.installRoot, 'current', 'variant-b'))).toBe(true);
    // The displaced bytes stay as the rollback target.
    expect(versionDirs(f)).toHaveLength(2);
  });

  it('restores the previous release when the new one does not start', async () => {
    const f = fixture();
    const [server, ui] = await freePorts();
    const ports = {
      STATION_INSTALL_SERVER_PORT: String(server),
      STATION_INSTALL_UI_PORT: String(ui),
    };
    expect(
      install(f, buildWindowsArchive(f.dir, '0.7.0-nightly.12'), ports).status,
    ).toBe(0);
    takeCliRuns(f);
    const stateBefore = readFileSync(
      join(f.installRoot, '.station-release-state.json'),
    );
    const launcherBefore = readFileSync(f.launcher);
    const [newServer, newUi] = await freePorts();
    const failed = install(f, buildWindowsArchive(f.dir, '0.7.0-nightly.13'), {
      STATION_INSTALL_SERVER_PORT: String(newServer),
      STATION_INSTALL_UI_PORT: String(newUi),
      STATION_TEST_CLI_FAIL: 'start@0.7.0-nightly.13',
    });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain(
      'Station install failed: the new release did not start; the previous release was restored',
    );
    expect(currentVersion(f)).toBe('0.7.0-nightly.12');
    expect(
      readFileSync(join(f.installRoot, '.station-release-state.json')),
    ).toEqual(stateBefore);
    expect(readFileSync(f.launcher)).toEqual(launcherBefore);
    const runs = takeCliRuns(f);
    expect(verbs(runs)).toEqual([
      'stop@0.7.0-nightly.12',
      'start@0.7.0-nightly.13',
      'stop@0.7.0-nightly.13',
      'start@0.7.0-nightly.12',
    ]);
    // The new release was tried on the requested ports; the restored one
    // comes back on the ports its restored state records.
    expect(runs[1].args).toContain(`--port=${newServer}`);
    expect(runs[3].args).toEqual([
      'start',
      `--base=${real(f.home)}`,
      `--port=${server}`,
      `--ui-port=${ui}`,
    ]);
  });

  it('removes a first install that does not start', async () => {
    const f = fixture();
    const [server, ui] = await freePorts();
    const failed = install(f, buildWindowsArchive(f.dir, '0.7.0-nightly.12'), {
      STATION_INSTALL_SERVER_PORT: String(server),
      STATION_INSTALL_UI_PORT: String(ui),
      STATION_TEST_CLI_FAIL: 'start@0.7.0-nightly.12',
    });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain(
      'the new release did not start; the incomplete install was removed',
    );
    expect(existsSync(join(f.installRoot, 'current'))).toBe(false);
    expect(existsSync(f.launcher)).toBe(false);
    expect(existsSync(join(f.installRoot, '.station-release-state.json'))).toBe(
      false,
    );
  });

  it('writes paths beneath a non-ASCII profile relative to %USERPROFILE%, so the launcher is ASCII', () => {
    const f = fixture();
    const profile = join(f.dir, 'José');
    mkdirSync(profile);
    const root = join(profile, '.station');
    const result = install(f, buildWindowsArchive(f.dir, '0.7.0-nightly.12'), {
      HOME: profile,
      STATION_ROOT: root,
      STATION_BIN_DIR: join(profile, '.local', 'bin'),
      STATION_INSTALL_NO_START: '1',
    });
    expect(result.status, result.stderr).toBe(0);
    const text = readFileSync(
      join(profile, '.local', 'bin', 'station-nightly.cmd'),
      'utf8',
    );
    expect(text).toMatch(/^[\x20-\x7e\r\n]*$/);
    const sep = join('a', 'b').slice(1, 2);
    const installRoot = ['.station', 'installs', 'nightly'].join(sep);
    expect(text).toContain(`set "STATION_ROOT=%USERPROFILE%${sep}.station"`);
    expect(text).toContain(
      `set "STATION_HOME=%USERPROFILE%${sep}${['.station', 'instances', 'nightly'].join(sep)}"`,
    );
    expect(text).toContain(
      `set "STATION_INSTALL_ROOT=%USERPROFILE%${sep}${installRoot}"`,
    );
    expect(text).toContain(
      `"%USERPROFILE%${sep}${[installRoot, 'current', 'bin', 'station.cmd'].join(sep)}" %*`,
    );
    // The same install again recognizes the launcher as its own.
    const again = install(f, buildWindowsArchive(f.dir, '0.7.0-nightly.13'), {
      HOME: profile,
      STATION_ROOT: root,
      STATION_BIN_DIR: join(profile, '.local', 'bin'),
      STATION_INSTALL_NO_START: '1',
    });
    expect(again.status, again.stderr).toBe(0);
  });

  it('refuses a non-ASCII path the launcher would have to hold literally', () => {
    const f = fixture();
    const result = install(f, buildWindowsArchive(f.dir, '0.7.0-nightly.12'), {
      STATION_HOME: join(f.stationRoot, 'instances', 'Zoë'),
      STATION_INSTALL_NO_START: '1',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'a Station path has a non-ASCII part the Windows launcher cannot hold',
    );
    expect(existsSync(join(f.installRoot, 'current'))).toBe(false);
  });

  it('checks an existing install root before recovering or reading anything in it', () => {
    const f = fixture();
    mkdirSync(f.installRoot, { recursive: true });
    const elsewhere = join(f.dir, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(f.installRoot, 'current.next'));
    const result = install(f, buildWindowsArchive(f.dir, '0.7.0-nightly.12'), {
      STATION_INSTALL_NO_START: '1',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'STATION_INSTALL_ROOT is not an empty or installer-owned directory',
    );
    // Not "recovered" into current.
    expect(
      lstatSync(join(f.installRoot, 'current.next')).isSymbolicLink(),
    ).toBe(true);
    expect(existsSync(join(f.installRoot, 'current'))).toBe(false);
  });

  it('refuses a current that names the versions directory itself', () => {
    const f = fixture();
    expect(
      install(f, buildWindowsArchive(f.dir, '0.7.0-nightly.12'), {
        STATION_INSTALL_NO_START: '1',
      }).status,
    ).toBe(0);
    unlinkSync(join(f.installRoot, 'current'));
    symlinkSync(
      join(f.installRoot, 'versions'),
      join(f.installRoot, 'current'),
    );
    takeCliRuns(f);
    const result = core(f, {}, ['uninstall']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('points outside');
    expect(takeCliRuns(f)).toEqual([]);
  });

  it('refuses to run anything from a current that points outside versions', () => {
    const f = fixture();
    expect(
      install(f, buildWindowsArchive(f.dir, '0.7.0-nightly.12'), {
        STATION_INSTALL_NO_START: '1',
      }).status,
    ).toBe(0);
    const planted = join(f.dir, 'planted');
    cpSync(join(f.installRoot, 'versions', '0.7.0-nightly.12'), planted, {
      recursive: true,
    });
    unlinkSync(join(f.installRoot, 'current'));
    symlinkSync(planted, join(f.installRoot, 'current'));
    takeCliRuns(f);
    for (const run of [
      () => install(f, buildWindowsArchive(f.dir, '0.7.0-nightly.13')),
      () => core(f, {}, ['uninstall']),
    ]) {
      const result = run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('points outside');
      expect(takeCliRuns(f)).toEqual([]);
    }
    expect(existsSync(f.launcher)).toBe(true);
  });

  it('finishes a switch a crash interrupted between removing current and renaming current.next', () => {
    const f = fixture();
    const archive = buildWindowsArchive(f.dir, '0.7.0-nightly.12');
    expect(install(f, archive, { STATION_INSTALL_NO_START: '1' }).status).toBe(
      0,
    );
    renameSync(
      join(f.installRoot, 'current'),
      join(f.installRoot, 'current.next'),
    );
    const result = install(f, archive, { STATION_INSTALL_NO_START: '1' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      'Station v0.7.0-nightly.12 is already installed; nothing to do.',
    );
    expect(currentVersion(f)).toBe('0.7.0-nightly.12');
    expect(existsSync(join(f.installRoot, 'current.next'))).toBe(false);
  });

  it.each<{
    name: string;
    setup: (f: Fixture) => Record<string, string>;
    message: string;
  }>([
    {
      name: 'a launcher it does not own',
      setup: (f) => {
        mkdirSync(f.binDir, { recursive: true });
        writeFileSync(f.launcher, '@echo off\r\necho mine\r\n');
        return {};
      },
      message:
        'refusing to replace a launcher not owned by the nightly install',
    },
    {
      name: 'an archive service of this install root',
      setup: (f) => {
        mkdirSync(join(f.home, 'service'), { recursive: true });
        writeFileSync(
          join(f.home, 'service', 'svc.json'),
          JSON.stringify({
            platform: process.platform,
            kind: 'archive',
            // As `service install` records it: the canonical install root.
            installRoot: join(real(f.dir), 'root', 'installs', 'nightly'),
            instanceId: 'svc',
          }),
        );
        return { STATION_HOME: f.home };
      },
      message:
        'Station service(s) svc run this install; install.ps1 cannot switch the version under a Windows service yet (#2675 slice W3)',
    },
    {
      name: 'default nightly home data it does not own',
      setup: (f) => {
        mkdirSync(f.home, { recursive: true });
        writeFileSync(join(f.home, 'desktop-data'), '');
        return {};
      },
      message:
        "already holds Station data this installer does not own (usually the Station Nightly desktop app's home)",
    },
    {
      name: 'a home path the launcher cannot quote',
      setup: (f) => ({
        STATION_HOME: join(f.stationRoot, 'instances', '100%'),
      }),
      message:
        'a Station path contains a character the Windows launcher cannot quote',
    },
    {
      name: 'an invalid explicit port',
      setup: () => ({ STATION_INSTALL_SERVER_PORT: '70000' }),
      message: 'invalid Station port: 70000',
    },
  ])('refuses $name and changes nothing', ({ setup, message }) => {
    const f = fixture();
    const env = setup(f);
    const result = install(f, buildWindowsArchive(f.dir, '0.7.0-nightly.12'), {
      STATION_INSTALL_NO_START: '1',
      ...env,
    });
    expect(result.status, result.stdout).toBe(1);
    expect(result.stderr).toContain(`Station install failed: `);
    expect(result.stderr).toContain(message);
    expect(existsSync(join(f.installRoot, 'current'))).toBe(false);
    expect(takeCliRuns(f)).toEqual([]);
  });

  it('refuses a nightly port another program holds when no nightly is installed', async () => {
    const f = fixture();
    const holder = createServer();
    servers.push(holder);
    await new Promise<void>((ready) =>
      holder.listen(0, '127.0.0.1', () => ready()),
    );
    const port = (holder.address() as { port: number }).port;
    const [, ui] = await freePorts();
    const result = install(f, buildWindowsArchive(f.dir, '0.7.0-nightly.12'), {
      STATION_INSTALL_SERVER_PORT: String(port),
      STATION_INSTALL_UI_PORT: String(ui),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `port ${port} is already in use on this host, and no portable nightly Station is installed to own it`,
    );
    expect(versionDirs(f)).toEqual([]);
  });
});

describe('install.ps1 installer core: uninstall (#2675 W2)', () => {
  function installed() {
    const f = fixture();
    expect(
      install(f, buildWindowsArchive(f.dir, '0.7.0-nightly.12'), {
        STATION_INSTALL_NO_START: '1',
      }).status,
    ).toBe(0);
    return f;
  }

  it('stops Station and removes the launcher and install root, keeping the data', () => {
    const f = installed();
    const result = core(f, {}, ['uninstall']);
    expect(result.status, result.stderr).toBe(0);
    expect(verbs(takeCliRuns(f))).toEqual(['stop@0.7.0-nightly.12']);
    expect(existsSync(f.installRoot)).toBe(false);
    expect(existsSync(f.launcher)).toBe(false);
    expect(existsSync(f.home)).toBe(true);
    expect(result.stdout).toContain('Station uninstalled.');
    expect(result.stdout).toContain(`Data preserved at ${real(f.home)}`);
  });

  it.each(['-PurgeData', '--purge-data'])(
    'removes the data too with %s',
    (flag) => {
      const f = installed();
      const result = core(f, {}, ['uninstall', flag]);
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(f.installRoot)).toBe(false);
      expect(existsSync(f.home)).toBe(false);
    },
  );

  it('refuses a launcher it does not own, and removes nothing', () => {
    const f = installed();
    writeFileSync(f.launcher, '@echo off\r\n');
    const result = core(f, {}, ['uninstall']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'refusing to remove a launcher not owned by the nightly install',
    );
    expect(existsSync(join(f.installRoot, 'current'))).toBe(true);
  });

  it('refuses while a service runs the install, and removes nothing', () => {
    const f = installed();
    mkdirSync(join(f.home, 'service'), { recursive: true });
    writeFileSync(
      join(f.home, 'service', 'svc.json'),
      JSON.stringify({
        platform: process.platform,
        kind: 'archive',
        installRoot: f.installRoot,
        instanceId: 'svc',
      }),
    );
    const result = core(f, {}, ['uninstall']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Station service(s) svc run this install');
    expect(takeCliRuns(f)).toEqual([]);
    expect(existsSync(f.launcher)).toBe(true);
  });

  it('removes a root not restricted to the user without running anything from it', async () => {
    const f = fixture();
    const [server, ui] = await freePorts();
    expect(
      install(f, buildWindowsArchive(f.dir, '0.7.0-nightly.12'), {
        STATION_INSTALL_SERVER_PORT: String(server),
        STATION_INSTALL_UI_PORT: String(ui),
        STATION_INSTALL_NO_START: '1',
      }).status,
    ).toBe(0);
    // Install refuses it, and names uninstall as the way out.
    const refused = install(f, buildWindowsArchive(f.dir, '0.7.0-nightly.13'), {
      STATION_INSTALL_TEST_UNTRUSTED_ROOT: '1',
    });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('is not restricted to your account');
    expect(refused.stderr).toContain(
      'Remove it with a freshly downloaded install.ps1',
    );
    const result = core(f, { STATION_INSTALL_TEST_UNTRUSTED_ROOT: '1' }, [
      'uninstall',
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('removed without running anything from it');
    expect(takeCliRuns(f)).toEqual([]);
    expect(existsSync(f.installRoot)).toBe(false);
    expect(existsSync(f.launcher)).toBe(false);
    expect(existsSync(f.home)).toBe(true);
    // A fresh install works afterwards.
    expect(
      install(f, buildWindowsArchive(f.dir, '0.7.0-nightly.13'), {
        STATION_INSTALL_SERVER_PORT: String(server),
        STATION_INSTALL_UI_PORT: String(ui),
        STATION_INSTALL_NO_START: '1',
      }).status,
    ).toBe(0);
  });

  it('removes a stage-only (W1) root not restricted to the user', () => {
    const f = fixture();
    const staged = install(f, buildWindowsArchive(f.dir, '0.7.0-nightly.12'), {
      STATION_INSTALL_STAGE_ONLY: '1',
    });
    expect(staged.status, staged.stderr).toBe(0);
    const result = core(f, { STATION_INSTALL_TEST_UNTRUSTED_ROOT: '1' }, [
      'uninstall',
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(f.installRoot)).toBe(false);
  });

  it('refuses to remove an untrusted root while a Station may run from it', async () => {
    const f = fixture();
    const holder = createServer();
    servers.push(holder);
    await new Promise<void>((ready) =>
      holder.listen(0, '127.0.0.1', () => ready()),
    );
    const port = (holder.address() as { port: number }).port;
    const [, ui] = await freePorts();
    expect(
      install(f, buildWindowsArchive(f.dir, '0.7.0-nightly.12'), {
        STATION_INSTALL_SERVER_PORT: String(port),
        STATION_INSTALL_UI_PORT: String(ui),
        STATION_INSTALL_NO_START: '1',
      }).status,
    ).toBe(0);
    const result = core(f, { STATION_INSTALL_TEST_UNTRUSTED_ROOT: '1' }, [
      'uninstall',
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `a Station may be running from ${real(f.installRoot)} (port ${port} is in use)`,
    );
    expect(takeCliRuns(f)).toEqual([]);
    expect(existsSync(join(f.installRoot, 'current'))).toBe(true);
  });

  it('refuses the test-only untrusted-root override without the test flag', () => {
    const f = installed();
    const result = core(
      f,
      {
        STATION_INSTALL_TEST_UNTRUSTED_ROOT: '1',
        STATION_INSTALL_ALLOW_INSECURE_TEST_URLS: '0',
      },
      ['uninstall'],
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'STATION_INSTALL_TEST_UNTRUSTED_ROOT is a test-only override',
    );
    expect(existsSync(f.installRoot)).toBe(true);
  });

  it('removes links inside the tree, never what they point at', () => {
    const f = installed();
    const outside = join(f.dir, 'outside-keep');
    mkdirSync(join(outside, 'deep'), { recursive: true });
    writeFileSync(join(outside, 'deep', 'precious'), 'keep me');
    symlinkSync(outside, join(f.installRoot, 'versions', 'planted-dir'));
    symlinkSync(
      join(outside, 'deep', 'precious'),
      join(f.installRoot, 'planted-file'),
    );
    const result = core(f, {}, ['uninstall']);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(f.installRoot)).toBe(false);
    expect(readFileSync(join(outside, 'deep', 'precious'), 'utf8')).toBe(
      'keep me',
    );
  });

  it('removes the ownership marker last, so a removal that fails partway can be rerun', () => {
    const f = installed();
    const failed = core(f, { STATION_INSTALL_TEST_FAIL_REMOVE: 'versions' }, [
      'uninstall',
    ]);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain('rerun the uninstall once nothing uses it');
    expect(
      readFileSync(
        join(f.installRoot, '.station-portable-install-root'),
        'utf8',
      ),
    ).toBe('station-portable-install-root-v1\n');
    expect(existsSync(join(f.installRoot, 'versions'))).toBe(true);
    const rerun = core(f, {}, ['uninstall']);
    expect(rerun.status, rerun.stderr).toBe(0);
    expect(existsSync(f.installRoot)).toBe(false);
  });

  it('refuses an install root it does not own', () => {
    const f = fixture();
    mkdirSync(f.installRoot, { recursive: true });
    writeFileSync(join(f.installRoot, 'someone-else'), '');
    const result = core(f, {}, ['uninstall']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'refusing to remove a root not owned by this installer',
    );
    expect(existsSync(join(f.installRoot, 'someone-else'))).toBe(true);
  });

  it('refuses an unknown option', () => {
    const f = installed();
    const result = core(f, {}, ['uninstall', '--everything']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unknown uninstall option: --everything');
    expect(existsSync(f.installRoot)).toBe(true);
  });
});

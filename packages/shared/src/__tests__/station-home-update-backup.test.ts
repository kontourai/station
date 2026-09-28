import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.js';
import {
  createStationHomeBackup,
  createStationHomeUpdateBackup,
  restoreStationHomeUpdateBackup,
  STATION_HOME_BACKUP_MANIFEST,
  STATION_HOME_UPDATE_BACKUP_SCHEMA,
  StationHomeArchiveError,
} from '../station-home-archive.js';
import { acquireStationHomeRuntimeLease } from '../station-home-lifecycle.js';
import {
  ensureStationHomeSchemaSync,
  STATION_HOME_SCHEMA_FILE,
} from '../station-home-schema.js';

const makeTempDir = trackTempDirs();

/** A stopped home in the shape a service leaves it: state plus live roots. */
function serviceHome(): { root: string; home: string; backupDir: string } {
  const root = makeTempDir('station-update-backup-');
  const home = join(root, 'home');
  ensureStationHomeSchemaSync(home);
  mkdirSync(join(home, 'config'), { recursive: true });
  writeFileSync(join(home, 'config', 'app.json'), '{"model":"before"}\n');
  mkdirSync(join(home, 'data'), { recursive: true });
  const database = new DatabaseSync(join(home, 'data', 'orchestration.sqlite'));
  database.exec(
    "CREATE TABLE facts (id TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO facts VALUES ('one', 'before')",
  );
  database.close();
  mkdirSync(join(home, 'service'), { recursive: true });
  writeFileSync(join(home, 'service', 'default.json'), '{"manifest":1}\n');
  writeFileSync(join(home, 'instances.json'), '{"liveness":"launcher"}\n');
  mkdirSync(join(home, 'logs'), { recursive: true });
  writeFileSync(join(home, 'logs', 'default.log'), 'before\n');
  return { root, home, backupDir: join(root, 'update-backups', 'u1') };
}

function sha(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function schemaVersion(home: string): unknown {
  return JSON.parse(readFileSync(join(home, STATION_HOME_SCHEMA_FILE), 'utf8'))
    .version;
}

function writeSchemaVersion(home: string, version: number): void {
  const marker = join(home, STATION_HOME_SCHEMA_FILE);
  const value = JSON.parse(readFileSync(marker, 'utf8'));
  writeFileSync(marker, `${JSON.stringify({ ...value, version })}\n`);
}

describe('update backup and in-place restore (#2675 D)', () => {
  it('backs up state including the schema marker and leaves live roots out', () => {
    const fixture = serviceHome();
    mkdirSync(join(fixture.root, 'update-backups'));
    const { manifest, reused } = createStationHomeUpdateBackup({
      homeDir: fixture.home,
      backupDir: fixture.backupDir,
    });
    expect(reused).toBe(false);
    const paths = manifest.files.map((file) => file.path.join('/'));
    expect(paths).toContain(STATION_HOME_SCHEMA_FILE);
    expect(paths).toContain('config/app.json');
    expect(paths).toContain('data/orchestration.sqlite');
    for (const live of ['service', 'instances.json', 'logs'])
      expect(paths.some((path) => path.split('/')[0] === live)).toBe(false);
  });

  it('rolls a trial that bumped the schema and wrote new data back, keeping live roots as they are', () => {
    const fixture = serviceHome();
    mkdirSync(join(fixture.root, 'update-backups'));
    createStationHomeUpdateBackup({
      homeDir: fixture.home,
      backupDir: fixture.backupDir,
    });
    const before = sha(join(fixture.home, STATION_HOME_SCHEMA_FILE));

    // The trial: migrates the home, rewrites data, adds a store, and the
    // service lifecycle keeps writing its live entries meanwhile.
    writeSchemaVersion(fixture.home, 99);
    writeFileSync(
      join(fixture.home, 'config', 'app.json'),
      '{"model":"trial"}\n',
    );
    const database = new DatabaseSync(
      join(fixture.home, 'data', 'orchestration.sqlite'),
    );
    database.exec("UPDATE facts SET value = 'trial'");
    database.close();
    mkdirSync(join(fixture.home, 'trial-only-store'));
    writeFileSync(join(fixture.home, 'trial-only-store', 'x.json'), '{}\n');
    writeFileSync(join(fixture.home, 'logs', 'default.log'), 'trial crashed\n');
    writeFileSync(join(fixture.home, 'instances.json'), '{"liveness":"now"}\n');

    restoreStationHomeUpdateBackup({
      homeDir: fixture.home,
      backupDir: fixture.backupDir,
    });

    expect(sha(join(fixture.home, STATION_HOME_SCHEMA_FILE))).toBe(before);
    expect(schemaVersion(fixture.home)).not.toBe(99);
    expect(readFileSync(join(fixture.home, 'config', 'app.json'), 'utf8')).toBe(
      '{"model":"before"}\n',
    );
    const restored = new DatabaseSync(
      join(fixture.home, 'data', 'orchestration.sqlite'),
      { readOnly: true },
    );
    expect(restored.prepare('SELECT value FROM facts').get()).toEqual({
      value: 'before',
    });
    restored.close();
    expect(existsSync(join(fixture.home, 'trial-only-store'))).toBe(false);
    // Live roots: exactly as the service lifecycle left them.
    expect(
      readFileSync(join(fixture.home, 'logs', 'default.log'), 'utf8'),
    ).toBe('trial crashed\n');
    expect(readFileSync(join(fixture.home, 'instances.json'), 'utf8')).toBe(
      '{"liveness":"now"}\n',
    );
    expect(
      readFileSync(join(fixture.home, 'service', 'default.json'), 'utf8'),
    ).toBe('{"manifest":1}\n');
  });

  it('finishes a restore interrupted after it removed the state entries', () => {
    const fixture = serviceHome();
    mkdirSync(join(fixture.root, 'update-backups'));
    createStationHomeUpdateBackup({
      homeDir: fixture.home,
      backupDir: fixture.backupDir,
    });
    writeSchemaVersion(fixture.home, 99);
    expect(() =>
      restoreStationHomeUpdateBackup({
        homeDir: fixture.home,
        backupDir: fixture.backupDir,
        afterRemove: () => {
          throw new Error('crash mid-restore');
        },
      }),
    ).toThrow(StationHomeArchiveError);
    // Interrupted: the state is gone, the live roots are not.
    expect(existsSync(join(fixture.home, STATION_HOME_SCHEMA_FILE))).toBe(
      false,
    );
    expect(existsSync(join(fixture.home, 'service', 'default.json'))).toBe(
      true,
    );

    restoreStationHomeUpdateBackup({
      homeDir: fixture.home,
      backupDir: fixture.backupDir,
    });
    expect(schemaVersion(fixture.home)).not.toBe(99);
    expect(readFileSync(join(fixture.home, 'config', 'app.json'), 'utf8')).toBe(
      '{"model":"before"}\n',
    );
  });

  it('takes the backup once: a second call reuses it instead of snapshotting the trial', () => {
    const fixture = serviceHome();
    mkdirSync(join(fixture.root, 'update-backups'));
    const first = createStationHomeUpdateBackup({
      homeDir: fixture.home,
      backupDir: fixture.backupDir,
    });
    writeFileSync(
      join(fixture.home, 'config', 'app.json'),
      '{"model":"trial"}\n',
    );
    const second = createStationHomeUpdateBackup({
      homeDir: fixture.home,
      backupDir: fixture.backupDir,
    });
    expect(second.reused).toBe(true);
    expect(second.manifest).toEqual(first.manifest);
  });

  it('ENOSPC while copying leaves no backup and the home untouched', () => {
    const fixture = serviceHome();
    mkdirSync(join(fixture.root, 'update-backups'));
    const appBefore = sha(join(fixture.home, 'config', 'app.json'));
    let copies = 0;
    expect(() =>
      createStationHomeUpdateBackup({
        homeDir: fixture.home,
        backupDir: fixture.backupDir,
        copyFile: () => {
          copies += 1;
          throw Object.assign(new Error('ENOSPC: no space left on device'), {
            code: 'ENOSPC',
          });
        },
      }),
    ).toThrow(StationHomeArchiveError);
    expect(copies).toBe(1);
    expect(existsSync(fixture.backupDir)).toBe(false);
    // No staging directory is left behind beside it either.
    expect(readdirSync(join(fixture.root, 'update-backups'))).toEqual([]);
    expect(sha(join(fixture.home, 'config', 'app.json'))).toBe(appBefore);
  });

  it('refuses to back up or restore a home a runtime still holds', () => {
    const fixture = serviceHome();
    mkdirSync(join(fixture.root, 'update-backups'));
    const lease = acquireStationHomeRuntimeLease(fixture.home);
    try {
      expect(() =>
        createStationHomeUpdateBackup({
          homeDir: fixture.home,
          backupDir: fixture.backupDir,
        }),
      ).toThrow(/inactive/);
    } finally {
      lease.release();
    }
    createStationHomeUpdateBackup({
      homeDir: fixture.home,
      backupDir: fixture.backupDir,
    });
    const again = acquireStationHomeRuntimeLease(fixture.home);
    try {
      expect(() =>
        restoreStationHomeUpdateBackup({
          homeDir: fixture.home,
          backupDir: fixture.backupDir,
        }),
      ).toThrow(/inactive/);
      expect(existsSync(join(fixture.home, 'config', 'app.json'))).toBe(true);
    } finally {
      again.release();
    }
  });

  it('checkpoints a registered WAL store that is not named *.sqlite, so its commits survive', () => {
    const fixture = serviceHome();
    mkdirSync(join(fixture.root, 'update-backups'));
    mkdirSync(join(fixture.home, 'knowledge-index'));
    const path = join(fixture.home, 'knowledge-index', 'index.db');
    const writer = new DatabaseSync(path);
    writer.exec(
      'PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE chunks (id INTEGER PRIMARY KEY, body TEXT);',
    );
    const insert = writer.prepare('INSERT INTO chunks (body) VALUES (?)');
    for (let index = 0; index < 500; index++) insert.run('x'.repeat(200));
    expect(existsSync(`${path}-wal`)).toBe(true);
    try {
      createStationHomeUpdateBackup({
        homeDir: fixture.home,
        backupDir: fixture.backupDir,
      });
    } finally {
      writer.close();
    }
    rmSync(join(fixture.home, 'knowledge-index'), { recursive: true });
    restoreStationHomeUpdateBackup({
      homeDir: fixture.home,
      backupDir: fixture.backupDir,
    });
    const restored = new DatabaseSync(path, { readOnly: true });
    expect(
      restored.prepare('SELECT count(*) AS count FROM chunks').get(),
    ).toEqual({ count: 500 });
    restored.close();
  });
});

/**
 * A home in the shape real use leaves it (#2675 D review F1): a default
 * project directory holding a repository with `node_modules/.bin` links, a
 * plugin whose selection alias is an absolute link into its generations, a
 * plugin draft linked to a package outside the home, and a browser root
 * whose Chromium profiles are large and hold Chromium's dangling
 * `SingletonLock` link.
 */
function realisticHome() {
  const fixture = serviceHome();
  const { home } = fixture;
  const repo = join(home, 'workspaces', 'my-app');
  mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true });
  mkdirSync(join(repo, 'node_modules', '.bin'));
  writeFileSync(join(repo, 'package.json'), '{"name":"my-app"}\n');
  writeFileSync(join(repo, 'node_modules', 'pkg', 'cli.js'), 'run()\n');
  symlinkSync('../pkg/cli.js', join(repo, 'node_modules', '.bin', 'pkg'));

  const generation = join(home, 'plugins', '.generations', 'k1', 'g1');
  mkdirSync(join(generation, 'package'), { recursive: true });
  writeFileSync(join(generation, 'package', 'index.js'), 'export {}\n');
  const alias = join(home, 'plugins', 'demo');
  symlinkSync(join(generation, 'package'), alias, 'dir');
  const outside = join(fixture.root, 'installs', 'versions', '1.0.0', 'shared');
  mkdirSync(outside, { recursive: true });
  const draftLink = join(
    home,
    'plugins',
    'draft',
    'node_modules',
    '@kontourai',
    'station-shared',
  );
  mkdirSync(join(draftLink, '..'), { recursive: true });
  symlinkSync(outside, draftLink, 'dir');

  mkdirSync(join(home, 'browser', 'chromium'), { recursive: true });
  writeFileSync(join(home, 'browser', 'chromium', 'chrome'), 'binary\n');
  writeFileSync(join(home, 'browser', 'sessions.json'), '{"sessions":1}\n');
  const profile = join(home, 'browser', 'profiles', 'p1', 'q1');
  mkdirSync(join(profile, 'Cache'), { recursive: true });
  for (let index = 0; index < 300; index += 1)
    writeFileSync(join(profile, 'Cache', `f_${index}`), `${index}\n`);
  symlinkSync('host-12345', join(profile, 'SingletonLock'));
  return { ...fixture, repo, alias, draftLink, outside, profile, generation };
}

describe('update backup of a realistic home (#2675 D review F1)', () => {
  it('records links as links, leaves external paths out, and stays inside a small file budget', () => {
    const fixture = realisticHome();
    mkdirSync(join(fixture.root, 'update-backups'));
    // A home backup still refuses a link, as before.
    expect(() =>
      createStationHomeBackup({
        homeDir: fixture.home,
        outputDir: join(fixture.root, 'home-backup'),
      }),
    ).toThrow(/symbolic link/);
    const { manifest } = createStationHomeUpdateBackup({
      homeDir: fixture.home,
      backupDir: fixture.backupDir,
      // The profile alone holds 300 files: excluded, it cannot count.
      maxFiles: 50,
    });
    expect(manifest.schemaVersion).toBe(STATION_HOME_UPDATE_BACKUP_SCHEMA);
    const files = manifest.files.map((file) => file.path.join('/'));
    expect(files).toContain('browser/sessions.json');
    expect(files).toContain('plugins/.generations/k1/g1/package/index.js');
    for (const file of files) {
      expect(file.startsWith('workspaces/')).toBe(false);
      expect(file.startsWith('browser/profiles/')).toBe(false);
      expect(file.startsWith('browser/chromium/')).toBe(false);
    }
    expect(
      manifest.symlinks?.map((link) => [link.path.join('/'), link.target]),
    ).toEqual([
      ['plugins/demo', join(fixture.generation, 'package')],
      ['plugins/draft/node_modules/@kontourai/station-shared', fixture.outside],
    ]);
    // Never followed: the backup's copy holds no link and nothing of the
    // package outside the home (the draft holds only its link).
    const copied = join(fixture.backupDir, 'home', 'plugins');
    expect(readdirSync(copied)).toEqual(['.generations']);
  });

  it('a rollback restores links as links and leaves users repositories and the browser profiles as the trial left them', () => {
    const fixture = realisticHome();
    mkdirSync(join(fixture.root, 'update-backups'));
    createStationHomeUpdateBackup({
      homeDir: fixture.home,
      backupDir: fixture.backupDir,
    });
    // The trial: re-points the plugin alias, drops the draft link, rewrites
    // Station's browser state; the user keeps working in the repository and
    // Chromium keeps writing its profile.
    rmSync(fixture.alias);
    symlinkSync(join(fixture.home, 'plugins'), fixture.alias, 'dir');
    rmSync(fixture.draftLink);
    writeFileSync(join(fixture.home, 'plugins', 'trial.json'), '{}\n');
    writeFileSync(
      join(fixture.home, 'browser', 'sessions.json'),
      '{"sessions":"trial"}\n',
    );
    writeFileSync(join(fixture.repo, 'written-during-trial.ts'), 'x\n');
    writeFileSync(join(fixture.profile, 'Cookies'), 'trial\n');

    restoreStationHomeUpdateBackup({
      homeDir: fixture.home,
      backupDir: fixture.backupDir,
    });

    expect(lstatSync(fixture.alias).isSymbolicLink()).toBe(true);
    expect(readlinkSync(fixture.alias)).toBe(
      join(fixture.generation, 'package'),
    );
    expect(lstatSync(fixture.draftLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(fixture.draftLink)).toBe(fixture.outside);
    expect(existsSync(join(fixture.home, 'plugins', 'trial.json'))).toBe(false);
    expect(
      readFileSync(join(fixture.home, 'browser', 'sessions.json'), 'utf8'),
    ).toBe('{"sessions":1}\n');
    // External: exactly as the trial window left it, links included.
    expect(
      readFileSync(join(fixture.repo, 'written-during-trial.ts'), 'utf8'),
    ).toBe('x\n');
    expect(
      readlinkSync(join(fixture.repo, 'node_modules', '.bin', 'pkg')),
    ).toBe('../pkg/cli.js');
    expect(readFileSync(join(fixture.profile, 'Cookies'), 'utf8')).toBe(
      'trial\n',
    );
    expect(readlinkSync(join(fixture.profile, 'SingletonLock'))).toBe(
      'host-12345',
    );
    expect(
      readFileSync(join(fixture.home, 'browser', 'chromium', 'chrome'), 'utf8'),
    ).toBe('binary\n');
  });

  it('refuses a manifest whose link would land outside the home', () => {
    const fixture = realisticHome();
    mkdirSync(join(fixture.root, 'update-backups'));
    createStationHomeUpdateBackup({
      homeDir: fixture.home,
      backupDir: fixture.backupDir,
    });
    const manifestPath = join(fixture.backupDir, STATION_HOME_BACKUP_MANIFEST);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.symlinks.push({
      path: ['..', 'escaped'],
      target: '/etc',
      directory: true,
    });
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() =>
      restoreStationHomeUpdateBackup({
        homeDir: fixture.home,
        backupDir: fixture.backupDir,
      }),
    ).toThrow(/unsafe path segment/);
    expect(existsSync(join(fixture.root, 'escaped'))).toBe(false);
    // Nothing was removed before the manifest was refused.
    expect(lstatSync(fixture.alias).isSymbolicLink()).toBe(true);
  });

  it('reusing an existing backup takes the maintenance lease too (F3)', () => {
    const fixture = serviceHome();
    mkdirSync(join(fixture.root, 'update-backups'));
    createStationHomeUpdateBackup({
      homeDir: fixture.home,
      backupDir: fixture.backupDir,
    });
    // A desktop sidecar started on the home while the launcher was down.
    const lease = acquireStationHomeRuntimeLease(fixture.home);
    try {
      expect(() =>
        createStationHomeUpdateBackup({
          homeDir: fixture.home,
          backupDir: fixture.backupDir,
        }),
      ).toThrow(/inactive/);
    } finally {
      lease.release();
    }
    expect(
      createStationHomeUpdateBackup({
        homeDir: fixture.home,
        backupDir: fixture.backupDir,
      }).reused,
    ).toBe(true);
  });
});

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  recordCorruptionObserved,
  SQLITE_CORRUPTION_MARKER_FILE,
} from '../sqlite-corruption-marker.js';
import {
  createStationHomeBackup,
  readStationHomeBackupManifest,
  restoreStationHomeBackup,
  STATION_HOME_BACKUP_MANIFEST,
  StationHomeArchiveError,
} from '../station-home-archive.js';
import { acquireStationHomeRuntimeLease } from '../station-home-lifecycle.js';
import {
  ensureStationHomeSchemaSync,
  STATION_HOME_SCHEMA_FILE,
} from '../station-home-schema.js';

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'station-home-archive-'));
  roots.push(value);
  return value;
}

function homeFixture(): { root: string; home: string } {
  const parent = root();
  const home = join(parent, 'home');
  ensureStationHomeSchemaSync(home);
  mkdirSync(join(home, 'config'), { recursive: true });
  writeFileSync(join(home, 'config', 'app.json'), '{"model":"original"}\n');
  mkdirSync(join(home, 'data'), { recursive: true });
  const database = new DatabaseSync(join(home, 'data', 'orchestration.sqlite'));
  database.exec(
    "CREATE TABLE facts (id TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO facts VALUES ('one', 'original')",
  );
  database.close();
  return { root: parent, home };
}

afterEach(() => {
  for (const value of roots.splice(0))
    rmSync(value, { recursive: true, force: true });
});

describe('StationHomeArchive', () => {
  it('refuses the shared root before backup or restore can mutate it', () => {
    const sharedRoot = root();
    const output = join(root(), 'backup');
    const previousRoot = process.env.STATION_ROOT;
    process.env.STATION_ROOT = sharedRoot;
    try {
      expect(() =>
        createStationHomeBackup({ homeDir: sharedRoot, outputDir: output }),
      ).toThrow(/not admissible/);
      expect(() =>
        restoreStationHomeBackup({
          homeDir: sharedRoot,
          backupDir: output,
          confirm: true,
        }),
      ).toThrow(/not admissible/);
      expect(readdirSync(sharedRoot)).toEqual([]);
      expect(existsSync(output)).toBe(false);
    } finally {
      if (previousRoot === undefined) delete process.env.STATION_ROOT;
      else process.env.STATION_ROOT = previousRoot;
    }
  });

  it('does not create a missing home merely to back it up', () => {
    const parent = root();
    const home = join(parent, 'missing-home');
    expect(() =>
      createStationHomeBackup({
        homeDir: home,
        outputDir: join(parent, 'backup'),
      }),
    ).toThrow(/does not exist/);
    expect(() => readFileSync(join(home, STATION_HOME_SCHEMA_FILE))).toThrow();
  });

  it('backs up and atomically restores validated home data', () => {
    const fixture = homeFixture();
    const backupDir = join(fixture.root, 'backup');
    mkdirSync(join(fixture.home, 'logs'), { recursive: true });
    writeFileSync(join(fixture.home, 'logs', 'server.log'), 'transient');
    writeFileSync(
      join(fixture.home, 'instances.json'),
      '{"version":1,"instances":{"stale":{}}}',
    );
    const inactive = vi.fn();

    const backup = createStationHomeBackup({
      homeDir: fixture.home,
      outputDir: backupDir,
      assertInactive: inactive,
      now: () => '2026-08-17T00:00:00.000Z',
    });
    expect(backup.manifest.createdAt).toBe('2026-08-17T00:00:00.000Z');
    expect(backup.manifest.files.map((file) => file.path.join('/'))).toEqual(
      expect.arrayContaining([
        STATION_HOME_SCHEMA_FILE,
        'config/app.json',
        'data/orchestration.sqlite',
      ]),
    );
    expect(backup.manifest.files.map((file) => file.path[0])).not.toContain(
      'logs',
    );
    expect(backup.manifest.files.map((file) => file.path[0])).not.toContain(
      'instances.json',
    );
    expect(inactive.mock.calls.length).toBeGreaterThanOrEqual(3);

    writeFileSync(
      join(fixture.home, 'config', 'app.json'),
      '{"model":"new"}\n',
    );
    const restored = restoreStationHomeBackup({
      backupDir,
      homeDir: fixture.home,
      confirm: true,
      assertInactive: inactive,
    });
    expect(readFileSync(join(fixture.home, 'config', 'app.json'), 'utf8')).toBe(
      '{"model":"original"}\n',
    );
    expect(restored.previousHome).toBeDefined();
    expect(
      readFileSync(join(restored.previousHome!, 'config', 'app.json'), 'utf8'),
    ).toBe('{"model":"new"}\n');
    const database = new DatabaseSync(
      join(fixture.home, 'data', 'orchestration.sqlite'),
      { readOnly: true },
    );
    expect(
      database.prepare('SELECT value FROM facts WHERE id = ?').get('one'),
    ).toEqual({ value: 'original' });
    database.close();
  });

  it('snapshots WAL SQLite metadata after checkpoint and restores its rows', () => {
    const fixture = homeFixture();
    const databasePath = join(fixture.home, 'data', 'orchestration.sqlite');
    const database = new DatabaseSync(databasePath);
    database.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
    const insert = database.prepare('INSERT INTO facts VALUES (?, ?)');
    for (let index = 0; index < 2_000; index++) {
      insert.run(`wal-${index}`, 'x'.repeat(200));
    }
    const preCheckpointSize = readFileSync(databasePath).byteLength;
    expect(existsSync(`${databasePath}-wal`)).toBe(true);
    const backupDir = join(fixture.root, 'backup');
    let result!: ReturnType<typeof createStationHomeBackup>;
    try {
      result = createStationHomeBackup({
        homeDir: fixture.home,
        outputDir: backupDir,
      });
    } finally {
      database.close();
    }
    const source = readFileSync(databasePath);
    expect(source.byteLength).not.toBe(preCheckpointSize);
    const entry = result.manifest.files.find(
      (file) => file.path.join('/') === 'data/orchestration.sqlite',
    );
    expect(entry).toMatchObject({
      size: source.byteLength,
      sha256: createHash('sha256').update(source).digest('hex'),
    });
    restoreStationHomeBackup({
      backupDir,
      homeDir: fixture.home,
      confirm: true,
    });
    const restored = new DatabaseSync(databasePath, { readOnly: true });
    expect(
      restored
        .prepare("SELECT count(*) AS count FROM facts WHERE id LIKE 'wal-%'")
        .get(),
    ).toEqual({ count: 2_000 });
    restored.close();
  });

  it('refuses a busy WAL checkpoint instead of archiving only the main database', () => {
    const fixture = homeFixture();
    const databasePath = join(fixture.home, 'data', 'orchestration.sqlite');
    const writer = new DatabaseSync(databasePath);
    writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
    const reader = new DatabaseSync(databasePath, { readOnly: true });
    reader.exec('BEGIN; SELECT * FROM facts;');
    writer.exec("INSERT INTO facts VALUES ('blocked-wal', 'value');");
    const backupDir = join(fixture.root, 'backup');
    try {
      expect(() =>
        createStationHomeBackup({
          homeDir: fixture.home,
          outputDir: backupDir,
        }),
      ).toThrow(/SQLite integrity check failed/);
      expect(existsSync(backupDir)).toBe(false);
    } finally {
      reader.exec('ROLLBACK;');
      reader.close();
      writer.close();
    }
  });

  it('refuses active homes before reading or publishing a backup', () => {
    const fixture = homeFixture();
    const backupDir = join(fixture.root, 'backup');
    expect(() =>
      createStationHomeBackup({
        homeDir: fixture.home,
        outputDir: backupDir,
        assertInactive: () => {
          throw new Error('Station is running');
        },
      }),
    ).toThrow(/must be inactive before backup/);
    expect(() =>
      readFileSync(join(backupDir, STATION_HOME_BACKUP_MANIFEST)),
    ).toThrow();
  });

  it('uses the durable runtime lease rather than only a caller snapshot', () => {
    const fixture = homeFixture();
    const lease = acquireStationHomeRuntimeLease(fixture.home);
    try {
      expect(() =>
        createStationHomeBackup({
          homeDir: fixture.home,
          outputDir: join(fixture.root, 'backup'),
        }),
      ).toThrow(/must be inactive before backup/);
    } finally {
      lease.release();
    }
  });

  it('fails closed for corrupt SQLite without publishing partial output', () => {
    const fixture = homeFixture();
    const backupDir = join(fixture.root, 'backup');
    writeFileSync(
      join(fixture.home, 'data', 'orchestration.sqlite'),
      'not sqlite',
    );

    expect(() =>
      createStationHomeBackup({
        homeDir: fixture.home,
        outputDir: backupDir,
      }),
    ).toThrow(/SQLite integrity check failed/);
    expect(() =>
      readFileSync(join(backupDir, STATION_HOME_BACKUP_MANIFEST)),
    ).toThrow();
  });

  it.skipIf(process.platform === 'win32')(
    'refuses symlinks anywhere in the authoritative home',
    () => {
      const fixture = homeFixture();
      const outside = join(fixture.root, 'outside');
      writeFileSync(outside, 'outside');
      symlinkSync(outside, join(fixture.home, 'config', 'linked.json'));
      expect(() =>
        createStationHomeBackup({
          homeDir: fixture.home,
          outputDir: join(fixture.root, 'backup'),
        }),
      ).toThrow(/symbolic link/);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'preserves a literal POSIX backslash as one path segment',
    () => {
      const fixture = homeFixture();
      const literal = 'literal\\name.json';
      writeFileSync(join(fixture.home, 'config', literal), 'literal');
      const backupDir = join(fixture.root, 'backup');
      const backup = createStationHomeBackup({
        homeDir: fixture.home,
        outputDir: backupDir,
      });
      expect(
        backup.manifest.files.some(
          (file) =>
            file.path.length === 2 &&
            file.path[0] === 'config' &&
            file.path[1] === literal,
        ),
      ).toBe(true);
      rmSync(join(fixture.home, 'config', literal));
      restoreStationHomeBackup({
        backupDir,
        homeDir: fixture.home,
        confirm: true,
      });
      expect(readFileSync(join(fixture.home, 'config', literal), 'utf8')).toBe(
        'literal',
      );
    },
  );

  it('detects tampering before restore and preserves the current home', () => {
    const fixture = homeFixture();
    const backupDir = join(fixture.root, 'backup');
    createStationHomeBackup({ homeDir: fixture.home, outputDir: backupDir });
    writeFileSync(
      join(backupDir, 'home', 'config', 'app.json'),
      '{"model":"tampered"}\n',
    );
    writeFileSync(join(fixture.home, 'config', 'app.json'), 'current');

    expect(() =>
      restoreStationHomeBackup({
        backupDir,
        homeDir: fixture.home,
        confirm: true,
      }),
    ).toThrow(/hash does not match/);
    expect(readFileSync(join(fixture.home, 'config', 'app.json'), 'utf8')).toBe(
      'current',
    );
  });

  it('requires confirmation and rolls back a pre-publication failure', () => {
    const fixture = homeFixture();
    const backupDir = join(fixture.root, 'backup');
    createStationHomeBackup({ homeDir: fixture.home, outputDir: backupDir });
    expect(() =>
      restoreStationHomeBackup({
        backupDir,
        homeDir: fixture.home,
        confirm: false,
      }),
    ).toThrow(/explicit confirmation/);
    let failure: unknown;
    try {
      restoreStationHomeBackup({
        backupDir,
        homeDir: fixture.home,
        confirm: true,
        beforePublish: () => {
          throw new Error('injected publication failure');
        },
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(StationHomeArchiveError);
    expect((failure as Error & { cause?: unknown }).cause).toMatchObject({
      message: 'injected publication failure',
    });
    expect(readFileSync(join(fixture.home, 'config', 'app.json'), 'utf8')).toBe(
      '{"model":"original"}\n',
    );
    expect(() =>
      restoreStationHomeBackup({
        backupDir,
        homeDir: fixture.home,
        confirm: true,
        afterPublish: () => {
          throw new Error('injected post-publication failure');
        },
      }),
    ).toThrow(/backup could not be restored/);
    expect(readFileSync(join(fixture.home, 'config', 'app.json'), 'utf8')).toBe(
      '{"model":"original"}\n',
    );
  });

  it('removes a newly published backup when final durability fails', () => {
    const fixture = homeFixture();
    const backupDir = join(fixture.root, 'backup');
    expect(() =>
      createStationHomeBackup({
        homeDir: fixture.home,
        outputDir: backupDir,
        afterPublish: () => {
          throw new Error('injected backup durability failure');
        },
      }),
    ).toThrow(/backup could not be created/);
    expect(() =>
      readFileSync(join(backupDir, STATION_HOME_BACKUP_MANIFEST)),
    ).toThrow();
  });

  it('enforces bounded manifests and file content', () => {
    const fixture = homeFixture();
    expect(() =>
      createStationHomeBackup({
        homeDir: fixture.home,
        outputDir: join(fixture.root, 'backup'),
        maxFiles: 1,
        maxBytes: 1_000_000,
        maxFileBytes: 1_000_000,
      }),
    ).toThrow(/file-count limit/);
  });

  it('reads the same validated manifest exposed by create', () => {
    const fixture = homeFixture();
    const backupDir = join(fixture.root, 'backup');
    const created = createStationHomeBackup({
      homeDir: fixture.home,
      outputDir: backupDir,
    });
    expect(readStationHomeBackupManifest(backupDir)).toEqual(created.manifest);
  });

  it('uses a typed failure for invalid archives', () => {
    const invalid = root();
    expect(() => readStationHomeBackupManifest(invalid)).toThrow(
      StationHomeArchiveError,
    );
  });
});

describe('a corruption marker never travels in a backup', () => {
  test('the manifest excludes it, so a restore cannot condemn a healthy store', () => {
    // collectFiles already refuses to archive an unhealthy *.sqlite, so every
    // archived home holds a database that PASSED quick_check. Carrying a
    // marker beside it would restore a home whose own backup proved the
    // database healthy while asserting it is corrupt, and the quarantine step
    // (station#3217) would then raze it (station#3215).
    const fixture = homeFixture();
    const backupDir = join(fixture.root, 'backup');
    recordCorruptionObserved({
      databasePath: join(fixture.home, 'data', 'orchestration.sqlite'),
      observedAt: '2026-08-18T00:00:00.000Z',
      errcode: 11,
    });
    expect(
      existsSync(join(fixture.home, 'data', SQLITE_CORRUPTION_MARKER_FILE)),
    ).toBe(true);

    const backup = createStationHomeBackup({
      homeDir: fixture.home,
      outputDir: backupDir,
      assertInactive: vi.fn(),
      now: () => '2026-08-18T00:00:00.000Z',
    });

    const paths = backup.manifest.files.map((file) => file.path.join('/'));
    expect(paths).toContain('data/orchestration.sqlite');
    expect(paths).not.toContain(`data/${SQLITE_CORRUPTION_MARKER_FILE}`);
  });
});

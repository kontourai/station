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
  readStationHomeRecovery,
  restoreStationHomeBackup,
  STATION_HOME_BACKUP_MANIFEST,
  STATION_HOME_RECOVERY_RECORD,
  StationHomeArchiveError,
  type StationHomeBackupManifest,
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

it('atomically records recovery-from-copy provenance without claiming transferred authority', () => {
  const fixture = homeFixture();
  const backup = createStationHomeBackup({
    homeDir: fixture.home,
    outputDir: join(fixture.root, 'backup'),
    now: () => '2026-09-05T00:00:00.000Z',
  });
  expect(readStationHomeRecovery(fixture.home)).toEqual({
    kind: 'not-restored',
  });
  const target = join(fixture.root, 'target');
  const result = restoreStationHomeBackup({
    homeDir: target,
    backupDir: backup.backupDir,
    confirm: true,
  });
  expect(readStationHomeRecovery(target)).toEqual({
    kind: 'recovered',
    recovery: result.recovery,
  });
  expect(result.recovery).toMatchObject({
    kind: 'recovered-from-copy',
    snapshotCreatedAt: backup.manifest.createdAt,
    backupManifestSha256: createHash('sha256')
      .update(JSON.stringify(backup.manifest))
      .digest('hex'),
    authorityTransferred: false,
  });
  expect(JSON.stringify(result.recovery)).not.toContain(fixture.root);
  const second = createStationHomeBackup({
    homeDir: target,
    outputDir: join(fixture.root, 'second-backup'),
  });
  const repeat = restoreStationHomeBackup({
    homeDir: target,
    backupDir: second.backupDir,
    confirm: true,
  });
  expect(repeat.recovery.recoveryId).not.toBe(result.recovery.recoveryId);
  expect(readStationHomeRecovery(target)).toEqual({
    kind: 'recovered',
    recovery: repeat.recovery,
  });
});

it('a failed restore rolls back the recovery disclosure with the home', () => {
  const fixture = homeFixture();
  const backup = createStationHomeBackup({
    homeDir: fixture.home,
    outputDir: join(fixture.root, 'backup'),
  });
  expect(() =>
    restoreStationHomeBackup({
      homeDir: fixture.home,
      backupDir: backup.backupDir,
      confirm: true,
      afterPublish: () => {
        throw new Error('publication fault');
      },
    }),
  ).toThrow();
  expect(readStationHomeRecovery(fixture.home)).toEqual({
    kind: 'not-restored',
  });
  expect(
    readFileSync(join(fixture.home, 'config', 'app.json'), 'utf8'),
  ).toContain('original');
});

it('malformed recovery disclosure stays unavailable rather than claiming a normal or transferred home', () => {
  const fixture = homeFixture();
  const path = join(fixture.home, STATION_HOME_RECOVERY_RECORD);
  for (const value of ['{}', 'x'.repeat(5000)]) {
    writeFileSync(path, value);
    expect(readStationHomeRecovery(fixture.home)).toEqual({
      kind: 'unavailable',
    });
  }
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
    const empty = join(fixture.home, 'agents', 'research', 'memory', 'empty');
    mkdirSync(empty, { recursive: true });
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
    rmSync(join(fixture.home, 'agents'), { recursive: true });
    const restored = restoreStationHomeBackup({
      backupDir,
      homeDir: fixture.home,
      confirm: true,
      assertInactive: inactive,
    });
    expect(readFileSync(join(fixture.home, 'config', 'app.json'), 'utf8')).toBe(
      '{"model":"original"}\n',
    );
    expect(existsSync(empty), 'the empty directory must survive restore').toBe(
      true,
    );
    expect(readdirSync(empty)).toEqual([]);
    expect(existsSync(join(empty, 'never-created'))).toBe(false);
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

  it.each(['file bytes', 'missing directory', 'unlisted directory'] as const)(
    'detects tampering (%s) before restore and preserves the current home',
    (change) => {
      const fixture = homeFixture();
      const backupDir = join(fixture.root, 'backup');
      mkdirSync(join(fixture.home, 'empty'));
      createStationHomeBackup({ homeDir: fixture.home, outputDir: backupDir });
      if (change === 'file bytes')
        writeFileSync(
          join(backupDir, 'home', 'config', 'app.json'),
          '{"model":"tampered"}\n',
        );
      else if (change === 'missing directory')
        rmSync(join(backupDir, 'home', 'empty'), { recursive: true });
      else mkdirSync(join(backupDir, 'home', 'unlisted'));
      writeFileSync(join(fixture.home, 'config', 'app.json'), 'current');

      expect(() =>
        restoreStationHomeBackup({
          backupDir,
          homeDir: fixture.home,
          confirm: true,
        }),
      ).toThrow(
        change === 'file bytes'
          ? /hash does not match/
          : /directories do not match/,
      );
      expect(
        readFileSync(join(fixture.home, 'config', 'app.json'), 'utf8'),
      ).toBe('current');
    },
  );

  it('restores a complete v1 archive that recorded media tools', () => {
    const parent = root();
    const home = join(parent, 'home');
    ensureStationHomeSchemaSync(home);
    const marker = readFileSync(join(home, STATION_HOME_SCHEMA_FILE));
    writeFileSync(join(home, 'current.txt'), 'current state');
    const backupDir = join(parent, 'legacy-backup');
    mkdirSync(join(backupDir, 'home', 'media-tools'), { recursive: true });
    const entries = [
      { path: [STATION_HOME_SCHEMA_FILE], bytes: marker },
      { path: ['media-tools', 'tool'], bytes: Buffer.from('saved tool bytes') },
    ];
    for (const entry of entries)
      writeFileSync(join(backupDir, 'home', ...entry.path), entry.bytes, {
        mode: 0o600,
      });
    const manifest: StationHomeBackupManifest = {
      schemaVersion: 'station.home-backup/v1',
      homeSchemaVersion: JSON.parse(marker.toString('utf8')).version,
      createdAt: '2026-09-05T00:00:00.000Z',
      files: entries.map(({ path, bytes }) => ({
        path,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        mode: 0o600,
      })),
      totalBytes: entries.reduce(
        (total, entry) => total + entry.bytes.length,
        0,
      ),
    };
    writeFileSync(
      join(backupDir, STATION_HOME_BACKUP_MANIFEST),
      JSON.stringify(manifest),
    );

    try {
      restoreStationHomeBackup({ backupDir, homeDir: home, confirm: true });
    } catch (error) {
      expect(readFileSync(join(home, 'current.txt'), 'utf8')).toBe(
        'current state',
      );
      expect(readFileSync(join(home, STATION_HOME_SCHEMA_FILE))).toEqual(
        marker,
      );
      throw error;
    }
    expect(readFileSync(join(home, 'media-tools', 'tool'), 'utf8')).toBe(
      'saved tool bytes',
    );
    expect(existsSync(join(home, 'current.txt'))).toBe(false);
  });

  it('reads a v1 backup without inventing directory history', () => {
    const fixture = homeFixture();
    mkdirSync(join(fixture.home, 'empty'));
    const backup = createStationHomeBackup({
      homeDir: fixture.home,
      outputDir: join(fixture.root, 'legacy-backup'),
    });
    const { directories: _directories, ...legacy } = backup.manifest;
    writeFileSync(
      join(backup.backupDir, STATION_HOME_BACKUP_MANIFEST),
      JSON.stringify({ ...legacy, schemaVersion: 'station.home-backup/v1' }),
    );
    rmSync(join(backup.backupDir, 'home', 'empty'), { recursive: true });
    const manifest = readStationHomeBackupManifest(backup.backupDir, {
      maxFiles: 3,
    });
    expect(manifest.schemaVersion).toBe('station.home-backup/v1');
    expect(manifest).not.toHaveProperty('directories');
    const target = join(fixture.root, 'legacy-restored');
    restoreStationHomeBackup({
      backupDir: backup.backupDir,
      homeDir: target,
      confirm: true,
      maxFiles: 3,
    });
    expect(readFileSync(join(target, 'config', 'app.json'), 'utf8')).toBe(
      '{"model":"original"}\n',
    );
    expect(existsSync(join(target, 'empty'))).toBe(false);
  });

  it.each([
    'duplicate',
    'unsafe',
    'root',
    'file collision',
    'missing parent',
    'alias',
  ] as const)(
    'refuses a v2 directory plan with %s before replacing current data',
    (change) => {
      const fixture = homeFixture();
      const backup = createStationHomeBackup({
        homeDir: fixture.home,
        outputDir: join(fixture.root, 'invalid-plan'),
      });
      const manifest = backup.manifest;
      if (!manifest.directories) throw new Error('Expected v2 directories');
      if (change === 'duplicate') manifest.directories.push(['config']);
      else if (change === 'unsafe') manifest.directories.push(['..']);
      else if (change === 'root') manifest.directories.push([]);
      else if (change === 'file collision')
        manifest.directories.push(['config', 'app.json']);
      else if (change === 'missing parent')
        manifest.directories = manifest.directories.filter(
          (path) => path[0] !== 'config',
        );
      else manifest.directories.push(['CONFIG']);
      writeFileSync(
        join(backup.backupDir, STATION_HOME_BACKUP_MANIFEST),
        JSON.stringify(manifest),
      );
      writeFileSync(join(fixture.home, 'config', 'app.json'), 'current');
      expect(() =>
        restoreStationHomeBackup({
          homeDir: fixture.home,
          backupDir: backup.backupDir,
          confirm: true,
        }),
      ).toThrow(StationHomeArchiveError);
      expect(
        readFileSync(join(fixture.home, 'config', 'app.json'), 'utf8'),
      ).toBe('current');
    },
  );

  it('counts directory-only entries against the archive entry bound', () => {
    const parent = root();
    const home = join(parent, 'home');
    ensureStationHomeSchemaSync(home);
    mkdirSync(join(home, 'empty', 'nested'), { recursive: true });
    expect(() =>
      createStationHomeBackup({
        homeDir: home,
        outputDir: join(parent, 'too-many'),
        maxFiles: 2,
      }),
    ).toThrow(/file-count limit/);
    expect(existsSync(join(parent, 'too-many'))).toBe(false);
    const backup = createStationHomeBackup({
      homeDir: home,
      outputDir: join(parent, 'fits'),
      maxFiles: 3,
    });
    expect(
      readStationHomeBackupManifest(backup.backupDir, { maxFiles: 3 })
        .directories,
    ).toEqual([['empty'], ['empty', 'nested']]);
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

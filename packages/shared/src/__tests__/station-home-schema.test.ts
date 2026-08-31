import fs, {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ensureStationHomeSchemaSync,
  migrationPath,
  PORTABLE_INSTALL_DATA_ROOT_MARKER,
  PORTABLE_INSTALL_DATA_ROOT_SIGNATURE,
  readRegularFileNoFollow,
  readStationHomeSchemaVersion,
  STATION_HOME_RESET_COMMAND,
  STATION_HOME_SCHEMA_FILE,
  STATION_HOME_SCHEMA_MIGRATIONS,
  STATION_HOME_SCHEMA_VERSION,
  StationHomeMigrationRequiredError,
  StationHomeResetRequiredError,
  StationHomeSchemaDowngradeError,
  stationHomeSchemaNeedsReset,
} from '../station-home-schema.js';

const roots: string[] = [];

function makeHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'station-home-schema-'));
  roots.push(root);
  return join(root, 'home');
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe('STATION_HOME_RESET_REQUIRED error text (station#1913)', () => {
  it('names the supported reset command, not just "manually"', () => {
    const error = new StationHomeResetRequiredError('/home/brian/.station');

    // Pinned to the exact command string so the error text and the actual
    // CLI verb cannot drift apart the way the old "reset this home
    // manually" text did -- it named no command at all.
    expect(STATION_HOME_RESET_COMMAND).toBe('station home reset --confirm');
    expect(error.message).toContain(STATION_HOME_RESET_COMMAND);
    expect(error.message).not.toContain('manually');
  });
});

describe('stationHomeSchemaNeedsReset (station#1913)', () => {
  it('is false for a home that does not exist yet (fresh bootstrap)', () => {
    const home = makeHome();
    expect(existsSync(home)).toBe(false);
    expect(stationHomeSchemaNeedsReset(home)).toBe(false);
  });

  it('is false for empty bootstrap scaffolding (an empty `config` dir only)', () => {
    const home = makeHome();
    mkdirSync(join(home, 'config'), { recursive: true });
    expect(stationHomeSchemaNeedsReset(home)).toBe(false);
  });

  it('is true for a marker-less home with real content -- the exact pre-#1560 shape from station#1913', () => {
    const home = makeHome();
    mkdirSync(join(home, 'agents'), { recursive: true });
    writeFileSync(join(home, 'agents', 'some-agent.json'), '{}');

    expect(stationHomeSchemaNeedsReset(home)).toBe(true);
  });

  it('is false once the gate has stamped the current-version marker', () => {
    const home = makeHome();
    ensureStationHomeSchemaSync(home, { acquireMutationLock: () => () => {} });
    expect(existsSync(join(home, STATION_HOME_SCHEMA_FILE))).toBe(true);

    expect(stationHomeSchemaNeedsReset(home)).toBe(false);
  });

  it('exposes a read-only exact version for backup admission', () => {
    const home = makeHome();
    ensureStationHomeSchemaSync(home);
    expect(readStationHomeSchemaVersion(home)).toBe(
      STATION_HOME_SCHEMA_VERSION,
    );
  });

  it('is false when a valid marker names a different schema version: reset is not the migration bridge', () => {
    const home = makeHome();
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(home, STATION_HOME_SCHEMA_FILE),
      JSON.stringify({ version: STATION_HOME_SCHEMA_VERSION + 1 }),
    );

    expect(stationHomeSchemaNeedsReset(home)).toBe(false);
  });
});

describe('portable installer data-root claim', () => {
  it('bootstraps a fresh home whose only content is the exact installer marker', () => {
    const home = makeHome();
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(home, PORTABLE_INSTALL_DATA_ROOT_MARKER),
      PORTABLE_INSTALL_DATA_ROOT_SIGNATURE,
    );

    expect(stationHomeSchemaNeedsReset(home)).toBe(false);
    ensureStationHomeSchemaSync(home, { acquireMutationLock: () => () => {} });
    expect(existsSync(join(home, STATION_HOME_SCHEMA_FILE))).toBe(true);
    expect(
      readFileSync(join(home, PORTABLE_INSTALL_DATA_ROOT_MARKER), 'utf8'),
    ).toBe(PORTABLE_INSTALL_DATA_ROOT_SIGNATURE);
  });

  it('resets a home whose installer marker is not the exact installer bytes', () => {
    const home = makeHome();
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(home, PORTABLE_INSTALL_DATA_ROOT_MARKER),
      'not the signature\n',
    );

    expect(stationHomeSchemaNeedsReset(home)).toBe(true);
    expect(() => ensureStationHomeSchemaSync(home)).toThrow(
      StationHomeResetRequiredError,
    );
    expect(existsSync(join(home, STATION_HOME_SCHEMA_FILE))).toBe(false);
  });

  it('resets a home whose installer marker path is a directory', () => {
    const home = makeHome();
    mkdirSync(join(home, PORTABLE_INSTALL_DATA_ROOT_MARKER), {
      recursive: true,
    });

    expect(stationHomeSchemaNeedsReset(home)).toBe(true);
  });

  it('pins the marker name and signature to install.sh so neither side drifts alone', () => {
    const installer = readFileSync(
      resolve(import.meta.dirname, '../../../..', 'install.sh'),
      'utf8',
    );

    expect(installer).toContain(
      `DATA_ROOT_MARKER='${PORTABLE_INSTALL_DATA_ROOT_MARKER}'`,
    );
    expect(installer).toContain(
      `DATA_ROOT_SIGNATURE='${PORTABLE_INSTALL_DATA_ROOT_SIGNATURE.trimEnd()}'`,
    );
    // Bytes-written must equal bytes-accepted, newline included: install.sh
    // appends the newline the TS constant carries, so pin BOTH halves — the
    // write expression and the constant's terminal newline. Either side
    // drifting alone re-breaks every fresh install silently.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the literal source text of the installer's template expression
    expect(installer).toContain('fs.writeFileSync(fd, `${signature}\\n`)');
    expect(PORTABLE_INSTALL_DATA_ROOT_SIGNATURE).toBe(
      `${PORTABLE_INSTALL_DATA_ROOT_SIGNATURE.trimEnd()}\n`,
    );
  });

  it('treats an unreadable marker as not-scaffolding instead of throwing', () => {
    // The discriminating case for the hardened read: the raw reader threw
    // EACCES here, escaping the fail-closed predicate entirely.
    const home = mkdtempSync(join(tmpdir(), 'station-home-unreadable-marker-'));
    const marker = join(home, PORTABLE_INSTALL_DATA_ROOT_MARKER);
    writeFileSync(marker, PORTABLE_INSTALL_DATA_ROOT_SIGNATURE);
    chmodSync(marker, 0o000);
    try {
      expect(stationHomeSchemaNeedsReset(home)).toBe(true);
    } finally {
      chmodSync(marker, 0o600);
    }
  });

  it('refuses a symlinked marker even when its target holds the exact signature', () => {
    const home = mkdtempSync(join(tmpdir(), 'station-home-symlink-marker-'));
    const outside = mkdtempSync(join(tmpdir(), 'station-marker-target-'));
    writeFileSync(
      join(outside, 'target'),
      PORTABLE_INSTALL_DATA_ROOT_SIGNATURE,
    );
    symlinkSync(
      join(outside, 'target'),
      join(home, PORTABLE_INSTALL_DATA_ROOT_MARKER),
    );
    expect(stationHomeSchemaNeedsReset(home)).toBe(true);
  });
});

describe('a home whose ancestors do not exist yet (#1090)', () => {
  // Every other home in this suite is a direct child of a live `mkdtemp`
  // directory, so its PARENT always exists. That made the real first-run
  // shape structurally unreachable here: the default home is
  // `<STATION_ROOT>/instances/<channel>/<id>`, and on a machine that has
  // never run Station the `instances/<channel>` chain is absent.
  function makeDeepHome(): { root: string; home: string } {
    const root = mkdtempSync(join(tmpdir(), 'station-home-fresh-machine-'));
    roots.push(root);
    return { root, home: join(root, 'instances', 'dev', 'station-abc123') };
  }

  it('scaffolds a home two levels below a missing ancestor instead of demanding a reset', () => {
    const { home } = makeDeepHome();
    expect(existsSync(dirname(home))).toBe(false);

    // Regression: this threw STATION_HOME_RESET_REQUIRED naming a home that
    // did not exist. The reset it prescribed resolved through this same
    // function, so it failed identically and a first install had no way
    // forward at all.
    expect(() => ensureStationHomeSchemaSync(home)).not.toThrow();

    expect(existsSync(home)).toBe(true);
    expect(
      JSON.parse(readFileSync(join(home, STATION_HOME_SCHEMA_FILE), 'utf8')),
    ).toEqual({ version: STATION_HOME_SCHEMA_VERSION });
  });

  it('does not report a reset for a home whose ancestors are absent', () => {
    const { home } = makeDeepHome();
    // Nothing is there, so there is no schema to be incompatible with.
    expect(stationHomeSchemaNeedsReset(home)).toBe(false);
  });

  it('is idempotent: the second call sees the marker it just wrote', () => {
    const { home } = makeDeepHome();
    ensureStationHomeSchemaSync(home);
    expect(() => ensureStationHomeSchemaSync(home)).not.toThrow();
  });

  it('still fails closed when the parent cannot be inspected for a reason other than absence', () => {
    // Only ENOENT means "fresh". An ancestor that exists but cannot be read
    // is exactly the case the original bare catch was protecting, and it
    // must keep resetting rather than bootstrapping over unknown state.
    const { home } = makeDeepHome();
    mkdirSync(dirname(home), { recursive: true });
    const realRealpathSync = fs.realpathSync;
    const denied = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    (fs as { realpathSync: typeof fs.realpathSync }).realpathSync = ((
      target: Parameters<typeof fs.realpathSync>[0],
    ) => {
      if (resolve(String(target)) === resolve(dirname(home))) throw denied;
      return realRealpathSync(target as never);
    }) as typeof fs.realpathSync;
    syncBuiltinESMExports();
    try {
      // Either guard may claim it first -- `admitStationRuntimeHome` reports
      // an uninspectable ancestor before the schema gate sees it. What must
      // hold is that an unreadable ancestor never reads as a fresh home.
      expect(() => ensureStationHomeSchemaSync(home)).toThrow(/EACCES/);
      expect(existsSync(join(home, STATION_HOME_SCHEMA_FILE))).toBe(false);
    } finally {
      (fs as { realpathSync: typeof fs.realpathSync }).realpathSync =
        realRealpathSync;
      syncBuiltinESMExports();
    }
  });
});

describe('runtime-home admission', () => {
  it('rejects the shared root before schema bootstrap can create its marker', () => {
    const sharedRoot = mkdtempSync(join(tmpdir(), 'station-shared-root-'));
    roots.push(sharedRoot);
    const previousRoot = process.env.STATION_ROOT;
    process.env.STATION_ROOT = sharedRoot;
    try {
      expect(() => ensureStationHomeSchemaSync(sharedRoot)).toThrow(
        /not admissible/,
      );
      expect(existsSync(join(sharedRoot, STATION_HOME_SCHEMA_FILE))).toBe(
        false,
      );
    } finally {
      if (previousRoot === undefined) delete process.env.STATION_ROOT;
      else process.env.STATION_ROOT = previousRoot;
    }
  });
});

describe('home schema migrations (station#1935)', () => {
  const testLock = () => () => {};

  function homeAtVersion(version: number): string {
    const home = makeHome();
    mkdirSync(join(home, 'config'), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(home, 'config', 'preserved.txt'),
      'keep this data',
      'utf8',
    );
    writeFileSync(
      join(home, STATION_HOME_SCHEMA_FILE),
      JSON.stringify({ version }),
      'utf8',
    );
    return home;
  }

  it('derives an ordered multi-step path from out-of-order registration', () => {
    const first = { fromVersion: 1, migrate: () => {} };
    const second = { fromVersion: 2, migrate: () => {} };
    expect(migrationPath(1, [second, first], 3)).toEqual([first, second]);
  });

  it('rejects duplicate fromVersion registrations before touching the home', () => {
    const duplicate = { fromVersion: 1, migrate: () => {} };
    expect(() => migrationPath(1, [duplicate, { ...duplicate }], 3)).toThrow(
      'migration[1] duplicates fromVersion 1 already declared by migration[0]',
    );
  });

  it('rejects invalid and non-forward migration registrations', () => {
    expect(() =>
      migrationPath(1, [{ fromVersion: 1.5, migrate: () => {} }], 3),
    ).toThrow(
      'migration[0] has invalid fromVersion 1.5; fromVersion must be a positive integer',
    );
    expect(() =>
      migrationPath(1, [{ fromVersion: 3, migrate: () => {} }], 3),
    ).toThrow(
      'migration[0] has non-forward fromVersion 3; it must be less than target schema 3',
    );
  });

  it('fails closed with the missing migration step instead of resetting a home', () => {
    expect(() =>
      migrationPath(1, [{ fromVersion: 1, migrate: () => {} }], 3),
    ).toThrow(new StationHomeMigrationRequiredError(2, 3).message);
  });

  it('refuses bootstrap beside an orphaned migration backup without deleting stranded data', () => {
    const home = makeHome();
    const backup = join(
      dirname(home),
      `.${basename(home)}.station-home-migration.123.backup.previous`,
    );
    mkdirSync(join(backup, 'config'), { recursive: true });
    writeFileSync(join(backup, 'config', 'preserved.txt'), 'keep this data');

    expect(() =>
      ensureStationHomeSchemaSync(home, { acquireMutationLock: testLock }),
    ).toThrow('STATION_HOME_MIGRATION_RECOVERY_REQUIRED');
    expect(readFileSync(join(backup, 'config', 'preserved.txt'), 'utf8')).toBe(
      'keep this data',
    );
    expect(existsSync(home)).toBe(false);
  });

  it('refuses bare bootstrap scaffolding beside an orphaned migration backup', () => {
    const home = makeHome();
    mkdirSync(join(home, 'config'), { recursive: true });
    const backup = join(
      dirname(home),
      `.${basename(home)}.station-home-migration.123.bare.previous`,
    );
    mkdirSync(join(backup, 'config'), { recursive: true });
    writeFileSync(join(backup, 'config', 'preserved.txt'), 'keep this data');

    expect(() =>
      ensureStationHomeSchemaSync(home, { acquireMutationLock: testLock }),
    ).toThrow('STATION_HOME_MIGRATION_RECOVERY_REQUIRED');
    expect(readFileSync(join(backup, 'config', 'preserved.txt'), 'utf8')).toBe(
      'keep this data',
    );
    expect(existsSync(join(home, STATION_HOME_SCHEMA_FILE))).toBe(false);
  });

  it('keeps the migration registry empty until #2469 proves home quiescence and bounded staging copy', () => {
    expect(
      STATION_HOME_SCHEMA_MIGRATIONS,
      'station#2469 must close before adding a home-schema migration: prove home quiescence (including WAL databases) and bound staging-copy disk usage first.',
    ).toHaveLength(0);
  });

  it('rejects a v1 app config with synthetic engine connection keys even when the registry is absent', () => {
    const home = homeAtVersion(1);
    const appConfigPath = join(home, 'config', 'app.json');
    writeFileSync(
      appConfigPath,
      JSON.stringify({ agentConnections: { 'claude-runtime': {} } }),
    );

    expect(stationHomeSchemaNeedsReset(home)).toBe(true);
    expect(() =>
      ensureStationHomeSchemaSync(home, { acquireMutationLock: testLock }),
    ).toThrow('STATION_HOME_RESET_REQUIRED');
    expect(JSON.parse(readFileSync(appConfigPath, 'utf8'))).toEqual({
      agentConnections: { 'claude-runtime': {} },
    });
  });

  it('rejects a v1 app config with a synthetic built-in engine connection id even when the registry is absent', () => {
    const home = homeAtVersion(1);
    const appConfigPath = join(home, 'config', 'app.json');
    writeFileSync(
      appConfigPath,
      JSON.stringify({ builtinAgentEngineConnectionId: 'codex-runtime' }),
    );

    expect(stationHomeSchemaNeedsReset(home)).toBe(true);
    expect(() =>
      ensureStationHomeSchemaSync(home, { acquireMutationLock: testLock }),
    ).toThrow('STATION_HOME_RESET_REQUIRED');
    expect(JSON.parse(readFileSync(appConfigPath, 'utf8'))).toEqual({
      builtinAgentEngineConnectionId: 'codex-runtime',
    });
  });

  it('rejects a v1 Agent record with a synthetic engine connection id even when the registry is absent', () => {
    const home = homeAtVersion(1);
    const agentPath = join(home, 'agents', 'legacy', 'agent.json');
    mkdirSync(dirname(agentPath), { recursive: true });
    writeFileSync(
      agentPath,
      JSON.stringify({
        name: 'Legacy',
        execution: { agentConnectionId: 'claude-runtime' },
      }),
    );

    expect(stationHomeSchemaNeedsReset(home)).toBe(true);
    expect(() =>
      ensureStationHomeSchemaSync(home, { acquireMutationLock: testLock }),
    ).toThrow('STATION_HOME_RESET_REQUIRED');
    expect(JSON.parse(readFileSync(agentPath, 'utf8'))).toMatchObject({
      execution: { agentConnectionId: 'claude-runtime' },
    });
  });

  it('refuses a future-version home instead of migrating or resetting it', () => {
    const home = homeAtVersion(STATION_HOME_SCHEMA_VERSION + 1);
    const dataPath = join(home, 'config', 'preserved.txt');

    expect(() =>
      ensureStationHomeSchemaSync(home, { acquireMutationLock: testLock }),
    ).toThrow(
      new StationHomeSchemaDowngradeError(
        STATION_HOME_SCHEMA_VERSION + 1,
        STATION_HOME_SCHEMA_VERSION,
      ).message,
    );
    expect(readFileSync(dataPath, 'utf8')).toBe('keep this data');
  });
});

describe('readRegularFileNoFollow bounded reads', () => {
  function createFile(source: string): { home: string; path: string } {
    const home = makeHome();
    mkdirSync(home, { recursive: true });
    const path = join(home, 'bounded.txt');
    writeFileSync(path, source, 'utf8');
    return { home, path };
  }

  it('rejects a file above the cap before any descriptor bytes are read', () => {
    const { home, path } = createFile('12345');
    const originalRead = fs.readSync;
    let descriptorBytesRead = 0;
    try {
      fs.readSync = ((fd, ...args) => {
        const count = Reflect.apply(originalRead, fs, [fd, ...args]);
        if (typeof fd === 'number') descriptorBytesRead += count;
        return count;
      }) as typeof fs.readSync;
      syncBuiltinESMExports();

      expect(() =>
        readRegularFileNoFollow(home, path, { maxBytes: 4 }),
      ).toThrow(StationHomeResetRequiredError);
      expect(descriptorBytesRead).toBe(0);
    } finally {
      fs.readSync = originalRead;
      syncBuiltinESMExports();
    }
  });

  it('reads no more than maxBytes plus one when an opened file grows', () => {
    const { home, path } = createFile('safe');
    const target = fs.statSync(path);
    const originalStat = fs.fstatSync;
    const originalRead = fs.readSync;
    let grew = false;
    let descriptorBytesRead = 0;
    const isTarget = (fd: number) => {
      const actual = originalStat(fd);
      return actual.dev === target.dev && actual.ino === target.ino;
    };
    try {
      fs.fstatSync = ((...args) => {
        const stat = Reflect.apply(originalStat, fs, args);
        if (!grew && isTarget(args[0])) {
          grew = true;
          fs.appendFileSync(path, '0123456789');
        }
        return stat;
      }) as typeof fs.fstatSync;
      fs.readSync = ((fd, ...args) => {
        const count = Reflect.apply(originalRead, fs, [fd, ...args]);
        if (isTarget(fd)) descriptorBytesRead += count;
        return count;
      }) as typeof fs.readSync;
      syncBuiltinESMExports();

      expect(() =>
        readRegularFileNoFollow(home, path, { maxBytes: 4 }),
      ).toThrow(StationHomeResetRequiredError);
      expect(grew).toBe(true);
      expect(descriptorBytesRead).toBeLessThanOrEqual(5);
    } finally {
      fs.fstatSync = originalStat;
      fs.readSync = originalRead;
      syncBuiltinESMExports();
    }
  });

  it('returns the exact source when descriptor reads are short', () => {
    const source = 'short descriptor reads preserve every byte';
    const { home, path } = createFile(source);
    const originalRead = fs.readSync;
    try {
      fs.readSync = ((fd, buffer, offset, length, position) =>
        Reflect.apply(originalRead, fs, [
          fd,
          buffer,
          offset,
          Math.min(length, 2),
          position,
        ])) as typeof fs.readSync;
      syncBuiltinESMExports();

      expect(readRegularFileNoFollow(home, path, { maxBytes: 64 })).toBe(
        source,
      );
    } finally {
      fs.readSync = originalRead;
      syncBuiltinESMExports();
    }
  });
});

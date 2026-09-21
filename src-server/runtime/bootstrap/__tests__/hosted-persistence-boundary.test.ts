import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  type Stats,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertHostedPersistenceBeforeSchemaSync,
  type HostedPersistenceBoundaryDependencies,
  HostedPersistenceBoundaryError,
  prepareHostedPersistenceAfterSchemaSync,
} from '../hosted-persistence-boundary.js';

const hostedEnvironment = {
  STATION_HOSTED_TENANT_REGISTRY_FILE: '/deployment/tenant-registry.json',
};

const runtimeMocks = vi.hoisted(() => ({
  eventStore: vi.fn(),
}));

vi.mock('../../../services/orchestration/event-store.js', () => ({
  EventStore: class {
    constructor(path: string) {
      runtimeMocks.eventStore(path);
    }
    close() {}
  },
}));

function actualDependencies(
  overrides: Partial<HostedPersistenceBoundaryDependencies> = {},
): HostedPersistenceBoundaryDependencies {
  return {
    platform: process.platform,
    getuid: process.getuid?.bind(process),
    lstatSync,
    fstatSync,
    mkdirSync,
    openSync,
    closeSync,
    fchmodSync,
    constants,
    ...overrides,
  };
}

function fixtureHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function secureHomeWithData(prefix: string): {
  home: string;
  data: string;
  database: string;
} {
  const home = fixtureHome(prefix);
  const data = join(home, 'data');
  const database = join(data, 'orchestration.sqlite');
  chmodSync(home, 0o700);
  mkdirSync(data, { mode: 0o700 });
  chmodSync(data, 0o700);
  return { home, data, database };
}

describe('hosted persistence boundary', () => {
  const directories: string[] = [];

  // The full station-runtime graph takes ~5.0s cold to import (measured in
  // the EventStore-order test below), and inside a loaded corpus shard that
  // import has repeatedly outrun the test's own budget (red again in the
  // 2026-09-21 21:54 UTC Nightly). Kick the import off at collection so it
  // overlaps the earlier filesystem tests instead of racing one test's
  // clock; the timed test then pays only construction + assertion. The env
  // var it configures is read at construction time, not module scope, so
  // the early import captures nothing it should not. Module mocks
  // (vi.mock) apply to dynamic imports regardless of timing.
  const stationRuntimeImport: Promise<typeof import('../station-runtime.js')> =
    import('../station-runtime.js');
  // A rejection here would otherwise sit unhandled during the earlier
  // tests; the timed test below still observes it via await.
  stationRuntimeImport.catch(() => {});

  afterEach(() => {
    vi.restoreAllMocks();
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('allows the schema gate to create an absent hosted home only under a non-writable parent', () => {
    const parent = fixtureHome('station-hosted-parent-');
    directories.push(parent);
    const home = join(parent, 'home');

    expect(() =>
      assertHostedPersistenceBeforeSchemaSync(home, hostedEnvironment),
    ).not.toThrow();

    chmodSync(parent, 0o777);
    expect(() =>
      assertHostedPersistenceBeforeSchemaSync(home, hostedEnvironment),
    ).toThrow(/parent must not grant group or other write access/);
    chmodSync(parent, 0o700);
  });

  it('creates a private data directory and database after schema bootstrap', () => {
    const parent = fixtureHome('station-hosted-new-');
    directories.push(parent);
    const home = join(parent, 'home');
    const data = join(home, 'data');
    const database = join(data, 'orchestration.sqlite');
    mkdirSync(home, { mode: 0o700 });
    chmodSync(home, 0o700);

    prepareHostedPersistenceAfterSchemaSync(
      home,
      data,
      database,
      hostedEnvironment,
    );

    expect(lstatSync(data).mode & 0o777).toBe(0o700);
    expect(lstatSync(database).mode & 0o777).toBe(0o600);
    expect(lstatSync(database).isFile()).toBe(true);
  });

  it('rejects a permissive existing Station home before the schema gate', () => {
    const home = fixtureHome('station-hosted-permissive-home-');
    directories.push(home);
    chmodSync(home, 0o755);

    expect(() =>
      assertHostedPersistenceBeforeSchemaSync(home, hostedEnvironment),
    ).toThrow(/Station home must not grant group or other access/);
  });

  it('rejects a symlinked Station home before any later startup work', () => {
    const parent = fixtureHome('station-hosted-home-link-');
    directories.push(parent);
    const target = join(parent, 'target');
    const home = join(parent, 'home');
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, home);

    expect(() =>
      assertHostedPersistenceBeforeSchemaSync(home, hostedEnvironment),
    ).toThrow(/Station home must not be a symbolic link/);
  });

  it('rejects a symlinked parent component even when the final home is a directory', () => {
    const parent = fixtureHome('station-hosted-parent-link-');
    directories.push(parent);
    const target = join(parent, 'target');
    const linkedParent = join(parent, 'linked');
    mkdirSync(target, { mode: 0o700 });
    chmodSync(target, 0o700);
    mkdirSync(join(target, 'home'), { mode: 0o700 });
    chmodSync(join(target, 'home'), 0o700);
    symlinkSync(target, linkedParent);

    expect(() =>
      assertHostedPersistenceBeforeSchemaSync(
        join(linkedParent, 'home'),
        hostedEnvironment,
      ),
    ).toThrow(/persistence path must not contain symbolic links/);
  });

  it('rejects a simulated wrong effective service owner', () => {
    const { home } = secureHomeWithData('station-hosted-owner-');
    directories.push(home);
    const actualUid = process.getuid?.() ?? 501;
    const dependencies = actualDependencies({
      platform: 'linux',
      getuid: () => actualUid,
      lstatSync(path) {
        const stats = lstatSync(path);
        return new Proxy(stats, {
          get(target, property, receiver) {
            if (path === home && property === 'uid') return actualUid + 1;
            return Reflect.get(target, property, receiver);
          },
        }) as Stats;
      },
    });

    expect(() =>
      assertHostedPersistenceBeforeSchemaSync(
        home,
        hostedEnvironment,
        dependencies,
      ),
    ).toThrow(/owned by the service user/);
  });

  it('rejects permissive data and database paths before SQLite can use them', () => {
    const { home, data, database } = secureHomeWithData(
      'station-hosted-permissive-data-',
    );
    directories.push(home);
    chmodSync(data, 0o755);

    expect(() =>
      prepareHostedPersistenceAfterSchemaSync(
        home,
        data,
        database,
        hostedEnvironment,
      ),
    ).toThrow(/data directory must not grant group or other access/);

    chmodSync(data, 0o700);
    writeFileSync(database, 'not-yet-a-sqlite-database', { mode: 0o644 });
    chmodSync(database, 0o644);
    expect(() =>
      prepareHostedPersistenceAfterSchemaSync(
        home,
        data,
        database,
        hostedEnvironment,
      ),
    ).toThrow(/orchestration database must not grant group or other access/);
  });

  it('rejects symlinked and non-regular existing database targets', () => {
    const linked = secureHomeWithData('station-hosted-db-link-');
    directories.push(linked.home);
    const target = join(linked.home, 'outside.sqlite');
    writeFileSync(target, 'outside', { mode: 0o600 });
    chmodSync(target, 0o600);
    symlinkSync(target, linked.database);

    expect(() =>
      prepareHostedPersistenceAfterSchemaSync(
        linked.home,
        linked.data,
        linked.database,
        hostedEnvironment,
      ),
    ).toThrow(/must not be a symbolic link/);

    rmSync(linked.database);
    mkdirSync(linked.database, { mode: 0o700 });
    chmodSync(linked.database, 0o700);
    expect(() =>
      prepareHostedPersistenceAfterSchemaSync(
        linked.home,
        linked.data,
        linked.database,
        hostedEnvironment,
      ),
    ).toThrow(/must be a regular file/);
  });

  it('is a no-op for personal startup without a tenant registry', () => {
    const missingHome = join(
      tmpdir(),
      'station-personal-boundary-does-not-exist',
    );
    expect(() =>
      assertHostedPersistenceBeforeSchemaSync(missingHome, {}),
    ).not.toThrow();
    expect(() =>
      prepareHostedPersistenceAfterSchemaSync(
        missingHome,
        join(missingHome, 'data'),
        join(missingHome, 'data', 'orchestration.sqlite'),
        {},
      ),
    ).not.toThrow();
  });

  it('fails Windows hosted mode explicitly instead of treating POSIX modes as ACLs', () => {
    expect(() =>
      assertHostedPersistenceBeforeSchemaSync(
        '/station/home',
        hostedEnvironment,
        {
          ...actualDependencies(),
          platform: 'win32',
        },
      ),
    ).toThrow(/Windows hosted mode is unsupported/);
  });

  // The station-runtime graph import is kicked off at describe scope (see
  // the note above) so this budget covers construction + assertion, not the
  // ~5s cold import that previously raced this clock under corpus load.
  it('rejects an insecure hosted home before EventStore construction', {
    timeout: 20_000,
  }, async () => {
    const home = fixtureHome('station-hosted-event-store-order-');
    directories.push(home);
    chmodSync(home, 0o755);
    runtimeMocks.eventStore.mockClear();
    const originalRegistry = process.env.STATION_HOSTED_TENANT_REGISTRY_FILE;
    process.env.STATION_HOSTED_TENANT_REGISTRY_FILE =
      '/deployment/tenant-registry.json';
    try {
      const { StationRuntime } = await stationRuntimeImport;
      expect(() => new StationRuntime({ projectHomeDir: home })).toThrow(
        HostedPersistenceBoundaryError,
      );
      expect(runtimeMocks.eventStore).not.toHaveBeenCalled();
    } finally {
      if (originalRegistry === undefined) {
        delete process.env.STATION_HOSTED_TENANT_REGISTRY_FILE;
      } else {
        process.env.STATION_HOSTED_TENANT_REGISTRY_FILE = originalRegistry;
      }
    }
  });
});

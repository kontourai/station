import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { orchestrationStorePath } from '@kontourai/station-shared/orchestration-store-quarantine';
import {
  readCorruptionMarker,
  recordCorruptionObserved,
} from '@kontourai/station-shared/sqlite-corruption-marker';
import { acquireStationHomeRuntimeLease } from '@kontourai/station-shared/station-home-lifecycle';
import { ensureStationHomeSchemaSync } from '@kontourai/station-shared/station-home-schema';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The placement proof for archive#3217.
 *
 * The quarantine takes the home MAINTENANCE lease, which is only grantable
 * while no runtime lease is held. Move the call below
 * `acquireStationHomeRuntimeLease` and it does not throw, does not warn, and
 * does not run: every boot reports a live peer — this process — and skips.
 * That is a guard whose success path silently stops executing, so it needs a
 * test that drives the real constructor rather than the helper in isolation.
 */
const runtimeMocks = vi.hoisted(() => ({
  eventStore: vi.fn(),
}));

vi.mock('../../../services/orchestration/event-store.js', () => ({
  EventStore: class {
    constructor(path: string) {
      runtimeMocks.eventStore(path);
    }
    createOperationalEventPublisher() {
      return {};
    }
    close() {}
  },
}));

/**
 * Construction is aborted HERE, one statement after the boot notice, rather
 * than at the EventStore.
 *
 * Stopping at the EventStore was the obvious choice and it made the notice
 * unreachable: the whole `logger.warn` block could be deleted with every test
 * in this file still green. The abort point has to sit after the last thing
 * being asserted, not before it — and letting the real runtime finish would
 * start servers, watchers, and timers none of these assertions need.
 */
vi.mock(
  '../../../services/feature-previews/feature-preview-registry.js',
  () => ({
    FeaturePreviewRegistry: class {
      constructor() {
        throw new Error('runtime construction stopped by the test');
      }
    },
  }),
);

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function corruptHome(): { homeDir: string; store: string; bytes: Buffer } {
  const parent = mkdtempSync(join(tmpdir(), 'station-runtime-quarantine-'));
  directories.push(parent);
  const homeDir = join(parent, 'home');
  ensureStationHomeSchemaSync(homeDir);
  mkdirSync(join(homeDir, 'data'), { recursive: true });
  const store = orchestrationStorePath(homeDir);

  const database = new DatabaseSync(store);
  database.exec(
    'CREATE TABLE orchestration_events (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)',
  );
  const insert = database.prepare(
    'INSERT INTO orchestration_events(payload) VALUES (?)',
  );
  for (let index = 0; index < 600; index += 1)
    insert.run(`payload ${index} ${'x'.repeat(400)}`);
  database.close();

  const bytes = readFileSync(store);
  bytes.fill(0x5a, 8192, Math.min(bytes.byteLength, 8192 + 32 * 1024));
  writeFileSync(store, bytes);

  const reader = new DatabaseSync(store);
  let observed: unknown;
  try {
    reader.prepare('SELECT count(*) AS total FROM orchestration_events').get();
  } catch (error) {
    observed = error;
  }
  try {
    reader.close();
  } catch {
    // A corrupt handle is allowed to fail on close.
  }
  expect(observed).toBeDefined();
  recordCorruptionObserved({
    databasePath: store,
    observedAt: '2026-08-18T00:00:00.000Z',
    errcode: (observed as { errcode?: number }).errcode,
  });

  return { homeDir, store, bytes };
}

describe('StationRuntime acts on a recorded corruption before it opens the store', () => {
  // The dynamic import pulls the whole station-runtime graph; the boundary
  // test in this directory measures that at ~5s cold, riding the default
  // budget. Measured 28.2s wall on an M-series host inside a linux/node:24
  // container — a 30s budget is knife-edge there and deterministically
  // times out on 2-core hosted CI runners (the opaque #862 fast-checks
  // reds: vitest-related selects this file for any system-status/cli-auth
  // change). 120s is headroom for slow hardware, not a target runtime.
  it('quarantines the store during construction, above its own runtime lease', {
    timeout: 120_000,
  }, async () => {
    const { homeDir, store, bytes } = corruptHome();
    runtimeMocks.eventStore.mockClear();

    const { StationRuntime } = await import('../station-runtime.js');
    expect(() => new StationRuntime({ projectHomeDir: homeDir })).toThrow(
      'runtime construction stopped by the test',
    );

    // Moved, not deleted, and byte-for-byte what was on disk.
    const quarantineRoot = join(homeDir, 'quarantine');
    const stamps = readdirSync(quarantineRoot);
    expect(stamps).toHaveLength(1);
    expect(
      readFileSync(
        join(quarantineRoot, stamps[0], 'orchestration.sqlite'),
      ).equals(bytes),
    ).toBe(true);

    // And the runtime went on to open a store at the now-free path rather
    // than the malformed one.
    expect(existsSync(store)).toBe(false);
    expect(runtimeMocks.eventStore).toHaveBeenCalledWith(store);
    expect(readCorruptionMarker(store)).toBeNull();
  });

  it('leaves the store alone while a peer runtime holds the home', {
    timeout: 120_000,
  }, async () => {
    const { homeDir, store, bytes } = corruptHome();
    runtimeMocks.eventStore.mockClear();
    const peer = acquireStationHomeRuntimeLease(homeDir);

    try {
      const { StationRuntime } = await import('../station-runtime.js');
      expect(() => new StationRuntime({ projectHomeDir: homeDir })).toThrow(
        'runtime construction stopped by the test',
      );
    } finally {
      peer.release();
    }

    expect(existsSync(join(homeDir, 'quarantine'))).toBe(false);
    expect(readFileSync(store).equals(bytes)).toBe(true);
    expect(readCorruptionMarker(store)?.observedAt).toBe(
      '2026-08-18T00:00:00.000Z',
    );
  });

  it('tells the operator, and counts it, from the running product', {
    timeout: 120_000,
  }, async () => {
    // The acceptance criterion is that the MESSAGE names the path and
    // `station home restore`. Proving that against the string function only
    // proves the string function: the block that calls it was deletable with
    // every other test in this file still green.
    const { homeDir } = corruptHome();
    const warn = vi.fn();
    const logger = {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn,
      error: vi.fn(),
      fatal: vi.fn(),
    };
    const { orchestrationStoreQuarantineDispositions } = await import(
      '../../../telemetry/metrics.js'
    );
    const add = vi.spyOn(orchestrationStoreQuarantineDispositions, 'add');
    add.mockClear();

    const { StationRuntime } = await import('../station-runtime.js');
    expect(
      () =>
        new StationRuntime({
          projectHomeDir: homeDir,
          logger: logger as never,
        }),
    ).toThrow('runtime construction stopped by the test');

    const quarantineDir = join(
      homeDir,
      'quarantine',
      readdirSync(join(homeDir, 'quarantine'))[0],
    );
    expect(warn).toHaveBeenCalledTimes(1);
    const [message, context] = warn.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(message).toContain(quarantineDir);
    expect(message).toContain('station home restore');
    expect(context).toMatchObject({
      outcome: 'quarantined',
      quarantineDir,
      observedAt: '2026-08-18T00:00:00.000Z',
    });

    expect(add).toHaveBeenCalledWith(1, { outcome: 'quarantined' });
    add.mockRestore();
  });

  it('says so when it declined, rather than dying silently', {
    timeout: 120_000,
  }, async () => {
    // `home-active` is followed by the store failing to open. Without this
    // line the operator reads the pre-branch error and cannot tell whether
    // the quarantine ran, declined, or could not look.
    const { homeDir } = corruptHome();
    const warn = vi.fn();
    const logger = {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn,
      error: vi.fn(),
      fatal: vi.fn(),
    };
    const peer = acquireStationHomeRuntimeLease(homeDir);

    try {
      const { StationRuntime } = await import('../station-runtime.js');
      expect(
        () =>
          new StationRuntime({
            projectHomeDir: homeDir,
            logger: logger as never,
          }),
      ).toThrow('runtime construction stopped by the test');
    } finally {
      peer.release();
    }

    expect(warn).toHaveBeenCalledTimes(1);
    const [message, context] = warn.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(message).toMatch(/another Station runtime holds this home/);
    expect(context).toMatchObject({ outcome: 'home-active' });
  });
});

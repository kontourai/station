import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { lookupProcessBirthFingerprint } from '@kontourai/station-shared/process-identity';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// Every lock this process creates records its own birth, which other
// processes compare to decide whether the lock is stale. The CLI resolves it
// through the shared own-process authority (#2470), which returns null-backed
// `unavailable` when its probe fails (on macOS a `ps` that timed out under
// load) and owns the bounded retry. Run that real resolver with a lookup that
// can be made to fail for our own pid, and with its retry nap stubbed so the
// test drives the retry rather than sleeping through it.
const identity = vi.hoisted(() => ({
  ownFailures: 0,
  ownCalls: 0,
  resolutions: 0,
  lockRecords: [] as Array<{ pid: number; birth: string }>,
}));
vi.mock(
  '@kontourai/station-shared/process-identity',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@kontourai/station-shared/process-identity')
      >();
    const ownLookup = (pid: number) => {
      if (pid === process.pid) {
        identity.ownCalls += 1;
        if (identity.ownFailures > 0) {
          identity.ownFailures -= 1;
          return null;
        }
      }
      return actual.lookupProcessBirthFingerprint(pid);
    };
    return {
      ...actual,
      resolveOwnProcessIdentity: (
        pid: number,
        dependencies: Parameters<typeof actual.resolveOwnProcessIdentity>[1],
      ) => {
        identity.resolutions += 1;
        return actual.resolveOwnProcessIdentity(pid, {
          ...dependencies,
          lookup: ownLookup,
          wait: () => {},
        });
      },
    };
  },
);
// Observe the v2 records the CLI publishes into its lock files.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const writeFileSync: typeof actual.writeFileSync = (file, data, options) => {
    if (typeof file === 'number' && typeof data === 'string') {
      try {
        const record = JSON.parse(data) as {
          schemaVersion?: unknown;
          pid?: unknown;
          birth?: unknown;
        };
        if (
          record.schemaVersion === 2 &&
          typeof record.pid === 'number' &&
          typeof record.birth === 'string'
        )
          identity.lockRecords.push({ pid: record.pid, birth: record.birth });
      } catch {
        // Not a lock record.
      }
    }
    return actual.writeFileSync(file, data, options);
  };
  return { ...actual, default: { ...actual, writeFileSync }, writeFileSync };
});

const {
  profilesPath,
  readProfileStore,
  setProfileStoreLockTimingForTests,
  upsertProfile,
} = await import('../commands/profile-store.js');

let home: string;
let previousHome: string | undefined;
let previousRoot: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'station-profile-birth-'));
  previousHome = process.env.STATION_HOME;
  previousRoot = process.env.STATION_ROOT;
  process.env.STATION_HOME = home;
  process.env.STATION_ROOT = home;
  // Also drops the cached owner birth, so each test starts with a lookup.
  setProfileStoreLockTimingForTests();
  identity.ownFailures = 0;
  identity.ownCalls = 0;
  identity.resolutions = 0;
  identity.lockRecords = [];
});
afterEach(() => {
  setProfileStoreLockTimingForTests();
  if (previousHome === undefined) delete process.env.STATION_HOME;
  else process.env.STATION_HOME = previousHome;
  if (previousRoot === undefined) delete process.env.STATION_ROOT;
  else process.env.STATION_ROOT = previousRoot;
  rmSync(home, { recursive: true, force: true });
});

describe('saved Station lock owner identity', () => {
  test('publishes the exact birth other processes compare for stale detection', () => {
    upsertProfile({ name: 'work', endpoint: 'https://work.example.test' });
    const comparator = lookupProcessBirthFingerprint(process.pid);
    expect(comparator).toBeTruthy();
    // Genesis lock and store lock, both bound to this process.
    expect(identity.lockRecords.length).toBeGreaterThanOrEqual(2);
    for (const record of identity.lockRecords) {
      expect(record).toEqual({ pid: process.pid, birth: comparator });
    }
  });

  test('a transient failure of our own birth lookup is retried, not fatal', () => {
    identity.ownFailures = 2;
    upsertProfile({ name: 'work', endpoint: 'https://work.example.test' });
    expect(readProfileStore().profiles.map((profile) => profile.name)).toEqual([
      'work',
    ]);
    expect(identity.resolutions).toBe(1);
    expect(identity.ownCalls).toBe(3);
  });

  test('an identity that stays unavailable refuses without inventing one or leaving a lock', () => {
    identity.ownFailures = Number.POSITIVE_INFINITY;
    expect(() =>
      upsertProfile({ name: 'work', endpoint: 'https://work.example.test' }),
    ).toThrow(/process identity is unavailable/);
    // Bounded: three lookups, not a loop until some deadline.
    expect(identity.ownCalls).toBe(3);
    // Resolved before any exclusive create: nothing was published.
    expect(identity.lockRecords).toEqual([]);
    // No lock file (empty or otherwise) is left for other processes to fence on.
    expect(
      existsSync(
        join(
          dirname(home),
          `.${basename(home)}.station-profile-store-genesis.json.lock`,
        ),
      ),
    ).toBe(false);
    expect(existsSync(`${profilesPath(home)}.lock`)).toBe(false);
  });

  test('our own birth is resolved once per process, not once per lock', () => {
    // Genesis lock, store lock, and a second write's store lock: one lookup.
    upsertProfile({ name: 'one', endpoint: 'https://one.example.test' });
    upsertProfile({ name: 'two', endpoint: 'https://two.example.test' });
    expect(identity.resolutions).toBe(1);
    expect(identity.ownCalls).toBe(1);
    expect(identity.lockRecords.length).toBeGreaterThanOrEqual(3);
  });
});

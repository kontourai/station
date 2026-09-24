import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// Every lock this process creates records its own birth, which other
// processes compare to decide whether the lock is stale. The shared authority
// returns null when its probe fails (on macOS a `ps` that timed out under
// load). Route it through a spy so a test can make our own lookup fail.
const identity = vi.hoisted(() => ({ ownFailures: 0, ownCalls: 0 }));
vi.mock(
  '@kontourai/station-shared/process-identity',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@kontourai/station-shared/process-identity')
      >();
    return {
      ...actual,
      lookupProcessBirthFingerprint: (
        pid: number,
        ...rest: Parameters<
          typeof actual.lookupProcessBirthFingerprint
        > extends [number, ...infer R]
          ? R
          : never
      ) => {
        if (pid === process.pid) {
          identity.ownCalls += 1;
          if (identity.ownFailures > 0) {
            identity.ownFailures -= 1;
            return null;
          }
        }
        return actual.lookupProcessBirthFingerprint(pid, ...rest);
      },
    };
  },
);

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
  test('a transient failure of our own birth lookup is retried, not fatal', () => {
    identity.ownFailures = 2;
    upsertProfile({ name: 'work', endpoint: 'https://work.example.test' });
    expect(readProfileStore().profiles.map((profile) => profile.name)).toEqual([
      'work',
    ]);
    expect(identity.ownCalls).toBe(3);
  });

  test('an identity that stays unavailable refuses without inventing one or leaving a lock', () => {
    identity.ownFailures = Number.POSITIVE_INFINITY;
    expect(() =>
      upsertProfile({ name: 'work', endpoint: 'https://work.example.test' }),
    ).toThrow(/process identity is unavailable/);
    // Bounded: three lookups, not a loop until some deadline.
    expect(identity.ownCalls).toBe(3);
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

  test('our own birth is looked up once per process, not once per lock', () => {
    // Genesis lock, store lock, and a second write's store lock: one lookup.
    upsertProfile({ name: 'one', endpoint: 'https://one.example.test' });
    upsertProfile({ name: 'two', endpoint: 'https://two.example.test' });
    expect(identity.ownCalls).toBe(1);
  });
});

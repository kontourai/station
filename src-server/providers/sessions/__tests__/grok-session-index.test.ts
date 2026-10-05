import {
  chmodSync,
  mkdirSync,
  opendirSync,
  realpathSync,
  utimesSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  GrokSessionIndex,
  type GrokSessionIndexOptions,
  type IndexedInspection,
} from '../grok-session-index.js';

const makeTempDir = trackTempDirs();

function tree(): string {
  return realpathSync(makeTempDir('station-grok-index-'));
}

function folder(root: string, group: string, name: string): string {
  const path = join(root, group, name);
  mkdirSync(path, { recursive: true });
  return path;
}

/** A folder whose name starts with `real` is a prompted session. */
function inspect(_sessionDir: string, dirName: string): IndexedInspection {
  return dirName.startsWith('real')
    ? {
        outcome: 'ok',
        cacheable: true,
        session: {
          sessionId: dirName,
          cwd: '/work',
          createdAt: '2026-10-05T00:00:00.000Z',
        },
      }
    : { outcome: 'ok', cacheable: true };
}

function index(options: Partial<GrokSessionIndexOptions> = {}) {
  // Each call is 5 s later, so freshly made folders settle between polls.
  let clock = Date.now();
  return new GrokSessionIndex({
    maxEntries: 131_072,
    maxStats: 16_384,
    maxSweepStats: 1024,
    maxInspections: 1024,
    now: () => (clock += 5000),
    yieldFn: async () => {},
    ...options,
  });
}

async function poll(target: GrokSessionIndex, root: string) {
  return target.refresh(root, inspect);
}

describe('GrokSessionIndex', () => {
  test('a refused poll rotates, so every group past the cap is reached', async () => {
    // The reviewer's shape, scaled down: many probe groups that together
    // exceed the cap and are newer than the user groups.
    const root = tree();
    for (const user of ['a-user', 'n-user', 'z-user']) {
      folder(root, user, `real-${user}`);
      const old = new Date(Date.now() - 86_400_000);
      utimesSync(join(root, user), old, old);
    }
    for (let group = 0; group < 8; group += 1) {
      for (let item = 0; item < 10; item += 1) {
        folder(root, `m-probe-${group}`, `probe-${item}`);
      }
    }
    const target = index({ maxEntries: 40 });
    const found = new Set<string>();
    for (let round = 0; round < 24 && found.size < 3; round += 1) {
      for (const session of (await poll(target, root)).sessions) {
        found.add(session.inspection.session!.sessionId);
      }
    }
    expect([...found].sort()).toEqual([
      'real-a-user',
      'real-n-user',
      'real-z-user',
    ]);
  });

  test('the newest group is read first, ahead of older ones past the budget', async () => {
    const root = tree();
    for (let item = 0; item < 15; item += 1)
      folder(root, 'a-junk', `probe-${item}`);
    const old = new Date(Date.now() - 86_400_000);
    utimesSync(join(root, 'a-junk'), old, old);
    folder(root, 'z-new', 'real-new');
    const first = await poll(index({ maxEntries: 10 }), root);
    expect(
      first.sessions.map((session) => session.inspection.session!.sessionId),
    ).toEqual(['real-new']);
  });

  test('an unchanged group cut short by the budget is not read again', async () => {
    const root = tree();
    for (let item = 0; item < 60; item += 1)
      folder(root, 'big', `probe-${item}`);
    const big = join(root, 'big');
    let bigReads = 0;
    const target = index({
      maxEntries: 50,
      openDirectory: (path) => {
        if (path === big) bigReads += 1;
        return opendirSync(path);
      },
    });
    for (let round = 0; round < 4; round += 1) await poll(target, root);
    expect(bigReads).toBe(1);
  });

  test('a listed folder that cannot be statted for now stays listed', async () => {
    const root = tree();
    folder(root, 'user', 'real-session');
    const group = join(root, 'user');
    const old = new Date(Date.now() - 86_400_000);
    utimesSync(group, old, old);
    const target = index();
    expect((await poll(target, root)).sessions).toHaveLength(1);
    // No search permission: lstat of the folder fails with EACCES, and the
    // group's own mtime is unchanged, so it is not re-read.
    chmodSync(group, 0o600);
    try {
      const after = await poll(target, root);
      expect(after.sessions.map((session) => session.sessionDir)).toEqual([
        join(group, 'real-session'),
      ]);
    } finally {
      chmodSync(group, 0o700);
    }
  });

  test('a prompt-less folder inspected within its mtime tick is inspected again', async () => {
    const root = tree();
    folder(root, 'user', 'fresh');
    const inspected: string[] = [];
    // The clock stays within two seconds of the folder's mtime.
    const target = index({ now: () => Date.now() });
    for (let round = 0; round < 2; round += 1) {
      await target.refresh(root, (sessionDir, dirName) => {
        inspected.push(dirName);
        return inspect(sessionDir, dirName);
      });
    }
    expect(inspected).toEqual(['fresh', 'fresh']);
  });
});

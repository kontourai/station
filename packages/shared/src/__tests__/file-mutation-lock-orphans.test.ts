/**
 * #4995: `notifications.json.mutation.<uuid>.tmp` files outlived the writer
 * that created them. These pin both halves of the fix: an acquisition that
 * fails removes its own temporary, and the startup sweep removes only an old,
 * exactly-named temporary that no live writer can own.
 */
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.js';
import {
  acquireFileMutationLockAsync,
  sweepOrphanedFileMutationLockTemporaries,
} from '../lifecycle-events.js';
import { lookupProcessBirthFingerprint } from '../process-identity.mjs';

const makeTempDir = trackTempDirs();
const TWO_DAYS_MS = 2 * 24 * 60 * 60_000;

function lockTemporaries(directory: string): string[] {
  return readdirSync(directory).filter((name) =>
    /\.mutation\.[0-9a-f-]{36}\.tmp$/.test(name),
  );
}

function orphan(directory: string, name: string, content = ''): string {
  const path = join(directory, name);
  writeFileSync(path, content);
  const old = new Date(Date.now() - TWO_DAYS_MS);
  utimesSync(path, old, old);
  return path;
}

function ownBirth(): string {
  const birth = lookupProcessBirthFingerprint(process.pid);
  if (!birth) throw new Error('this host exposes no process birth time');
  return birth;
}

describe('file mutation lock temporaries (#4995)', () => {
  it('an acquisition that fails part-way removes its own temporary', async () => {
    const root = makeTempDir('station-lock-leak-');
    const lock = join(root, 'notifications.json.mutation');
    // A stale owner: this pid, a birth that is not ours, so it reads dead
    // and the acquirer takes the compare-delete path — where the hook throws.
    writeFileSync(
      lock,
      JSON.stringify({
        version: 1,
        pid: process.pid,
        birth: 'stale',
        token: 'A',
      }),
      { mode: 0o600 },
    );

    await expect(
      acquireFileMutationLockAsync(lock, {
        timeoutMs: 1_000,
        hooks: {
          afterStaleInspect: () => {
            throw new Error('injected failure after inspection');
          },
        },
      }),
    ).rejects.toThrow('injected failure after inspection');

    expect(lockTemporaries(root)).toEqual([]);
  });

  it('a successful acquisition and release leaves no temporary either', async () => {
    const root = makeTempDir('station-lock-clean-');
    const release = await acquireFileMutationLockAsync(
      join(root, 'store.json.mutation'),
    );
    expect(lockTemporaries(root)).toEqual([]);
    await release();
    expect(readdirSync(root)).toEqual([]);
  });

  it('removes only old, exactly-named temporaries with no live owner', async () => {
    const root = makeTempDir('station-lock-sweep-');
    const uuid = () => randomUUID();
    const zeroByte = orphan(root, `notifications.json.mutation.${uuid()}.tmp`);
    const deadOwner = orphan(
      root,
      `jobs.json.mutation.${uuid()}.tmp`,
      JSON.stringify({ pid: process.pid, birth: 'stale', token: 't' }),
    );
    const nested = join(root, 'projects', 'demo');
    mkdirSync(nested, { recursive: true });
    const nestedOrphan = orphan(nested, `project.json.mutation.${uuid()}.tmp`);

    // Retained: too young, not this exact shape, or a live owner.
    const young = join(root, `young.json.mutation.${uuid()}.tmp`);
    writeFileSync(young, '');
    const lookalikes = [
      orphan(root, 'notifications.json.mutation.not-a-uuid.tmp'),
      orphan(root, `.notifications.json.${process.pid}.abc123.tmp`),
      orphan(root, `notifications.json.mutation.guard.${uuid()}.tmp`),
      orphan(root, `notifications.json.mutation.${uuid()}.tmp.keep`),
    ];
    const liveOwner = orphan(
      root,
      `live.json.mutation.${uuid()}.tmp`,
      JSON.stringify({ pid: process.pid, birth: ownBirth(), token: 't' }),
    );

    const result = await sweepOrphanedFileMutationLockTemporaries(root);

    expect(result).toEqual({
      removed: 3,
      retainedLive: 1,
      failed: 0,
      truncated: false,
    });
    for (const path of [zeroByte, deadOwner, nestedOrphan])
      expect(existsSync(path)).toBe(false);
    for (const path of [young, liveOwner, ...lookalikes])
      expect(existsSync(path)).toBe(true);
  });

  it('never removes a temporary a waiting live acquirer still owns', async () => {
    const root = makeTempDir('station-lock-live-');
    const lock = join(root, 'notifications.json.mutation');
    const releaseHolder = await acquireFileMutationLockAsync(lock);
    // A second writer is now waiting with its temporary on disk.
    const waiter = acquireFileMutationLockAsync(lock, { timeoutMs: 5_000 });
    let waiting: string[] = [];
    for (let attempt = 0; attempt < 200 && waiting.length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      waiting = lockTemporaries(root);
    }
    expect(waiting).toHaveLength(1);

    // Even with no age floor, the live owner record protects it.
    const result = await sweepOrphanedFileMutationLockTemporaries(root, {
      minAgeMs: 0,
    });
    expect(result.removed).toBe(0);
    expect(existsSync(join(root, waiting[0]!))).toBe(true);

    await releaseHolder();
    const releaseWaiter = await waiter;
    await releaseWaiter();
    expect(lockTemporaries(root)).toEqual([]);
  });

  it('never removes a temporary hard-linked as the published lock', async () => {
    const root = makeTempDir('station-lock-linked-');
    const temporary = orphan(root, `store.json.mutation.${randomUUID()}.tmp`);
    linkSync(temporary, join(root, 'store.json.mutation'));

    const result = await sweepOrphanedFileMutationLockTemporaries(root);

    expect(result).toMatchObject({ removed: 0, retainedLive: 1 });
    expect(existsSync(temporary)).toBe(true);
  });

  it('is bounded by depth and by entries examined', async () => {
    const root = makeTempDir('station-lock-bounds-');
    const deep = join(root, 'a', 'b');
    mkdirSync(deep, { recursive: true });
    const deepOrphan = orphan(deep, `x.json.mutation.${randomUUID()}.tmp`);

    expect(
      await sweepOrphanedFileMutationLockTemporaries(root, { maxDepth: 1 }),
    ).toMatchObject({ removed: 0 });
    expect(existsSync(deepOrphan)).toBe(true);

    expect(
      await sweepOrphanedFileMutationLockTemporaries(root, { maxEntries: 1 }),
    ).toMatchObject({ removed: 0, truncated: true });

    expect(await sweepOrphanedFileMutationLockTemporaries(root)).toMatchObject({
      removed: 1,
      truncated: false,
    });
  });

  it('a missing root is an empty sweep, not an error', async () => {
    const root = makeTempDir('station-lock-missing-');
    expect(
      await sweepOrphanedFileMutationLockTemporaries(join(root, 'absent')),
    ).toEqual({ removed: 0, retainedLive: 0, failed: 0, truncated: false });
  });
});

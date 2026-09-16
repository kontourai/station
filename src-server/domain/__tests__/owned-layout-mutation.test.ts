/**
 * #2061 — `mutateOwnedLayout`, the personal scope's serialized updater.
 *
 * These drive the real `FileStorageAdapter` against a real temporary Station
 * home, because the properties under test are properties of the on-disk
 * transaction (a lock that spans read and publish, a record that is not
 * republished when the updater throws) and a fake store cannot have them.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LayoutConfig } from '@kontourai/station-contracts/layout';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import { afterEach, describe, expect, test } from 'vitest';
import { FileStorageAdapter } from '../file-storage-adapter.js';
import { principalLayoutStorageKey } from '../layout-owner-storage.js';

const NOW = '2026-01-01T00:00:00.000Z';
const alice = humanPrincipal('oidc', 'alice', 'Alice');
const bob = humanPrincipal('oidc', 'bob', 'Bob');
const aliceOwner = { kind: 'principal', principal: alice } as const;
const bobOwner = { kind: 'principal', principal: bob } as const;

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function home() {
  const dir = mkdtempSync(join(tmpdir(), 'station-owned-layout-mutation-'));
  tempDirs.push(dir);
  return { dir, storage: new FileStorageAdapter(dir) };
}

function board(
  slug: string,
  overrides: Partial<LayoutConfig> = {},
): LayoutConfig {
  return {
    id: `board-${slug}`,
    owner: aliceOwner,
    slug,
    type: 'custom',
    name: 'A Board',
    config: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function recordPath(dir: string, slug: string): string {
  return join(
    dir,
    'layouts',
    'personal',
    principalLayoutStorageKey(alice),
    `${slug}.json`,
  );
}

describe('mutateOwnedLayout', () => {
  test('creates when absent and updates when present, in one transaction', async () => {
    const { dir, storage } = home();

    const created = await storage.mutateOwnedLayout(
      aliceOwner,
      'daily',
      (current) => {
        expect(current).toBeUndefined();
        return board('daily');
      },
    );
    expect(created.name).toBe('A Board');
    expect(existsSync(recordPath(dir, 'daily'))).toBe(true);

    const updated = await storage.mutateOwnedLayout(
      aliceOwner,
      'daily',
      (current) => {
        expect(current?.id).toBe('board-daily');
        return { ...(current as LayoutConfig), name: 'Renamed' };
      },
    );
    expect(updated.name).toBe('Renamed');
    expect(storage.getOwnedLayout(aliceOwner, 'daily').name).toBe('Renamed');
  });

  test('two concurrent updates of one record both survive', async () => {
    const { storage } = home();
    await storage.mutateOwnedLayout(aliceOwner, 'daily', () =>
      board('daily', { config: { marks: [] } }),
    );

    // Both transactions are in flight before either can commit: each awaits
    // inside `mutateJsonFile` (mkdir, then the per-path mutation capability)
    // before it reads. Without a lock spanning read and publish, both read the
    // same base and the second erases the first's mark — the CAS-less
    // read-modify-write class. With it, the second reads the first's result.
    const append = (mark: string) =>
      storage.mutateOwnedLayout(aliceOwner, 'daily', (current) => {
        const config = current?.config as { marks?: string[] } | undefined;
        return {
          ...(current as LayoutConfig),
          config: { marks: [...(config?.marks ?? []), mark] },
        };
      });
    await Promise.all([append('first'), append('second')]);

    const marks = (
      storage.getOwnedLayout(aliceOwner, 'daily').config as {
        marks?: string[];
      }
    ).marks;
    expect(marks).toHaveLength(2);
    expect([...(marks ?? [])].sort()).toEqual(['first', 'second']);
  });

  test('an updater that mutates its argument in place cannot change the id', async () => {
    const { dir, storage } = home();
    await storage.mutateOwnedLayout(aliceOwner, 'daily', () => board('daily'));

    // The updater receives a defensive copy. Mutating it and returning the
    // SAME object is the shape that defeats a naive immutability check: the
    // adapter's `next.id !== current.id` comparison reads one object twice
    // unless the pristine record was kept separately.
    await expect(
      storage.mutateOwnedLayout(aliceOwner, 'daily', (current) => {
        const mutable = current as LayoutConfig;
        mutable.id = 'stolen-id';
        return mutable;
      }),
    ).rejects.toThrow("layout 'daily' id is immutable");

    expect(storage.getOwnedLayout(aliceOwner, 'daily').id).toBe('board-daily');
    expect(JSON.parse(readFileSync(recordPath(dir, 'daily'), 'utf8')).id).toBe(
      'board-daily',
    );
  });

  test('an updater that mutates then throws publishes nothing', async () => {
    const { dir, storage } = home();
    await storage.mutateOwnedLayout(aliceOwner, 'daily', () => board('daily'));
    const before = readFileSync(recordPath(dir, 'daily'), 'utf8');

    await expect(
      storage.mutateOwnedLayout(aliceOwner, 'daily', (current) => {
        (current as LayoutConfig).name = 'Half-written';
        throw new Error('updater refused');
      }),
    ).rejects.toThrow('updater refused');

    expect(readFileSync(recordPath(dir, 'daily'), 'utf8')).toBe(before);
    expect(storage.getOwnedLayout(aliceOwner, 'daily').name).toBe('A Board');
  });

  test('an updater cannot relocate a record to another principal', async () => {
    const { storage } = home();
    await storage.mutateOwnedLayout(aliceOwner, 'daily', () => board('daily'));

    await expect(
      storage.mutateOwnedLayout(aliceOwner, 'daily', (current) => ({
        ...(current as LayoutConfig),
        owner: bobOwner,
      })),
    ).rejects.toThrow('layout record identity does not match');

    expect(storage.listOwnedLayouts(bobOwner)).toEqual([]);
    expect(storage.getOwnedLayout(aliceOwner, 'daily').owner).toEqual(
      aliceOwner,
    );
  });

  test("one principal's updater never sees another's record", async () => {
    const { storage } = home();
    await storage.mutateOwnedLayout(aliceOwner, 'daily', () => board('daily'));

    const seen: (LayoutConfig | undefined)[] = [];
    await storage.mutateOwnedLayout(bobOwner, 'daily', (current) => {
      seen.push(current);
      return board('daily', { id: 'bob-daily', owner: bobOwner });
    });

    expect(seen).toEqual([undefined]);
    expect(storage.getOwnedLayout(aliceOwner, 'daily').id).toBe('board-daily');
    expect(storage.getOwnedLayout(bobOwner, 'daily').id).toBe('bob-daily');
  });

  test('refuses to write a project-owned layout', async () => {
    const { storage } = home();
    await expect(
      storage.mutateOwnedLayout(
        { kind: 'project', projectSlug: 'demo' },
        'coding',
        () => board('coding'),
      ),
    ).rejects.toThrow('does not write project-owned layouts');
  });
});

/**
 * #2060 — owner-scoped Layout storage.
 *
 * Two properties this file exists to hold:
 *
 *  1. a project-owned Layout's bytes on disk did not change. The shape pin
 *     below asserts the exact persisted object, not a subset, so adding a
 *     field to the write path (an `owner` a project record must not carry,
 *     say) reddens it.
 *  2. a principal- or instance-owned Layout round-trips and lives OUTSIDE
 *     `projects/`, which is what makes it unreachable from a project's
 *     layout listing by construction rather than by a filter.
 */
import { createHash } from 'node:crypto';
import {
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
import type { LayoutConfig } from '@kontourai/station-contracts/layout';
import { INSTANCE_LAYOUT_OWNER } from '@kontourai/station-contracts/layout';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import type { ProjectConfig } from '@kontourai/station-contracts/project';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { FileStorageAdapter } from '../file-storage-adapter.js';
import { principalLayoutStorageKey } from '../layout-owner-storage.js';
import { FileStorageConflictError } from '../project-file-transactions.js';

const NOW = '2026-01-01T00:00:00.000Z';

const alice = humanPrincipal('oidc', 'alice', 'Alice');

function project(): ProjectConfig {
  return {
    id: 'project-1',
    slug: 'acme',
    name: 'Acme',
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function projectLayout(): LayoutConfig {
  return {
    id: 'layout-1',
    projectSlug: 'acme',
    slug: 'coding',
    type: 'coding',
    name: 'Coding',
    config: {},
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function board(slug = 'my-board'): LayoutConfig {
  return {
    id: `board-${slug}`,
    owner: { kind: 'principal', principal: alice },
    slug,
    type: 'coding',
    name: 'My Board',
    config: { tabs: [{ id: 'a' }, { id: 'b' }] },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe('owner-scoped layout storage', () => {
  let home: string;
  let adapter: FileStorageAdapter;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'station-layout-owner-'));
    adapter = new FileStorageAdapter(home);
    await adapter.createProject(project());
  });

  afterEach(() => rmSync(home, { recursive: true, force: true }));

  test('a project layout persists exactly the pre-Boards fields', async () => {
    await adapter.createLayout('acme', projectLayout());
    const persisted = JSON.parse(
      readFileSync(
        join(home, 'projects', 'acme', 'layouts', 'coding.json'),
        'utf8',
      ),
    );
    // Exact equality, not a subset: `owner` must NOT appear on a
    // project-owned record, and no other field may quietly join it.
    expect(persisted).toEqual({
      id: 'layout-1',
      projectSlug: 'acme',
      slug: 'coding',
      type: 'coding',
      name: 'Coding',
      config: {},
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(Object.keys(persisted).sort()).toEqual([
      'config',
      'createdAt',
      'id',
      'name',
      'projectSlug',
      'slug',
      'type',
      'updatedAt',
    ]);
  });

  test('a record written before owners existed still loads, as project-owned', () => {
    // Byte-identical legacy content, written straight to disk without going
    // through today's write path at all.
    const legacy = {
      id: 'layout-legacy',
      projectSlug: 'acme',
      slug: 'legacy',
      type: 'coding',
      name: 'Legacy',
      config: {},
      createdAt: NOW,
      updatedAt: NOW,
    };
    writeLayoutFile(
      join(home, 'projects', 'acme', 'layouts'),
      'legacy',
      legacy,
    );
    expect(adapter.getLayout('acme', 'legacy')).toEqual(legacy);
    expect(adapter.listLayouts('acme').map((l) => l.slug)).toEqual(['legacy']);
    expect(adapter.listLayouts('acme')[0]?.projectSlug).toBe('acme');
  });

  test('a principal-owned layout round-trips outside every project', async () => {
    await adapter.createOwnedLayout(
      { kind: 'principal', principal: alice },
      board(),
    );

    const owner = { kind: 'principal', principal: alice } as const;
    expect(adapter.getOwnedLayout(owner, 'my-board')).toEqual(board());
    expect(adapter.listOwnedLayouts(owner)).toEqual([
      {
        id: 'board-my-board',
        slug: 'my-board',
        owner: { kind: 'principal', principal: alice },
        type: 'coding',
        name: 'My Board',
        icon: undefined,
        description: undefined,
        plugin: undefined,
        tabCount: 2,
      },
    ]);

    // Stored under the Station home's own layouts root, never under a project.
    expect(readdirSync(join(home, 'layouts', 'personal'))).toEqual([
      principalLayoutStorageKey(alice),
    ]);
    expect(layoutFilesIn(join(home, 'projects', 'acme', 'layouts'))).toEqual(
      [],
    );

    // No project lists it — checked over every project the adapter knows.
    for (const known of adapter.listProjects()) {
      expect(adapter.listLayouts(known.slug)).toEqual([]);
    }

    await adapter.deleteOwnedLayout(owner, 'my-board');
    expect(adapter.listOwnedLayouts(owner)).toEqual([]);
  });

  test('an instance-owned layout round-trips under its own root', async () => {
    const layout: LayoutConfig = {
      ...board('shared'),
      id: 'instance-1',
      owner: INSTANCE_LAYOUT_OWNER,
    };
    await adapter.createOwnedLayout(INSTANCE_LAYOUT_OWNER, layout);
    expect(adapter.getOwnedLayout(INSTANCE_LAYOUT_OWNER, 'shared')).toEqual(
      layout,
    );
    expect(readdirSync(join(home, 'layouts', 'instance'))).toContain(
      'shared.json',
    );
    expect(adapter.listLayouts('acme')).toEqual([]);
  });

  test("one principal's board is invisible to another principal", async () => {
    const bob = humanPrincipal('oidc', 'bob', 'Bob');
    await adapter.createOwnedLayout(
      { kind: 'principal', principal: alice },
      board(),
    );
    expect(
      adapter.listOwnedLayouts({ kind: 'principal', principal: bob }),
    ).toEqual([]);
  });

  test('refuses to write a principal-owned record into a project', async () => {
    await expect(adapter.createLayout('acme', board())).rejects.toThrow(
      "layout owned by principal 'human:oidc:alice' cannot be written to project 'acme'",
    );
    await expect(
      adapter.createOwnedLayout(
        { kind: 'principal', principal: humanPrincipal('oidc', 'bob', 'Bob') },
        board(),
      ),
    ).rejects.toThrow('cannot be written under');
  });

  test('refuses a stored record that claims two owners at once', async () => {
    await adapter.createLayout('acme', projectLayout());
    writeLayoutFile(join(home, 'projects', 'acme', 'layouts'), 'coding', {
      ...projectLayout(),
      owner: { kind: 'principal', principal: alice },
    });
    // The storage layer wraps every invalid record in one outer message; the
    // refusal REASON rides the cause, and asserting it is what proves the
    // parser refused for the owner contradiction rather than for any of the
    // other ways a record can be invalid.
    expect(() => adapter.getLayout('acme', 'coding')).toThrow(
      'Project storage contains an invalid record',
    );
    expect(refusalReason(() => adapter.getLayout('acme', 'coding'))).toContain(
      'owned by one or the other, never both',
    );
    expect(refusalReason(() => adapter.listLayouts('acme'))).toContain(
      'owned by one or the other, never both',
    );
  });

  test('a principal-owned record dropped into a project directory is refused', async () => {
    writeLayoutFile(
      join(home, 'projects', 'acme', 'layouts'),
      'my-board',
      board(),
    );
    expect(() => adapter.getLayout('acme', 'my-board')).toThrow(
      'identity does not match',
    );
  });

  test('a second create for the same owner and slug is refused, not absorbed', async () => {
    // MED-1. An upsert here silently replaced the record AND its immutable
    // id, while the project path refuses a duplicate by name. `listOwnedLayouts`
    // proves the first record survived — a refusal that still overwrote would
    // be indistinguishable from this assertion without it.
    const owner = { kind: 'principal', principal: alice } as const;
    await adapter.createOwnedLayout(owner, board());
    await expect(
      adapter.createOwnedLayout(owner, { ...board(), id: 'board-second' }),
    ).rejects.toThrow(
      "Layout 'my-board' already exists for principal 'human:oidc:alice'",
    );
    await expect(
      adapter.createOwnedLayout(owner, { ...board(), id: 'board-second' }),
    ).rejects.toThrow(FileStorageConflictError);
    expect(adapter.getOwnedLayout(owner, 'my-board').id).toBe('board-my-board');
    expect(adapter.listOwnedLayouts(owner)).toHaveLength(1);
  });

  test('a project record never persists owner, and always persists projectSlug', async () => {
    // MED-3, pinned at the STORAGE layer: a caller may legitimately hand the
    // adapter an explicit project owner (`layoutOwner` accepts it), and
    // persisting it would change a project record's bytes — and, with
    // `projectSlug` omitted, write a record an older build's schema rejects,
    // which makes that build's whole layout listing throw.
    await adapter.createLayout('acme', {
      ...projectLayout(),
      projectSlug: undefined,
      owner: { kind: 'project', projectSlug: 'acme' },
    } as LayoutConfig);
    const persisted = JSON.parse(
      readFileSync(
        join(home, 'projects', 'acme', 'layouts', 'coding.json'),
        'utf8',
      ),
    );
    expect(persisted.owner).toBeUndefined();
    expect(persisted.projectSlug).toBe('acme');
    expect(Object.keys(persisted).sort()).toEqual([
      'config',
      'createdAt',
      'id',
      'name',
      'projectSlug',
      'slug',
      'type',
      'updatedAt',
    ]);

    // The same normalization on the update path.
    const revision = adapter.layoutRevision('acme', 'coding');
    await revision.replace({
      ...revision.value,
      name: 'Renamed',
      owner: { kind: 'project', projectSlug: 'acme' },
    });
    const updated = JSON.parse(
      readFileSync(
        join(home, 'projects', 'acme', 'layouts', 'coding.json'),
        'utf8',
      ),
    );
    expect(updated.owner).toBeUndefined();
    expect(updated.projectSlug).toBe('acme');
    expect(updated.name).toBe('Renamed');
  });

  test('findLayoutsUsingAgent sees a Board referencing the agent', async () => {
    // MED-4. `deleteAgent` refuses only when this sweep reports a dependent,
    // so a root it cannot reach is an agent deleted out from under a Board.
    await adapter.createLayout('acme', {
      ...projectLayout(),
      config: { defaultAgent: 'claude' },
    });
    await adapter.createOwnedLayout(
      { kind: 'principal', principal: alice },
      {
        ...board(),
        config: { tabs: [{ id: 'a', skills: [{ agent: 'claude' }] }] },
      },
    );
    await adapter.createOwnedLayout(INSTANCE_LAYOUT_OWNER, {
      ...board('shared'),
      id: 'instance-1',
      owner: INSTANCE_LAYOUT_OWNER,
      config: { availableAgents: ['claude'] },
    });

    expect(adapter.findLayoutsUsingAgent('claude')).toEqual([
      {
        owner: { kind: 'project', projectSlug: 'acme' },
        projectSlug: 'acme',
        layoutSlug: 'coding',
      },
      { owner: INSTANCE_LAYOUT_OWNER, layoutSlug: 'shared' },
      {
        owner: { kind: 'principal', principal: alice },
        layoutSlug: 'my-board',
      },
    ]);
    // An agent nothing names is still reported as unreferenced, so the sweep
    // is not simply returning every layout it can see.
    expect(adapter.findLayoutsUsingAgent('codex')).toEqual([]);
  });

  test('the sweep ignores a stray file under the personal layout root', async () => {
    // Finder writes `.DS_Store` into any folder it browses. Every entry under
    // `personal/` used to be read as a principal directory, so that one file
    // raised ENOTDIR out of the sweep and `deleteAgent` threw for EVERY agent
    // on the machine — a guard failing closed for a reason unrelated to any
    // dependent.
    await adapter.createOwnedLayout(
      { kind: 'principal', principal: alice },
      {
        ...board(),
        config: { tabs: [{ id: 'a', skills: [{ agent: 'claude' }] }] },
      },
    );
    writeFileSync(join(home, 'layouts', 'personal', '.DS_Store'), 'junk');

    expect(adapter.findLayoutsUsingAgent('claude')).toEqual([
      {
        owner: { kind: 'principal', principal: alice },
        layoutSlug: 'my-board',
      },
    ]);
  });

  test('an owned-layout read refuses a principal that is not well formed', async () => {
    // LOW-5 — the principal becomes a path and error text before anything
    // validates it, on every one of the three read/write entry points.
    const invalid = {
      kind: 'principal',
      principal: { id: 'human:oidc:al\u0000ice', kind: 'human', display: 'A' },
    } as never;
    expect(() => adapter.listOwnedLayouts(invalid)).toThrow(
      'well-formed PrincipalRef',
    );
    expect(() => adapter.getOwnedLayout(invalid, 'my-board')).toThrow(
      'well-formed PrincipalRef',
    );
    await expect(
      adapter.deleteOwnedLayout(invalid, 'my-board'),
    ).rejects.toThrow('well-formed PrincipalRef');
  });

  test('reports a missing owned layout as not found', () => {
    expect(() =>
      adapter.getOwnedLayout({ kind: 'principal', principal: alice }, 'nope'),
    ).toThrow("Layout 'nope' not found for principal 'human:oidc:alice'");
  });
});

describe('principalLayoutStorageKey', () => {
  test('encodes a subject carrying / and : as one safe path segment', () => {
    const awkward = humanPrincipal('oidc', 'acme/team:alice', 'Alice');
    const key = principalLayoutStorageKey(awkward);
    expect(key).not.toContain('/');
    expect(key).not.toContain(':');
    expect(key).not.toContain('\\');
    expect(key).not.toContain('..');
    expect(key).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    expect(key).toBe(`human-oidc-acme-team-alice-${digest16(awkward.id)}`);
  });

  test('two principals differing only in case do not share a directory', () => {
    // The readable excerpt lowercases, so on a case-insensitive filesystem
    // the digest is the only thing keeping these apart.
    const upper = principalLayoutStorageKey(
      humanPrincipal('oidc', 'Alice', 'Alice'),
    );
    const lower = principalLayoutStorageKey(
      humanPrincipal('oidc', 'alice', 'Alice'),
    );
    expect(upper).not.toBe(lower);
    expect(upper.toLowerCase()).not.toBe(lower.toLowerCase());
  });

  test('a display-only difference does not change the key', () => {
    expect(
      principalLayoutStorageKey(humanPrincipal('oidc', 'alice', 'Alice')),
    ).toBe(principalLayoutStorageKey(humanPrincipal('oidc', 'alice', 'A. L.')));
  });

  test('refuses a principal that is not a well-formed PrincipalRef', () => {
    // The key becomes a filesystem path AND error text, so an unvalidated
    // value reached both — a NUL-carrying id was accepted and echoed back.
    for (const invalid of [
      { id: 'human:oidc:al\u0000ice', kind: 'human', display: 'Alice' },
      { id: '...', kind: 'human', display: 'Odd' },
      { id: 'human:oidc:alice', kind: 'human', display: '   ' },
      { id: 'human:oidc:alice', kind: 'wizard', display: 'Alice' },
    ] as never[]) {
      expect(() => principalLayoutStorageKey(invalid)).toThrow(
        'well-formed PrincipalRef',
      );
    }
  });

  test('a long subject is truncated without losing identity', () => {
    const long = 'x'.repeat(400);
    const a = principalLayoutStorageKey(
      humanPrincipal('oidc', `${long}a`, 'A'),
    );
    const b = principalLayoutStorageKey(
      humanPrincipal('oidc', `${long}b`, 'B'),
    );
    expect(a.length).toBeLessThanOrEqual(48 + 1 + 16);
    expect(a).not.toBe(b);
  });
});

/** The message of the cause the storage layer wrapped, for reason pins. */
function refusalReason(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    return cause instanceof Error ? cause.message : String(cause);
  }
  throw new Error('expected the read to be refused');
}

/** Independently recomputed, so the key pin states the derivation. */
function digest16(id: string): string {
  return createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 16);
}

/** A directory that was never created holds no layouts. */
function layoutFilesIn(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function writeLayoutFile(dir: string, slug: string, value: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${slug}.json`), JSON.stringify(value), 'utf8');
}

/**
 * #2076: the sweeps list directories by what an entry IS on disk, not by
 * what `readdir` says the entry is. `Dirent.isDirectory()` is false for a
 * symlink, so a symlinked project or principal root was dropped from
 * `listProjects` and `findLayoutsUsingAgent` while `getLayout` /
 * `getOwnedLayout` on the same path read it fine -- the delete guard
 * answering "no dependents" about a Board it could otherwise see. The
 * mirror gap: a DIRECTORY named `x.json` passed the suffix filter and every
 * lister opened it as a record and threw `EISDIR`.
 */
describe('layout sweeps see through symlinks and past directories named *.json (#2076)', () => {
  let home: string;
  let adapter: FileStorageAdapter;
  let elsewhere: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'station-layout-symlink-'));
    elsewhere = mkdtempSync(join(tmpdir(), 'station-layout-elsewhere-'));
    adapter = new FileStorageAdapter(home);
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  });

  test('a symlinked principal root is swept for agent dependents', async () => {
    // Write the Board into a real directory elsewhere, then link it in as
    // the principal's key directory -- a home restored via symlink.
    const key = principalLayoutStorageKey(alice);
    const realKeyDir = join(elsewhere, key);
    writeLayoutFile(realKeyDir, 'my-board', {
      ...board(),
      config: { tabs: [{ id: 'a', skills: [{ agent: 'claude' }] }] },
    });
    mkdirSync(join(home, 'layouts', 'personal'), { recursive: true });
    symlinkSync(realKeyDir, join(home, 'layouts', 'personal', key));

    const owner = { kind: 'principal' as const, principal: alice };
    // The direct read already worked before the fix; the sweep did not.
    expect(adapter.getOwnedLayout(owner, 'my-board').slug).toBe('my-board');
    expect(adapter.findLayoutsUsingAgent('claude')).toEqual([
      { owner, layoutSlug: 'my-board' },
    ]);
  });

  test('a symlinked project directory is listed and swept', async () => {
    const realProject = join(elsewhere, 'acme');
    mkdirSync(realProject, { recursive: true });
    writeFileSync(
      join(realProject, 'project.json'),
      JSON.stringify(project()),
      'utf8',
    );
    writeLayoutFile(join(realProject, 'layouts'), 'coding', {
      ...projectLayout(),
      config: { defaultAgent: 'claude' },
    });
    mkdirSync(join(home, 'projects'), { recursive: true });
    symlinkSync(realProject, join(home, 'projects', 'acme'));

    expect(adapter.listProjects().map((p) => p.slug)).toEqual(['acme']);
    expect(adapter.listProjects()[0]?.layoutCount).toBe(1);
    expect(adapter.findLayoutsUsingAgent('claude')).toEqual([
      {
        owner: { kind: 'project', projectSlug: 'acme' },
        projectSlug: 'acme',
        layoutSlug: 'coding',
      },
    ]);
  });

  test('a dangling symlink is nothing, not an error', async () => {
    mkdirSync(join(home, 'projects'), { recursive: true });
    symlinkSync(join(elsewhere, 'gone'), join(home, 'projects', 'ghost'));
    mkdirSync(join(home, 'layouts', 'personal'), { recursive: true });
    symlinkSync(
      join(elsewhere, 'gone-too'),
      join(home, 'layouts', 'personal', 'ghost-key'),
    );
    expect(adapter.listProjects()).toEqual([]);
    expect(adapter.findLayoutsUsingAgent('claude')).toEqual([]);
  });

  test('a directory named *.json is not a record, in every lister', async () => {
    await adapter.createProject(project());
    await adapter.createLayout('acme', projectLayout());
    const owner = { kind: 'principal' as const, principal: alice };
    await adapter.createOwnedLayout(owner, board());
    await adapter.createOwnedLayout(INSTANCE_LAYOUT_OWNER, {
      ...board('shared'),
      id: 'instance-1',
      owner: INSTANCE_LAYOUT_OWNER,
    });

    // One impostor under each root the listers walk.
    mkdirSync(join(home, 'projects', 'acme', 'layouts', 'dir.json'));
    mkdirSync(
      join(
        home,
        'layouts',
        'personal',
        principalLayoutStorageKey(alice),
        'dir.json',
      ),
    );
    mkdirSync(join(home, 'layouts', 'instance', 'dir.json'));

    expect(adapter.listLayouts('acme').map((l) => l.slug)).toEqual(['coding']);
    expect(adapter.listOwnedLayouts(owner).map((l) => l.slug)).toEqual([
      'my-board',
    ]);
    expect(
      adapter.listOwnedLayouts(INSTANCE_LAYOUT_OWNER).map((l) => l.slug),
    ).toEqual(['shared']);
    expect(adapter.listProjects()[0]?.layoutCount).toBe(1);
    // The sweep walks all three roots; before the fix it threw EISDIR.
    expect(() => adapter.findLayoutsUsingAgent('claude')).not.toThrow();
  });
});

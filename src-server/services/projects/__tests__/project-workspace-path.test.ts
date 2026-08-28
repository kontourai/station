/**
 * archive#1501 — the shared state→path adapter
 * (`docs/design/portable-project-identity.md` §2.2.1).
 *
 * This suite covers the mapping ONCE, on behalf of all three migrated seams
 * (S3 knowledge, S4 Task bindings + A7, S5 attached roots), which is the
 * entire reason the adapter exists. The second describe block covers the
 * shape every one of those seams installs — a single
 * `resolveProjectWorkspacePath` call over a long-lived resolver — through
 * transitions no individual seam's suite exercises: a project gaining and
 * losing a directory, the directory itself being deleted and recreated, and a
 * process restart over the same home.
 *
 * Seam S2 (`runtime-routes.ts`) was migrated in this slice's first round and
 * reverted after review; see §2.2.1's S2 note. Nothing here depends on it.
 */

import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectConfig } from '@kontourai/station-contracts/project';
import type { ResourceResolutionResult } from '@kontourai/station-contracts/project-identity';
import { afterEach, describe, expect, test } from 'vitest';
import { putProject } from '../../../domain/__tests__/file-storage-test-helpers.js';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import type { CheckoutRemoteReader } from '../checkout-remote-reader.js';
import { ProjectBindingsStore } from '../project-binding-store.js';
import {
  type ProjectManifestRecord,
  projectManifestPath,
} from '../project-manifest-store.js';
import { ProjectResourceResolver } from '../project-resource-resolver.js';
import {
  projectDirectoryPath,
  resolveProjectDirectoryOutcome,
  resolveProjectWorkspaceOutcome,
  resolveProjectWorkspacePath,
} from '../project-workspace-path.js';

const tmpRoots: string[] = [];

afterEach(() => {
  while (tmpRoots.length > 0) {
    const dir = tmpRoots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

interface Harness {
  home: string;
  adapter: FileStorageAdapter;
  bindings: ProjectBindingsStore;
}

function createHome(home = tempDir('station-1501-home-')): Harness {
  return {
    home,
    adapter: new FileStorageAdapter(home),
    bindings: new ProjectBindingsStore(home),
  };
}

async function saveProject(
  adapter: FileStorageAdapter,
  overrides: Partial<ProjectConfig> & { slug: string },
): Promise<ProjectConfig> {
  const now = new Date().toISOString();
  const project: ProjectConfig = {
    id: randomUUID(),
    name: 'Acme',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  await putProject(adapter, project);
  return project;
}

function writeManifest(
  home: string,
  slug: string,
  record: Partial<ProjectManifestRecord> & { id: string },
): void {
  const full: ProjectManifestRecord = {
    schemaVersion: 1,
    repos: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...record,
  };
  mkdirSync(join(home, 'projects', slug), { recursive: true });
  writeFileSync(projectManifestPath(home, slug), JSON.stringify(full, null, 2));
}

function gitResource(canonicalRemote: string, role?: 'primary' | 'secondary') {
  return {
    kind: 'git' as const,
    id: canonicalRemote,
    canonicalRemote,
    ...(role ? { role } : {}),
  };
}

function remoteReader(urls: string[]): CheckoutRemoteReader {
  return async () => ({
    ok: true,
    remotes: urls.map((url, index) => ({
      name: index === 0 ? 'origin' : `remote-${index}`,
      url,
    })),
  });
}

const unreadableRemotes: CheckoutRemoteReader = async () => ({
  ok: false,
  reason: 'git is not installed',
});

function makeResolver(
  harness: Harness,
  readRemotes?: CheckoutRemoteReader,
): ProjectResourceResolver {
  return new ProjectResourceResolver({
    homeDir: harness.home,
    source: harness.adapter,
    bindings: harness.bindings,
    readRemotes: readRemotes ?? remoteReader([]),
  });
}

/**
 * The shape every migrated seam installs: one `resolveProjectWorkspacePath`
 * call bound to a resolver that outlives the call.
 */
function pathResolver(harness: Harness, readRemotes?: CheckoutRemoteReader) {
  const resolver = makeResolver(harness, readRemotes);
  return (slug: string) => resolveProjectWorkspacePath(slug, { resolver });
}

describe('project-workspace-path — the state → path-or-honest-absence mapping', () => {
  test('bound is the ONLY state that yields a path', async () => {
    const harness = createHome();
    const checkout = tempDir('station-1501-checkout-');
    await saveProject(harness.adapter, {
      slug: 'acme',
      workingDirectory: checkout,
    });

    const outcome = await resolveProjectWorkspaceOutcome('acme', {
      resolver: makeResolver(harness),
    });
    expect(outcome).toEqual({
      available: true,
      path: checkout,
      resourceId: 'local:acme',
    });
  });

  test.each([
    [
      'unbound (no working directory at all)',
      'unbound',
      async (harness: Harness) => {
        await saveProject(harness.adapter, { slug: 'acme' });
        return makeResolver(harness);
      },
    ],
    [
      // archive#1594: this WAS `unbound`. It is now `missing` — a recorded
      // realization whose path is gone. Behaviour at THIS adapter is
      // unchanged (every non-`bound` state maps to no path), which is the
      // point: the split matters to the seams that must tell the two apart.
      'missing (a declared working directory that does not exist)',
      'missing',
      async (harness: Harness) => {
        await saveProject(harness.adapter, {
          slug: 'acme',
          workingDirectory: '/definitely/not/here/station-1501',
        });
        return makeResolver(harness);
      },
    ],
    [
      'missing (a recorded binding whose path is gone)',
      'missing',
      async (harness: Harness) => {
        const gone = tempDir('station-1501-gone-');
        await saveProject(harness.adapter, {
          slug: 'acme',
          workingDirectory: gone,
        });
        writeManifest(harness.home, 'acme', {
          id: 'proj-acme',
          repos: [gitResource('github.com/kontourai/station')],
        });
        await harness.bindings.upsertProjectBinding({
          projectId: 'proj-acme',
          resourceId: 'github.com/kontourai/station',
          kind: 'git-checkout',
          path: join(gone, 'vanished'),
          remotes: ['git@github.com:kontourai/station.git'],
          verifiedAt: Date.now(),
          state: 'bound',
        });
        return makeResolver(
          harness,
          remoteReader(['git@github.com:kontourai/station.git']),
        );
      },
    ],
    [
      'drifted (the checkout is a different repository)',
      'drifted',
      async (harness: Harness) => {
        const checkout = tempDir('station-1501-drift-');
        await saveProject(harness.adapter, {
          slug: 'acme',
          workingDirectory: checkout,
        });
        writeManifest(harness.home, 'acme', {
          id: 'proj-acme',
          repos: [gitResource('github.com/kontourai/station')],
        });
        return makeResolver(
          harness,
          remoteReader(['git@github.com:someone/entirely-else.git']),
        );
      },
    ],
    [
      'stale (the live check could not be performed)',
      'stale',
      async (harness: Harness) => {
        const checkout = tempDir('station-1501-stale-');
        await saveProject(harness.adapter, {
          slug: 'acme',
          workingDirectory: checkout,
        });
        writeManifest(harness.home, 'acme', {
          id: 'proj-acme',
          repos: [gitResource('github.com/kontourai/station')],
        });
        return makeResolver(harness, unreadableRemotes);
      },
    ],
    [
      'ambiguous (several resources, no unique primary)',
      'ambiguous',
      async (harness: Harness) => {
        const checkout = tempDir('station-1501-ambiguous-');
        await saveProject(harness.adapter, {
          slug: 'acme',
          workingDirectory: checkout,
        });
        writeManifest(harness.home, 'acme', {
          id: 'proj-acme',
          repos: [
            gitResource('github.com/kontourai/station'),
            gitResource('github.com/kontourai/flow'),
          ],
        });
        return makeResolver(harness, remoteReader([]));
      },
    ],
  ])(
    '%s yields NO path, and carries the resolver’s own reason verbatim',
    async (_label, expectedState, arrange) => {
      const harness = createHome();
      const resolver = await arrange(harness);

      const outcome = await resolveProjectWorkspaceOutcome('acme', {
        resolver,
      });
      expect(outcome.available).toBe(false);
      if (outcome.available) throw new Error('unreachable');
      expect(outcome.state).toBe(expectedState);
      expect(outcome.reason.length).toBeGreaterThan(0);

      // Verbatim, not re-worded: the adapter must not invent a repair prompt.
      const raw = await resolver.resolveProjectResource('acme');
      expect(outcome.reason).toBe('reason' in raw ? raw.reason : undefined);
      expect(outcome.state).toBe(raw.state);

      // …and the path-shaped convenience wrapper agrees.
      expect(await resolveProjectWorkspacePath('acme', { resolver })).toBe(
        undefined,
      );
    },
  );

  test('an unknown project becomes the `error` outcome, NOT a throw', async () => {
    const harness = createHome();
    const resolver = makeResolver(harness);

    // The resolver itself fails closed…
    await expect(resolver.resolveProjectResource('nope')).rejects.toThrow(
      /not found/,
    );
    // …and the adapter reports that without throwing, carrying the message.
    const outcome = await resolveProjectWorkspaceOutcome('nope', { resolver });
    expect(outcome.available).toBe(false);
    if (outcome.available) throw new Error('unreachable');
    expect(outcome.state).toBe('error');
    expect(outcome.reason).toContain('nope');
    expect(await resolveProjectWorkspacePath('nope', { resolver })).toBe(
      undefined,
    );
  });

  test('an unreadable manifest becomes the `error` outcome, NOT a throw', async () => {
    const harness = createHome();
    const checkout = tempDir('station-1501-unreadable-');
    await saveProject(harness.adapter, {
      slug: 'acme',
      workingDirectory: checkout,
    });
    mkdirSync(join(harness.home, 'projects', 'acme'), { recursive: true });
    writeFileSync(projectManifestPath(harness.home, 'acme'), '{ not json');

    const resolver = makeResolver(harness);
    await expect(resolver.resolveProjectResource('acme')).rejects.toThrow();

    const outcome = await resolveProjectWorkspaceOutcome('acme', { resolver });
    expect(outcome.available).toBe(false);
    if (outcome.available) throw new Error('unreachable');
    expect(outcome.state).toBe('error');
    // It must NOT silently fall through to the working directory.
    expect(await resolveProjectWorkspacePath('acme', { resolver })).toBe(
      undefined,
    );
  });
});

describe('the path-shaped seam adapter — transitions', () => {
  test('A → B → A: the project gains a directory, loses it, and regains it', async () => {
    const harness = createHome();
    const dirA = tempDir('station-1501-s2a-');
    const dirB = tempDir('station-1501-s2b-');
    const resolve = pathResolver(harness);
    const project = await saveProject(harness.adapter, { slug: 'acme' });

    // A: no working directory at all — an organizational scope.
    expect(await resolve('acme')).toBe(undefined);

    // B: it gains one.
    await putProject(harness.adapter, { ...project, workingDirectory: dirA });
    expect(await resolve('acme')).toBe(dirA);

    // …moves.
    await putProject(harness.adapter, { ...project, workingDirectory: dirB });
    expect(await resolve('acme')).toBe(dirB);

    // A again: it loses it.
    await putProject(harness.adapter, {
      ...project,
      workingDirectory: undefined,
    });
    expect(await resolve('acme')).toBe(undefined);

    // …and regains the original.
    await putProject(harness.adapter, { ...project, workingDirectory: dirA });
    expect(await resolve('acme')).toBe(dirA);
  });

  test('the DIRECTORY itself is deleted and recreated (the project record never changes)', async () => {
    const harness = createHome();
    const checkout = tempDir('station-1501-s2-dir-');
    await saveProject(harness.adapter, {
      slug: 'acme',
      workingDirectory: checkout,
    });
    const resolve = pathResolver(harness);

    expect(await resolve('acme')).toBe(checkout);

    rmSync(checkout, { recursive: true, force: true });
    expect(await resolve('acme')).toBe(undefined);

    mkdirSync(checkout, { recursive: true });
    expect(await resolve('acme')).toBe(checkout);
  });

  test('restart-after-write: a store rebuilt from disk answers identically', async () => {
    const home = tempDir('station-1501-s2-restart-');
    const first = createHome(home);
    const checkout = tempDir('station-1501-s2-restart-ws-');
    await saveProject(first.adapter, {
      slug: 'acme',
      workingDirectory: checkout,
    });
    expect(await pathResolver(first)('acme')).toBe(checkout);

    // Nothing may be answered from memory: a completely fresh object graph
    // over the same home directory.
    const restarted = createHome(home);
    expect(await pathResolver(restarted)('acme')).toBe(checkout);
  });

  test('upgrade path: a project with project.json and NO manifest sidecar resolves, and the read writes nothing', async () => {
    const harness = createHome();
    const checkout = tempDir('station-1501-s2-upgrade-');
    await saveProject(harness.adapter, {
      slug: 'acme',
      workingDirectory: checkout,
    });
    const sidecar = projectManifestPath(harness.home, 'acme');
    const resolve = pathResolver(
      harness,
      remoteReader(['git@github.com:kontourai/station.git']),
    );

    expect(await resolve('acme')).toBe(checkout);
    expect(existsSync(sidecar)).toBe(false);
    expect(await resolve('acme')).toBe(checkout);
    expect(existsSync(sidecar)).toBe(false);
  });

  test('a tilde-stored working directory is expanded', async () => {
    const harness = createHome();
    const home = process.env.HOME ?? '';
    expect(home.length).toBeGreaterThan(0);
    await saveProject(harness.adapter, { slug: 'acme', workingDirectory: '~' });
    expect(await pathResolver(harness)('acme')).toBe(home);
  });
});

// ---------------------------------------------------------------------------
// archive#1594 — THE DIRECTORY-QUESTION.
//
// The second of the two questions the module docblock separates. Its answer is
// `path ?? unverifiedPath`, folded in exactly one place, and it is the one
// slice 3c's flip and S2's re-migration consume. The tests below cover the
// fold directly (pure, every state) and the full outcome through the REAL
// resolver, because a fold that is right in a unit test and wrong against the
// resolver's actual states is the failure this module exists to prevent.
// ---------------------------------------------------------------------------

describe('projectDirectoryPath — the one fold', () => {
  test('`bound` and only `bound` yields a VERIFIED directory', () => {
    expect(
      projectDirectoryPath({ state: 'bound', resourceId: 'r', path: '/p' }),
    ).toBe('/p');
  });

  test.each(['stale', 'drifted'] as const)(
    '%s yields its `unverifiedPath` — the observation the resolver already made',
    (state) => {
      expect(
        projectDirectoryPath({
          state,
          resourceId: 'r',
          reason: 'because',
          unverifiedPath: '/observed',
        }),
      ).toBe('/observed');
    },
  );

  test('`missing` yields NOTHING, even though it carries a path', () => {
    // The single most tempting mistake in this fold. `declaredPath` is a path
    // that is NOT THERE — the resolver `existsSync`'d it and it failed. A
    // caller handed it would stat a hole, or worse, create one.
    expect(
      projectDirectoryPath({
        state: 'missing',
        resourceId: 'r',
        reason: 'gone',
        record: 'working-directory',
        declaredPath: '/gone',
      }),
    ).toBeUndefined();
  });

  test.each(['unbound', 'ambiguous', 'unresolvable', 'not-portable'] as const)(
    '%s yields nothing — no directory was ever observed',
    (state) => {
      // `test.each` widens `state` across the tuple, which the union rejects
      // per-member; the narrowing belongs to the caller, not to the fold.
      const result = {
        state,
        resourceId: state === 'ambiguous' ? '' : 'r',
        reason: 'because',
      } as ResourceResolutionResult;
      expect(projectDirectoryPath(result)).toBeUndefined();
    },
  );
});

describe('resolveProjectDirectoryOutcome — against the real resolver', () => {
  test('a project without a manifest but with a real directory is available and VERIFIED', async () => {
    const harness = createHome();
    const checkout = tempDir('station-1594-dirq-bound-');
    await saveProject(harness.adapter, {
      slug: 'acme',
      workingDirectory: checkout,
    });

    expect(
      await resolveProjectDirectoryOutcome('acme', {
        resolver: makeResolver(harness),
      }),
    ).toEqual({
      available: true,
      path: checkout,
      verified: true,
      state: 'bound',
      resourceId: 'local:acme',
    });
  });

  test('THE S2 REVERT CASE: a manifested git project on a host with no `git` is available and UNVERIFIED, not a 404', async () => {
    // This is the whole reason `unverifiedPath` exists. Before archive#1594
    // this project resolved `stale` with no path, so every route that only
    // wanted a directory to read `.flow`/`.veritas` in answered 404 — for a
    // project whose directory is plainly there.
    const harness = createHome();
    const checkout = tempDir('station-1594-dirq-stale-');
    await saveProject(harness.adapter, {
      slug: 'acme',
      workingDirectory: checkout,
    });
    writeManifest(harness.home, 'acme', {
      id: 'proj-acme',
      repos: [gitResource('github.com/kontourai/station')],
    });

    const outcome = await resolveProjectDirectoryOutcome('acme', {
      resolver: makeResolver(harness, unreadableRemotes),
    });
    expect(outcome.available).toBe(true);
    if (!outcome.available) throw new Error('unreachable');
    expect(outcome.path).toBe(checkout);
    // The weaker claim is LABELLED weaker. A caller that needs repo identity
    // must ask the repo-question; one that only needs a directory may proceed.
    expect(outcome.verified).toBe(false);
    expect(outcome.state).toBe('stale');
    expect(outcome.reason).toContain('git is not installed');

    // …and the REPO-question still refuses, on the same tree. If these two
    // ever agree, one of them is answering the wrong question.
    expect(
      await resolveProjectWorkspacePath('acme', {
        resolver: makeResolver(harness, unreadableRemotes),
      }),
    ).toBeUndefined();
  });

  test('a drifted checkout is available and UNVERIFIED — the legacy seam never identity-checked either', async () => {
    const harness = createHome();
    const checkout = tempDir('station-1594-dirq-drift-');
    await saveProject(harness.adapter, {
      slug: 'acme',
      workingDirectory: checkout,
    });
    writeManifest(harness.home, 'acme', {
      id: 'proj-acme',
      repos: [gitResource('github.com/kontourai/station')],
    });

    const outcome = await resolveProjectDirectoryOutcome('acme', {
      resolver: makeResolver(
        harness,
        remoteReader(['git@github.com:someone/else.git']),
      ),
    });
    expect(outcome.available).toBe(true);
    if (!outcome.available) throw new Error('unreachable');
    expect(outcome.path).toBe(checkout);
    expect(outcome.verified).toBe(false);
    expect(outcome.state).toBe('drifted');
  });

  test('station#1594: a project with NO directory is `unbound` — the #1023 population', async () => {
    const harness = createHome();
    await saveProject(harness.adapter, { slug: 'default', name: 'Default' });

    const outcome = await resolveProjectDirectoryOutcome('default', {
      resolver: makeResolver(harness),
    });
    expect(outcome.available).toBe(false);
    if (outcome.available) throw new Error('unreachable');
    expect(outcome.state).toBe('unbound');
    // Slice 3c maps this to $HOME + cwdDefaulted. It carries no declaredPath
    // because nothing declared one — that is the whole distinction.
    expect('declaredPath' in outcome).toBe(false);
  });

  test('station#1594: a project whose DECLARED directory is gone is `missing`, and names the record and the path — the #791 population', async () => {
    const harness = createHome();
    const gone = join(tmpdir(), `station-1594-gone-${randomUUID()}`);
    await saveProject(harness.adapter, {
      slug: 'acme',
      workingDirectory: gone,
    });

    const outcome = await resolveProjectDirectoryOutcome('acme', {
      resolver: makeResolver(harness),
    });
    expect(outcome.available).toBe(false);
    if (outcome.available) throw new Error('unreachable');
    // The two populations above are the ones the seam must treat OPPOSITELY,
    // and this pair of tests is what proves the contract can now tell them
    // apart at all. Before archive#1594 both answered `unbound`.
    expect(outcome.state).toBe('missing');
    expect(outcome.state === 'missing' && outcome.record).toBe(
      'working-directory',
    );
    expect(outcome.state === 'missing' && outcome.declaredPath).toBe(gone);
  });

  test('an unknown project is the `error` outcome, never a throw', async () => {
    const harness = createHome();
    const outcome = await resolveProjectDirectoryOutcome('nope', {
      resolver: makeResolver(harness),
    });
    expect(outcome.available).toBe(false);
    if (outcome.available) throw new Error('unreachable');
    expect(outcome.state).toBe('error');
    expect(outcome.reason).toMatch(/not found/);
  });

  test('an untyped producer that answers `bound` with no path degrades to `error` — never to `unbound`, the one fail-OPEN state', async () => {
    // Only reachable without a compiler — a `vi.fn()` double, a result off
    // disk, a producer built against an older version of the contracts
    // package. `isWellFormedResolution` is the runtime backstop; this is what
    // the adapter does if one slips past it.
    //
    // The STATE is the load-bearing assertion (review round 1, HIGH-2), not
    // just the reason prose. Slice 3c maps `unbound` to `$HOME` +
    // `cwdDefaulted: true`; reporting it for a result that CLAIMED a directory
    // would start a project-bound chat in $HOME — the archive#1011 fail-open class.
    // `error` maps to a throw, which is what "I cannot answer" owes a
    // fail-closed seam.
    const outcome = await resolveProjectDirectoryOutcome('acme', {
      resolver: {
        resolveProjectResource: async () =>
          ({ state: 'bound', resourceId: 'r' }) as never,
      },
    });
    expect(outcome.available).toBe(false);
    if (outcome.available) throw new Error('unreachable');
    expect(outcome.state).toBe('error');
    expect(outcome.state).not.toBe('unbound');
    expect(outcome.reason).toContain('resolved as bound but carried no path');
  });

  test('an untyped `stale` with no `unverifiedPath` degrades to `error` and KEEPS the resolver’s sentence', async () => {
    const outcome = await resolveProjectDirectoryOutcome('acme', {
      resolver: {
        resolveProjectResource: async () =>
          ({
            state: 'stale',
            resourceId: 'r',
            reason: 'git refused',
          }) as never,
      },
    });
    expect(outcome.available).toBe(false);
    if (outcome.available) throw new Error('unreachable');
    expect(outcome.state).toBe('error');
    expect(outcome.state).not.toBe('unbound');
    expect(outcome.reason).toContain('carried no unverifiedPath');
    expect(outcome.reason).toContain('git refused');
  });
});

describe('BOTH questions survive an untyped producer (review round 1 HIGH-1, delta HIGH-1)', () => {
  test('a NULL path — the shape `JSON.parse` produces — is a named gap, not a TypeError, in the DIRECTORY-question', async () => {
    // Delta review, HIGH: round 1 restored the `typeof` guard on the sibling
    // repo-question and missed this one — the function slice 3c's flip and
    // S2's re-migration actually call. The round-1 tests used ABSENT fields,
    // which take the safe `undefined` path; a result read off disk yields
    // `null`, and `null.length` throws past `resolveResource`'s catch out of a
    // function whose docblock promises it never throws.
    for (const malformed of [
      { state: 'bound', resourceId: 'r', path: null },
      { state: 'stale', resourceId: 'r', reason: 'x', unverifiedPath: null },
    ]) {
      const outcome = await resolveProjectDirectoryOutcome('acme', {
        resolver: { resolveProjectResource: async () => malformed as never },
      });
      expect(outcome.available).toBe(false);
      if (outcome.available) throw new Error('unreachable');
      expect(outcome.state).toBe('error');
    }
  });

  test('a `missing` that cannot name its own record degrades to `error` — #791 must never throw a blank', async () => {
    // Delta review, MEDIUM: the `missing` variant exists so slice 3c's throw
    // cannot COMPILE without the path. An untyped producer can still omit it
    // at runtime, and `new Error(undefined)` naming no path is exactly the
    // blank-cell failure the honesty bar forbids.
    const outcome = await resolveProjectDirectoryOutcome('acme', {
      resolver: {
        resolveProjectResource: async () =>
          ({ state: 'missing', resourceId: 'r' }) as never,
      },
    });
    expect(outcome.available).toBe(false);
    if (outcome.available) throw new Error('unreachable');
    expect(outcome.state).toBe('error');
    expect(outcome.reason).toContain('nothing to re-point');
  });

  test('a non-bound result with NO reason carries a named gap in the DIRECTORY-question too', async () => {
    const outcome = await resolveProjectDirectoryOutcome('acme', {
      resolver: {
        resolveProjectResource: async () =>
          ({ state: 'unbound', resourceId: 'r' }) as never,
      },
    });
    expect(outcome.available).toBe(false);
    if (outcome.available) throw new Error('unreachable');
    expect(typeof outcome.reason).toBe('string');
    expect(outcome.reason).toContain('without a reason');
  });

  test('`bound` with NO path returns a named gap rather than throwing a TypeError', async () => {
    // The `typeof` guard the discriminated union makes LOOK redundant is
    // redundant only for the producers the union covers. For the ones this
    // guard exists for, `result.path` is `undefined` and `.length` throws
    // past `resolveResource`'s catch — turning a named gap into a crash in
    // every seam that calls this (`task-graph-service`, `knowledge-scan-utils`,
    // `station-runtime`, `runtime-initialize`).
    const outcome = await resolveProjectWorkspaceOutcome('acme', {
      resolver: {
        resolveProjectResource: async () =>
          ({ state: 'bound', resourceId: 'r' }) as never,
      },
    });
    expect(outcome.available).toBe(false);
    if (outcome.available) throw new Error('unreachable');
    expect(outcome.reason).toContain('resolved as bound but carried no path');
  });

  test('a non-bound result with NO reason still carries a non-empty string, because callers hand it to `new Error(...)`', async () => {
    const outcome = await resolveProjectWorkspaceOutcome('acme', {
      resolver: {
        resolveProjectResource: async () =>
          ({ state: 'unbound', resourceId: 'r' }) as never,
      },
    });
    expect(outcome.available).toBe(false);
    if (outcome.available) throw new Error('unreachable');
    expect(typeof outcome.reason).toBe('string');
    expect(outcome.reason).toContain('without a reason');
  });
});

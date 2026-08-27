/**
 * station#1502 slice 4 — `describeProjectResolution`, the project-level
 * posture (`docs/design/portable-project-identity.md` §3.6 preamble, §4.1).
 *
 * Built over REAL stores on a temp home rather than fakes wherever the claim
 * is about what the stores actually do — in particular the trap-2 regression
 * below, whose whole point is that `composeManifest`'s ambiguity path is
 * structurally invisible and therefore cannot be reproduced by a mock that
 * merely returns what the test already believes.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectConfig } from '@kontourai/station-contracts/project';
import { isWellFormedProjectResolutionView } from '@kontourai/station-contracts/project-identity';
import { afterEach, describe, expect, test } from 'vitest';
import { putProject } from '../../../domain/__tests__/file-storage-test-helpers.js';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import type { CheckoutRemoteReader } from '../checkout-remote-reader.js';
import { ProjectBindingsStore } from '../project-binding-store.js';
import {
  type ProjectManifestRecord,
  ProjectManifestStore,
  projectManifestPath,
} from '../project-manifest-store.js';
import { describeProjectResolution } from '../project-resolution-view.js';
import { ProjectResourceResolver } from '../project-resource-resolver.js';

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
  manifests: ProjectManifestStore;
  resolver: ProjectResourceResolver;
}

function createHarness(readRemotes?: CheckoutRemoteReader): Harness {
  const home = tempDir('station-ppi-view-home-');
  const adapter = new FileStorageAdapter(home);
  const bindings = new ProjectBindingsStore(home);
  const reader: CheckoutRemoteReader =
    readRemotes ?? (async () => ({ ok: true, remotes: [] }));
  const manifests = new ProjectManifestStore(home, adapter, {
    bindings,
    readRemotes: reader,
  });
  const resolver = new ProjectResourceResolver({
    homeDir: home,
    source: adapter,
    bindings,
    manifests,
    readRemotes: reader,
  });
  return { home, adapter, bindings, manifests, resolver };
}

async function saveProject(
  adapter: FileStorageAdapter,
  overrides: Partial<ProjectConfig> & { slug: string },
): Promise<ProjectConfig> {
  const now = new Date().toISOString();
  const project: ProjectConfig = {
    id: randomUUID(),
    name: overrides.name ?? 'Acme',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  await putProject(adapter, project);
  return project;
}

function writeManifestRecord(
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

function writeRawManifest(home: string, slug: string, contents: string): void {
  mkdirSync(join(home, 'projects', slug), { recursive: true });
  writeFileSync(projectManifestPath(home, slug), contents);
}

function describeWith(harness: Harness, slug: string) {
  return describeProjectResolution(slug, {
    resolver: harness.resolver,
    manifests: harness.manifests,
    bindings: harness.bindings,
    source: harness.adapter,
  });
}

function localOnlyResource(id: string): ProjectManifestRecord['repos'][number] {
  return { kind: 'local-only', id };
}

function gitResource(
  canonicalRemote: string,
  role?: 'primary' | 'secondary',
): ProjectManifestRecord['repos'][number] {
  return {
    kind: 'git',
    id: canonicalRemote,
    canonicalRemote,
    ...(role ? { role } : {}),
  };
}

describe('describeProjectResolution — the not-backing derivation (§4.1)', () => {
  test('no manifest record AND no workingDirectory is `not-backing`, with no resource at all', async () => {
    const harness = createHarness();
    await saveProject(harness.adapter, { slug: 'acme' });

    const view = await describeWith(harness, 'acme');

    expect(view).toEqual({ posture: 'not-backing' });
    // §4.1: nothing per-resource exists to render. The predicate REJECTS a
    // `resource` on this posture, so this is a real structural guarantee and
    // not just an omission this test happened to observe.
    expect('resources' in view).toBe(false);
    expect('primary' in view).toBe(false);
    expect(isWellFormedProjectResolutionView(view)).toBe(true);
  });

  test('a declared workingDirectory alone is `backing` — a realization is recorded here even with no manifest', async () => {
    const harness = createHarness();
    const checkout = tempDir('station-ppi-view-checkout-');
    await saveProject(harness.adapter, {
      slug: 'acme',
      workingDirectory: checkout,
    });

    const view = await describeWith(harness, 'acme');

    expect(view.posture).toBe('backing');
    // The compat resource: no manifest identity to check the directory
    // against, so the resolver reports it under `localProjectResourceId`.
    expect(view).toEqual({
      posture: 'backing',
      resources: [{ state: 'bound', resourceId: 'local:acme', path: checkout }],
      // With no manifest there is one compat resource and it IS what a
      // no-`resourceId` caller gets.
      primary: { named: true, resourceId: 'local:acme' },
    });
    expect(isWellFormedProjectResolutionView(view)).toBe(true);
  });

  test('a workingDirectory that is only whitespace does NOT count as a realization', async () => {
    const harness = createHarness();
    await saveProject(harness.adapter, {
      slug: 'acme',
      workingDirectory: '   ',
    });

    expect(await describeWith(harness, 'acme')).toEqual({
      posture: 'not-backing',
    });
  });

  test('a DECLARED GIT RESOURCE alone is `backing` — §3.6 covers "setting up to back it"', async () => {
    const harness = createHarness();
    await saveProject(harness.adapter, { slug: 'acme' });
    writeManifestRecord(harness.home, 'acme', {
      id: 'prj_declared',
      repos: [gitResource('github.com/acme/api', 'primary')],
    });

    const view = await describeWith(harness, 'acme');

    expect(view.posture).toBe('backing');
    if (view.posture !== 'backing') throw new Error('unreachable');
    // Declared but not realized here — a BACKING Station's honest "not set up
    // here", which is a different sentence from "this Station backs nothing".
    expect(view.resources).toHaveLength(1);
    expect(view.resources[0].state).toBe('unbound');
    expect(view.resources[0].resourceId).toBe('github.com/acme/api');
    expect(view.primary).toEqual({
      named: true,
      resourceId: 'github.com/acme/api',
    });
    expect(isWellFormedProjectResolutionView(view)).toBe(true);
  });

  test('an EMPTY manifest record is `not-backing` — a record that names nothing is not a declaration', async () => {
    const harness = createHarness();
    await saveProject(harness.adapter, { slug: 'acme' });
    writeManifestRecord(harness.home, 'acme', { id: 'prj_empty', repos: [] });

    // The derivation asks whether anything here NAMES CODE, not whether a
    // sidecar file exists. A record declaring no resources answers no — and
    // §4.1's rendering ("it has no working directory on this Station, there is
    // nothing to set up") is the truth about it.
    expect(await describeWith(harness, 'acme')).toEqual({
      posture: 'not-backing',
    });
  });

  // ── station#1502 fix round, HIGH-1 ───────────────────────────────────────
  //
  // `ProjectService.createProject` backfills a manifest for EVERY new project,
  // and `deriveRepos` returns a synthetic `local-only` placeholder whenever the
  // project has no working directory. Reading the record's EXISTENCE therefore
  // made `not-backing` unreachable for any project a user creates: a member who
  // creates a project to collaborate in got the "Not set up on this Station"
  // headline, a row naming `local:acme`, and a repair form — three of §4.1's
  // five forbidden things, shown to the member §4.1 exists to protect.
  //
  // Every pre-existing `backing` test above uses a GIT resource, which is why
  // this was uncovered.
  describe('the backfill placeholder is not a declaration', () => {
    test('a `local-only` placeholder record with no workingDirectory is `not-backing`', async () => {
      const harness = createHarness();
      await saveProject(harness.adapter, { slug: 'acme' });
      // Byte-for-byte what `ProjectManifestStore.deriveRepos` writes for a
      // project with no working directory (its `localOnly` constant).
      writeManifestRecord(harness.home, 'acme', {
        id: 'prj_backfilled',
        repos: [localOnlyResource('local:acme')],
      });

      const view = await describeWith(harness, 'acme');

      expect(view).toEqual({ posture: 'not-backing' });
      expect('resources' in view).toBe(false);
      expect('primary' in view).toBe(false);
      expect(isWellFormedProjectResolutionView(view)).toBe(true);
    });

    test('the SAME record plus a binding row is `backing` — a realization is recorded here', async () => {
      const harness = createHarness();
      const checkout = tempDir('station-ppi-view-localdir-');
      await saveProject(harness.adapter, { slug: 'acme' });
      writeManifestRecord(harness.home, 'acme', {
        id: 'prj_backfilled',
        repos: [localOnlyResource('local:acme')],
      });
      await harness.bindings.upsertProjectBinding({
        projectId: 'prj_backfilled',
        resourceId: 'local:acme',
        kind: 'local-directory',
        path: checkout,
        remotes: [],
        verifiedAt: Date.UTC(2026, 0, 1),
        state: 'bound',
      });

      const view = await describeWith(harness, 'acme');

      expect(view).toEqual({
        posture: 'backing',
        resources: [
          { state: 'bound', resourceId: 'local:acme', path: checkout },
        ],
        primary: { named: true, resourceId: 'local:acme' },
      });
    });

    test('a GIT resource with no workingDirectory and no binding is `backing` — something names code', async () => {
      const harness = createHarness();
      await saveProject(harness.adapter, { slug: 'acme' });
      writeManifestRecord(harness.home, 'acme', {
        id: 'prj_declared',
        repos: [gitResource('github.com/acme/api', 'primary')],
      });

      const view = await describeWith(harness, 'acme');

      expect(view.posture).toBe('backing');
      if (view.posture !== 'backing') throw new Error('unreachable');
      // A BACKING Station's honest "not set up here" — and the one place the
      // "Point at an existing checkout" form is actually the right offer.
      expect(view.resources[0].state).toBe('unbound');
    });

    test('a placeholder record WITH a working directory is `backing` (clause 1 stands alone)', async () => {
      const harness = createHarness();
      const checkout = tempDir('station-ppi-view-wd-');
      await saveProject(harness.adapter, {
        slug: 'acme',
        workingDirectory: checkout,
      });
      writeManifestRecord(harness.home, 'acme', {
        id: 'prj_backfilled',
        repos: [localOnlyResource('local:acme')],
      });

      const view = await describeWith(harness, 'acme');

      expect(view.posture).toBe('backing');
    });
  });
});

describe('describeProjectResolution — trap 2: `repos` is never read or exposed', () => {
  test('a manifest that FAILS validation on selection ambiguity alone reports `ambiguous`, and the view carries no repos', async () => {
    const harness = createHarness();
    await saveProject(harness.adapter, { slug: 'acme' });
    // TWO primaries. `ProjectManifestStore.composeManifest` returns this
    // candidate VERBATIM — `repos` populated, no flag — because the only
    // diagnostics are §3.5 selection ambiguities (its decision 7). A consumer
    // that iterated `repos` would render both as though the project resolved.
    writeManifestRecord(harness.home, 'acme', {
      id: 'prj_two_primaries',
      repos: [
        gitResource('github.com/acme/api', 'primary'),
        gitResource('github.com/acme/web', 'primary'),
      ],
    });

    // The trap, demonstrated rather than asserted from the docs: the store
    // hands back a fully-populated manifest for a manifest that is INVALID.
    const composed = harness.manifests.readProjectManifest('acme');
    expect(composed?.repos).toHaveLength(2);

    const view = await describeWith(harness, 'acme');

    // station#1503: every declared resource still resolves BY ID, and the
    // ambiguity lands on `primary` — where a surface must render it, because
    // every no-`resourceId` consumer in Station still fails on this project.
    expect(view.posture).toBe('backing');
    if (view.posture !== 'backing') throw new Error('unreachable');
    expect(view.resources.map((entry) => entry.resourceId)).toEqual([
      'github.com/acme/api',
      'github.com/acme/web',
    ]);
    expect(view.primary).toEqual({
      named: false,
      // The candidates live in the reason, which is the only place they are
      // safe to read from.
      reason: expect.stringContaining('github.com/acme/api'),
    });
    // Nothing resembling the manifest's resource list crossed this boundary.
    expect(JSON.stringify(view)).not.toContain('canonicalRemote');
    expect('repos' in view).toBe(false);
    expect(isWellFormedProjectResolutionView(view)).toBe(true);
  });

  test('several resources and NO primary is the same story', async () => {
    const harness = createHarness();
    await saveProject(harness.adapter, { slug: 'acme' });
    writeManifestRecord(harness.home, 'acme', {
      id: 'prj_no_primary',
      repos: [
        gitResource('github.com/acme/api'),
        gitResource('github.com/acme/web'),
      ],
    });

    const view = await describeWith(harness, 'acme');

    expect(view.posture).toBe('backing');
    if (view.posture !== 'backing') throw new Error('unreachable');
    expect(view.resources).toHaveLength(2);
    expect(view.primary.named).toBe(false);
    expect(isWellFormedProjectResolutionView(view)).toBe(true);
  });
});

describe('describeProjectResolution — the three manifest throw classes are `unreadable`', () => {
  test('an unknown schemaVersion (ProjectManifestSchemaVersionError)', async () => {
    const harness = createHarness();
    await saveProject(harness.adapter, { slug: 'acme' });
    writeRawManifest(
      harness.home,
      'acme',
      JSON.stringify({
        schemaVersion: 99,
        id: 'prj_future',
        repos: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    );

    const view = await describeWith(harness, 'acme');

    expect(view.posture).toBe('unreadable');
    if (view.posture !== 'unreadable') throw new Error('unreachable');
    expect(view.reason).toContain('acme');
    expect(view.reason).toContain('schema version');
    expect(isWellFormedProjectResolutionView(view)).toBe(true);
  });

  test('corrupt content (ProjectManifestUnreadableError)', async () => {
    const harness = createHarness();
    await saveProject(harness.adapter, { slug: 'acme' });
    writeRawManifest(harness.home, 'acme', '{ not json at all');

    const view = await describeWith(harness, 'acme');

    expect(view.posture).toBe('unreadable');
    if (view.posture !== 'unreadable') throw new Error('unreachable');
    expect(view.reason).toContain('not readable');
  });

  test('a zero-length sidecar (ProjectManifestIncompleteError)', async () => {
    const harness = createHarness();
    await saveProject(harness.adapter, { slug: 'acme' });
    writeRawManifest(harness.home, 'acme', '');

    const view = await describeWith(harness, 'acme');

    expect(view.posture).toBe('unreadable');
    if (view.posture !== 'unreadable') throw new Error('unreachable');
    expect(view.reason).toContain('zero-length');
  });

  test('an unreadable manifest is NEVER reported as `not-backing`, even with no workingDirectory', async () => {
    // The exact lie the posture exists to prevent: §4.1 guarantees the
    // `not-backing` rendering carries no repair prompt, so a swallowed read
    // failure would structurally suppress the one thing an operator needs.
    const harness = createHarness();
    await saveProject(harness.adapter, { slug: 'acme' });
    writeRawManifest(harness.home, 'acme', '');

    const view = await describeWith(harness, 'acme');

    expect(view.posture).not.toBe('not-backing');
  });

  test('a manifest that fails validation on something OTHER than ambiguity is `unreadable`, not `backing`', async () => {
    const harness = createHarness();
    await saveProject(harness.adapter, { slug: 'acme' });
    // A git resource with an absolute-path canonicalRemote: §3.2 refuses
    // path-shaped identities, and that diagnostic is NOT a selection
    // ambiguity — so `composeManifest` fails closed rather than returning the
    // candidate. The record itself parses, so this can only surface from the
    // resolver's compose, which is why the derivation catches around BOTH.
    writeManifestRecord(harness.home, 'acme', {
      id: 'prj_bad_remote',
      repos: [gitResource('/Users/dev/mirrors/api', 'primary')],
    });

    const view = await describeWith(harness, 'acme');

    expect(view.posture).toBe('unreadable');
    if (view.posture !== 'unreadable') throw new Error('unreachable');
    expect(view.reason).toContain('acme');
  });
});

describe('describeProjectResolution — failures it does NOT absorb', () => {
  test('an unknown project throws (the route turns that into a 404)', async () => {
    const harness = createHarness();
    await expect(describeWith(harness, 'nope')).rejects.toThrow(/not found/);
  });

  test('a non-manifest failure from the resolver propagates rather than becoming `unreadable`', async () => {
    const harness = createHarness();
    await saveProject(harness.adapter, { slug: 'acme' });
    const boom = new Error('the disk caught fire');

    await expect(
      describeProjectResolution('acme', {
        resolver: {
          resolveProjectResource: async () => {
            throw boom;
          },
        },
        manifests: {
          readRecord: () => ({
            schemaVersion: 1,
            id: 'prj_x',
            repos: [gitResource('github.com/acme/api', 'primary')],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          }),
        },
        bindings: { read: () => ({ bindings: [] }) },
        source: harness.adapter,
      }),
    ).rejects.toBe(boom);
  });

  test('the binding store is not read at all when there is NO manifest record', async () => {
    // Binding rows are keyed by `(manifest.id, resource.id)`, so with no record
    // there is no key and no row anything could find. Pinning the SKIP, not
    // just the answer: it is what keeps a project with no manifest from being
    // failed by an unrelated corrupt binding store.
    const harness = createHarness();
    await saveProject(harness.adapter, { slug: 'acme' });

    const view = await describeProjectResolution('acme', {
      resolver: harness.resolver,
      manifests: { readRecord: () => undefined },
      bindings: {
        read: () => {
          throw new Error('the binding store must not be read here');
        },
      },
      source: harness.adapter,
    });

    expect(view).toEqual({ posture: 'not-backing' });
  });
});

// ── station#1503 slice 5 — multi-repo ──────────────────────────────────────

describe('describeProjectResolution — multi-repo (station#1503, §10 slice 5)', () => {
  test('a PARTIALLY BOUND project renders 2 of 3 — the reason slice 5 depends on slice 4', async () => {
    const harness = createHarness(async (path) => ({
      ok: true,
      remotes: [
        {
          name: 'origin',
          url: path.includes('web')
            ? 'git@github.com:acme/web.git'
            : 'git@github.com:acme/api.git',
        },
      ],
    }));
    const apiCheckout = tempDir('station-ppi-view-api-');
    const webCheckout = tempDir('station-ppi-view-web-');
    await saveProject(harness.adapter, { slug: 'acme' });
    writeManifestRecord(harness.home, 'acme', {
      id: 'prj_partial',
      repos: [
        gitResource('github.com/acme/api', 'primary'),
        gitResource('github.com/acme/web', 'secondary'),
        gitResource('github.com/acme/docs', 'secondary'),
      ],
    });
    for (const [resourceId, path, url] of [
      ['github.com/acme/api', apiCheckout, 'git@github.com:acme/api.git'],
      ['github.com/acme/web', webCheckout, 'git@github.com:acme/web.git'],
    ] as const) {
      await harness.bindings.upsertProjectBinding({
        projectId: 'prj_partial',
        resourceId,
        kind: 'git-checkout',
        path,
        remotes: [url],
        verifiedAt: Date.UTC(2026, 0, 1),
        state: 'bound',
      });
    }

    const view = await describeWith(harness, 'acme');

    expect(view.posture).toBe('backing');
    if (view.posture !== 'backing') throw new Error('unreachable');
    // ONE result per declared resource, in DECLARATION ORDER — nothing picked,
    // nothing ranked, nothing dropped.
    expect(
      view.resources.map((entry) => [entry.resourceId, entry.state]),
    ).toEqual([
      ['github.com/acme/api', 'bound'],
      ['github.com/acme/web', 'bound'],
      ['github.com/acme/docs', 'unbound'],
    ]);
    expect(view.primary).toEqual({
      named: true,
      resourceId: 'github.com/acme/api',
    });
    expect(isWellFormedProjectResolutionView(view)).toBe(true);
    // The manifest's resource objects still never cross this boundary.
    expect(JSON.stringify(view)).not.toContain('canonicalRemote');
  });

  test('an UNDECLARED resource is never answered with the primary', async () => {
    const harness = createHarness();
    await saveProject(harness.adapter, { slug: 'acme' });
    writeManifestRecord(harness.home, 'acme', {
      id: 'prj_multi',
      repos: [
        gitResource('github.com/acme/api', 'primary'),
        gitResource('github.com/acme/web', 'secondary'),
      ],
    });

    const view = await describeWith(harness, 'acme');

    expect(view.posture).toBe('backing');
    if (view.posture !== 'backing') throw new Error('unreachable');
    // The view enumerates only what the record declares — a resource nobody
    // declared has no row, and no row silently stands in for another.
    expect(view.resources).toHaveLength(2);
    expect(
      await harness.resolver.resolveProjectResource(
        'acme',
        'github.com/acme/ghost',
      ),
    ).toMatchObject({ state: 'unbound', resourceId: 'github.com/acme/ghost' });
  });
});

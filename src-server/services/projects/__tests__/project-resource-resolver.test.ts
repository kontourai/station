import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { ProjectConfig } from '@kontourai/station-contracts/project';
import {
  isWellFormedResolution,
  type ResourceResolutionResult,
} from '@kontourai/station-contracts/project-identity';
import { afterEach, describe, expect, test } from 'vitest';
import { putProject } from '../../../domain/__tests__/file-storage-test-helpers.js';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import type { CheckoutRemoteReader } from '../checkout-remote-reader.js';
import { ProjectBindingsStore } from '../project-binding-store.js';
import {
  type ProjectManifestRecord,
  ProjectManifestSchemaVersionError,
  ProjectManifestUnreadableError,
  projectManifestPath,
} from '../project-manifest-store.js';
import { ProjectResourceResolver } from '../project-resource-resolver.js';

/**
 * station#1594 made `ResourceResolutionResult` a discriminated union, so
 * `result.path` and `result.reason` are no longer readable without narrowing —
 * every read below was a compile error until it went through one of these.
 * That is the migration story working, and it is worth stating: before the
 * union, a test asserting `result.path` on a state that can never carry one
 * compiled and passed vacuously.
 *
 * These two accessors are deliberately NOT assertions. A test that wants to
 * prove no path leaked asserts `'path' in result` directly, which is the same
 * power the old `expect(result.path).toBeUndefined()` had; folding that into an
 * accessor that returns `undefined` for every non-`bound` state would have
 * turned ten real assertions into tautologies.
 */
function pathOf(result: ResourceResolutionResult): string | undefined {
  return result.state === 'bound' ? result.path : undefined;
}

function reasonOf(result: ResourceResolutionResult): string | undefined {
  return 'reason' in result ? result.reason : undefined;
}

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

function createHome(): Harness {
  const home = tempDir('station-ppi-resolver-home-');
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
): ProjectManifestRecord {
  const full: ProjectManifestRecord = {
    schemaVersion: 1,
    repos: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...record,
  };
  mkdirSync(join(home, 'projects', slug), { recursive: true });
  writeFileSync(projectManifestPath(home, slug), JSON.stringify(full, null, 2));
  return full;
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

/** Every result this suite produces must satisfy slice 1's honesty predicate. */
function expectWellFormed(result: ResourceResolutionResult): void {
  expect(isWellFormedResolution(result)).toBe(true);
}

describe('resolveProjectResource — the upgrade path from an install predating manifests', () => {
  test('a project with project.json and NO manifest resolves through the working-directory fallback, and the read WRITES NOTHING', async () => {
    const harness = createHome();
    const checkout = tempDir('station-ppi-checkout-');
    await saveProject(harness.adapter, {
      slug: 'acme',
      workingDirectory: checkout,
    });
    const sidecar = projectManifestPath(harness.home, 'acme');

    const resolver = makeResolver(
      harness,
      remoteReader(['git@github.com:kontourai/station.git']),
    );
    const before = await resolver.resolveProjectResource('acme');
    expect(before).toEqual({
      state: 'bound',
      resourceId: 'local:acme',
      path: checkout,
    });
    expectWellFormed(before);

    // D1: a read path does not write. No manifest is minted here — the
    // backfill belongs to a write boundary (createProject today, an explicit
    // action in slice 3).
    expect(existsSync(sidecar)).toBe(false);
    const after = await resolver.resolveProjectResource('acme');
    expect(after).toEqual(before);
    expect(existsSync(sidecar)).toBe(false);

    // …and it is a read-path property, not in-memory state: a fresh resolver
    // over the same on-disk home gives the same answer and still writes
    // nothing.
    const restarted = makeResolver(
      createRestartHarness(harness.home),
      remoteReader(['git@github.com:kontourai/station.git']),
    );
    expect(await restarted.resolveProjectResource('acme')).toEqual(before);
    expect(existsSync(sidecar)).toBe(false);
  });

  test('A → B → A: the working directory moves and returns, and no sidecar is ever written', async () => {
    const harness = createHome();
    const dirA = tempDir('station-ppi-a-');
    const dirB = tempDir('station-ppi-b-');
    const project = await saveProject(harness.adapter, {
      slug: 'acme',
      workingDirectory: dirA,
    });
    const resolver = makeResolver(harness);
    const sidecar = projectManifestPath(harness.home, 'acme');

    const atA = await resolver.resolveProjectResource('acme');
    expect(pathOf(atA)).toBe(dirA);
    expect(existsSync(sidecar)).toBe(false);

    await putProject(harness.adapter, { ...project, workingDirectory: dirB });
    const atB = await resolver.resolveProjectResource('acme');
    expect(pathOf(atB)).toBe(dirB);
    expect(existsSync(sidecar)).toBe(false);

    await putProject(harness.adapter, { ...project, workingDirectory: dirA });
    const backAtA = await resolver.resolveProjectResource('acme');
    expect(backAtA).toEqual(atA);
    expect(existsSync(sidecar)).toBe(false);
  });

  test('a relative workingDirectory resolves to an ABSOLUTE path, not one relative to the server process', async () => {
    const harness = createHome();
    const checkout = tempDir('station-ppi-relative-');
    const relativePath = relative(process.cwd(), checkout);
    expect(relativePath.startsWith('/')).toBe(false);
    await saveProject(harness.adapter, {
      slug: 'acme',
      workingDirectory: relativePath,
    });

    const result = await makeResolver(harness).resolveProjectResource('acme');
    // `expandTilde` alone leaves this relative, and every consumer would then
    // evaluate it against the server process's cwd.
    expect(pathOf(result)).toBe(checkout);
  });

  test('the seeded `default` project — no directory at all — is unbound with a truthful reason, never a fabricated path and never `not-portable`', async () => {
    const harness = createHome();
    await saveProject(harness.adapter, { slug: 'default', name: 'Default' });
    const result =
      await makeResolver(harness).resolveProjectResource('default');
    // §3.6's `not-portable` is "a local-only resource authored by SOMEONE
    // ELSE"; this is Station's own seeded project on the machine that owns it.
    expect(result.state).toBe('unbound');
    expect('path' in result).toBe(false);
    expect(result.resourceId).toBe('local:default');
    expect(reasonOf(result)).toMatch(/local-only/);
    expect(reasonOf(result)).toMatch(/nothing on this Station realizes it/);
    expectWellFormed(result);
  });

  test('station#1594: a DECLARED working directory that no longer exists is `missing` — a recorded realization that failed verification — never `unbound`', async () => {
    const harness = createHome();
    const gone = join(tmpdir(), `station-ppi-gone-${randomUUID()}`);
    await saveProject(harness.adapter, {
      slug: 'acme',
      workingDirectory: gone,
    });
    const result = await makeResolver(harness).resolveProjectResource('acme');
    // The whole point of station#1594: this is NOT the same fact as the
    // seeded `default` project above. That one has nothing recorded
    // (`unbound`); this one has a record whose path is gone (`missing`), and
    // the session-cwd seam owes them OPPOSITE behavior (#1023 vs #791).
    expect(result.state).toBe('missing');
    expect(result.state === 'missing' && result.record).toBe(
      'working-directory',
    );
    expect(result.state === 'missing' && result.declaredPath).toBe(gone);
    expect('path' in result).toBe(false);
    expect(reasonOf(result)).toMatch(/does not exist/);
    expect(reasonOf(result)).toMatch(/never silently re-bound/);
    expectWellFormed(result);
  });

  test('station#1594: the declared path is carried VERBATIM, tilde-preserved — the string an operator edits to repair it', async () => {
    const harness = createHome();
    await saveProject(harness.adapter, {
      slug: 'acme',
      workingDirectory: '~/station-ppi-does-not-exist-1594',
    });
    const result = await makeResolver(harness).resolveProjectResource('acme');
    expect(result.state).toBe('missing');
    // NOT the absolutized form. A consumer that needs that already computed
    // it; re-deriving tilde expansion in two places is how two readers come to
    // disagree about what one record says.
    expect(result.state === 'missing' && result.declaredPath).toBe(
      '~/station-ppi-does-not-exist-1594',
    );
    expectWellFormed(result);
  });

  test('a manifest this Station cannot read fails closed rather than downgrading to the legacy path', async () => {
    const harness = createHome();
    const checkout = tempDir('station-ppi-checkout-');
    await saveProject(harness.adapter, {
      slug: 'acme',
      workingDirectory: checkout,
    });
    mkdirSync(join(harness.home, 'projects', 'acme'), { recursive: true });
    writeFileSync(
      projectManifestPath(harness.home, 'acme'),
      JSON.stringify({
        schemaVersion: 99,
        id: 'prj_future',
        repos: [],
        createdAt: 'x',
        updatedAt: 'x',
      }),
    );
    await expect(
      makeResolver(harness).resolveProjectResource('acme'),
    ).rejects.toThrow(ProjectManifestSchemaVersionError);
  });
});

describe('resolveProjectResource — bindings (§3.6)', () => {
  test('a bound checkout whose remotes intersect the manifest resolves bound', async () => {
    const harness = createHome();
    const checkout = tempDir('station-ppi-checkout-');
    await saveProject(harness.adapter, { slug: 'acme' });
    const record = writeManifestRecord(harness.home, 'acme', {
      id: 'prj_acme',
      repos: [gitResource('github.com/kontourai/station', 'primary')],
    });
    await harness.bindings.upsertProjectBinding({
      projectId: record.id,
      resourceId: 'github.com/kontourai/station',
      kind: 'git-checkout',
      path: checkout,
      remotes: ['git@github.com:kontourai/station.git'],
      verifiedAt: Date.now(),
      state: 'bound',
    });

    const result = await makeResolver(
      harness,
      remoteReader(['git@github.com:kontourai/station.git']),
    ).resolveProjectResource('acme');
    expect(result).toEqual({
      state: 'bound',
      resourceId: 'github.com/kontourai/station',
      path: checkout,
    });
    expectWellFormed(result);
  });

  test('a binding whose path is deleted reports missing and NEVER silently re-binds to workingDirectory', async () => {
    const harness = createHome();
    const checkout = tempDir('station-ppi-checkout-');
    const fallback = tempDir('station-ppi-fallback-');
    await saveProject(harness.adapter, {
      slug: 'acme',
      workingDirectory: fallback,
    });
    const record = writeManifestRecord(harness.home, 'acme', {
      id: 'prj_acme',
      repos: [gitResource('github.com/kontourai/station', 'primary')],
    });
    await harness.bindings.upsertProjectBinding({
      projectId: record.id,
      resourceId: 'github.com/kontourai/station',
      kind: 'git-checkout',
      path: checkout,
      remotes: ['git@github.com:kontourai/station.git'],
      verifiedAt: 1_754_000_000_000,
      state: 'bound',
    });
    const resolver = makeResolver(
      harness,
      remoteReader(['git@github.com:kontourai/station.git']),
    );
    expect((await resolver.resolveProjectResource('acme')).state).toBe('bound');

    // The transition: the bound checkout goes away.
    rmSync(checkout, { recursive: true, force: true });
    const result = await resolver.resolveProjectResource('acme');
    expect(result.state).toBe('missing');
    // station#1594: `missing` names WHICH record declared the dead path — a
    // binding row here, the compat `workingDirectory` in the test above. The
    // repair prompt and the surface that owns it differ.
    expect(result.state === 'missing' && result.record).toBe('binding');
    expect(result.state === 'missing' && result.declaredPath).toBe(checkout);
    expect('path' in result).toBe(false);
    expect(reasonOf(result)).toContain(checkout);
    // The project HAS a usable working directory; the resolver must not use it
    // to paper over a broken binding.
    expect(reasonOf(result)).not.toContain(fallback);
    expectWellFormed(result);
  });

  test('a checkout whose remote set no longer intersects the manifest reports drifted', async () => {
    const harness = createHome();
    const checkout = tempDir('station-ppi-checkout-');
    await saveProject(harness.adapter, { slug: 'acme' });
    const record = writeManifestRecord(harness.home, 'acme', {
      id: 'prj_acme',
      repos: [gitResource('github.com/kontourai/station', 'primary')],
    });
    await harness.bindings.upsertProjectBinding({
      projectId: record.id,
      resourceId: 'github.com/kontourai/station',
      kind: 'git-checkout',
      path: checkout,
      remotes: ['git@github.com:kontourai/station.git'],
      verifiedAt: Date.now(),
      state: 'bound',
    });

    const result = await makeResolver(
      harness,
      remoteReader(['git@github.com:someone-else/fork.git']),
    ).resolveProjectResource('acme');
    expect(result.state).toBe('drifted');
    expect(reasonOf(result)).toContain('github.com/someone-else/fork');
    expect(reasonOf(result)).toContain('github.com/kontourai/station');
    expectWellFormed(result);
  });

  test('a manifest alias is honoured; a host alias is NOT applied to the manifest side (§3.3(a))', async () => {
    const harness = createHome();
    const checkout = tempDir('station-ppi-checkout-');
    await saveProject(harness.adapter, { slug: 'acme' });
    mkdirSync(join(harness.home, 'config'), { recursive: true });
    writeFileSync(
      join(harness.home, 'config', 'project-bindings.json'),
      JSON.stringify({
        schemaVersion: 1,
        memberId: 'local',
        hostAliases: { 'github-work': 'github.com' },
        bindings: [],
        credentialBindings: [],
      }),
    );
    const bindings = new ProjectBindingsStore(harness.home);
    const record = writeManifestRecord(harness.home, 'acme', {
      id: 'prj_acme',
      // The manifest's own value literally names the aliased host. The host
      // alias must NOT rewrite it — it is a shared fact, not machine-local.
      repos: [gitResource('github-work/kontourai/station', 'primary')],
    });
    await bindings.upsertProjectBinding({
      projectId: record.id,
      resourceId: 'github-work/kontourai/station',
      kind: 'git-checkout',
      path: checkout,
      remotes: ['git@github.com:kontourai/station.git'],
      verifiedAt: Date.now(),
      state: 'bound',
    });

    const resolver = new ProjectResourceResolver({
      homeDir: harness.home,
      source: harness.adapter,
      bindings,
      readRemotes: remoteReader(['git@github.com:kontourai/station.git']),
    });
    const drifted = await resolver.resolveProjectResource('acme');
    expect(drifted.state).toBe('drifted');
    expect(reasonOf(drifted)).toContain('github-work/kontourai/station');
    expectWellFormed(drifted);

    // The same checkout DOES resolve when the manifest itself declares the
    // equivalence — §3.3(c) aliases are the manifest-side mechanism.
    writeManifestRecord(harness.home, 'acme', {
      id: 'prj_acme',
      repos: [
        {
          ...gitResource('github-work/kontourai/station', 'primary'),
          aliases: ['github.com/kontourai/station'],
        },
      ],
    });
    const bound = await resolver.resolveProjectResource('acme');
    expect(bound.state).toBe('bound');
    expect(pathOf(bound)).toBe(checkout);
  });

  test('a stale verifiedAt does not disqualify a checkout that verifies right now, and the read writes nothing', async () => {
    const harness = createHome();
    const checkout = tempDir('station-ppi-checkout-');
    await saveProject(harness.adapter, { slug: 'acme' });
    const record = writeManifestRecord(harness.home, 'acme', {
      id: 'prj_acme',
      repos: [gitResource('github.com/kontourai/station', 'primary')],
    });
    await harness.bindings.upsertProjectBinding({
      projectId: record.id,
      resourceId: 'github.com/kontourai/station',
      kind: 'git-checkout',
      path: checkout,
      remotes: ['git@github.com:kontourai/station.git'],
      verifiedAt: 1, // 1970 — as stale as an observation gets
      state: 'bound',
    });

    const result = await makeResolver(
      harness,
      remoteReader(['git@github.com:kontourai/station.git']),
    ).resolveProjectResource('acme');
    expect(result.state).toBe('bound');
    // The observation is left exactly as recorded: a read path does not write.
    expect(
      harness.bindings.findBinding(record.id, 'github.com/kontourai/station')
        ?.verifiedAt,
    ).toBe(1);
  });

  test('an unverifiable checkout reports stale, quoting verifiedAt as an observation rather than a guarantee', async () => {
    const harness = createHome();
    const checkout = tempDir('station-ppi-checkout-');
    await saveProject(harness.adapter, { slug: 'acme' });
    const record = writeManifestRecord(harness.home, 'acme', {
      id: 'prj_acme',
      repos: [gitResource('github.com/kontourai/station', 'primary')],
    });
    await harness.bindings.upsertProjectBinding({
      projectId: record.id,
      resourceId: 'github.com/kontourai/station',
      kind: 'git-checkout',
      path: checkout,
      remotes: ['git@github.com:kontourai/station.git'],
      verifiedAt: 1_754_000_000_000,
      state: 'bound',
    });

    const result = await new ProjectResourceResolver({
      homeDir: harness.home,
      source: harness.adapter,
      bindings: harness.bindings,
      readRemotes: async () => ({
        ok: false,
        reason: 'git executable not found',
      }),
    }).resolveProjectResource('acme');

    expect(result.state).toBe('stale');
    expect('path' in result).toBe(false);
    // The binding branch `existsSync`'d the path too, so it is observed here
    // as well — the slot is required on `stale`, not best-effort.
    expect(result.state === 'stale' && result.unverifiedPath).toBe(checkout);
    expect(reasonOf(result)).toContain('git executable not found');
    expect(reasonOf(result)).toContain('2025-07-31T22:13:20.000Z');
    expect(reasonOf(result)).toMatch(/not a guarantee/);
    expectWellFormed(result);
  });

  test('a bound local-only resource resolves for its author', async () => {
    const harness = createHome();
    const dir = tempDir('station-ppi-local-');
    await saveProject(harness.adapter, { slug: 'acme' });
    const record = writeManifestRecord(harness.home, 'acme', {
      id: 'prj_acme',
      repos: [{ kind: 'local-only', id: 'local:scratch' }],
    });
    await harness.bindings.upsertProjectBinding({
      projectId: record.id,
      resourceId: 'local:scratch',
      kind: 'local-directory',
      path: dir,
      remotes: [],
      verifiedAt: Date.now(),
      state: 'bound',
    });

    const result = await makeResolver(harness).resolveProjectResource('acme');
    expect(result).toEqual({
      state: 'bound',
      resourceId: 'local:scratch',
      path: dir,
    });
  });

  test('a binding path stored relative resolves to an ABSOLUTE path', async () => {
    const harness = createHome();
    const dir = tempDir('station-ppi-relative-binding-');
    const relativePath = relative(process.cwd(), dir);
    expect(relativePath.startsWith('/')).toBe(false);
    await saveProject(harness.adapter, { slug: 'acme' });
    const record = writeManifestRecord(harness.home, 'acme', {
      id: 'prj_acme',
      repos: [{ kind: 'local-only', id: 'local:scratch' }],
    });
    await harness.bindings.upsertProjectBinding({
      projectId: record.id,
      resourceId: 'local:scratch',
      kind: 'local-directory',
      // §3.5 stores the path exactly as the user gave it; the resolver is the
      // one place that canonicalizes, and `expandTilde` alone does not.
      path: relativePath,
      remotes: [],
      verifiedAt: Date.now(),
      state: 'bound',
    });

    const result = await makeResolver(harness).resolveProjectResource('acme');
    expect(pathOf(result)).toBe(dir);
  });

  test('a manifest resource with no binding and no working directory is unbound', async () => {
    const harness = createHome();
    await saveProject(harness.adapter, { slug: 'acme' });
    writeManifestRecord(harness.home, 'acme', {
      id: 'prj_acme',
      repos: [gitResource('github.com/kontourai/station', 'primary')],
    });
    const result = await makeResolver(harness).resolveProjectResource('acme');
    expect(result.state).toBe('unbound');
    expect(reasonOf(result)).toMatch(/no binding on this Station/);
    expectWellFormed(result);
  });
});

describe('resolveProjectResource — exact match or an honest unavailable (D4)', () => {
  test('an explicit resourceId the manifest does not name never falls back to the primary', async () => {
    const harness = createHome();
    const checkout = tempDir('station-ppi-checkout-');
    await saveProject(harness.adapter, {
      slug: 'acme',
      workingDirectory: checkout,
    });
    writeManifestRecord(harness.home, 'acme', {
      id: 'prj_acme',
      repos: [gitResource('github.com/kontourai/station', 'primary')],
    });

    const result = await makeResolver(harness).resolveProjectResource(
      'acme',
      'github.com/kontourai/absent',
    );
    // NOT `unresolvable`: nothing was attempted and nothing was denied (§3.6
    // rule 2 — "asserted, never inferred").
    expect(result.state).toBe('unbound');
    expect('path' in result).toBe(false);
    expect(result.resourceId).toBe('github.com/kontourai/absent');
    expect(reasonOf(result)).toContain('github.com/kontourai/absent');
    expect(reasonOf(result)).toContain('github.com/kontourai/station');
    expectWellFormed(result);
  });

  test('an explicit resourceId selects THAT resource, not the primary', async () => {
    const harness = createHome();
    const primaryDir = tempDir('station-ppi-primary-');
    const secondaryDir = tempDir('station-ppi-secondary-');
    await saveProject(harness.adapter, { slug: 'acme' });
    const record = writeManifestRecord(harness.home, 'acme', {
      id: 'prj_acme',
      repos: [
        gitResource('github.com/kontourai/station', 'primary'),
        gitResource('github.com/kontourai/docs', 'secondary'),
      ],
    });
    for (const [resourceId, path] of [
      ['github.com/kontourai/station', primaryDir],
      ['github.com/kontourai/docs', secondaryDir],
    ] as const) {
      await harness.bindings.upsertProjectBinding({
        projectId: record.id,
        resourceId,
        kind: 'git-checkout',
        path,
        remotes: [`git@${resourceId.replace('/', ':')}.git`],
        verifiedAt: Date.now(),
        state: 'bound',
      });
    }

    const resolver = new ProjectResourceResolver({
      homeDir: harness.home,
      source: harness.adapter,
      bindings: harness.bindings,
      readRemotes: async (path) => ({
        ok: true,
        remotes: [
          {
            name: 'origin',
            url:
              path === primaryDir
                ? 'git@github.com:kontourai/station.git'
                : 'git@github.com:kontourai/docs.git',
          },
        ],
      }),
    });

    expect(
      pathOf(
        await resolver.resolveProjectResource(
          'acme',
          'github.com/kontourai/docs',
        ),
      ),
    ).toBe(secondaryDir);
    // …and the no-resourceId call still picks the unique primary.
    expect(pathOf(await resolver.resolveProjectResource('acme'))).toBe(
      primaryDir,
    );
  });

  test('several resources with no unique primary is ambiguity: every candidate is named and nothing is picked', async () => {
    const harness = createHome();
    const checkout = tempDir('station-ppi-checkout-');
    await saveProject(harness.adapter, {
      slug: 'acme',
      workingDirectory: checkout,
    });
    writeManifestRecord(harness.home, 'acme', {
      id: 'prj_acme',
      repos: [
        gitResource('github.com/kontourai/station', 'primary'),
        gitResource('github.com/kontourai/docs', 'primary'),
      ],
    });

    const result = await makeResolver(harness).resolveProjectResource('acme');
    // A configuration problem the operator owns and can fix — reporting it as
    // `unresolvable` would tell them "you do not have access" instead.
    expect(result.state).toBe('ambiguous');
    expect('path' in result).toBe(false);
    expect(reasonOf(result)).toContain('github.com/kontourai/station');
    expect(reasonOf(result)).toContain('github.com/kontourai/docs');
    expectWellFormed(result);
  });

  test('several resources and NO primary at all is equally ambiguous — never repos[0]', async () => {
    const harness = createHome();
    const checkout = tempDir('station-ppi-checkout-');
    await saveProject(harness.adapter, {
      slug: 'acme',
      workingDirectory: checkout,
    });
    writeManifestRecord(harness.home, 'acme', {
      id: 'prj_acme',
      repos: [
        gitResource('github.com/kontourai/station'),
        gitResource('github.com/kontourai/docs'),
      ],
    });

    const result = await makeResolver(harness).resolveProjectResource('acme');
    expect(result.state).toBe('ambiguous');
    expect('path' in result).toBe(false);
    expect(reasonOf(result)).toContain('github.com/kontourai/station');
    expect(reasonOf(result)).toContain('github.com/kontourai/docs');
    expectWellFormed(result);
  });

  test('a single resource is the primary whether or not it says so', async () => {
    const harness = createHome();
    const checkout = tempDir('station-ppi-checkout-');
    await saveProject(harness.adapter, {
      slug: 'acme',
      workingDirectory: checkout,
    });
    writeManifestRecord(harness.home, 'acme', {
      id: 'prj_acme',
      repos: [gitResource('github.com/kontourai/station')],
    });
    const result = await makeResolver(
      harness,
      remoteReader(['git@github.com:kontourai/station.git']),
    ).resolveProjectResource('acme');
    expect(result.state).toBe('bound');
    expect(pathOf(result)).toBe(checkout);
  });

  test('a manifest that names no resources is ambiguous rather than an empty success', async () => {
    const harness = createHome();
    const checkout = tempDir('station-ppi-checkout-');
    await saveProject(harness.adapter, {
      slug: 'acme',
      workingDirectory: checkout,
    });
    writeManifestRecord(harness.home, 'acme', { id: 'prj_acme', repos: [] });

    const result = await makeResolver(harness).resolveProjectResource('acme');
    expect(result.state).toBe('ambiguous');
    expect(reasonOf(result)).toMatch(/names no resources/);
    expectWellFormed(result);
  });

  test('a sole resource that declared itself secondary is ambiguous — this resolver does not overrule the document', async () => {
    // §3.5: a single-resource manifest's sole resource IS its primary — unless
    // it said otherwise. Treating a resource that declared itself non-primary
    // as the primary is the contradiction slice 1's validator refuses to let a
    // manifest express; a manifest read off disk can still express it.
    const harness = createHome();
    const checkout = tempDir('station-ppi-checkout-');
    await saveProject(harness.adapter, {
      slug: 'acme',
      workingDirectory: checkout,
    });
    writeManifestRecord(harness.home, 'acme', {
      id: 'prj_acme',
      repos: [gitResource('github.com/kontourai/station', 'secondary')],
    });

    const result = await makeResolver(harness).resolveProjectResource('acme');
    expect(result.state).toBe('ambiguous');
    expect('path' in result).toBe(false);
    expect(reasonOf(result)).toContain('github.com/kontourai/station');
    expect(reasonOf(result)).toContain('secondary');
    expectWellFormed(result);
    // …and it is still reachable by name: ambiguity is about the OMITTED
    // resourceId, never about the resource being unusable.
    const named = await makeResolver(
      harness,
      remoteReader(['git@github.com:kontourai/station.git']),
    ).resolveProjectResource('acme', 'github.com/kontourai/station');
    expect(named.state).toBe('bound');
  });

  test('a local-only PRIMARY is selected over a git secondary — `role` is not git-only', async () => {
    // The resolver filtered `kind === 'git'` when counting primaries while
    // slice 1's validator counts `role` across both kinds, so this manifest
    // validated and then resolved `ambiguous`. §3.5 puts `role` on local-only
    // resources precisely so a manifest like this can name its primary.
    const harness = createHome();
    const checkout = tempDir('station-ppi-checkout-');
    await saveProject(harness.adapter, {
      slug: 'acme',
      workingDirectory: checkout,
    });
    writeManifestRecord(harness.home, 'acme', {
      id: 'prj_acme',
      repos: [
        { kind: 'local-only', id: 'local:notes', role: 'primary' },
        gitResource('github.com/kontourai/station', 'secondary'),
      ],
    });

    const result = await makeResolver(harness).resolveProjectResource('acme');
    expect(result).toEqual({
      state: 'bound',
      resourceId: 'local:notes',
      path: checkout,
    });
  });

  test('a manifest that is MALFORMED rather than merely unselectable still fails closed', async () => {
    // The other half of the split: unreadable stays a throw. Answering
    // `ambiguous` here would report a document this Station cannot trust as an
    // ordinary configuration problem.
    const harness = createHome();
    const checkout = tempDir('station-ppi-checkout-');
    await saveProject(harness.adapter, {
      slug: 'acme',
      workingDirectory: checkout,
    });
    writeManifestRecord(harness.home, 'acme', {
      id: 'prj_acme',
      repos: [
        {
          kind: 'git',
          // §9 OQ-1: a git resource's id IS its canonicalRemote.
          id: 'github.com/kontourai/station',
          canonicalRemote: 'github.com/kontourai/docs',
          role: 'primary',
        },
      ],
    });

    await expect(
      makeResolver(harness).resolveProjectResource('acme'),
    ).rejects.toThrow(ProjectManifestUnreadableError);
  });

  test('an explicit resourceId is never answered from the working directory while no manifest exists', async () => {
    const harness = createHome();
    const checkout = tempDir('station-ppi-checkout-');
    await saveProject(harness.adapter, {
      slug: 'acme',
      workingDirectory: checkout,
    });
    const resolver = new ProjectResourceResolver({
      homeDir: harness.home,
      source: harness.adapter,
      bindings: harness.bindings,
      readRemotes: async () => ({
        ok: false,
        reason: 'git executable not found',
      }),
    });

    const result = await resolver.resolveProjectResource(
      'acme',
      'github.com/kontourai/station',
    );
    expect(result.state).toBe('unbound');
    expect('path' in result).toBe(false);
    expect(reasonOf(result)).toContain('github.com/kontourai/station');
    expectWellFormed(result);
  });

  test('no state this module can produce is `unresolvable` or `not-portable` — neither is ever inferred', async () => {
    // §3.6: `unresolvable` is attempted-and-denied and "is asserted, never
    // inferred"; `not-portable` is a local-only resource authored by SOMEONE
    // ELSE. This slice performs no authenticated operation and reads no
    // foreign manifest, so it can honestly emit neither. This test exists so
    // that reintroducing either as an inference is a failing test, not a
    // silent regression.
    const harness = createHome();
    const gone = join(tmpdir(), `station-ppi-gone-${randomUUID()}`);
    const checkout = tempDir('station-ppi-checkout-');
    await saveProject(harness.adapter, { slug: 'no-manifest' });
    await saveProject(harness.adapter, { slug: 'no-dir' });
    await saveProject(harness.adapter, {
      slug: 'absent-dir',
      workingDirectory: gone,
    });
    await saveProject(harness.adapter, {
      slug: 'ambiguous',
      workingDirectory: checkout,
    });
    writeManifestRecord(harness.home, 'no-dir', {
      id: 'prj_no_dir',
      repos: [{ kind: 'local-only', id: 'local:no-dir' }],
    });
    writeManifestRecord(harness.home, 'absent-dir', {
      id: 'prj_absent',
      repos: [gitResource('github.com/kontourai/station', 'primary')],
    });
    writeManifestRecord(harness.home, 'ambiguous', {
      id: 'prj_ambiguous',
      repos: [
        gitResource('github.com/kontourai/station', 'primary'),
        gitResource('github.com/kontourai/docs', 'primary'),
      ],
    });

    const resolver = makeResolver(harness);
    const states = await Promise.all(
      [
        resolver.resolveProjectResource('no-manifest'),
        resolver.resolveProjectResource('no-manifest', 'github.com/x/y'),
        resolver.resolveProjectResource('no-dir'),
        resolver.resolveProjectResource('absent-dir'),
        resolver.resolveProjectResource('absent-dir', 'github.com/x/y'),
        resolver.resolveProjectResource('ambiguous'),
      ].map((pending) => pending.then((result) => result.state)),
    );
    expect(states).not.toContain('unresolvable');
    expect(states).not.toContain('not-portable');
  });
});

describe('resolveProjectResource — the working-directory fallback is identity-CHECKED (§3.6)', () => {
  async function gitManifestProject(
    harness: Harness,
    workingDirectory: string,
  ) {
    await saveProject(harness.adapter, { slug: 'acme', workingDirectory });
    return writeManifestRecord(harness.home, 'acme', {
      id: 'prj_acme',
      repos: [gitResource('github.com/kontourai/station', 'primary')],
    });
  }

  test('a workingDirectory pointing at a DIFFERENT repository is drifted, never bound', async () => {
    const harness = createHome();
    const otherRepo = tempDir('station-ppi-other-repo-');
    await gitManifestProject(harness, otherRepo);

    // No binding exists — which is the only live shape in this slice, because
    // nothing writes bindings yet. Returning `bound` here would name the
    // manifest's resource while handing back a checkout of another repo.
    const result = await makeResolver(
      harness,
      remoteReader(['git@github.com:someone-else/fork.git']),
    ).resolveProjectResource('acme');
    expect(result.state).toBe('drifted');
    // station#1594: `path` — the ANSWER slot — stays `bound`-only. The
    // directory the resolver DID observe is reported in the separately named
    // observation slot, so a caller asking the weaker directory-question can
    // use it and a caller asking the repo-question structurally cannot.
    expect('path' in result).toBe(false);
    expect(result.state === 'drifted' && result.unverifiedPath).toBe(otherRepo);
    expect(reasonOf(result)).toContain('github.com/someone-else/fork');
    expect(reasonOf(result)).toContain('github.com/kontourai/station');
    expect(reasonOf(result)).toContain('working directory');
    expectWellFormed(result);
  });

  test('a workingDirectory whose remotes DO intersect the manifest is bound', async () => {
    const harness = createHome();
    const checkout = tempDir('station-ppi-checkout-');
    await gitManifestProject(harness, checkout);

    const result = await makeResolver(
      harness,
      remoteReader(['git@github.com:kontourai/station.git']),
    ).resolveProjectResource('acme');
    expect(result).toEqual({
      state: 'bound',
      resourceId: 'github.com/kontourai/station',
      path: checkout,
    });
  });

  test('an unverifiable workingDirectory is stale, and says it has NEVER been verified rather than quoting a timestamp it does not have', async () => {
    const harness = createHome();
    const checkout = tempDir('station-ppi-checkout-');
    await gitManifestProject(harness, checkout);

    const result = await new ProjectResourceResolver({
      homeDir: harness.home,
      source: harness.adapter,
      bindings: harness.bindings,
      readRemotes: async () => ({ ok: false, reason: 'git refused' }),
    }).resolveProjectResource('acme');
    expect(result.state).toBe('stale');
    expect('path' in result).toBe(false);
    // station#1594: existence was checked and PASSED before the git check ran.
    // Withholding the directory here is what 404'd every `.flow`-reading route
    // on a host with no `git` (the slice-3b S2 revert).
    expect(result.state === 'stale' && result.unverifiedPath).toBe(checkout);
    expectWellFormed(result);
    expect(reasonOf(result)).toContain('git refused');
    expect(reasonOf(result)).toMatch(/NEVER been verified/);
    expect(reasonOf(result)).not.toMatch(/1970|last observed/);
    expectWellFormed(result);
  });

  test('a local-only resource still resolves through the working directory with no git check', async () => {
    const harness = createHome();
    const dir = tempDir('station-ppi-local-');
    await saveProject(harness.adapter, { slug: 'acme', workingDirectory: dir });
    writeManifestRecord(harness.home, 'acme', {
      id: 'prj_acme',
      repos: [{ kind: 'local-only', id: 'local:acme' }],
    });

    const result = await new ProjectResourceResolver({
      homeDir: harness.home,
      source: harness.adapter,
      bindings: harness.bindings,
      readRemotes: async () => {
        throw new Error('a local-only resource must not be git-checked');
      },
    }).resolveProjectResource('acme');
    expect(result).toEqual({
      state: 'bound',
      resourceId: 'local:acme',
      path: dir,
    });
  });

  test('"advertises no remotes" and "its remotes canonicalize to nothing" are different sentences', async () => {
    const harness = createHome();
    const checkout = tempDir('station-ppi-checkout-');
    await gitManifestProject(harness, checkout);

    const noRemotes = await makeResolver(harness, async () => ({
      ok: true,
      remotes: [],
    })).resolveProjectResource('acme');
    expect(noRemotes.state).toBe('drifted');
    expect(reasonOf(noRemotes)).toContain('advertises no remotes');

    const emptyCanonical = await makeResolver(harness, async () => ({
      ok: true,
      remotes: [{ name: 'origin', url: '   ' }],
    })).resolveProjectResource('acme');
    expect(emptyCanonical.state).toBe('drifted');
    expect(reasonOf(emptyCanonical)).not.toContain('advertises no remotes');
    expect(reasonOf(emptyCanonical)).toContain('canonicalize to nothing');
    expect(reasonOf(emptyCanonical)).toContain('origin');
  });
});

function createRestartHarness(home: string): Harness {
  return {
    home,
    adapter: new FileStorageAdapter(home),
    bindings: new ProjectBindingsStore(home),
  };
}

// ── station#1503 slice 5 — multi-repo ──────────────────────────────────────

describe('resolveProjectResource — multi-repo (station#1503, §10 slice 5)', () => {
  test('resolves a NAMED SECONDARY repo through its own binding, not the primary’s', async () => {
    const harness = createHome();
    const apiCheckout = tempDir('station-ppi-multi-api-');
    const webCheckout = tempDir('station-ppi-multi-web-');
    await saveProject(harness.adapter, {
      slug: 'acme',
      workingDirectory: apiCheckout,
    });
    writeManifestRecord(harness.home, 'acme', {
      id: 'prj_multi',
      repos: [
        gitResource('github.com/acme/api', 'primary'),
        gitResource('github.com/acme/web', 'secondary'),
      ],
    });
    await harness.bindings.upsertProjectBinding({
      projectId: 'prj_multi',
      resourceId: 'github.com/acme/web',
      kind: 'git-checkout',
      path: webCheckout,
      remotes: ['git@github.com:acme/web.git'],
      verifiedAt: Date.UTC(2026, 0, 1),
      state: 'bound',
    });
    // One reader for both checkouts: the remote it reports depends on WHICH
    // directory it is asked about, which is the whole point of the assertion.
    const readRemotes: CheckoutRemoteReader = async (path) => ({
      ok: true,
      remotes: [
        {
          name: 'origin',
          url:
            path === webCheckout
              ? 'git@github.com:acme/web.git'
              : 'git@github.com:acme/api.git',
        },
      ],
    });
    const resolver = makeResolver(harness, readRemotes);

    const web = await resolver.resolveProjectResource(
      'acme',
      'github.com/acme/web',
    );
    const api = await resolver.resolveProjectResource(
      'acme',
      'github.com/acme/api',
    );

    expect(pathOf(web)).toBe(webCheckout);
    expect(pathOf(api)).toBe(apiCheckout);
    expectWellFormed(web);
    expectWellFormed(api);
  });

  test('an UNBOUND secondary is `unbound`, never the project directory’s repo', async () => {
    // THE SLICE-5 DEFECT THIS CLOSES: the compat fallback handed the project's
    // single working directory to every unbound resource, so a secondary repo
    // was verified against the PRIMARY's checkout and came back `drifted` — "a
    // different repository is at that path" — sending the operator to repair a
    // directory that was doing exactly what it should.
    const harness = createHome();
    const apiCheckout = tempDir('station-ppi-multi-only-api-');
    await saveProject(harness.adapter, {
      slug: 'acme',
      workingDirectory: apiCheckout,
    });
    writeManifestRecord(harness.home, 'acme', {
      id: 'prj_multi',
      repos: [
        gitResource('github.com/acme/api', 'primary'),
        gitResource('github.com/acme/web', 'secondary'),
      ],
    });
    const resolver = makeResolver(
      harness,
      remoteReader(['git@github.com:acme/api.git']),
    );

    const web = await resolver.resolveProjectResource(
      'acme',
      'github.com/acme/web',
    );

    expect(web.state).toBe('unbound');
    expect(reasonOf(web)).toContain('2 resources');
    expect(reasonOf(web)).toContain('github.com/acme/api');
    // No path of any kind: nothing here records a location for THIS resource.
    expect('path' in web).toBe(false);
    expect('unverifiedPath' in web).toBe(false);
    expectWellFormed(web);

    // ...and the primary still inherits it, so the compat behaviour a
    // single-repo project depends on is unchanged for the resource it belongs
    // to.
    const api = await resolver.resolveProjectResource(
      'acme',
      'github.com/acme/api',
    );
    expect(pathOf(api)).toBe(apiCheckout);
  });

  test('a SINGLE-resource manifest keeps the compat fallback verbatim', async () => {
    // The negative control for the branch above: one declared resource, no
    // binding, and the working directory still stands in for it.
    const harness = createHome();
    const checkout = tempDir('station-ppi-single-');
    await saveProject(harness.adapter, {
      slug: 'acme',
      workingDirectory: checkout,
    });
    writeManifestRecord(harness.home, 'acme', {
      id: 'prj_single',
      repos: [gitResource('github.com/acme/api', 'primary')],
    });
    const resolver = makeResolver(
      harness,
      remoteReader(['git@github.com:acme/api.git']),
    );

    const result = await resolver.resolveProjectResource('acme');

    expect(pathOf(result)).toBe(checkout);
  });

  test('with NO unique primary, NO resource inherits the working directory', async () => {
    // Fail-closed in the only direction available: picking one would be the
    // coin flip presented as fact that decision 2 refuses.
    const harness = createHome();
    const checkout = tempDir('station-ppi-multi-nop-');
    await saveProject(harness.adapter, {
      slug: 'acme',
      workingDirectory: checkout,
    });
    writeManifestRecord(harness.home, 'acme', {
      id: 'prj_no_primary',
      repos: [
        gitResource('github.com/acme/api'),
        gitResource('github.com/acme/web'),
      ],
    });
    const resolver = makeResolver(
      harness,
      remoteReader(['git@github.com:acme/api.git']),
    );

    for (const id of ['github.com/acme/api', 'github.com/acme/web']) {
      const result = await resolver.resolveProjectResource('acme', id);
      expect(result.state).toBe('unbound');
      expect(reasonOf(result)).toContain(
        'no single resource is declared primary',
      );
      expectWellFormed(result);
    }
  });

  test('a PARTIALLY BOUND project reports 2 bound and 1 unbound', async () => {
    const harness = createHome();
    const apiCheckout = tempDir('station-ppi-partial-api-');
    const webCheckout = tempDir('station-ppi-partial-web-');
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
    const readRemotes: CheckoutRemoteReader = async (path) => ({
      ok: true,
      remotes: [
        {
          name: 'origin',
          url:
            path === apiCheckout
              ? 'git@github.com:acme/api.git'
              : 'git@github.com:acme/web.git',
        },
      ],
    });
    const resolver = makeResolver(harness, readRemotes);

    const states = [];
    for (const id of [
      'github.com/acme/api',
      'github.com/acme/web',
      'github.com/acme/docs',
    ]) {
      states.push((await resolver.resolveProjectResource('acme', id)).state);
    }

    expect(states).toEqual(['bound', 'bound', 'unbound']);
  });
});

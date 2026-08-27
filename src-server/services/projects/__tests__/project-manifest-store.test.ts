import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { ProjectConfig } from '@kontourai/station-contracts/project';
import { afterEach, describe, expect, test, vi } from 'vitest';

// The backfill counter is asserted below (an adopted record that CONTRADICTS
// the derivation is a different event from one that agrees), so it is replaced
// while every other instrument stays real.
const backfillCounter = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock('../../../telemetry/metrics.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../telemetry/metrics.js')>()),
  projectManifestBackfills: backfillCounter,
}));

import { putProject } from '../../../domain/__tests__/file-storage-test-helpers.js';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import { execGitSync } from '../../../utils/git-exec.js';
import type { CheckoutRemoteReader } from '../checkout-remote-reader.js';
import { ProjectBindingsStore } from '../project-binding-store.js';
import {
  ProjectManifestIncompleteError,
  ProjectManifestSchemaVersionError,
  ProjectManifestStore,
  ProjectManifestUnreadableError,
  projectManifestPath,
} from '../project-manifest-store.js';

const tmpRoots: string[] = [];

afterEach(() => {
  backfillCounter.add.mockClear();
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

function createHome(): { home: string; adapter: FileStorageAdapter } {
  const home = tempDir('station-ppi-manifest-home-');
  return { home, adapter: new FileStorageAdapter(home) };
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

function remoteReader(
  remotes: Array<{ name: string; url: string }>,
): CheckoutRemoteReader {
  return async () => ({ ok: true, remotes });
}

describe('ProjectManifestStore — the sidecar record (D1: no second copy)', () => {
  test('a project with no manifest reads as undefined (the compat state)', async () => {
    const { home, adapter } = createHome();
    await saveProject(adapter, { slug: 'acme' });
    const store = new ProjectManifestStore(home, adapter);
    expect(store.readRecord('acme')).toBeUndefined();
    expect(store.readProjectManifest('acme')).toBeUndefined();
  });

  test('an unknown schemaVersion is refused by name, never cast (§2.5)', async () => {
    const { home, adapter } = createHome();
    await saveProject(adapter, { slug: 'acme' });
    writeFileSync(
      projectManifestPath(home, 'acme'),
      JSON.stringify({
        schemaVersion: 2,
        id: 'prj_future',
        repos: [],
        createdAt: 'now',
        updatedAt: 'now',
      }),
    );
    const store = new ProjectManifestStore(home, adapter);
    expect(() => store.readRecord('acme')).toThrow(
      ProjectManifestSchemaVersionError,
    );
    expect(() => store.readRecord('acme')).toThrow(/expected 1, got 2/);
    // Crucially NOT treated as "no manifest": a future-version sidecar must
    // never downgrade the project to the legacy path.
    expect(() => store.readProjectManifest('acme')).toThrow(
      ProjectManifestSchemaVersionError,
    );
  });

  test('a ZERO-LENGTH sidecar is named as an interrupted write, distinctly from malformed content', async () => {
    const { home, adapter } = createHome();
    await saveProject(adapter, { slug: 'acme' });
    // The exact shape a torn `open(O_CREAT|O_EXCL) → write → close` leaves
    // behind if the process dies between the create and the write.
    writeFileSync(projectManifestPath(home, 'acme'), '');
    const store = new ProjectManifestStore(home, adapter);
    expect(() => store.readRecord('acme')).toThrow(
      ProjectManifestIncompleteError,
    );
    expect(() => store.readRecord('acme')).toThrow(/zero-length/);
    // …and it is still an unreadable manifest, so decision 6 of the resolver
    // (fail closed, never downgrade to the legacy path) is unchanged.
    expect(() => store.readRecord('acme')).toThrow(
      ProjectManifestUnreadableError,
    );
  });

  test('a corrupt sidecar throws rather than reading as absent', async () => {
    const { home, adapter } = createHome();
    await saveProject(adapter, { slug: 'acme' });
    writeFileSync(projectManifestPath(home, 'acme'), '{ not json');
    const store = new ProjectManifestStore(home, adapter);
    expect(() => store.readRecord('acme')).toThrow(
      ProjectManifestUnreadableError,
    );
  });

  test('the sidecar persists ONLY id/repos/timestamps — no name, slug, or agents', async () => {
    const { home, adapter } = createHome();
    const project = await saveProject(adapter, {
      slug: 'acme',
      name: 'Acme Rockets',
      description: 'a distinctive description',
      agents: ['reviewer' as never],
    });
    const store = new ProjectManifestStore(home, adapter);
    await store.ensureProjectManifest(project);

    const raw = readFileSync(projectManifestPath(home, 'acme'), 'utf-8');
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual([
      'createdAt',
      'id',
      'repos',
      'schemaVersion',
      'updatedAt',
    ]);
    expect(raw).not.toContain('Acme Rockets');
    expect(raw).not.toContain('a distinctive description');
    expect(raw).not.toContain('reviewer');
  });

  test('rename → re-read → rename back: the composed manifest follows project.json with NO sidecar write', async () => {
    const { home, adapter } = createHome();
    const project = await saveProject(adapter, { slug: 'acme', name: 'Acme' });
    const store = new ProjectManifestStore(home, adapter);
    await store.ensureProjectManifest(project);

    const sidecar = projectManifestPath(home, 'acme');
    const bytesAtStart = readFileSync(sidecar, 'utf-8');
    expect(store.readProjectManifest('acme')?.name).toBe('Acme');

    await putProject(adapter, { ...project, name: 'Acme Renamed' });
    expect(store.readProjectManifest('acme')?.name).toBe('Acme Renamed');
    expect(readFileSync(sidecar, 'utf-8')).toBe(bytesAtStart);

    // …and back again: the transition is reversible because nothing about the
    // name was ever persisted here.
    await putProject(adapter, { ...project, name: 'Acme' });
    expect(store.readProjectManifest('acme')?.name).toBe('Acme');
    expect(readFileSync(sidecar, 'utf-8')).toBe(bytesAtStart);

    // A fresh store over the same home behaves identically — a read-path
    // property, not in-memory state.
    const restarted = new ProjectManifestStore(
      home,
      new FileStorageAdapter(home),
    );
    await putProject(adapter, { ...project, name: 'Acme Renamed Again' });
    expect(restarted.readProjectManifest('acme')?.name).toBe(
      'Acme Renamed Again',
    );
    expect(readFileSync(sidecar, 'utf-8')).toBe(bytesAtStart);
  });

  test('the composed manifest joins live knowledge namespaces and layout ids', async () => {
    const { home, adapter } = createHome();
    const project = await saveProject(adapter, {
      slug: 'acme',
      knowledgeNamespaces: [
        { id: 'default', label: 'Default', behavior: 'rag' },
      ] as never,
    });
    await adapter.createLayout('acme', {
      id: 'layout-1',
      slug: 'coding',
      projectSlug: 'acme',
      type: 'coding',
      name: 'Coding',
      config: {},
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as never);
    const store = new ProjectManifestStore(home, adapter);
    await store.ensureProjectManifest(project);

    const manifest = store.readProjectManifest('acme');
    expect(manifest?.knowledge).toEqual([
      { namespaceId: 'default', root: { kind: 'station-managed' } },
    ]);
    expect(manifest?.layouts).toEqual(['layout-1']);
    // Disclosed gap: Station has no per-project integration list to source.
    expect(manifest?.integrations).toEqual([]);
  });

  // ── station#1503 slice 5 ────────────────────────────────────────────────

  test('a namespace anchored to a NAMED repo composes as §3.2’s repo root', async () => {
    // Before this slice EVERY namespace composed as `station-managed`
    // unconditionally, so the repo-rooted arm of `ProjectKnowledgeRef` was a
    // documented shape with no writer.
    const { home, adapter } = createHome();
    const checkout = tempDir('station-ppi-know-checkout-');
    const project = await saveProject(adapter, {
      slug: 'acme',
      workingDirectory: checkout,
      knowledgeNamespaces: [
        { id: 'default', label: 'Default', behavior: 'rag' },
        {
          id: 'api-docs',
          label: 'API docs',
          behavior: 'rag',
          repoRoot: { repoId: 'github.com/kontourai/station', path: 'docs' },
        },
      ] as never,
    });
    const store = new ProjectManifestStore(home, adapter, {
      readRemotes: remoteReader([
        { name: 'origin', url: 'git@github.com:kontourai/station.git' },
      ]),
    });
    await store.ensureProjectManifest(project);

    expect(store.readProjectManifest('acme')?.knowledge).toEqual([
      { namespaceId: 'default', root: { kind: 'station-managed' } },
      {
        namespaceId: 'api-docs',
        root: {
          kind: 'repo',
          repoId: 'github.com/kontourai/station',
          path: 'docs',
        },
      },
    ]);
  });

  test('a repo anchor naming an UNDECLARED repo makes the manifest UNREADABLE, not silently station-managed', async () => {
    // The deliberate severity, asserted rather than discovered: the two
    // alternatives are dropping the namespace (a silent omission) and
    // composing it as `station-managed` (a claim that the operator's anchor is
    // not there), and both hide a misconfiguration in the layer meant to
    // surface it. The reason names the field and the bad id.
    const { home, adapter } = createHome();
    const checkout = tempDir('station-ppi-know-bad-');
    const project = await saveProject(adapter, {
      slug: 'acme',
      workingDirectory: checkout,
      knowledgeNamespaces: [
        {
          id: 'api-docs',
          label: 'API docs',
          behavior: 'rag',
          repoRoot: { repoId: 'github.com/acme/ghost', path: 'docs' },
        },
      ] as never,
    });
    const store = new ProjectManifestStore(home, adapter, {
      readRemotes: remoteReader([
        { name: 'origin', url: 'git@github.com:kontourai/station.git' },
      ]),
    });
    await store.ensureProjectManifest(project);

    expect(() => store.readProjectManifest('acme')).toThrow(
      /github.com\/acme\/ghost/,
    );
  });
});

describe('ProjectManifestStore — backfill derivation (§5)', () => {
  test('derives the canonicalized origin as a primary git resource', async () => {
    const { home, adapter } = createHome();
    const checkout = tempDir('station-ppi-checkout-');
    const project = await saveProject(adapter, {
      slug: 'acme',
      workingDirectory: checkout,
    });
    const store = new ProjectManifestStore(home, adapter, {
      readRemotes: remoteReader([
        { name: 'origin', url: 'git@github.com:KontourAI/Station.git' },
        { name: 'fork', url: 'https://github.com/brian/station.git' },
      ]),
    });

    const result = await store.ensureProjectManifest(project);
    expect(result.outcome).toBe('created');
    expect(result.outcome !== 'unavailable' && result.record.repos).toEqual([
      {
        kind: 'git',
        id: 'github.com/kontourai/station',
        canonicalRemote: 'github.com/kontourai/station',
        role: 'primary',
      },
    ]);
  });

  test('host aliases rewrite the CHECKOUT side before canonicalization (§3.3(a))', async () => {
    const { home, adapter } = createHome();
    const checkout = tempDir('station-ppi-checkout-');
    const project = await saveProject(adapter, {
      slug: 'acme',
      workingDirectory: checkout,
    });
    mkdirSync(join(home, 'config'), { recursive: true });
    writeFileSync(
      join(home, 'config', 'project-bindings.json'),
      JSON.stringify({
        schemaVersion: 1,
        memberId: 'local',
        hostAliases: { 'github-work': 'github.com' },
        bindings: [],
        credentialBindings: [],
      }),
    );
    const store = new ProjectManifestStore(home, adapter, {
      bindings: new ProjectBindingsStore(home),
      readRemotes: remoteReader([
        { name: 'origin', url: 'git@github-work:kontourai/station.git' },
      ]),
    });

    const result = await store.ensureProjectManifest(project);
    expect(result.outcome !== 'unavailable' && result.record.repos[0]).toEqual({
      kind: 'git',
      id: 'github.com/kontourai/station',
      canonicalRemote: 'github.com/kontourai/station',
      role: 'primary',
    });
  });

  test('a project with no working directory backfills a local-only resource (the seeded `default`)', async () => {
    const { home, adapter } = createHome();
    const project = await saveProject(adapter, {
      slug: 'default',
      name: 'Default',
    });
    const store = new ProjectManifestStore(home, adapter);

    const result = await store.ensureProjectManifest(project);
    expect(result.outcome).toBe('created');
    expect(result.outcome !== 'unavailable' && result.record.repos).toEqual([
      { kind: 'local-only', id: 'local:default' },
    ]);
  });

  test('a working directory that does not exist backfills local-only', async () => {
    const { home, adapter } = createHome();
    const project = await saveProject(adapter, {
      slug: 'acme',
      workingDirectory: join(tmpdir(), `station-ppi-absent-${randomUUID()}`),
    });
    const store = new ProjectManifestStore(home, adapter);
    const result = await store.ensureProjectManifest(project);
    expect(
      result.outcome !== 'unavailable' && result.record.repos[0].kind,
    ).toBe('local-only');
  });

  test('an unverifiable checkout writes NOTHING rather than recording local-only', async () => {
    const { home, adapter } = createHome();
    const checkout = tempDir('station-ppi-checkout-');
    const project = await saveProject(adapter, {
      slug: 'acme',
      workingDirectory: checkout,
    });
    const store = new ProjectManifestStore(home, adapter, {
      readRemotes: async () => ({
        ok: false,
        reason: 'git executable not found',
      }),
    });

    const result = await store.ensureProjectManifest(project);
    expect(result.outcome).toBe('unavailable');
    expect(result.outcome === 'unavailable' && result.reason).toContain(
      'git executable not found',
    );
    expect(existsSync(projectManifestPath(home, 'acme'))).toBe(false);
  });

  test('several remotes and no `origin` is unavailable, naming every candidate — never a coin flip', async () => {
    const { home, adapter } = createHome();
    const checkout = tempDir('station-ppi-checkout-');
    const project = await saveProject(adapter, {
      slug: 'acme',
      workingDirectory: checkout,
    });
    const store = new ProjectManifestStore(home, adapter, {
      readRemotes: remoteReader([
        { name: 'upstream', url: 'git@github.com:kontourai/station.git' },
        { name: 'mirror', url: 'git@git.internal:kontourai/station.git' },
      ]),
    });

    const result = await store.ensureProjectManifest(project);
    expect(result.outcome).toBe('unavailable');
    expect(result.outcome === 'unavailable' && result.reason).toContain(
      'upstream, mirror',
    );
    expect(existsSync(projectManifestPath(home, 'acme'))).toBe(false);
  });

  test('a single remote that is not named origin is unambiguous and is used', async () => {
    const { home, adapter } = createHome();
    const checkout = tempDir('station-ppi-checkout-');
    const project = await saveProject(adapter, {
      slug: 'acme',
      workingDirectory: checkout,
    });
    const store = new ProjectManifestStore(home, adapter, {
      readRemotes: remoteReader([
        { name: 'upstream', url: 'git@github.com:kontourai/station.git' },
      ]),
    });
    const result = await store.ensureProjectManifest(project);
    expect(result.outcome !== 'unavailable' && result.record.repos[0].id).toBe(
      'github.com/kontourai/station',
    );
  });

  test.each([
    ['an absolute local path', '/var/folders/zz/t/ppi-mirror-gpwob2'],
    ['a file:// URL', 'file:///var/folders/zz/t/ppi-mirror-gpwob2'],
    ['a tilde path', '~/mirrors/station'],
    ['a relative dot path', '../sibling-mirror'],
    ['a same-dir dot path', './mirror'],
    ['a Windows drive path', 'C:\\mirrors\\station'],
    ['a UNC path', '\\\\fileserver\\mirrors\\station'],
    ['a localhost URL', 'http://localhost:9418/mirrors/station'],
    ['a loopback URL', 'git://127.0.0.1/mirrors/station'],
  ])(
    'a path-shaped origin (%s) backfills LOCAL-ONLY — never an absolute path as the portable id',
    async (_label, originUrl) => {
      const { home, adapter } = createHome();
      const checkout = tempDir('station-ppi-checkout-');
      const project = await saveProject(adapter, {
        slug: 'acme',
        workingDirectory: checkout,
      });
      const store = new ProjectManifestStore(home, adapter, {
        readRemotes: remoteReader([{ name: 'origin', url: originUrl }]),
      });

      const result = await store.ensureProjectManifest(project);
      // §3.2: "no absolute or tilde-prefixed paths, anywhere", and `id` is
      // "portable and opaque … not derived from any repo, path, or machine".
      expect(result.outcome !== 'unavailable' && result.record.repos).toEqual([
        { kind: 'local-only', id: 'local:acme' },
      ]);
      const raw = readFileSync(projectManifestPath(home, 'acme'), 'utf-8');
      expect(raw).not.toContain('mirror');
      expect(raw).not.toContain('localhost');
      expect(raw).not.toContain('127.0.0.1');
    },
  );

  test('a REAL `git clone <local mirror>` backfills local-only, and the manifest it writes reads back', async () => {
    const { home, adapter } = createHome();
    const mirror = tempDir('station-ppi-mirror-');
    execGitSync(['init', '-q', '--bare'], { cwd: mirror });
    const parent = tempDir('station-ppi-clone-parent-');
    execGitSync(['clone', '-q', mirror, 'work'], { cwd: parent });
    const checkout = join(parent, 'work');
    const project = await saveProject(adapter, {
      slug: 'acme',
      workingDirectory: checkout,
    });

    // The DEFAULT reader — this is the ordinary local-mirror clone workflow,
    // whose `origin` really is a filesystem path.
    const store = new ProjectManifestStore(home, adapter);
    const result = await store.ensureProjectManifest(project);
    expect(result.outcome !== 'unavailable' && result.record.repos).toEqual([
      { kind: 'local-only', id: 'local:acme' },
    ]);
    expect(
      readFileSync(projectManifestPath(home, 'acme'), 'utf-8'),
    ).not.toContain(mirror.toLowerCase());
    // Slice 1's validator refuses a path-shaped `git` resource, so writing one
    // would produce a manifest this very store could not read back.
    expect(store.readProjectManifest('acme')?.repos).toEqual([
      { kind: 'local-only', id: 'local:acme' },
    ]);
  });

  test('a relative workingDirectory is ABSOLUTIZED before git ever sees it', async () => {
    const { home, adapter } = createHome();
    const checkout = tempDir('station-ppi-relative-');
    const relativePath = relative(process.cwd(), checkout);
    expect(relativePath.startsWith('/')).toBe(false);
    const project = await saveProject(adapter, {
      slug: 'acme',
      workingDirectory: relativePath,
    });
    const seen: string[] = [];
    const store = new ProjectManifestStore(home, adapter, {
      readRemotes: async (path) => {
        seen.push(path);
        return {
          ok: true,
          remotes: [
            { name: 'origin', url: 'git@github.com:kontourai/station.git' },
          ],
        };
      },
    });

    await store.ensureProjectManifest(project);
    // Otherwise `execGit({ cwd })` runs against the SERVER PROCESS's cwd.
    expect(seen).toEqual([checkout]);
  });

  test('the DEFAULT reader derives from a real git checkout (no injected fake)', async () => {
    const { home, adapter } = createHome();
    const checkout = tempDir('station-ppi-real-repo-');
    execGitSync(['init', '-q'], { cwd: checkout });
    execGitSync(
      ['remote', 'add', 'origin', 'git@github.com:kontourai/station.git'],
      { cwd: checkout },
    );
    const project = await saveProject(adapter, {
      slug: 'acme',
      workingDirectory: checkout,
    });

    const store = new ProjectManifestStore(home, adapter);
    const result = await store.ensureProjectManifest(project);
    expect(result.outcome !== 'unavailable' && result.record.repos).toEqual([
      {
        kind: 'git',
        id: 'github.com/kontourai/station',
        canonicalRemote: 'github.com/kontourai/station',
        role: 'primary',
      },
    ]);
  });
});

describe('ProjectManifestStore — backfill is an exclusive create (D2)', () => {
  test('a second ensure is a no-op that rewrites nothing', async () => {
    const { home, adapter } = createHome();
    const project = await saveProject(adapter, { slug: 'acme' });
    const store = new ProjectManifestStore(home, adapter);

    const first = await store.ensureProjectManifest(project);
    const bytes = readFileSync(projectManifestPath(home, 'acme'), 'utf-8');
    const second = await store.ensureProjectManifest(project);

    expect(second.outcome).toBe('existing');
    expect(first.outcome !== 'unavailable' && first.record.id).toBe(
      second.outcome !== 'unavailable' && second.record.id,
    );
    expect(readFileSync(projectManifestPath(home, 'acme'), 'utf-8')).toBe(
      bytes,
    );
  });

  /**
   * The competing writer lands DURING derivation — i.e. after this store
   * observed "no manifest" and before it writes its own.
   */
  function racingStore(
    home: string,
    adapter: FileStorageAdapter,
    winner: unknown,
  ): ProjectManifestStore {
    return new ProjectManifestStore(home, adapter, {
      readRemotes: async () => {
        mkdirSync(join(home, 'projects', 'acme'), { recursive: true });
        writeFileSync(
          projectManifestPath(home, 'acme'),
          JSON.stringify(winner, null, 2),
        );
        return {
          ok: true,
          remotes: [
            { name: 'origin', url: 'git@github.com:kontourai/station.git' },
          ],
        };
      },
    });
  }

  test('the EEXIST loser ADOPTS the winner and never clobbers its portable id — and says so when the winner CONTRADICTS what it derived', async () => {
    const { home, adapter } = createHome();
    const checkout = tempDir('station-ppi-checkout-');
    const project = await saveProject(adapter, {
      slug: 'acme',
      workingDirectory: checkout,
    });
    const sidecar = projectManifestPath(home, 'acme');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // The winner recorded local-only; this store derived a real git origin.
    // Adopting silently would present two contradictory observations of the
    // same project as one uneventful success.
    const result = await racingStore(home, adapter, {
      schemaVersion: 1,
      id: 'prj_winner',
      repos: [{ kind: 'local-only', id: 'local:acme' }],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }).ensureProjectManifest(project);

    expect(result.outcome).toBe('adopted-existing');
    expect(result.outcome !== 'unavailable' && result.record.id).toBe(
      'prj_winner',
    );
    expect(JSON.parse(readFileSync(sidecar, 'utf-8')).id).toBe('prj_winner');

    expect(backfillCounter.add).toHaveBeenCalledWith(1, {
      outcome: 'adopted-existing',
      adopted: 'divergent',
    });
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain('local-only local:acme');
    expect(message).toContain('github.com/kontourai/station');
    warn.mockRestore();
  });

  test('adopting a winner that AGREES with the derivation is silent, and the metric says which it was', async () => {
    const { home, adapter } = createHome();
    const checkout = tempDir('station-ppi-checkout-');
    const project = await saveProject(adapter, {
      slug: 'acme',
      workingDirectory: checkout,
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await racingStore(home, adapter, {
      schemaVersion: 1,
      id: 'prj_winner',
      repos: [
        {
          kind: 'git',
          id: 'github.com/kontourai/station',
          canonicalRemote: 'github.com/kontourai/station',
          role: 'primary',
        },
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }).ensureProjectManifest(project);

    expect(result.outcome).toBe('adopted-existing');
    expect(backfillCounter.add).toHaveBeenCalledWith(1, {
      outcome: 'adopted-existing',
      adopted: 'identical',
    });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// station#1499 slice 2 — UNREADABLE vs UNSELECTABLE on the read path (D7).
//
// `composeManifest` runs slice 1's validator on every read, and slice 1
// enforces §3.5's primary cardinality there. A manifest with two primaries is
// not unreadable — every field parses — it simply cannot name ONE resource,
// which is the `ambiguous` resolution §3.6 exists for. Throwing there turns an
// honest unavailable into an exception the caller cannot answer. Everything
// else still fails closed.
// ---------------------------------------------------------------------------

describe('ProjectManifestStore — a readable manifest is not always a selectable one', () => {
  function writeRecord(home: string, slug: string, repos: unknown[]): void {
    mkdirSync(join(home, 'projects', slug), { recursive: true });
    writeFileSync(
      projectManifestPath(home, slug),
      JSON.stringify({
        schemaVersion: 1,
        id: 'prj_acme',
        repos,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
  }

  const gitResource = (
    canonicalRemote: string,
    role?: 'primary' | 'secondary',
  ) => ({
    kind: 'git',
    id: canonicalRemote,
    canonicalRemote,
    ...(role ? { role } : {}),
  });

  test.each([
    [
      'two resources declaring role "primary"',
      [
        gitResource('github.com/kontourai/station', 'primary'),
        gitResource('github.com/kontourai/docs', 'primary'),
      ],
    ],
    [
      'several resources and no primary at all',
      [
        gitResource('github.com/kontourai/station'),
        gitResource('github.com/kontourai/docs'),
      ],
    ],
    [
      'a sole resource that declared itself secondary',
      [gitResource('github.com/kontourai/station', 'secondary')],
    ],
  ])(
    "%s reads back — selection is the resolver's answer, not this reader's failure",
    async (_label, repos) => {
      const { home, adapter } = createHome();
      await saveProject(adapter, { slug: 'acme' });
      writeRecord(home, 'acme', repos);
      const store = new ProjectManifestStore(home, adapter);
      expect(store.readProjectManifest('acme')?.repos).toEqual(repos);
    },
  );

  test('a MALFORMED resource still fails closed — unselectable is not the same as unreadable', async () => {
    const { home, adapter } = createHome();
    await saveProject(adapter, { slug: 'acme' });
    // §9 OQ-1: a git resource's id IS its canonicalRemote. This document is
    // untrustworthy, not merely unselectable.
    writeRecord(home, 'acme', [
      {
        kind: 'git',
        id: 'github.com/kontourai/station',
        canonicalRemote: 'github.com/kontourai/docs',
        role: 'primary',
      },
    ]);
    const store = new ProjectManifestStore(home, adapter);
    expect(() => store.readProjectManifest('acme')).toThrow(
      ProjectManifestUnreadableError,
    );
    expect(() => store.readProjectManifest('acme')).toThrow(
      /must equal canonicalRemote/,
    );
  });

  test('a cardinality failure ALONGSIDE a malformed resource fails closed', async () => {
    // The mixed case: reading on here would mean reading a document already
    // known to be untrustworthy, because one of its problems happened to be
    // benign.
    const { home, adapter } = createHome();
    await saveProject(adapter, { slug: 'acme' });
    writeRecord(home, 'acme', [
      gitResource('github.com/kontourai/station', 'primary'),
      {
        kind: 'git',
        id: 'github.com/kontourai/docs',
        canonicalRemote: '~/dev/mirror/docs',
        role: 'primary',
      },
    ]);
    const store = new ProjectManifestStore(home, adapter);
    expect(() => store.readProjectManifest('acme')).toThrow(
      ProjectManifestUnreadableError,
    );
  });
});

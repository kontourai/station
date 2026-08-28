import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectConfig } from '@kontourai/station-contracts/project';
import { afterEach, describe, expect, test } from 'vitest';
import { putProject } from '../../../domain/__tests__/file-storage-test-helpers.js';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import type { CheckoutRemoteReader } from '../../projects/checkout-remote-reader.js';
import { ProjectBindingsStore } from '../../projects/project-binding-store.js';
import {
  applyKnowledgeScanPatterns,
  normalizeKnowledgeExtension,
  resolveKnowledgeScanPath,
} from '../knowledge-scan-utils.js';

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

/** The real call shape: no namespace `storageDir`, so the project directory. */
function scanPath(
  adapter: FileStorageAdapter,
  slug: string,
  home: string,
): Promise<string | null> {
  return resolveKnowledgeScanPath(slug, 'code', adapter, () => undefined, {
    resolverOptions: { homeDir: home },
  });
}

describe('knowledge-scan-utils', () => {
  test('normalizeKnowledgeExtension preserves dotted extensions and prefixes bare ones', () => {
    expect(normalizeKnowledgeExtension('md')).toBe('.md');
    expect(normalizeKnowledgeExtension('.ts')).toBe('.ts');
  });

  test('applyKnowledgeScanPatterns applies include and exclude globs', () => {
    expect(
      applyKnowledgeScanPatterns(
        ['/repo/src/a.ts', '/repo/src/b.ts', '/repo/docs/readme.md'],
        '/repo',
        ['src/**'],
        ['**/b.ts'],
      ),
    ).toEqual(['/repo/src/a.ts']);
  });

  test('preserves ?, negation, globstar root matches, and Unicode filenames', () => {
    expect(
      applyKnowledgeScanPatterns(
        ['/repo/a.ts', '/repo/ab.ts', '/repo/dir/a.ts', '/repo/emoji-😀.ts'],
        '/repo',
        ['?.ts'],
      ),
    ).toEqual(['/repo/a.ts']);

    expect(
      applyKnowledgeScanPatterns(
        ['/repo/a.ts', '/repo/dir/a.ts', '/repo/emoji-😀.ts'],
        '/repo',
        ['**/*.ts', 'emoji-?.ts'],
      ),
    ).toEqual(['/repo/a.ts', '/repo/dir/a.ts', '/repo/emoji-😀.ts']);

    expect(
      applyKnowledgeScanPatterns(
        ['/repo/a.ts', '/repo/ab.ts', '/repo/dir/a.ts', '/repo/emoji-😀.ts'],
        '/repo',
        ['!**/*.test.ts'],
      ),
    ).toEqual([
      '/repo/a.ts',
      '/repo/ab.ts',
      '/repo/dir/a.ts',
      '/repo/emoji-😀.ts',
    ]);
    expect(
      applyKnowledgeScanPatterns(['/repo/a.test.ts', '/repo/a.ts'], '/repo', [
        '!**/*.test.ts',
      ]),
    ).toEqual(['/repo/a.ts']);
  });

  test('matches **/ only at complete directory boundaries', () => {
    expect(
      applyKnowledgeScanPatterns(
        ['/repo/a.ts', '/repo/x/a.ts', '/repo/x/y/a.ts', '/repo/fooa.ts'],
        '/repo',
        ['**/a.ts'],
      ),
    ).toEqual(['/repo/a.ts', '/repo/x/a.ts', '/repo/x/y/a.ts']);
  });

  test('matches a valid glob longer than 512 code points', () => {
    const directory = 'a'.repeat(600);
    expect(
      applyKnowledgeScanPatterns([`/repo/${directory}/target.ts`], '/repo', [
        `${directory}/target.ts`,
      ]),
    ).toEqual([`/repo/${directory}/target.ts`]);
  });

  test('resolveKnowledgeScanPath prefers namespace storageDir/files when present', async () => {
    expect(
      await resolveKnowledgeScanPath(
        'proj',
        'code',
        {
          getProject: () => ({ workingDirectory: '/workspace' }),
        } as any,
        () => ({
          id: 'code',
          label: 'Code',
          behavior: 'rag',
          storageDir: '/tmp/ns',
        }),
      ),
    ).toBe('/tmp/ns');
  });
});

/**
 * archive#1501, seam S3
 * (`docs/design/portable-project-identity.md` §2.2.1).
 */
describe('resolveKnowledgeScanPath — migrated onto resolveProjectResource', () => {
  test('the namespace storageDir STILL WINS, and short-circuits before any project resolution', async () => {
    const home = tempDir('station-1501-ks-home-');
    const adapter = new FileStorageAdapter(home);
    const storageDir = tempDir('station-1501-ks-ns-');
    const workspace = tempDir('station-1501-ks-ws-');
    await saveProject(adapter, { slug: 'acme', workingDirectory: workspace });

    expect(
      await resolveKnowledgeScanPath(
        'acme',
        'code',
        adapter,
        () => ({
          id: 'code',
          label: 'Code',
          behavior: 'rag',
          storageDir,
        }),
        { resolverOptions: { homeDir: home } },
      ),
    ).toBe(storageDir);

    // …and it wins even for a project that does not exist at all, proving the
    // precedence is a short-circuit and not a fallback ordering.
    expect(
      await resolveKnowledgeScanPath(
        'no-such-project',
        'code',
        adapter,
        () => ({ id: 'code', label: 'Code', behavior: 'rag', storageDir }),
        { resolverOptions: { homeDir: home } },
      ),
    ).toBe(storageDir);
  });

  test('BEHAVIOR DELTA: a tilde-stored working directory is now EXPANDED, so its knowledge is scannable at last', async () => {
    const home = tempDir('station-1501-ks-tilde-');
    const adapter = new FileStorageAdapter(home);
    await saveProject(adapter, { slug: 'acme', workingDirectory: '~' });

    // Before this slice the last line was `return project.workingDirectory ??
    // null`, so this asserted the literal string `'~'` and every caller's
    // `existsSync('~')` then failed — the scan silently indexed nothing.
    expect(await scanPath(adapter, 'acme', home)).toBe(homedir());
  });

  test('a working directory that does not exist yields null rather than an unusable string', async () => {
    const home = tempDir('station-1501-ks-gone-');
    const adapter = new FileStorageAdapter(home);
    await saveProject(adapter, {
      slug: 'acme',
      workingDirectory: '/definitely/not/here/station-1501',
    });
    expect(await scanPath(adapter, 'acme', home)).toBe(null);
  });

  /**
   * archive#1501 review, L3. The migration pins the resolver's
   * project source to the `storageAdapter` this function was HANDED, because
   * an unpinned resolver constructs its own `FileStorageAdapter` over the
   * ambient home and would answer from a different project store than the
   * caller's — a second source of truth about where a project lives, which is
   * the defect class the seam migration exists to remove.
   *
   * The guard is only provable when the two disagree, so this test makes them
   * disagree: one slug, two homes, two different working directories.
   */
  test('the project source is PINNED to the caller’s storage adapter, not to the resolver’s ambient home', async () => {
    const callerHome = tempDir('station-1501-ks-pin-caller-');
    const ambientHome = tempDir('station-1501-ks-pin-ambient-');
    const callerAdapter = new FileStorageAdapter(callerHome);
    const ambientAdapter = new FileStorageAdapter(ambientHome);
    const callerWorkspace = tempDir('station-1501-ks-pin-a-');
    const ambientWorkspace = tempDir('station-1501-ks-pin-b-');
    await saveProject(callerAdapter, {
      slug: 'acme',
      workingDirectory: callerWorkspace,
    });
    await saveProject(ambientAdapter, {
      slug: 'acme',
      workingDirectory: ambientWorkspace,
    });

    const resolved = await resolveKnowledgeScanPath(
      'acme',
      'code',
      callerAdapter,
      () => undefined,
      // Manifest/binding stores live under the ambient home; the PROJECT
      // record must still come from `callerAdapter`.
      { resolverOptions: { homeDir: ambientHome } },
    );

    expect(resolved).toBe(callerWorkspace);
    expect(resolved).not.toBe(ambientWorkspace);
  });

  test('an unknown project still THROWS — a missing project must never render as an empty scan', async () => {
    const home = tempDir('station-1501-ks-unknown-');
    const adapter = new FileStorageAdapter(home);
    await expect(scanPath(adapter, 'nope', home)).rejects.toThrow(/not found/);
  });

  test('A → B → A: the project gains a working directory, loses it, and regains it', async () => {
    const home = tempDir('station-1501-ks-aba-');
    const adapter = new FileStorageAdapter(home);
    const dirA = tempDir('station-1501-ks-a-');
    const dirB = tempDir('station-1501-ks-b-');
    const project = await saveProject(adapter, { slug: 'acme' });

    expect(await scanPath(adapter, 'acme', home)).toBe(null);

    await putProject(adapter, { ...project, workingDirectory: dirA });
    expect(await scanPath(adapter, 'acme', home)).toBe(dirA);

    await putProject(adapter, { ...project, workingDirectory: dirB });
    expect(await scanPath(adapter, 'acme', home)).toBe(dirB);

    await putProject(adapter, { ...project, workingDirectory: undefined });
    expect(await scanPath(adapter, 'acme', home)).toBe(null);

    await putProject(adapter, { ...project, workingDirectory: dirA });
    expect(await scanPath(adapter, 'acme', home)).toBe(dirA);
  });

  test('the DIRECTORY itself is deleted and recreated', async () => {
    const home = tempDir('station-1501-ks-dir-');
    const adapter = new FileStorageAdapter(home);
    const workspace = tempDir('station-1501-ks-dir-ws-');
    await saveProject(adapter, { slug: 'acme', workingDirectory: workspace });

    expect(await scanPath(adapter, 'acme', home)).toBe(workspace);
    rmSync(workspace, { recursive: true, force: true });
    expect(await scanPath(adapter, 'acme', home)).toBe(null);
    mkdirSync(workspace, { recursive: true });
    expect(await scanPath(adapter, 'acme', home)).toBe(workspace);
  });

  test('restart-after-write: a store rebuilt from disk answers identically', async () => {
    const home = tempDir('station-1501-ks-restart-');
    const workspace = tempDir('station-1501-ks-restart-ws-');
    await saveProject(new FileStorageAdapter(home), {
      slug: 'acme',
      workingDirectory: workspace,
    });
    expect(await scanPath(new FileStorageAdapter(home), 'acme', home)).toBe(
      workspace,
    );
    // A completely fresh object graph over the same home: nothing may be
    // answered from memory.
    expect(await scanPath(new FileStorageAdapter(home), 'acme', home)).toBe(
      workspace,
    );
  });

  test('upgrade path: a project with project.json and NO manifest sidecar scans, and the read writes nothing under its home', async () => {
    const home = tempDir('station-1501-ks-upgrade-');
    const adapter = new FileStorageAdapter(home);
    const workspace = tempDir('station-1501-ks-upgrade-ws-');
    await saveProject(adapter, { slug: 'acme', workingDirectory: workspace });

    const before = listHome(home);
    expect(await scanPath(adapter, 'acme', home)).toBe(workspace);
    expect(listHome(home)).toEqual(before);
  });
});

/** Every path under `home`, sorted — a write of any kind changes this. */
function listHome(home: string): string[] {
  const walk = (dir: string, prefix: string): string[] => {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      return entry.isDirectory()
        ? [rel, ...walk(join(dir, entry.name), rel)]
        : [rel];
    });
  };
  return walk(home, '').sort();
}

// ── archive#1503 — knowledge roots reference repos by id ───────────

describe('resolveKnowledgeScanPath — a namespace anchored to a NAMED repo', () => {
  interface RepoHarness {
    home: string;
    adapter: FileStorageAdapter;
    apiCheckout: string;
    webCheckout: string;
  }

  /**
   * A two-repo project with BOTH repos bound to different checkouts, and a
   * `workingDirectory` pointing at the API one. That last part is what makes
   * the assertions load-bearing: a scanner that fell back to "the project's
   * directory" would silently index the API repo for a namespace that names
   * the WEB one, and the test would still find files.
   */
  async function createRepoHarness(): Promise<RepoHarness> {
    const home = tempDir('station-know-repo-home-');
    const adapter = new FileStorageAdapter(home);
    const apiCheckout = tempDir('station-know-api-');
    const webCheckout = tempDir('station-know-web-');
    await saveProject(adapter, { slug: 'acme', workingDirectory: apiCheckout });
    mkdirSync(join(home, 'projects', 'acme'), { recursive: true });
    writeFileSync(
      join(home, 'projects', 'acme', 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'prj_multi',
        repos: [
          {
            kind: 'git',
            id: 'github.com/acme/api',
            canonicalRemote: 'github.com/acme/api',
            role: 'primary',
          },
          {
            kind: 'git',
            id: 'github.com/acme/web',
            canonicalRemote: 'github.com/acme/web',
            role: 'secondary',
          },
        ],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    const bindings = new ProjectBindingsStore(home);
    for (const [resourceId, path, url] of [
      ['github.com/acme/api', apiCheckout, 'git@github.com:acme/api.git'],
      ['github.com/acme/web', webCheckout, 'git@github.com:acme/web.git'],
    ] as const) {
      await bindings.upsertProjectBinding({
        projectId: 'prj_multi',
        resourceId,
        kind: 'git-checkout',
        path,
        remotes: [url],
        verifiedAt: Date.UTC(2026, 0, 1),
        state: 'bound',
      });
    }
    return { home, adapter, apiCheckout, webCheckout };
  }

  function repoAwareRemotes(harness: RepoHarness): CheckoutRemoteReader {
    return async (path) => ({
      ok: true,
      remotes: [
        {
          name: 'origin',
          url:
            path === harness.webCheckout
              ? 'git@github.com:acme/web.git'
              : 'git@github.com:acme/api.git',
        },
      ],
    });
  }

  function scanRepoRooted(
    harness: RepoHarness,
    repoRoot: { repoId: string; path: string } | undefined,
  ): Promise<string | null> {
    return resolveKnowledgeScanPath(
      'acme',
      'code',
      harness.adapter,
      () => ({
        id: 'code',
        label: 'Code',
        behavior: 'rag',
        ...(repoRoot ? { repoRoot } : {}),
      }),
      {
        resolverOptions: {
          homeDir: harness.home,
          source: harness.adapter,
          readRemotes: repoAwareRemotes(harness),
        },
      },
    );
  }

  test('scans the NAMED repo’s checkout, not the project’s working directory', async () => {
    const harness = await createRepoHarness();

    const resolved = await scanRepoRooted(harness, {
      repoId: 'github.com/acme/web',
      path: 'docs',
    });

    expect(resolved).toBe(join(harness.webCheckout, 'docs'));
    // The negative half: the project directory (the API checkout) is NOT what
    // a namespace naming the web repo resolves to.
    expect(resolved).not.toContain(harness.apiCheckout);
  });

  test('`.` names the repo root itself', async () => {
    const harness = await createRepoHarness();

    expect(
      await scanRepoRooted(harness, {
        repoId: 'github.com/acme/web',
        path: '.',
      }),
    ).toBe(harness.webCheckout);
  });

  test('a namespace with NO repoRoot still resolves the project directory', async () => {
    // The negative control: nothing about the existing behaviour changed for a
    // namespace that names no repo.
    const harness = await createRepoHarness();

    expect(await scanRepoRooted(harness, undefined)).toBe(harness.apiCheckout);
  });

  test('a repo that does NOT resolve scans NOTHING, never the project directory', async () => {
    const harness = await createRepoHarness();

    // `github.com/acme/docs` is not declared by this manifest at all, so the
    // resolver answers `unbound` for it (never the primary). Falling back to
    // the project directory here is precisely the silent wrong-repo index this
    // slice exists to remove.
    expect(
      await scanRepoRooted(harness, {
        repoId: 'github.com/acme/docs',
        path: 'docs',
      }),
    ).toBeNull();
  });

  test.each([
    ['an absolute path', '/etc'],
    ['a tilde path', '~/secrets'],
    ['a parent escape', '../../etc'],
    ['a nested parent escape', 'docs/../../etc'],
    ['a windows separator escape', 'docs\\..\\..\\etc'],
    ['an empty path', ''],
  ])('REFUSES %s rather than joining it onto a checkout', async (_l, path) => {
    const harness = await createRepoHarness();

    await expect(
      scanRepoRooted(harness, { repoId: 'github.com/acme/web', path }),
    ).rejects.toThrow(/not a repo-relative path/);
  });

  test('an explicit storageDir still WINS over a repo anchor', async () => {
    // `storageDir` is a deliberate operator choice about where documents live
    // and is not a project resource at all — slice 3b's precedence, unchanged.
    const harness = await createRepoHarness();
    const storageDir = tempDir('station-know-storage-');

    const resolved = await resolveKnowledgeScanPath(
      'acme',
      'code',
      harness.adapter,
      () => ({
        id: 'code',
        label: 'Code',
        behavior: 'rag',
        storageDir,
        repoRoot: { repoId: 'github.com/acme/web', path: 'docs' },
      }),
      { resolverOptions: { homeDir: harness.home, source: harness.adapter } },
    );

    expect(resolved).toBe(storageDir);
  });
});

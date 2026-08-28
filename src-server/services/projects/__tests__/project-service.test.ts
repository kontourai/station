import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

const backfillCounter = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock('../../../telemetry/metrics.js', () => ({
  projectOps: { add: vi.fn() },
  projectManifestBackfills: backfillCounter,
}));
vi.mock('@kontourai/station-contracts/knowledge', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@kontourai/station-contracts/knowledge')
    >();
  return {
    ...actual,
    BUILTIN_KNOWLEDGE_NAMESPACES: [
      { id: 'default', label: 'Default', behavior: 'rag' },
    ],
  };
});

const { ProjectService } = await import('../project-service.js');
const { FileStorageAdapter, compareProjectListOrder } = await import(
  '../../../domain/file-storage-adapter.js'
);
const { ProjectManifestStore, projectManifestPath } = await import(
  '../project-manifest-store.js'
);
const { execGitSync } = await import('../../../utils/git-exec.js');
const { raceWorktreeDirectoryCheck } = await import('../project-service.js');

function createMockStorageAdapter() {
  const projects = new Map<string, any>();
  const adapter = {
    listProjects: vi.fn(() =>
      [...projects.values()].map((p) => ({ slug: p.slug, name: p.name })),
    ),
    getProject: vi.fn((slug: string) => {
      const p = projects.get(slug);
      if (!p) throw new Error(`Project '${slug}' not found`);
      return p;
    }),
    createProject: vi.fn(async (p: any) => {
      projects.set(p.slug || p.id, p);
    }),
    projectRevision: vi.fn((slug: string) => {
      const value = adapter.getProject(slug);
      return {
        value,
        replace: vi.fn(async (next: any) => {
          projects.set(slug, next);
        }),
        remove: vi.fn(async () => {
          projects.delete(slug);
        }),
      };
    }),
    deleteProject: vi.fn((slug: string) => {
      projects.delete(slug);
    }),
  };
  return adapter;
}

const tmpHomes: string[] = [];

afterEach(() => {
  while (tmpHomes.length > 0) {
    const dir = tmpHomes.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('ProjectService', () => {
  test('createProject generates id and timestamps', async () => {
    const adapter = createMockStorageAdapter();
    const svc = new ProjectService(adapter as any);
    const result = await svc.createProject({
      name: 'Test',
      slug: 'test',
    } as any);
    expect(result.id).toBeDefined();
    expect(result.createdAt).toBeDefined();
    expect(result.updatedAt).toBeDefined();
    expect(result.name).toBe('Test');
  });

  test('createProject derives name from workingDirectory', async () => {
    const adapter = createMockStorageAdapter();
    const svc = new ProjectService(adapter as any);
    const result = await svc.createProject({
      name: 'Untitled',
      slug: 'my-app',
      workingDirectory: '/home/user/my-app',
    } as any);
    expect(result.name).toBe('My-app');
  });

  test('refuses worktree isolation for a directory that is not a Git work tree', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'station-project-nonrepo-'));
    tmpHomes.push(directory);
    const adapter = createMockStorageAdapter();
    const svc = new ProjectService(adapter as any);

    await expect(
      svc.createProject({
        name: 'Nonrepo',
        slug: 'nonrepo',
        workingDirectory: directory,
        defaultWorkspaceIsolation: 'worktree',
      } as any),
    ).rejects.toMatchObject({
      code: 'project_worktree_directory_invalid',
      message: expect.stringContaining(directory),
    });
    expect(adapter.createProject).not.toHaveBeenCalled();
  });

  test('a stalled directory probe produces a bounded unreachable refusal, not a hang', async () => {
    // A dead network mount cannot be simulated portably; the deadline race is
    // the mechanism that bounds it, so it is proven directly with a probe
    // that never settles.
    const never = new Promise<void>(() => undefined);
    await expect(
      raceWorktreeDirectoryCheck(never, 'stalled', '/mnt/dead', 25),
    ).rejects.toMatchObject({
      code: 'project_worktree_directory_invalid',
      message: expect.stringContaining('did not respond'),
    });
  });

  test('the deadline race returns the probe result when it settles in time', async () => {
    await expect(
      raceWorktreeDirectoryCheck(Promise.resolve('ok'), 'fast', '/tmp', 1_000),
    ).resolves.toBe('ok');
  });

  test('accepts worktree isolation for a real Git work tree', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'station-project-repo-'));
    tmpHomes.push(directory);
    execGitSync(['init'], { cwd: directory, stdio: 'pipe' });
    const svc = new ProjectService(createMockStorageAdapter() as any);

    await expect(
      svc.createProject({
        name: 'Repo',
        slug: 'repo',
        workingDirectory: directory,
        defaultWorkspaceIsolation: 'worktree',
      } as any),
    ).resolves.toMatchObject({ slug: 'repo' });
  });

  test('createProject derives a slug from name when slug is omitted (#597)', async () => {
    const adapter = createMockStorageAdapter();
    const svc = new ProjectService(adapter as any);
    const result = await svc.createProject({
      name: 'My Cool Project!',
    } as any);
    expect(result.slug).toBe('my-cool-project');
    expect(adapter.createProject).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'my-cool-project' }),
    );
  });

  test('createProject de-dupes a derived slug against existing projects (#597)', async () => {
    const adapter = createMockStorageAdapter();
    const svc = new ProjectService(adapter as any);
    await svc.createProject({ name: 'Acme', slug: 'acme' } as any);
    const result = await svc.createProject({ name: 'Acme' } as any);
    expect(result.slug).toBe('acme-2');
  });

  test('createProject treats a blank slug the same as an omitted slug (#597)', async () => {
    const adapter = createMockStorageAdapter();
    const svc = new ProjectService(adapter as any);
    const result = await svc.createProject({
      name: 'Blank Slug',
      slug: '   ',
    } as any);
    expect(result.slug).toBe('blank-slug');
  });

  test('listProjects delegates', () => {
    const adapter = createMockStorageAdapter();
    const svc = new ProjectService(adapter as any);
    svc.listProjects();
    expect(adapter.listProjects).toHaveBeenCalled();
  });

  test('deleteProject delegates', () => {
    const adapter = createMockStorageAdapter();
    const svc = new ProjectService(adapter as any);
    svc.deleteProject('test');
    expect(adapter.deleteProject).toHaveBeenCalledWith('test');
  });

  // archive#1499: a new project is never in the legacy shape, so the
  // `workingDirectory`-only path shrinks monotonically instead of persisting as
  // a permanent second mode (portable-project-identity.md §5).
  test('createProject writes a manifest sidecar when a manifest store is wired', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-ppi-create-'));
    tmpHomes.push(home);
    const adapter = new FileStorageAdapter(home);
    const svc = new ProjectService(
      adapter,
      new ProjectManifestStore(home, adapter, {
        readRemotes: async () => ({
          ok: true,
          remotes: [
            { name: 'origin', url: 'git@github.com:kontourai/station.git' },
          ],
        }),
      }),
    );

    const project = await svc.createProject({
      name: 'Acme',
      slug: 'acme',
      workingDirectory: home,
    } as any);

    const sidecar = projectManifestPath(home, project.slug);
    expect(existsSync(sidecar)).toBe(true);
    const record = JSON.parse(readFileSync(sidecar, 'utf-8'));
    expect(record.schemaVersion).toBe(1);
    expect(record.id).toMatch(/^prj_/);
    // NOT the local project id: the manifest's id is the portable join key.
    expect(record.id).not.toContain(project.id);
    expect(record.repos).toEqual([
      {
        kind: 'git',
        id: 'github.com/kontourai/station',
        canonicalRemote: 'github.com/kontourai/station',
        role: 'primary',
      },
    ]);
  });

  test('a manifest backfill that THROWS does not fail the creation it followed', async () => {
    // Proven reachable: one corrupt `<home>/config/project-bindings.json` is
    // read through `hostAliases()` for every git-backed project (the binding
    // store throws on corruption, correctly — a silently empty read there would
    // turn every bound resource into `unbound`). An unreadable sidecar, EACCES,
    // ENOSPC, or a read-only home do the same. The project route's catch turns
    // any of them into a 400 for a project that WAS created.
    const adapter = createMockStorageAdapter();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const svc = new ProjectService(
      adapter as any,
      {
        ensureProjectManifest: vi.fn(async () => {
          throw new Error(
            'JSON store is corrupt: /home/config/project-bindings.json',
          );
        }),
      } as any,
    );

    await expect(
      svc.createProject({ name: 'Acme', slug: 'acme' } as any),
    ).resolves.toMatchObject({ slug: 'acme' });
    // The absence of a manifest is the defined compat state (§5 point 1), so
    // nothing was lost — but it is recorded rather than swallowed.
    expect(backfillCounter.add).toHaveBeenCalledWith(1, { outcome: 'failed' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('acme');
    warn.mockRestore();
  });

  test('createProject still succeeds with no manifest store wired', async () => {
    const adapter = createMockStorageAdapter();
    const svc = new ProjectService(adapter as any);
    await expect(
      svc.createProject({ name: 'No Manifest', slug: 'no-manifest' } as any),
    ).resolves.toMatchObject({ slug: 'no-manifest' });
  });

  test('updateProject merges and updates timestamp', async () => {
    const adapter = createMockStorageAdapter();
    adapter.getProject.mockReturnValue({
      id: 'project-test',
      slug: 'test',
      name: 'Old',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    });
    const svc = new ProjectService(adapter as any);
    const result = await svc.updateProject('test', { name: 'New' });
    expect(result.name).toBe('New');
    expect(result.updatedAt).toBeDefined();
    const revision = adapter.projectRevision.mock.results[0]?.value;
    expect(revision.replace).toHaveBeenCalled();
  });

  test('persists a project default workspace isolation through updates', async () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'station-project-update-repo-'),
    );
    tmpHomes.push(directory);
    execGitSync(['init'], { cwd: directory, stdio: 'pipe' });
    const adapter = createMockStorageAdapter();
    adapter.getProject.mockReturnValue({
      id: 'project-test',
      slug: 'test',
      name: 'Test',
      workingDirectory: directory,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    });
    const svc = new ProjectService(adapter as any);
    await svc.updateProject('test', { defaultWorkspaceIsolation: 'worktree' });

    const revision = adapter.projectRevision.mock.results[0]?.value;
    expect(revision.replace).toHaveBeenCalledWith(
      expect.objectContaining({ defaultWorkspaceIsolation: 'worktree' }),
    );
  });

  test('refuses an update that enables worktree isolation for a non-repository directory', async () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'station-project-update-nonrepo-'),
    );
    tmpHomes.push(directory);
    const adapter = createMockStorageAdapter();
    adapter.getProject.mockReturnValue({
      id: 'project-test',
      slug: 'test',
      name: 'Test',
      workingDirectory: directory,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    });
    const svc = new ProjectService(adapter as any);

    await expect(
      svc.updateProject('test', { defaultWorkspaceIsolation: 'worktree' }),
    ).rejects.toMatchObject({
      code: 'project_worktree_directory_invalid',
      message: expect.stringContaining(directory),
    });
    expect(
      adapter.projectRevision.mock.results[0]?.value.replace,
    ).not.toHaveBeenCalled();
  });

  // archive#3315: server-owned sidebar order, proven through the REAL storage
  // adapter so the round-trip covers schema acceptance and the list sort, not
  // a mock's echo.
  test('reorderProjects persists a full order that survives a fresh adapter; an unpositioned set lists in name order', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-reorder-'));
    tmpHomes.push(home);
    const adapter = new FileStorageAdapter(home);
    const svc = new ProjectService(adapter);
    // Created deliberately out of name order.
    await svc.createProject({ name: 'Cedar', slug: 'cedar' } as any);
    await svc.createProject({ name: 'Alder', slug: 'alder' } as any);
    await svc.createProject({ name: 'Birch', slug: 'birch' } as any);

    // No positions persisted yet: deterministic name order, never readdir order.
    expect(svc.listProjects().map((p) => p.slug)).toEqual([
      'alder',
      'birch',
      'cedar',
    ]);

    // The payload is the whole set; every project is positioned.
    const reordered = await svc.reorderProjects(['cedar', 'alder', 'birch']);
    expect(reordered.map((p) => p.slug)).toEqual(['cedar', 'alder', 'birch']);

    // Round-trip through disk: a fresh adapter re-reads the same order.
    const fresh = new ProjectService(new FileStorageAdapter(home));
    expect(fresh.listProjects().map((p) => p.slug)).toEqual([
      'cedar',
      'alder',
      'birch',
    ]);
    expect(fresh.listProjects().map((p) => p.position)).toEqual([0, 1, 2]);
  });

  // `order` is the WHOLE set. A partial payload from a stale REST client would
  // otherwise silently degrade the operator's hand-made order: leaving omitted
  // projects alone strands colliding stale positions, and clearing them throws
  // the whole order away over a one-row request. Refusing is the only option
  // that keeps the docstring's promise — "a stale client cannot silently
  // reorder a partial set it mislabeled as full" — true.
  test('reorderProjects refuses a partial payload and leaves the stored order untouched', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-reorder-partial-'));
    tmpHomes.push(home);
    const svc = new ProjectService(new FileStorageAdapter(home));
    await svc.createProject({ name: 'Alder', slug: 'alder' } as any);
    await svc.createProject({ name: 'Birch', slug: 'birch' } as any);
    await svc.createProject({ name: 'Cedar', slug: 'cedar' } as any);

    // A full reorder positions all three — the operator's hand-made order.
    await svc.reorderProjects(['cedar', 'birch', 'alder']);
    expect(svc.listProjects().map((p) => p.slug)).toEqual([
      'cedar',
      'birch',
      'alder',
    ]);

    // One omitted slug is refused, and the error names it.
    await expect(svc.reorderProjects(['cedar', 'birch'])).rejects.toThrow(
      "Project order must list every project; missing 'alder'",
    );
    // Several omitted slugs are all named, so the caller can see the shape of
    // its mistake rather than one symptom of it.
    await expect(svc.reorderProjects(['birch'])).rejects.toThrow(
      "missing 'alder', 'cedar'",
    );

    // The refusal wrote nothing: the hand-made order survives in memory and
    // across a fresh adapter, with every position intact.
    expect(svc.listProjects().map((p) => p.slug)).toEqual([
      'cedar',
      'birch',
      'alder',
    ]);
    const fresh = new ProjectService(new FileStorageAdapter(home));
    expect(fresh.listProjects().map((p) => p.slug)).toEqual([
      'cedar',
      'birch',
      'alder',
    ]);
    expect(fresh.listProjects().map((p) => p.position)).toEqual([0, 1, 2]);
  });

  // The comparator's arms directly: a listProjects round-trip cannot prove the
  // name fallback when the fixture's readdir order coincides with name order
  // (it did — a fault injection neutralizing the fallback stayed green).
  test('compareProjectListOrder: positions ascending, positioned before unpositioned, name fallback', () => {
    const positioned = (name: string, position: number) => ({
      name,
      position,
    });
    const unpositioned = (name: string) => ({ name });
    expect(
      compareProjectListOrder(positioned('z', 0), positioned('a', 1)),
    ).toBeLessThan(0);
    expect(
      compareProjectListOrder(positioned('z', 9), unpositioned('a')),
    ).toBeLessThan(0);
    expect(
      compareProjectListOrder(unpositioned('a'), positioned('z', 9)),
    ).toBeGreaterThan(0);
    expect(
      compareProjectListOrder(unpositioned('beta'), unpositioned('alpha')),
    ).toBeGreaterThan(0);
    expect(
      compareProjectListOrder(unpositioned('alpha'), unpositioned('beta')),
    ).toBeLessThan(0);
  });

  test('reorderProjects refuses unknown and repeated slugs without writing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-reorder-refuse-'));
    tmpHomes.push(home);
    const svc = new ProjectService(new FileStorageAdapter(home));
    await svc.createProject({ name: 'Alder', slug: 'alder' } as any);

    await expect(svc.reorderProjects(['ghost'])).rejects.toThrow(
      "Unknown project slug 'ghost'",
    );
    await expect(svc.reorderProjects(['alder', 'alder'])).rejects.toThrow(
      'cannot repeat',
    );
    expect(svc.listProjects()[0]?.position).toBeUndefined();
  });
});

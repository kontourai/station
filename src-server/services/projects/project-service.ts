import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { BUILTIN_KNOWLEDGE_NAMESPACES } from '@kontourai/station-contracts/knowledge';
import type {
  ProjectConfig,
  ProjectMetadata,
} from '@kontourai/station-contracts/project';
import type { IStorageAdapter } from '../../domain/storage-adapter.js';
import {
  projectManifestBackfills,
  projectOps,
} from '../../telemetry/metrics.js';
import { execGit } from '../../utils/git-exec.js';
import { expandTilde } from '../../utils/paths.js';
import type { ProjectManifestStore } from './project-manifest-store.js';

export class ProjectWorktreeDirectoryError extends Error {
  readonly code = 'project_worktree_directory_invalid';

  constructor(
    readonly projectSlug: string,
    readonly workingDirectory: string | undefined,
    readonly reason:
      | 'missing'
      | 'not-directory'
      | 'not-git-worktree'
      | 'unreachable',
  ) {
    const directory = workingDirectory
      ? `'${workingDirectory}'`
      : 'an empty path';
    const detail =
      reason === 'missing'
        ? 'does not exist'
        : reason === 'not-directory'
          ? 'is not a directory'
          : reason === 'unreachable'
            ? 'did not respond to a filesystem check in time (unreachable or stalled mount?)'
            : 'is not inside a Git working tree';
    super(
      `Project '${projectSlug}' cannot use worktree isolation: configured working directory ${directory} ${detail}. Choose a Git repository directory or switch workspace isolation to shared.`,
    );
    this.name = 'ProjectWorktreeDirectoryError';
  }
}

/**
 * Whole-check deadline. This validation sits on the create/update request and
 * send paths, where a stalled network mount must produce a bounded, truthful
 * refusal instead of a hung request. The probe itself runs in a killable git
 * subprocess (see checkWorktreeDirectory); this outer deadline bounds the
 * caller even when the child cannot be reaped (uninterruptible-sleep mounts).
 */
const WORKTREE_DIRECTORY_CHECK_TIMEOUT_MS = 5_000;

/**
 * Race `check` against the deadline. A timed-out probe cannot be cancelled
 * (fs has no abort), so the loser is left to settle in the background with
 * its rejection consumed.
 */
export async function raceWorktreeDirectoryCheck<T>(
  check: Promise<T>,
  projectSlug: string,
  workingDirectory: string | undefined,
  timeoutMs: number = WORKTREE_DIRECTORY_CHECK_TIMEOUT_MS,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      check,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new ProjectWorktreeDirectoryError(
                projectSlug,
                workingDirectory,
                'unreachable',
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    check.catch(() => undefined);
  }
}

/** Validate the persisted-directory precondition before worktree provisioning. */
export async function assertProjectWorktreeDirectory(
  projectSlug: string,
  workingDirectory: string | undefined,
  timeoutMs?: number,
): Promise<void> {
  if (!workingDirectory) {
    throw new ProjectWorktreeDirectoryError(
      projectSlug,
      workingDirectory,
      'missing',
    );
  }
  await raceWorktreeDirectoryCheck(
    checkWorktreeDirectory(projectSlug, workingDirectory, timeoutMs),
    projectSlug,
    workingDirectory,
    timeoutMs,
  );
}

async function checkWorktreeDirectory(
  projectSlug: string,
  workingDirectory: string,
  timeoutMs: number = WORKTREE_DIRECTORY_CHECK_TIMEOUT_MS,
): Promise<void> {
  // The git child is the ONLY thing that touches the configured path: an
  // in-process fs probe against a dead mount parks a libuv threadpool worker
  // forever, and a handful of retries can stall every fs operation the server
  // owns. A subprocess is independently terminable and holds no worker.
  try {
    const { stdout } = await execGit(
      // EXPAND. Project working directories are stored tilde-literal, so
      // `git -C '~/dev/x'` fails with "cannot change to" and gets classified
      // below as reason 'missing' — producing "configured working directory
      // '~/dev/x' does not exist", a false statement about a directory that
      // does exist. Worktree isolation was therefore unavailable for every
      // project created through the UI (station#3155).
      [
        '-C',
        resolve(expandTilde(workingDirectory)),
        'rev-parse',
        '--is-inside-work-tree',
      ],
      // LC_ALL pins git's message language so stderr classification below
      // stays stable across host locales.
      { encoding: 'utf8', timeout: timeoutMs, env: { LC_ALL: 'C' } },
    );
    if (stdout.trim() === 'true') return;
    throw new ProjectWorktreeDirectoryError(
      projectSlug,
      workingDirectory,
      'not-git-worktree',
    );
  } catch (error) {
    if (error instanceof ProjectWorktreeDirectoryError) throw error;
    const failure = error as {
      killed?: boolean;
      signal?: string | null;
      stderr?: unknown;
    };
    if (failure.killed === true || failure.signal != null) {
      throw new ProjectWorktreeDirectoryError(
        projectSlug,
        workingDirectory,
        'unreachable',
      );
    }
    const stderr = typeof failure.stderr === 'string' ? failure.stderr : '';
    if (stderr.includes('cannot change to')) {
      throw new ProjectWorktreeDirectoryError(
        projectSlug,
        workingDirectory,
        stderr.includes('Not a directory') ? 'not-directory' : 'missing',
      );
    }
    // Everything else — not a repository, git absent, permission refusals —
    // is "not a usable work tree for this Station".
    throw new ProjectWorktreeDirectoryError(
      projectSlug,
      workingDirectory,
      'not-git-worktree',
    );
  }
}

/** Slugify a project name into a URL/filesystem-safe identifier. */
function slugifyProjectName(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'project'
  );
}

export class ProjectService {
  /**
   * `manifests` is optional so a caller that only needs project CRUD (tests,
   * migrations) is not forced to construct a manifest store. Production wires
   * it in `runtime-service-bootstrap.ts`: station#1499 writes a manifest
   * sidecar for every NEW project so the legacy `workingDirectory`-only path
   * shrinks monotonically instead of persisting as a permanent second mode
   * (`docs/design/portable-project-identity.md` §5, and its #1302
   * "designed but dead" precedent).
   */
  constructor(
    private storageAdapter: IStorageAdapter,
    private manifests?: Pick<ProjectManifestStore, 'ensureProjectManifest'>,
  ) {}

  listProjects(): ProjectMetadata[] {
    return this.storageAdapter.listProjects();
  }

  getProject(slug: string): ProjectConfig {
    return this.storageAdapter.getProject(slug);
  }

  async createProject(
    config: Omit<ProjectConfig, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<ProjectConfig> {
    // Derive name from working directory basename if not provided
    let name = config.name;
    if ((!name || name === 'Untitled') && config.workingDirectory) {
      const basename = config.workingDirectory.split('/').filter(Boolean).pop();
      if (basename) {
        name = basename.charAt(0).toUpperCase() + basename.slice(1);
      }
    }
    name = name || config.name;

    // Derive slug from name when the caller omits it — the storage layer
    // requires a slug for the on-disk project path (#597).
    let slug = config.slug?.trim();
    if (!slug) {
      const base = slugifyProjectName(name);
      const existingSlugs = new Set(
        this.storageAdapter.listProjects().map((project) => project.slug),
      );
      slug = base;
      let suffix = 2;
      while (existingSlugs.has(slug)) {
        slug = `${base}-${suffix++}`;
      }
    }

    if (config.defaultWorkspaceIsolation === 'worktree') {
      await assertProjectWorktreeDirectory(slug, config.workingDirectory);
    }

    const now = new Date().toISOString();
    const project: ProjectConfig = {
      ...config,
      name,
      slug,
      id: randomUUID(),
      knowledgeNamespaces: [...BUILTIN_KNOWLEDGE_NAMESPACES],
      createdAt: now,
      updatedAt: now,
    };
    if (project.defaultEnvironment?.kind === 'current') {
      delete project.defaultEnvironment;
    }
    await this.storageAdapter.createProject(project);
    // The manifest is derived from the project record that was just written,
    // so it is created AFTER the project exists on disk. `ensureProjectManifest`
    // is an exclusive create: if something else got there first, the winner's
    // portable id stands.
    //
    // BEST-EFFORT, deliberately: the project IS created at this point, and the
    // absence of a manifest is the defined compat state (§5 point 1), so a
    // failure here loses nothing. Letting it propagate turned a successful
    // creation into a 400 from the route's catch (and swallowed the create
    // telemetry below) for causes that have nothing to do with the request —
    // one corrupt `<home>/config/project-bindings.json` is read via
    // `hostAliases()` for every git-backed project and would break creating
    // them all; an unreadable sidecar, EACCES, ENOSPC, or a read-only home do
    // the same. The binding store's `onCorruption: 'throw'` is right and stays:
    // a silently-empty read there would turn every bound resource into
    // `unbound`.
    if (this.manifests) {
      try {
        await this.manifests.ensureProjectManifest(project);
      } catch (error) {
        projectManifestBackfills.add(1, { outcome: 'failed' });
        console.warn(
          `Project "${project.slug}" was created, but writing its manifest sidecar failed; it stays on the working-directory compat path:`,
          error,
        );
      }
    }
    projectOps.add(1, {
      operation: 'create',
      project: project.slug || project.id,
    });
    return project;
  }

  async updateProject(
    slug: string,
    updates: Partial<Omit<ProjectConfig, 'id' | 'slug' | 'createdAt'>>,
  ): Promise<ProjectConfig> {
    const revision = this.storageAdapter.projectRevision(slug);
    const existing = revision.value;
    const updated: ProjectConfig = {
      ...existing,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    if (updated.defaultEnvironment?.kind === 'current') {
      delete updated.defaultEnvironment;
    }
    if (
      updated.defaultWorkspaceIsolation === 'worktree' &&
      ('workingDirectory' in updates ||
        updates.defaultWorkspaceIsolation === 'worktree')
    ) {
      await assertProjectWorktreeDirectory(slug, updated.workingDirectory);
    }
    await revision.replace(updated);
    projectOps.add(1, { operation: 'update', project: slug });
    return updated;
  }

  async deleteProject(slug: string): Promise<void> {
    await this.storageAdapter.deleteProject(slug);
    projectOps.add(1, { operation: 'delete', project: slug });
  }

  /**
   * Persists the explicit sidebar order (station#3315): `order` is the WHOLE
   * project set, and each slug gets `position` = its index.
   *
   * A partial payload is refused, by cardinality and membership against the
   * known set. This is what makes "a stale client cannot silently reorder a
   * partial set it mislabeled as full" a check rather than a hope. Both of the
   * alternatives lose:
   *
   *  - Leaving omitted projects untouched appends them deterministically only
   *    while they have never been positioned. After any earlier full reorder
   *    an omitted project keeps a stale position that collides with a listed
   *    project's new one, and the pair falls through to the name tiebreak — so
   *    a user who dragged `birch` to the top could be shown `alder` there.
   *  - Clearing omitted positions fixes that collision but hands a stale REST
   *    client a bigger weapon: `{order:["birch"]}` would silently discard the
   *    operator's whole hand-made order instead of touching one row.
   *
   * With fullness enforced no project can carry a stale position, because
   * every project is rewritten on every reorder. The UI already sends the full
   * list, so this refuses only callers that were already wrong.
   */
  async reorderProjects(order: readonly string[]): Promise<ProjectMetadata[]> {
    const all = this.storageAdapter.listProjects();
    const known = new Set(all.map((project) => project.slug));
    const unknown = order.filter((slug) => !known.has(slug));
    if (unknown.length > 0) {
      throw new Error(`Unknown project slug '${unknown[0]}'`);
    }
    if (new Set(order).size !== order.length) {
      throw new Error('Project order cannot repeat a slug');
    }
    const listed = new Set(order);
    // Sorted, not in list order: the diagnostic must not change shape with the
    // current positions it is complaining about.
    const missing = all
      .map((project) => project.slug)
      .filter((slug) => !listed.has(slug))
      .sort();
    if (missing.length > 0) {
      throw new Error(
        `Project order must list every project; missing ${missing
          .map((slug) => `'${slug}'`)
          .join(', ')}`,
      );
    }
    const updatedAt = new Date().toISOString();
    for (const [index, slug] of order.entries()) {
      const revision = this.storageAdapter.projectRevision(slug);
      if (revision.value.position === index) continue;
      await revision.replace({
        ...revision.value,
        position: index,
        updatedAt,
      });
    }
    projectOps.add(1, { operation: 'reorder' });
    return this.listProjects();
  }
}

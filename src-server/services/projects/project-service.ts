import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { BUILTIN_KNOWLEDGE_NAMESPACES } from '@kontourai/station-contracts/knowledge';
import type {
  ProjectConfig,
  ProjectMetadata,
} from '@kontourai/station-contracts/project';
import type { ProjectPortableIdentity } from '@kontourai/station-contracts/project-identity';
import {
  PROJECT_OVERRIDE_RECORD_FIELDS,
  type ProjectOverrideRecordField,
} from '@kontourai/station-contracts/project-settings-overrides';
import {
  resolveWorkspaceIsolationMode,
  type WorkspaceIsolationMode,
} from '@kontourai/station-contracts/workspace-isolation';
import { FileStorageUnavailableError } from '../../domain/project-file-transactions.js';
import { parseProjectPortableIdentity } from '../../domain/project-identity-record.js';
import type { IStorageAdapter } from '../../domain/storage-adapter.js';
import {
  projectManifestBackfills,
  projectOps,
} from '../../telemetry/metrics.js';
import { execGit } from '../../utils/git-exec.js';
import { createLogger } from '../../utils/logger.js';
import { expandTilde, resolveHomeDir } from '../../utils/paths.js';
import type { ProjectManifestStore } from './project-manifest-store.js';

const logger = createLogger({ name: 'project-service' });

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
/**
 * A `PUT /projects/:slug` body, as `updateProject` accepts it.
 *
 * The settings-override fields additionally accept `null`, which DROPS the
 * override (#2144 slice 2). Null is not a stored value for any of them —
 * `projectSchema` has no null — so "clear this" needs a spelling that is not
 * "store this", and `undefined` cannot be it: a spread merge cannot tell an
 * absent key from one the caller explicitly left out.
 */
export type ProjectUpdate = Partial<
  Omit<ProjectConfig, 'id' | 'slug' | 'createdAt' | ProjectOverrideRecordField>
> & {
  [K in ProjectOverrideRecordField]?: ProjectConfig[K] | null;
};

/**
 * A `POST /projects` body, as `createProject` accepts it.
 *
 * Carries the same `null`-means-drop allowance as {@link ProjectUpdate}, and
 * for a reason that is not optional: `projectUpdateSchema` IS
 * `projectCreateSchema.partial()`, so the route's validator admits `null` on
 * create whatever this type says. Symmetric types keep the service honest
 * about what the schema already lets through.
 */
export type ProjectCreate = Omit<
  ProjectConfig,
  'id' | 'createdAt' | 'updatedAt' | ProjectOverrideRecordField
> & {
  [K in ProjectOverrideRecordField]?: ProjectConfig[K] | null;
};

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
      // project created through the UI (archive#3155).
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

/** Host-owned folder for a project that did not name another path. */
function stationOwnedWorkspaceDirectory(
  slug: string,
  home: string = resolveHomeDir(),
): string {
  return join(home, 'workspaces', slug);
}

/** Stored spelling of {@link stationOwnedWorkspaceDirectory}. */
export function defaultedProjectWorkingDirectory(
  slug: string,
  home: string = resolveHomeDir(),
): string {
  return resolve(expandTilde(stationOwnedWorkspaceDirectory(slug, home)));
}

export class ProjectService {
  /**
   * `manifests` is optional so a caller that only needs project CRUD (tests,
   * migrations) is not forced to construct a manifest store. Production wires
   * it in `runtime-service-bootstrap.ts`: archive#1499 writes a manifest
   * sidecar for every NEW project so the legacy `workingDirectory`-only path
   * shrinks monotonically instead of persisting as a permanent second mode
   * (`docs/design/portable-project-identity.md` §5, and its archive#1302
   * "designed but dead" precedent).
   */
  /**
   * `stationDefaultWorkspaceIsolation` reads this Station's
   * `AppConfig.defaultWorkspaceIsolation` (#2144 slice 2) so the worktree
   * directory preflights below judge the mode a chat will ACTUALLY start in,
   * not just the one the project record names. Optional, and absent resolves
   * to the shared checkout — which is how every caller behaved before the
   * Station default existed.
   */
  constructor(
    private storageAdapter: IStorageAdapter,
    private manifests?: Pick<ProjectManifestStore, 'ensureProjectManifest'>,
    private stationDefaultWorkspaceIsolation?: () => Promise<
      WorkspaceIsolationMode | undefined
    >,
  ) {}

  /**
   * The mode a new chat in this project would start in — the project's own
   * choice, then this Station's default, then shared. The preflights below
   * are the early, specific "this directory is not a git repository" the
   * person gets at save time instead of a failed chat start; they have to ask
   * the same question `execution-target-resolver.ts` asks, or a project
   * inheriting a Station default of `worktree` skips the check entirely and
   * finds out at the first turn.
   */
  private async effectiveWorkspaceIsolation(
    projectMode: WorkspaceIsolationMode | undefined,
  ): Promise<WorkspaceIsolationMode> {
    return resolveWorkspaceIsolationMode(
      projectMode,
      await this.stationDefaultWorkspaceIsolation?.(),
    );
  }

  listProjects(): ProjectMetadata[] {
    return this.storageAdapter.listProjects();
  }

  getProject(slug: string): ProjectConfig {
    return this.storageAdapter.getProject(slug);
  }

  async createProject(config: ProjectCreate): Promise<ProjectConfig> {
    const project = await this.prepareProjectConfig(config);
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
        logger.warn(
          'Project was created, but writing its manifest sidecar failed; it stays on the working-directory compat path',
          { project: project.slug, error },
        );
      }
    }
    projectOps.add(1, {
      operation: 'create',
      project: project.slug || project.id,
    });
    return project;
  }

  async createAttachedProject(
    config: Omit<ProjectConfig, 'id' | 'createdAt' | 'updatedAt'>,
    portableIdentity: ProjectPortableIdentity,
  ): Promise<ProjectConfig> {
    const identity = parseProjectPortableIdentity(portableIdentity);
    const create = this.storageAdapter.createProjectWithIdentity?.bind(
      this.storageAdapter,
    );
    if (!create)
      throw new FileStorageUnavailableError(
        'This storage adapter cannot atomically attach a portable Project.',
      );
    const project = await this.prepareProjectConfig(config);
    await create(project, identity);
    projectOps.add(1, {
      operation: 'create',
      project: project.slug || project.id,
    });
    return project;
  }

  private async prepareProjectConfig(
    config: ProjectCreate,
  ): Promise<ProjectConfig> {
    // #2144 slice 2, same rule as `updateProject`: `null` on a
    // settings-override field means "no override", not "store null". The two
    // schemas are one schema — `projectUpdateSchema` IS
    // `projectCreateSchema.partial()` — so create receives the null the
    // route's validator lets through, and `projectSchema`
    // (file-storage-schemas.ts) admits none, which would make a brand-new
    // record unloadable on its first read.
    //
    // Dropped HERE, before anything reads the fields: the worktree preflight
    // below asks what mode this project will resolve to, and `null` is not a
    // mode — passing it through would make "no override" look like a choice
    // to whatever read it next.
    const normalized = { ...config } as Omit<
      ProjectConfig,
      'id' | 'createdAt' | 'updatedAt'
    >;
    for (const field of PROJECT_OVERRIDE_RECORD_FIELDS) {
      if ((config as Record<string, unknown>)[field] === null) {
        delete normalized[field];
      }
    }
    // Rebound, not reassigned: a reassigned parameter keeps its declared
    // (nullable) type, and every read below must see the narrowed one.
    const input = normalized;

    // Derive name from working directory basename if not provided
    let name = input.name;
    if ((!name || name === 'Untitled') && input.workingDirectory) {
      const basename = input.workingDirectory.split('/').filter(Boolean).pop();
      if (basename) {
        name = basename.charAt(0).toUpperCase() + basename.slice(1);
      }
    }
    name = name || input.name;

    // Derive slug from name when the caller omits it — the storage layer
    // requires a slug for the on-disk project path (archive#597).
    let slug = input.slug?.trim();
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

    const isolation = await this.effectiveWorkspaceIsolation(
      input.defaultWorkspaceIsolation,
    );
    const requestedDirectory = input.workingDirectory?.trim()
      ? resolve(expandTilde(input.workingDirectory.trim()))
      : undefined;
    if (!requestedDirectory) {
      if (isolation === 'worktree') {
        await assertProjectWorktreeDirectory(slug, undefined);
      } else {
        const workspace = defaultedProjectWorkingDirectory(slug);
        await mkdir(workspace, { recursive: true });
        input.workingDirectory = resolve(expandTilde(workspace));
      }
    } else if (isolation === 'worktree') {
      await assertProjectWorktreeDirectory(slug, requestedDirectory);
    }

    const now = new Date().toISOString();
    const project: ProjectConfig = {
      ...input,
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
    return project;
  }

  async updateProject(
    slug: string,
    updates: ProjectUpdate,
  ): Promise<ProjectConfig> {
    const revision = this.storageAdapter.projectRevision(slug);
    const existing = revision.value;
    const updated: ProjectConfig = {
      ...existing,
      ...updates,
      updatedAt: new Date().toISOString(),
    } as ProjectConfig;
    // #2144 slice 2: `null` on a settings-override field DROPS the override
    // rather than storing it. Storing it is not an option that merely reads
    // oddly — `projectSchema` (file-storage-schemas.ts) has no null for any
    // of these, so a stored null makes the record unloadable on the next
    // read. Applied after the spread so it also clears a field the existing
    // record carried.
    for (const field of PROJECT_OVERRIDE_RECORD_FIELDS) {
      if ((updates as Record<string, unknown>)[field] === null) {
        delete updated[field];
      }
    }
    if (updated.defaultEnvironment?.kind === 'current') {
      delete updated.defaultEnvironment;
    }
    // The trigger list gains `null` (#2144 slice 2): dropping the project's
    // own mode is a change of the effective mode exactly as setting it is —
    // the project stops naming one and lands on the Station default, which
    // may be `worktree`. Without it, "use the Station default" was the one
    // edit that could newly require a git repository and never check for one.
    if (
      ('workingDirectory' in updates ||
        updates.defaultWorkspaceIsolation === 'worktree' ||
        updates.defaultWorkspaceIsolation === null) &&
      (await this.effectiveWorkspaceIsolation(
        updated.defaultWorkspaceIsolation,
      )) === 'worktree'
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
   * Persists the explicit sidebar order (archive#3315): `order` is the WHOLE
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

/**
 * Project Routes - project and layout management
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { agentId } from '@kontourai/station-contracts/agent-identity';
import {
  PAIRING_SCOPE_ORCHESTRATION_OPERATE,
  pairingScopeIncludes,
} from '@kontourai/station-contracts/environment-security';
import {
  describeKnowledgeRepoRootProblem,
  type KnowledgeNamespaceConfig,
  knowledgeRepoRootProblem,
} from '@kontourai/station-contracts/knowledge';
import {
  assertNoRetiredLayoutKeys,
  BUILTIN_SESSION_BOARD_LAYOUT,
  type LayoutConfig,
  type LayoutReadView,
  RetiredLayoutKeyError,
} from '@kontourai/station-contracts/layout';
import type { PluginManifest } from '@kontourai/station-contracts/plugin';
import {
  describeProjectSlugConflict,
  findProjectSlugConflict,
  type ProjectConfig,
} from '@kontourai/station-contracts/project';
import type { ProjectResourceBindOutcome } from '@kontourai/station-contracts/project-identity';
import type { AgentOwnershipRef } from '@kontourai/station-contracts/project-reference-integrity';
import {
  normalizeProjectAgentScope,
  validateLayoutAgentReferences,
  validateProjectAgentScope,
} from '@kontourai/station-contracts/project-reference-integrity';
import {
  WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR_ID,
  WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR_ID,
  WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR_ID,
} from '@kontourai/station-contracts/workspace-coding-panels';
import { type Context, Hono } from 'hono';
import {
  FileStorageAlreadyExistsError,
  FileStorageConflictError,
  FileStorageNotFoundError,
  FileStorageUnavailableError,
} from '../../domain/project-file-transactions.js';
import {
  assertSafeLayoutPathSegment,
  type IStorageAdapter,
} from '../../domain/storage-adapter.js';
import {
  grantedPairingScope,
  type PairingScopeContextStore,
} from '../../security/pairing-route-scopes.js';
import type { StationKitObservabilityRegistry } from '../../services/kits/kit-observability-registry.js';
import {
  layoutPluginBindingWithheld,
  resolveLayoutPaneReferences,
  withoutPluginBinding,
  withPluginBindingRestored,
} from '../../services/layouts/layout-pane-reference.js';
import { DistributionProfileService } from '../../services/plugins/distribution-profile-service.js';
import type { CheckoutRemoteReader } from '../../services/projects/checkout-remote-reader.js';
import { findGitEntryOnPath } from '../../services/projects/checkout-remote-reader.js';
import { discoverProjectIconCandidates } from '../../services/projects/project-icon-discovery.js';
import { ProjectIdentityService } from '../../services/projects/project-identity-service.js';
import {
  describeProjectResolution,
  type ProjectManifestRecordReader,
  type ProjectResolutionBindingReader,
  type ProjectResourceResolverLike,
} from '../../services/projects/project-resolution-view.js';
import {
  type BindProjectResourceRefusalCode,
  bindProjectResource,
  type ProjectBindingWriter,
  type ProjectManifestReader,
} from '../../services/projects/project-resource-binder.js';
import type { ProjectService } from '../../services/projects/project-service.js';
import { resolveProjectWorkspacePath } from '../../services/projects/project-workspace-path.js';
import { workspacePaneAvailabilityMetricAttributes } from '../../services/projects/workspace-pane-availability-resolver.js';
import { readCurrentWorkspacePaneCatalog } from '../../services/projects/workspace-pane-catalog.js';
import type { TerminalService } from '../../services/terminal/terminal-service.js';
import {
  projectBindingOperations,
  projectOps,
  projectPaneCatalogDuration,
  projectResolutionRouteRequests,
  workspacePaneAvailabilityResolutions,
} from '../../telemetry/metrics.js';
import { createLogger } from '../../utils/logger.js';
import { pathAccessFailure } from '../../utils/path-access-failure.js';
import { expandTilde } from '../../utils/paths.js';
import { projectLayoutCatalogItems } from '../plugins/plugin-identity-enumeration.js';
import {
  errorMessage,
  getBody,
  param,
  projectCreateSchema,
  projectLayoutApplySchema,
  projectLayoutCreateSchema,
  projectLayoutFromPluginSchema,
  projectLayoutUpdateSchema,
  projectReorderSchema,
  projectResourceBindSchema,
  projectUpdateSchema,
  validate,
} from '../schemas/schemas.js';
import {
  codingLayoutRepoId,
  withDerivedWorkingDirectory,
  withoutPersistedWorkingDirectory,
} from './layout-working-directory.js';
import { createProjectIdentityRoutes } from './project-identity-routes.js';
import { admitProjectLayoutWrite } from './project-layout-admission.js';
import { createWorkspacePanePreviewRoutes } from './workspace-pane-previews.js';

/** Read a plugin's layout.json to create a layout reference */
function readPluginLayout(projectHomeDir: string, pluginName: string) {
  const pluginFile = join(projectHomeDir, 'plugins', pluginName, 'plugin.json');
  if (!existsSync(pluginFile)) return null;
  const plugin = JSON.parse(
    readFileSync(pluginFile, 'utf-8'),
  ) as PluginManifest;
  if (!plugin.layout) return null;

  const layoutFile = join(
    projectHomeDir,
    'plugins',
    pluginName,
    plugin.layout.source || 'layout.json',
  );
  if (!existsSync(layoutFile)) return null;
  const definition = JSON.parse(readFileSync(layoutFile, 'utf-8'));
  // Refused by name rather than read past: this definition is copied into the
  // project's stored layout config, so a retired key would be persisted and
  // then dropped by every reader downstream (review M1).
  assertNoRetiredLayoutKeys(definition, `Plugin '${pluginName}' layout`);
  return definition;
}

/**
 * archive#1503 review H2 — a PLUGIN may not anchor a knowledge namespace to a
 * project repo, and saying so is not a limitation.
 *
 * `PluginManifest.knowledge.namespaces` is typed `KnowledgeNamespaceConfig[]`,
 * so it inherited `repoRoot` the moment that field existed, and the function
 * below copies plugin-declared namespaces into the project VERBATIM. A plugin
 * cannot know a project's declared resources — those are canonical remotes
 * specific to that project — so any `repoRoot` a plugin declares is a guess,
 * and a wrong guess makes the project's manifest UNREADABLE, failing every seam
 * closed until someone hand-edits storage.
 *
 * Refusing at install time, by name, is therefore both the safe answer and the
 * honest one: there is no case where a plugin legitimately knows this value.
 * A project-level anchor is written by the operator, on the project, and is
 * validated against the declared set there.
 */
function refusePluginRepoAnchors(
  pluginName: string,
  namespaces: readonly KnowledgeNamespaceConfig[],
): void {
  const anchored = namespaces.filter((namespace) => namespace.repoRoot);
  if (anchored.length === 0) return;
  throw new Error(
    `Plugin "${pluginName}" declares a repo-anchored knowledge namespace (${anchored
      .map((namespace) => namespace.id)
      .join(
        ', ',
      )}), which a plugin cannot do: a repo anchor names one of THIS project's declared resources, and a plugin has no way to know them. Remove the anchor from the plugin, or add the namespace on the project instead. Nothing was saved.`,
  );
}

async function registerPluginNamespaces(
  storageAdapter: IStorageAdapter,
  projectSlug: string,
  manifest: PluginManifest,
): Promise<void> {
  const namespaces = manifest.knowledge?.namespaces;
  if (!namespaces?.length) return;
  const revision = storageAdapter.projectRevision(projectSlug);
  const project = revision.value;
  const existing: KnowledgeNamespaceConfig[] =
    project.knowledgeNamespaces ?? [];
  const existingIds = new Set(existing.map((n) => n.id));
  const toAdd = namespaces.filter((n) => !existingIds.has(n.id));
  if (!toAdd.length) return;
  await revision.replace({
    ...project,
    knowledgeNamespaces: [...existing, ...toAdd],
  });
}

interface ProjectRouteDeps {
  listAgents?: () => Promise<AgentOwnershipRef[]> | AgentOwnershipRef[];
  layoutCatalog?: DistributionProfileService;
  /** Existing Kit lifecycle authority; pane discovery only reads its snapshot. */
  kitObservabilityRegistry?: StationKitObservabilityRegistry;
  /** Project-scoped terminal termination; the route supplies the identity. */
  terminalService?: Pick<TerminalService, 'closeForProject'>;
  /**
   * archive#3778 — `OperatingStateService.hasBuilderRun`, the ONE Builder-run
   * predicate the Board's nav entry and route guard already consume. Injected
   * rather than re-derived so the Pane catalogue answers the same question the
   * same way; absent (layout-only route tests), the catalogue offers every
   * layout as it always did.
   */
  hasBuilderRun?: (projectSlug: string) => boolean;
  /**
   * archive#1502 — the resolution surface's dependencies.
   *
   * Injected as ONE object rather than defaulted here on purpose. A
   * `ProjectResourceResolver` that constructs its own `FileStorageAdapter`
   * answers from a different project store than the runtime was built over —
   * a recorded slice-3b review finding, which `station-runtime.ts` closes by
   * pinning `source` to the runtime's own adapter. Defaulting it in this
   * module would reintroduce it behind a route instead of behind a service.
   * Absent (as in the layout-only route tests), the two routes report an
   * honest 501 rather than answering from a store nobody chose.
   */
  resolution?: ProjectResolutionRouteDeps;
  /**
   * Whether the request's own caller may see a named plugin (#2067) — the
   * projection `PluginVisibilityService` derives, bound per request.
   *
   * The catalogue IS an enumeration boundary — it carries every plugin's
   * name, version, `plugins/<name>` source and lifecycle state — so a plugin
   * outside the projection is ABSENT from `contributions`, `descriptors`,
   * `instances` and `availability` alike. That is the discovery half.
   *
   * The REFERENCE half is #2090, and it is live: the layout read routes
   * consult `services/layouts/layout-pane-reference.ts`, which withholds
   * everything naming the owning plugin (the live `plugins/<name>` merge,
   * the catalog backfill, `config.plugin`, `catalogContribution`, the
   * plugin's global actions) and emits a causeless per-tab verdict the host
   * renders a placeholder from. The layout list, apply, and from-plugin
   * paths read the same predicate (#2103), so a hidden plugin and a name
   * nobody installed answer identically on every one of them.
   *
   * Absent (the layout-only route tests), no visibility fact is produced and
   * availability resolves exactly as before.
   */
  canSeePlugin?: (c: Context, pluginId: string) => boolean;
}

/**
 * archive#1502. The route owns no resolution logic; it owns the
 * envelope, the status map, and the telemetry.
 */
export interface ProjectResolutionRouteDeps {
  resolver: ProjectResourceResolverLike;
  manifests: ProjectManifestRecordReader & ProjectManifestReader;
  bindings: ProjectBindingWriter & ProjectResolutionBindingReader;
  readRemotes: CheckoutRemoteReader;
}

/**
 * §3.6's repair action returns a REASON on refusal, and the status separates
 * "you gave me something wrong" from "what you gave me conflicts with what is
 * recorded". Neither ever records a binding — see `project-resource-binder.ts`
 * decision 1.
 */
const logger = createLogger({ name: 'projects-routes' });

function projectMutationStatus(
  error: unknown,
  fallback: 400 | 404 = 400,
): 400 | 404 | 409 | 503 {
  if (error instanceof FileStorageConflictError) return 409;
  if (error instanceof FileStorageNotFoundError) return 404;
  if (error instanceof FileStorageUnavailableError) return 503;
  return fallback;
}

function projectMutationMessage(error: unknown): string {
  if (error instanceof FileStorageConflictError) {
    return 'Project storage changed before the operation could commit';
  }
  if (error instanceof FileStorageNotFoundError) return 'Project not found';
  if (error instanceof FileStorageUnavailableError) {
    return 'Project storage is unavailable';
  }
  return errorMessage(error);
}

function projectReadFailure(
  error: unknown,
  resource: 'Project' | 'Layout',
): { error: string; status: 404 | 500 } {
  if (error instanceof FileStorageNotFoundError) {
    const missingResource = error.message.startsWith('Project ')
      ? 'Project'
      : resource;
    return { error: `${missingResource} not found`, status: 404 };
  }
  logger.error(`${resource} storage read failed`, {
    error: error instanceof Error ? error.message : 'non-Error thrown',
  });
  return { error: `${resource} storage is unavailable`, status: 500 };
}

const BIND_REFUSAL_STATUS: Record<BindProjectResourceRefusalCode, 400 | 409> = {
  'path-not-found': 400,
  'path-not-absolute': 400,
  'path-not-a-directory': 400,
  // archive#1503: the request named a resource this project does not declare —
  // "you gave me something wrong", not a conflict with what is recorded.
  'unknown-resource': 400,
  'no-resources-declared': 409,
  ambiguous: 409,
  unverifiable: 409,
  'remotes-do-not-intersect': 409,
};

/**
 * The scope `PUT /config/app` requires — the authority that writing a
 * Station setting takes. Named here so the coupling in
 * `refuseUnscopedWorkspaceIsolationWrite` is a reference to that route's
 * tier rather than a second, drifting opinion about it.
 */
const PROJECT_WORKSPACE_ISOLATION_SCOPE = PAIRING_SCOPE_ORCHESTRATION_OPERATE;

export function createProjectRoutes(
  projectService: ProjectService,
  storageAdapter: IStorageAdapter,
  projectHomeDir: string,
  deps: ProjectRouteDeps = {},
) {
  const app = new Hono();
  const resolution = deps.resolution;
  app.route(
    '/',
    createProjectIdentityRoutes(
      resolution
        ? new ProjectIdentityService(
            projectService,
            storageAdapter,
            resolution.manifests,
            resolution.readRemotes,
            () => resolution.bindings.hostAliases(),
          )
        : undefined,
    ),
  );
  const layoutCatalog =
    deps.layoutCatalog ?? new DistributionProfileService(projectHomeDir);

  async function readKnownAgents(): Promise<AgentOwnershipRef[] | undefined> {
    return deps.listAgents ? await deps.listAgents() : undefined;
  }

  /**
   * This request's own plugin projection (#2067), or `undefined` when the
   * composition supplied none.
   *
   * Every layout handler below reads it through this one binding so that
   * "absent means nothing is withheld" is decided once, rather than in each
   * handler where one of them would eventually get it backwards.
   */
  function viewerPluginSight(
    c: Context,
  ): ((pluginId: string) => boolean) | undefined {
    const canSeePlugin = deps.canSeePlugin;
    return canSeePlugin ? (pluginId) => canSeePlugin(c, pluginId) : undefined;
  }

  /**
   * archive#1497 — the single source of truth for a coding layout's working
   * directory.
   *
   * This deliberately does NOT swallow a read failure. An earlier revision
   * caught and returned `undefined`, documented as "an honest absence beats a
   * path we can no longer confirm" — but review proved that path is
   * unreachable: every layout handler also calls `storageAdapter.getProject`
   * unguarded a few lines later (for agent-reference diagnostics), and
   * `listAgents` is always supplied in production
   * (`runtime-routes.ts:760-771`). An unreadable project record therefore
   * always 404s the request, and the swallow only made the code *look* like
   * it had a resilience it did not have.
   */
  function projectWorkingDirectory(slug: string): string | undefined {
    return storageAdapter.getProject(slug).workingDirectory;
  }

  /**
   * The Pane catalog needs bounded workspace and Git facts, not an invented
   * workspace identifier. Project configuration names the workspace; a live
   * directory check confirms it is available here, and the established Git
   * entry probe distinguishes a configured directory from a Git checkout.
   */
  function projectWorkspacePaneContext(project: { workingDirectory?: string }) {
    const workingDirectory = project.workingDirectory?.trim();
    if (!workingDirectory) {
      return {
        workspace: 'missing' as const,
        gitRepository: 'missing' as const,
      };
    }
    const workspacePath = resolve(expandTilde(workingDirectory));
    if (!existsSync(workspacePath)) {
      return {
        workspace: 'missing' as const,
        gitRepository: 'missing' as const,
      };
    }
    return {
      workspace: 'present' as const,
      gitRepository: findGitEntryOnPath(workspacePath)
        ? ('present' as const)
        : ('missing' as const),
    };
  }

  /**
   * archive#1503 — the working directory a coding layout derives, which
   * is the project's UNLESS the layout names a repo (§10: "layouts reference
   * repos by id").
   *
   * A named repo is resolved through the REPO-question
   * (`resolveProjectWorkspacePath`, `bound` only), so a layout about the API
   * repo opens the API repo's checkout wherever it is bound on this Station —
   * not "the project's directory", which on a multi-repo project is a different
   * repository's tree. When that repo is not bound here the key is ABSENT, and
   * that is the honest answer: falling back to the project directory would open
   * the wrong repo under a caption naming the right one.
   *
   * Named but unresolvable — including when this server has no resolution
   * dependencies wired at all — is likewise absent, never the project's
   * directory. §1497's rule is unchanged for a layout that names no repo: the
   * project's value, derived on every read, never a persisted copy.
   */
  async function derivedLayoutWorkingDirectory(
    slug: string,
    layout: { type?: string; config?: Record<string, unknown> },
    project?: ProjectConfig,
  ): Promise<string | undefined> {
    const repoId = codingLayoutRepoId(layout);
    if (repoId === undefined)
      return project?.workingDirectory ?? projectWorkingDirectory(slug);
    // Read the project anyway, so an unknown slug still throws here exactly as
    // it did before this branch existed (every caller relies on that 404).
    if (!project) projectWorkingDirectory(slug);
    const resolution = deps.resolution;
    if (!resolution) return undefined;
    return await resolveProjectWorkspacePath(slug, {
      resolver: resolution.resolver,
      resourceId: repoId,
    });
  }

  /**
   * archive#1497 — a coding layout's working directory is derived from its
   * owning project, so a request that tries to set a *different* one is
   * refused by name rather than silently discarded.
   *
   * The check is against the REQUEST body, never the merged record: a layout
   * carrying a copy persisted before this change must still be renamable, and
   * that copy is cleared by the write rather than rejected by it.
   */
  function conflictingWorkingDirectory(
    projectSlug: string,
    type: string | undefined,
    body: { config?: Record<string, unknown> },
    derived: string | undefined,
  ): string | undefined {
    if (type !== 'coding') return undefined;
    const supplied = body.config?.workingDirectory;
    if (supplied === undefined || supplied === derived) return undefined;
    return `A coding layout's config.workingDirectory is derived from its project and cannot be set independently. Project '${projectSlug}' resolves to ${derived ? `'${derived}'` : 'no working directory'}; change the project's working directory instead.`;
  }

  /**
   * archive#1503 review H2 — refuse a bad repo anchor AT THE WRITE, where the
   * operator is present and the repair is obvious.
   *
   * The read side already refuses one (the manifest validator rejects a
   * `knowledge[].root.repoId` naming an undeclared resource, so `composeManifest`
   * fails the project closed as `unreadable`). That outcome is right and the two
   * alternatives are worse, but the PLACE is terrible: an unreadable manifest
   * fails every seam at once — session cwd, knowledge scan, task workspace, the
   * resolution surface — long after whoever caused it has gone.
   *
   * The declared set comes from the manifest RECORD. When there is none, the
   * shape checks still run and the declared-id check is skipped.
   *
   * **That skip rests on a coincidence of two facts, not on a rule** — say so
   * rather than stating the conclusion (archive#1503 delta review, R3). It is
   * safe only while BOTH hold:
   *
   *   1. Nothing backfills a manifest sidecar for an EXISTING project.
   *      `ensureProjectManifest` has exactly one caller today, inside
   *      `ProjectService.createProject`.
   *   2. That caller cannot carry an anchor — `createProject` overwrites
   *      `knowledgeNamespaces` with the built-ins (see R2 at the call site).
   *
   * The resolver's own docblock notes that essentially every project on disk
   * predates manifests, so the population under this skip is large. **The day
   * any write path backfills a sidecar for an existing project, every
   * compat-era project that accepted an anchor here becomes `unreadable` at
   * once.** Whoever adds that backfill owes this branch a re-validation pass
   * over existing `knowledgeNamespaces`, not just a new call site.
   */
  function refuseInvalidRepoAnchors(
    slug: string,
    body: Record<string, unknown>,
  ): string | undefined {
    const namespaces = body.knowledgeNamespaces;
    if (!Array.isArray(namespaces)) return undefined;
    let declaredRepoIds: string[] | undefined;
    try {
      const record = deps.resolution?.manifests.readRecord(slug);
      declaredRepoIds = record?.repos.map((repo) => repo.id);
    } catch {
      // An unreadable record cannot tell us what is declared. Leaving this
      // `undefined` runs the SHAPE checks and skips the id check, which is the
      // same posture as "no record" — and the read side still refuses on its
      // own. Failing the write here would make an already-broken sidecar block
      // the edits that repair it.
      declaredRepoIds = undefined;
    }
    for (const namespace of namespaces as KnowledgeNamespaceConfig[]) {
      const repoRoot = namespace?.repoRoot;
      if (!repoRoot) continue;
      const problem = knowledgeRepoRootProblem(repoRoot, declaredRepoIds);
      if (problem) {
        return describeKnowledgeRepoRootProblem(
          namespace.id,
          repoRoot,
          problem,
        );
      }
    }
    return undefined;
  }

  function normalizeProjectBody<T extends Record<string, unknown>>(body: T): T {
    if (!Object.hasOwn(body, 'agents')) return body;
    return {
      ...body,
      agents: normalizeProjectAgentScope(
        body.agents === null
          ? undefined
          : (body.agents as string[] | undefined)?.map(agentId),
      ),
    };
  }

  /**
   * #2144 slice 2, decision 4: a project's `defaultWorkspaceIsolation` is a
   * Station setting a project overrides, so writing it requires the scope
   * that writing the Station setting requires —
   * `requiredPairingScope('PUT', '/config/app')`, which is
   * `orchestration:operate`.
   *
   * WHAT THIS DOES AND DOES NOT ADD, stated plainly because the honest
   * answer is "less than the decision's wording implies". `PUT
   * /api/projects/:slug` ALREADY requires `orchestration:operate` (the
   * `/api/projects` family's mutate tier), so for a caller that reached this
   * handler through the runtime auth boundary, the predicate is already
   * satisfied and this guard refuses nobody today. It is defense in depth
   * against a future narrowing of the project family's tier — the moment
   * project mutation drops below the config tier, this field does not drop
   * with it — and it is the place the coupling is written down.
   *
   * It is NOT a claim that project updates are authorized more narrowly than
   * they were. An absent scope is Station's own internal-token attestation
   * and passes, exactly as it does in `PUT /config/app`'s guards.
   */
  function refuseUnscopedWorkspaceIsolationWrite(
    c: Context,
    body: Record<string, unknown>,
  ): string | undefined {
    if (!Object.hasOwn(body, 'defaultWorkspaceIsolation')) return undefined;
    const presentedScope = grantedPairingScope(
      c as unknown as PairingScopeContextStore,
    );
    if (presentedScope === undefined) return undefined;
    if (
      pairingScopeIncludes(presentedScope, PROJECT_WORKSPACE_ISOLATION_SCOPE)
    ) {
      return undefined;
    }
    return 'The workspace new chats start in is a Station setting this project overrides, so changing it needs the same authority as changing it on the Station. No changes were saved.';
  }

  function integrityError(
    diagnostics: ReturnType<typeof validateProjectAgentScope>,
  ) {
    return {
      success: false,
      error: diagnostics[0]?.message ?? 'Invalid project references',
      diagnostics,
    };
  }

  // File preview is deliberately a separate read-only route so its
  // filesystem authority stays project-bound and cannot leak into layout
  // persistence or catalog construction.
  app.route(
    '/:slug/file-preview',
    createWorkspacePanePreviewRoutes(projectService),
  );

  // List all projects
  app.get('/', async (c) => {
    try {
      const projects = await projectService.listProjects();
      return c.json({ success: true, data: projects });
    } catch (error: unknown) {
      logger.error('Project storage list failed', {
        error: error instanceof Error ? error.message : 'non-Error thrown',
      });
      return c.json(
        { success: false, error: 'Project storage is unavailable' },
        500,
      );
    }
  });

  // Create project
  app.post('/', validate(projectCreateSchema), async (c) => {
    const body = normalizeProjectBody(getBody(c));
    try {
      const knownAgents = await readKnownAgents();
      if (knownAgents) {
        const diagnostics = validateProjectAgentScope(body as any, {
          knownAgents,
        });
        if (diagnostics.length > 0) {
          return c.json(integrityError(diagnostics), 400);
        }
      }
      // INERT TODAY, deliberately kept (archive#1503 delta review, R2):
      // `ProjectService.createProject` overwrites `knowledgeNamespaces` with
      // `[...BUILTIN_KNOWLEDGE_NAMESPACES]` unconditionally, so a `repoRoot` in
      // a create body is discarded before it can be persisted and this can only
      // ever refuse a value that was going to be dropped. It stays because it
      // costs nothing and becomes load-bearing the moment create stops
      // discarding the caller's namespaces — but do NOT read it as the thing
      // protecting the create path today. The update path below is the live one.
      const anchorRefusal = refuseInvalidRepoAnchors(
        typeof body.slug === 'string' ? body.slug : '',
        body,
      );
      if (anchorRefusal) {
        return c.json({ success: false, error: anchorRefusal }, 400);
      }
      const project = await projectService.createProject(body);
      projectOps.add(1, { op: 'create' });
      return c.json({ success: true, data: project }, 201);
    } catch (error: unknown) {
      // 4-HOME-007: a name collision and a lost CAS race are both 409s from
      // the storage layer, and reporting both as "Project storage changed
      // before the operation could commit" told a user creating a second
      // "Audit Alpha" nothing about the name they typed. The suggestion is
      // computed from the store that just refused the write, through the same
      // contracts helper the modal's pre-POST check uses.
      if (error instanceof FileStorageAlreadyExistsError) {
        const conflict = findProjectSlugConflict(
          error.takenSlug,
          storageAdapter.listProjects().map((project) => project.slug),
        ) ?? { takenSlug: error.takenSlug, suggestedSlug: error.takenSlug };
        const name =
          typeof body.name === 'string' && body.name.trim()
            ? body.name.trim()
            : error.takenSlug;
        return c.json(
          {
            success: false,
            error: describeProjectSlugConflict(name, conflict),
            data: conflict,
          },
          409,
        );
      }
      return c.json(
        { success: false, error: projectMutationMessage(error) },
        projectMutationStatus(error),
      );
    }
  });

  // Discover bounded, local-only project artwork. The response contains only
  // candidates inside the explicitly selected workspace and never uploads them
  // to an external service or silently changes project metadata.
  app.get('/icon-candidates', async (c) => {
    const workspacePath = c.req.query('path')?.trim();
    if (!workspacePath) {
      return c.json(
        { success: false, error: 'Workspace path is required' },
        400,
      );
    }
    try {
      const candidates = await discoverProjectIconCandidates(workspacePath);
      return c.json({ success: true, data: candidates });
    } catch (error: unknown) {
      // The masking this route owes the caller is of the PATH, never of the
      // reason: `pathAccessFailure` answers from the errno alone and its
      // strings contain neither the workspace path nor the thrown message.
      const failure = pathAccessFailure(error, 'Workspace');
      if (failure.status === 500) {
        logger.error('Workspace artwork discovery failed', {
          error: error instanceof Error ? error.message : 'non-Error thrown',
        });
      }
      return c.json({ success: false, error: failure.error }, failure.status);
    }
  });

  // Persist the explicit sidebar order (archive#3315). Registered before the
  // `/:slug` routes so the static segment can never be captured as a slug.
  app.put('/order', validate(projectReorderSchema), async (c) => {
    try {
      const { order } = getBody(c) as { order: string[] };
      const projects = await projectService.reorderProjects(order);
      projectOps.add(1, { op: 'reorder' });
      return c.json({ success: true, data: projects });
    } catch (error: unknown) {
      return c.json(
        { success: false, error: projectMutationMessage(error) },
        projectMutationStatus(error),
      );
    }
  });

  // Get project
  app.get('/:slug', async (c) => {
    try {
      const slug = param(c, 'slug');
      const project = await projectService.getProject(slug);
      const knownAgents = await readKnownAgents();
      const diagnostics = knownAgents
        ? validateProjectAgentScope(project, {
            knownAgents,
            severity: 'warning',
          })
        : [];
      return c.json({
        success: true,
        data:
          diagnostics.length > 0
            ? { ...project, _integrityDiagnostics: diagnostics }
            : project,
      });
    } catch (error: unknown) {
      const failure = projectReadFailure(error, 'Project');
      return c.json({ success: false, error: failure.error }, failure.status);
    }
  });

  // Update project
  app.put('/:slug', validate(projectUpdateSchema), async (c) => {
    try {
      const slug = param(c, 'slug');
      const body = normalizeProjectBody(getBody(c));
      const knownAgents = await readKnownAgents();
      if (knownAgents) {
        const existing = await projectService.getProject(slug);
        const diagnostics = validateProjectAgentScope(
          { ...existing, ...body },
          { knownAgents },
        );
        if (diagnostics.length > 0) {
          return c.json(integrityError(diagnostics), 400);
        }
      }
      const anchorRefusal = refuseInvalidRepoAnchors(slug, body);
      if (anchorRefusal) {
        return c.json({ success: false, error: anchorRefusal }, 400);
      }
      const isolationRefusal = refuseUnscopedWorkspaceIsolationWrite(c, body);
      if (isolationRefusal) {
        return c.json({ success: false, error: isolationRefusal }, 403);
      }
      const updated = await projectService.updateProject(slug, body);
      projectOps.add(1, { op: 'update' });
      return c.json({ success: true, data: updated });
    } catch (error: unknown) {
      return c.json(
        { success: false, error: projectMutationMessage(error) },
        projectMutationStatus(error),
      );
    }
  });

  // Delete project
  app.delete('/:slug', async (c) => {
    try {
      const slug = param(c, 'slug');
      await projectService.deleteProject(slug);
      projectOps.add(1, { op: 'delete' });
      return c.json({ success: true }, 200);
    } catch (error: unknown) {
      return c.json(
        { success: false, error: projectMutationMessage(error) },
        projectMutationStatus(error),
      );
    }
  });

  /**
   * Explicit terminal termination belongs to the TerminalService. The route
   * first resolves the Project selected by the URL, then passes only that
   * route-bound slug plus the terminal id to the service. A renderer cannot
   * close an arbitrary raw session id, and mounting a terminal renderer is
   * not a prerequisite for this operation.
   */
  app.delete('/:slug/terminals/:terminalId', async (c) => {
    try {
      const slug = param(c, 'slug');
      const terminalId = param(c, 'terminalId');
      assertSafeLayoutPathSegment('project slug', slug);
      assertSafeLayoutPathSegment('terminal id', terminalId);

      try {
        storageAdapter.getProject(slug);
      } catch {
        return c.json({ success: false, error: 'Project not found' }, 404);
      }

      if (!deps.terminalService) {
        return c.json(
          { success: false, error: 'Terminal service is unavailable' },
          503,
        );
      }

      const closed = await deps.terminalService.closeForProject(
        slug,
        terminalId,
      );
      if (!closed) {
        return c.json({ success: false, error: 'Terminal not found' }, 404);
      }
      return c.json({ success: true, data: closed });
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 400);
    }
  });

  // ── archive#1502: the resolution surface ──────────────────────────

  /**
   * DISCLOSED GAP: `IStorageAdapter` has no typed not-found error, so "this
   * project does not exist" is told apart from "reading it failed" by matching
   * the adapter's own message (`Project '<slug>' not found`). A stringly-typed
   * join, named here rather than left implicit — the alternative today is to
   * 500 an ordinary unknown-slug request or to 404 a corrupt `project.json`,
   * and both are worse. It is fail-safe in the direction that matters: an
   * unrecognized message falls through to a 500, never to a false 404.
   */
  function isProjectNotFound(error: unknown): boolean {
    return errorMessage(error).includes('not found');
  }

  /**
   * §3.6/§4.1's project-level answer. The derivation lives in
   * `project-resolution-view.ts`; this owns the envelope and the telemetry.
   *
   * It NEVER exposes `manifest.repos` — see that module's docblock for why a
   * consumer that iterated them would render a manifest with two primaries as
   * a cleanly-resolving project.
   */
  app.get('/:slug/resolution', async (c) => {
    const resolution = deps.resolution;
    if (!resolution) {
      projectResolutionRouteRequests.add(1, { outcome: 'unconfigured' });
      return c.json(
        {
          success: false,
          error:
            'Project resolution is not configured on this server. This route needs the runtime-pinned resolver and manifest store.',
        },
        501,
      );
    }
    try {
      const slug = param(c, 'slug');
      const view = await describeProjectResolution(slug, {
        resolver: resolution.resolver,
        manifests: resolution.manifests,
        bindings: resolution.bindings,
        // The runtime's OWN adapter, by construction — the recorded slice-3b
        // review finding is that a store which defaults its own
        // `FileStorageAdapter` answers from a different project store.
        source: storageAdapter,
      });
      projectResolutionRouteRequests.add(1, { outcome: view.posture });
      return c.json({ success: true, data: view });
    } catch (error: unknown) {
      const notFound = isProjectNotFound(error);
      projectResolutionRouteRequests.add(1, {
        outcome: notFound ? 'not-found' : 'failed',
      });
      return c.json(
        { success: false, error: errorMessage(error) },
        notFound ? 404 : 500,
      );
    }
  });

  /**
   * §3.6's repair action: point a resource at a checkout the operator names.
   *
   * It VERIFIES BEFORE IT RECORDS and refuses with the reason otherwise —
   * §3.6's `missing` row is "never silently re-bind", and a bind that recorded
   * whatever it was handed would be that silent re-bind with a click in front
   * of it. See `project-resource-binder.ts` decision 1.
   */
  app.post('/:slug/bind', validate(projectResourceBindSchema), async (c) => {
    const resolution = deps.resolution;
    if (!resolution) {
      projectBindingOperations.add(1, { op: 'bind', outcome: 'unconfigured' });
      return c.json(
        {
          success: false,
          error:
            'Project resource binding is not configured on this server. This route needs the runtime-pinned manifest and binding stores.',
        },
        501,
      );
    }
    try {
      const slug = param(c, 'slug');
      const revision = storageAdapter.projectRevision(slug);
      if (!revision.withCurrentRead) {
        throw new FileStorageUnavailableError(
          'Project binding requires current Project revision admission.',
        );
      }
      // Hold the owning Project revision across checkout verification, binding
      // publication and its response view. A rename/delete/replacement must not
      // retarget an operation while asynchronous Git verification is running.
      return await revision.withCurrentRead(async () => {
        const { path, resourceId } = getBody(c) as {
          path: string;
          resourceId?: string;
        };
        const result = await bindProjectResource(
          slug,
          path,
          {
            manifests: resolution.manifests,
            bindings: resolution.bindings,
            readRemotes: resolution.readRemotes,
          },
          resourceId,
        );
        if (!result.ok) {
          projectBindingOperations.add(1, { op: 'bind', outcome: result.code });
          return c.json(
            { success: false, error: result.reason },
            BIND_REFUSAL_STATUS[result.code],
          );
        }
        projectBindingOperations.add(1, { op: 'bind', outcome: 'bound' });
        // ── PHASE BOUNDARY. The row is written and durable from here on. ──
        //
        // Answer with the freshly re-derived view rather than the row that was
        // written: the row is what this Station recorded, the view is what it can
        // now truthfully say, and the surface renders the second.
        //
        // The re-derivation is a SEPARATE try on purpose. Sharing the outer one
        // answered a re-read failure with `success: false`, which the surface
        // titles "That checkout was not recorded" — a false negative about a
        // completed, durable write, telling the operator to retry a repair that
        // already succeeded. The write's outcome and the re-read's outcome are
        // two facts, and the response now carries both.
        try {
          return c.json({
            success: true,
            data: {
              recorded: true,
              view: await describeProjectResolution(slug, {
                resolver: resolution.resolver,
                manifests: resolution.manifests,
                bindings: resolution.bindings,
                source: storageAdapter,
              }),
            } satisfies ProjectResourceBindOutcome,
          });
        } catch (error: unknown) {
          projectBindingOperations.add(1, {
            op: 'bind',
            outcome: 're-derive-failed',
          });
          return c.json({
            success: true,
            data: {
              recorded: true,
              gap: `The binding was recorded. This Station could not then re-read what it can now say about this project: ${errorMessage(error)}`,
            } satisfies ProjectResourceBindOutcome,
          });
        }
      });
    } catch (error: unknown) {
      const notFound = isProjectNotFound(error);
      projectBindingOperations.add(1, {
        op: 'bind',
        outcome: notFound ? 'not-found' : 'failed',
      });
      return c.json(
        { success: false, error: errorMessage(error) },
        error instanceof FileStorageConflictError
          ? 409
          : error instanceof FileStorageUnavailableError
            ? 503
            : notFound
              ? 404
              : 500,
      );
    }
  });

  // List layouts
  app.get('/:slug/layouts', async (c) => {
    try {
      const slug = param(c, 'slug');
      assertSafeLayoutPathSegment('project slug', slug);
      // archive#1497 — no derivation here on purpose: `listLayouts` returns
      // `LayoutMetadata`, which carries no `config` at all, so the list has
      // never exposed a working directory (stale or derived) and adding one
      // would change the response shape rather than correct it.
      const layouts = storageAdapter.listLayouts(slug);
      // #2103 — each row carries the stored `config.plugin`. Withholding that
      // name on the DETAIL read while handing it over here in one request
      // would make the detail route's withholding theatre, so the same
      // predicate answers both. `tabCount` stays: it is a fact about the
      // project's own record, and it is what the picker reads.
      const canSee = viewerPluginSight(c);
      return c.json({
        success: true,
        data: canSee
          ? layouts.map((layout) =>
              layout.plugin !== undefined && !canSee(layout.plugin)
                ? { ...layout, plugin: undefined }
                : layout,
            )
          : layouts,
      });
    } catch (error: unknown) {
      const message = errorMessage(error);
      return c.json(
        { success: false, error: message },
        message.startsWith('Invalid ') ? 400 : 500,
      );
    }
  });

  // Read-only Pane catalog over the current built-in/plugin/MCP layout inputs.
  // It intentionally reports descriptors and bound instances only; renderer
  // availability, installation, authorization, and execution stay elsewhere.
  app.get('/:slug/panes', async (c) => {
    const startedAt = performance.now();
    let outcome: 'success' | 'invalid' | 'not_found' | 'failure' = 'failure';
    try {
      let slug: string;
      let project: ReturnType<typeof storageAdapter.getProject>;
      try {
        slug = param(c, 'slug');
        assertSafeLayoutPathSegment('project slug', slug);
      } catch {
        outcome = 'invalid';
        return c.json({ success: false, error: 'Invalid project slug' }, 400);
      }
      try {
        project = storageAdapter.getProject(slug);
        if (!project) {
          outcome = 'not_found';
          return c.json({ success: false, error: 'Project not found' }, 404);
        }
      } catch {
        outcome = 'not_found';
        return c.json({ success: false, error: 'Project not found' }, 404);
      }
      try {
        const response = c.json({
          success: true,
          // The route slug selects the Project record; its canonical id is the
          // exact project identity bound into Pane instances and state scopes.
          data: {
            ...readCurrentWorkspacePaneCatalog(
              await (layoutCatalog.captureCatalog?.() ?? layoutCatalog),
              project.id,
              {
                resolveInput: (candidate) =>
                  candidate.descriptor.id ===
                    WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR_ID ||
                  candidate.descriptor.id ===
                    WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR_ID ||
                  candidate.descriptor.id ===
                    WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR_ID
                    ? { context: projectWorkspacePaneContext(project) }
                    : {},
                recordTelemetry: (event) =>
                  workspacePaneAvailabilityResolutions.add(
                    1,
                    workspacePaneAvailabilityMetricAttributes(event),
                  ),
                ...(deps.canSeePlugin
                  ? {
                      canSeePlugin: (pluginId: string) =>
                        // Non-null is sound: guarded by the spread above.
                        deps.canSeePlugin!(c, pluginId),
                    }
                  : {}),
              },
              deps.kitObservabilityRegistry?.list(),
              {
                // The Board exists where a Builder run does — the same fact the
                // nav entry and the `/session-board` route guard read, from the
                // same predicate. Advertising a 'Session Board' Pane on a
                // project with no run and explaining it as a renderer that is
                // "temporarily unavailable" was a third answer to that question,
                // in a vocabulary the Board has nothing to do with.
                ...(deps.hasBuilderRun
                  ? {
                      offersLayout: (layout) =>
                        layout.type !== BUILTIN_SESSION_BOARD_LAYOUT.type ||
                        // Non-null is sound: guarded above.
                        deps.hasBuilderRun!(slug),
                    }
                  : {}),
              },
            ),
            projectSlug: project.slug,
          },
        });
        outcome = 'success';
        return response;
      } catch (error) {
        // Log the cause for operators (the response stays generic). Foreign
        // thrown values are not coerced: an arbitrary toString could itself
        // throw and escape this catch.
        logger.error('Workspace Pane catalog read failed', {
          projectSlug: slug,
          error: error instanceof Error ? error.message : 'non-Error thrown',
        });
        return c.json(
          { success: false, error: 'Workspace Pane catalog is unavailable' },
          500,
        );
      }
    } finally {
      projectOps.add(1, { op: 'list_panes', outcome });
      projectPaneCatalogDuration.record(performance.now() - startedAt, {
        outcome,
      });
    }
  });

  // Create layout
  app.post('/:slug/layouts', validate(projectLayoutCreateSchema), async (c) => {
    try {
      const slug = param(c, 'slug');
      const body = getBody(c);
      assertSafeLayoutPathSegment('project slug', slug);
      assertSafeLayoutPathSegment('layout slug', body.slug);
      const projectRevision = storageAdapter.projectRevision(slug);
      const project = projectRevision.value;

      // archive#1497 — a coding layout's working directory is derived from its
      // owning project, so it is never persisted into the layout's own config.
      // Read the project BEFORE any write, so a request that names a different
      // directory is refused without having already created the layout.
      const derived = await derivedLayoutWorkingDirectory(slug, body, project);
      // #2062 BLOCKING-2 — the two refusals below used to be written out here,
      // and promote published a project Layout past both of them. They now
      // come from `admitProjectLayoutWrite`, which promote also calls, so the
      // equality is derived rather than asserted. Refusal shapes are unchanged:
      // the module reproduces `integrityError`'s body and the working-directory
      // message verbatim.
      const admission = admitProjectLayoutWrite({
        project,
        layout: body,
        knownAgents: await readKnownAgents(),
        derivedWorkingDirectory: derived,
      });
      if (!admission.ok) return c.json(admission.body, 400);

      // `LayoutConfig.config` is required by the contract, and `listLayouts`
      // dereferences it. Before this change the coding path happened to
      // materialize it as a side effect of copying the working directory in;
      // now that the copy is gone, materialize it deliberately — for every
      // layout type — so removing the copy cannot leave a record that breaks
      // the list read.
      const now = new Date().toISOString();
      const persisted = withoutPersistedWorkingDirectory({
        ...withoutClientLayoutOwner(withoutClientCatalogContribution(body)),
        id: randomUUID(),
        projectSlug: slug,
        slug: body.slug,
        type: body.type ?? 'custom',
        config: body.config ?? {},
        createdAt: now,
        updatedAt: now,
      } as LayoutConfig);
      await projectRevision.createLayout(persisted.slug, persisted);
      projectOps.add(1, { op: 'add_layout' });
      return c.json(
        {
          success: true,
          data: withDerivedWorkingDirectory(persisted, derived),
        },
        201,
      );
    } catch (error: unknown) {
      if (error instanceof FileStorageConflictError) {
        return c.json(
          { success: false, error: projectMutationMessage(error) },
          409,
        );
      }
      return c.json(
        { success: false, error: projectMutationMessage(error) },
        projectMutationStatus(error),
      );
    }
  });

  // Get layout — resolves plugin layouts dynamically
  app.get('/:slug/layouts/:layoutSlug', async (c) => {
    try {
      const slug = param(c, 'slug');
      const layoutSlug = param(c, 'layoutSlug');
      assertSafeLayoutPathSegment('project slug', slug);
      assertSafeLayoutPathSegment('layout slug', layoutSlug);
      let layout = storageAdapter.getLayout(slug, layoutSlug);

      // #2103 — this route was an enumeration oracle: `config` is
      // `z.record(z.unknown())` and create strips only `owner` and
      // `catalogContribution`, so ANY project member could write
      // `{config: {plugin: 'a-guess'}}` and read back — from the live merge
      // below and the catalog backfill after it — whether that plugin is
      // installed, with its tabs, its version and its `plugins/<name>`
      // source. Both reads are skipped for a caller who cannot see the
      // owning plugin, and the two fields naming it are withheld, so a
      // hidden plugin and a name nobody ever installed answer identically.
      const canSee = viewerPluginSight(c);
      const withheld = layoutPluginBindingWithheld(layout, {
        canSeePlugin: canSee,
      });
      const paneReferences = resolveLayoutPaneReferences(layout, {
        canSeePlugin: canSee,
      });

      // Dynamic resolution: if layout references a plugin, merge fresh layout data
      const pluginName = withheld ? undefined : (layout.config as any)?.plugin;
      if (pluginName && projectHomeDir) {
        const ws = readPluginLayout(projectHomeDir, pluginName);
        if (ws) {
          layout.config = {
            ...(layout.config as any),
            tabs: ws.tabs,
            globalSkills: ws.globalSkills,
            defaultAgent: ws.defaultAgent,
            availableAgents: ws.availableAgents,
            requiredProviders: ws.requiredProviders,
          };
        }
        // Legacy plugin layouts predate catalog attribution. Resolve their
        // contribution from the installed plugin catalog for this response so
        // the UI keeps their declared tabs as the rendering authority. This
        // is intentionally not persisted: catalog attribution remains issued
        // only by the catalog-apply path.
        if (layout.catalogContribution === undefined) {
          const contribution = layoutCatalog
            .listLayouts()
            .find(
              (candidate) =>
                candidate.source === 'plugin' &&
                candidate.plugin === pluginName,
            )?.contribution;
          if (contribution) {
            layout = { ...layout, catalogContribution: contribution };
          }
        }
      }

      if (withheld) layout = withoutPluginBinding(layout);

      // archive#1497 — derive the working directory from the owning project
      // rather than backfilling only when absent. A copy persisted before this
      // change is discarded here, which is what makes it inert on upgrade
      // without any rewrite of existing installs.
      const derived = withDerivedWorkingDirectory(
        layout,
        await derivedLayoutWorkingDirectory(slug, layout),
      );

      const knownAgents = await readKnownAgents();
      const diagnostics = knownAgents
        ? validateLayoutAgentReferences(
            storageAdapter.getProject(slug),
            derived,
            {
              knownAgents,
              severity: 'warning',
            },
          )
        : [];
      // Typed against the contract, and ASSIGNED rather than spread, so the
      // wire key is really checked (#2090 review). Naming the extra member
      // instead of an index signature was not enough on its own: TypeScript
      // does not excess-property-check spread-originated properties, so
      // `...(x ? { paneReferencess: x } : {})` typechecked clean and the
      // field simply vanished from the response. A direct assignment to a
      // typed binding does error (probed: TS2551).
      const data: LayoutReadView & { _integrityDiagnostics?: unknown } = {
        ...derived,
      };
      if (diagnostics.length > 0) data._integrityDiagnostics = diagnostics;
      // #2090. Response-only, and absent unless something really is
      // withheld — `PUT` strips it back off for the same reason the derived
      // working directory is stripped: the storage schema is `.strict()`, so
      // a client that read this record and PUT it back would otherwise be
      // refused by storage.
      if (paneReferences) data.paneReferences = paneReferences;
      return c.json({ success: true, data });
    } catch (error: unknown) {
      // An author's retired key is a 400 they can act on, not the storage
      // failure the generic arm below would report it as.
      if (error instanceof RetiredLayoutKeyError) {
        return c.json({ success: false, error: errorMessage(error) }, 400);
      }
      const message = errorMessage(error);
      if (!message.startsWith('Invalid ')) {
        const failure = projectReadFailure(error, 'Layout');
        return c.json({ success: false, error: failure.error }, failure.status);
      }
      return c.json({ success: false, error: message }, 400);
    }
  });

  // Update layout
  app.put(
    '/:slug/layouts/:layoutSlug',
    validate(projectLayoutUpdateSchema),
    async (c) => {
      try {
        const slug = param(c, 'slug');
        const layoutSlug = param(c, 'layoutSlug');
        const body = getBody(c);
        assertSafeLayoutPathSegment('project slug', slug);
        assertSafeLayoutPathSegment('layout slug', layoutSlug);
        const revision = storageAdapter.layoutRevision(slug, layoutSlug);
        const existing = revision.value;
        const immutableMismatch = layoutImmutableMismatch(
          existing,
          slug,
          layoutSlug,
          body,
        );
        if (immutableMismatch) {
          return c.json(
            {
              success: false,
              error: immutableMismatch,
            },
            409,
          );
        }
        // #2090/#2103 — the GET withholds this caller's view of the owning
        // plugin, so the write path has to put both halves back:
        //
        //  - `paneReferences` is response-only and the storage schema is
        //    `.strict()`, so a GET→PUT round trip would be a hard storage
        //    rejection. Stripped here exactly as the derived working
        //    directory is, and for the same recorded reason.
        //  - every `config` key the read REMOVED is missing from what this
        //    caller read back, and `config` is replaced wholesale here, so
        //    an ordinary rename would destroy them. Restored by
        //    `withPluginBindingRestored`, which shares its key list with the
        //    strip — the first version of this restored `plugin` and lost
        //    `actions` and `globalSkills`, and nothing re-derives `actions`.
        //
        // DISCLOSED ORDERING (#2090 review): the agent-reference validation
        // below runs on the PRE-restore config, so a withheld caller's write
        // is not validated over the keys the restore puts back. There is no
        // loss and no leak — those values are the stored ones, which were
        // validated when they were written — but a visible caller gets a 400
        // where a withheld one gets a 200 for the same stored content.
        const withheld = layoutPluginBindingWithheld(existing, {
          canSeePlugin: viewerPluginSight(c),
        });
        // id, projectSlug, slug, and createdAt are immutable record identity.
        // updatedAt is server-owned. Only mutable fields replace their stored
        // values, so a partial rename cannot erase the saved LayoutDefinition.
        const layout = {
          ...existing,
          ...withoutClientLayoutOwner(
            withoutClientCatalogContribution(withoutPaneReferences(body)),
          ),
          id: existing.id,
          projectSlug: slug,
          slug: layoutSlug,
          createdAt: existing.createdAt,
          updatedAt: new Date().toISOString(),
          ...(existing.catalogContribution === undefined
            ? {}
            : { catalogContribution: existing.catalogContribution }),
        };
        const validLayout = projectLayoutCreateSchema.safeParse(layout);
        if (!validLayout.success) {
          return c.json(
            {
              success: false,
              error:
                validLayout.error.issues[0]?.message ??
                'Invalid merged layout definition',
            },
            400,
          );
        }
        const knownAgents = await readKnownAgents();
        if (knownAgents) {
          const project = storageAdapter.getProject(slug);
          const diagnostics = validateLayoutAgentReferences(project, layout, {
            knownAgents,
          });
          if (diagnostics.length > 0) {
            return c.json(integrityError(diagnostics), 400);
          }
        }
        // archive#1497 — stripping here is what makes the fix converge on
        // disk. Without it a GET (which now derives the value) followed by a
        // PUT (a rename, say) would re-plant the derived path as a fresh
        // persisted copy, and any layout carrying a pre-fix copy would keep it
        // forever. A request that names a *different* directory is refused by
        // name instead (checked against the request body, so a rename of a
        // layout carrying a pre-fix copy still succeeds and clears it).
        const derived = await derivedLayoutWorkingDirectory(slug, layout);
        const conflict = conflictingWorkingDirectory(
          slug,
          layout.type,
          body,
          derived,
        );
        if (conflict) return c.json({ success: false, error: conflict }, 400);
        const merged = { ...layout, config: layout.config ?? {} };
        const persisted = withoutPersistedWorkingDirectory(
          withheld ? withPluginBindingRestored(merged, existing) : merged,
        );
        await revision.replace(persisted);
        // The write's own answer is projected exactly as the read is: a
        // response that handed back the plugin name the GET withheld would
        // reopen the same oracle one verb over.
        const canSee = viewerPluginSight(c);
        const paneReferences = resolveLayoutPaneReferences(persisted, {
          canSeePlugin: canSee,
        });
        const answered = layoutPluginBindingWithheld(persisted, {
          canSeePlugin: canSee,
        })
          ? withoutPluginBinding(persisted)
          : persisted;
        const data: LayoutReadView = {
          ...withDerivedWorkingDirectory(answered, derived),
        };
        if (paneReferences) data.paneReferences = paneReferences;
        return c.json({ success: true, data });
      } catch (error: unknown) {
        const message = errorMessage(error);
        return c.json(
          { success: false, error: projectMutationMessage(error) },
          projectMutationStatus(
            error,
            message.includes('not found') ? 404 : 400,
          ),
        );
      }
    },
  );

  // Delete layout
  app.delete('/:slug/layouts/:layoutSlug', async (c) => {
    try {
      const slug = param(c, 'slug');
      const layoutSlug = param(c, 'layoutSlug');
      assertSafeLayoutPathSegment('project slug', slug);
      assertSafeLayoutPathSegment('layout slug', layoutSlug);
      await storageAdapter.deleteLayout(slug, layoutSlug);
      projectOps.add(1, { op: 'remove_layout' });
      return c.json({ success: true }, 200);
    } catch (error: unknown) {
      return c.json(
        { success: false, error: projectMutationMessage(error) },
        projectMutationStatus(error),
      );
    }
  });

  // ── Available layout sources (plugins + built-in types) ──

  // #2067: projected. This returned `listLayouts()` raw with no principal
  // resolved at all — the picker a project applies a layout from, carrying
  // every plugin's name and `plugins/<name>` source. Narrowed rather than
  // refused: choosing a layout is a composition act, not maintenance.
  app.get('/layouts/available', (c) => {
    try {
      return c.json({
        success: true,
        data: projectLayoutCatalogItems(
          layoutCatalog.listLayouts(),
          deps.canSeePlugin
            ? (pluginId: string) => deps.canSeePlugin!(c, pluginId)
            : undefined,
        ),
      });
    } catch (e: unknown) {
      return c.json({ success: false, error: errorMessage(e) }, 500);
    }
  });

  async function applyCatalogLayout(
    slug: string,
    layoutId: string,
    canSeePlugin?: (pluginId: string) => boolean,
  ) {
    assertSafeLayoutPathSegment('project slug', slug);
    // #2103 — apply had no visibility check at all, so a member could apply a
    // hidden plugin's layout into a shared project (and learn it exists from
    // the 201).
    //
    // The check runs BEFORE `resolveForApply`, deliberately. `resolveForApply`
    // is `resolveForCatalog` plus an installed-and-enabled check, and those
    // two refusals carry DIFFERENT messages — so checking visibility after it
    // would let a caller guessing catalog ids tell "exists here, disabled"
    // from "does not exist". `resolveForCatalog` answers the same way for an
    // unknown id and an uninstalled one, so a refusal issued here is the
    // message an id nobody has already gets, verbatim.
    //
    // Guarded on `canSeePlugin` rather than run unconditionally, so a
    // composition with no projection makes no extra catalog call at all —
    // absence changes nothing, including which methods this path requires.
    if (canSeePlugin) {
      const forVisibility = layoutCatalog.resolveForCatalog(layoutId);
      // The SAME derivation the read routes use, called rather than
      // restated. An earlier version inlined the identity set here; it
      // agreed with the helper on the day it was written, which is exactly
      // the shape `runtime-routes.ts` records as "a second reader of an
      // authorized store eventually gets the authorization wrong". A catalog
      // item is shaped into the layout the helper reads: its `pluginName` is
      // this path's merge key, and its contribution is the same field a
      // stored layout carries.
      const asStoredLayout = {
        config: forVisibility.pluginName
          ? { plugin: forVisibility.pluginName }
          : {},
        ...(forVisibility.item.contribution
          ? { catalogContribution: forVisibility.item.contribution }
          : {}),
      };
      if (layoutPluginBindingWithheld(asStoredLayout, { canSeePlugin })) {
        throw new Error('Layout is not a known installed contribution');
      }
    }
    const resolved = layoutCatalog.resolveForApply(layoutId);
    const pluginManifest = resolved.pluginName
      ? layoutCatalog.getPluginManifest(resolved.pluginName)
      : undefined;
    if (pluginManifest?.knowledge?.namespaces?.length) {
      refusePluginRepoAnchors(
        resolved.pluginName as string,
        pluginManifest.knowledge.namespaces,
      );
    }
    // Namespace convergence is a create prerequisite. It is idempotent and
    // completes before any Layout effect, so a Project CAS conflict cannot
    // leave a created Layout behind or make retry choose another slug.
    if (pluginManifest) {
      await registerPluginNamespaces(storageAdapter, slug, pluginManifest);
    }
    const projectRevision = storageAdapter.projectRevision(slug);
    const project = projectRevision.value;
    const existingSlugs = new Set(
      storageAdapter.listLayouts(slug).map((layout) => layout.slug),
    );
    let layoutSlug = resolved.definition.slug;
    for (let suffix = 2; existingSlugs.has(layoutSlug); suffix += 1) {
      layoutSlug = `${resolved.definition.slug}-${suffix}`;
    }
    const now = new Date().toISOString();
    const layout = {
      id: randomUUID(),
      projectSlug: slug,
      type: resolved.definition.type,
      name: resolved.definition.name,
      slug: layoutSlug,
      icon: resolved.definition.icon,
      description: resolved.definition.description,
      catalogContribution: resolved.item.contribution,
      // archive#1497 — a catalog-materialized coding layout no longer embeds
      // the project's working directory in its persisted config; the read
      // paths derive it.
      config: resolved.pluginName
        ? {
            plugin: resolved.pluginName,
            tabs: resolved.definition.tabs,
            globalSkills: resolved.definition.globalSkills,
            defaultAgent: resolved.definition.defaultAgent,
            availableAgents: resolved.definition.availableAgents,
            requiredProviders: resolved.definition.requiredProviders,
          }
        : {},
      createdAt: now,
      updatedAt: now,
    };
    const knownAgents = await readKnownAgents();
    if (knownAgents) {
      const diagnostics = validateLayoutAgentReferences(project, layout, {
        knownAgents,
      });
      if (diagnostics.length > 0)
        throw Object.assign(new Error(diagnostics[0].message), { diagnostics });
    }
    await projectRevision.createLayout(layout.slug, layout);
    projectOps.add(1, {
      op: 'apply_catalog_layout',
      source: resolved.item.source,
    });
    // The stored record carries no working directory; the returned one carries
    // the derived value, so the apply response is unchanged for its caller.
    return withDerivedWorkingDirectory(layout, project.workingDirectory);
  }

  // One apply path for enabled installed built-ins and plugin layouts.
  app.post(
    '/:slug/layouts/apply',
    validate(projectLayoutApplySchema),
    async (c) => {
      try {
        const layout = await applyCatalogLayout(
          param(c, 'slug'),
          getBody(c).layoutId,
          viewerPluginSight(c),
        );
        return c.json({ success: true, data: layout }, 201);
      } catch (error: unknown) {
        if (error instanceof FileStorageConflictError) {
          return c.json(
            { success: false, error: projectMutationMessage(error) },
            409,
          );
        }
        return c.json(
          { success: false, error: projectMutationMessage(error) },
          projectMutationStatus(error),
        );
      }
    },
  );

  // Compatibility endpoint: it selects an installed plugin catalog item and delegates above.
  app.post(
    '/:slug/layouts/from-plugin',
    validate(projectLayoutFromPluginSchema),
    async (c) => {
      try {
        const pluginName = getBody(c).plugin;
        const canSee = viewerPluginSight(c);
        // #2103 — this searched `listLayouts()` unprojected and answered
        // 404-by-name, which is an existence oracle for anybody guessing
        // names. Projected through the same helper `GET /layouts/available`
        // uses, so a hidden plugin misses the lookup and gets the identical
        // 404 an uninstalled name gets.
        const item = projectLayoutCatalogItems(
          layoutCatalog.listLayouts(),
          canSee,
        ).find(
          (candidate) =>
            candidate.source === 'plugin' && candidate.plugin === pluginName,
        );
        if (!item)
          return c.json(
            { success: false, error: `Plugin '${pluginName}' has no layout` },
            404,
          );
        const layout = await applyCatalogLayout(
          param(c, 'slug'),
          item.id,
          canSee,
        );
        return c.json({ success: true, data: layout }, 201);
      } catch (error: unknown) {
        return c.json(
          { success: false, error: projectMutationMessage(error) },
          projectMutationStatus(error),
        );
      }
    },
  );

  return app;
}

/**
 * A Layout reached through `/:slug/layouts` is owned by that route's project,
 * always. Ownership is issued by the route, never accepted from the body —
 * the same rule catalog attribution follows below, and the reason a request
 * cannot relocate somebody's Layout under a principal by naming one (#2060).
 */
function withoutClientLayoutOwner<T extends Record<string, unknown>>(
  value: T,
): Omit<T, 'owner'> {
  const { owner: _owner, ...withoutOwner } = value;
  return withoutOwner;
}

/**
 * #2090 — `paneReferences` is a READ verdict about the calling principal. It
 * is never storage, and the storage schema is `.strict()`, so a client that
 * PUT back a record it had read would otherwise be refused by the store
 * rather than by anything that could explain itself. Stripped for the same
 * reason and in the same place as the derived working directory.
 */
function withoutPaneReferences<T extends Record<string, unknown>>(
  value: T,
): Omit<T, 'paneReferences'> {
  const { paneReferences: _paneReferences, ...rest } = value;
  return rest;
}

/** Catalog attribution is issued only by the catalog-apply path. */
function withoutClientCatalogContribution<T extends Record<string, unknown>>(
  value: T,
): Omit<T, 'catalogContribution'> {
  const { catalogContribution: _catalogContribution, ...withoutContribution } =
    value;
  return withoutContribution;
}

function layoutImmutableMismatch(
  // Narrowed to exactly the two fields this reads: the route supplies the
  // project and layout slugs it compares against, so widening the parameter
  // to the whole record only invites a second reader of ownership.
  existing: {
    id: string;
    createdAt: string;
  },
  projectSlug: string,
  layoutSlug: string,
  update: Record<string, unknown>,
): string | undefined {
  const immutable: readonly [string, unknown, unknown][] = [
    ['id', existing.id, update.id],
    ['projectSlug', projectSlug, update.projectSlug],
    ['slug', layoutSlug, update.slug],
    ['createdAt', existing.createdAt, update.createdAt],
  ];
  for (const [field, expected, received] of immutable) {
    if (received !== undefined && received !== expected) {
      return `Layout ${field} in the request body must match the stored route identity`;
    }
  }
  return undefined;
}

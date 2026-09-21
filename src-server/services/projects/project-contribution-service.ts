import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { AppConfig } from '@kontourai/station-contracts/config';
import {
  CONTRIBUTION_DIAGNOSTIC_ID,
  CONTRIBUTION_PROJECTION_SCHEMA_VERSION,
  type ContributionConfig,
  type ContributionProjection,
  contributionScopeKey,
  declaredContributionIds,
  isContributionEnabled,
  resolveScopedContribution,
} from '@kontourai/station-contracts/contribution';
import { PORTABLE_EXECUTION_CONSENT_METADATA_KEY } from '@kontourai/station-contracts/provider';
import type { ConfigLoader } from '../../domain/config-loader.js';
import {
  FileStorageConflictError,
  FileStorageNotFoundError,
} from '../../domain/project-file-transactions.js';
import type { IStorageAdapter } from '../../domain/storage-adapter.js';
import { expandTilde } from '../../utils/paths.js';
import type { ProjectBindingsStore } from './project-binding-store.js';
import type { ProjectManifestStore } from './project-manifest-store.js';
import type { ProjectResourceResolver } from './project-resource-resolver.js';

export interface ProjectExecutionOfferMutation {
  portableProjectId: string;
  localProjectId: string;
  resourceId: string;
  expected: ContributionConfig | null;
  enabled: boolean;
}

export interface ProjectContributionQuery {
  portableProjectId: string;
  resourceId: string;
}

/**
 * A peer's explicit portable-execution intent was REFUSED at the receiving
 * boundary (#484 phase A). Mapped to 403 by the delegation route; the
 * message is operator-actionable contribution diagnostic vocabulary and
 * never carries a local path or binding inventory.
 */
export class ReceiverExecutionRefusal extends Error {
  constructor(
    readonly code:
      | 'receiver_execution_not_offered'
      | 'receiver_execution_unavailable'
      | 'receiver_execution_forwarding_refused'
      | 'receiver_execution_authority_changed',
    message: string,
  ) {
    super(message);
    this.name = 'ReceiverExecutionRefusal';
  }
}

/** The server-minted portable consent identity stamped on a session binding. */
export interface PortableExecutionConsentIdentity {
  portableProjectId: string;
  resourceId: string;
}

/**
 * #484 phase A follow-up: read the server-minted portable consent marker off
 * persisted session binding metadata (`session.started` / `session.configured`).
 * Returns the consent identity for a thread that started as an explicit
 * portable execution, or undefined for ordinary and legacy sessions. Public
 * callers can neither forge this (the reserved-key strip removes it from
 * every start input; only the internal-only consent re-stamp writes it) nor
 * clear it by omission (reads are off persisted events, never the request).
 * Shared by the orchestration service and the session command module so the
 * association proof never drifts between the two effect seams.
 */
export function portableConsentOfStartedMetadata(
  metadata: Record<string, unknown> | undefined,
): PortableExecutionConsentIdentity | undefined {
  const marker = metadata?.[PORTABLE_EXECUTION_CONSENT_METADATA_KEY];
  if (!marker || typeof marker !== 'object') return undefined;
  const { portableProjectId, resourceId } = marker as Record<string, unknown>;
  if (typeof portableProjectId !== 'string' || typeof resourceId !== 'string')
    return undefined;
  return { portableProjectId, resourceId };
}

/**
 * The receiver-owned admission for one explicit portable-execution intent:
 * the captured receiver-local Project binding (its `workingDirectory` is the
 * execution root) plus a `recheck` that must be awaited before EVERY
 * irreversible effect (session start, turn dispatch, workspace
 * provisioning). The recheck compares freshly-read state against the
 * CAPTURED scalars, so a withdrawn offer, a replaced checkout, or a lost
 * binding refuses instead of re-resolving to a different workspace.
 */
export interface ReceiverExecutionAdmission {
  /**
   * The EXACT consent identity this admission was captured for — the caller
   * sent portable Project id plus offered resource id. Consumers must
   * refuse when the workspace they are about to execute names a different
   * pair rather than re-targeting the admitted project.
   */
  readonly portableProjectId: string;
  readonly resourceId: string;
  readonly admittedProject: {
    readonly slug: string;
    readonly workingDirectory: string;
    /**
     * The canonical path the resolver owner checked for the EXACT requested
     * resource (`resolution.path`) — NOT the compat `workingDirectory`,
     * which names only the project's default checkout. A non-default bound
     * repo (or a repository-relative execution root) resolves elsewhere;
     * executing the default there would run the wrong checkout.
     */
    readonly resourcePath: string;
    /**
     * The canonical manifest execution root when it selects the requested
     * resource; absent when the manifest declares none (or selects another
     * resource). The provider must start in `executionRoot ?? resourcePath`.
     */
    readonly executionRoot?: string;
  };
  readonly recheck: () => Promise<void>;
}

/**
 * The exact directory one admitted portable intent must execute in: the
 * manifest execution root when it selects the admitted resource, else the
 * admitted resource's own bound path. Never the compat workingDirectory.
 */
export function receiverAdmittedCwd(
  admitted: ReceiverExecutionAdmission['admittedProject'],
): string {
  return admitted.executionRoot ?? admitted.resourcePath;
}

/**
 * The owned pre-await identity baseline for ONE portable admission capture:
 * the exact Project record, manifest content (including the execution-root
 * selection), and binding row the admission was captured against. Every
 * field is a `structuredClone` owned by the capture — never a live store
 * row — so an in-place withdraw+rebind during an await cannot mutate the
 * baseline. Compared both within a capture (before vs after its own
 * awaits) and across invocations (fresh capture vs the ORIGINAL admission's
 * baseline), so replacing the Project, manifest, or binding with a
 * different identity under the same cwd refuses instead of executing.
 * Module-private: the public admission carries only the admitted
 * coordinates, never this baseline.
 */
interface CapturedReceiverIdentity {
  readonly projectId: string;
  readonly manifest: {
    readonly id: string;
    readonly slug: string;
    readonly repos: unknown;
  };
  readonly binding: unknown;
  readonly executionSelection: unknown;
}

interface Deps {
  source: Pick<IStorageAdapter, 'listProjects' | 'projectRevision'>;
  manifests: Pick<ProjectManifestStore, 'readProjectManifest'>;
  bindings: Pick<ProjectBindingsStore, 'findBinding'>;
  resolver: Pick<
    ProjectResourceResolver,
    'resolveProjectResource' | 'resolveProjectExecutionRoot'
  >;
  config: Pick<ConfigLoader, 'loadAppConfig' | 'mutateAppConfig'>;
  now?: () => Date;
}

export class ProjectContributionService {
  constructor(private readonly deps: Deps) {}

  private association(portableProjectId: string, localProjectId?: string) {
    const matches = this.deps.source
      .listProjects()
      .filter((project) => !localProjectId || project.id === localProjectId)
      .map((project) => ({
        project,
        manifest: this.deps.manifests.readProjectManifest(project.slug),
      }))
      .filter((entry) => entry.manifest?.id === portableProjectId);
    if (matches.length !== 1)
      throw new FileStorageNotFoundError(
        'Project contribution is unavailable.',
      );
    return matches[0] as {
      project: (typeof matches)[number]['project'];
      manifest: NonNullable<(typeof matches)[number]['manifest']>;
    };
  }

  async setExecutionOffer(
    input: ProjectExecutionOfferMutation,
    authorityCurrent: () => boolean,
  ): Promise<ContributionConfig> {
    const requested = structuredClone(input);
    const { project, manifest } = this.association(
      requested.portableProjectId,
      requested.localProjectId,
    );
    if (
      !manifest.repos.some((resource) => resource.id === requested.resourceId)
    )
      throw new FileStorageNotFoundError(
        'Project contribution is unavailable.',
      );
    const revision = this.deps.source.projectRevision(project.slug);
    if (!revision.withCurrentRead)
      throw new Error('Current Project admission is unavailable.');
    return revision.withCurrentRead(async (currentProject) => {
      if (currentProject.id !== requested.localProjectId)
        throw new FileStorageConflictError('Project association changed.');
      let result!: ContributionConfig;
      await this.deps.config.mutateAppConfig((current) => {
        if (!authorityCurrent())
          throw new FileStorageConflictError('Offer authority changed.');
        const currentManifest = this.deps.manifests.readProjectManifest(
          currentProject.slug,
        );
        if (
          currentManifest?.id !== requested.portableProjectId ||
          !currentManifest.repos.some(
            (resource) => resource.id === requested.resourceId,
          )
        )
          throw new FileStorageConflictError('Project association changed.');
        const scope = {
          kind: 'project' as const,
          projectId: requested.portableProjectId,
        };
        const key = contributionScopeKey(scope);
        const selected = resolveScopedContribution(current, scope);
        const actual = selected.origin === 'absent' ? null : selected.config;
        if (!isDeepStrictEqual(actual, requested.expected))
          throw new FileStorageConflictError(
            'Project execution offer changed.',
          );
        const repoIds = new Set(
          declaredContributionIds(selected.config, 'execution'),
        );
        const otherExecution = [...repoIds].filter(
          (id) => id !== requested.resourceId,
        );
        const otherAxes =
          declaredContributionIds(selected.config, 'agents').length +
          declaredContributionIds(selected.config, 'inference').length;
        if (
          requested.enabled &&
          !isContributionEnabled(selected.config) &&
          (otherExecution.length > 0 || otherAxes > 0)
        )
          throw new FileStorageConflictError(
            'Enabling this resource would activate unrelated contribution.',
          );
        if (requested.enabled) repoIds.add(requested.resourceId);
        else repoIds.delete(requested.resourceId);
        const remaining = repoIds.size + otherAxes;
        result = {
          ...selected.config,
          enabled: requested.enabled
            ? true
            : isContributionEnabled(selected.config) && remaining > 0,
          execution: { repoIds: [...repoIds].sort() },
        };
        return {
          contribution: { ...(current.contribution ?? {}), [key]: result },
        } satisfies Partial<AppConfig>;
      });
      return result;
    });
  }

  async query(
    input: ProjectContributionQuery,
    authorityCurrent: () => boolean,
  ): Promise<ContributionProjection> {
    const requested = structuredClone(input);
    const scope = {
      kind: 'project' as const,
      projectId: requested.portableProjectId,
    };
    const now = (this.deps.now ?? (() => new Date()))();
    const base: Pick<
      ContributionProjection,
      'schemaVersion' | 'scope' | 'projectedAt' | 'agents' | 'inference'
    > = {
      schemaVersion: CONTRIBUTION_PROJECTION_SCHEMA_VERSION,
      scope,
      projectedAt: now.toISOString(),
      agents: [],
      inference: [],
    };
    const config = await this.deps.config.loadAppConfig();
    const selected = resolveScopedContribution(config, scope);
    const offered =
      isContributionEnabled(selected.config) &&
      declaredContributionIds(selected.config, 'execution').includes(
        requested.resourceId,
      );
    if (!offered) {
      if (!authorityCurrent())
        throw new FileStorageConflictError('Query authority changed.');
      return {
        ...base,
        sourceObservedAt: null,
        participation: isContributionEnabled(selected.config)
          ? 'nothing-contributed'
          : 'disabled',
        execution: [],
        diagnostics: [
          {
            axis: 'execution',
            resourceId: CONTRIBUTION_DIAGNOSTIC_ID,
            code: isContributionEnabled(selected.config)
              ? 'contribution-empty'
              : 'contribution-disabled',
            message:
              'This Station does not offer the requested Project resource.',
          },
        ],
      };
    }
    let association: ReturnType<ProjectContributionService['association']>;
    try {
      association = this.association(requested.portableProjectId);
    } catch {
      return this.unavailable(base, requested.resourceId);
    }
    // Capture WHAT the answer is about — the Project record (id, slug, and
    // the compat workingDirectory the resolver resolves against) and the
    // relevant manifest content (identity, slug, and the declared repos) —
    // BEFORE the async read. A wall-clock `updatedAt` is a label, not a
    // revision: a same-timestamp resource or checkout replacement must not
    // let a captured resolution answer for a project that no longer is one.
    const associationSnapshot = {
      projectId: association.project.id,
      projectSlug: association.project.slug,
      // The stored `~/...` compat workingDirectory is EXPANDED at the read
      // (station#3155) so identity comparison happens on absolute paths —
      // `~/x` and its spelled-out form are the same checkout. Pure
      // comparison; nothing here reads or writes the path.
      projectWorkingDirectory:
        association.project.workingDirectory === undefined
          ? undefined
          : resolve(expandTilde(association.project.workingDirectory)),
      manifest: structuredClone({
        id: association.manifest.id,
        slug: association.manifest.slug,
        repos: association.manifest.repos,
      }),
    };
    if (
      !association.manifest.repos.some(
        (resource) => resource.id === requested.resourceId,
      )
    )
      return this.unavailable(base, requested.resourceId);
    // OWN the pre-await binding snapshot: `findBinding` hands back the
    // store's live record, so an in-place withdraw+rebind recorded onto the
    // same row during the async read would otherwise mutate "before" and
    // "after" together and project the new observation under the old
    // resolution verdict.
    const beforeBinding = structuredClone(
      this.deps.bindings.findBinding(
        requested.portableProjectId,
        requested.resourceId,
      ),
    );
    const resolution = await this.deps.resolver.resolveProjectResource(
      association.project.slug,
      requested.resourceId,
    );
    const currentConfig = await this.deps.config.loadAppConfig();
    const currentSelected = resolveScopedContribution(currentConfig, scope);
    const stillOffered =
      isContributionEnabled(currentSelected.config) &&
      declaredContributionIds(currentSelected.config, 'execution').includes(
        requested.resourceId,
      );
    let sameAssociation = false;
    try {
      const currentAssociation = this.association(requested.portableProjectId);
      // Same expand-at-the-read identity comparison as the snapshot above.
      const currentWorkingDirectory =
        currentAssociation.project.workingDirectory === undefined
          ? undefined
          : resolve(expandTilde(currentAssociation.project.workingDirectory));
      sameAssociation =
        currentAssociation.project.id === associationSnapshot.projectId &&
        currentAssociation.project.slug === associationSnapshot.projectSlug &&
        currentWorkingDirectory ===
          associationSnapshot.projectWorkingDirectory &&
        isDeepStrictEqual(
          {
            id: currentAssociation.manifest.id,
            slug: currentAssociation.manifest.slug,
            repos: currentAssociation.manifest.repos,
          },
          associationSnapshot.manifest,
        );
    } catch {}
    const afterBinding = this.deps.bindings.findBinding(
      requested.portableProjectId,
      requested.resourceId,
    );
    if (!authorityCurrent())
      throw new FileStorageConflictError('Query authority changed.');
    if (
      !stillOffered ||
      !sameAssociation ||
      !isDeepStrictEqual(beforeBinding, afterBinding)
    )
      return this.unavailable(base, requested.resourceId);
    const verifiedAt = beforeBinding?.verifiedAt ?? null;
    const bound = resolution.state === 'bound';
    return {
      ...base,
      sourceObservedAt:
        verifiedAt === null ? null : new Date(verifiedAt).toISOString(),
      participation: bound ? 'contributing' : 'contributed-unavailable',
      execution: [{ repoId: requested.resourceId, bound, verifiedAt }],
      diagnostics: bound
        ? []
        : [
            {
              axis: 'execution',
              resourceId: requested.resourceId,
              code: 'contribution-unavailable-resource',
              message: 'The offered Project resource is unavailable.',
            },
          ],
    };
  }

  private unavailable(
    base: Pick<
      ContributionProjection,
      'schemaVersion' | 'scope' | 'projectedAt' | 'agents' | 'inference'
    >,
    resourceId: string,
  ): ContributionProjection {
    return {
      ...base,
      sourceObservedAt: null,
      participation: 'contributed-unavailable',
      execution: [{ repoId: resourceId, bound: false, verifiedAt: null }],
      diagnostics: [
        {
          axis: 'execution',
          resourceId,
          code: 'contribution-unavailable-resource',
          message: 'The offered Project resource is unavailable.',
        },
      ],
    };
  }

  /**
   * #484 phase A: admit (or refuse) ONE explicit portable-execution intent
   * against this Station's operator offer. The predicate is the same chain
   * the projection query uses — offer on, exactly this resource declared,
   * content-identical Project association, resource currently `bound` —
   * evaluated with the same snapshot discipline: scalars and nested objects
   * are owned by `structuredClone` before any await, and the `recheck`
   * re-runs the WHOLE chain against the captured scalars so a withdrawn
   * offer, a replaced checkout, or a lost binding refuses instead of
   * re-resolving to a different workspace. There is no slug/path fallback:
   * absence of a current explicit offer refuses.
   *
   * The returned admission carries the receiver-local Project binding; its
   * `workingDirectory` is stored tilde-literal in the project record and is
   * returned here EXPANDED (station#3155) so consumers compare or execute
   * only against the absolute path. It ALSO carries the resolver owner's
   * checked canonical path for the exact requested resource
   * (`resourcePath`) plus the manifest execution root when it selects that
   * resource (`executionRoot`): the provider must start in
   * `executionRoot ?? resourcePath`, never in the compat default.
   */
  async authorizeReceiverExecution(
    input: ProjectContributionQuery,
    authorityCurrent: () => boolean,
  ): Promise<ReceiverExecutionAdmission> {
    const requested = structuredClone(input);
    const first = await this.captureReceiverAdmission(
      requested,
      authorityCurrent,
    );
    // OWN the original identity continuity: the recheck below compares
    // freshly-read state against THESE captured scalars — never against a
    // re-resolved association that could have drifted onto a different
    // Project, manifest, or binding hiding under the same cwd. The closure
    // owns the object; it is never handed out, so no caller alias can
    // mutate the baseline out from under the next recheck.
    const originalIdentity = first.identity;
    const admittedProject = Object.freeze({ ...first.admitted });
    return {
      portableProjectId: requested.portableProjectId,
      resourceId: requested.resourceId,
      admittedProject,
      recheck: async () => {
        await this.captureReceiverAdmission(requested, authorityCurrent, {
          admitted: admittedProject,
          identity: originalIdentity,
        });
      },
    };
  }

  private async captureReceiverAdmission(
    input: ProjectContributionQuery,
    authorityCurrent: () => boolean,
    expect?: {
      admitted: ReceiverExecutionAdmission['admittedProject'];
      identity: CapturedReceiverIdentity;
    },
  ): Promise<{
    admitted: ReceiverExecutionAdmission['admittedProject'];
    identity: CapturedReceiverIdentity;
  }> {
    const unavailable = () =>
      new ReceiverExecutionRefusal(
        'receiver_execution_unavailable',
        'The offered Project resource is unavailable.',
      );
    const requested = structuredClone(input);
    const scope = {
      kind: 'project' as const,
      projectId: requested.portableProjectId,
    };
    const config = await this.deps.config.loadAppConfig();
    const selected = resolveScopedContribution(config, scope);
    const offered =
      isContributionEnabled(selected.config) &&
      declaredContributionIds(selected.config, 'execution').includes(
        requested.resourceId,
      );
    if (!offered)
      throw new ReceiverExecutionRefusal(
        'receiver_execution_not_offered',
        'This Station does not currently offer execution for the requested Project resource.',
      );
    let association: ReturnType<ProjectContributionService['association']>;
    try {
      association = this.association(requested.portableProjectId);
    } catch {
      throw unavailable();
    }
    if (
      !association.manifest.repos.some(
        (resource) => resource.id === requested.resourceId,
      )
    )
      throw unavailable();
    const captured = {
      projectId: association.project.id,
      projectSlug: association.project.slug,
      absoluteProjectRoot:
        association.project.workingDirectory === undefined
          ? undefined
          : resolve(expandTilde(association.project.workingDirectory)),
      manifest: structuredClone({
        id: association.manifest.id,
        slug: association.manifest.slug,
        repos: association.manifest.repos,
      }),
      binding: structuredClone(
        this.deps.bindings.findBinding(
          requested.portableProjectId,
          requested.resourceId,
        ),
      ),
      executionSelection: structuredClone(association.manifest.executionRoot),
    };
    const resolution = await this.deps.resolver.resolveProjectResource(
      association.project.slug,
      requested.resourceId,
    );
    if (resolution.state !== 'bound') throw unavailable();
    // The SAME checked canonical path the resolver owner just verified for
    // the EXACT requested resource — never the compat workingDirectory,
    // which names only the project's default checkout.
    const resourcePath = resolution.path;
    // The manifest execution root refines the start directory only when it
    // selects THIS resource (or names no repo, i.e. project-wide). A root
    // declared for another resource, or no declared root at all, leaves the
    // resource's own bound path. Resolved through the same resolver owner
    // so the admitted root is the checked canonical directory.
    let executionRoot: string | undefined;
    {
      const selection = captured.executionSelection as
        | { repoId?: string }
        | undefined;
      // Only a DECLARED root refines the start directory — and only when
      // it selects this resource (or names no repo). With no declared
      // root the resource's own bound path stands: resolving the root
      // unconditionally would answer a DIFFERENT (primary) resource's
      // path for a non-primary request.
      const selectsThisResource =
        selection !== undefined &&
        (selection.repoId === undefined ||
          selection.repoId === requested.resourceId);
      if (selectsThisResource) {
        try {
          executionRoot = await this.deps.resolver.resolveProjectExecutionRoot(
            association.project.slug,
          );
        } catch {
          throw unavailable();
        }
      }
    }
    const currentConfig = await this.deps.config.loadAppConfig();
    const currentSelected = resolveScopedContribution(currentConfig, scope);
    const stillOffered =
      isContributionEnabled(currentSelected.config) &&
      declaredContributionIds(currentSelected.config, 'execution').includes(
        requested.resourceId,
      );
    let sameAssociation = false;
    try {
      const currentAssociation = this.association(requested.portableProjectId);
      const currentWorkingDirectory =
        currentAssociation.project.workingDirectory === undefined
          ? undefined
          : resolve(expandTilde(currentAssociation.project.workingDirectory));
      sameAssociation =
        currentAssociation.project.id === captured.projectId &&
        currentAssociation.project.slug === captured.projectSlug &&
        currentWorkingDirectory === captured.absoluteProjectRoot &&
        isDeepStrictEqual(
          {
            id: currentAssociation.manifest.id,
            slug: currentAssociation.manifest.slug,
            repos: currentAssociation.manifest.repos,
          },
          captured.manifest,
        ) &&
        // The manifest execution-root SELECTION is part of freshness: a
        // root that moved (or appeared/vanished) while the final config
        // read awaited must refuse the OLD admitted root, never start in
        // it. Compared as the declared selection (not the resolved
        // directory) so a same-directory rewording still counts as moved.
        isDeepStrictEqual(
          structuredClone(currentAssociation.manifest.executionRoot),
          captured.executionSelection,
        );
    } catch {}
    const afterBinding = structuredClone(
      this.deps.bindings.findBinding(
        requested.portableProjectId,
        requested.resourceId,
      ),
    );
    if (!stillOffered)
      throw new ReceiverExecutionRefusal(
        'receiver_execution_not_offered',
        'This Station does not currently offer execution for the requested Project resource.',
      );
    if (!authorityCurrent())
      throw new ReceiverExecutionRefusal(
        'receiver_execution_not_offered',
        'Receiver execution authority changed before the work could start.',
      );
    if (!sameAssociation || !isDeepStrictEqual(captured.binding, afterBinding))
      throw unavailable();
    if ((captured.absoluteProjectRoot ?? '') === '') throw unavailable();
    const expectedProjectRoot = expect
      ? resolve(expandTilde(expect.admitted.workingDirectory))
      : undefined;
    if (
      expect &&
      (expect.admitted.slug !== captured.projectSlug ||
        expectedProjectRoot !== captured.absoluteProjectRoot ||
        expect.admitted.resourcePath !== resourcePath ||
        (expect.admitted.executionRoot ?? undefined) !==
          (executionRoot ?? undefined) ||
        // Full original-identity continuity: a replaced Project record, a
        // replaced manifest (different id, even with identical repos), or
        // a replaced binding row hiding under the same slug/cwd/path is a
        // DIFFERENT association and refuses — the within-invocation checks
        // above only prove the fresh capture is self-consistent, never
        // that it is the SAME association this admission was minted for.
        expect.identity.projectId !== captured.projectId ||
        !isDeepStrictEqual(expect.identity.manifest, captured.manifest) ||
        !isDeepStrictEqual(expect.identity.binding, captured.binding) ||
        !isDeepStrictEqual(
          expect.identity.executionSelection,
          captured.executionSelection,
        ))
    )
      // A recheck must answer for the SAME captured association, manifest,
      // binding, resource path, and execution root; a rebind that re-points
      // the resource elsewhere (or a root that moved) is a refusal, never a
      // silent re-target onto the new directory.
      throw unavailable();
    return {
      admitted: {
        slug: captured.projectSlug,
        workingDirectory: captured.absoluteProjectRoot!,
        resourcePath,
        ...(executionRoot === undefined ? {} : { executionRoot }),
      },
      // Owned baseline for the NEXT recheck: these are this capture's own
      // clones (never a live store row, never handed out), so a later
      // in-place replacement cannot mutate them.
      identity: {
        projectId: captured.projectId,
        manifest: captured.manifest,
        binding: captured.binding,
        executionSelection: captured.executionSelection,
      },
    };
  }
}

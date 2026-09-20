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
      | 'receiver_execution_unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'ReceiverExecutionRefusal';
  }
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
  };
  readonly recheck: () => Promise<void>;
}

interface Deps {
  source: Pick<IStorageAdapter, 'listProjects' | 'projectRevision'>;
  manifests: Pick<ProjectManifestStore, 'readProjectManifest'>;
  bindings: Pick<ProjectBindingsStore, 'findBinding'>;
  resolver: Pick<ProjectResourceResolver, 'resolveProjectResource'>;
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
   * only against the absolute path.
   */
  async authorizeReceiverExecution(
    input: ProjectContributionQuery,
    authorityCurrent: () => boolean,
  ): Promise<ReceiverExecutionAdmission> {
    const requested = structuredClone(input);
    const admitted = await this.captureReceiverAdmission(
      requested,
      authorityCurrent,
    );
    return {
      portableProjectId: requested.portableProjectId,
      resourceId: requested.resourceId,
      admittedProject: admitted,
      recheck: async () => {
        await this.captureReceiverAdmission(requested, authorityCurrent, {
          admittedProject: admitted,
        });
      },
    };
  }

  private async captureReceiverAdmission(
    input: ProjectContributionQuery,
    authorityCurrent: () => boolean,
    expect?: { admittedProject: ReceiverExecutionAdmission['admittedProject'] },
  ): Promise<ReceiverExecutionAdmission['admittedProject']> {
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
      workingDirectory:
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
    };
    const resolution = await this.deps.resolver.resolveProjectResource(
      association.project.slug,
      requested.resourceId,
    );
    if (resolution.state !== 'bound') throw unavailable();
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
        currentWorkingDirectory === captured.workingDirectory &&
        isDeepStrictEqual(
          {
            id: currentAssociation.manifest.id,
            slug: currentAssociation.manifest.slug,
            repos: currentAssociation.manifest.repos,
          },
          captured.manifest,
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
    if (
      !sameAssociation ||
      !isDeepStrictEqual(captured.binding, afterBinding)
    )
      throw unavailable();
    if (
      (captured.workingDirectory ?? '') === '' ||
      (expect &&
        (expect.admittedProject.slug !== captured.projectSlug ||
          expect.admittedProject.workingDirectory !==
            captured.workingDirectory))
    )
      // A recheck must answer for the SAME captured binding; re-resolving to
      // a different workspace is a refusal, never a silent re-target.
      throw unavailable();
    return {
      slug: captured.projectSlug,
      workingDirectory: captured.workingDirectory!,
    };
  }
}

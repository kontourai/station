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
    if (
      !association.manifest.repos.some(
        (resource) => resource.id === requested.resourceId,
      )
    )
      return this.unavailable(base, requested.resourceId);
    const beforeBinding = this.deps.bindings.findBinding(
      requested.portableProjectId,
      requested.resourceId,
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
      sameAssociation =
        currentAssociation.project.id === association.project.id &&
        currentAssociation.manifest.updatedAt ===
          association.manifest.updatedAt;
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
}

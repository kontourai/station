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
  ): Promise<ContributionConfig> {
    const { project, manifest } = this.association(
      input.portableProjectId,
      input.localProjectId,
    );
    if (!manifest.repos.some((resource) => resource.id === input.resourceId))
      throw new FileStorageNotFoundError(
        'Project contribution is unavailable.',
      );
    const revision = this.deps.source.projectRevision(project.slug);
    if (!revision.withCurrentRead)
      throw new Error('Current Project admission is unavailable.');
    return revision.withCurrentRead(async (currentProject) => {
      if (currentProject.id !== input.localProjectId)
        throw new FileStorageConflictError('Project association changed.');
      let result!: ContributionConfig;
      await this.deps.config.mutateAppConfig((current) => {
        const scope = {
          kind: 'project' as const,
          projectId: input.portableProjectId,
        };
        const key = contributionScopeKey(scope);
        const selected = resolveScopedContribution(current, scope);
        const actual = selected.origin === 'absent' ? null : selected.config;
        if (!isDeepStrictEqual(actual, input.expected))
          throw new FileStorageConflictError(
            'Project execution offer changed.',
          );
        const repoIds = new Set(
          declaredContributionIds(selected.config, 'execution'),
        );
        if (input.enabled) repoIds.add(input.resourceId);
        else repoIds.delete(input.resourceId);
        result = {
          ...selected.config,
          enabled: repoIds.size > 0,
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
  ): Promise<ContributionProjection> {
    const scope = {
      kind: 'project' as const,
      projectId: input.portableProjectId,
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
        input.resourceId,
      );
    if (!offered) {
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
      association = this.association(input.portableProjectId);
    } catch {
      return {
        ...base,
        sourceObservedAt: null,
        participation: 'contributed-unavailable',
        execution: [
          { repoId: input.resourceId, bound: false, verifiedAt: null },
        ],
        diagnostics: [
          {
            axis: 'execution',
            resourceId: input.resourceId,
            code: 'contribution-unavailable-resource',
            message: 'The offered Project resource is unavailable.',
          },
        ],
      };
    }
    if (
      !association.manifest.repos.some(
        (resource) => resource.id === input.resourceId,
      )
    )
      return {
        ...base,
        sourceObservedAt: null,
        participation: 'contributed-unavailable',
        execution: [
          { repoId: input.resourceId, bound: false, verifiedAt: null },
        ],
        diagnostics: [
          {
            axis: 'execution',
            resourceId: input.resourceId,
            code: 'contribution-unavailable-resource',
            message: 'The offered Project resource is unavailable.',
          },
        ],
      };
    const resolution = await this.deps.resolver.resolveProjectResource(
      association.project.slug,
      input.resourceId,
    );
    const binding = this.deps.bindings.findBinding(
      input.portableProjectId,
      input.resourceId,
    );
    const verifiedAt = binding?.verifiedAt ?? null;
    const bound = resolution.state === 'bound';
    return {
      ...base,
      sourceObservedAt:
        verifiedAt === null ? null : new Date(verifiedAt).toISOString(),
      participation: bound ? 'contributing' : 'contributed-unavailable',
      execution: [{ repoId: input.resourceId, bound, verifiedAt }],
      diagnostics: bound
        ? []
        : [
            {
              axis: 'execution',
              resourceId: input.resourceId,
              code: 'contribution-unavailable-resource',
              message: 'The offered Project resource is unavailable.',
            },
          ],
    };
  }
}

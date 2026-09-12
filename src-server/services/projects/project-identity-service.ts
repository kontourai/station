import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { ProjectConfig } from '@kontourai/station-contracts/project';
import {
  type ProjectAttachRequest,
  type ProjectAttachResult,
  type ProjectIdentityView,
  type ProjectPortableIdentity,
  selectPrimaryResource,
} from '@kontourai/station-contracts/project-identity';
import {
  FileStorageAlreadyExistsError,
  FileStorageConflictError,
  FileStorageNotFoundError,
  FileStorageUnavailableError,
} from '../../domain/project-file-transactions.js';
import {
  ProjectIdentityValidationError,
  parseProjectPortableIdentity,
} from '../../domain/project-identity-record.js';
import {
  assertSafeLayoutPathSegment,
  type IStorageAdapter,
} from '../../domain/storage-adapter.js';
import { expandTilde } from '../../utils/paths.js';
import type { CheckoutRemoteReader } from './checkout-remote-reader.js';
import { compareProjectGitRemotes } from './project-git-remote-comparison.js';
import type { ProjectManifestStore } from './project-manifest-store.js';
import type { ProjectService } from './project-service.js';

type ProjectIdentityManifestPort = Pick<ProjectManifestStore, 'readRecord'> &
  Partial<Pick<ProjectManifestStore, 'ensureProjectManifest'>>;

/** Explicit local attachment. This service grants no remote or member authority. */
export class ProjectIdentityService {
  constructor(
    private readonly projects: ProjectService,
    private readonly storage: IStorageAdapter,
    private readonly manifests: ProjectIdentityManifestPort,
    private readonly readRemotes: CheckoutRemoteReader,
    private readonly hostAliases: () => Record<string, string>,
  ) {}

  async read(slug: string): Promise<ProjectIdentityView> {
    return this.withProject(slug, async (project) => this.view(project));
  }

  async prepare(slug: string): Promise<ProjectIdentityView> {
    const prepare = this.manifests.ensureProjectManifest?.bind(this.manifests);
    if (!prepare)
      throw new FileStorageUnavailableError(
        'Project identity preparation is not supported by this store.',
      );
    return this.withProject(slug, async (project) => {
      const result = await prepare(project);
      if (result.outcome === 'unavailable')
        throw new FileStorageUnavailableError(result.reason);
      return this.view(project);
    });
  }

  async attach(
    input: Omit<ProjectAttachRequest, 'identity'> & { identity: unknown },
  ): Promise<ProjectAttachResult> {
    assertSafeLayoutPathSegment('project slug', input.slug);
    if (typeof input.name !== 'string' || !input.name.trim()) {
      throw new ProjectIdentityValidationError(
        'A local Project name is required.',
      );
    }
    const identity = parseProjectPortableIdentity(input.identity);
    const config = {
      name: input.name,
      slug: input.slug,
      ...(input.workingDirectory === undefined
        ? {}
        : { workingDirectory: input.workingDirectory }),
    };
    await this.verifyDirectory(config.workingDirectory, identity);
    try {
      const project = await this.projects.createAttachedProject(
        config,
        identity,
      );
      return { ...identityView(project, identity), outcome: 'created' };
    } catch (error) {
      if (!(error instanceof FileStorageAlreadyExistsError)) throw error;
      try {
        return await this.withProject(config.slug, async (project) => {
          const view = this.view(project);
          if (
            !isDeepStrictEqual(view.identity, identity) ||
            project.name !== config.name ||
            project.workingDirectory !== config.workingDirectory
          ) {
            throw new FileStorageConflictError(
              'This local Project already has a different identity or configuration. Nothing was changed.',
            );
          }
          return { ...view, outcome: 'existing' };
        });
      } catch (readError) {
        if (readError instanceof FileStorageNotFoundError) {
          throw new FileStorageConflictError(
            'The local Project location is already occupied without the requested portable identity. Nothing was changed.',
          );
        }
        throw readError;
      }
    }
  }

  private view(project: ProjectConfig): ProjectIdentityView {
    const record = this.manifests.readRecord(project.slug);
    if (!record)
      throw new FileStorageNotFoundError(
        'This Project has no portable identity. Prepare it explicitly before exporting it.',
      );
    const identity = parseProjectPortableIdentity(record);
    return identityView(project, identity);
  }

  private async withProject<T>(
    slug: string,
    operation: (project: ProjectConfig) => Promise<T>,
  ): Promise<T> {
    const revision = this.storage.projectRevision(slug);
    if (!revision.withCurrentRead)
      throw new FileStorageUnavailableError(
        'The Project store cannot verify a current identity association.',
      );
    return revision.withCurrentRead(operation);
  }

  private async verifyDirectory(
    directory: string | undefined,
    identity: ProjectPortableIdentity,
  ): Promise<void> {
    if (directory === undefined) return;
    const expanded = expandTilde(directory);
    if (!isAbsolute(expanded))
      throw new ProjectIdentityValidationError(
        'The checkout path must be absolute on this Station.',
      );
    const absolute = resolve(expanded);
    try {
      if (!statSync(absolute).isDirectory()) throw new Error('not-directory');
    } catch {
      throw new ProjectIdentityValidationError(
        'The checkout directory is unavailable on this Station.',
      );
    }
    const primary = selectPrimaryResource(identity.repos);
    if (!primary.ok)
      throw new ProjectIdentityValidationError(
        'A checkout requires one unambiguous primary resource.',
      );
    if (primary.resource.kind === 'local-only') return;
    const remotes = await this.readRemotes(absolute);
    if (!remotes.ok)
      throw new FileStorageUnavailableError(
        'The checkout repository could not be verified.',
      );
    const result = compareProjectGitRemotes(
      remotes.remotes.map((remote) => remote.url),
      this.hostAliases(),
      [primary.resource.canonicalRemote, ...(primary.resource.aliases ?? [])],
    );
    if (result.outcome !== 'matched') {
      throw new ProjectIdentityValidationError(
        'The checkout does not verifiably realize this Project primary repository.',
      );
    }
  }
}

function identityView(
  project: ProjectConfig,
  identity: ProjectPortableIdentity,
): ProjectIdentityView {
  return {
    identity,
    association: {
      portableProjectId: identity.id,
      localProjectId: project.id,
      localProjectSlug: project.slug,
    },
  };
}

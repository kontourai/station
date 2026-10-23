import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { ProjectConfig } from '@kontourai/station-contracts/project';
import {
  isLocalCloneSource,
  type ProjectAttachRequest,
  type ProjectAttachResult,
  type ProjectExecutionRootMutationRequest,
  type ProjectIdentityView,
  type ProjectPortableIdentity,
  type ProjectRepoResource,
  selectPrimaryResource,
} from '@kontourai/station-contracts/project-identity';
import {
  FileStorageAlreadyExistsError,
  FileStorageConflictError,
  FileStorageNotFoundError,
  FileStorageUnavailableError,
  ProjectIdentityNotPreparedError,
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
import type { ProjectBindingsStore } from './project-binding-store.js';
import { compareProjectGitRemotes } from './project-git-remote-comparison.js';
import type { ProjectManifestStore } from './project-manifest-store.js';
import {
  defaultedProjectWorkingDirectory,
  type ProjectService,
} from './project-service.js';
import type { RepositoryAcquisitionService } from './repository-acquisition-service.js';

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
    private readonly now: () => Date = () => new Date(),
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
    // Capture the authored path verbatim for persistence and exact retry
    // comparison. verifyDirectory expands it before every filesystem/Git read.
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
          // Identity attachment does not rewrite an existing local config,
          // including its chosen path spelling; this is not a filesystem read.
          const expectedWorkingDirectory =
            config.workingDirectory ??
            resolve(expandTilde(defaultedProjectWorkingDirectory(config.slug)));
          const pathMatches =
            project.workingDirectory === expectedWorkingDirectory;
          if (
            !isDeepStrictEqual(view.identity, identity) ||
            project.name !== config.name ||
            !pathMatches
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

  async attachRepository(
    slug: string,
    input: {
      expectedIdentity: unknown;
      expectedLocalProjectId: string;
      acquisitionId: string;
      useForCode: boolean;
    },
    deps: {
      acquisitions: Pick<RepositoryAcquisitionService, 'get' | 'projectSource'>;
      bindings: Pick<
        ProjectBindingsStore,
        'findBinding' | 'upsertProjectBinding' | 'confirmProjectBinding'
      >;
      assertCurrent: () => void;
    },
  ): Promise<ProjectIdentityView> {
    deps.assertCurrent();
    const expected = parseProjectPortableIdentity(input.expectedIdentity);
    const revision = this.storage.projectRevision(slug);
    if (revision.value.id !== input.expectedLocalProjectId)
      throw new FileStorageConflictError(
        'The local Project changed before repository attachment.',
      );
    if (!revision.replaceManifest || !revision.withCurrentRead)
      throw new FileStorageUnavailableError(
        'Current Project identity mutation is unavailable.',
      );
    const record = this.manifests.readRecord(slug);
    if (!record)
      throw new ProjectIdentityNotPreparedError(
        'Prepare Project identity before attaching a repository.',
      );
    const current = parseProjectPortableIdentity(record);
    const acquisition = deps.acquisitions.get(input.acquisitionId);
    if (
      acquisition?.phase !== 'ready' ||
      !acquisition.canonicalRemote ||
      isLocalCloneSource(acquisition.canonicalRemote)
    )
      throw new ProjectIdentityValidationError(
        'Choose a verified remote repository acquisition.',
      );
    const resourceId = acquisition.canonicalRemote;
    const previousBinding =
      deps.bindings.findBinding(current.id, resourceId) ?? null;
    if (previousBinding && previousBinding.path !== acquisition.checkoutPath)
      throw new FileStorageConflictError(
        'A different checkout is already bound. Use repair explicitly.',
      );
    if (!expected.repos.length && !input.useForCode)
      throw new FileStorageConflictError(
        'This Project has no existing resource to preserve. Explicitly choose whether to use the repository for code work before attaching it.',
      );
    const primary = selectPrimaryResource(expected.repos);
    if (expected.repos.length && !primary.ok)
      throw new FileStorageConflictError(
        'Choose an unambiguous primary resource before adding a repository.',
      );
    if (expected.repos.some((resource) => resource.id === resourceId)) {
      if (
        !isDeepStrictEqual(current, expected) ||
        previousBinding?.path !== acquisition.checkoutPath ||
        (input.useForCode &&
          (current.executionRoot?.repoId !== resourceId ||
            current.executionRoot.path !==
              (acquisition.request.subdirectory ?? '.')))
      )
        throw new FileStorageConflictError(
          'This repository is already declared with a different selection. Use repair explicitly.',
        );
      await deps.acquisitions.projectSource(input.acquisitionId);
      return revision.withCurrentRead(async () => {
        deps.assertCurrent();
        const latest = this.manifests.readRecord(slug);
        if (
          !latest ||
          !isDeepStrictEqual(parseProjectPortableIdentity(latest), current)
        )
          throw new FileStorageConflictError(
            'Project identity changed during recovery.',
          );
        await deps.bindings.confirmProjectBinding(
          current.id,
          resourceId,
          previousBinding,
          deps.assertCurrent,
        );
        return identityView(revision.value, current);
      });
    }
    const repos: ProjectRepoResource[] = expected.repos.map((resource) => ({
      ...resource,
      role:
        primary.ok && resource.id === primary.resource.id
          ? 'primary'
          : 'secondary',
    }));
    repos.push({
      kind: 'git',
      id: resourceId,
      canonicalRemote: resourceId,
      role: repos.length ? 'secondary' : 'primary',
    });
    const candidate = parseProjectPortableIdentity({
      ...expected,
      repos,
      ...(input.useForCode
        ? {
            executionRoot: {
              repoId: resourceId,
              path: acquisition.request.subdirectory ?? '.',
            },
          }
        : {}),
      updatedAt: this.now().toISOString(),
    });
    const retryCandidate = { ...candidate, updatedAt: current.updatedAt };
    const alreadyAttached = isDeepStrictEqual(current, retryCandidate);
    if (!isDeepStrictEqual(current, expected) && !alreadyAttached)
      throw new FileStorageConflictError(
        'Project resources changed before repository attachment.',
      );
    await deps.acquisitions.projectSource(input.acquisitionId);
    deps.assertCurrent();
    await revision.withCurrentRead(async () => {
      const latest = this.manifests.readRecord(slug);
      if (
        !latest ||
        !isDeepStrictEqual(parseProjectPortableIdentity(latest), current)
      )
        throw new FileStorageConflictError(
          'Project identity changed during repository verification.',
        );
      if (alreadyAttached && previousBinding?.path !== acquisition.checkoutPath)
        throw new FileStorageConflictError(
          'The attached repository has a different binding. Use repair explicitly.',
        );
      await deps.bindings.upsertProjectBinding(
        {
          projectId: current.id,
          resourceId,
          kind: 'git-checkout',
          path: acquisition.checkoutPath,
          remotes: [acquisition.request.sourceUrl],
          verifiedAt: Date.now(),
          state: 'bound',
        },
        { expectedBinding: previousBinding, assertCurrent: deps.assertCurrent },
      );
    });
    deps.assertCurrent();
    await revision.replaceManifest(
      record,
      alreadyAttached ? current : candidate,
      deps.assertCurrent,
    );
    return identityView(revision.value, alreadyAttached ? current : candidate);
  }

  async updateExecutionRoot(
    slug: string,
    input: Omit<ProjectExecutionRootMutationRequest, 'expectedIdentity'> & {
      expectedIdentity: unknown;
    },
    assertCurrent: () => void = () => {},
  ): Promise<ProjectIdentityView> {
    const expectedIdentity = parseProjectPortableIdentity(
      input.expectedIdentity,
    );
    if (
      typeof input.expectedLocalProjectId !== 'string' ||
      !input.expectedLocalProjectId
    )
      throw new ProjectIdentityValidationError(
        'A current local Project identity guard is required.',
      );
    const revision = this.storage.projectRevision(slug);
    if (revision.value.id !== input.expectedLocalProjectId)
      throw new FileStorageConflictError(
        'The local Project changed before the execution root could update.',
      );
    if (!revision.replaceManifest)
      throw new FileStorageUnavailableError(
        'The Project store cannot atomically update portable identity.',
      );
    const record = this.manifests.readRecord(slug);
    if (!record)
      throw new ProjectIdentityNotPreparedError(
        'This Project has no portable identity. Prepare it explicitly before selecting an execution root.',
      );
    const current = parseProjectPortableIdentity(record);
    const { executionRoot: _previousRoot, ...expectedBase } = expectedIdentity;
    const replayCandidate = parseProjectPortableIdentity({
      ...expectedBase,
      ...(input.executionRoot === null
        ? {}
        : { executionRoot: input.executionRoot }),
      updatedAt: current.updatedAt,
    });
    if (
      !isDeepStrictEqual(current, expectedIdentity) &&
      !isDeepStrictEqual(current, replayCandidate)
    )
      throw new FileStorageConflictError(
        'Project identity changed before the execution root could update.',
      );
    const unchanged = isDeepStrictEqual(
      current.executionRoot ?? null,
      input.executionRoot,
    );
    const candidate = unchanged
      ? current
      : parseProjectPortableIdentity({
          ...current,
          ...(input.executionRoot === null
            ? { executionRoot: undefined }
            : { executionRoot: input.executionRoot }),
          updatedAt: this.now().toISOString(),
        });
    assertCurrent();
    await revision.replaceManifest(record, candidate, assertCurrent);
    return identityView(revision.value, candidate);
  }

  private view(project: ProjectConfig): ProjectIdentityView {
    const record = this.manifests.readRecord(project.slug);
    // Discriminated from a removed Project (a plain FileStorageNotFoundError
    // from withProject): the Project exists, only its identity is unprepared.
    if (!record)
      throw new ProjectIdentityNotPreparedError(
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

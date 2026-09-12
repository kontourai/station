import {
  PROJECT_GIT_RESOURCE_FIELDS,
  PROJECT_LOCAL_RESOURCE_FIELDS,
  PROJECT_MANIFEST_SCHEMA_VERSION,
  PROJECT_PORTABLE_IDENTITY_FIELDS,
  type ProjectPortableIdentity,
  validateProjectManifest,
} from '@kontourai/station-contracts/project-identity';
import { isRecord } from '../utils/is-record.js';

export class ProjectIdentityValidationError extends Error {
  readonly code = 'project_identity_invalid';

  constructor(message: string) {
    super(message);
    this.name = 'ProjectIdentityValidationError';
  }
}

/** Closed wire/storage shape; the existing manifest validator owns resource rules. */
export function parseProjectPortableIdentity(
  value: unknown,
): ProjectPortableIdentity {
  if (
    !isRecord(value) ||
    value.schemaVersion !== PROJECT_MANIFEST_SCHEMA_VERSION
  ) {
    throw new ProjectIdentityValidationError(
      'Unsupported or missing Project identity schema version.',
    );
  }
  if (
    Object.keys(value).some(
      (key) => !Object.hasOwn(PROJECT_PORTABLE_IDENTITY_FIELDS, key),
    )
  ) {
    throw new ProjectIdentityValidationError(
      'Project identity must contain only the portable identity fields.',
    );
  }
  if (!Array.isArray(value.repos)) {
    throw new ProjectIdentityValidationError(
      'Project identity repos must be an array.',
    );
  }
  for (const repo of value.repos) {
    const fields =
      isRecord(repo) && repo.kind === 'git'
        ? PROJECT_GIT_RESOURCE_FIELDS
        : PROJECT_LOCAL_RESOURCE_FIELDS;
    if (
      !isRecord(repo) ||
      Object.keys(repo).some((key) => !Object.hasOwn(fields, key))
    ) {
      throw new ProjectIdentityValidationError(
        'A Project resource contains unsupported fields.',
      );
    }
    if (repo.kind === 'git') {
      const remotes = [
        repo.canonicalRemote,
        ...(Array.isArray(repo.aliases) ? repo.aliases : []),
      ];
      if (
        remotes.some(
          (remote) => typeof remote !== 'string' || /[?#@\s\\]/.test(remote),
        )
      ) {
        throw new ProjectIdentityValidationError(
          'Repository identity cannot contain credentials, query parameters, fragments or whitespace.',
        );
      }
    }
  }
  const validation = validateProjectManifest({
    ...value,
    name: 'Portable Project',
    slug: 'portable-project',
    knowledge: [],
    agents: [],
    integrations: [],
    layouts: [],
  });
  if (!validation.ok) {
    throw new ProjectIdentityValidationError(
      `Project identity is invalid: ${validation.errors.join('; ')}`,
    );
  }
  const { schemaVersion, id, repos, createdAt, updatedAt } =
    validation.manifest;
  return structuredClone({ schemaVersion, id, repos, createdAt, updatedAt });
}

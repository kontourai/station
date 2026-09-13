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
      'Project identity does not satisfy the manifest resource contract.',
    );
  }
  for (const repo of validation.manifest.repos) {
    const fields =
      repo.kind === 'git'
        ? PROJECT_GIT_RESOURCE_FIELDS
        : PROJECT_LOCAL_RESOURCE_FIELDS;
    if (Object.keys(repo).some((key) => !Object.hasOwn(fields, key))) {
      throw new ProjectIdentityValidationError(
        'A Project resource contains unsupported fields.',
      );
    }
    if (
      repo.kind === 'git' &&
      [repo.canonicalRemote, ...(repo.aliases ?? [])].some((remote) =>
        /[?#@\s\\]/.test(remote),
      )
    ) {
      throw new ProjectIdentityValidationError(
        'Repository identity cannot contain credentials, query parameters, fragments or whitespace.',
      );
    }
  }
  const { schemaVersion, id, repos, createdAt, updatedAt } =
    validation.manifest;
  return structuredClone({ schemaVersion, id, repos, createdAt, updatedAt });
}

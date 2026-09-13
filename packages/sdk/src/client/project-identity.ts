/** Portable Project attachment operations, opt-in through the project-identity SDK subpath. */
import {
  PROJECT_GIT_RESOURCE_FIELDS,
  PROJECT_LOCAL_RESOURCE_FIELDS,
  PROJECT_PORTABLE_IDENTITY_FIELDS,
  type ProjectAttachRequest,
  type ProjectAttachResult,
  type ProjectIdentityView,
  validateProjectManifest,
} from '@kontourai/station-contracts/project-identity';
import { type ClientRequestOptions, getJson, mutateJson } from './http';
import { unwrapProjectResponse as unwrapOrThrow } from './project-response';

function identityObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readProjectIdentityView(
  value: unknown,
  slug: string,
): ProjectIdentityView {
  const message =
    'This client cannot validate the Project identity returned by this Station.';
  if (
    !identityObject(value) ||
    !identityObject(value.identity) ||
    !identityObject(value.association)
  )
    throw new Error(message);
  const record = value.identity;
  const association = value.association;
  if (
    Object.keys(record).some(
      (key) => !Object.keys(PROJECT_PORTABLE_IDENTITY_FIELDS).includes(key),
    ) ||
    association.localProjectSlug !== slug ||
    typeof association.localProjectId !== 'string' ||
    !association.localProjectId.trim()
  )
    throw new Error(message);
  const parsed = validateProjectManifest({
    ...record,
    name: 'Portable Project',
    slug: 'portable-project',
    knowledge: [],
    agents: [],
    integrations: [],
    layouts: [],
  });
  if (!parsed.ok || association.portableProjectId !== parsed.manifest.id)
    throw new Error(message);
  for (const repo of parsed.manifest.repos) {
    const fields =
      repo.kind === 'git'
        ? PROJECT_GIT_RESOURCE_FIELDS
        : PROJECT_LOCAL_RESOURCE_FIELDS;
    if (Object.keys(repo).some((key) => !Object.keys(fields).includes(key)))
      throw new Error(message);
    if (
      repo.kind === 'git' &&
      [repo.canonicalRemote, ...(repo.aliases ?? [])].some((remote) =>
        /[?#@\s\\]/.test(remote),
      )
    )
      throw new Error(message);
  }
  const { schemaVersion, id, repos, createdAt, updatedAt } = parsed.manifest;
  return {
    identity: { schemaVersion, id, repos, createdAt, updatedAt },
    association: {
      portableProjectId: id,
      localProjectId: association.localProjectId,
      localProjectSlug: slug,
    },
  };
}

/** Read a prepared identity. This never creates or repairs one implicitly. */
export async function getProjectIdentity(
  apiBase: string,
  slug: string,
  opts?: ClientRequestOptions,
): Promise<ProjectIdentityView> {
  const response = await getJson(
    `${apiBase}/api/projects/${encodeURIComponent(slug)}/identity`,
    opts,
  );
  return readProjectIdentityView(await unwrapOrThrow<unknown>(response), slug);
}

/** Explicitly derive a missing identity from this Station's Project resource. */
export async function prepareProjectIdentity(
  apiBase: string,
  slug: string,
  opts?: ClientRequestOptions,
): Promise<ProjectIdentityView> {
  const response = await mutateJson(
    `${apiBase}/api/projects/${encodeURIComponent(slug)}/identity/prepare`,
    'POST',
    { ...opts, readOnly: false },
  );
  return readProjectIdentityView(await unwrapOrThrow<unknown>(response), slug);
}

/** Create a destination-local Project carrying an existing portable identity. */
export async function attachProject(
  apiBase: string,
  input: ProjectAttachRequest,
  opts?: ClientRequestOptions,
): Promise<ProjectAttachResult> {
  const request = structuredClone(input);
  const response = await mutateJson(
    `${apiBase}/api/projects/attach`,
    'POST',
    { ...opts, readOnly: false },
    request,
  );
  const data = await unwrapOrThrow<unknown>(response);
  const view = readProjectIdentityView(data, request.slug);
  if (
    !identityObject(data) ||
    (data.outcome !== 'created' && data.outcome !== 'existing') ||
    view.identity.id !== request.identity.id
  ) {
    throw new Error(
      'This client cannot validate the Project attachment returned by this Station.',
    );
  }
  return { ...view, outcome: data.outcome };
}

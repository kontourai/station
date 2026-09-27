/** Portable Project attachment operations, opt-in through the project-identity SDK subpath. */
import {
  PROJECT_GIT_RESOURCE_FIELDS,
  PROJECT_IDENTITY_NOT_PREPARED_CODE,
  PROJECT_LOCAL_RESOURCE_FIELDS,
  PROJECT_PORTABLE_IDENTITY_FIELDS,
  type ProjectAttachRequest,
  type ProjectAttachResult,
  type ProjectExecutionRootMutationRequest,
  type ProjectIdentityView,
  type ProjectPortableIdentity,
  validateProjectManifest,
} from '@kontourai/station-contracts/project-identity';
import { type ClientRequestOptions, getJson, mutateJson } from './http';
import { unwrapProjectResponse as unwrapOrThrow } from './project-response';

function identityObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Validate a portable snapshot without importing local paths, grants or unknown fields. */
export function parseProjectPortableIdentity(
  value: unknown,
): ProjectPortableIdentity {
  const message = 'Invalid or unsupported portable Project identity.';
  if (
    !identityObject(value) ||
    Object.keys(value).some(
      (key) => !Object.keys(PROJECT_PORTABLE_IDENTITY_FIELDS).includes(key),
    )
  )
    throw new Error(message);
  const record = value;
  const parsed = validateProjectManifest({
    ...record,
    name: 'Portable Project',
    slug: 'portable-project',
    knowledge: [],
    agents: [],
    integrations: [],
    layouts: [],
  });
  if (!parsed.ok) throw new Error(message);
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
  const { schemaVersion, id, repos, executionRoot, createdAt, updatedAt } =
    parsed.manifest;
  return {
    schemaVersion,
    id,
    repos,
    ...(executionRoot === undefined ? {} : { executionRoot }),
    createdAt,
    updatedAt,
  };
}

function readProjectIdentityView(
  value: unknown,
  slug: string,
): ProjectIdentityView {
  const message =
    'This client cannot validate the Project identity returned by this Station.';
  if (!identityObject(value) || !identityObject(value.association))
    throw new Error(message);
  const association = value.association;
  let identity: ProjectPortableIdentity;
  try {
    identity = parseProjectPortableIdentity(value.identity);
  } catch {
    throw new Error(message);
  }
  if (
    association.localProjectSlug !== slug ||
    typeof association.localProjectId !== 'string' ||
    !association.localProjectId.trim() ||
    association.portableProjectId !== identity.id
  )
    throw new Error(message);
  return {
    identity,
    association: {
      portableProjectId: identity.id,
      localProjectId: association.localProjectId,
      localProjectSlug: slug,
    },
  };
}

/**
 * What a failed identity read actually established (#480 review).
 *
 * - `not-prepared` — the ONLY verified absence: a 404 carrying the
 *   discriminated `project_identity_not_prepared` wire code, i.e. the server
 *   found the Project and holds no identity record. Only this gets prepare
 *   guidance.
 * - `not-found-unverified` — a 404 WITHOUT that code: an old server with no
 *   identity endpoint, a proxy 404, a non-JSON 404 body, or a removed
 *   Project (generic `file_storage_not_found`). Nothing verified; retry plus
 *   conditional setup help, never an absence claim.
 * - `denied` — 401/403 authorization refusal.
 * - `unavailable` — timeouts, 5xx, malformed bodies, anything else.
 *
 * Branches on transport status + machine code only. The server message is
 * never read: two failures can share every word and mean different things.
 */
export type ProjectIdentityReadFailure =
  | 'not-prepared'
  | 'denied'
  | 'not-found-unverified'
  | 'unavailable';

export function projectIdentityReadFailure(
  error: unknown,
): ProjectIdentityReadFailure {
  const record =
    typeof error === 'object' && error !== null
      ? (error as { status?: unknown; code?: unknown })
      : undefined;
  const status = typeof record?.status === 'number' ? record.status : undefined;
  const code = typeof record?.code === 'string' ? record.code : undefined;
  if (status === 404 && code === PROJECT_IDENTITY_NOT_PREPARED_CODE)
    return 'not-prepared';
  if (status === 404) return 'not-found-unverified';
  if (status === 401 || status === 403) return 'denied';
  return 'unavailable';
}

/** Only a discriminated not-prepared read verifies absence. */
export function isProjectIdentityNotPrepared(error: unknown): boolean {
  return projectIdentityReadFailure(error) === 'not-prepared';
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

/** Set or clear the portable execution root under an exact identity guard. */
export async function updateProjectExecutionRoot(
  apiBase: string,
  slug: string,
  input: ProjectExecutionRootMutationRequest,
  opts?: ClientRequestOptions,
): Promise<ProjectIdentityView> {
  const response = await mutateJson(
    `${apiBase}/api/projects/${encodeURIComponent(slug)}/identity/execution-root`,
    'PUT',
    { ...opts, readOnly: false },
    structuredClone(input),
  );
  const view = readProjectIdentityView(
    await unwrapOrThrow<unknown>(response),
    slug,
  );
  const requested = input.executionRoot;
  const actual = view.identity.executionRoot;
  if (
    view.identity.id !== input.expectedIdentity.id ||
    view.association.localProjectId !== input.expectedLocalProjectId ||
    (requested === null
      ? actual !== undefined
      : actual?.repoId !== requested.repoId || actual.path !== requested.path)
  )
    throw new Error(
      'This Station did not confirm the requested Project execution root mutation.',
    );
  return view;
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

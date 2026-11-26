/**
 * #5065: Project memory notes (`/api/projects/:slug/memory`), behind the
 * `project-coordination` Feature Preview. The host answers a typed 404 while
 * the preview is off; callers read the preview before calling.
 */
import type {
  ProjectMemoryList,
  ProjectMemoryNote,
  ProjectMemoryNoteWrite,
} from '@kontourai/station-contracts/project-session-context';
import {
  type ClientRequestOptions,
  getJson,
  mutateJson,
  readEnvelopeOrThrow,
} from './http';

function memoryPath(apiBase: string, slug: string, id?: string): string {
  return `${apiBase}/api/projects/${encodeURIComponent(slug)}/memory${
    id ? `/${encodeURIComponent(id)}` : ''
  }`;
}

async function required<T>(response: Response): Promise<T> {
  const value = await readEnvelopeOrThrow<T>(response);
  if (value === undefined) throw new Error('Project memory returned no data');
  return value;
}

/** `GET /api/projects/:slug/memory`: the index, newest change first. */
export async function listProjectMemory(
  apiBase: string,
  slug: string,
  opts?: ClientRequestOptions,
): Promise<ProjectMemoryList> {
  return required(await getJson(memoryPath(apiBase, slug), opts));
}

/** `GET /api/projects/:slug/memory/:id`. */
export async function getProjectMemoryNote(
  apiBase: string,
  slug: string,
  id: string,
  opts?: ClientRequestOptions,
): Promise<ProjectMemoryNote> {
  return required(await getJson(memoryPath(apiBase, slug, id), opts));
}

/** `POST /api/projects/:slug/memory`. */
export async function createProjectMemoryNote(
  apiBase: string,
  slug: string,
  write: ProjectMemoryNoteWrite,
  opts?: ClientRequestOptions,
): Promise<ProjectMemoryNote> {
  return required(
    await mutateJson(memoryPath(apiBase, slug), 'POST', opts, write),
  );
}

/** `PUT /api/projects/:slug/memory/:id`. */
export async function updateProjectMemoryNote(
  apiBase: string,
  slug: string,
  id: string,
  write: ProjectMemoryNoteWrite,
  opts?: ClientRequestOptions,
): Promise<ProjectMemoryNote> {
  return required(
    await mutateJson(memoryPath(apiBase, slug, id), 'PUT', opts, write),
  );
}

/** `DELETE /api/projects/:slug/memory/:id`. */
export async function deleteProjectMemoryNote(
  apiBase: string,
  slug: string,
  id: string,
  opts?: ClientRequestOptions,
): Promise<void> {
  await readEnvelopeOrThrow(
    await mutateJson(memoryPath(apiBase, slug, id), 'DELETE', opts),
  );
}

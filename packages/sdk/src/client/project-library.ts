import {
  PROJECT_LIBRARY_V1,
  type ProjectLibraryItem,
  type ProjectLibraryPage,
  type ProjectLibraryUpload,
} from '@kontourai/station-contracts/project-library';
// The sibling, not the `../api-core` barrel: nothing under `client/**` may
// reach outside `client/` (station#4011).
import { envelopeError } from './api-error-message';
import { hasCapability } from './capability.js';
import {
  type ClientRequestOptions,
  getJson,
  mutateBinary,
  mutateJson,
  readJsonBody,
} from './http';
import { fetchPublicStationCapabilities } from './publicStationCapabilities.js';

type Envelope<T> = { success: boolean; data?: T; error?: string };

const libraryPath = (slug: string, suffix = '') =>
  `/api/projects/${encodeURIComponent(slug)}/library${suffix}`;

async function unwrap<T>(response: Response): Promise<T> {
  const body = (await readJsonBody(response)) as Envelope<T> | undefined;
  if (!response.ok || !body?.success || body.data === undefined)
    throw envelopeError(response, body, `HTTP ${response.status}`);
  return body.data;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
const text = (value: unknown, max = 4096): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;
const size = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 0;

function upload(value: Record<string, unknown>): ProjectLibraryUpload | null {
  if (
    !text(value.relativePath, 1024) ||
    !size(value.byteLength) ||
    !text(value.mediaType, 160) ||
    !text(value.modifiedAt, 128)
  )
    return null;
  return {
    kind: 'upload',
    relativePath: value.relativePath,
    byteLength: value.byteLength,
    mediaType: value.mediaType,
    modifiedAt: value.modifiedAt,
  };
}

function item(value: unknown): ProjectLibraryItem | null {
  const entry = record(value);
  if (!entry) return null;
  if (entry.kind === 'upload') return upload(entry);
  if (entry.kind !== 'task-output') return null;
  const task = record(entry.task);
  if (
    !text(entry.outputId, 240) ||
    !text(entry.taskId, 240) ||
    !text(entry.title, 240) ||
    !text(entry.fileName, 240) ||
    !text(entry.sourcePath) ||
    !text(entry.mediaType, 160) ||
    !size(entry.byteLength) ||
    typeof entry.contentAvailable !== 'boolean' ||
    !text(entry.createdAt, 128) ||
    !task ||
    (task.state !== 'orphaned' &&
      !(task.state === 'present' && typeof task.title === 'string')) ||
    (entry.sessionId !== undefined && !text(entry.sessionId, 1024))
  )
    return null;
  return {
    kind: 'task-output',
    outputId: entry.outputId,
    taskId: entry.taskId,
    title: entry.title,
    fileName: entry.fileName,
    sourcePath: entry.sourcePath,
    mediaType: entry.mediaType,
    byteLength: entry.byteLength,
    contentAvailable: entry.contentAvailable,
    createdAt: entry.createdAt,
    task:
      task.state === 'present'
        ? { state: 'present', title: task.title as string }
        : { state: 'orphaned' },
    ...(typeof entry.sessionId === 'string'
      ? { sessionId: entry.sessionId }
      : {}),
  };
}

/**
 * One Project's Library. A malformed entry is withheld and the page reads as
 * partial, never as a phantom file.
 */
export async function getProjectLibrary(
  apiBase: string,
  slug: string,
  options?: ClientRequestOptions,
): Promise<ProjectLibraryPage> {
  const data = record(
    await unwrap<unknown>(
      await getJson(`${apiBase}${libraryPath(slug)}`, options),
    ),
  );
  if (
    !data ||
    data.version !== PROJECT_LIBRARY_V1 ||
    !text(data.projectId, 240) ||
    !Array.isArray(data.items)
  )
    throw new Error('Project Library answer is malformed');
  const items = data.items.map(item);
  const kept = items.filter((entry): entry is ProjectLibraryItem => !!entry);
  return {
    version: PROJECT_LIBRARY_V1,
    projectId: data.projectId,
    items: kept,
    partial: data.partial === true || kept.length !== items.length,
    truncated: data.truncated === true,
  };
}

/** Add or replace one file. `relativePath` keeps a picked folder's layout. */
export async function uploadProjectLibraryFile(
  apiBase: string,
  slug: string,
  relativePath: string,
  bytes: Blob,
  options?: ClientRequestOptions,
): Promise<ProjectLibraryUpload> {
  const response = await mutateBinary(
    `${apiBase}${libraryPath(slug, `/uploads?path=${encodeURIComponent(relativePath)}`)}`,
    'PUT',
    options,
    bytes,
  );
  const data = record(await unwrap<unknown>(response));
  const parsed = data && upload(data);
  if (!parsed) throw new Error('Project Library upload answer is malformed');
  return parsed;
}

export async function deleteProjectLibraryFile(
  apiBase: string,
  slug: string,
  relativePath: string,
  options?: ClientRequestOptions,
): Promise<void> {
  await unwrap<unknown>(
    await mutateJson(
      `${apiBase}${libraryPath(slug, `/uploads?path=${encodeURIComponent(relativePath)}`)}`,
      'DELETE',
      options,
      {},
    ),
  );
}

export type ProjectLibraryContent = {
  bytes: Uint8Array;
  mediaType: string;
  safePreview: 'image/png' | null;
};

/** One Library file's bytes: an upload by path, or a Task output by id. */
export async function downloadProjectLibraryContent(
  apiBase: string,
  slug: string,
  target: { relativePath: string } | { outputId: string },
  options?: ClientRequestOptions,
): Promise<ProjectLibraryContent> {
  const suffix =
    'relativePath' in target
      ? `/uploads/content?path=${encodeURIComponent(target.relativePath)}`
      : `/outputs/${encodeURIComponent(target.outputId)}/content`;
  const response = await getJson(
    `${apiBase}${libraryPath(slug, suffix)}`,
    options,
  );
  if (!response.ok)
    throw envelopeError(
      response,
      await readJsonBody(response),
      `HTTP ${response.status}`,
    );
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    mediaType:
      response.headers.get('content-type') ?? 'application/octet-stream',
    safePreview:
      response.headers.get('x-station-safe-preview') === 'image/png'
        ? 'image/png'
        : null,
  };
}

/**
 * Whether the host serves the Project Library (`projectLibrary`). `false`
 * also covers a handshake that could not be read, and a hosted Station.
 */
export async function readProjectLibraryCapability(
  apiBase: string,
): Promise<boolean> {
  const handshake = await fetchPublicStationCapabilities(apiBase);
  return handshake ? hasCapability(handshake, 'projectLibrary') : false;
}

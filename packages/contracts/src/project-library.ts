/**
 * Project Library (#5067): one list of the files people add to a Project and
 * the files its Tasks keep. It is a projection: every file keeps exactly one
 * owner. An upload is owned by the Project's Library folder; a Task output is
 * owned by the Task output store, and the Library only reads it.
 */
export const PROJECT_LIBRARY_V1 = 'project-library/v1' as const;

/** Largest single upload the Library accepts. */
export const PROJECT_LIBRARY_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
/** Uploads listed per Project; a larger folder is reported as truncated. */
export const PROJECT_LIBRARY_LIST_MAX_UPLOADS = 2_000;
/** Longest relative upload path, in characters. */
export const PROJECT_LIBRARY_PATH_MAX = 1_024;

/** A file a person added to the Project. */
export interface ProjectLibraryUpload {
  kind: 'upload';
  /** POSIX path relative to the Project's Library folder; its identity. */
  relativePath: string;
  byteLength: number;
  mediaType: string;
  modifiedAt: string;
}

/** A file one of the Project's Tasks kept, read from the Task output store. */
export interface ProjectLibraryTaskOutput {
  kind: 'task-output';
  outputId: string;
  taskId: string;
  title: string;
  fileName: string;
  /** Where the Task found the file in its workspace. */
  sourcePath: string;
  mediaType: string;
  byteLength: number;
  contentAvailable: boolean;
  createdAt: string;
  /**
   * `orphaned`: the Task that kept this file was deleted (or its id now names
   * a different Task). The file is still listed and readable.
   */
  task: { state: 'present'; title: string } | { state: 'orphaned' };
  /** The Session that declared the file, when it was kept from a declaration. */
  sessionId?: string;
}

export type ProjectLibraryItem =
  | ProjectLibraryUpload
  | ProjectLibraryTaskOutput;

export interface ProjectLibraryPage {
  version: typeof PROJECT_LIBRARY_V1;
  projectId: string;
  items: readonly ProjectLibraryItem[];
  /** One source (uploads or Task outputs) could not be read; the rest is listed. */
  partial: boolean;
  /** More uploads exist than {@link PROJECT_LIBRARY_LIST_MAX_UPLOADS}. */
  truncated: boolean;
}

/** Why a path in a picked folder is not uploaded. */
export type ProjectLibrarySkipReason = 'hidden' | 'node_modules' | 'invalid';

/**
 * The canonical relative path for an upload, or why it is refused. Hidden
 * segments (`.git`, `.env`) and `node_modules` are skipped, so picking a
 * project folder uploads only the files a person meant to share.
 */
export function projectLibraryUploadPath(
  value: string,
):
  | { ok: true; path: string }
  | { ok: false; reason: ProjectLibrarySkipReason } {
  if (typeof value !== 'string') return { ok: false, reason: 'invalid' };
  const normalized = value.replace(/\\/g, '/');
  if (
    normalized.length === 0 ||
    normalized.length > PROJECT_LIBRARY_PATH_MAX ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:/.test(normalized) ||
    // Control characters never name a file a person picked.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point
    /[\u0000-\u001f\u007f]/.test(normalized)
  )
    return { ok: false, reason: 'invalid' };
  const segments = normalized.split('/').filter((segment) => segment !== '');
  if (segments.length === 0) return { ok: false, reason: 'invalid' };
  for (const segment of segments) {
    if (segment === '..' || segment === '.')
      return { ok: false, reason: 'invalid' };
    if (segment === 'node_modules')
      return { ok: false, reason: 'node_modules' };
    if (segment.startsWith('.')) return { ok: false, reason: 'hidden' };
    // Windows refuses these in file names; refusing them everywhere keeps a
    // Library portable between Stations.
    if (/[<>:"|?*]/.test(segment) || /[ .]$/.test(segment))
      return { ok: false, reason: 'invalid' };
  }
  return { ok: true, path: segments.join('/') };
}

export type ProjectLibrarySourceFilter = 'all' | 'people' | 'tasks';

export interface ProjectLibraryFilter {
  source: ProjectLibrarySourceFilter;
  /** Only this Task's outputs (implies `tasks`). */
  taskId?: string;
}

/** The items a filter shows, in Library order (newest first). */
export function filterProjectLibraryItems(
  items: readonly ProjectLibraryItem[],
  filter: ProjectLibraryFilter,
): ProjectLibraryItem[] {
  return items.filter((item) => {
    if (filter.taskId !== undefined)
      return item.kind === 'task-output' && item.taskId === filter.taskId;
    if (filter.source === 'people') return item.kind === 'upload';
    if (filter.source === 'tasks') return item.kind === 'task-output';
    return true;
  });
}

/** The Tasks the Library's "by Task" filter offers, one per Task id. */
export function projectLibraryTasks(
  items: readonly ProjectLibraryItem[],
): { taskId: string; title: string | undefined; orphaned: boolean }[] {
  const tasks = new Map<
    string,
    { taskId: string; title: string | undefined; orphaned: boolean }
  >();
  for (const item of items) {
    if (item.kind !== 'task-output' || tasks.has(item.taskId)) continue;
    tasks.set(item.taskId, {
      taskId: item.taskId,
      title: item.task.state === 'present' ? item.task.title : undefined,
      orphaned: item.task.state === 'orphaned',
    });
  }
  return [...tasks.values()];
}

/** Newest first; an upload and an output order by when they entered the Library. */
export function sortProjectLibraryItems(
  items: readonly ProjectLibraryItem[],
): ProjectLibraryItem[] {
  const at = (item: ProjectLibraryItem) =>
    item.kind === 'upload' ? item.modifiedAt : item.createdAt;
  return [...items].sort((a, b) => {
    const order = at(b).localeCompare(at(a));
    if (order !== 0) return order;
    const key = (item: ProjectLibraryItem) =>
      item.kind === 'upload' ? item.relativePath : item.outputId;
    return key(a).localeCompare(key(b));
  });
}

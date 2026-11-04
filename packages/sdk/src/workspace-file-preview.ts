/**
 * Opt-in, browser-safe file preview access. This subpath only exposes a
 * bounded read contract; renderers decide how to display a returned result.
 */

import {
  parseWorkspaceVisualFile,
  type WorkspaceVisualFile,
  type WorkspaceVisualFileUnavailableReason,
  workspaceVisualFileUnavailableReason,
} from '@kontourai/station-contracts/workspace-file-preview';
import { _getApiBase } from './api-core.js';
import {
  type ClientRequestOptions,
  mutateJson,
  rethrowDeadline,
} from './client/http.js';

export type {
  WorkspaceFileChanges,
  WorkspaceFileChangesRequest,
  WorkspaceFileExistence,
  WorkspaceFilePreview,
  WorkspaceFilePreviewLineRange,
  WorkspaceFilePreviewPaneState,
  WorkspaceFilePreviewRenderKind,
  WorkspaceFilePreviewRequest,
  WorkspaceFilePreviewStatus,
  WorkspaceOpenFilePreviewIntent,
  WorkspaceVisualFileRefusal,
  WorkspaceVisualFileUnavailableReason,
} from '@kontourai/station-contracts/workspace-file-preview';
export {
  isWorkspaceFilePreviewImageDataUrl,
  parseWorkspaceOpenFilePreviewIntent,
  WORKSPACE_FILE_CHANGES_MAX_BYTES,
  WORKSPACE_FILE_EXISTENCE_MAX_PATHS,
  WORKSPACE_FILE_PREVIEW_MAX_BYTES,
  WORKSPACE_FILE_PREVIEW_MAX_IMAGE_DIMENSION,
  WORKSPACE_FILE_PREVIEW_MAX_IMAGE_FINAL_RASTER_BYTES,
  WORKSPACE_FILE_PREVIEW_MAX_IMAGE_PIXELS,
  WORKSPACE_FILE_PREVIEW_MAX_LINES,
  WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR,
  WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR_ID,
  WORKSPACE_FILE_PREVIEW_PANE_RENDERER_ID,
  WORKSPACE_FILE_PREVIEW_PANE_RENDERER_NAME,
  WORKSPACE_FILE_PREVIEW_PANE_VERSION,
} from '@kontourai/station-contracts/workspace-file-preview';
export {
  isRepositoryBusyError,
  type ProjectWorkspacePaneAvailabilityProjection,
  type ProjectWorkspacePaneCatalog,
  previewProjectWorkspaceFile,
  readProjectWorkspaceFileChanges,
} from './client/projects';
export { listExistingProjectWorkspaceFiles } from './client/workspace-file-existence';
export {
  useProjectWorkspaceFileChangesQuery,
  useProjectWorkspaceFilePreviewQuery,
} from './query-domains/workspaceProjects';

export interface WorkspaceFilePreviewDownload {
  filename: string;
  bytes: Uint8Array;
}

/**
 * Fetches the server's attachment-only HTML/PDF handoff through the same
 * authenticated JSON POST transport as the project preview read. Keeping the
 * path in a bounded body prevents it entering URLs, history, referrers, and
 * proxy cache keys. Callers receive bytes, never a filesystem path, `file://`
 * URL, browser target, or HTML document to mount in Station's origin.
 */
export async function downloadProjectWorkspaceFilePreview(
  projectSlug: string,
  path: string,
  thread?: string,
): Promise<WorkspaceFilePreviewDownload> {
  const apiBase = await _getApiBase();
  const response = await mutateJson(
    `${apiBase}/api/projects/${encodeURIComponent(projectSlug)}/file-preview/download`,
    'POST',
    undefined,
    thread ? { path, thread } : { path },
  );
  if (!response.ok) {
    throw new Error('Station could not prepare the file handoff.');
  }
  return {
    filename: path.split('/').slice(-1)[0] || 'workspace-file',
    bytes: new Uint8Array(await response.arrayBuffer()),
  };
}

/** Read a local visual without navigating to a host filesystem path. */
export async function readProjectWorkspaceVisualFile(
  apiBase: string,
  projectSlug: string,
  path: string,
  opts?: ClientRequestOptions,
  thread?: string,
): Promise<WorkspaceVisualFile> {
  const response = await mutateJson(
    `${apiBase}/api/projects/${encodeURIComponent(projectSlug)}/file-preview/visual`,
    'POST',
    { ...opts, readOnly: true, maxResponseBytes: 10 * 1024 * 1024 },
    { path, ...(thread ? { thread } : {}) },
  );
  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      rethrowDeadline(error);
      // A proxy or auth page: no refusal reason, decided by status alone.
    }
    throw new WorkspaceVisualFileError(
      response.status,
      workspaceVisualFileUnavailableReason(response.status, body),
    );
  }
  const body: { success: boolean; data?: WorkspaceVisualFile } =
    await response.json();
  if (!body.success || !body.data)
    throw new WorkspaceVisualFileError(response.status, 'unavailable');
  return parseWorkspaceVisualFile(body.data);
}

/**
 * A visual-file read that failed, with the reason: the server's refusal, or
 * `unauthorized` (401, or a 403 with no refusal), `server-error` (5xx) or
 * `unavailable` (anything else, such as an older host's reasonless 404).
 * Renderers branch on `reason`, never on the message.
 */
export class WorkspaceVisualFileError extends Error {
  readonly status: number;
  readonly reason: WorkspaceVisualFileUnavailableReason;

  constructor(status: number, reason: WorkspaceVisualFileUnavailableReason) {
    super(`Visual file unavailable (${reason}, HTTP ${status})`);
    this.name = 'WorkspaceVisualFileError';
    this.status = status;
    this.reason = reason;
  }
}

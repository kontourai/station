/**
 * Opt-in, browser-safe file preview access. This subpath only exposes a
 * bounded read contract; renderers decide how to display a returned result.
 */

import { _getApiBase } from './api-core.js';
import { mutateJson } from './client/http.js';

export type {
  WorkspaceFilePreview,
  WorkspaceFilePreviewLineRange,
  WorkspaceFilePreviewPaneState,
  WorkspaceFilePreviewRenderKind,
  WorkspaceFilePreviewRequest,
  WorkspaceFilePreviewStatus,
  WorkspaceOpenFilePreviewIntent,
} from '@kontourai/station-contracts/workspace-file-preview';
export {
  isWorkspaceFilePreviewImageDataUrl,
  parseWorkspaceOpenFilePreviewIntent,
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
  type ProjectWorkspacePaneAvailabilityProjection,
  type ProjectWorkspacePaneCatalog,
  previewProjectWorkspaceFile,
} from './client/projects';
export { useProjectWorkspaceFilePreviewQuery } from './query-domains/workspaceProjects';

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
): Promise<WorkspaceFilePreviewDownload> {
  const apiBase = await _getApiBase();
  const response = await mutateJson(
    `${apiBase}/api/projects/${encodeURIComponent(projectSlug)}/file-preview/download`,
    'POST',
    undefined,
    { path },
  );
  if (!response.ok) {
    throw new Error('Station could not prepare the file handoff.');
  }
  return {
    filename: path.split('/').slice(-1)[0] || 'workspace-file',
    bytes: new Uint8Array(await response.arrayBuffer()),
  };
}

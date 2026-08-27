/**
 * Read-only, project-bound file preview contract. A preview is descriptive
 * data for a Workspace Pane; it never grants filesystem authority or asks a
 * renderer to execute the returned content.
 */

export const WORKSPACE_FILE_PREVIEW_MAX_BYTES = 512 * 1024;
export const WORKSPACE_FILE_PREVIEW_MAX_LINES = 500;
export const WORKSPACE_FILE_PREVIEW_MAX_IMAGE_DIMENSION = 8_192;
export const WORKSPACE_FILE_PREVIEW_MAX_IMAGE_PIXELS = 16_777_216;
/** A compressed PNG must not induce an unbounded browser decode allocation. */
export const WORKSPACE_FILE_PREVIEW_MAX_IMAGE_DECODED_BYTES = 16 * 1024 * 1024;
/**
 * A browser can expand a low-bit-depth PNG beyond its source sample bytes.
 * Bound its conservative RGBA raster allocation before returning a data URL.
 */
export const WORKSPACE_FILE_PREVIEW_MAX_IMAGE_FINAL_RASTER_BYTES =
  16 * 1024 * 1024;
export const WORKSPACE_FILE_PREVIEW_PANE_VERSION = '1.0' as const;
export const WORKSPACE_FILE_PREVIEW_MAX_PATH_LENGTH = 1024;
export const WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR_ID =
  'pane:builtin:workspace-preview:file-preview';
export const WORKSPACE_FILE_PREVIEW_PANE_RENDERER_ID =
  'renderer:builtin:builtin-component:workspace-file-preview';
export const WORKSPACE_FILE_PREVIEW_PANE_RENDERER_NAME =
  'workspace-file-preview';
export const WORKSPACE_FILE_PREVIEW_PANE_SOURCE_ID =
  'builtin:workspace-file-preview';

const parsedWorkspaceFilePreviewPaneDescriptor = parseWorkspacePaneDescriptor({
  version: WORKSPACE_PANE_CONTRACT_VERSION,
  id: WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR_ID,
  name: 'File Preview',
  description: 'Inspect a bounded preview of a Project workspace file.',
  rendererId: WORKSPACE_FILE_PREVIEW_PANE_RENDERER_ID,
  renderer: {
    kind: 'builtin-component',
    name: WORKSPACE_FILE_PREVIEW_PANE_RENDERER_NAME,
  },
  placement: {
    supportedRegions: ['primary', 'secondary', 'standalone'],
    preferredRegion: 'secondary',
  },
  modes: [
    { id: 'default', contextRequirement: { project: true, source: true } },
  ],
  provenance: { origin: 'builtin' },
  lifecycle: { stage: 'preview' },
});

if (!parsedWorkspaceFilePreviewPaneDescriptor)
  throw new Error('Canonical File Preview pane descriptor must be valid');

/** One code-owned descriptor shared by server catalog and UI registry. */
export const WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR =
  parsedWorkspaceFilePreviewPaneDescriptor;

/**
 * The entire persisted, data-only state for an initial File Preview pane.
 * It is deliberately separate from a host document: geometry never learns a
 * path and this shape never contains a renderer, URL, or filesystem root.
 */
export interface WorkspaceFilePreviewPaneState {
  version: typeof WORKSPACE_FILE_PREVIEW_PANE_VERSION;
  projectSlug: string;
  path: string;
  lineRange?: WorkspaceFilePreviewLineRange;
  wrap: boolean;
  markdownMode?: 'rendered' | 'source';
}

export type WorkspaceFilePreviewStatus =
  | 'ready'
  | 'binary'
  | 'oversized'
  | 'unsupported'
  | 'missing'
  | 'unreadable';

export type WorkspaceFilePreviewRenderKind =
  | 'source'
  | 'text'
  | 'markdown'
  | 'image'
  | 'html'
  | 'pdf'
  | 'unknown';

export interface WorkspaceFilePreviewLineRange {
  /** One-based, inclusive line number. */
  start: number;
  /** One-based, inclusive line number. */
  end: number;
}

/**
 * A host-neutral request to open one exact Project file preview. It carries
 * no workspace root, pane instance, renderer, or host placement state.
 */
export interface WorkspaceOpenFilePreviewIntent {
  projectSlug: string;
  path: string;
  /** Optional one-based, inclusive selection to reveal and carry forward. */
  lineRange?: WorkspaceFilePreviewLineRange;
}

export interface WorkspaceFilePreviewRequest {
  /** A workspace-relative file path. Absolute and traversal paths are invalid. */
  path: string;
  /** An optional bounded, one-based inclusive line selection. */
  lineRange?: WorkspaceFilePreviewLineRange;
}

export interface WorkspaceFilePreview {
  /** Normalized, workspace-relative path. Never an absolute host path. */
  path: string;
  status: WorkspaceFilePreviewStatus;
  renderKind: WorkspaceFilePreviewRenderKind;
  sizeBytes?: number;
  /** Exact decoded text line count before any bounded renderer projection. */
  lineCount?: number;
  mimeType?: string;
  lineRange?: WorkspaceFilePreviewLineRange;
  /** Present only for bounded, strictly valid UTF-8 source or plain text. */
  content?: string;
  /** Present only for a bounded, server-validated raster image allowlist. */
  dataUrl?: string;
}

const WORKSPACE_FILE_PREVIEW_PNG_DATA_URL_PREFIX = 'data:image/png;base64,';
const BASE64_PAYLOAD =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Re-validates the narrow image transport before a browser renderer uses it. */
export function isWorkspaceFilePreviewImageDataUrl(
  value: unknown,
  mimeType: unknown,
): value is string {
  if (
    typeof value !== 'string' ||
    mimeType !== 'image/png' ||
    !value.startsWith(WORKSPACE_FILE_PREVIEW_PNG_DATA_URL_PREFIX)
  )
    return false;
  const payload = value.slice(
    WORKSPACE_FILE_PREVIEW_PNG_DATA_URL_PREFIX.length,
  );
  return (
    payload.length > 0 &&
    payload.length <= Math.ceil(WORKSPACE_FILE_PREVIEW_MAX_BYTES / 3) * 4 &&
    BASE64_PAYLOAD.test(payload)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Object.values(Object.getOwnPropertyDescriptors(value)).every(
      (descriptor) =>
        descriptor.get === undefined && descriptor.set === undefined,
    );
  } catch {
    return false;
  }
}

function isIdentity(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value === value.trim() &&
    value.length <= 192
  );
}

/** Relative POSIX paths only. The service independently resolves containment. */
export function isWorkspaceFilePreviewRelativePath(
  value: unknown,
): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > WORKSPACE_FILE_PREVIEW_MAX_PATH_LENGTH ||
    value !== value.trim() ||
    value.includes('\0') ||
    value.includes('\\') ||
    value.startsWith('/') ||
    value.startsWith('\\\\') ||
    /^[a-zA-Z]:[\\/]/.test(value)
  )
    return false;
  return value
    .split('/')
    .every(
      (segment) => segment.length > 0 && segment !== '.' && segment !== '..',
    );
}

function parseLineRange(
  value: unknown,
): WorkspaceFilePreviewLineRange | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('lineRange must be an object');
  const { start, end } = value;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    (start as number) < 1 ||
    (end as number) < (start as number) ||
    (end as number) - (start as number) + 1 > WORKSPACE_FILE_PREVIEW_MAX_LINES
  ) {
    throw new Error(
      `lineRange must be a one-based inclusive range of at most ${WORKSPACE_FILE_PREVIEW_MAX_LINES} lines`,
    );
  }
  return { start: start as number, end: end as number };
}

/** Strictly validates a cross-surface File Preview request before a host acts. */
export function parseWorkspaceOpenFilePreviewIntent(
  value: unknown,
): WorkspaceOpenFilePreviewIntent | null {
  if (!isRecord(value)) return null;
  if (
    Object.keys(value).some(
      (key) => key !== 'projectSlug' && key !== 'path' && key !== 'lineRange',
    ) ||
    !isIdentity(value.projectSlug) ||
    !isWorkspaceFilePreviewRelativePath(value.path)
  )
    return null;
  try {
    const lineRange = parseLineRange(value.lineRange);
    return {
      projectSlug: value.projectSlug,
      path: value.path,
      ...(lineRange ? { lineRange } : {}),
    };
  } catch {
    return null;
  }
}

/** Parse untrusted transport input without normalizing its filesystem path. */
export function parseWorkspaceFilePreviewRequest(
  value: unknown,
): WorkspaceFilePreviewRequest {
  if (
    !isRecord(value) ||
    typeof value.path !== 'string' ||
    !value.path.trim()
  ) {
    throw new Error('path is required');
  }
  if (Object.keys(value).some((key) => key !== 'path' && key !== 'lineRange')) {
    throw new Error('unknown preview request field');
  }
  return {
    path: value.path,
    lineRange: parseLineRange(value.lineRange),
  };
}

/** Strictly admits only the declared state fields from browser persistence. */
export function parseWorkspaceFilePreviewPaneState(
  value: unknown,
): WorkspaceFilePreviewPaneState | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (
    keys.some(
      (key) =>
        key !== 'version' &&
        key !== 'projectSlug' &&
        key !== 'path' &&
        key !== 'lineRange' &&
        key !== 'wrap' &&
        key !== 'markdownMode',
    ) ||
    value.version !== WORKSPACE_FILE_PREVIEW_PANE_VERSION ||
    !isIdentity(value.projectSlug) ||
    !isWorkspaceFilePreviewRelativePath(value.path) ||
    typeof value.wrap !== 'boolean' ||
    (value.markdownMode !== undefined &&
      value.markdownMode !== 'rendered' &&
      value.markdownMode !== 'source')
  )
    return null;
  try {
    const lineRange = parseLineRange(value.lineRange);
    return {
      version: WORKSPACE_FILE_PREVIEW_PANE_VERSION,
      projectSlug: value.projectSlug,
      path: value.path,
      ...(lineRange ? { lineRange } : {}),
      wrap: value.wrap,
      ...(value.markdownMode
        ? { markdownMode: value.markdownMode as 'rendered' | 'source' }
        : {}),
    };
  } catch {
    return null;
  }
}

import {
  parseWorkspacePaneDescriptor,
  WORKSPACE_PANE_CONTRACT_VERSION,
} from './workspace-pane.js';

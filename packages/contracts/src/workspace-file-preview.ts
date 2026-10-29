import type { HtmlReplyPage } from './html-reply.js';

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
    supportedRegions: ['primary', 'secondary', 'standalone', 'docked'],
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

/**
 * One code-owned descriptor shared by server catalog and UI registry.
 *
 * `docked` since #2049, when the reader #2047 was waiting for arrived: a
 * chat's repo-relative link and a docked Files pane's file click both open a
 * preview as a dock tab through `openInRegion`, keyed by the instance's
 * `file-preview:<nonce>` id.
 *
 * It is still not offered by a region's chooser: it has no blank canonical
 * instance — an occurrence is keyed by a file path — so a row could be
 * listed but never opened. The chooser lists registry surfaces, and no
 * prefix family is a registry key (`region-model.ts`,
 * `INSTANCE_SURFACE_PREFIXES`); the link handler is its opener.
 */
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
  /**
   * The session whose directory the preview reads (#2476): a file a model
   * named in an isolated worktree previews from that worktree. Absent: the
   * project checkout. Older builds drop a state carrying it.
   */
  thread?: string;
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
  /**
   * The session whose own directory (an isolated worktree) to read instead of
   * the project checkout. Refused, never substituted, when the caller may not
   * read that session.
   */
  thread?: string;
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

function parseThread(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value || value.length > 200)
    throw new Error('thread must be a session thread id');
  return value;
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
  if (
    Object.keys(value).some(
      (key) => key !== 'path' && key !== 'lineRange' && key !== 'thread',
    )
  ) {
    throw new Error('unknown preview request field');
  }
  const thread = parseThread(value.thread);
  return {
    path: value.path,
    lineRange: parseLineRange(value.lineRange),
    ...(thread ? { thread } : {}),
  };
}

/**
 * How many paths one existence check may name. A chat message that mentions
 * more files than this links the first ones only; the cap bounds the
 * filesystem work a single request can ask of the server.
 */
export const WORKSPACE_FILE_EXISTENCE_MAX_PATHS = 64;

/**
 * Which of a set of workspace-relative paths name regular files the preview
 * route would serve. Used to decide whether a path a model wrote in prose is
 * a link at all: a path that does not resolve is left as text, so a
 * hallucinated or stale path never renders as something clickable.
 */
export interface WorkspaceFileExistenceRequest {
  paths: string[];
  /** As on a preview request: the session whose directory to check. */
  thread?: string;
}

/**
 * Largest per-file change patch the server returns. A larger one is refused
 * as `oversized`, never truncated: half a patch reads as the whole change.
 */
export const WORKSPACE_FILE_CHANGES_MAX_BYTES = 256 * 1024;

/** One file's changes, read with the same path and session rules as a preview. */
export interface WorkspaceFileChangesRequest {
  path: string;
  thread?: string;
}

/**
 * The working tree against the repository's HEAD commit (staged and unstaged
 * together, what `git diff HEAD -- <file>` reports) for one previewed file.
 * Each non-`changed` state is a distinct fact the reader is told; none of
 * them is an empty patch standing in for "no changes".
 */
export type WorkspaceFileChanges =
  | { state: 'changed'; base: 'HEAD'; patch: string }
  | { state: 'unchanged'; base: 'HEAD' }
  /** Not tracked by git (new, or ignored): there is no HEAD version. */
  | { state: 'untracked' }
  /** The file is not inside a git working tree. */
  | { state: 'not-a-repository' }
  /** The repository has no commit yet, so there is no HEAD to compare. */
  | { state: 'no-commits' }
  | { state: 'oversized'; limitBytes: number }
  /** The repository's own config defines programs `git diff` would run. */
  | { state: 'refused'; reason: string };

export interface WorkspaceFileExistence {
  /** The subset of the requested paths that are previewable regular files. */
  files: string[];
}

/** Parse untrusted transport input; paths are validated, not normalized. */
export function parseWorkspaceFileExistenceRequest(
  value: unknown,
): WorkspaceFileExistenceRequest {
  if (!isRecord(value) || !Array.isArray(value.paths)) {
    throw new Error('paths is required');
  }
  if (Object.keys(value).some((key) => key !== 'paths' && key !== 'thread')) {
    throw new Error('unknown existence request field');
  }
  const thread = parseThread(value.thread);
  if (value.paths.length > WORKSPACE_FILE_EXISTENCE_MAX_PATHS) {
    throw new Error('too many paths');
  }
  if (!value.paths.every(isWorkspaceFilePreviewRelativePath)) {
    throw new Error('paths must be workspace-relative');
  }
  return {
    paths: [...new Set(value.paths)],
    ...(thread ? { thread } : {}),
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
        key !== 'markdownMode' &&
        key !== 'thread',
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
    const thread = parseThread(value.thread);
    return {
      version: WORKSPACE_FILE_PREVIEW_PANE_VERSION,
      projectSlug: value.projectSlug,
      path: value.path,
      ...(lineRange ? { lineRange } : {}),
      wrap: value.wrap,
      ...(value.markdownMode
        ? { markdownMode: value.markdownMode as 'rendered' | 'source' }
        : {}),
      ...(thread ? { thread } : {}),
    };
  } catch {
    return null;
  }
}

import {
  parseWorkspacePaneDescriptor,
  WORKSPACE_PANE_CONTRACT_VERSION,
} from './workspace-pane.js';

/** Bounded visual bytes read from a Project workspace or verified Git worktree. */
export type WorkspaceVisualFile =
  | { kind: 'html'; page: HtmlReplyPage; frameOrigin?: string }
  | { kind: 'image'; preview: WorkspaceFilePreview };

export function parseWorkspaceVisualFile(value: unknown): WorkspaceVisualFile {
  if (!isRecord(value)) throw new Error('Invalid visual file response');
  if (
    value.kind === 'html' &&
    isRecord(value.page) &&
    value.page.version === 1 &&
    typeof value.page.html === 'string' &&
    value.page.html.length <= 8 * 1024 * 1024 &&
    typeof value.page.height === 'number' &&
    Number.isInteger(value.page.height) &&
    value.page.height >= 100 &&
    value.page.height <= 2000 &&
    (value.frameOrigin === undefined || typeof value.frameOrigin === 'string')
  ) {
    return {
      kind: 'html',
      page: { version: 1, html: value.page.html, height: value.page.height },
      ...(typeof value.frameOrigin === 'string'
        ? { frameOrigin: value.frameOrigin }
        : {}),
    };
  }
  if (
    value.kind === 'image' &&
    isRecord(value.preview) &&
    value.preview.status === 'ready' &&
    value.preview.renderKind === 'image' &&
    typeof value.preview.mimeType === 'string' &&
    isWorkspaceFilePreviewRelativePath(value.preview.path) &&
    isWorkspaceFilePreviewImageDataUrl(
      value.preview.dataUrl,
      value.preview.mimeType,
    )
  ) {
    return {
      kind: 'image',
      preview: {
        path: value.preview.path,
        status: 'ready',
        renderKind: 'image',
        mimeType: value.preview.mimeType,
        dataUrl: value.preview.dataUrl,
      },
    };
  }
  throw new Error('Invalid visual file response');
}

/**
 * Why the visual-file read refused a path. The server checks in an order that
 * never reveals whether a file exists outside the allowed folders: the path's
 * form and extension first, then a path-only containment check, and only then
 * the filesystem. A link that leads out of the allowed folders, dangling or
 * not, is `outside-project`.
 */
export type WorkspaceVisualFileRefusal =
  /** Inside the allowed folders, but nothing is there. */
  | 'missing'
  /** Outside the Project workspace and its verified worktrees, or not a plain path. */
  | 'outside-project'
  /** Not a PNG image or an HTML page this reader can show. */
  | 'unsupported-type'
  /** Larger than {@link WORKSPACE_FILE_PREVIEW_MAX_BYTES} or the image raster bounds. */
  | 'too-large'
  /** The Project (or the requested session) has no readable workspace. */
  | 'no-workspace'
  /** Present and allowed, but the host could not read it. */
  | 'unreadable';

export const WORKSPACE_VISUAL_FILE_REFUSALS: readonly WorkspaceVisualFileRefusal[] =
  [
    'missing',
    'outside-project',
    'unsupported-type',
    'too-large',
    'no-workspace',
    'unreadable',
  ];

/** The HTTP status the visual-file route answers each refusal with. */
export const WORKSPACE_VISUAL_FILE_REFUSAL_STATUS: Readonly<
  Record<WorkspaceVisualFileRefusal, number>
> = {
  missing: 404,
  'no-workspace': 404,
  'outside-project': 403,
  'unsupported-type': 415,
  'too-large': 413,
  unreadable: 422,
};

/**
 * Why a client could not show a visual file: a server refusal, or a failure
 * the client observed itself. `unauthorized` is a 401, or a 403 without a
 * refusal reason (the authorization layer, not the reader). `server-error` is
 * a 5xx. `unavailable` is any other answer without a reason, such as an older
 * host's single 404.
 */
export type WorkspaceVisualFileUnavailableReason =
  | WorkspaceVisualFileRefusal
  | 'unauthorized'
  | 'server-error'
  | 'unavailable';

/** The refusal a visual-file response body names, or undefined. */
export function parseWorkspaceVisualFileRefusal(
  body: unknown,
): WorkspaceVisualFileRefusal | undefined {
  if (!isRecord(body) || typeof body.reason !== 'string') return undefined;
  return (WORKSPACE_VISUAL_FILE_REFUSALS as readonly string[]).includes(
    body.reason,
  )
    ? (body.reason as WorkspaceVisualFileRefusal)
    : undefined;
}

/** The reason a failed visual-file response stands for. */
export function workspaceVisualFileUnavailableReason(
  status: number,
  body: unknown,
): WorkspaceVisualFileUnavailableReason {
  const refusal = parseWorkspaceVisualFileRefusal(body);
  // A refusal is believed only with the status the route pairs it with, so a
  // proxy's or the auth layer's answer is never read as the reader's.
  if (refusal && WORKSPACE_VISUAL_FILE_REFUSAL_STATUS[refusal] === status)
    return refusal;
  if (status === 401 || status === 403) return 'unauthorized';
  if (status >= 500) return 'server-error';
  return 'unavailable';
}

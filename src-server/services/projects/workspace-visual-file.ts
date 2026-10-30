import { lstat, realpath, stat } from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import {
  WORKSPACE_FILE_PREVIEW_MAX_BYTES,
  WORKSPACE_FILE_PREVIEW_MAX_PATH_LENGTH,
  type WorkspaceVisualFile,
  type WorkspaceVisualFileRefusal,
} from '@kontourai/station-contracts/workspace-file-preview';
import { prepareHtmlReply } from '../html-replies.js';
import { listVerifiedWorktrees } from './verified-worktrees.js';
import { WorkspaceFilePreviewService } from './workspace-file-preview-service.js';

export type WorkspaceVisualFileRead =
  | { visual: WorkspaceVisualFile }
  | { refused: WorkspaceVisualFileRefusal };

/** The visual kinds this reader serves, decided by name before any I/O. */
const VISUAL_EXTENSION = /\.(?:html?|png)$/i;

/** `target` relative to `directory` when strictly inside it, else null. */
function within(directory: string, target: string): string | null {
  const value = relative(directory, target);
  return value &&
    value !== '..' &&
    !value.startsWith(`..${sep}`) &&
    !isAbsolute(value)
    ? value.split(sep).join('/')
    : null;
}

type Resolution =
  | { kind: 'resolved'; path: string }
  /** Nothing is at the path; `path` is its resolved parent plus its name. */
  | { kind: 'absent'; path: string }
  /** A link (here or in an ancestor) that resolves to nothing. */
  | { kind: 'dangling' };

/**
 * Resolves `path` through every link. A path that does not resolve is
 * resolved through its nearest existing ancestor, so a missing file inside a
 * root is told apart from one whose ancestor link leads elsewhere; a link
 * whose target is missing is `dangling`, never `absent`, so a link cannot
 * report whether its outside target exists.
 */
async function resolveThroughLinks(path: string): Promise<Resolution> {
  try {
    return { kind: 'resolved', path: await realpath(path) };
  } catch {
    // Any failure (ENOENT, ENOTDIR, EACCES) is decided the same way, so a
    // folder this user cannot search answers like a missing one.
  }
  try {
    await lstat(path);
    // Something is at the path, yet it does not resolve: a broken link.
    return { kind: 'dangling' };
  } catch {
    // Nothing at the path itself; decide by the parent.
  }
  const parent = dirname(path);
  if (parent === path) return { kind: 'absent', path };
  const resolved = await resolveThroughLinks(parent);
  return resolved.kind === 'dangling'
    ? resolved
    : { kind: 'absent', path: join(resolved.path, basename(path)) };
}

/**
 * Reads an HTML page or PNG image a reply named, from the configured
 * workspace or a verified Git worktree of it only, and says why when it
 * refuses. Form and extension are decided by name before any filesystem
 * access, and the answer for a path that does not resolve inside those
 * folders never depends on whether anything exists there.
 */
export async function readWorkspaceVisualFile(
  workspace: string,
  path: string,
): Promise<WorkspaceVisualFileRead> {
  if (
    path.length > WORKSPACE_FILE_PREVIEW_MAX_PATH_LENGTH ||
    path.includes('\0') ||
    path.split(/[\\/]/).includes('..')
  )
    return { refused: 'outside-project' };
  if (!VISUAL_EXTENSION.test(path)) return { refused: 'unsupported-type' };

  let root: string;
  try {
    root = await realpath(workspace);
  } catch {
    return { refused: 'no-workspace' };
  }
  // Worktrees are listed (a git call) only for a path the workspace does not
  // already contain.
  let worktrees: readonly string[] | undefined;
  const worktreeRoots = async () => {
    worktrees ??= await listVerifiedWorktrees(root, 5000);
    return worktrees;
  };

  // Containment is decided on resolved paths only. A path-only check cannot
  // be the gate: `/tmp/p/x.png` and `/var/folders/…` name folders macOS
  // resolves under `/private`, and a worktree is known only by its resolved
  // path. What is outside still cannot be learned: a missing file is resolved
  // through its nearest existing ancestor and a broken link is `dangling`,
  // so any path that does not end inside the Project answers
  // `outside-project`, whether or not anything exists there.
  const requested = isAbsolute(path) ? resolve(path) : resolve(root, path);
  const resolution = await resolveThroughLinks(requested);
  if (resolution.kind === 'dangling') return { refused: 'outside-project' };
  const target = resolution.path;
  let directory = root;
  let file = within(root, target);
  if (!file) {
    for (const checkout of await worktreeRoots()) {
      file = within(checkout, target);
      if (file) {
        directory = checkout;
        break;
      }
    }
  }
  // Resolved outside: the path, or a link along it, leads out.
  if (!file) return { refused: 'outside-project' };
  if (resolution.kind === 'absent') return { refused: 'missing' };

  try {
    const info = await stat(target);
    if (!info.isFile()) return { refused: 'unsupported-type' };
    if (info.size > WORKSPACE_FILE_PREVIEW_MAX_BYTES)
      return { refused: 'too-large' };
  } catch {
    return { refused: 'unreadable' };
  }

  const reader = new WorkspaceFilePreviewService();
  if (/\.html?$/i.test(file)) {
    const attachment = reader.download(directory, { path: file });
    if (!attachment) return { refused: 'unreadable' };
    let html: string;
    try {
      html = new TextDecoder('utf-8', { fatal: true }).decode(attachment.bytes);
    } catch {
      return { refused: 'unsupported-type' };
    }
    return {
      visual: {
        kind: 'html',
        page: await prepareHtmlReply({ html, height: 600 }, directory),
      },
    };
  }
  let preview: ReturnType<WorkspaceFilePreviewService['preview']>;
  try {
    preview = reader.preview(directory, { path: file });
  } catch {
    // The preview refuses links and escapes; the file changed under the read.
    return { refused: 'outside-project' };
  }
  if (
    preview.status === 'ready' &&
    preview.renderKind === 'image' &&
    preview.dataUrl
  )
    return { visual: { kind: 'image', preview } };
  switch (preview.status) {
    case 'missing':
      return { refused: 'missing' };
    case 'oversized':
      return { refused: 'too-large' };
    case 'unreadable':
      return { refused: 'unreadable' };
    default:
      // Not a PNG by content, or past the decode bounds.
      return { refused: 'unsupported-type' };
  }
}

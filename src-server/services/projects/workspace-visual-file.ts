import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { WorkspaceVisualFile } from '@kontourai/station-contracts/workspace-file-preview';
import { prepareHtmlReply } from '../html-replies.js';
import { listVerifiedWorktrees } from './verified-worktrees.js';
import { WorkspaceFilePreviewService } from './workspace-file-preview-service.js';

/** Only the configured workspace and verified checkouts may supply visual bytes. */
export async function readWorkspaceVisualFile(
  workspace: string,
  path: string,
): Promise<WorkspaceVisualFile | null> {
  if (
    path.length > 1024 ||
    path.includes('\0') ||
    path.split(/[\\/]/).includes('..')
  )
    return null;
  const root = await realpath(workspace);
  const target = await realpath(isAbsolute(path) ? path : resolve(root, path));
  const within = (directory: string) => {
    const value = relative(directory, target);
    return value &&
      value !== '..' &&
      !value.startsWith(`..${sep}`) &&
      !isAbsolute(value)
      ? value.split(sep).join('/')
      : null;
  };
  let directory = root;
  let file = within(root);
  if (!file) {
    for (const checkout of await listVerifiedWorktrees(root, 5000)) {
      file = within(checkout);
      if (file) {
        directory = checkout;
        break;
      }
    }
  }
  if (!file) return null;
  const reader = new WorkspaceFilePreviewService();
  if (/\.html?$/i.test(file)) {
    const attachment = reader.download(directory, { path: file });
    if (!attachment) return null;
    const html = new TextDecoder('utf-8', { fatal: true }).decode(
      attachment.bytes,
    );
    return {
      kind: 'html',
      page: await prepareHtmlReply({ html, height: 600 }, directory),
    };
  }
  const preview = reader.preview(directory, { path: file });
  return preview.status === 'ready' &&
    preview.renderKind === 'image' &&
    preview.dataUrl
    ? { kind: 'image', preview }
    : null;
}

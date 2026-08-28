/**
 * CodingFilesContextProvider — injects the contents of files the user attaches
 * from the coding file explorer into the next chat message.
 *
 * Unlike the ambient providers (timezone, geolocation) this one is dynamic: the
 * file explorer adds/removes entries at runtime. It is still a single
 * MessageContextProvider so it surfaces as one toggle in Settings; getContext
 * composes every attached file. A cached snapshot keeps it
 * useSyncExternalStore-safe.
 */
import type {
  WorkspaceFilePreview,
  WorkspaceOpenFilePreviewIntent,
} from '@kontourai/station-contracts/workspace-file-preview';
import { parseWorkspaceOpenFilePreviewIntent } from '@kontourai/station-contracts/workspace-file-preview';
import type { MessageContextProvider } from '@kontourai/station-sdk';
import { ListenerManager } from '@kontourai/station-sdk';
import { useSyncExternalStore } from 'react';
import {
  type FilePreviewConversationContext,
  filePreviewConversationContext,
  formatFilePreviewConversationContext,
} from './filePreviewConversationContext';

export type AttachedFile = FilePreviewConversationContext;

function fileContextKey(intent: WorkspaceOpenFilePreviewIntent): string {
  return `${intent.projectSlug}:${intent.path}:${intent.lineRange?.start ?? ''}:${intent.lineRange?.end ?? ''}`;
}

function normalizedFileContextKey(
  intent: WorkspaceOpenFilePreviewIntent,
): string | null {
  const normalized = parseWorkspaceOpenFilePreviewIntent(intent);
  return normalized ? fileContextKey(normalized) : null;
}

class CodingFilesContextProvider
  extends ListenerManager
  implements MessageContextProvider
{
  readonly id = 'coding-files';
  readonly name = 'Attached files';
  readonly description =
    'Includes the contents of files you attach from the coding file explorer in your next message.';

  private _enabled = true;
  private _files = new Map<string, AttachedFile>();
  private _cached: AttachedFile[] = [];

  get enabled(): boolean {
    return this._enabled;
  }

  set enabled(value: boolean) {
    if (value === this._enabled) return;
    this._enabled = value;
    this._notify();
  }

  private _refresh(): void {
    this._cached = Array.from(this._files.values());
    this._notify();
  }

  addFile(
    intent: WorkspaceOpenFilePreviewIntent,
    preview: WorkspaceFilePreview,
  ): boolean {
    const context = filePreviewConversationContext(intent, preview);
    if (!context) return false;
    this._files.set(fileContextKey(context), context);
    this._refresh();
    return true;
  }

  removeFile(intent: WorkspaceOpenFilePreviewIntent): void {
    const key = normalizedFileContextKey(intent);
    if (key && this._files.delete(key)) this._refresh();
  }

  removeFilesAtPath(projectSlug: string, path: string): void {
    const normalized = parseWorkspaceOpenFilePreviewIntent({
      projectSlug,
      path,
    });
    if (!normalized) return;

    let removed = false;
    for (const [key, file] of this._files) {
      if (
        file.projectSlug === normalized.projectSlug &&
        file.path === normalized.path
      ) {
        this._files.delete(key);
        removed = true;
      }
    }
    if (removed) this._refresh();
  }

  clear(): void {
    if (this._files.size > 0) {
      this._files.clear();
      this._refresh();
    }
  }

  has(intent: WorkspaceOpenFilePreviewIntent): boolean {
    const key = normalizedFileContextKey(intent);
    return key ? this._files.has(key) : false;
  }

  /** Stable snapshot for useSyncExternalStore. */
  list(): AttachedFile[] {
    return this._cached;
  }

  getContext(): string | null {
    if (!this._enabled || this._files.size === 0) return null;
    return Array.from(this._files.values())
      .map(formatFilePreviewConversationContext)
      .join('\n\n');
  }

  destroy(): void {
    this._clearListeners();
  }
}

export const codingFilesContextProvider = new CodingFilesContextProvider();

/** Subscribe to the attached-file list (and expose add/remove helpers). */
export function useCodingFilesContext() {
  const files = useSyncExternalStore(codingFilesContextProvider.subscribe, () =>
    codingFilesContextProvider.list(),
  );
  return {
    files,
    has: (intent: WorkspaceOpenFilePreviewIntent) =>
      codingFilesContextProvider.has(intent),
    addFile: (
      intent: WorkspaceOpenFilePreviewIntent,
      preview: WorkspaceFilePreview,
    ) => codingFilesContextProvider.addFile(intent, preview),
    removeFile: (intent: WorkspaceOpenFilePreviewIntent) =>
      codingFilesContextProvider.removeFile(intent),
    removeFilesAtPath: (projectSlug: string, path: string) =>
      codingFilesContextProvider.removeFilesAtPath(projectSlug, path),
  };
}

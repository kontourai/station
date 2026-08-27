import type {
  WorkspaceFilePreview,
  WorkspaceOpenFilePreviewIntent,
} from '@kontourai/station-contracts/workspace-file-preview';
import { parseWorkspaceOpenFilePreviewIntent } from '@kontourai/station-contracts/workspace-file-preview';

export const MAX_FILE_PREVIEW_CONVERSATION_CONTEXT_BYTES = 64 * 1024;

export interface FilePreviewConversationContext
  extends WorkspaceOpenFilePreviewIntent {
  content: string;
}

const utf8 = new TextEncoder();

/**
 * Admits only an exact bounded source/text result from the Project preview
 * authority. Context insertion never rereads a path through the older coding
 * file endpoint and never derives line identity from client text.
 */
export function filePreviewConversationContext(
  intent: WorkspaceOpenFilePreviewIntent,
  preview: WorkspaceFilePreview,
): FilePreviewConversationContext | null {
  const normalized = parseWorkspaceOpenFilePreviewIntent(intent);
  if (
    !normalized ||
    preview.status !== 'ready' ||
    !['source', 'text', 'markdown'].includes(preview.renderKind) ||
    preview.path !== normalized.path ||
    typeof preview.content !== 'string' ||
    utf8.encode(preview.content).byteLength >
      MAX_FILE_PREVIEW_CONVERSATION_CONTEXT_BYTES ||
    (normalized.lineRange &&
      (preview.lineRange?.start !== normalized.lineRange.start ||
        preview.lineRange?.end !== normalized.lineRange.end))
  )
    return null;
  return { ...normalized, content: preview.content };
}

export function formatFilePreviewConversationContext(
  context: FilePreviewConversationContext,
): string {
  const range = context.lineRange
    ? ` (lines ${context.lineRange.start}-${context.lineRange.end})`
    : '';
  return `Project file: ${context.projectSlug}/${context.path}${range}\n\`\`\`\n${context.content}\n\`\`\``;
}

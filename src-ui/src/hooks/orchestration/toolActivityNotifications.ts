import type { ChatUIState } from '../../contexts/active-chats-state';
import { navigationStore } from '../../contexts/NavigationContext';
import { toastStore } from '../../contexts/ToastContext';
import { isReplayThread } from './replay/replay-registry';
import type { OrchestrationEvent } from './types';

type ToolCompletedEvent = Extract<
  OrchestrationEvent,
  { method: 'tool.completed' }
>;

function formatToolName(toolName: string): string {
  return toolName.trim().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ');
}

function trimDetail(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > 180 ? `${trimmed.slice(0, 177)}...` : trimmed;
}

export function summarizeToolActivityDetail(
  output: unknown,
): string | undefined {
  if (typeof output === 'string') {
    return trimDetail(output);
  }

  if (!output || typeof output !== 'object') {
    return undefined;
  }

  const record = output as Record<string, unknown>;
  const preferredKeys = ['output', 'message', 'text', 'result'];
  for (const key of preferredKeys) {
    if (typeof record[key] === 'string') {
      return trimDetail(record[key] as string);
    }
  }

  return undefined;
}

/**
 * Only a failed tool call toasts. Success and cancellation are routine, and
 * an unresolved call (station#1558: the session ended with no result) is not
 * a user-attention event; each stays visible on its tool row. The turn ending
 * is what calls the user back (`turnAttentionNotifications`).
 */
export function shouldNotifyForToolCompletion(
  event: ToolCompletedEvent,
): boolean {
  return event.status === 'error';
}

export function notifyToolCompletion(
  event: ToolCompletedEvent,
  chat: ChatUIState,
): void {
  if (isReplayThread(event.threadId)) return;
  if (!shouldNotifyForToolCompletion(event)) {
    return;
  }

  const toolName = formatToolName(event.toolName);
  const agentName = chat.agentName || chat.agentSlug || event.provider;
  const detail =
    event.error || summarizeToolActivityDetail(event.output) || undefined;

  toastStore.showToolActivity({
    sessionId: event.threadId,
    toolName,
    agentName,
    conversationTitle: chat.title,
    status: 'error',
    detail,
    onNavigate: () => {
      navigationStore.setDockState(true);
      navigationStore.setActiveChat(chat.conversationId ?? event.threadId);
    },
  });
}

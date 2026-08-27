import type { ChatUIState } from '../../contexts/active-chats-state';
import { navigationStore } from '../../contexts/NavigationContext';
import { toastStore } from '../../contexts/ToastContext';
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

function isForegroundChat(threadId: string, chat: ChatUIState): boolean {
  const navigation = navigationStore.getSnapshot();
  if (!navigation.isDockOpen) {
    return false;
  }

  return (
    navigation.activeChat === threadId ||
    navigation.activeChat === chat.conversationId ||
    navigation.activeConversation === chat.conversationId
  );
}

export function shouldNotifyForToolCompletion(
  event: ToolCompletedEvent,
  chat: ChatUIState,
): boolean {
  if (event.status !== 'success') {
    return true;
  }

  return !isForegroundChat(event.threadId, chat);
}

export function notifyToolCompletion(
  event: ToolCompletedEvent,
  chat: ChatUIState,
): void {
  if (!shouldNotifyForToolCompletion(event, chat)) {
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
    status:
      event.status === 'cancelled'
        ? 'cancelled'
        : event.status === 'error'
          ? 'error'
          : 'completed',
    detail,
    onNavigate: () => {
      navigationStore.setDockState(true);
      navigationStore.setActiveChat(chat.conversationId ?? event.threadId);
    },
  });
}

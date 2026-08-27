import { resolveOrchestrationRequest } from '@kontourai/station-sdk';
import { activeChatsStore } from '../../contexts/active-chats-store';
import { toastStore } from '../../contexts/ToastContext';
import type { OrchestrationEvent } from './types';

async function resolveApproval(
  apiBase: string,
  threadId: string,
  requestId: string,
  decision: 'accept' | 'acceptForSession' | 'decline',
) {
  await resolveOrchestrationRequest({
    apiBase,
    threadId,
    requestId,
    decision,
  });
}

export function handleRequestOpenedEvent(
  apiBase: string,
  event: Extract<OrchestrationEvent, { method: 'request.opened' }>,
) {
  const chat = activeChatsStore.getChatForExecutionSession(event.threadId);
  if (!chat) return;

  const pendingApprovals = [...(chat.pendingApprovals || [])];
  if (!pendingApprovals.includes(event.requestId)) {
    pendingApprovals.push(event.requestId);
  }
  activeChatsStore.updateChat(event.threadId, {
    pendingApprovals,
    orchestrationStatus: 'awaiting-approval',
  });

  const agentName = chat.agentName || chat.agentSlug || event.provider;
  const toastId = toastStore.showToolApproval({
    sessionId: event.threadId,
    toolName: String(event.payload?.toolName || event.title || 'Tool request'),
    agentName,
    conversationTitle: chat.title,
    actions: [
      {
        label: 'Allow Once',
        variant: 'primary',
        onClick: () => {
          void resolveApproval(
            apiBase,
            event.threadId,
            event.requestId,
            'accept',
          );
        },
      },
      {
        label: 'Allow for Session',
        variant: 'secondary',
        onClick: () => {
          void resolveApproval(
            apiBase,
            event.threadId,
            event.requestId,
            'acceptForSession',
          );
        },
      },
      {
        label: 'Deny',
        variant: 'danger',
        onClick: () => {
          void resolveApproval(
            apiBase,
            event.threadId,
            event.requestId,
            'decline',
          );
        },
      },
    ],
  });

  const approvalToasts = new Map(chat.approvalToasts || []);
  approvalToasts.set(event.requestId, toastId);
  activeChatsStore.updateChat(event.threadId, { approvalToasts });
}

export function handleRequestResolvedEvent(
  event: Extract<OrchestrationEvent, { method: 'request.resolved' }>,
) {
  const chat = activeChatsStore.getChatForExecutionSession(event.threadId);
  if (!chat) return;

  const pendingApprovals = (chat.pendingApprovals || []).filter(
    (id) => id !== event.requestId,
  );
  const approvalToasts = new Map(chat.approvalToasts || []);
  const toastId = approvalToasts.get(event.requestId);
  if (toastId) {
    toastStore.dismiss(toastId);
  }
  approvalToasts.delete(event.requestId);
  activeChatsStore.updateChat(event.threadId, {
    pendingApprovals,
    approvalToasts,
    orchestrationStatus:
      pendingApprovals.length > 0 ? 'awaiting-approval' : 'running',
  });
}

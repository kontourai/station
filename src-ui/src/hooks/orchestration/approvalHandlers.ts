import { resolveOrchestrationRequest } from '@kontourai/station-sdk';
import {
  toolRequestDisplayName,
  toolRequestPreview,
} from '@kontourai/station-shared/tool-request-preview';
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
  // #1545: the tool name alone ("Codex wants to use Bash") is not a decision an
  // operator can make. `toolRequestPreview` derives the one field that says
  // what the call will do — the command, the file, the pattern — bounded,
  // single-line and secret-redacted. `event.payload` is the live orchestration
  // event as it arrives on the stream, so `toolInput` is present here; the
  // durable inbox row gets the same preview server-side (see
  // `request-presentation.ts`), from the same derivation.
  const payloadToolName =
    typeof event.payload?.toolName === 'string'
      ? event.payload.toolName
      : undefined;
  const toolName = String(payloadToolName || event.title || 'Tool request');
  // Only name the tool in the grant label when the payload actually reported
  // one. The `event.title` fallback is adapter display text — for Codex it is
  // the literal shell command — and "Allow <a whole command line> for this
  // session" would both mislead about the grant's scope and swamp the button.
  const grantLabel = payloadToolName
    ? `Allow ${toolRequestDisplayName(payloadToolName) ?? payloadToolName} for this session`
    : 'Allow this tool for this session';
  const toastId = toastStore.showToolApproval({
    sessionId: event.threadId,
    toolName,
    toolPreview: toolRequestPreview(payloadToolName, event.payload?.toolInput),
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
        // Says what the grant covers: "Allow for Session" reads as a grant for
        // this one call, and it is a standing grant for every later call to the
        // same tool in this session.
        label: grantLabel,
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

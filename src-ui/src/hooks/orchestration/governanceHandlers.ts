import type { ChatMessage } from '../../contexts/active-chats-state';
import { activeChatsStore } from '../../contexts/active-chats-store';
import type { OrchestrationEvent } from './types';

function appendSystemMessage(threadId: string, message: ChatMessage) {
  const chat = activeChatsStore.getChatForExecutionSession(threadId);
  if (!chat) return;
  activeChatsStore.updateChat(threadId, {
    messages: [...(chat.messages || []), message],
  });
}

function eventMessageMeta(event: OrchestrationEvent) {
  const parsedTimestamp = Date.parse(event.createdAt);
  return {
    id: event.eventId ?? `${event.method}:${event.threadId}:${event.createdAt}`,
    ...(Number.isNaN(parsedTimestamp) ? {} : { timestamp: parsedTimestamp }),
  };
}

export function handlePolicyHooksAttachedEvent(
  event: Extract<OrchestrationEvent, { method: 'policy.hooks-attached' }>,
) {
  // Session-start audit. Do not add a transcript row per attach.
  void event;
}

export function handlePolicyStopVerdictEvent(
  event: Extract<OrchestrationEvent, { method: 'policy.stop-verdict' }>,
) {
  if (event.verdict === 'pass') return;
  const heading =
    event.verdict === 'block'
      ? 'Policy blocked completion.'
      : 'Policy warned on completion.';
  const warnings =
    event.warnings.length > 0 ? `\n${event.warnings.join('\n')}` : '';
  appendSystemMessage(event.threadId, {
    ...eventMessageMeta(event),
    role: 'system',
    content: `${heading}${warnings}`,
  });
}

export function handlePlatformMutationEvent(
  event: Extract<OrchestrationEvent, { method: 'platform.mutation' }>,
) {
  if (event.outcome === 'allowed') return;
  const heading =
    event.outcome === 'blocked'
      ? `Blocked platform change: ${event.tool}`
      : event.outcome === 'failed'
        ? `Platform change failed: ${event.tool}`
        : `Platform change warned: ${event.tool}`;
  appendSystemMessage(event.threadId, {
    ...eventMessageMeta(event),
    role: 'system',
    content: event.reason ? `${heading}\n${event.reason}` : heading,
  });
}

export function handleWorkflowStateChangedEvent(
  event: Extract<OrchestrationEvent, { method: 'workflow.state-changed' }>,
) {
  if (event.trigger === 'session-start') return;
  appendSystemMessage(event.threadId, {
    ...eventMessageMeta(event),
    role: 'system',
    content: event.nextActionSummary
      ? `Workflow ${event.status}: ${event.nextActionSummary}`
      : `Workflow ${event.status} (${event.phase})`,
  });
}

export function handleConversationForkedEvent(
  event: Extract<OrchestrationEvent, { method: 'conversation.forked' }>,
) {
  // Provenance for the fork UI; the live transcript is not the place to
  // restated the fork that created this conversation.
  void event;
}

import {
  type ExtensionNotificationConsumer,
  extensionNotificationBinding,
} from '@shared/extension-notification-bindings';
import type {
  ChatActivityHint,
  ChatBackgroundTask,
} from '../../contexts/active-chats-state';
import { activeChatsStore } from '../../contexts/active-chats-store';
import type { OrchestrationEvent } from './types';

function readPayloadString(payload: unknown, key: string): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function readPayloadNumber(payload: unknown, key: string): number | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function formatApproxTokens(tokens: number): string {
  if (tokens >= 1000) {
    const thousands = tokens / 1000;
    return `~${thousands >= 10 ? Math.round(thousands) : Math.round(thousands * 10) / 10}k tokens`;
  }
  return `~${tokens} tokens`;
}

/**
 * `estimatedTokens` (thinking/tokens) is a raw running count that ticks on
 * essentially every SDK reasoning delta, but `formatApproxTokens` already
 * buckets it (whole tokens under 1k, 0.1k increments at/above 1k) — so most
 * consecutive raw deltas format to the identical detail string. Comparing
 * the formatted `{ kind, detail }` hint (rather than throttling on a
 * wall-clock timer) is what actually bounds store-update/re-render churn
 * here without adding a coarser, dropped-update failure mode.
 */
function activityHintsEqual(
  a: ChatActivityHint | undefined,
  b: ChatActivityHint | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.kind === b.kind && a.detail === b.detail;
}

function readRegistryTasks(payload: unknown): ChatBackgroundTask[] {
  if (!payload || typeof payload !== 'object') return [];
  const active = (payload as { active?: unknown }).active;
  if (!Array.isArray(active)) return [];
  const tasks: ChatBackgroundTask[] = [];
  for (const entry of active) {
    if (!entry || typeof entry !== 'object') continue;
    const raw = entry as Record<string, unknown>;
    if (typeof raw.taskId !== 'string') continue;
    tasks.push({
      taskId: raw.taskId,
      toolCallId:
        typeof raw.toolCallId === 'string' ? raw.toolCallId : undefined,
      description:
        typeof raw.description === 'string' ? raw.description : undefined,
      subagentType:
        typeof raw.subagentType === 'string' ? raw.subagentType : undefined,
      backgrounded: raw.backgrounded === true,
    });
  }
  return tasks;
}

/**
 * `claude-code` namespace: activity/progress signals for phases where no
 * content deltas flow (redacted thinking, compaction) plus the
 * background-task registry that outlives assistant turns.
 */
function handleClaudeNotification(
  event: Extract<OrchestrationEvent, { method: 'extension.notification' }>,
  consumer: ExtensionNotificationConsumer,
) {
  if (consumer === 'ui.claude.thinking-tokens') {
    const estimated = readPayloadNumber(event.payload, 'estimatedTokens');
    const hint: ChatActivityHint = {
      kind: 'thinking',
      detail:
        estimated !== undefined ? formatApproxTokens(estimated) : undefined,
    };
    const current = activeChatsStore.getChatForExecutionSession(
      event.threadId,
    )?.activityHint;
    // Skip the store update entirely when the incoming hint is unchanged
    // (same kind + formatted detail) — otherwise every raw token delta
    // replaces the activityHint reference, forcing useDerivedSessions'
    // per-session cache (archive#726) to rebuild this session's derived
    // identity on essentially every SDK reasoning tick.
    if (!activityHintsEqual(current, hint)) {
      activeChatsStore.updateChat(event.threadId, { activityHint: hint });
    }
    return;
  }

  if (consumer === 'ui.claude.session-status') {
    const status = readPayloadString(event.payload, 'status');
    const current = activeChatsStore.getChatForExecutionSession(
      event.threadId,
    )?.activityHint;
    if (status === 'compacting' || status === 'requesting') {
      const hint: ChatActivityHint = { kind: status };
      if (!activityHintsEqual(current, hint)) {
        activeChatsStore.updateChat(event.threadId, { activityHint: hint });
      }
    } else if (current !== undefined) {
      // `status: null` (or unknown) is the cleared signal.
      activeChatsStore.updateChat(event.threadId, { activityHint: undefined });
    }
    return;
  }

  if (consumer === 'ui.claude.task-registry') {
    activeChatsStore.updateChat(event.threadId, {
      backgroundTasks: readRegistryTasks(event.payload),
    });
    return;
  }

  if (consumer === 'ui.claude.task-settled') {
    const taskId = readPayloadString(event.payload, 'taskId');
    const chat = activeChatsStore.getChatForExecutionSession(event.threadId);
    const remaining = (chat?.backgroundTasks || []).filter(
      (task) => task.taskId !== taskId,
    );
    const wasTracked =
      (chat?.backgroundTasks || []).length !== remaining.length;
    activeChatsStore.updateChat(event.threadId, {
      backgroundTasks: remaining,
    });
    // Only announce settles for tasks the user could see as "still working"
    // (i.e. ones that survived past their turn into the registry) — inline
    // tool parts already report same-turn completions.
    if (wasTracked) {
      const summary = readPayloadString(event.payload, 'summary');
      const description = readPayloadString(event.payload, 'description');
      const status = readPayloadString(event.payload, 'status');
      const heading =
        status === 'error'
          ? 'Background task failed'
          : status === 'cancelled'
            ? '⏹ Background task stopped'
            : 'Background task finished';
      const label = description ? `${heading} — ${description}` : heading;
      activeChatsStore.addEphemeralMessage(event.threadId, {
        role: 'system',
        content: summary ? `${label}\n\n${summary}` : label,
      });
    }
    return;
  }
}

/**
 * Renders the two functional `_kiro.dev` extension-notification cases
 * (ADR-0008: the canonical `extension.notification` envelope carries no
 * app-specific semantics — everything else is a deliberate no-op). Both
 * cases append an ephemeral system message via the existing
 * `EphemeralMessage` markdown-capable rendering path, mirroring the
 * wording/link convention of the retired `acp-bridge-events.ts`
 * (`_kiro.dev/mcp/oauth_request`, `_kiro.dev/compaction|clear/status`).
 */
export function handleExtensionNotificationEvent(
  event: Extract<OrchestrationEvent, { method: 'extension.notification' }>,
) {
  const chat = activeChatsStore.getChatForExecutionSession(event.threadId);
  if (!chat) return;
  const binding = extensionNotificationBinding(event.namespace, event.type);
  if (!binding) return;

  if (binding.consumer.startsWith('ui.claude.')) {
    handleClaudeNotification(event, binding.consumer);
    return;
  }

  if (binding.consumer === 'ui.kiro.oauth-request') {
    const url = readPayloadString(event.payload, 'url');
    if (!url) return;
    activeChatsStore.addEphemeralMessage(event.threadId, {
      role: 'system',
      content: `**Authentication required** — An MCP server needs you to sign in:\n[Open authentication page](${url})`,
    });
    return;
  }

  if (
    binding.consumer === 'ui.kiro.compaction-status' ||
    binding.consumer === 'ui.kiro.clear-status'
  ) {
    const fallback =
      binding.consumer === 'ui.kiro.compaction-status'
        ? 'Context compacted.'
        : 'History cleared.';
    const message = readPayloadString(event.payload, 'message') || fallback;
    activeChatsStore.addEphemeralMessage(event.threadId, {
      role: 'system',
      content: message,
    });
    return;
  }
}

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

function readPayloadBoolean(
  payload: unknown,
  key: string,
): boolean | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'boolean' ? value : undefined;
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

function readRegistryTasks(
  payload: unknown,
  sessionThreadId: string,
): ChatBackgroundTask[] {
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
      // Absent depth stays absent: "not reported" is not "top level".
      spawnDepth:
        typeof raw.spawnDepth === 'number' &&
        Number.isFinite(raw.spawnDepth) &&
        raw.spawnDepth > 0
          ? raw.spawnDepth
          : undefined,
      sessionThreadId,
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
      backgroundTasks: readRegistryTasks(event.payload, event.threadId),
    });
    return;
  }

  if (consumer === 'ui.claude.task-settled') {
    const taskId = readPayloadString(event.payload, 'taskId');
    const chat = activeChatsStore.getChatForExecutionSession(event.threadId);
    const remaining = (chat?.backgroundTasks || []).filter(
      (task) => task.taskId !== taskId,
    );
    // station#1877: the registry carries every live subagent, not only ones
    // that outlived their turn, so registry membership alone does not mean the
    // user saw this as "still working" — an inline tool part already reports a
    // same-turn completion. Gate on `backgrounded`, which is what "survived
    // past its turn" actually meant.
    //
    // station#1892: read `backgrounded` off the PAYLOAD rather than off the
    // registry entry. The SDK sends two terminals per task; the first removes
    // the entry, so by the time the one carrying the result arrives there is
    // no entry left to read — which is exactly why the real result used to be
    // dropped. The adapter now stamps `backgrounded` on every settle.
    // The registry entry is the fallback for a settle that carries no stamp —
    // an older server, or the untracked path — so this never silently stops
    // announcing work a client was already tracking as backgrounded.
    const announceable =
      readPayloadBoolean(event.payload, 'backgrounded') === true ||
      (chat?.backgroundTasks || []).find((task) => task.taskId === taskId)
        ?.backgrounded === true;
    activeChatsStore.updateChat(event.threadId, {
      backgroundTasks: remaining,
    });
    // station#1892: announce only the settle that actually carries an outcome.
    // The SDK's first terminal has identity but no result and its second has
    // the result; announcing the first produced the empty "Background task
    // finished" the user saw while the real findings went unreported. The
    // adapter publishes at most one settle bearing a result per task, so this
    // fires exactly once.
    const summary = readPayloadString(event.payload, 'summary');
    const outputFile = readPayloadString(event.payload, 'outputFile');
    if (announceable && (summary || outputFile)) {
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

  if (binding.consumer === 'acp.host-chrome') return;

  if (binding.consumer === 'ui.engine.mcp-status') {
    const total = readPayloadNumber(event.payload, 'total');
    const connected = readPayloadNumber(event.payload, 'connected');
    const current = activeChatsStore.getChatForExecutionSession(
      event.threadId,
    )?.activityHint;
    if (
      event.type === 'mcp/init_progress' &&
      total !== undefined &&
      connected !== undefined &&
      connected < total
    ) {
      const hint: ChatActivityHint = {
        kind: 'requesting',
        detail: `MCP ${connected}/${total}`,
      };
      if (!activityHintsEqual(current, hint)) {
        activeChatsStore.updateChat(event.threadId, { activityHint: hint });
      }
      return;
    }
    if (current?.kind === 'requesting') {
      activeChatsStore.updateChat(event.threadId, { activityHint: undefined });
    }
  }
}

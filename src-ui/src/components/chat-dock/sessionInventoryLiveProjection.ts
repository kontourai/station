import type { ChatBackgroundTask } from '../../contexts/active-chats-state';
import type {
  BackgroundTaskEntry,
  BackgroundTasksState,
} from '../../contexts/background-tasks-store';

/**
 * Activation-only live projection. It is intentionally not a background-store
 * selector: inventory liveness is an ephemeral rendering concern, keyed by a
 * captured execution Session, and must not make the eager dock subscribe.
 */
export function selectSessionInventoryLiveNow(
  state: BackgroundTasksState,
  capturedSessionId: string | null | undefined,
  providerTasks: ChatBackgroundTask[] | undefined,
): readonly BackgroundTaskEntry[] {
  if (!capturedSessionId) return [];
  const raw = Object.values(state.entries).filter(
    (entry) =>
      entry.chatThreadId === capturedSessionId && entry.state === 'running',
  );
  const rawTools = new Map(
    raw
      .filter((entry) => entry.kind === 'tool')
      .map((entry) => [entry.id, entry]),
  );
  const provider = (providerTasks ?? []).flatMap((task) => {
    if (!task.toolCallId) return [];
    const matched = rawTools.get(task.toolCallId);
    if (!matched) return [];
    return [
      {
        id: task.taskId,
        kind: 'agent' as const,
        source: 'provider-task' as const,
        chatThreadId: capturedSessionId,
        title: task.description || task.subagentType || 'Background task',
        detail: task.subagentType,
        startedAt: matched.startedAt,
        state: 'running' as const,
      },
    ];
  });
  const joined = new Set(
    (providerTasks ?? [])
      .map((task) => task.toolCallId)
      .filter((id): id is string => typeof id === 'string' && rawTools.has(id)),
  );
  return [
    ...raw.filter((entry) => !(entry.kind === 'tool' && joined.has(entry.id))),
    ...provider,
  ].sort((left, right) => left.startedAt - right.startedAt);
}

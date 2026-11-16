import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { backgroundTasksStore } from '../../contexts/background-tasks-store';
import { useOptionalConversationConnection } from '../conversation/ConversationConnectionContext';
import { toolCallPhase } from './tool-call-labels';
import type { ToolCallLike, ToolCallRun } from './tool-call-runs';

/**
 * A call that started and has no observed outcome yet: not finished, failed,
 * cancelled, denied, or settled `unresolved` by a session end. The durable
 * projection gives such a call `state: 'call'` once its turn is no longer
 * live, and on its own it reads "No result recorded" (assistantTurn.ts).
 */
function hasNoObservedOutcome(part: ToolCallLike): boolean {
  if (part.state === 'unresolved' || part.state === 'running') return false;
  if (part.cancelled === true || part.state === 'cancelled') return false;
  if (
    part.approvalStatus === 'user-denied' ||
    part.approvalStatus === 'policy-denied'
  )
    return false;
  return toolCallPhase(part) === 'unresolved';
}

/**
 * The run with each outcome-less call that this Station's live tool record
 * still holds as running (`tool.started` seen, no `tool.completed`, not closed
 * by a turn end) marked `state: 'running'`.
 *
 * Without it, a call the Agents pane lists as running reads "no result" in
 * the transcript, because the transcript row only knows its own turn is over.
 * A call that the live record closed or never saw keeps its "no result".
 */
export function useRunWithObservedRunningCalls<P extends ToolCallLike>(
  run: ToolCallRun<P>,
): ToolCallRun<P> {
  const station = useOptionalConversationConnection()?.station;
  const candidates = useMemo(
    () =>
      run.calls.flatMap(({ part }) =>
        part.toolCallId && hasNoObservedOutcome(part) ? [part.toolCallId] : [],
      ),
    [run],
  );
  // A joined id string is a stable snapshot: the store notifies on every
  // event, and only a change to THIS run's running calls re-renders it.
  const getSnapshot = useCallback(() => {
    if (candidates.length === 0) return '';
    const { entries } = backgroundTasksStore.getSnapshot(station);
    return candidates
      .filter((id) => {
        const entry = entries[id];
        return entry?.kind === 'tool' && entry.state === 'running';
      })
      .join('\n');
  }, [candidates, station]);
  const running = useSyncExternalStore(
    backgroundTasksStore.subscribe,
    getSnapshot,
    getSnapshot,
  );
  return useMemo(() => {
    if (!running) return run;
    const ids = new Set(running.split('\n'));
    return {
      ...run,
      calls: run.calls.map((call) =>
        call.part.toolCallId && ids.has(call.part.toolCallId)
          ? { ...call, part: { ...call.part, state: 'running' } as P }
          : call,
      ),
    };
  }, [run, running]);
}

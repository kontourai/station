import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
} from 'react';
import { backgroundTasksStore } from '../../contexts/background-tasks-store';
import {
  subscribeBackgroundTasks,
  useBackgroundTasksPartition,
} from '../../hooks/useBackgroundTasks';
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
 * The API base whose live tool record a transcript reads, as the transcript
 * resolved it for its background strip (the conversation's, else the host's).
 * Outside a transcript, the conversation's own API base is used.
 */
export const TranscriptToolRecordSource = createContext<string | undefined>(
  undefined,
);

/**
 * Whether this transcript's calls may read the live tool record. A record
 * of work that has ended (a settled subagent's transcript) says no: its
 * calls are not this chat's to mark running, and a call the record never
 * closed would otherwise read running for as long as other work runs.
 */
export const TranscriptToolRecordLive = createContext(true);

/**
 * Of `candidates`, the ids this Station's live tool record still holds as
 * running (`tool.started` seen, no `tool.completed`, not closed by a turn
 * end), joined by newlines: a stable snapshot, so only a change to THESE
 * calls re-renders the reader.
 */
function useObservedRunningIds(candidates: readonly string[]): string {
  // The partition the Agents pane and the background strip read: the
  // conversation's Station, or its API base when it has no Station.
  const transcriptSource = useContext(TranscriptToolRecordSource);
  const connectionApiBase = useOptionalConversationConnection()?.apiBase;
  const partition = useBackgroundTasksPartition(
    transcriptSource ?? connectionApiBase,
  );
  const live = useContext(TranscriptToolRecordLive);
  const key = live ? candidates.join('\n') : '';
  const getSnapshot = useCallback(() => {
    if (!key) return '';
    const { entries } = backgroundTasksStore.getSnapshot(partition);
    return key
      .split('\n')
      .filter((id) => {
        const entry = entries[id];
        return entry?.kind === 'tool' && entry.state === 'running';
      })
      .join('\n');
  }, [key, partition]);
  const subscribe = useCallback(
    (listener: () => void) => subscribeBackgroundTasks(listener, partition),
    [partition],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function candidateIds(parts: readonly ToolCallLike[]): string[] {
  return parts.flatMap((part) =>
    part.toolCallId && hasNoObservedOutcome(part) ? [part.toolCallId] : [],
  );
}

/**
 * The run with each outcome-less call that the live tool record still holds
 * as running marked `state: 'running'`.
 *
 * Without it, a call the Agents pane lists as running reads "no result" in
 * the transcript, because the transcript row only knows its own turn is over.
 * A call that the live record closed or never saw keeps its "no result".
 */
export function useRunWithObservedRunningCalls<P extends ToolCallLike>(
  run: ToolCallRun<P>,
): ToolCallRun<P> {
  const running = useObservedRunningIds(
    useMemo(() => candidateIds(run.calls.map(({ part }) => part)), [run]),
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

/** One call, as `useRunWithObservedRunningCalls` reads it in its run. */
export function useCallWithObservedRunning<P extends ToolCallLike>(part: P): P {
  const running = useObservedRunningIds(
    useMemo(() => candidateIds([part]), [part]),
  );
  return useMemo(
    () => (running ? ({ ...part, state: 'running' } as P) : part),
    [part, running],
  );
}

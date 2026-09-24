// #2050: the row every background-task list renders, lifted out of
// `BackgroundTasksSheet.tsx` so the sheet and the Agents pane show ONE row
// rather than two that drift. The class names and the stylesheet stay the
// sheet's — the row is the same row, and renaming its styling would have been
// the only change a reader could see.

import {
  useInterruptDelegatedTaskMutation,
  useOrchestrationSessionQuery,
  useStopProviderTaskMutation,
} from '@kontourai/station-sdk';
import {
  cacheInclusiveTotalTokens,
  foldUsageEvents,
} from '@kontourai/station-shared/usage-fold';
import { useMemo, useState } from 'react';
import type {
  BackgroundTaskEntry,
  BackgroundTaskState,
} from '../../contexts/background-tasks-store';
import { AgentGlyph, TerminalGlyph } from '../icons/Glyph';
import './BackgroundTasksSheet.css';

/** `m:ss`, or `h:mm:ss` once an entry has run past an hour. */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
}

/**
 * #2459: a card's elapsed time, or undefined when no start was reported —
 * a running card counts to `now`, a settled one to its end.
 */
export function backgroundTaskElapsedMs(
  entry: BackgroundTaskEntry,
  now: number,
): number | undefined {
  if (entry.startedAt === undefined) return undefined;
  return entry.state === 'running'
    ? now - entry.startedAt
    : (entry.endedAt ?? entry.startedAt) - entry.startedAt;
}

const KIND_LABEL: Record<BackgroundTaskEntry['kind'], string> = {
  tool: 'Tool',
  agent: 'Agent',
};

const OUTCOME_LABEL: Partial<Record<BackgroundTaskState, string>> = {
  completed: 'Completed',
  stopped: 'Stopped',
  // station#1558: not "Stopped" and not "Failed" — the session ended before
  // any result arrived, and whether the tool ran is unknown.
  unresolved: 'No result',
  // #2459: never "Stopped" — nothing confirmed the stop took effect.
  'stopped-unconfirmed': 'Stop requested — not confirmed',
  failed: 'Failed',
};

function TaskGlyph({ kind }: { kind: BackgroundTaskEntry['kind'] }) {
  return kind === 'tool' ? <TerminalGlyph /> : <AgentGlyph />;
}

export function TaskRow({
  entry,
  elapsedMs,
  outcomeChip,
  onOpenTranscript,
}: {
  entry: BackgroundTaskEntry;
  /** Absent when no start was reported: the meta line then shows no time. */
  elapsedMs: number | undefined;
  outcomeChip?: BackgroundTaskState;
  onOpenTranscript: (threadId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasDetail = Boolean(entry.detail);
  const delegateThreadId = entry.delegateThreadId ?? '';
  const isRunningDelegate =
    entry.state === 'running' &&
    entry.stop?.kind === 'delegate-interrupt' &&
    delegateThreadId.length > 0;
  const detail = useOrchestrationSessionQuery(delegateThreadId, {
    enabled: delegateThreadId.length > 0,
    staleTime: entry.state === 'running' ? 0 : 30_000,
    refetchInterval: entry.state === 'running' ? 2_000 : undefined,
    retry: false,
    cancelWhenInactive: true,
  });
  const usage = useMemo(
    () => (detail.data ? foldUsageEvents(detail.data.events) : null),
    [detail.data],
  );
  /**
   * station#4196: "N tokens" must not present a cache-exclusive sum as the
   * task's tokens. When the provider's declared cache-inclusivity backs it
   * ('disjoint' — Claude), the figure includes cache read/write; otherwise
   * it stays the provider's own reported total, unsummed (Codex's
   * inclusivity is 'unverified', so adding its cachedInputTokens could
   * double-count).
   */
  const usageTokens = usage
    ? (cacheInclusiveTotalTokens(usage.provider, usage) ?? usage.totalTokens)
    : undefined;
  const transcriptTitle = useMemo(() => {
    const started = detail.data?.events.find(
      (event) => event.method === 'turn.started',
    );
    if (!started?.prompt) return null;
    const firstLine = started.prompt.split('\n')[0]?.trim();
    if (!firstLine) return null;
    return firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
  }, [detail.data]);
  const interrupt = useInterruptDelegatedTaskMutation();
  const stopRequested = interrupt.isPending || interrupt.isSuccess;
  /**
   * station#1877: a provider subagent has no delegate thread, so it gets its
   * own task-scoped control rather than borrowing the delegate one. The
   * engine emits a `task_notification` with status `stopped`, so the card
   * settles through the ordinary path and nothing is assumed here.
   */
  const stopProviderTask = useStopProviderTaskMutation();
  const providerSessionThreadId = entry.sessionThreadId ?? '';
  const isRunningProviderTask =
    entry.state === 'running' &&
    entry.stop?.kind === 'provider-task-stop' &&
    providerSessionThreadId.length > 0;
  const providerStopRequested =
    stopProviderTask.isPending || stopProviderTask.isSuccess;

  return (
    <li className="background-tasks-sheet__row">
      <button
        type="button"
        className="background-tasks-sheet__row-main"
        aria-expanded={hasDetail ? expanded : undefined}
        disabled={!hasDetail}
        onClick={() => hasDetail && setExpanded((current) => !current)}
      >
        <span className="background-tasks-sheet__glyph" aria-hidden="true">
          <TaskGlyph kind={entry.kind} />
        </span>
        <span className="background-tasks-sheet__row-text">
          <strong className="background-tasks-sheet__title">
            {transcriptTitle ?? entry.title}
          </strong>
          <span className="background-tasks-sheet__meta">
            {KIND_LABEL[entry.kind]}
            {elapsedMs !== undefined && ` · ${formatElapsed(elapsedMs)}`}
          </span>
        </span>
        {outcomeChip && (
          <span
            className={`background-tasks-sheet__chip background-tasks-sheet__chip--${outcomeChip}`}
          >
            {OUTCOME_LABEL[outcomeChip] ?? outcomeChip}
          </span>
        )}
        {hasDetail && (
          <span className="background-tasks-sheet__chevron" aria-hidden="true">
            {expanded ? '▾' : '▸'}
          </span>
        )}
      </button>
      {expanded && hasDetail && (
        <div className="background-tasks-sheet__detail">{entry.detail}</div>
      )}
      {delegateThreadId && (
        <div className="background-tasks-sheet__task-footer">
          {usage && (
            <span className="background-tasks-sheet__usage">
              {/* An engine that reported no token count (ACP reports context
                  occupancy only) drops the token clause rather than printing
                  a `0 tokens` nobody measured — station#3201. Tool uses are
                  counted by Station from `tool.completed`, so zero there is
                  a real zero and always prints. */}
              {usageTokens !== undefined &&
                `${usageTokens.toLocaleString()} tokens · `}
              {usage.toolCalls} tool {usage.toolCalls === 1 ? 'use' : 'uses'}
            </span>
          )}
          <span className="background-tasks-sheet__task-actions">
            <button
              type="button"
              className="background-tasks-sheet__action"
              onClick={() => onOpenTranscript(delegateThreadId)}
            >
              View transcript
            </button>
            {isRunningDelegate && (
              <button
                type="button"
                className="background-tasks-sheet__action background-tasks-sheet__action--stop"
                disabled={stopRequested}
                onClick={() => interrupt.mutate({ taskId: delegateThreadId })}
              >
                {stopRequested ? 'Stopping…' : 'Stop'}
              </button>
            )}
          </span>
          {interrupt.isError && (
            <span className="background-tasks-sheet__error" role="alert">
              Could not stop this task. Try again.
            </span>
          )}
        </div>
      )}
      {isRunningProviderTask && (
        <div className="background-tasks-sheet__task-footer">
          <span className="background-tasks-sheet__task-actions">
            <button
              type="button"
              className="background-tasks-sheet__action background-tasks-sheet__action--stop"
              disabled={providerStopRequested}
              onClick={() =>
                stopProviderTask.mutate({
                  threadId: providerSessionThreadId,
                  taskId: entry.id,
                })
              }
            >
              {providerStopRequested ? 'Stopping…' : 'Stop'}
            </button>
          </span>
          {stopProviderTask.isError && (
            <span className="background-tasks-sheet__error" role="alert">
              Could not stop this subagent. Try again.
            </span>
          )}
        </div>
      )}
    </li>
  );
}

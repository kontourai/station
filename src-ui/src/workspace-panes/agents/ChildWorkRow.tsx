import type {
  ChildWorkStatus,
  ChildWorkUsage,
} from '@kontourai/station-contracts/child-work';
import { CHILD_WORK_SUMMARY_MAX_CHARS } from '@kontourai/station-contracts/child-work';
import {
  useInterruptDelegatedTaskMutation,
  useOrchestrationSessionQuery,
  useStopProviderTaskMutation,
} from '@kontourai/station-sdk';
import {
  cacheInclusiveTotalTokens,
  foldUsageEvents,
} from '@kontourai/station-shared/usage-fold';
import { type CSSProperties, useMemo, useState } from 'react';
import { Button } from '../../components/Button';
import { AgentGlyph } from '../../components/icons/Glyph';
import type {
  ChildWorkProvenance,
  ChildWorkRowModel,
} from './childWorkSelectors';
import './ChildWorkRow.css';

/**
 * #2459: one child — an engine subagent or a Station delegate — rendered from
 * the provider-neutral contract, whatever engine reported it.
 *
 * Every member is optional on the contract and optional here: a time, a token
 * count or a result nobody reported renders absent, never as 0. A terminal
 * reads as what was OBSERVED — "No result" and "Stop requested — not
 * confirmed" are not "Completed" and not "Stopped". A control renders only
 * from the row model's `stop`, which the selectors derive from a wired seam.
 */

/** `m:ss`, or `h:mm:ss` past an hour. */
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

const CHILD_WORK_STATUS_LABEL: Record<ChildWorkStatus, string> = {
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Stopped',
  // Decision F: a stop nobody confirmed is not a stop that happened.
  'stopped-unconfirmed': 'Stop requested — not confirmed',
  // The reporter stopped listing it without an outcome.
  unresolved: 'No result',
};

/** Only the members the engine reported; a reported 0 prints. */
function usageClauses(usage: ChildWorkUsage | undefined): string[] {
  if (!usage) return [];
  const clauses: string[] = [];
  if (usage.totalTokens !== undefined)
    clauses.push(`${usage.totalTokens.toLocaleString()} tokens`);
  if (usage.toolUses !== undefined)
    clauses.push(
      `${usage.toolUses} tool ${usage.toolUses === 1 ? 'use' : 'uses'}`,
    );
  if (usage.durationMs !== undefined)
    clauses.push(`ran ${formatElapsed(usage.durationMs)}`);
  return clauses;
}

function provenanceText(provenance: ChildWorkProvenance): string {
  switch (provenance.kind) {
    case 'conversation':
      return provenance.title
        ? `From “${provenance.title}”`
        : 'From a conversation';
    case 'task':
      return `From task ${provenance.taskId}`;
    case 'cli':
      return 'Started from the CLI';
    case 'none':
      return 'No parent';
  }
}

/**
 * A delegate's own accounting, read from its session only while the row is
 * open — a closed row polls nothing.
 */
function DelegateUsage({
  threadId,
  running,
}: {
  threadId: string;
  running: boolean;
}) {
  const detail = useOrchestrationSessionQuery(threadId, {
    enabled: true,
    staleTime: running ? 0 : 30_000,
    refetchInterval: running ? 2_000 : undefined,
    retry: false,
    cancelWhenInactive: true,
  });
  const usage = useMemo(
    () => (detail.data ? foldUsageEvents(detail.data.events) : null),
    [detail.data],
  );
  if (!usage) return null;
  // station#4196/#3201: a provider-declared cache-inclusive total, else the
  // provider's own total — and no clause at all when neither was reported.
  const tokens =
    cacheInclusiveTotalTokens(usage.provider, usage) ?? usage.totalTokens;
  return (
    <p className="child-work-row__usage">
      {tokens !== undefined && `${tokens.toLocaleString()} tokens · `}
      {usage.toolCalls} tool {usage.toolCalls === 1 ? 'use' : 'uses'}
    </p>
  );
}

export function ChildWorkRow({
  row,
  now,
  showProvenance,
  onOpenSession,
}: {
  row: ChildWorkRowModel;
  now: number;
  showProvenance: boolean;
  onOpenSession: (threadId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { item } = row;
  const running = item.status === 'running';
  const interrupt = useInterruptDelegatedTaskMutation();
  const stopProviderTask = useStopProviderTaskMutation();
  const stopMutation =
    row.stop === 'delegate-interrupt' ? interrupt : stopProviderTask;
  // #2486 review: a child registered before its own turn/started can offer
  // no target yet, so a click can genuinely land on nothing — an engine-
  // generic race (`ProviderTaskStopResult`'s `no-active-task`, shared with
  // every `provider-task-stop` engine), not a Codex-specific one. Without
  // this the button stayed on "Stopping…" forever for a request that had
  // already resolved successfully to "there was nothing to stop".
  const noActiveTask =
    row.stop === 'provider-task-stop' &&
    stopProviderTask.data?.outcome === 'no-active-task';
  const stopRequested =
    (stopMutation.isPending || stopMutation.isSuccess) && !noActiveTask;

  const elapsedMs =
    row.startedAtMs === undefined
      ? undefined
      : running
        ? now - row.startedAtMs
        : row.endedAtMs !== undefined
          ? row.endedAtMs - row.startedAtMs
          : undefined;
  const isDelegate = item.producer === 'station-delegate';
  const kind = item.kindLabel ?? (isDelegate ? 'Delegate' : 'Subagent');
  const meta = [
    kind,
    ...(elapsedMs !== undefined ? [formatElapsed(elapsedMs)] : []),
    ...usageClauses(item.usage),
  ].join(' · ');
  const summary = item.result?.summary;
  const handle = item.result?.handle;
  const sessionHandle = handle?.kind === 'session' ? handle : undefined;
  const expandable = Boolean(summary) || isDelegate;

  const stop = () => {
    if (row.stop === 'delegate-interrupt')
      interrupt.mutate({ taskId: item.childId });
    else if (row.stop === 'provider-task-stop')
      stopProviderTask.mutate({
        threadId: item.reporterThreadId,
        taskId: item.childId,
      });
  };

  return (
    <li
      className="child-work-row"
      data-status={item.status}
      style={
        row.level > 0
          ? ({ '--child-work-level': row.level } as CSSProperties)
          : undefined
      }
    >
      <button
        type="button"
        className="child-work-row__main"
        aria-expanded={expandable ? expanded : undefined}
        disabled={!expandable}
        onClick={() => expandable && setExpanded((current) => !current)}
      >
        <span className="child-work-row__glyph" aria-hidden="true">
          <AgentGlyph />
        </span>
        <span className="child-work-row__text">
          <strong className="child-work-row__title">{row.title}</strong>
          <span className="child-work-row__meta">{meta}</span>
          {running && item.progress && (
            <span className="child-work-row__progress">{item.progress}</span>
          )}
          {showProvenance && (
            <span className="child-work-row__provenance">
              {provenanceText(row.provenance)}
            </span>
          )}
        </span>
        <span
          className={`child-work-row__chip child-work-row__chip--${item.status}`}
        >
          {CHILD_WORK_STATUS_LABEL[item.status]}
        </span>
        {expandable && (
          <span className="child-work-row__chevron" aria-hidden="true">
            {expanded ? '▾' : '▸'}
          </span>
        )}
      </button>
      {expanded && (
        <div className="child-work-row__detail">
          {summary && <p className="child-work-row__summary">{summary}</p>}
          {summary && item.result?.summaryTruncated && (
            <p className="child-work-row__note">
              Summary cut at {CHILD_WORK_SUMMARY_MAX_CHARS.toLocaleString()}{' '}
              characters.
              {sessionHandle ? ' Open the session for the full output.' : ''}
            </p>
          )}
          {isDelegate && (
            <DelegateUsage threadId={item.childId} running={running} />
          )}
        </div>
      )}
      {(sessionHandle || row.stop) && (
        <div className="child-work-row__actions">
          {sessionHandle && (
            <Button
              size="sm"
              onClick={() => onOpenSession(sessionHandle.threadId)}
            >
              Open session
            </Button>
          )}
          {row.stop && (
            <Button
              size="sm"
              variant="danger-outline"
              pending={stopRequested}
              pendingLabel="Stopping…"
              onClick={stop}
              // #2486: some engines (Codex) have no softer path — stopping
              // one subagent also ends the turn that started it. The matrix
              // says so per engine (`stopEndsParentTurn`); this is never a
              // copy hardcoded the same for every engine's control.
              title={
                row.stopEndsParentTurn
                  ? 'Stop this subagent and the turn that started it'
                  : undefined
              }
            >
              Stop
            </Button>
          )}
          {stopMutation.isError && row.stop && (
            <span className="child-work-row__error" role="alert">
              Could not stop this {isDelegate ? 'task' : 'subagent'}. Try again.
            </span>
          )}
          {noActiveTask && (
            <span className="child-work-row__hint" role="status">
              Nothing to stop yet — try again.
            </span>
          )}
        </div>
      )}
    </li>
  );
}

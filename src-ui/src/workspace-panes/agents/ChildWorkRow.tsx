import {
  CHILD_WORK_SUMMARY_MAX_CHARS,
  type ChildWorkItem,
  childWorkDisplayStatus,
  childWorkKindOf,
} from '@kontourai/station-contracts/child-work';
import {
  useInterruptDelegatedTaskMutation,
  useOrchestrationSessionActivityQuery,
  useOrchestrationSessionQuery,
  useStopProviderTaskMutation,
} from '@kontourai/station-sdk';
import {
  cacheInclusiveTotalTokens,
  foldUsageEvents,
} from '@kontourai/station-shared/usage-fold';
import { type CSSProperties, useMemo, useState } from 'react';
import { Button } from '../../components/Button';
import { ChildWorkActivity } from '../../components/chat/ChildWorkActivity';
import { ChildWorkIdentity } from '../../components/chat/ChildWorkIdentity';
import {
  childChatTarget,
  useChildChatNavigation,
} from '../../components/chat-dock/ChildChatNavigationContext';
import { useOptionalConversationConnection } from '../../components/conversation/ConversationConnectionContext';
import { ConversationStopControl } from '../../components/conversation/ConversationStopControl';
import {
  CHILD_WORK_MODEL_SOURCE_TEXT,
  CHILD_WORK_STATUS_LABEL,
  childWorkKindLabel,
  childWorkResultText,
  childWorkSummaryLabel,
  childWorkUsageClauses,
  formatChildWorkElapsed,
  latestChildTool,
} from '../../utils/child-work-display';
import type { SessionIconAgent } from '../../utils/sessionDisplay';
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

function provenanceText(provenance: ChildWorkProvenance): string {
  switch (provenance.kind) {
    case 'conversation':
      return provenance.title
        ? `From “${provenance.title}”`
        : 'From a conversation';
    case 'task':
      return `From task ${provenance.taskId}`;
    case 'cli':
      return 'Recorded origin: CLI (reported)';
    case 'none':
      return 'No parent';
  }
}

/**
 * Lifetime accounting is read only on expansion.
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

function DelegateActivity({
  threadId,
  progress,
}: {
  threadId: string;
  progress?: string;
}) {
  const activity = useOrchestrationSessionActivityQuery(threadId, undefined, {
    staleTime: 0,
    refetchInterval: 2_000,
    retry: false,
    cancelWhenInactive: true,
  });
  const tool = useMemo(
    () =>
      activity.data
        ? latestChildTool(
            activity.data.events.map(({ event }) => event),
            threadId,
            activity.data.latestTool,
          )
        : undefined,
    [activity.data, threadId],
  );
  return <ChildWorkActivity tool={tool} progress={progress} />;
}

export function ChildWorkRow({
  row,
  now,
  showProvenance,
  onOpenSession,
  onOpenChild,
  agent,
  stationName,
}: {
  row: ChildWorkRowModel;
  stationName?: string;
  agent?: SessionIconAgent;
  now: number;
  showProvenance: boolean;
  onOpenSession: (threadId: string) => void;
  onOpenChild?: (item: ChildWorkItem, title: string) => void;
}) {
  const target = useOptionalConversationConnection();
  const owningStationName = target?.station?.binding.stationName ?? stationName;
  const [expanded, setExpanded] = useState(false);
  const openChild = useChildChatNavigation();
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
  const workKind = childWorkKindOf(item);
  const isAgent = workKind === 'agent';
  const kind = isAgent
    ? (childWorkKindLabel(item) ?? (isDelegate ? 'Delegate' : 'Subagent'))
    : workKind === 'monitor'
      ? 'Background monitor'
      : 'Background command';
  const meta = [
    kind,
    ...(elapsedMs !== undefined ? [formatChildWorkElapsed(elapsedMs)] : []),
  ].join(' · ');
  // #3163: an engine subagent's OWN model, or the plain fact that its engine
  // did not report one. Never the parent's. A delegate is a session of its
  // own, whose model that session shows.
  // A shell command has no model to report.
  const model = isDelegate || !isAgent ? undefined : (item.model ?? null);
  const transcript = isDelegate ? undefined : item.transcript;
  const summary = childWorkResultText(item, row.title);
  const handle = item.result?.handle;
  const sessionHandle = handle?.kind === 'session' ? handle : undefined;
  const usage = childWorkUsageClauses(item.usage);
  const expandable =
    !running || Boolean(summary) || isDelegate || usage.length > 0;

  const stop = () => {
    if (row.stop === 'delegate-interrupt')
      return interrupt.mutateAsync({ taskId: item.childId });
    else if (row.stop === 'provider-task-stop')
      return stopProviderTask.mutateAsync({
        threadId: item.reporterThreadId,
        taskId: item.childId,
      });
  };

  return (
    <li
      className="child-work-row"
      data-status={childWorkDisplayStatus(item)}
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
        <span className="child-work-row__glyph">
          <ChildWorkIdentity provider={row.provider} agent={agent} />
        </span>
        <span className="child-work-row__text">
          <strong className="child-work-row__title">{row.title}</strong>
          <span className="child-work-row__meta">{meta}</span>
          {model !== undefined && (
            <span
              className="child-work-row__model"
              data-reported={model ? 'true' : 'false'}
              title={
                model ? CHILD_WORK_MODEL_SOURCE_TEXT[model.source] : undefined
              }
            >
              {model ? model.id : 'model not reported'}
            </span>
          )}
          {running && isDelegate ? (
            <DelegateActivity
              threadId={item.childId}
              progress={item.progress}
            />
          ) : running ? (
            <ChildWorkActivity
              tool={item.latestTool}
              progress={item.progress}
            />
          ) : null}
          {isAgent && item.status === 'completed' && !summary && (
            <span className="child-work-row__note">Summary not reported</span>
          )}
          {showProvenance && (
            <span className="child-work-row__provenance">
              {provenanceText(row.provenance)}
              {owningStationName ? ` · Via ${owningStationName}` : ''}
            </span>
          )}
        </span>
        <span
          className={`child-work-row__chip child-work-row__chip--${childWorkDisplayStatus(item)}`}
        >
          {CHILD_WORK_STATUS_LABEL[childWorkDisplayStatus(item)]}
        </span>
        {expandable && (
          <span className="child-work-row__chevron" aria-hidden="true">
            {expanded ? '▾' : '▸'}
          </span>
        )}
      </button>
      {expanded && (
        <div className="child-work-row__detail">
          {summary && (
            <p className="child-work-row__summary">
              <strong>
                {isAgent
                  ? childWorkSummaryLabel(item.result?.source)
                  : 'Result'}
              </strong>
              {' · '}
              <span>{summary}</span>
            </p>
          )}
          {!running && !isDelegate && item.result?.source !== 'tool-return' && (
            <p className="child-work-row__note">
              No returned result was reported.
            </p>
          )}
          {summary && item.result?.summaryTruncated && (
            <p className="child-work-row__note">
              Summary cut at {CHILD_WORK_SUMMARY_MAX_CHARS.toLocaleString()}{' '}
              characters.
              {sessionHandle ? ' Open the session for the full output.' : ''}
            </p>
          )}
          {usage.length > 0 && (
            <p className="child-work-row__usage">{usage.join(' · ')}</p>
          )}
          {isDelegate && (
            <DelegateUsage threadId={item.childId} running={running} />
          )}
        </div>
      )}
      {(sessionHandle || transcript || row.stop) && (
        <div className="child-work-row__actions">
          {/* One "open" action: a delegate opens its own session, an engine
              subagent its read-only transcript (#3163). A child has at most
              one of the two. */}
          {(sessionHandle || transcript) && (
            <Button
              size="sm"
              className="tap-target"
              onClick={() => {
                if (openChild && target) {
                  openChild({
                    ...childChatTarget(item, target),
                    title: row.title,
                  });
                  return;
                }
                if (onOpenChild) onOpenChild(item, row.title);
                else if (sessionHandle) onOpenSession(sessionHandle.threadId);
              }}
            >
              Open chat
            </Button>
          )}
          {row.stop && (
            <span
              title={
                row.stopEndsParentTurn
                  ? 'Stop this subagent and the turn that started it'
                  : undefined
              }
            >
              <ConversationStopControl
                intent={
                  isDelegate
                    ? { kind: 'task', name: row.title }
                    : { kind: 'turn' }
                }
                title={
                  row.stopEndsParentTurn
                    ? 'Stop this subagent and the turn that started it'
                    : undefined
                }
                onCancel={stop}
                stopPending={stopRequested}
              >
                Stop
              </ConversationStopControl>
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

import {
  CHILD_WORK_SUMMARY_MAX_CHARS,
  type ChildWorkDisplayStatus,
  childWorkDisplayStatus,
  childWorkKindOf,
} from '@kontourai/station-contracts/child-work';
import { engineDisplayLabel } from '@kontourai/station-contracts/engine-display';
import { useId, useState } from 'react';
import { useElapsedClock } from '../../hooks/useElapsedClock';
import {
  CHILD_WORK_GROUP_STATUS_LABEL,
  CHILD_WORK_MODEL_SOURCE_TEXT,
  CHILD_WORK_STATUS_LABEL,
  childWorkGroupLabel,
  childWorkKindLabel,
  childWorkResultText,
  childWorkSummaryLabel,
  childWorkUsageClauses,
  formatChildWorkElapsed,
} from '../../utils/child-work-display';
import { parseEpochMs } from '../../utils/parseEpochMs';
import { Button } from '../Button';
import {
  childChatTarget,
  useChildChatNavigation,
} from '../chat-dock/ChildChatNavigationContext';
import { useOptionalConversationConnection } from '../conversation/ConversationConnectionContext';
import {
  ArrowDownGlyph,
  ArrowRightGlyph,
  CheckGlyph,
  CloseGlyph,
  TerminalGlyph,
  WarningGlyph,
} from '../icons/Glyph';
import { ChildWorkActivity } from './ChildWorkActivity';
import { ChildWorkIdentity } from './ChildWorkIdentity';
import { ChildWorkInstructionPanel } from './ChildWorkInstructionPanel';
import { LazyMarkdown } from './LazyMarkdown';
import type { ToolCallLike } from './tool-call-runs';
import {
  type TranscriptChild,
  useTranscriptChildrenForCalls,
} from './transcript-child-work';
import './SubagentTranscriptCard.css';

/** One card at each reported spawn anchor; never borrow facts from the parent. */

const LIST_ITEM = /^(?:[-*+]|\d+[.)])\s+/;

/** One Markdown line as the plain text it renders: no block markers, code
 * spans, emphasis or link syntax. */
function plainMarkdownLine(line: string): string {
  // A code fence line renders as no text.
  if (/^(?:`{3,}|~{3,})/.test(line.trim())) return '';
  return line
    .trim()
    .replace(/^(?:#{1,6}\s+|>\s*)+/, '')
    .replace(LIST_ITEM, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(`+)([^`]*?)\1/g, '$2')
    .replace(/`/g, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_]([^*_\s][^*_]*?)[*_](?=[^\w*]|$)/g, '$1$2')
    .trim();
}

/**
 * The collapsed card's one line of the result (#4266): Markdown stripped, so
 * a cut never leaves a stray backtick, and a first line that introduces a
 * list ("Found three issues:") followed by the list's first item.
 */
export function subagentSummaryPreview(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const firstIndex = lines.findIndex((line) => plainMarkdownLine(line));
  if (firstIndex < 0) return '';
  const first = plainMarkdownLine(lines[firstIndex]!);
  if (!first.endsWith(':')) return first;
  const item = lines
    .slice(firstIndex + 1)
    .find((line) => LIST_ITEM.test(line.trim()) && plainMarkdownLine(line));
  return item ? `${first} ${plainMarkdownLine(item)}` : first;
}

function StatusGlyph({ status }: { status: ChildWorkDisplayStatus }) {
  if (status === 'running')
    return <span className="subagent-card__spinner" aria-hidden="true" />;
  if (status === 'completed') return <CheckGlyph />;
  if (status === 'failed') return <CloseGlyph />;
  // A stop someone made is an outcome; the dashed ring is kept for the two
  // observations of an absence (no result, an unconfirmed stop).
  if (status === 'cancelled')
    return <span className="subagent-card__stopped" aria-hidden="true" />;
  // Its engine died under it: an observed end, so a solid mark, not a ring.
  if (status === 'interrupted') return <WarningGlyph />;
  return <span className="subagent-card__hollow" aria-hidden="true" />;
}

/** The shell command a spawning tool call ran, when it carried one. */
function commandOf(part: ToolCallLike | undefined): string | undefined {
  const input = part?.input ?? part?.args;
  const command =
    input && typeof input === 'object' ? input.command : undefined;
  return typeof command === 'string' && command.trim()
    ? command.trim()
    : undefined;
}

export function SubagentTranscriptCard({
  child,
  call,
}: {
  child: TranscriptChild;
  /** The tool call that spawned it, when the card is drawn in its place. */
  call?: ToolCallLike;
}) {
  const { item, provider } = child;
  const workKind = childWorkKindOf(item);
  const isAgent = workKind === 'agent';
  const command = isAgent ? undefined : commandOf(call);
  const [expanded, setExpanded] = useState(false);
  const openChild = useChildChatNavigation();
  const connection = useOptionalConversationConnection();
  const detailId = useId();
  const running = item.status === 'running';
  const startedAtMs = parseEpochMs(item.startedAt);
  const endedAtMs = parseEpochMs(item.endedAt);
  const now = useElapsedClock(running && startedAtMs !== undefined);

  // Running: the live clock from the reported start. Settled: the reported
  // start and end, else the engine's own duration. Nothing reported: absent.
  const elapsedMs =
    startedAtMs === undefined
      ? running
        ? undefined
        : item.usage?.durationMs
      : running
        ? now - startedAtMs
        : endedAtMs !== undefined
          ? endedAtMs - startedAtMs
          : item.usage?.durationMs;

  const kindLabel = childWorkKindLabel(item);
  const title =
    item.title ??
    kindLabel ??
    (isAgent ? 'Subagent' : workKind === 'monitor' ? 'Monitor' : 'Command');
  const engine = isAgent && provider ? engineDisplayLabel(provider) : null;
  // A result that only restates the title says nothing; a command's
  // engine-written summary reduces to its exit code.
  const summary = childWorkResultText(item, title);
  const preview = running
    ? item.progress && item.progress !== title
      ? item.progress
      : undefined
    : summary
      ? subagentSummaryPreview(summary) || undefined
      : undefined;
  const usage = childWorkUsageClauses(item.usage);
  const status = childWorkDisplayStatus(item);
  const statusLabel = CHILD_WORK_STATUS_LABEL[status];

  return (
    <div
      className="subagent-card"
      data-status={status}
      data-testid="subagent-card"
    >
      <button
        type="button"
        className="subagent-card__main"
        aria-expanded={expanded}
        aria-controls={expanded ? detailId : undefined}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="subagent-card__glyph">
          {isAgent ? (
            <ChildWorkIdentity provider={provider} />
          ) : (
            <span className="subagent-card__command-glyph" aria-hidden="true">
              <TerminalGlyph />
            </span>
          )}
        </span>
        <span className="subagent-card__text">
          <span className="subagent-card__headline">
            <strong className="subagent-card__title">{title}</strong>
            <span
              className={`subagent-card__status subagent-card__status--${status}`}
            >
              <StatusGlyph status={status} />
              {statusLabel}
            </span>
          </span>
          {expanded && !isAgent && (
            <span className="subagent-card__meta">
              {workKind === 'monitor'
                ? 'Background monitor'
                : 'Background command'}
            </span>
          )}
          {expanded && isAgent && (
            <span className="subagent-card__meta">
              {[kindLabel && kindLabel !== title ? kindLabel : null, engine]
                .filter(Boolean)
                .map((part) => `${part} · `)
                .join('')}
              <span
                className="subagent-card__model"
                data-reported={item.model ? 'true' : 'false'}
                title={
                  item.model
                    ? CHILD_WORK_MODEL_SOURCE_TEXT[item.model.source]
                    : undefined
                }
              >
                {item.model ? item.model.id : 'model not reported'}
              </span>
            </span>
          )}
          {running && isAgent ? (
            <ChildWorkActivity
              tool={item.latestTool}
              progress={item.progress}
            />
          ) : !expanded && preview ? (
            <span className="subagent-card__preview">{preview}</span>
          ) : !expanded && isAgent && item.status === 'completed' ? (
            <span className="subagent-card__preview subagent-card__preview--gap">
              No summary reported
            </span>
          ) : null}
        </span>
        <span className="subagent-card__aside">
          {elapsedMs !== undefined && (
            <span className="subagent-card__elapsed">
              {formatChildWorkElapsed(elapsedMs)}
            </span>
          )}
          <span className="subagent-card__chevron" aria-hidden="true">
            {expanded ? <ArrowDownGlyph /> : <ArrowRightGlyph />}
          </span>
        </span>
      </button>
      {expanded && (
        <div className="subagent-card__detail" id={detailId}>
          {command && (
            <pre className="subagent-card__command">
              <code>{command}</code>
            </pre>
          )}
          {item.producer === 'engine-subagent' && isAgent && (
            <ChildWorkInstructionPanel
              threadId={item.reporterThreadId}
              childId={item.childId}
              turnId={item.controls?.steer?.turnId}
              running={running}
              name={title}
              historyAvailable={!!item.transcript}
            />
          )}
          {summary ? (
            <div className="subagent-card__summary">
              <span className="subagent-card__note">
                {isAgent
                  ? childWorkSummaryLabel(item.result?.source)
                  : 'Result'}
              </span>
              <LazyMarkdown>{summary}</LazyMarkdown>
            </div>
          ) : isAgent ? (
            <p className="subagent-card__note">
              {running ? 'Result pending' : 'No summary reported'}
            </p>
          ) : null}
          {summary && item.result?.summaryTruncated && (
            <p className="subagent-card__note">
              Summary cut at {CHILD_WORK_SUMMARY_MAX_CHARS.toLocaleString()}{' '}
              characters.
            </p>
          )}
          {(usage.length > 0 ||
            item.transcript ||
            item.producer === 'station-delegate') && (
            <div className="subagent-card__actions">
              {usage.length > 0 && (
                <p className="subagent-card__note">{usage.join(' · ')}</p>
              )}
              {(item.transcript || item.producer === 'station-delegate') && (
                <Button
                  size="sm"
                  className="tap-target"
                  variant="ghost"
                  disabled={!openChild || !connection}
                  onClick={() =>
                    connection && openChild?.(childChatTarget(item, connection))
                  }
                >
                  Open chat
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Reconstruct original runs even when the phone folds their tool work together. */
export function SubagentCardsForCalls({
  calls,
}: {
  calls: readonly { part: ToolCallLike; index: number }[];
}) {
  const runs: (typeof calls)[number][][] = [];
  for (const call of calls) {
    const run = runs.at(-1);
    if (run && run.at(-1)!.index + 1 === call.index) run.push(call);
    else runs.push([call]);
  }
  return runs.map((run) => (
    <SubagentCallGroup
      key={run[0].part.toolCallId ?? run[0].index}
      calls={run}
    />
  ));
}

function SubagentCallGroup({
  calls,
}: {
  calls: readonly { part: ToolCallLike }[];
}) {
  const children = useTranscriptChildrenForCalls(
    calls.flatMap(({ part }) => (part.toolCallId ? [part.toolCallId] : [])),
  );
  const callFor = (child: TranscriptChild) =>
    calls.find(({ part }) => part.toolCallId === child.item.parent?.toolCallId)
      ?.part;
  const [expanded, setExpanded] = useState(false);
  const groupId = useId();
  const grouped = children.length > 1;
  if (!children.length) return null;
  const counts = new Map<ChildWorkDisplayStatus, number>();
  for (const child of children) {
    const status = childWorkDisplayStatus(child.item);
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }

  return (
    <div className="subagent-group" data-grouped={grouped}>
      {grouped && (
        <button
          type="button"
          className="subagent-group__heading"
          aria-expanded={expanded}
          aria-controls={groupId}
          onClick={() => setExpanded((current) => !current)}
        >
          <span className="subagent-group__avatars" aria-hidden="true">
            {children.slice(0, 3).map((child) =>
              childWorkKindOf(child.item) === 'agent' ? (
                <ChildWorkIdentity
                  key={child.item.childId}
                  provider={child.provider}
                />
              ) : (
                <span
                  key={child.item.childId}
                  className="subagent-card__command-glyph"
                >
                  <TerminalGlyph />
                </span>
              ),
            )}
            {children.length > 3 && (
              <span className="subagent-group__more">
                +{children.length - 3}
              </span>
            )}
          </span>
          <strong>
            {childWorkGroupLabel(children.map((child) => child.item))}
          </strong>
          <span className="subagent-group__counts" aria-live="polite">
            {[...counts]
              .map(
                ([status, count]) =>
                  `${count} ${CHILD_WORK_GROUP_STATUS_LABEL[status]}`,
              )
              .join(' · ')}
          </span>
          {expanded ? <ArrowDownGlyph /> : <ArrowRightGlyph />}
        </button>
      )}
      <div
        className="subagent-group__children"
        id={groupId}
        hidden={grouped && !expanded}
        onFocusCapture={() => setExpanded(true)}
        onClickCapture={() => setExpanded(true)}
      >
        {children.map((child) => (
          <SubagentTranscriptCard
            key={child.item.childId}
            child={child}
            call={callFor(child)}
          />
        ))}
      </div>
    </div>
  );
}

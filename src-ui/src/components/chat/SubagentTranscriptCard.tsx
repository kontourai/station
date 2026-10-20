import { CHILD_WORK_SUMMARY_MAX_CHARS } from '@kontourai/station-contracts/child-work';
import { engineDisplayLabel } from '@kontourai/station-contracts/engine-display';
import { useEffect, useId, useState } from 'react';
import {
  CHILD_WORK_MODEL_SOURCE_TEXT,
  CHILD_WORK_STATUS_LABEL,
  childWorkUsageClauses,
  formatChildWorkElapsed,
} from '../../utils/child-work-display';
import { Button } from '../Button';
import {
  ArrowDownGlyph,
  ArrowRightGlyph,
  CheckGlyph,
  CloseGlyph,
} from '../icons/Glyph';
import { LazyBoundary } from '../LazyBoundary';
import { ChildWorkIdentity } from './ChildWorkIdentity';
import { LazyMarkdown } from './LazyMarkdown';
import type { ToolCallLike } from './tool-call-runs';
import {
  type TranscriptChild,
  useTranscriptChildrenForCalls,
} from './transcript-child-work';
import './SubagentTranscriptCard.css';

/** One card at each reported spawn anchor; never borrow facts from the parent. */

const loadChildWorkTranscript = () =>
  import('../../workspace-panes/agents/ChildWorkTranscript').then((module) => ({
    default: module.ChildWorkTranscript,
  }));

function parseTime(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Re-renders once a second while `active`, for a running child's clock. */
function useTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

/** The first line of `text` with Markdown emphasis left as written. */
function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ''
  );
}

function StatusGlyph({
  status,
}: {
  status: TranscriptChild['item']['status'];
}) {
  if (status === 'running')
    return <span className="subagent-card__spinner" aria-hidden="true" />;
  if (status === 'completed') return <CheckGlyph />;
  if (status === 'failed') return <CloseGlyph />;
  // A stop someone made is an outcome; the dashed ring is kept for the two
  // observations of an absence (no result, an unconfirmed stop).
  if (status === 'cancelled')
    return <span className="subagent-card__stopped" aria-hidden="true" />;
  return <span className="subagent-card__hollow" aria-hidden="true" />;
}

export function SubagentTranscriptCard({ child }: { child: TranscriptChild }) {
  const { item, provider } = child;
  const [expanded, setExpanded] = useState(false);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const detailId = useId();
  const transcriptId = useId();
  const running = item.status === 'running';
  const startedAtMs = parseTime(item.startedAt);
  const endedAtMs = parseTime(item.endedAt);
  const now = useTicker(running && startedAtMs !== undefined);

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

  const title = item.title ?? item.kindLabel ?? 'Subagent';
  const engine = provider ? engineDisplayLabel(provider) : null;
  const summary = item.result?.summary;
  const preview = running
    ? item.progress
    : summary
      ? firstLine(summary)
      : undefined;
  const usage = childWorkUsageClauses(item.usage);
  const statusLabel = CHILD_WORK_STATUS_LABEL[item.status];

  return (
    <div
      className="subagent-card"
      data-status={item.status}
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
          <ChildWorkIdentity provider={provider} />
        </span>
        <span className="subagent-card__text">
          <span className="subagent-card__headline">
            <strong className="subagent-card__title">{title}</strong>
            <span
              className={`subagent-card__status subagent-card__status--${item.status}`}
            >
              <StatusGlyph status={item.status} />
              {statusLabel}
            </span>
          </span>
          {expanded && (
            <span className="subagent-card__meta">
              {[
                item.kindLabel && item.kindLabel !== title
                  ? item.kindLabel
                  : null,
                engine,
              ]
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
          {(running || !expanded) && preview ? (
            <span className="subagent-card__preview">{preview}</span>
          ) : !expanded && !running && item.status === 'completed' ? (
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
          {summary ? (
            <div className="subagent-card__summary">
              <LazyMarkdown>{summary}</LazyMarkdown>
            </div>
          ) : (
            <p className="subagent-card__note">
              {running ? 'Result pending' : 'No summary reported'}
            </p>
          )}
          {summary && item.result?.summaryTruncated && (
            <p className="subagent-card__note">
              Summary cut at {CHILD_WORK_SUMMARY_MAX_CHARS.toLocaleString()}{' '}
              characters.
            </p>
          )}
          {(usage.length > 0 || item.transcript) && (
            <div className="subagent-card__actions">
              {usage.length > 0 && (
                <p className="subagent-card__note">{usage.join(' · ')}</p>
              )}
              {item.transcript && (
                <Button
                  size="sm"
                  className="tap-target"
                  variant="ghost"
                  aria-expanded={transcriptOpen}
                  aria-controls={transcriptOpen ? transcriptId : undefined}
                  onClick={() => setTranscriptOpen((current) => !current)}
                >
                  {transcriptOpen ? 'Hide transcript' : 'View transcript'}
                </Button>
              )}
            </div>
          )}
          {item.transcript && transcriptOpen && (
            <LazyBoundary
              load={loadChildWorkTranscript}
              componentProps={{
                id: transcriptId,
                threadId: item.reporterThreadId,
                childId: item.childId,
                running,
                revision: JSON.stringify([
                  item.status,
                  item.progress,
                  item.usage,
                ]),
              }}
              pending={null}
              unavailable={(retry) => (
                <p className="subagent-card__note" role="alert">
                  Could not load the transcript viewer.{' '}
                  <Button size="sm" className="tap-target" onClick={retry}>
                    Retry
                  </Button>
                </p>
              )}
            />
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
  const [expanded, setExpanded] = useState(false);
  const groupId = useId();
  const grouped = children.length > 1;
  if (!children.length) return null;
  const counts = new Map<TranscriptChild['item']['status'], number>();
  for (const child of children)
    counts.set(child.item.status, (counts.get(child.item.status) ?? 0) + 1);

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
            {children.slice(0, 3).map((child) => (
              <ChildWorkIdentity
                key={child.item.childId}
                provider={child.provider}
              />
            ))}
            {children.length > 3 && (
              <span className="subagent-group__more">
                +{children.length - 3}
              </span>
            )}
          </span>
          <strong>{children.length} subagents</strong>
          <span className="subagent-group__counts" aria-live="polite">
            {[...counts]
              .map(
                ([status, count]) =>
                  `${count} ${CHILD_WORK_STATUS_LABEL[status].toLowerCase()}`,
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
          <SubagentTranscriptCard key={child.item.childId} child={child} />
        ))}
      </div>
    </div>
  );
}

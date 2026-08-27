// station#1301: Running/Finished panel over the chat's background-task
// registry, with safe delegate controls and persisted transcript details.
// Lazy-loaded from ChatDock.tsx — see the note there on why this stays out of
// the entry chunk.

import {
  useInterruptDelegatedTaskMutation,
  useOrchestrationSessionQuery,
} from '@kontourai/station-sdk';
import {
  cacheInclusiveTotalTokens,
  foldUsageEvents,
} from '@kontourai/station-shared/usage-fold';
import type { RefObject } from 'react';
import { useEffect, useMemo, useState } from 'react';
import type {
  BackgroundTaskEntry,
  BackgroundTaskState,
} from '../../contexts/background-tasks-store';
import { useChatBackgroundTasks } from '../../hooks/useBackgroundTasks';
import { AgentGlyph, TerminalGlyph } from '../icons/Glyph';
import {
  ResponsiveDialogCloseButton,
  ResponsiveDialogSurface,
} from '../ResponsiveDialogSurface';
import { Empty } from '../state';
import './BackgroundTasksSheet.css';

const SECTION_STORAGE_KEY = 'station.background-tasks.sections';

interface SectionState {
  finishedExpanded: boolean;
}

const DEFAULT_SECTION_STATE: SectionState = { finishedExpanded: false };

function readSectionState(): SectionState {
  try {
    const raw = localStorage.getItem(SECTION_STORAGE_KEY);
    if (!raw) return DEFAULT_SECTION_STATE;
    const parsed = JSON.parse(raw) as Partial<SectionState>;
    return {
      finishedExpanded:
        typeof parsed.finishedExpanded === 'boolean'
          ? parsed.finishedExpanded
          : DEFAULT_SECTION_STATE.finishedExpanded,
    };
  } catch {
    return DEFAULT_SECTION_STATE;
  }
}

function writeSectionState(state: SectionState) {
  try {
    localStorage.setItem(SECTION_STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* Collapsed state is a convenience; storage failure must not break the sheet. */
  }
}

/** `m:ss`, or `h:mm:ss` once an entry has run past an hour. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
}

const KIND_LABEL: Record<BackgroundTaskEntry['kind'], string> = {
  tool: 'Tool',
  agent: 'Agent',
};

const OUTCOME_LABEL: Partial<Record<BackgroundTaskState, string>> = {
  completed: 'Completed',
  stopped: 'Stopped',
  failed: 'Failed',
};

function TaskGlyph({ kind }: { kind: BackgroundTaskEntry['kind'] }) {
  return kind === 'tool' ? <TerminalGlyph /> : <AgentGlyph />;
}

function TaskRow({
  entry,
  elapsedMs,
  outcomeChip,
  onOpenTranscript,
}: {
  entry: BackgroundTaskEntry;
  elapsedMs: number;
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
            {KIND_LABEL[entry.kind]} · {formatElapsed(elapsedMs)}
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
    </li>
  );
}

export interface BackgroundTasksSheetProps {
  chatThreadId: string;
  anchorRef: RefObject<HTMLElement | null>;
  returnFocusTarget?: HTMLElement | null;
  onOpenTranscript: (threadId: string) => void;
  onClose: () => void;
}

export function BackgroundTasksSheet({
  chatThreadId,
  anchorRef,
  returnFocusTarget,
  onOpenTranscript,
  onClose,
}: BackgroundTasksSheetProps) {
  const { running, finished } = useChatBackgroundTasks(chatThreadId);
  const [sections, setSections] = useState<SectionState>(readSectionState);
  const [now, setNow] = useState(() => Date.now());

  // Shared 1s ticker for every Running row's elapsed time — only while this
  // sheet is mounted (it is only ever mounted while open; see the lazy
  // Suspense gate in ChatDock.tsx).
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const toggleFinished = () => {
    setSections((current) => {
      const next: SectionState = {
        finishedExpanded: !current.finishedExpanded,
      };
      writeSectionState(next);
      return next;
    });
  };

  const isEmpty = running.length === 0 && finished.length === 0;

  return (
    <ResponsiveDialogSurface
      onClose={onClose}
      ariaLabel="Background tasks"
      overlayClassName="background-tasks-sheet-overlay background-tasks-sheet-overlay--start"
      panelClassName="background-tasks-sheet-panel"
      anchorRef={anchorRef}
      returnFocusTarget={returnFocusTarget}
    >
      <header className="background-tasks-sheet__header">
        <h2>Background tasks</h2>
        <ResponsiveDialogCloseButton
          label="Close background tasks"
          onClick={onClose}
        />
      </header>
      <div className="background-tasks-sheet__body">
        {isEmpty && <Empty variant="compact" label="Nothing here yet" />}
        {running.length > 0 && (
          <section className="background-tasks-sheet__section">
            <h3 className="background-tasks-sheet__section-label">
              Running ({running.length})
            </h3>
            <ul className="background-tasks-sheet__list">
              {running.map((entry) => (
                <TaskRow
                  key={entry.id}
                  entry={entry}
                  elapsedMs={now - entry.startedAt}
                  onOpenTranscript={onOpenTranscript}
                />
              ))}
            </ul>
          </section>
        )}
        {finished.length > 0 && (
          <section className="background-tasks-sheet__section">
            <button
              type="button"
              className="background-tasks-sheet__section-toggle"
              aria-expanded={sections.finishedExpanded}
              onClick={toggleFinished}
            >
              <span aria-hidden="true">
                {sections.finishedExpanded ? '−' : '+'}
              </span>
              Finished ({finished.length})
            </button>
            {sections.finishedExpanded && (
              <ul className="background-tasks-sheet__list">
                {finished.map((entry) => (
                  <TaskRow
                    key={entry.id}
                    entry={entry}
                    elapsedMs={
                      (entry.endedAt ?? entry.startedAt) - entry.startedAt
                    }
                    outcomeChip={entry.state}
                    onOpenTranscript={onOpenTranscript}
                  />
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
      <footer className="background-tasks-sheet__footer">
        Remote delegations appear on the Activity page.
      </footer>
    </ResponsiveDialogSurface>
  );
}

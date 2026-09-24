// station#1301: Running/Finished panel over the chat's background-task
// registry, with safe delegate controls and persisted transcript details.
// Lazy-loaded from ChatDock.tsx — see the note there on why this stays out of
// the entry chunk.

import type { RefObject } from 'react';
import { useEffect, useState } from 'react';
import { useChatBackgroundTasks } from '../../hooks/useBackgroundTasks';
import {
  ResponsiveDialogCloseButton,
  ResponsiveDialogSurface,
} from '../ResponsiveDialogSurface';
import { Empty } from '../state';
import { backgroundTaskElapsedMs, TaskRow } from './backgroundTaskRows';
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
      layer="popover"
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
                  elapsedMs={backgroundTaskElapsedMs(entry, now)}
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
                    elapsedMs={backgroundTaskElapsedMs(entry, now)}
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

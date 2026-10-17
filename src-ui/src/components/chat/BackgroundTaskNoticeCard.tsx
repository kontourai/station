import type { ChildWorkTerminalStatus } from '@kontourai/station-contracts/child-work';
import type { BackgroundTaskNotice } from '../../contexts/active-chats-state';
import { STATUS_GLYPH_BY_STATE } from '../status/StatusGlyph';
import { LazyMarkdown } from './LazyMarkdown';
import './BackgroundTaskNoticeCard.css';

interface NoticeStatusPresentation {
  /** Visible status text. It carries the meaning; the glyph only marks it. */
  text: string;
  glyph: string;
  tone: 'success' | 'danger' | 'muted' | 'warning';
}

/**
 * The glyph and tone come from the shared lifecycle vocabulary
 * (`StatusGlyph`), so a finished task here reads like a finished chat
 * everywhere else. The two outcomes nobody confirmed share the caution tone:
 * neither may look like a success or a confirmed stop (#2459).
 */
const NOTICE_STATUS: Record<ChildWorkTerminalStatus, NoticeStatusPresentation> =
  {
    completed: {
      text: 'Task finished',
      glyph: STATUS_GLYPH_BY_STATE.Completed.glyph,
      tone: 'success',
    },
    failed: {
      text: 'Task failed',
      glyph: STATUS_GLYPH_BY_STATE.Failed.glyph,
      tone: 'danger',
    },
    cancelled: {
      text: 'Task stopped',
      glyph: STATUS_GLYPH_BY_STATE.Stopped.glyph,
      tone: 'muted',
    },
    'stopped-unconfirmed': {
      text: 'Stop requested — not confirmed',
      glyph: '?',
      tone: 'warning',
    },
    unresolved: {
      text: 'Task ended — outcome unknown',
      glyph: '?',
      tone: 'warning',
    },
  };

/**
 * A backgrounded child's settle, compact: one line of status and title, then
 * the engine's result. When that result only restates the title (Claude's
 * `Background command "<title>" completed (exit code 0)`), it moves behind a
 * Details disclosure instead of repeating the title in the card's body.
 *
 * No artifact link: the child-work result carries a summary and a handle to a
 * transcript or session, never a produced file such as a capture's image, so
 * there is nothing computed to link to here.
 */
export function BackgroundTaskNoticeCard({
  notice,
}: {
  notice: BackgroundTaskNotice;
}) {
  const status = NOTICE_STATUS[notice.status] ?? NOTICE_STATUS.unresolved;
  const { title, summary } = notice;
  const summaryRestatesTitle = Boolean(title && summary?.includes(title));
  return (
    <div
      className="task-notice"
      data-testid="background-task-notice"
      data-status={notice.status}
    >
      <p className="task-notice__line">
        <span
          className={`task-notice__status task-notice__status--${status.tone}`}
        >
          <span className="task-notice__glyph" aria-hidden="true">
            {status.glyph}
          </span>
          {status.text}
        </span>
        {title && (
          <>
            <span className="task-notice__separator" aria-hidden="true">
              ·
            </span>
            <span className="task-notice__title">{title}</span>
          </>
        )}
      </p>
      {summary &&
        (summaryRestatesTitle ? (
          <details className="task-notice__details">
            <summary>Details</summary>
            <p className="task-notice__summary">{summary}</p>
          </details>
        ) : (
          <div className="task-notice__summary">
            <LazyMarkdown loadingProjection={summary}>{summary}</LazyMarkdown>
          </div>
        ))}
    </div>
  );
}

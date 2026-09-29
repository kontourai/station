import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import { StatusBadge } from '@kontourai/ui/react';
import { Fragment } from 'react';
import {
  orchestrationLifecycleLabel,
  sessionStatusWord,
} from '../../utils/session-state';
import { sessionKindLabel } from '../../utils/sessionDisplay';
import { Button } from '../Button';
import { sessionStateTone } from '../kontour/station-tones';
import {
  type SessionDetailMenuAction,
  SessionDetailMoreMenu,
} from './SessionDetailMoreMenu';

/**
 * The session detail page's identity block: kind, title, one status badge,
 * a plain meta line (agent · model · project · where it started · when), and
 * the page's actions — Open in chat (a Station-owned conversation the chat
 * can reopen), Stop… (only while a turn runs; the caller confirms), and ⋯.
 *
 * The raw thread id is not header content any more: it lives in the ⋯ menu
 * (copy) and in Details. The compact-viewport CSS contract
 * (`.sessions-detail--viewport-compact .sessions-detail__eyebrow` etc. in
 * SessionsView.css) depends on these class names staying put here.
 */
export function SessionDetailHeader({
  session,
  title,
  meta,
  isStopped,
  isStreaming,
  connected,
  stopTaskPending,
  onRequestStop,
  onOpenInChat,
  menuActions,
}: {
  session: OrchestrationSessionSummary;
  title: string;
  /** Already-derived meta clauses; empty ones are dropped here. */
  meta: Array<string | null | undefined>;
  /**
   * `isSessionLifecycleStateAtRest` semantics — the session is not doing
   * work. Stop and the connection note are gated on this, NOT on terminality
   * (archive#3244): a failed session is retryable, but "failed AND Stop" is
   * the contradiction archive#1170 removed.
   */
  isStopped: boolean;
  isStreaming: boolean;
  connected: boolean;
  stopTaskPending: boolean;
  /** Opens the stop confirmation; never stops directly. */
  onRequestStop: () => void;
  /** Present only when this session reopens as a real chat. */
  onOpenInChat?: () => void;
  menuActions: readonly SessionDetailMenuAction[];
}) {
  const state = orchestrationLifecycleLabel(session);
  const clauses = meta.filter((clause): clause is string =>
    Boolean(clause?.trim()),
  );
  return (
    <header className="sessions-detail__header">
      <div className="sessions-detail__identity">
        <p className="sessions-detail__eyebrow">{sessionKindLabel(session)}</p>
        <h2>{title}</h2>
        <div className="sessions-detail__status-line">
          <StatusBadge
            status={sessionStatusWord(session)}
            tone={sessionStateTone(state)}
            className="sessions-detail__status"
          />
          {!isStopped && !connected && (
            <span className="sessions-detail__live-indicator" role="status">
              Connecting…
            </span>
          )}
        </div>
        {clauses.length > 0 && (
          <p className="sessions-detail__meta-line">
            {clauses.map((clause, index) => (
              <Fragment key={`${index}:${clause}`}>
                {index > 0 && ' · '}
                <span>{clause}</span>
              </Fragment>
            ))}
          </p>
        )}
      </div>
      <div className="sessions-detail__actions">
        {onOpenInChat && (
          <Button variant="primary" onClick={onOpenInChat}>
            Open in chat
          </Button>
        )}
        {!isStopped && isStreaming && (
          <Button
            variant="secondary"
            className="sessions-detail__stop-task"
            disabled={stopTaskPending}
            onClick={onRequestStop}
          >
            {stopTaskPending ? 'Stopping…' : 'Stop…'}
          </Button>
        )}
        <SessionDetailMoreMenu actions={menuActions} />
      </div>
    </header>
  );
}

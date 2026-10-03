import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import { StatusBadge } from '@kontourai/ui/react';
import { Fragment, useEffect, useRef } from 'react';
import { useAgents } from '../../contexts/AgentsContext';
import { orchestrationLifecycleLabel } from '../../utils/session-state';
import { sessionKindLabel } from '../../utils/sessionDisplay';
import { sessionWorkStatus } from '../../views/sessions/sessions-lane-model';
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
  connectionLabel,
  currentActivity,
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
  connectionLabel?: string;
  currentActivity?: string;
  stopTaskPending: boolean;
  /** Opens the stop confirmation; never stops directly. */
  onRequestStop: () => void;
  /** Present only when this session reopens as a real chat. */
  onOpenInChat?: () => void;
  menuActions: readonly SessionDetailMenuAction[];
}) {
  const state = orchestrationLifecycleLabel(session);
  // The badge's word is the status ladder's (the same one the Activity row
  // and the inbox row for this session print); its tone follows the fold.
  const statusWord = sessionWorkStatus(session, useAgents(), Date.now()).word;
  const headerRef = useRef<HTMLElement | null>(null);
  const openInChatRef = useRef<HTMLButtonElement | null>(null);
  // Stop… leaves once the turn has actually stopped — usually after its
  // confirmation has already handed focus back to it — and focus would fall
  // to <body>. Land it on the header's primary action (or the header itself).
  const showStop = !isStopped && isStreaming;
  const stopWasShown = useRef(showStop);
  useEffect(() => {
    const lost = stopWasShown.current && !showStop;
    stopWasShown.current = showStop;
    if (!lost) return;
    // Focus is stranded only when it sits on nothing: <body>, a node that
    // has been detached (the Stop… button, a closed dialog's panel), or this
    // detail's own header/section container, which the return-focus walk
    // climbs to when the Stop… it would restore is gone. Focus anywhere else
    // was put there on purpose — another pane's heading, this detail's
    // evidence region after a deep link — and is left alone. Checked now and
    // again after a closing dialog has run its own restore (it defers to the
    // next frame), so the "turn ended while the confirmation was open" path
    // lands here too.
    const land = () => {
      const active = document.activeElement;
      const detail = headerRef.current?.closest(
        '[data-testid="session-detail"]',
      );
      const stranded =
        !active ||
        active === document.body ||
        !active.isConnected ||
        active === detail ||
        // The walk makes a surviving ancestor focusable to land on it — here
        // the header or its action row. A real control in the header is not
        // stranded.
        (active instanceof HTMLElement &&
          Boolean(headerRef.current?.contains(active)) &&
          !active.matches('button, a[href], input, textarea, select'));
      if (!stranded) return;
      (openInChatRef.current ?? headerRef.current)?.focus({
        preventScroll: true,
      });
    };
    land();
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(land);
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [showStop]);
  const clauses = meta.filter((clause): clause is string =>
    Boolean(clause?.trim()),
  );
  return (
    <header className="sessions-detail__header" ref={headerRef} tabIndex={-1}>
      <div className="sessions-detail__identity">
        <p className="sessions-detail__eyebrow">{sessionKindLabel(session)}</p>
        <h2>{title}</h2>
        <div className="sessions-detail__status-line">
          <StatusBadge
            status={statusWord}
            tone={sessionStateTone(state)}
            className="sessions-detail__status"
          />
          {!isStopped && (
            <span className="sessions-detail__live-indicator" role="status">
              {connectionLabel ?? (connected ? 'Live' : 'Connecting…')}
              {currentActivity && <> · {currentActivity}</>}
            </span>
          )}
        </div>
        {clauses.length > 0 && (
          <details className="sessions-detail__metadata">
            <summary>Session info</summary>
            <p className="sessions-detail__meta-line">
              {clauses.map((clause, index) => (
                <Fragment key={`${index}:${clause}`}>
                  {index > 0 && ' · '}
                  <span>{clause}</span>
                </Fragment>
              ))}
            </p>
          </details>
        )}
      </div>
      <div className="sessions-detail__actions">
        {onOpenInChat && (
          <Button variant="primary" ref={openInChatRef} onClick={onOpenInChat}>
            Open in chat
          </Button>
        )}
        {showStop && (
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

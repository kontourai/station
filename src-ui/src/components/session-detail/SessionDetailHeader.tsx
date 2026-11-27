import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import { StatusBadge } from '@kontourai/ui/react';
import { Fragment } from 'react';
import type { AgentData } from '../../contexts/AgentsContext';
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
 * can reopen) and the metadata menu. Conversation controls live in the body.
 *
 * The raw thread id is not header content any more: it lives in the ⋯ menu
 * (copy) and in Details. The compact-viewport CSS contract
 * (`.sessions-detail--viewport-compact .sessions-detail__eyebrow` etc. in
 * SessionDetail.css) depends on these class names staying put here.
 */
export function SessionDetailHeader({
  session,
  agents,
  title,
  meta,
  isStopped,
  connected,
  connectionLabel,
  currentActivity,
  onOpenInChat,
  menuActions,
}: {
  session: OrchestrationSessionSummary;
  agents: AgentData[];
  title: string;
  /** Already-derived meta clauses; empty ones are dropped here. */
  meta: Array<string | null | undefined>;
  /**
   * `isSessionLifecycleStateAtRest` semantics — the session is not doing
   * work. The connection note is gated on this, not terminality
   * (archive#3244): a failed session is retryable, but "failed AND Stop" is
   * the contradiction archive#1170 removed.
   */
  isStopped: boolean;
  connected: boolean;
  connectionLabel?: string;
  currentActivity?: string;
  /** Present only when this session reopens as a real chat. */
  onOpenInChat?: () => void;
  menuActions: readonly SessionDetailMenuAction[];
}) {
  const state = orchestrationLifecycleLabel(session);
  // The badge's word is the status ladder's (the same one the Activity row
  // and the inbox row for this session print); its tone follows the fold.
  const statusWord = sessionWorkStatus(session, agents, Date.now()).word;
  const clauses = meta.filter((clause): clause is string =>
    Boolean(clause?.trim()),
  );
  return (
    <header className="sessions-detail__header" tabIndex={-1}>
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
          <Button variant="primary" onClick={onOpenInChat}>
            Open in chat
          </Button>
        )}
        <SessionDetailMoreMenu actions={menuActions} />
      </div>
    </header>
  );
}

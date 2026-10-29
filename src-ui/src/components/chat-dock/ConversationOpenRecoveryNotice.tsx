export interface ConversationOpenRecoveryNoticeProps {
  title: string;
  /**
   * A VERDICT only. `resolving` used to be a member, which is how a
   * conversation that was merely still being read got a red "is read-only"
   * alert on every reload; the transitional state now has its own muted line
   * in `ChatDockBody` and never reaches this component (#1582 E3/B6).
   *
   * Only `missing-session` (the Session is gone) and `resolved` (the server
   * resolved it and refused continuation) or `fork-ready` (the saved fork
   * refused first start — a writable resolution never
   * reaches this notice) are verdicts, and only they say "read-only". Every
   * other state is a failed check — the open read failed (`error`), the
   * server could not resolve it (`unavailable`), or the chat's own point-read
   * failed (`unverified`) — and says so instead (#2424). Callers pass their
   * status through unmapped, so this is the one place that decides which is
   * which.
   */
  state?:
    | 'missing-session'
    | 'resolved'
    | 'fork-ready'
    | 'unavailable'
    | 'error'
    | 'unverified';
  onRetry?: () => void;
  onStartNew?: () => void;
}

/**
 * Conversation-only recovery chrome. Keeping it behind the owning chat
 * boundary means ordinary first paint does not pay for an exceptional open.
 */
export function ConversationOpenRecoveryNotice({
  title,
  state,
  onRetry,
  onStartNew,
}: ConversationOpenRecoveryNoticeProps) {
  const verdict =
    state === 'missing-session' ||
    state === 'resolved' ||
    state === 'fork-ready';
  const detail =
    state === 'missing-session'
      ? 'Its execution session is no longer available.'
      : verdict
        ? 'Station could not prove this chat can continue.'
        : 'Sending is paused. Retry to check again.';

  return (
    <div className="conversation-open-recovery" role="status">
      <span className="conversation-open-recovery__detail">
        <strong title={title}>
          {verdict ? 'This chat is read-only.' : "Couldn't check this chat."}
        </strong>{' '}
        {detail}
      </span>
      {onRetry || onStartNew ? (
        <span className="conversation-open-recovery__actions">
          {onRetry ? (
            <button
              type="button"
              className="button button--secondary"
              onClick={onRetry}
            >
              Retry
            </button>
          ) : null}
          {onStartNew ? (
            <button
              type="button"
              className="button button--secondary"
              onClick={onStartNew}
            >
              Start new chat
            </button>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

import './ConversationOpenRecoveryNotice.css';

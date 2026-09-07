export interface ConversationOpenRecoveryNoticeProps {
  title: string;
  /**
   * A VERDICT only. `resolving` used to be a member, which is how a
   * conversation that was merely still being read got a red "is read-only"
   * alert on every reload; the transitional state now has its own muted line
   * in `ChatDockBody` and never reaches this component (#1582 E3/B6).
   */
  state: 'missing-session' | 'unavailable';
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
  const detail =
    state === 'missing-session'
      ? 'Its execution session is no longer available.'
      : 'Station could not prove a writable continuation for its current session.';

  return (
    <div className="session-history-error" role="alert">
      <strong>{title} is read-only.</strong>
      <span className="session-history-error__detail"> {detail}</span>
      {onRetry ? (
        <button
          type="button"
          className="button button--secondary session-history-error__retry"
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
    </div>
  );
}

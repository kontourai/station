export interface ConversationOpenRecoveryNoticeProps {
  title: string;
  state: 'resolving' | 'missing-session' | 'transcript-only' | 'unavailable';
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
    state === 'resolving'
      ? 'Station is resolving its current session.'
      : state === 'missing-session'
        ? 'Its execution session is no longer available.'
        : state === 'transcript-only'
          ? 'Its transcript is available, but continuation is not authorized.'
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

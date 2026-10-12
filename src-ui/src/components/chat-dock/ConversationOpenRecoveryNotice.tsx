import './ConversationOpenRecoveryNotice.css';

export interface ConversationOpenRecoveryNoticeProps {
  title: string;
  /**
   * A VERDICT only. `resolving` used to be a member, which is how a
   * conversation that was merely still being read got a red "is read-only"
   * alert on every reload; the transitional state now has its own muted line
   * in `ChatDockBody` and never reaches this component (#1582 E3/B6).
   *
   * Only `missing-session` (the Session is gone) and `resolved` (the server
   * resolved it and refused continuation — a writable resolution never
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
    | 'unavailable'
    | 'error'
    | 'unverified';
  /**
   * Each action renders only when passed. Callers pass one only when this
   * client can actually take it — e.g. no `onStartNew` for a paired device
   * that lacks the scope to create a chat — so the notice never offers an
   * action that would only fail.
   */
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
  const verdict = state === 'missing-session' || state === 'resolved';
  // The detail names Retry only when Retry is on screen: a caller that cannot
  // re-check passes no `onRetry`, and the sentence must not point at it.
  const detail =
    state === 'missing-session'
      ? 'Its execution session is no longer available.'
      : verdict
        ? 'Station could not prove this chat can continue.'
        : onRetry
          ? 'Checking this chat failed, so sending is paused. Retry to check again.'
          : 'Checking this chat failed, so sending is paused.';
  // The title is the user's own text ("New chat" by default), so it is
  // quoted: interpolated bare it reads as broken grammar ("confirm New chat
  // can continue"). It stays in the sentence because the picker path shows
  // this notice for a conversation other than the one in the header.
  const quoted = `“${title}”`;

  return (
    <div className="session-history-error" role="alert">
      <strong>
        {verdict
          ? `${quoted} is read-only.`
          : `Station couldn't confirm ${quoted} can continue.`}
      </strong>
      <span className="session-history-error__detail"> {detail}</span>
      {onRetry || onStartNew ? (
        <div className="session-history-error__actions">
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
        </div>
      ) : null}
    </div>
  );
}

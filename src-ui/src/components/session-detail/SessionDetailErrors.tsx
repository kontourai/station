import { ACKNOWLEDGE_ATTENTION_ACTION } from '../attention/notificationRowActions';
import { Button } from '../Button';
import { SessionFailureAlert } from '../session-failure/SessionFailureAlert';
import { ErrorState } from '../state';

/**
 * Mutation-error surface for the session detail page — a genuine failure
 * banner (`session-failure`) plus one alert per mutation that can fail
 * independently (stop, send, respond). Split out of `MutableSessionDetail`
 * per archive#1204.
 *
 * archive#3213: the failure banner itself now lives in `SessionFailureAlert`,
 * shared with the chat dock. Its `note` here is the session's terminal
 * attribution when that says something the cause does not.
 *
 * This is the ONE failure card on the page: the matching `session-failed`
 * attention item is not rendered beside it (its "Open session" link pointed at
 * this very page). The item's acknowledgement survives as this card's
 * Dismiss, which records exactly what the attention card's Dismiss did.
 */
export function SessionDetailErrors({
  failureText,
  failureNote,
  onDismissFailure,
  dismissFailurePending = false,
  dismissFailureError,
  stopTaskError,
  sendTurnError,
  respondError,
  onDraftSendError,
}: {
  failureText: string | null;
  failureNote?: string | null;
  /** Acknowledge the session-failed attention item; absent when none is live. */
  onDismissFailure?: () => void;
  dismissFailurePending?: boolean;
  dismissFailureError?: unknown;
  stopTaskError: unknown;
  sendTurnError: unknown;
  respondError: unknown;
  onDraftSendError?: () => void;
}) {
  return (
    <div className="sessions-detail__errors">
      {failureText ? (
        <div className="sessions-detail__failure-card">
          <SessionFailureAlert
            failureText={failureText}
            note={failureNote ?? undefined}
          />
          {onDismissFailure && (
            <div className="sessions-detail__failure-actions">
              <Button
                variant="secondary"
                disabled={dismissFailurePending}
                onClick={onDismissFailure}
              >
                {ACKNOWLEDGE_ATTENTION_ACTION.label}
              </Button>
            </div>
          )}
          {dismissFailureError ? (
            <p className="sessions-detail__error" role="alert">
              {dismissFailureError instanceof Error
                ? dismissFailureError.message
                : 'Unable to dismiss this failure'}
            </p>
          ) : null}
        </div>
      ) : null}
      {stopTaskError ? (
        <p className="sessions-detail__error" role="alert">
          {stopTaskError instanceof Error
            ? stopTaskError.message
            : 'Unable to stop this task'}
        </p>
      ) : null}
      {sendTurnError ? (
        <ErrorState
          variant="compact"
          title="Unable to continue this task"
          description={
            sendTurnError instanceof Error ? sendTurnError.message : undefined
          }
          action={
            onDraftSendError ? (
              <Button variant="secondary" onClick={onDraftSendError}>
                Ask agent to help
              </Button>
            ) : undefined
          }
        />
      ) : null}
      {respondError ? (
        <p className="sessions-detail__error" role="alert">
          {respondError instanceof Error
            ? respondError.message
            : 'Unable to answer this request'}
        </p>
      ) : null}
    </div>
  );
}

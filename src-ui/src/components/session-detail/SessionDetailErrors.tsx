import { describeStationFailure } from '../../utils/stationFailure';
import { ACKNOWLEDGE_ATTENTION_ACTION } from '../attention/notificationRowActions';
import { Button } from '../Button';
import { SessionFailureAlert } from '../session-failure/SessionFailureAlert';

/** Recorded failure and its attention acknowledgement; mutation feedback is shared. */
export function SessionDetailErrors({
  failureText,
  failureNote,
  onDismissFailure,
  dismissFailurePending = false,
  dismissFailureError,
}: {
  failureText: string | null;
  failureNote?: string | null;
  /** Acknowledge the session-failed attention item; absent when none is live. */
  onDismissFailure?: () => void;
  dismissFailurePending?: boolean;
  dismissFailureError?: unknown;
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
              {describeStationFailure(dismissFailureError).body}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

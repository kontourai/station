import { SessionFailureAlert } from '../session-failure/SessionFailureAlert';

/**
 * Mutation-error surface for the session detail page — a genuine failure
 * banner (`session-failure`) plus one alert per mutation that can fail
 * independently (stop, send, respond). Split out of `MutableSessionDetail`
 * per archive#1204.
 *
 * archive#3213: the failure banner itself now lives in `SessionFailureAlert`,
 * shared with the chat dock. No `note` here — this pane hides its composer for
 * a terminal session, so a "you can continue" line would name an affordance
 * that is not on screen.
 */
export function SessionDetailErrors({
  failureText,
  stopTaskError,
  sendTurnError,
  respondError,
}: {
  failureText: string | null;
  stopTaskError: unknown;
  sendTurnError: unknown;
  respondError: unknown;
}) {
  return (
    <div className="sessions-detail__errors">
      <SessionFailureAlert failureText={failureText} />
      {stopTaskError ? (
        <p className="sessions-detail__error" role="alert">
          {stopTaskError instanceof Error
            ? stopTaskError.message
            : 'Unable to stop this task'}
        </p>
      ) : null}
      {sendTurnError ? (
        <p className="sessions-detail__error" role="alert">
          {sendTurnError instanceof Error
            ? sendTurnError.message
            : 'Unable to continue this task'}
        </p>
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

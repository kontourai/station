import type {
  AdoptedSessionResult,
  OrchestrationSessionSummary,
} from '@kontourai/station-sdk';
import { useSessionEventStream } from '../../hooks/orchestration/useSessionEventStream';
import { useMobileVisualViewport } from '../../hooks/useMobileVisualViewport';
import { elidedHistoryNoticeText } from '../../utils/elidedHistory';
import { AttachedSessionDetail } from './AttachedSessionDetail';
import {
  MutableSessionDetail,
  type SessionEvidenceReveal,
} from './MutableSessionDetail';
import '../../views/SessionsView.css';

export function SessionDetail({
  apiBase,
  session,
  onTaskChanged,
  onAdopted,
  getSelectionIntent,
  evidenceReveal,
}: {
  apiBase: string;
  session: OrchestrationSessionSummary;
  onTaskChanged: () => void;
  onAdopted: (session: AdoptedSessionResult, intent: number) => void;
  getSelectionIntent: () => number;
  evidenceReveal?: SessionEvidenceReveal | null;
}) {
  const {
    events,
    connected,
    hasMore,
    loadOlder,
    upgradeRequired,
    error,
    historyRetrying,
    elidedHistory,
    liveStreamStoppedTerminal,
    historyStoppedTerminal,
    capabilityRecoveryExhausted,
    retryCapabilityRecovery,
  } = useSessionEventStream(apiBase, session.threadId);
  // archive#3386: the same bounded read feeds this surface and
  // the chat dock. The dock disclosed what its budget withheld and this one
  // rendered the identical amputated turn in silence, because both readers in
  // `useSessionEventStream` unwrapped `item.event` and dropped the envelope.
  const elidedHistoryText = elidedHistoryNoticeText(elidedHistory);
  const elidedHistoryNotice = elidedHistoryText ? (
    <p
      className="history-elided"
      role="status"
      data-testid="session-history-elided"
    >
      {elidedHistoryText}
    </p>
  ) : null;
  const visualViewport = useMobileVisualViewport();
  const historyControls = (
    <div className="session-history-controls">
      {hasMore && (
        <button
          type="button"
          className="button button--secondary session-history-controls__more"
          onClick={() => void loadOlder()}
        >
          Load earlier events
        </button>
      )}
      {upgradeRequired && (
        <p role="alert">Update Station to view this session history.</p>
      )}
      {elidedHistoryNotice}
      {error && !upgradeRequired && (
        <p role="alert">
          {/* archive#3378: the two outcomes read identically before this —
              a history read that is coming back and one that has stopped
              both printed the raw cause and nothing else. */}
          {historyRetrying
            ? `${error.message} Retrying session history…`
            : error.message}
        </p>
      )}
    </div>
  );

  if (session.controlMode === 'read-only-attached') {
    return (
      <>
        {/* Upgrade/error stories render INSIDE the detail for attached
            sessions — only the pagination control and the elision notice
            belong up here, or the update requirement renders twice (sol delta
            review, #2630). The notice is safe in both places precisely
            because it is NOT among the props handed to
            `AttachedSessionDetail`: nothing downstream can render it a second
            time, and these two branches are mutually exclusive anyway. */}
        {(hasMore || elidedHistoryNotice) && (
          <div className="session-history-controls">
            {hasMore && (
              <button
                type="button"
                className="button button--secondary session-history-controls__more"
                onClick={() => void loadOlder()}
              >
                Load earlier events
              </button>
            )}
            {elidedHistoryNotice}
          </div>
        )}
        <AttachedSessionDetail
          key={session.threadId}
          apiBase={apiBase}
          session={session}
          onAdopted={onAdopted}
          getSelectionIntent={getSelectionIntent}
          events={events}
          connected={connected}
          upgradeRequired={upgradeRequired}
          streamError={error}
          liveStreamStoppedTerminal={liveStreamStoppedTerminal}
          historyStoppedTerminal={historyStoppedTerminal}
          capabilityRecoveryExhausted={capabilityRecoveryExhausted}
          onRetryCapabilityRecovery={retryCapabilityRecovery}
          visualViewport={visualViewport}
        />
      </>
    );
  }

  return (
    <>
      {historyControls}
      <MutableSessionDetail
        apiBase={apiBase}
        session={session}
        onTaskChanged={onTaskChanged}
        events={events}
        connected={connected}
        visualViewport={visualViewport}
        evidenceReveal={evidenceReveal}
      />
    </>
  );
}

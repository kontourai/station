import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import type {
  AdoptedSessionResult,
  OrchestrationSessionSummary,
  StarterWorkStatus,
} from '@kontourai/station-sdk';
import {
  AdoptSessionError,
  adoptOrchestrationSession,
  createAdoptOrchestrationSessionIntent,
  getStarterWork,
  launchContinueSessionStarter,
} from '@kontourai/station-sdk';
import { projectRuntimeEventsToMessages } from '@kontourai/station-shared/runtime-event-projection';
import { useMutation } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useToast } from '../../contexts/ToastContext';
import type { OrchestrationEvent } from '../../hooks/orchestration/types';
import type { useMobileVisualViewport } from '../../hooks/useMobileVisualViewport';
import {
  type AttachedSessionContinuationRead,
  browserAttachedSessionContinuationStore,
} from '../../lib/attached-session-continuation-store';
import type { ChatMessage } from '../../types';
import { displayProvider, sessionTitle } from '../../utils/sessionDisplay';
import { isStationTransportFailure } from '../../utils/stationTransportFailure';
import { Button } from '../Button';
import { PermissionPostureBadge } from '../badges/PermissionPostureBadge';
import { MessageContent } from '../chat/message-bubble/MessageContent';

function hasCanonicalEventId(
  event: OrchestrationEvent,
): event is CanonicalRuntimeEvent {
  return typeof event.eventId === 'string' && event.eventId.length > 0;
}

function reservationFailure(
  state: Extract<
    AttachedSessionContinuationRead['state'],
    'corrupt' | 'unavailable'
  >,
): AdoptSessionError {
  return new AdoptSessionError({
    failureClass: 'certain-not-sent',
    message:
      state === 'corrupt'
        ? 'The saved continuation request is corrupt, so no continuation was requested.'
        : 'The saved continuation request is unavailable, so no continuation was requested.',
    retryable: false,
  });
}

/**
 * Read-only view for a session Station is only following (a terminal
 * session attached from another surface, e.g. a CLI). Offers one action —
 * adopt it into a real Station-owned continuation — plus the imported
 * transcript. Split out of `SessionsView` per archive#1204.
 */
export function AttachedSessionDetail({
  apiBase,
  session,
  onAdopted,
  getSelectionIntent,
  events,
  connected,
  upgradeRequired,
  streamError,
  liveStreamStoppedTerminal,
  historyStoppedTerminal,
  capabilityRecoveryExhausted,
  onRetryCapabilityRecovery,
  visualViewport,
}: {
  apiBase: string;
  session: OrchestrationSessionSummary;
  onAdopted: (session: AdoptedSessionResult, intent: number) => void;
  getSelectionIntent: () => number;
  events: OrchestrationEvent[];
  connected: boolean;
  upgradeRequired?: boolean;
  streamError?: Error;
  /**
   * archive#3426: the three honest states behind one `disconnected` flag.
   * `liveStreamStoppedTerminal`/`historyStoppedTerminal` name a credential
   * rejection (401/403) the SSE transport or the history-window ladder gave
   * up on for good; `capabilityRecoveryExhausted` names the bounded
   * capability re-probe running out of automatic attempts (not a rejection —
   * `onRetryCapabilityRecovery` can restart it). All three default to
   * `false`/absent so an omitted prop reads as "still retrying", the prior
   * behavior.
   */
  liveStreamStoppedTerminal?: boolean;
  historyStoppedTerminal?: boolean;
  capabilityRecoveryExhausted?: boolean;
  onRetryCapabilityRecovery?: () => void;
  visualViewport: ReturnType<typeof useMobileVisualViewport>;
}) {
  const { showToast } = useToast();
  const adoptionIntent = useRef(createAdoptOrchestrationSessionIntent());
  // A settled server outcome is distinct from local reservation evidence: the
  // former says this exact continuation cannot be retried safely, whereas the
  // latter says the browser cannot establish whether it may launch at all.
  // Keep the guard in a ref too, so a second activation cannot race the render
  // that disables the button.
  const serverRejectedRetryRef = useRef(false);
  const [serverRejectedRetry, setServerRejectedRetry] = useState(false);
  const continuationStore = useRef<ReturnType<
    typeof browserAttachedSessionContinuationStore
  > | null>(null);
  if (!continuationStore.current) {
    continuationStore.current = browserAttachedSessionContinuationStore();
  }
  const messages = projectRuntimeEventsToMessages(
    events.filter(hasCanonicalEventId),
  );
  const adoption = useMutation({
    mutationFn: async (_intent: number) => {
      try {
        const persisted = continuationStore.current!.read(session.threadId);
        let operationId: string;
        if (persisted.state === 'pending') {
          operationId = persisted.operationId;
        } else {
          if (persisted.state !== 'absent')
            throw reservationFailure(persisted.state);
          let status: StarterWorkStatus;
          try {
            status = await getStarterWork('continue-session', apiBase);
          } catch (error) {
            throw new AdoptSessionError({
              failureClass: 'certain-response',
              message:
                'Starter correlation could not be read, so no continuation was requested.',
              retryable: true,
              cause: error,
            });
          }
          if (status.state === 'unavailable')
            throw new AdoptSessionError({
              failureClass: 'certain-response',
              message:
                'Starter correlation is unavailable, so no continuation was requested.',
              retryable: true,
            });
          if (status.state === 'bound')
            return adoptOrchestrationSession({
              sourceThreadId: session.threadId,
              apiBase,
              intent: adoptionIntent.current,
            });
          const reservation = await continuationStore.current!.reserve(
            session.threadId,
          );
          if (reservation.state !== 'reserved') {
            throw reservationFailure(reservation.state);
          }
          operationId = reservation.operationId;
        }
        const outcome = await launchContinueSessionStarter({
          starterId: 'continue-session',
          sourceSessionId: session.threadId,
          operationId,
          apiBase,
        });
        if (outcome.state === 'continued') {
          const clearance = await continuationStore.current!.clear(
            session.threadId,
            operationId,
          );
          if (clearance.state !== 'cleared') {
            showToast(
              'Session continued, but its saved continuation request could not be cleared. Future retries may reuse it.',
              outcome.session.threadId,
            );
          }
          if (outcome.correlation.state !== 'bound')
            // archive#3965: a toast is read in a second — it has to lead with
            // what happened, not with the name of the check that didn't pass.
            showToast(
              `Continued. We couldn’t confirm this links back to your first-task step (${outcome.correlation.reason}).`,
              outcome.session.threadId,
            );
          return outcome.session;
        }
        if (outcome.retrySafe === false) {
          serverRejectedRetryRef.current = true;
          setServerRejectedRetry(true);
        }
        throw new AdoptSessionError({
          failureClass:
            outcome.state === 'indeterminate'
              ? 'uncertain-no-response'
              : 'certain-response',
          message: outcome.reason,
          retryable: outcome.retrySafe,
        });
      } catch (error) {
        if (error instanceof AdoptSessionError) throw error;
        throw new AdoptSessionError({
          failureClass: isStationTransportFailure(error)
            ? 'uncertain-no-response'
            : 'certain-response',
          message:
            error instanceof Error
              ? error.message
              : 'Station could not continue the Session.',
          retryable: true,
          cause: error,
        });
      }
    },
    onSuccess: (child, intent) => onAdopted(child, intent),
    onError: (error) => {
      // Keep the diagnostic available to native/browser developer consoles;
      // the screen deliberately presents a plain-language recovery state.
      console.error('Attached-session continuation failed', error);
    },
  });
  const adoptionCause =
    adoption.error instanceof Error &&
    adoption.error.cause instanceof Error &&
    adoption.error.cause.message
      ? adoption.error.cause.message
      : undefined;
  const technicalErrors = [
    streamError?.message,
    adoption.error instanceof Error ? adoption.error.message : undefined,
    // The classifier wraps the native/browser transport detail as `cause`;
    // the disclosure keeps that raw diagnostic, not just the plain copy.
    adoptionCause,
  ].filter((message): message is string => Boolean(message));
  const disconnected = !connected || Boolean(streamError);
  // archive#3426: derive the claim from the mechanism that is actually
  // active, instead of one copy folding three recovery mechanisms with
  // different behaviours. `stoppedTerminal` takes precedence — a credential
  // rejection stops both the other mechanisms too (the SSE transport closes
  // the stream, `authenticatedStream?.close`, and the capability probe is
  // moot with nothing left to hydrate).
  const stoppedTerminal = Boolean(
    liveStreamStoppedTerminal || historyStoppedTerminal,
  );
  const stoppedRecoverable =
    !stoppedTerminal && Boolean(capabilityRecoveryExhausted);
  const adoptionError =
    adoption.error instanceof Error && 'failureClass' in adoption.error
      ? (adoption.error as AdoptSessionError)
      : null;
  const adoptionDidNotReachStation =
    adoptionError?.failureClass === 'certain-not-sent';
  const adoptionNonRetryable = adoptionError?.retryable === false;
  const adoptionOutcomeUncertain =
    adoptionError?.failureClass === 'uncertain-no-response';
  const adoptionTransportFailed = isStationTransportFailure(adoption.error);
  const adoptionDisabled = adoption.isPending || serverRejectedRetry;
  // archive#3227 C3: this was an inline copy of `sessionTitle`'s first and
  // last branches with its delegation branch missing, so an attached session
  // that DID carry a delegated task id read "Claude Code session" here and
  // "Worker task · <id>" in the list it was opened from.
  const title = sessionTitle(session);

  return (
    <section
      className="sessions-detail sessions-detail--read-only"
      data-testid="session-detail"
      style={visualViewport.style}
    >
      <header className="sessions-detail__header">
        <div>
          <p className="sessions-detail__eyebrow">Attached session</p>
          <h2>{title}</h2>
          <p className="sessions-detail__meta">
            <span>{displayProvider(session)}</span>
            {session.model && <span>{session.model}</span>}
            <span>
              {messages.length === 0
                ? 'No messages yet'
                : `${messages.length} message${messages.length === 1 ? '' : 's'}`}
            </span>
          </p>
        </div>
      </header>

      {/* archive#3305: one scroll region for everything below the pinned
          header. The previous fixed grid template declared 3 rows for a
          variable child list, so the transcript and adoption controls could
          land past the pane's clipped height with no way to reach them. */}
      <div className="sessions-detail__scroll">
        <p className="sessions-detail__readonly-label">
          Following terminal session · Read only
        </p>

        {upgradeRequired ? (
          <div className="sessions-detail__connection-state" role="status">
            <strong>
              This Station needs an update before it can show this session's
              history.
            </strong>
            <p>
              Update Station on the host computer, then reopen this session.
            </p>
          </div>
        ) : (
          disconnected &&
          (stoppedTerminal ? (
            <div className="sessions-detail__connection-state" role="status">
              <strong>
                Station stopped reconnecting — it rejected this session's
                credentials.
              </strong>
              <p>This transcript is read-only and safe.</p>
            </div>
          ) : stoppedRecoverable ? (
            <div className="sessions-detail__connection-state" role="status">
              <strong>
                Station stopped checking for this session's history and live
                updates automatically.
              </strong>
              <p>This transcript is read-only and safe.</p>
              {onRetryCapabilityRecovery && (
                <Button variant="secondary" onClick={onRetryCapabilityRecovery}>
                  Retry now
                </Button>
              )}
            </div>
          ) : (
            <div className="sessions-detail__connection-state" role="status">
              <strong>
                Station isn't responding right now — retrying automatically.
              </strong>
              <p>This transcript is read-only and safe.</p>
            </div>
          ))
        )}

        <div className="sessions-detail__adoption">
          <div>
            <strong>Continue independently</strong>
            <p>
              Station creates its own continuation. Your terminal keeps the
              original session.
            </p>
          </div>
          {/* The stream's SSE state says nothing about whether this REST
            action would succeed (sol review of #2630, finding 1) — the
            button stays enabled and failures are classified below. */}
          <Button
            variant="primary"
            disabled={adoptionDisabled}
            onClick={() => {
              if (adoption.isPending || serverRejectedRetryRef.current) return;
              adoption.mutate(getSelectionIntent());
            }}
          >
            {adoption.isPending ? 'Continuing…' : 'Continue in Station'}
          </Button>
          {adoption.error && (
            <p className="sessions-detail__adoption-reason" role="alert">
              {serverRejectedRetry
                ? 'Station says this continuation cannot be retried safely from this state.'
                : adoptionNonRetryable
                  ? "Couldn't safely start the continuation. Browser storage is unavailable or corrupt, so retrying could duplicate it."
                  : adoptionDidNotReachStation ||
                      adoptionOutcomeUncertain ||
                      adoptionTransportFailed
                    ? "Couldn't start the continuation — Station isn't responding right now."
                    : "Couldn't start the continuation. Technical detail is under Details below."}
            </p>
          )}
          {adoptionOutcomeUncertain && !serverRejectedRetry && (
            <p className="sessions-detail__disabled-reason">
              Retry safely — Station will not duplicate the continuation.
            </p>
          )}
        </div>
        <details className="sessions-detail__details">
          <summary>Details</summary>
          <p>
            <strong>Session ID:</strong> <code>{session.threadId}</code>
          </p>
          {technicalErrors.map((message) => (
            <p key={message}>
              <strong>Technical detail:</strong> <code>{message}</code>
            </p>
          ))}
        </details>

        <div
          className="sessions-detail__transcript"
          data-testid="attached-session-transcript"
        >
          {messages.length === 0 ? (
            <p className="sessions-detail__feed-empty">
              Waiting for transcript events from this terminal session…
            </p>
          ) : (
            messages.map((message) => {
              const contentParts = message.parts.map((part) => ({
                type: part.type,
                content: part.text,
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                args: part.args,
                result: part.result,
                state: part.state,
                isError: part.isError,
              }));
              return (
                <article
                  className={`sessions-detail__transcript-message sessions-detail__transcript-message--${message.role}`}
                  key={message.id}
                >
                  <p className="sessions-detail__transcript-role">
                    {message.role === 'assistant' ? 'Assistant' : 'You'}
                    {/* archive#1424: this view exists only for a session
                      Station is following read-only (see the doc comment
                      above) — every assistant row it renders is genuinely
                      read-only-attached, so the badge is unconditional here
                      rather than re-derived from a posture the component
                      doesn't otherwise carry. */}
                    {message.role === 'assistant' && (
                      <PermissionPostureBadge posture="read-only-attached" />
                    )}
                  </p>
                  <MessageContent
                    contentParts={contentParts as ChatMessage['contentParts']}
                    textContent=""
                    chatFontSize={14}
                    showReasoning
                    showToolDetails
                    isStreamingMessage={false}
                  />
                </article>
              );
            })
          )}
        </div>
      </div>
    </section>
  );
}

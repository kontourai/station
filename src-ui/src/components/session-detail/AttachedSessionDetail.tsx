import { externalSessionContinuationAvailability } from '@kontourai/station-contracts/engine-capability-matrix';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import type {
  AdoptedSessionResult,
  AdoptSessionTarget,
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
import { useId, useRef, useState } from 'react';
import { useToast } from '../../contexts/ToastContext';
import { conversationPartToContentParts } from '../../hooks/orchestration/conversationTranscriptParts';
import type { OrchestrationEvent } from '../../hooks/orchestration/types';
import type { useMobileVisualViewport } from '../../hooks/useMobileVisualViewport';
import {
  type AttachedSessionContinuationRead,
  browserAttachedSessionContinuationStore,
} from '../../lib/attached-session-continuation-store';
import type { ChatMessage } from '../../types';
import { displayProvider, sessionTitle } from '../../utils/sessionDisplay';
import { isStationTransportFailure } from '../../utils/stationTransportFailure';
import { sessionProjectKeys } from '../../views/sessions/sessions-lane-model';
import { Button } from '../Button';
import { PermissionPostureBadge } from '../badges/PermissionPostureBadge';
import { MessageBubble } from '../chat/MessageBubble';
import { MessageContent } from '../chat/message-bubble/MessageContent';
import {
  TranscriptMarker,
  transcriptMarkerLabel,
} from '../chat/TranscriptMarker';
import { Dialog } from '../Dialog';
import { useSessionTranscriptScroll } from './useSessionTranscriptScroll';

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
type TranscriptPart = ReturnType<typeof conversationPartToContentParts>[number];

/** A part as a read-only transcript shows it: never answerable from here. */
function withoutApprovalBinding(part: TranscriptPart): TranscriptPart {
  const {
    needsApproval: _needsApproval,
    approvalId: _approvalId,
    approvalThreadId: _approvalThreadId,
    approvalEventId: _approvalEventId,
    approvalToolName: _approvalToolName,
    approvalSessionGrant: _approvalSessionGrant,
    ...rest
  } = part as TranscriptPart & Record<string, unknown>;
  return rest as TranscriptPart;
}

export function AttachedSessionDetail({
  apiBase,
  chatFontSize = 14,
  presentation = 'inspector',
  openingContinuation = false,
  continuationCreated = false,
  onLoadOlder,
  session,
  onAdopted,
  onOpenInChat,
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
  onOpenInChat?: () => void;
  presentation?: 'inspector' | 'chat';
  openingContinuation?: boolean;
  continuationCreated?: boolean;
  onLoadOlder?: () => Promise<void>;
  apiBase: string;
  chatFontSize?: number;
  session: OrchestrationSessionSummary;
  onAdopted: (
    session: AdoptedSessionResult,
    intent: number,
    message?: string,
  ) => void;
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
  const continuationSupport = externalSessionContinuationAvailability(
    session.provider,
    session.attachedSource,
  );
  const continuationSupported = continuationSupport.enabled;
  // #3386: a conversation no project claims (Activity's No project) continues
  // only as a No project chat in its own folder, and only because the person
  // confirmed that here: the request names the choice, and Station refuses
  // it for a folder too broad to confine an agent to. A conversation a
  // project claims continues under that project, so it names no choice.
  const outsideProjects = sessionProjectKeys(session).length === 0;
  const adoptionTarget: AdoptSessionTarget | undefined = outsideProjects
    ? { kind: 'own-folder' }
    : undefined;
  const ownFolder = session.cwd ? session.cwd : 'its own folder';
  const noProjectExplanation = `This conversation belongs to no project. Station will continue it as a No project chat that works only in ${ownFolder}. To continue it in a project instead, add a project for that folder or its repository first.`;
  const adoptionIntent = useRef(createAdoptOrchestrationSessionIntent());
  // A settled server outcome is distinct from local reservation evidence: the
  // former says this exact continuation cannot be retried safely, whereas the
  // latter says the browser cannot establish whether it may launch at all.
  // Keep the guard in a ref too, so a second activation cannot race the render
  // that disables the button.
  const serverRejectedRetryRef = useRef(false);
  const [serverRejectedRetry, setServerRejectedRetry] = useState(false);
  /**
   * #3429: Station's reason for a continuation it settled as not created
   * (its engine was not ready), shown as written; the retry stays available.
   */
  const [serverFailureReason, setServerFailureReason] = useState<string | null>(
    null,
  );
  const continuationStore = useRef<ReturnType<
    typeof browserAttachedSessionContinuationStore
  > | null>(null);
  if (!continuationStore.current) {
    continuationStore.current = browserAttachedSessionContinuationStore();
  }
  const messages = projectRuntimeEventsToMessages(
    events.filter(hasCanonicalEventId),
  );
  const [replyRequested, setReplyRequested] = useState(false);
  const continuationDescriptionId = useId();
  const [draft, setDraft] = useState('');
  const confirmedDraft = useRef('');
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const transcriptScrollRef = useRef<HTMLDivElement>(null);
  const transcriptBodyRef = useRef<HTMLDivElement>(null);
  const { atLatest, jumpToLatest, pauseFollowing } = useSessionTranscriptScroll(
    {
      identity: `${apiBase}\0${session.threadId}`,
      scrollRef: transcriptScrollRef,
      contentRef: transcriptBodyRef,
      ready: events.length > 0 && !upgradeRequired && !streamError,
      contentVersion: events,
      preserveReading:
        events.length > 0 && Boolean(upgradeRequired || streamError),
    },
  );
  const adoption = useMutation({
    mutationFn: async (_intent: number) => {
      setServerFailureReason(null);
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
              ...(adoptionTarget ? { target: adoptionTarget } : {}),
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
          ...(adoptionTarget ? { target: adoptionTarget } : {}),
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
        } else if (outcome.state === 'failed') {
          setServerFailureReason(outcome.reason);
        }
        throw new AdoptSessionError({
          failureClass:
            outcome.state === 'indeterminate'
              ? 'uncertain-no-response'
              : 'certain-response',
          message: outcome.reason,
          retryable: outcome.retrySafe,
          // #3386: a settled refusal Station says retrying cannot change is
          // shown in its own words.
          ...(outcome.state === 'failed' && outcome.retrySafe === false
            ? { refusal: outcome.reason }
            : {}),
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
    onSuccess: (child, intent) =>
      onAdopted(
        child,
        intent,
        presentation === 'chat' ? confirmedDraft.current : undefined,
      ),
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
  // #3386: Station refused this continuation for a reason a retry cannot
  // change (a folder it will not continue in): say why, offer no retry.
  const adoptionRefusal =
    adoptionError?.failureClass === 'certain-response' &&
    adoptionError.retryable === false
      ? adoptionError.refusal
      : undefined;
  const adoptionDisabled =
    Boolean(adoptionRefusal) ||
    !continuationSupported ||
    adoption.isPending ||
    openingContinuation ||
    continuationCreated ||
    serverRejectedRetry;
  // archive#3227 C3: this was an inline copy of `sessionTitle`'s first and
  // last branches with its delegation branch missing, so an attached session
  // that DID carry a delegated task id read "Claude Code session" here and
  // "Worker task · <id>" in the list it was opened from.
  const title = sessionTitle(session);

  const continuationAction = (
    <Button
      variant="primary"
      disabled={adoptionDisabled}
      onClick={() => {
        if (
          !continuationSupported ||
          adoption.isPending ||
          serverRejectedRetryRef.current
        )
          return;
        if (presentation === 'inspector' && onOpenInChat) {
          onOpenInChat();
          return;
        }
        if (presentation === 'chat') confirmedDraft.current = draft;
        adoption.mutate(getSelectionIntent());
      }}
    >
      {adoption.isPending || openingContinuation
        ? 'Continuing…'
        : presentation === 'chat'
          ? 'Continue and send'
          : 'Continue in Station'}
    </Button>
  );
  const continuationFeedback = (
    <>
      {adoption.error && (
        <p
          className="sessions-detail__adoption-reason sessions-detail__adoption-folder"
          role="alert"
        >
          {adoptionRefusal
            ? adoptionRefusal
            : serverRejectedRetry
              ? 'Station says this continuation cannot be retried safely from this state.'
              : adoptionNonRetryable
                ? "Couldn't safely start the continuation. Browser storage is unavailable or corrupt, so retrying could duplicate it."
                : serverFailureReason
                  ? `Couldn't start the continuation. ${serverFailureReason}`
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
    </>
  );
  const continuationControls = (
    <div className="sessions-detail__adoption">
      <div>
        <strong>Continue independently</strong>
        <p id={continuationDescriptionId}>
          {continuationSupported
            ? `Continue from this history. The original conversation in ${displayProvider(session)} stays available.`
            : continuationSupport.reason}
        </p>
        {continuationSupported && outsideProjects && (
          <p
            className="sessions-detail__adoption-folder"
            data-testid="attached-continuation-no-project"
          >
            {noProjectExplanation}
          </p>
        )}
      </div>
      {continuationAction}
      {continuationFeedback}
    </div>
  );
  const requestSend = () => {
    if (draft.trim() && !adoption.isPending && !continuationCreated)
      setReplyRequested(true);
  };

  return (
    <section
      className={`sessions-detail sessions-detail--read-only${presentation === 'chat' ? ' sessions-detail--chat' : ''}`}
      data-testid="session-detail"
      style={visualViewport.style}
    >
      {presentation !== 'chat' && (
        <header className="sessions-detail__header">
          <div>
            <p className="sessions-detail__eyebrow">
              Started in {displayProvider(session)}
            </p>
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
      )}

      {/* archive#3305: one scroll region for everything below the pinned
          header. The previous fixed grid template declared 3 rows for a
          variable child list, so the transcript and adoption controls could
          land past the pane's clipped height with no way to reach them. */}
      <div
        className={
          presentation === 'chat' ? 'chat-messages' : 'sessions-detail__scroll'
        }
        role="log"
        tabIndex={-1}
        aria-label="Conversation messages"
        ref={transcriptScrollRef}
        onPointerDown={pauseFollowing}
        onKeyDown={(event) => {
          if (['ArrowUp', 'PageUp', 'Home'].includes(event.key))
            pauseFollowing();
        }}
      >
        {!atLatest && (
          <div className="session-transcript__toolbar responsive-surface-actions">
            <Button variant="secondary" onClick={jumpToLatest}>
              Jump to latest
            </Button>
          </div>
        )}
        {presentation !== 'chat' && (
          <p className="sessions-detail__readonly-label">
            Started in {displayProvider(session)} · Read only
          </p>
        )}

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

        {presentation !== 'chat' && continuationControls}
        {presentation !== 'chat' && (
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
        )}

        {presentation === 'chat' && onLoadOlder && (
          <div className="session-history-controls responsive-surface-actions">
            <Button
              onClick={() => {
                pauseFollowing();
                void onLoadOlder().then(() => {
                  if (transcriptScrollRef.current)
                    transcriptScrollRef.current.scrollTop = 0;
                });
              }}
            >
              Show older messages
            </Button>
          </div>
        )}
        <div
          className="sessions-detail__transcript"
          data-testid="attached-session-transcript"
          ref={transcriptBodyRef}
        >
          {messages.length === 0 ? (
            <p className="sessions-detail__feed-empty">
              Waiting for transcript events from this terminal session…
            </p>
          ) : (
            messages.map((message, index) => {
              // Chat's own mapping, so a runtime error's code (its
              // translated copy), a file's reference and a cancelled call
              // render here as they do in the dock — minus the approval
              // binding: this view is read-only, and a bound part would
              // offer Approve/Deny that nothing here can answer.
              const contentParts = message.parts
                .flatMap(conversationPartToContentParts)
                .map(withoutApprovalBinding);
              const marker = transcriptMarkerLabel(contentParts);
              if (marker)
                return <TranscriptMarker key={message.id} label={marker} />;
              if (presentation === 'chat')
                return (
                  <MessageBubble
                    key={message.id}
                    msg={{
                      role: message.role,
                      content: message.parts
                        .filter((part) => part.type === 'text')
                        .map((part) => part.text ?? '')
                        .join('\n\n'),
                      contentParts: contentParts as ChatMessage['contentParts'],
                    }}
                    idx={index}
                    activeSession={{
                      id: session.threadId,
                      agentSlug: session.provider,
                      agentName: displayProvider(session),
                      messageCount: messages.length,
                    }}
                    agents={[]}
                    chatFontSize={chatFontSize}
                    showReasoning={false}
                    showToolDetails={false}
                    onCopy={(text) => {
                      void navigator.clipboard
                        .writeText(text)
                        .catch(() =>
                          showToast(
                            'Could not copy this message.',
                            session.threadId,
                          ),
                        );
                    }}
                  />
                );
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
      {presentation === 'chat' && (
        <fieldset
          className="external-chat-composer chat-input"
          aria-label="Message composer"
        >
          <div className="chat-input__capsule">
            <div className="chat-input__textarea-wrapper">
              <textarea
                ref={composerRef}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                disabled={adoption.isPending || continuationCreated}
                aria-label="Message"
                placeholder="Type a message…"
                rows={2}
                onKeyDown={(event) => {
                  if (
                    event.key === 'Enter' &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    requestSend();
                  }
                }}
              />
            </div>
            <div className="imported-conversation-send-row">
              <button
                type="button"
                aria-label="Send message"
                className={`chat-input__send-btn ${draft.trim() ? 'chat-input__send-btn--active' : 'chat-input__send-btn--inactive'}`}
                disabled={
                  !draft.trim() || adoption.isPending || continuationCreated
                }
                onClick={requestSend}
              >
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden="true"
                >
                  <path d="M12 19V5m-7 7 7-7 7 7" />
                </svg>
              </button>
            </div>
          </div>
        </fieldset>
      )}
      {presentation === 'chat' && replyRequested && !continuationCreated && (
        <Dialog
          title="Continue here?"
          closeLabel="Cancel continuation"
          size="sm"
          dismissible={!adoption.isPending}
          returnFocusTarget={composerRef.current}
          onClose={() => {
            if (!adoption.isPending) setReplyRequested(false);
          }}
          footer={
            <>
              <Button
                disabled={adoption.isPending}
                onClick={() => setReplyRequested(false)}
              >
                Cancel
              </Button>
              {continuationAction}
            </>
          }
        >
          <p>
            {continuationSupported
              ? `This conversation started in ${displayProvider(session)}. Station will continue from this history and send your message. The original conversation stays available.`
              : continuationSupport.reason}
          </p>
          {continuationSupported && outsideProjects && (
            <p
              className="sessions-detail__adoption-folder"
              data-testid="attached-continuation-no-project"
            >
              {noProjectExplanation}
            </p>
          )}
          {continuationFeedback}
        </Dialog>
      )}
    </section>
  );
}

import { externalSessionContinuationAvailability } from '@kontourai/station-contracts/engine-capability-matrix';
import { ADOPTION_SOURCE_ACTIVE_CODE } from '@kontourai/station-contracts/provider-failure';
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
import { useMutation } from '@tanstack/react-query';
import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';
import { chatDraftsStore } from '../../contexts/chat-drafts-store';
import { navigationStore } from '../../contexts/navigation-store';
import { useToast } from '../../contexts/ToastContext';
import type { OrchestrationEvent } from '../../hooks/orchestration/types';
import { useIsMobile } from '../../hooks/useIsMobile';
import type { useMobileVisualViewport } from '../../hooks/useMobileVisualViewport';
import {
  subscribeAttachedContinuationHandoff,
  takeAttachedContinuationHandoff,
} from '../../lib/attached-continuation-handoff';
import {
  type AttachedSessionContinuationRead,
  browserAttachedSessionContinuationStore,
} from '../../lib/attached-session-continuation-store';
import { displayProvider, sessionTitle } from '../../utils/sessionDisplay';
import { isStationTransportFailure } from '../../utils/stationTransportFailure';
import { sessionProjectKeys } from '../../views/sessions/sessions-lane-model';
import { Button } from '../Button';
import { ConversationBody } from '../conversation/ConversationBody';
import { useOptionalConversationConnection } from '../conversation/ConversationConnectionContext';
import { ConversationHeaderActionSlot } from '../conversation/ConversationHeaderActionSlot';

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
  draftScope,
  handoffScope,
  apiBase,
  chatFontSize = 14,
  showHeader = false,
  onContinueInChat,
  openingContinuation = false,
  continuationCreated = false,
  onLoadOlder,
  session,
  onAdopted,
  getSelectionIntent,
  events,
  connected,
  upgradeRequired,
  streamError,
  liveStreamStoppedTerminal,
  connectionInterrupted,
  historyLoaded,
  historyStoppedTerminal,
  capabilityRecoveryExhausted,
  onRetryCapabilityRecovery,
  visualViewport,
}: {
  draftScope?: string;
  handoffScope?: string;
  /**
   * #3552: the same chat everywhere. Activity's pane has no surrounding
   * chrome, so it shows the conversation's name and origin above it; the dock
   * already names it in its own header.
   */
  showHeader?: boolean;
  /**
   * #3454: a continuation is made in the chat dock, whose reader opens it as
   * its Agent's chat. A host that is not the dock passes this, and Send hands
   * the exact draft to the dock instead of continuing here.
   */
  onContinueInChat?:
    | ((draft: string) => void)
    | ((draft: string) => boolean | Promise<boolean>);
  openingContinuation?: boolean;
  continuationCreated?: boolean;
  onLoadOlder?: () => Promise<void>;
  apiBase: string;
  chatFontSize?: number;
  session: OrchestrationSessionSummary;
  /** `message` is the exact draft the person confirmed sending. */
  onAdopted: (
    session: AdoptedSessionResult,
    intent: number,
    message: string,
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
   * `onRetryCapabilityRecovery` can restart it).
   */
  liveStreamStoppedTerminal?: boolean;
  /**
   * Station stayed unreachable past the hook's grace window (see
   * `useSessionEventStream`). `connected === false` alone is also true while
   * the stream is still opening, which is not an outage and must not be
   * narrated as one.
   */
  connectionInterrupted?: boolean;
  /** History has been read, so an empty transcript is genuinely empty. */
  historyLoaded?: boolean;
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
  const noProjectExplanation = `No project: the agent works only in ${ownFolder}.`;
  const isMobile = useIsMobile();
  /**
   * #3552: the alternative to a No project chat is a Project for this
   * folder, so offer it as an action rather than an instruction. New project
   * opens with the folder chosen; on a phone the dock gives way to the page.
   */
  const addProjectForFolder = session.cwd
    ? () =>
        navigationStore.navigate('/projects/new', {
          directory: session.cwd ?? null,
          maximize: null,
          ...(isMobile ? { dock: null } : {}),
        })
    : undefined;
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
  const inheritedConnection = useOptionalConversationConnection();
  const actionSlot = useContext(ConversationHeaderActionSlot);
  const connection = inheritedConnection ?? { apiBase };
  const [localDraft, setLocalDraft] = useState('');
  const savedDraft = useSyncExternalStore(chatDraftsStore.subscribe, () =>
    draftScope !== undefined
      ? chatDraftsStore.getActivityDraft(draftScope, session.threadId)
      : '',
  );
  const draft = draftScope !== undefined ? savedDraft : localDraft;
  const currentDraft = useRef(draft);
  useLayoutEffect(() => {
    currentDraft.current = draft;
  }, [draft]);
  const setDraft = useCallback(
    (value: string) => {
      currentDraft.current = value;
      if (draftScope !== undefined)
        chatDraftsStore.setActivityDraft(draftScope, session.threadId, value);
      else setLocalDraft(value);
    },
    [draftScope, session.threadId],
  );
  const confirmedDraft = useRef('');
  const handoffIdentity = JSON.stringify([
    apiBase,
    draftScope,
    session.threadId,
  ]);
  const handoff = useMemo(
    () => ({ identity: handoffIdentity, alive: false }),
    [handoffIdentity],
  );
  const [handoffPending, setHandoffPending] = useState(false);
  useLayoutEffect(() => {
    handoff.alive = true;
    return () => {
      handoff.alive = false;
    };
  }, [handoff]);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  // The server's read of whether the harness that wrote this transcript is
  // still working on it. Continuing then forks it, so the person confirms
  // first; the server re-checks and refuses without the override, which
  // opens this same warning when the read here was stale.
  const sourceActive = session.attachedSourceActivity?.state === 'active';
  const [sourceActiveWarning, setSourceActiveWarning] = useState(false);
  // The caution is its own row under the origin, apart from Continue in
  // Station. Opening it (or pressing Continue again while it shows) moves
  // focus to Continue anyway; Not now moves it back to Continue. Set beside
  // the state change; applied once the caution has rendered or gone.
  const focusAfterSwap = useRef<'caution' | 'continue' | null>(null);
  // Continue anyway removes the caution that had focus; if that request then
  // fails, focus goes to the retry rather than the page.
  const focusContinueOnFailure = useRef(false);
  const continueActionRef = useRef<HTMLButtonElement>(null);
  const continueAnywayRef = useRef<HTMLButtonElement>(null);
  const sourceActiveNoteId = useId();
  const showSourceActiveWarning = useCallback(() => {
    // Already showing: nothing re-renders, so focus moves now.
    if (continueAnywayRef.current) {
      continueAnywayRef.current.focus();
      return;
    }
    focusAfterSwap.current = 'caution';
    setSourceActiveWarning(true);
  }, []);
  const adoption = useMutation({
    mutationFn: async ({ override }: { intent: number; override: boolean }) => {
      setServerFailureReason(null);
      const overrideField = override
        ? { continueWhileSourceActive: true as const }
        : {};
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
          // `return await`, not `return`: a rejection must land in the
          // classifying `catch` below, not skip it unclassified (#2722).
          if (status.state === 'bound')
            return await adoptOrchestrationSession({
              sourceThreadId: session.threadId,
              apiBase,
              intent: adoptionIntent.current,
              ...(adoptionTarget ? { target: adoptionTarget } : {}),
              ...overrideField,
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
          ...overrideField,
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
        if (outcome.code === ADOPTION_SOURCE_ACTIVE_CODE)
          throw new AdoptSessionError({
            failureClass: 'certain-response',
            message: outcome.reason,
            retryable: true,
            code: outcome.code,
          });
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
    onSuccess: (child, { intent }) =>
      onAdopted(child, intent, confirmedDraft.current),
    onError: (error) => {
      if (
        error instanceof AdoptSessionError &&
        error.code === ADOPTION_SOURCE_ACTIVE_CODE
      ) {
        showSourceActiveWarning();
        return;
      }
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
  ].filter(
    (message, index, all): message is string =>
      Boolean(message) && all.indexOf(message) === index,
  );
  // Only the hook's grace-filtered and stopped states are outages. A single
  // failed read (`streamError`) is a blip the hook is already retrying, or a
  // failed older page; its detail stays under Details.
  const disconnected = Boolean(
    connectionInterrupted ||
      liveStreamStoppedTerminal ||
      historyStoppedTerminal ||
      capabilityRecoveryExhausted,
  );
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
  // Refused only because the source is still running: the warning below says
  // so and offers the override, so it is not shown as a failure.
  const adoptionSourceActive =
    adoptionError?.code === ADOPTION_SOURCE_ACTIVE_CODE;
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
  // Continued: the host swaps this pane for the new conversation, and until
  // it does a second request could create a duplicate.
  const continued = continuationCreated || adoption.isSuccess;
  const adoptionDisabled =
    Boolean(adoptionRefusal) ||
    !continuationSupported ||
    adoption.isPending ||
    openingContinuation ||
    continued ||
    serverRejectedRetry;
  // archive#3227 C3: this was an inline copy of `sessionTitle`'s first and
  // last branches with its delegation branch missing, so an attached session
  // that DID carry a delegated task id read "Claude Code session" here and
  // "Worker task · <id>" in the list it was opened from.
  const title = sessionTitle(session);

  const continuationFeedback = (
    <>
      {adoption.error && !adoptionSourceActive && (
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
                    ? "Couldn't start the continuation. Station isn't responding."
                    : showHeader
                      ? "Couldn't start the continuation. Technical detail is under Details."
                      : "Couldn't start the continuation. Try again."}
        </p>
      )}
      {adoptionOutcomeUncertain && !serverRejectedRetry && (
        <p className="sessions-detail__disabled-reason">
          Retrying won't continue it twice.
        </p>
      )}
    </>
  );
  const composerDisabled =
    !continuationSupported ||
    (connection.station &&
      connection.station.capabilities.continue.state !== 'allowed') ||
    adoption.isPending ||
    continued ||
    handoffPending;
  // Continuing needs no message: the continuation opens with this history,
  // and a typed draft (none is fine) is sent there afterwards by the host.
  // Every entry (the action, Send, a draft handed over from Activity) comes
  // through here, so each one gets the same guards the action shows.
  const adoptionInFlight = useRef(false);
  const startContinuation = ({ override = false } = {}) => {
    if (
      adoptionDisabled ||
      composerDisabled ||
      adoptionInFlight.current ||
      serverRejectedRetryRef.current
    )
      return;
    confirmedDraft.current = currentDraft.current;
    // The source is still running: ask first, inline, instead of forking it.
    if (sourceActive && !override) {
      showSourceActiveWarning();
      return;
    }
    setSourceActiveWarning(false);
    focusContinueOnFailure.current = override;
    adoptionInFlight.current = true;
    adoption.mutate(
      { intent: getSelectionIntent(), override },
      {
        onSettled: () => {
          adoptionInFlight.current = false;
        },
      },
    );
  };
  const requestSend = async ({ allowEmpty = false } = {}) => {
    if ((!allowEmpty && !draft.trim()) || composerDisabled) return;
    if (onContinueInChat) {
      const held = handoff;
      setHandoffPending(true);
      try {
        const submittedDraft = draft;
        const result = onContinueInChat(submittedDraft);
        const accepted = result instanceof Promise ? await result : result;
        const latest =
          draftScope === undefined
            ? currentDraft.current
            : chatDraftsStore.getActivityDraft(draftScope, session.threadId);
        if (held.alive && accepted !== false && latest === submittedDraft)
          setDraft('');
      } catch {
        if (held.alive)
          showToast(
            'Could not open this conversation. Your message is still here.',
            session.threadId,
          );
      } finally {
        if (held.alive) setHandoffPending(false);
      }
      return;
    }
    startContinuation();
  };
  const startContinuationRef = useRef(startContinuation);
  startContinuationRef.current = startContinuation;
  // A draft handed over from Activity continues at once: the person already
  // chose Continue there, beside the same folder note this reader shows.
  const handsOff = Boolean(onContinueInChat);
  useEffect(() => {
    if (handsOff) return;
    const receive = () => {
      const handedOver = takeAttachedContinuationHandoff(
        session.threadId,
        handoffScope,
      );
      if (handedOver === null) return;
      setDraft(handedOver);
      // If this reader cannot continue, its reason shows above the composer.
      if (continuationSupported) startContinuationRef.current();
    };
    receive();
    return subscribeAttachedContinuationHandoff(receive);
  }, [
    handsOff,
    session.threadId,
    continuationSupported,
    setDraft,
    handoffScope,
  ]);

  const cautionShown = sourceActiveWarning && !adoption.isPending;
  useEffect(() => {
    const target = focusAfterSwap.current;
    if (target === 'caution' && cautionShown) {
      focusAfterSwap.current = null;
      continueAnywayRef.current?.focus();
    } else if (target === 'continue' && !cautionShown) {
      focusAfterSwap.current = null;
      continueActionRef.current?.focus();
    }
  }, [cautionShown]);
  const adoptionFailed = adoption.isError;
  useEffect(() => {
    if (!adoptionFailed || !focusContinueOnFailure.current) return;
    focusContinueOnFailure.current = false;
    continueActionRef.current?.focus();
  }, [adoptionFailed]);
  // Why continuing is unavailable, said once, beside the action it explains.
  const continueBlockedReason = !continuationSupported
    ? continuationSupport.reason
    : connection.station &&
        connection.station.capabilities.continue.state !== 'allowed'
      ? connection.station.capabilities.continue.reason ===
        'permission-required'
        ? "You don't have permission to continue this conversation."
        : "This Station can't continue this conversation right now."
      : undefined;
  const continueReasonId = useId();
  const continueAction = continued ? null : (
    <Button
      ref={continueActionRef}
      variant="secondary"
      size="sm"
      className="sessions-detail__continue-action"
      disabled={adoptionDisabled || composerDisabled}
      aria-describedby={continueBlockedReason ? continueReasonId : undefined}
      onClick={() => void requestSend({ allowEmpty: true })}
    >
      {adoption.isPending || openingContinuation || handoffPending
        ? 'Continuing…'
        : 'Continue in Station'}
    </Button>
  );
  const continuationNotice =
    !continued &&
    (continueBlockedReason ||
      outsideProjects ||
      (adoption.error && !adoptionSourceActive)) ? (
      <div
        className="sessions-detail__continue-notice"
        data-testid="attached-continue-notice"
      >
        {continueBlockedReason && (
          <p id={continueReasonId} className="sessions-detail__continue-note">
            {continueBlockedReason}
          </p>
        )}
        {outsideProjects && !continueBlockedReason && (
          <p
            className="sessions-detail__continue-note"
            data-testid="attached-continuation-no-project"
          >
            {noProjectExplanation}
            {addProjectForFolder && (
              <>
                {' '}
                <Button
                  variant="link"
                  disabled={adoption.isPending}
                  onClick={addProjectForFolder}
                >
                  Add a project instead
                </Button>
              </>
            )}
          </p>
        )}
        {continuationFeedback}
      </div>
    ) : null;
  // The source is still running: its caution and two choices take a full
  // row of the content area, under the header, not the header's action slot
  // (too narrow for a sentence and two buttons, and on a phone the origin
  // row is one line). Continue in Station stays where it is.
  const sourceActiveCaution = cautionShown ? (
    <div
      className="sessions-detail__source-active"
      data-testid="attached-source-active"
    >
      <p
        id={sourceActiveNoteId}
        role="status"
        className="sessions-detail__source-active-text"
      >
        Still running in {displayProvider(session)}. Continuing now forks it
      </p>
      <div className="sessions-detail__source-active-actions">
        <Button
          ref={continueAnywayRef}
          variant="primary"
          size="sm"
          aria-describedby={sourceActiveNoteId}
          disabled={adoptionDisabled || composerDisabled}
          onClick={() => startContinuation({ override: true })}
        >
          Continue anyway
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            focusAfterSwap.current = 'continue';
            setSourceActiveWarning(false);
          }}
        >
          Not now
        </Button>
      </div>
    </div>
  ) : null;

  return (
    <section
      className="sessions-detail sessions-detail--read-only sessions-detail--chat"
      data-testid="session-detail"
      style={visualViewport.style}
    >
      {showHeader && (
        <header className="sessions-detail__chat-header">
          <div className="sessions-detail__chat-heading">
            <h2>{title}</h2>
            <p className="sessions-detail__meta-line">
              <span>Started in {displayProvider(session)} · Read only</span>
              {session.model && <span> · {session.model}</span>}
            </p>
          </div>
          {!continued && continueAction}
          <details className="sessions-detail__details">
            <summary>Details</summary>
            <div className="sessions-detail__details-body">
              <p>
                <strong>Session ID:</strong> <code>{session.threadId}</code>
              </p>
              {technicalErrors.map((message) => (
                <p key={message}>
                  <strong>Technical detail:</strong> <code>{message}</code>
                </p>
              ))}
            </div>
          </details>
        </header>
      )}

      {/* Pinned above the conversation, not scrolled with it: the view opens
          at the latest message, where a status at the top of the scroll
          region would never be seen. */}
      {upgradeRequired ? (
        <div className="sessions-detail__connection-state" role="status">
          <strong>
            This Station needs an update before it can show this session's
            history.
          </strong>
          <p>Update Station on the host computer, then reopen this session.</p>
        </div>
      ) : (
        disconnected &&
        (stoppedTerminal ? (
          <div className="sessions-detail__connection-state" role="status">
            <strong>
              Station rejected this session's credentials and stopped
              reconnecting.
            </strong>
          </div>
        ) : stoppedRecoverable ? (
          <div className="sessions-detail__connection-state" role="status">
            <strong>
              Station stopped checking for this session's history and live
              updates automatically.
            </strong>
            {onRetryCapabilityRecovery && (
              <Button variant="secondary" onClick={onRetryCapabilityRecovery}>
                Retry now
              </Button>
            )}
          </div>
        ) : (
          <div className="sessions-detail__connection-state" role="status">
            <strong>Station isn't responding. Retrying automatically.</strong>
          </div>
        ))
      )}

      {!showHeader && !actionSlot && !continued && (
        <div
          className="sessions-detail__origin-row"
          data-testid="attached-continue-bar"
        >
          <span className="sessions-detail__origin-label">
            Started in {displayProvider(session)}
          </span>
          {continueAction}
        </div>
      )}
      {actionSlot && !showHeader && continueAction
        ? createPortal(continueAction, actionSlot)
        : null}
      {sourceActiveCaution}
      {continuationNotice}

      <ConversationBody
        density="record"
        connection={connection}
        session={session}
        readOnly
        reader={{
          agentLabel: displayProvider(session),
          isStreaming: false,
          fontSize: chatFontSize,
        }}
        source={{
          events: events.filter(hasCanonicalEventId),
          settled: historyLoaded ?? (connected && events.length > 0),
          hasMore: Boolean(onLoadOlder),
          loadOlder: onLoadOlder,
          upgradeRequired,
          error: streamError,
          retry: onLoadOlder ?? onRetryCapabilityRecovery,
        }}
        composer={{
          // Sending continues the conversation in Station, so the action
          // reads as the ordinary Send.
          submitAction: { label: 'Send', placeholder: 'Message…' },
          input: draft,
          onInputChange: setDraft,
          disabled: composerDisabled,
          onSubmit: () => requestSend(),
          textareaRef: composerRef,
        }}
      />
    </section>
  );
}

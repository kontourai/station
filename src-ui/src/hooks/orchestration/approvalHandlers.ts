import { readHarnessQuestionnaire } from '@kontourai/station-shared/harness-questions';
import { requestIdsSettledByTurnAbort } from '@kontourai/station-shared/request-settlement';
import {
  STATION_BROWSER_SERVER_GRANT_LABEL,
  toolRequestDisplayName,
  toolRequestFromPayload,
  toolRequestGrantLabel,
  toolRequestPreviewFromPayload,
  toolRequestServerGrantFromPayload,
  toolRequestSessionGrantFromPayload,
} from '@kontourai/station-shared/tool-request-preview';
import { toolPurposeView } from '../../components/chat/tool-display-view';
import {
  activeChatsStore,
  type ChatUIState,
} from '../../contexts/active-chats-store';
import { navigationStore } from '../../contexts/NavigationContext';
import { toastStore } from '../../contexts/ToastContext';
import { isReplayThread } from './replay/replay-registry';
import type { OrchestrationEvent } from './types';

export function handleRequestOpenedEvent(
  apiBase: string,
  event: Extract<OrchestrationEvent, { method: 'request.opened' }>,
) {
  const chat = activeChatsStore.getChatForExecutionSession(event.threadId);
  if (!chat) return;

  if (event.blocking === false) return;

  const pendingApprovals = [...(chat.pendingApprovals || [])];
  const newlyOpened = !pendingApprovals.includes(event.requestId);
  if (newlyOpened) pendingApprovals.push(event.requestId);
  // #3071: the turn this request names, read by the shared settle rule when
  // a turn ends (`settlePendingApprovalsOnTurnEnd`). A re-opened request is
  // a new ask, so its binding is this event's, or none.
  const { [event.requestId]: _reopened, ...otherTurnIds } =
    chat.pendingApprovalTurnIds ?? {};
  activeChatsStore.updateChat(event.threadId, {
    pendingApprovals,
    pendingApprovalTurnIds:
      typeof event.turnId === 'string'
        ? { ...otherTurnIds, [event.requestId]: event.turnId }
        : otherTurnIds,
    // A request that opens (again) waits on the user, whatever an earlier
    // answer under the same id left behind. A re-delivered event for a
    // request already pending changes nothing.
    ...(newlyOpened && chat.answeredApprovals?.includes(event.requestId)
      ? {
          answeredApprovals: chat.answeredApprovals.filter(
            (id) => id !== event.requestId,
          ),
        }
      : {}),
    orchestrationStatus: 'awaiting-approval',
  });

  raiseRequestOpenedToast(apiBase, event);
}

/**
 * The toast a `request.opened` raises, without the chat state the live event
 * also writes. A reload rebuilds the toasts of requests a snapshot reports
 * open (`hydrateOpenApprovalToasts`), and must not replay the state: the
 * snapshot already holds it, and setting `awaiting-approval` again would
 * contradict a turn that ended after the request opened.
 */
/**
 * #3284: whether a request carries a tool server form, which is answered on
 * its pending-requests card rather than by a one-click toast. Only the shape
 * is checked here: Station's relay publishes only forms it has normalized,
 * and the pending-requests rows read the form with the full reader before the
 * card renders it (a payload that fails that read is shown as an ordinary
 * request); the card validates any answer. This event path is always loaded,
 * so it carries the shape check rather than the reader.
 */
export function carriesMcpElicitationForm(
  payload: { mcpElicitation?: unknown } | null | undefined,
): boolean {
  const form = payload?.mcpElicitation;
  return (
    typeof form === 'object' &&
    form !== null &&
    typeof (form as { serverId?: unknown }).serverId === 'string' &&
    Array.isArray((form as { fields?: unknown }).fields)
  );
}

export function raiseRequestOpenedToast(
  apiBase: string,
  event: Extract<OrchestrationEvent, { method: 'request.opened' }>,
) {
  const chat = activeChatsStore.getChatForExecutionSession(event.threadId);
  if (!chat || event.blocking === false) return;
  // A form has no one-click answer; the pending-requests card collects it.
  if (
    readHarnessQuestionnaire(event.payload?.questionnaire) ||
    carriesMcpElicitationForm(event.payload)
  )
    return;

  const agentName = chat.agentName || chat.agentSlug || event.provider;
  // #1545: the tool name alone ("Codex wants to use Bash") is not a decision an
  // operator can make. `toolRequestPreview` derives the one field that says
  // what the call will do — the command, the file, the pattern — bounded,
  // single-line and secret-redacted.
  //
  // Read the payload through the shared helpers, never by indexing one key: the
  // adapters do not agree on a name. Claude's `canUseTool` publishes
  // `toolInput`, ACP publishes `rawInput` (so every ACP engine, Gemini
  // included), the station-agent adapter publishes `toolArgs`, and Codex — which
  // Station cannot intercept at all — publishes its raw request params with no
  // argument bag, handled by `toolRequestPreviewFromPayload`'s fallback.
  const { toolName: payloadToolName } = toolRequestFromPayload(event.payload);
  const displayName = toolRequestDisplayName(payloadToolName);
  // The title fallback is adapter display text (Codex: the literal command),
  // so it is shown in the same sanitised, bounded form as a tool name (#3382).
  const toolName =
    displayName ||
    (typeof event.title === 'string'
      ? toolRequestDisplayName(event.title)
      : undefined) ||
    'Tool request';
  const purpose = toolPurposeView(event) ?? toolPurposeView(event.payload);
  const preview = toolRequestPreviewFromPayload(event.payload);
  const toolPreview = [purpose ? `Why: ${purpose}` : '', preview]
    .filter(Boolean)
    .join(' · ');
  // Only name the tool in the grant label when the payload actually reported
  // one. The `event.title` fallback is adapter display text — for Codex it is
  // the literal shell command — and "Allow <a whole command line> for this
  // session" would both mislead about the grant's scope and swamp the button.
  // The inline card uses the same helper (#2316).
  // #2915/#2916: says what a session answer grants for THIS request, and is
  // undefined where none is offered (a plan exit, an ask rule).
  const grantLabel = toolRequestGrantLabel(
    payloadToolName,
    toolRequestSessionGrantFromPayload(event.payload),
  );
  if (
    isReplayThread(event.threadId) ||
    chat.approvalToasts?.has(event.requestId)
  )
    return;

  showApprovalToast(apiBase, event, {
    toolName,
    toolPreview,
    agentName,
    conversationTitle: chat.title,
    grantLabel,
    ...(toolRequestServerGrantFromPayload(event.payload) === 'server'
      ? { serverGrantLabel: STATION_BROWSER_SERVER_GRANT_LABEL }
      : {}),
  });
}

type ApprovalToastView = {
  toolName: string;
  toolPreview: string;
  agentName: string;
  conversationTitle?: string;
  grantLabel?: string;
  /** Set only when the request offers the Station browser server grant. */
  serverGrantLabel?: string;
};

function showApprovalToast(
  apiBase: string,
  event: Extract<OrchestrationEvent, { method: 'request.opened' }>,
  view: ApprovalToastView,
) {
  const answer = (
    decision: 'accept' | 'acceptForSession' | 'decline',
    sessionGrantScope?: 'server',
  ) => {
    const chat = activeChatsStore.getChatForExecutionSession(event.threadId);
    navigationStore.navigate('/', {
      chat: chat?.conversationId ?? event.threadId,
      dock: 'open',
    });
    void answerFromToast(apiBase, event, view, decision, sessionGrantScope);
  };
  const toastId = toastStore.showToolApproval({
    sessionId: event.threadId,
    requestId: event.requestId,
    toolName: view.toolName,
    ...(view.toolPreview ? { toolPreview: view.toolPreview } : {}),
    agentName: view.agentName,
    conversationTitle: view.conversationTitle,
    actions: [
      {
        label: 'Allow Once',
        variant: 'primary',
        onClick: () => answer('accept'),
      },
      ...(view.grantLabel
        ? [
            {
              // Says what the grant covers: "Allow for Session" reads as a
              // grant for this one call, and it is a standing grant for every
              // later call to the same tool in this session.
              label: view.grantLabel,
              variant: 'secondary' as const,
              onClick: () => answer('acceptForSession'),
            },
          ]
        : []),
      ...(view.serverGrantLabel
        ? [
            {
              label: view.serverGrantLabel,
              variant: 'secondary' as const,
              onClick: () => answer('acceptForSession', 'server'),
            },
          ]
        : []),
      { label: 'Deny', variant: 'danger', onClick: () => answer('decline') },
    ],
  });

  const chat = activeChatsStore.getChatForExecutionSession(event.threadId);
  const approvalToasts = new Map(chat?.approvalToasts || []);
  approvalToasts.set(event.requestId, toastId);
  activeChatsStore.updateChat(event.threadId, { approvalToasts });
}

/** Marks or unmarks a request as answered here; see `answeredApprovals`. */
function setAnswered(threadId: string, requestId: string, answered: boolean) {
  const chat = activeChatsStore.getChatForExecutionSession(threadId);
  if (!chat) return;
  const others = (chat.answeredApprovals ?? []).filter(
    (id) => id !== requestId,
  );
  activeChatsStore.updateChat(threadId, {
    answeredApprovals: answered ? [...others, requestId] : others,
  });
}

/**
 * #2344: the toast used to fire the answer and forget it, so a refused or
 * failed decision showed nothing while the inline card named it. The toast
 * card is gone once clicked (the container dismisses it), so this reports
 * the outcome in its own notice, and a decision that did not land offers the
 * request again: it is still open and still waiting on the user, exactly as
 * the inline card re-enables its buttons.
 */
async function answerFromToast(
  apiBase: string,
  event: Extract<OrchestrationEvent, { method: 'request.opened' }>,
  view: ApprovalToastView,
  decision: 'accept' | 'acceptForSession' | 'decline',
  sessionGrantScope?: 'server',
) {
  // The request stops waiting on the user at the click, not at the engine's
  // `request.resolved`: the queue card is already gone, and a status surface
  // that kept saying "Approval needed" until the round trip finished would
  // contradict it.
  setAnswered(event.threadId, event.requestId, true);
  try {
    // Loaded on demand: the answer path runs only after a click, so it stays
    // out of the entry chunk (same precedent as queueDrain's dispatcher). A
    // failed load is a decision that did not land, and takes the same
    // report-and-re-offer path below.
    const { answerOrchestrationRequest } = await import('./answerRequest');
    const outcome = await answerOrchestrationRequest(apiBase, {
      threadId: event.threadId,
      requestId: event.requestId,
      requestEventId: event.eventId,
      decision,
      ...(sessionGrantScope ? { sessionGrantScope } : {}),
    });
    if (outcome === 'already-settled') {
      toastStore.show(
        `${view.toolName}: this request is no longer open.`,
        event.threadId,
        5000,
      );
    }
  } catch (error) {
    const reason =
      error instanceof Error && error.message
        ? error.message
        : 'Station did not accept this decision.';
    const unconfirmed =
      error instanceof Error &&
      'code' in error &&
      error.code === 'approval_delivery_unconfirmed';
    setAnswered(event.threadId, event.requestId, false);
    toastStore.show(
      unconfirmed
        ? `Delivery of your decision on ${view.toolName} is not confirmed: ${reason}`
        : `Your decision on ${view.toolName} was not delivered: ${reason}`,
      event.threadId,
      9000,
      undefined,
      undefined,
      'error',
    );
    // Only while the request is still waiting: a `request.resolved` that
    // landed meanwhile already removed it, and must not get a dead prompt.
    const chat = activeChatsStore.getChatForExecutionSession(event.threadId);
    if (chat?.pendingApprovals?.includes(event.requestId)) {
      showApprovalToast(apiBase, event, view);
    }
  }
}

/**
 * #2880: the engine-side fate of a recorded decision. `unacknowledged` puts
 * the request on the chat's list; a later `acknowledged` (late ack) takes it
 * off, which clears the status note. The runtime.warning that accompanies an
 * unacknowledged decision is shown by its own handler.
 */
export function handleRequestDeliveryEvent(
  event: Extract<OrchestrationEvent, { method: 'request.delivery' }>,
) {
  const chat = activeChatsStore.getChatForExecutionSession(event.threadId);
  if (!chat) return;
  // The note speaks for a live engine; a report settled after the session
  // ended (a cancel written during teardown) must not re-add what
  // `session.exited` cleared.
  if (
    event.outcome === 'unacknowledged' &&
    chat.orchestrationStatus === 'exited'
  )
    return;
  const others = (chat.unacknowledgedDecisions || []).filter(
    (decision) => decision.requestId !== event.requestId,
  );
  activeChatsStore.updateChat(event.threadId, {
    unacknowledgedDecisions:
      event.outcome === 'unacknowledged'
        ? [
            ...others,
            {
              requestId: event.requestId,
              reason:
                event.reason === 'invalid-reply'
                  ? 'invalid-reply'
                  : 'no-acknowledgement',
            },
          ]
        : others,
  });
}

export function handleRequestResolvedEvent(
  event: Extract<OrchestrationEvent, { method: 'request.resolved' }>,
) {
  void import('./answerRequest')
    .then(({ forgetApprovalAnswer }) =>
      forgetApprovalAnswer(event.threadId, event.requestId),
    )
    .catch(() => undefined);
  const chat = activeChatsStore.getChatForExecutionSession(event.threadId);
  if (!chat) return;

  const pendingApprovals = (chat.pendingApprovals || []).filter(
    (id) => id !== event.requestId,
  );
  const { [event.requestId]: _resolved, ...pendingApprovalTurnIds } =
    chat.pendingApprovalTurnIds ?? {};
  const approvalToasts = new Map(chat.approvalToasts || []);
  const toastId = approvalToasts.get(event.requestId);
  if (toastId) {
    toastStore.dismiss(toastId);
  }
  approvalToasts.delete(event.requestId);
  activeChatsStore.updateChat(event.threadId, {
    pendingApprovals,
    pendingApprovalTurnIds,
    answeredApprovals: (chat.answeredApprovals ?? []).filter(
      (id) => id !== event.requestId,
    ),
    approvalToasts,
    ...(event.blocking === false
      ? {}
      : {
          orchestrationStatus:
            pendingApprovals.length > 0 ? 'awaiting-approval' : 'running',
        }),
  });
}

type PendingApprovalState = Pick<
  ChatUIState,
  | 'pendingApprovals'
  | 'answeredApprovals'
  | 'pendingApprovalTurnIds'
  | 'approvalToasts'
>;

/**
 * #3071: the store's side of the shared settle rule. The server's session
 * summary (so every snapshot's `openRequestIds`), its respond path and the
 * CLI fold the log through `requestIdsSettledByTurnAbort`; a client that
 * folded `request.opened` live and then hears the turn end must reach the
 * same list, or a snapshot reconnect and a live stream disagree about what
 * is still pending. The rule reads the facts the chat recorded — each
 * pending request's turn binding — and this terminal: a request naming the
 * ended turn is settled, one naming no turn (or one whose binding a snapshot
 * never carried) is kept, and an ordinary completion settles nothing.
 *
 * The rule's positional arm (a recovery abort settling every request opened
 * in the dead turn's window) needs that turn's `turn.started`, which the
 * store does not keep. Live, that path is already closed: recovery resolves
 * those requests `expired` before it publishes the abort, and the
 * interrupted-turn banner that follows clears the list outright
 * (`handleSessionStateChangedEvent`).
 *
 * Returns the fields to write, or nothing when nothing settled.
 */
export function settlePendingApprovalsOnTurnEnd(
  chat: PendingApprovalState | undefined,
  event: Extract<
    OrchestrationEvent,
    { method: 'turn.aborted' | 'turn.completed' }
  >,
): PendingApprovalState | Record<never, never> {
  const pending = chat?.pendingApprovals ?? [];
  if (pending.length === 0) return {};
  const turnIds = chat?.pendingApprovalTurnIds ?? {};
  const settled = requestIdsSettledByTurnAbort([
    ...pending.map((requestId) => ({
      method: 'request.opened',
      requestId,
      turnId: turnIds[requestId],
    })),
    event,
  ]);
  if (settled.size === 0) return {};
  const approvalToasts = new Map(chat?.approvalToasts ?? []);
  for (const requestId of settled) {
    const toastId = approvalToasts.get(requestId);
    if (toastId) toastStore.dismiss(toastId);
    approvalToasts.delete(requestId);
  }
  return {
    pendingApprovals: pending.filter((requestId) => !settled.has(requestId)),
    // A settled request is gone; its "answered here" mark goes with it.
    answeredApprovals: (chat?.answeredApprovals ?? []).filter(
      (requestId) => !settled.has(requestId),
    ),
    pendingApprovalTurnIds: Object.fromEntries(
      Object.entries(turnIds).filter(([requestId]) => !settled.has(requestId)),
    ),
    approvalToasts,
  };
}

import { readHarnessQuestionnaire } from '@kontourai/station-shared/harness-questions';
import {
  toolRequestDisplayName,
  toolRequestFromPayload,
  toolRequestGrantLabel,
  toolRequestPreviewFromPayload,
  toolRequestSessionGrantFromPayload,
} from '@kontourai/station-shared/tool-request-preview';
import { toolPurposeView } from '../../components/chat/tool-display-view';
import { activeChatsStore } from '../../contexts/active-chats-store';
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
  if (!pendingApprovals.includes(event.requestId)) {
    pendingApprovals.push(event.requestId);
  }
  activeChatsStore.updateChat(event.threadId, {
    pendingApprovals,
    orchestrationStatus: 'awaiting-approval',
  });

  if (readHarnessQuestionnaire(event.payload?.questionnaire)) return;

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
  const toolName = String(displayName || event.title || 'Tool request');
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
  });
}

type ApprovalToastView = {
  toolName: string;
  toolPreview: string;
  agentName: string;
  conversationTitle?: string;
  grantLabel?: string;
};

function showApprovalToast(
  apiBase: string,
  event: Extract<OrchestrationEvent, { method: 'request.opened' }>,
  view: ApprovalToastView,
) {
  const answer = (decision: 'accept' | 'acceptForSession' | 'decline') => {
    void answerFromToast(apiBase, event, view, decision);
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
      { label: 'Deny', variant: 'danger', onClick: () => answer('decline') },
    ],
  });

  const chat = activeChatsStore.getChatForExecutionSession(event.threadId);
  const approvalToasts = new Map(chat?.approvalToasts || []);
  approvalToasts.set(event.requestId, toastId);
  activeChatsStore.updateChat(event.threadId, { approvalToasts });
}

/**
 * #2344: the toast used to fire the answer and forget it, so a refused or
 * failed decision showed nothing while the inline card named it. The toast
 * card is gone once clicked (the container dismisses it), so this reports
 * the outcome in its own notice, and a decision that did not land offers the
 * request again: it is still open and still waiting on the user, exactly as
 * the inline card re-enables its buttons.
 */
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

async function answerFromToast(
  apiBase: string,
  event: Extract<OrchestrationEvent, { method: 'request.opened' }>,
  view: ApprovalToastView,
  decision: 'accept' | 'acceptForSession' | 'decline',
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
    // Not delivered: the request waits on the user again.
    setAnswered(event.threadId, event.requestId, false);
    toastStore.show(
      `Your decision on ${view.toolName} was not delivered: ${reason}`,
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
  const chat = activeChatsStore.getChatForExecutionSession(event.threadId);
  if (!chat) return;

  const pendingApprovals = (chat.pendingApprovals || []).filter(
    (id) => id !== event.requestId,
  );
  const approvalToasts = new Map(chat.approvalToasts || []);
  const toastId = approvalToasts.get(event.requestId);
  if (toastId) {
    toastStore.dismiss(toastId);
  }
  approvalToasts.delete(event.requestId);
  activeChatsStore.updateChat(event.threadId, {
    pendingApprovals,
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

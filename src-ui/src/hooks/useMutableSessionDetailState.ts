import {
  foldedSessionLifecycleState,
  isSessionLifecycleStateStopped,
  isSessionLifecycleStateTerminal,
} from '@kontourai/station-contracts/session-lifecycle';
import type {
  AttentionItem,
  OrchestrationSessionSummary,
} from '@kontourai/station-sdk';
import {
  interruptOrchestrationTurn,
  resolveOrchestrationRequest,
  sendOrchestrationTurn,
  useAttentionQuery,
  useSessionBuilderRunQuery,
  useSessionFlowRunQuery,
  useWorkflowTasksQuery,
} from '@kontourai/station-sdk';
import { useMutation } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useToast } from '../contexts/ToastContext';
import { copyToClipboard } from '../lib/clipboard';
import { sessionAnswerabilityView } from '../utils/answerability';
import { isApprovalLivePending } from '../utils/attention';
import {
  buildDiagnosticsLog,
  type DiagnosticsEntry,
} from '../utils/sessionDiagnosticsLog';
import {
  displayEnvironment,
  isStreamingSession,
  sessionProjectLabel,
  sessionTitle,
} from '../utils/sessionDisplay';
import { isFailedSession, sessionFailureText } from '../utils/sessionFailure';
import type { OrchestrationEvent } from './orchestration/types';

/** Flow-agents sidecar statuses excluded from the "Project workflows"
 * fallback list — these are already closed out, so surfacing them next to a
 * live session invites confusion about what's actually in flight. */
const TERMINAL_WORKFLOW_STATUSES = new Set([
  'delivered',
  'accepted',
  'archived',
]);

/** Cap the project-level workflow list; the rest collapse into "+N more". */
const MAX_PROJECT_WORKFLOW_ENTRIES = 5;

function truncateOneLine(text: string, max = 96): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max
    ? `${oneLine.slice(0, max - 1).trimEnd()}…`
    : oneLine;
}

/** The opening user turn's own text, if the live feed has caught it yet. */
function firstUserPrompt(events: OrchestrationEvent[]): string | undefined {
  for (const event of events) {
    if (event.method === 'turn.started' && event.prompt?.trim()) {
      return event.prompt.trim();
    }
  }
  return undefined;
}

/**
 * archive#1170: the session detail header's title. A raw thread id ("claude
 * code:1785191319504") answers none of "what was this task" — prefer the
 * task's own words. The first user turn's prompt is the most concrete
 * answer when the live feed has it; a delegated task's own id is next-best
 * (still human-authored, unlike the thread id); the thread id stays visible
 * separately either way (kept small/secondary, never removed — archive#1170
 * asks to demote it, not delete it).
 *
 * archive#3227 (a live recurrence of archive#3139): the last two branches
 * used to be written out here rather than delegated, and the final one
 * returned `humanizeId(session.threadId) || session.threadId` — `humanizeId`
 * only strips a leading `task[:-]?` and swaps `[-_]` for spaces, so on a
 * content-derived hex digest it is a NO-OP and the header rendered
 * `external:claude:5dfa9c…` verbatim. It also never read `displayTitle`,
 * which the server derives from the first user turn and which the list row
 * this header was opened from was already showing, so clicking a named row
 * landed on a header showing a raw thread id. `sessionTitle` is the canonical
 * precedence and guarantees no branch returns one.
 *
 * The live feed's own first prompt still wins over it: it is the most
 * concrete answer to "what was this task", and it is available here (the
 * event stream) in a way no shared helper over a summary can be. Exported for
 * direct coverage, for the same reason `metadataRows` below is — reaching it
 * through the hook would need the whole react-query/toast provider stack to
 * assert one string.
 */
export function mutableSessionTitle(
  session: OrchestrationSessionSummary,
  events: OrchestrationEvent[],
): string {
  const prompt = firstUserPrompt(events);
  if (prompt) return truncateOneLine(prompt);
  return sessionTitle(session);
}

/**
 * Every concrete AttentionItem that put this session on the needs-attention
 * list, if any are still there (archive#1170: the list already knows
 * "why"; this page used to discard it entirely).
 *
 * a single `.find` only ever surfaced the first-sorted
 * item, but the server explicitly supports more than one item coexisting
 * for the same session — a lifecycle item (needs_input/review_pending)
 * plus one or more Flow-gate items, which "never shadow anything else"
 * (attention-projection.ts's `projectGateItems` comment). Returning every
 * match and rendering each keeps a genuinely-gated session from silently
 * losing its gate reason to whichever item happened to sort first.
 */
function matchingAttentionItems(
  items: AttentionItem[] | undefined,
  threadId: string,
): AttentionItem[] {
  return items?.filter((item) => item.sessionId === threadId) ?? [];
}

/** archive#1170: no 'Status' row here — the header's own single status badge is
 * now the one place this session's state is shown; a second copy in this
 * context list was pure redundancy (never contradictory, since both read
 * the same field, but it's exactly the kind of noise "one truthful status"
 * asks to cut). */
/**
 * Exported for direct coverage: the rows are a pure projection of the
 * session, and reaching them through the hook would need the whole
 * react-query/toast provider stack to assert one string. archive#1462/archive#1463
 * the Project row is the reason, since it is the row that used to
 * contradict the list heading.
 */
export function metadataRows(session: OrchestrationSessionSummary) {
  return [
    {
      label: 'Environment',
      value:
        session.delegation?.environmentName ??
        displayEnvironment(session.delegation?.environmentId),
    },
    {
      label: 'Worker',
      value: session.delegation?.targetId ?? session.assignedAgentSlug ?? null,
    },
    { label: 'Connection', value: session.delegation?.connectionId ?? null },
    { label: 'Parent', value: session.delegation?.parentTaskId ?? null },
    // Continuation provenance. A session adopted from a read-only-attached
    // transcript is a NEW Station session that continues from an imported
    // transcript — not the external session itself. The server stamps
    // `continuationSourceThreadId` at adoption (`buildAdoptedChild`;
    // archive#1165 made it a server-owned fact a client cannot forge), and
    // until this row the field reached the summary contract but rendered
    // nowhere, so an adopted session presented as an ordinary Station
    // session with its origin silently dropped. Raw source id on purpose,
    // following the 'Parent' row's precedent: an identifier actually
    // observed on the session beats an invented label, and the source's
    // own detail page shows the same id under Details.
    {
      label: 'Continued from',
      value: session.continuationSourceThreadId ?? null,
    },
    // archive#1462/archive#1463: the SAME helper the sessions list heading
    // uses. Reading the raw slugs here made the detail panel contradict the
    // list it was opened from — the list said "station (unverified name
    // match)" and this row, one click later, said "station"; an ambiguous
    // attached session had no slug at all, so the row silently disappeared
    // rather than naming the candidates. A caveat a surface will withdraw on
    // the next screen is worse than no caveat.
    { label: 'Project', value: sessionProjectLabel(session) },
    // Model is deliberately NOT here: `SessionDetailHeader`'s meta line
    // already names it, and repeating it as a card put the same token twice
    // on one screen. The rows above are delegation-specific and appear
    // nowhere else on this page.
  ].filter(
    (row): row is { label: string; value: string } =>
      typeof row.value === 'string' && row.value.trim().length > 0,
  );
}

type OpenRequest = Extract<OrchestrationEvent, { method: 'request.opened' }>;

/** Track the latest still-open request from the live feed (opened, not resolved). */
function latestOpenRequest(events: OrchestrationEvent[]): OpenRequest | null {
  const open = new Map<string, OpenRequest>();
  for (const event of events) {
    if (event.method === 'request.opened') open.set(event.requestId, event);
    else if (event.method === 'request.resolved') open.delete(event.requestId);
  }
  return Array.from(open.values()).at(-1) ?? null;
}

/**
 * True only when `item` is a genuine duplicate of the session's own live
 * in-turn `pendingRequest` — i.e. rendering both would offer the identical
 * action twice. (archive#1170): the previous check
 * suppressed `needs_input`/`review_pending` whenever ANY request was
 * pending, with no correlation to WHICH request — a `review_pending` item
 * plus an unrelated `permission` request silently discarded the review
 * reason and left no equivalent action on screen. `review_pending` can
 * never be a genuine duplicate: `ReviewAction` renders a bare "Open
 * session" link, never a request-resolution form, so it is not equivalent
 * to resolving `pendingRequest` regardless of correlation. Only
 * `needs_input` can, and only when the item's own `requestType`
 * (server-projected from the SAME open-request evidence this page's own
 * `latestOpenRequest` reads — archive#1188) matches the live request's
 * type. An item with no resolvable `requestType` is the honest fallback
 * case (`fallbackLifecyclePresentation` server-side) and carries no proof
 * it's the same request, so it is never suppressed either — when in doubt,
 * show both; a redundant card is far cheaper than silently discarding the
 * one reason this page exists to surface.
 */
function isDuplicateOfPendingRequest(
  item: AttentionItem,
  pendingRequest: OpenRequest | null,
): boolean {
  if (!pendingRequest || item.kind !== 'needs_input') return false;
  return item.requestType === pendingRequest.requestType;
}

function requestPresentation(request: OpenRequest): {
  label: string;
  accept: string;
  decline: string;
} {
  switch (request.requestType) {
    case 'permission':
      return {
        label: 'Permission requested',
        accept: 'Approve',
        decline: 'Decline',
      };
    case 'confirmation':
      return {
        label: 'Confirmation needed',
        accept: 'Confirm',
        decline: 'Cancel',
      };
    case 'input':
      return {
        label: 'Input requested',
        accept: 'Continue',
        decline: 'Cancel',
      };
    default:
      return {
        label: 'Approval requested',
        accept: 'Approve',
        decline: 'Decline',
      };
  }
}

/**
 * All query/mutation wiring and derived state for `MutableSessionDetail`
 * (archive#1204) — the render tree lives in the component; this hook owns
 * every piece of state, derivation, and side effect it renders from.
 */
export function useMutableSessionDetailState({
  apiBase,
  session,
  onTaskChanged,
  events,
  visualViewport,
}: {
  apiBase: string;
  session: OrchestrationSessionSummary;
  onTaskChanged: () => void;
  events: OrchestrationEvent[];
  visualViewport: { height: number };
}) {
  const threadId = session.threadId;
  const [input, setInput] = useState('');
  const isDelegated = Boolean(session.delegation);
  const { showToast } = useToast();

  const sendTurn = useMutation({
    mutationFn: () => sendOrchestrationTurn({ threadId, text: input, apiBase }),
    onSuccess: () => setInput(''),
  });
  const respond = useMutation({
    mutationFn: (decision: 'accept' | 'decline') => {
      const request = latestOpenRequest(events);
      if (!request) return Promise.resolve();
      return resolveOrchestrationRequest({
        threadId,
        requestId: request.requestId,
        decision,
        apiBase,
      });
    },
  });
  const stopTask = useMutation({
    mutationFn: () => interruptOrchestrationTurn({ threadId, apiBase }),
    onSuccess: onTaskChanged,
  });

  const pendingRequest = latestOpenRequest(events);
  const pendingRequestPresentation = pendingRequest
    ? requestPresentation(pendingRequest)
    : null;
  const isStreaming = isStreamingSession(session);
  // archive#3244: this used to be a hand-written `['completed', 'failed',
  // 'canceled']` — a third copy of exactly the drift archive#1548 deleted
  // server-side. The two gates it fed want DIFFERENT canonical predicates
  // (the `open-requests.ts` predicate-choice discipline):
  //
  // - `isTerminal` = `{completed}`, derived from the transitions map. It
  //   gates the composer (`hideGenericCompose`): the server's only send-path
  //   terminal gate rejects `foldedSessionLifecycleState(...) === 'completed'`
  //   alone (`orchestration-service.ts`, `sendTurn`), and the map declares
  //   `failed -> queued | running` and `canceled -> queued` — both retryable.
  //   Hiding the composer on a failed session contradicted the chat dock,
  //   which keeps its composer enabled beside the same session's failure
  //   banner ("You can send a message to try to continue this session").
  // - `isStopped` = `{completed, failed, canceled}` — the session records a
  //   run outcome and is not doing work. It gates the surfaces archive#1170
  //   deliberately removed from finished sessions (the header's live
  //   indicator / Stop task, the live in-turn Approve/Decline card): a
  //   failed session must not read "failed AND live AND Stop task", and
  //   that judgement is about "stopped", not "terminal".
  const foldedLifecycleState = foldedSessionLifecycleState(
    session.lifecycleState,
  );
  const isTerminal = isSessionLifecycleStateTerminal(foldedLifecycleState);
  const isStopped = isSessionLifecycleStateStopped(foldedLifecycleState);
  const isFailed = isFailedSession(session);
  const rows = metadataRows(session);
  const viewportIsCompact =
    visualViewport.height > 0 && visualViewport.height <= 620;
  const title = mutableSessionTitle(session, events);
  const diagnosticsLog: DiagnosticsEntry[] = useMemo(
    () => buildDiagnosticsLog(events),
    [events],
  );

  const attentionQuery = useAttentionQuery(apiBase);
  // The list's own "why" for this session — every item still on the list,
  // not just the first-sorted one (a lifecycle item and one or more
  // Flow-gate items can legitimately coexist, review). A live
  // in-turn request (`pendingRequest`, derived from this session's own SSE
  // feed) is the more real-time, authoritative signal for needs_input, so a
  // `needs_input` item that correlates to that SAME request (see
  // `isDuplicateOfPendingRequest`) is suppressed to avoid rendering its
  // action twice. Approval, `review_pending`, and gate-* items have no
  // equivalent affordance elsewhere on this page, so they always render.
  const visibleAttentionItems = matchingAttentionItems(
    attentionQuery.data?.items,
    threadId,
  ).filter((item) => !isDuplicateOfPendingRequest(item, pendingRequest));
  // needs_input's own action is `sendOrchestrationTurn` with free text —
  // identical to the compose box below. Showing both is exactly the
  // "generic free-text box whose relevance depends on state" archive#1170 asks to
  // replace with the matching inline action; a terminal (`completed`)
  // session can't receive more input at all — the server's send gate
  // rejects it. A failed or canceled session CAN (archive#3244): the
  // transitions map declares both retryable, so the composer stays, next to
  // the failure alert `SessionDetailErrors` already renders.
  // (archive#1170): `attentionQuery.data?.items` defaults to
  // `[]` for BOTH "still loading" and "fetch failed" (`matchingAttentionItems`
  // above), so a genuine fetch failure previously made a session that DOES
  // need attention look identical to one that doesn't — no error, no retry.
  // Distinguishing the two here, rather than absorbing the failure into a
  // silent empty list, is what "reliably show why" actually requires.
  const attentionCheckFailed = attentionQuery.isError;
  const attentionErrorMessage =
    attentionQuery.error instanceof Error
      ? attentionQuery.error.message
      : 'The attention check failed to load — this session may still need a response.';
  // A `needs_input` session's own generic compose box must never flash
  // visible before the attention query resolves and `hideGenericCompose`
  // flips it back off — `session.lifecycleState` is available synchronously
  // (no query needed) and is the same signal the server itself gates the
  // `needs_input` item's existence on, so it is trustworthy evidence that an
  // item is very likely coming once the query settles.
  // A LIVE `approval` item carries its own Approve/Deny buttons, so leaving
  // the generic compose box below it offered two competing ways to answer one
  // decision — and the free-text one does not resolve the request at all, it
  // just sends a turn. Same reasoning as `needs_input` above: when the card
  // owns the response affordance, the page must not offer a second one.
  //
  // `isApprovalLivePending` is the required predicate, not a bare
  // `kind === 'approval'` (review of archive#1249, probe-confirmed). An
  // approval item with no `actions` renders ONLY a Dismiss button —
  // `ApprovalActions` gates Approve/Deny on that same helper — and such an
  // item is externally reachable: `POST /api/notifications` accepts
  // `category: 'approval-request'` with no actions and an arbitrary
  // `metadata.sessionId`, and `isApprovalLive` only filters registry-kind
  // approvals. Suppressing on `kind` alone therefore left a live session
  // showing a lone Dismiss button and no way to reply at all.
  //
  // archive#1781: every one of those suppressions rests on "the card
  // below owns the response affordance." When the serving Station reports
  // this session as unanswerable, that card's Approve/Deny is disabled and
  // owns nothing — suppressing the composer as well would leave the page
  // with no way to act at all, on a session whose request may become
  // answerable again on the next poll. Read off the summary's decoration,
  // never recomputed here (ADR 0012: the predicate is process-local).
  const answerability = sessionAnswerabilityView(session);
  /** `null` unless the serving Station observed this session unanswerable. */
  const sessionUnanswerableNotice =
    answerability.status === 'unanswerable' ? answerability.notice : null;
  const sessionUnanswerable = sessionUnanswerableNotice !== null;
  const hideGenericCompose =
    isTerminal ||
    (!sessionUnanswerable &&
      (visibleAttentionItems.some(
        (item) =>
          item.kind === 'needs_input' ||
          (item.kind === 'approval' && isApprovalLivePending(item)),
      ) ||
        (attentionQuery.isLoading &&
          session.lifecycleState === 'needs_input')));
  // archive#3203: the same sentence the `session-failed` notification uses for
  // an unrecorded cause, imported rather than respelled — the notification and
  // the session it opens must describe one absence one way. archive#3213
  // extracted the whole fold to `utils/sessionFailure` so the chat dock reads
  // this session's failure from the same derivation rather than a second one.
  const failureText = sessionFailureText(session, events);

  const copySessionId = () => {
    // A rejection handler cannot see the insecure-origin case: with no
    // `navigator.clipboard`, the member access threw synchronously and neither
    // toast was ever reached (archive#3347, the class of archive#3341).
    void copyToClipboard(threadId).then((copied) => {
      showToast(copied ? 'Session ID copied' : 'Could not copy the session ID');
    });
  };

  const canSend =
    input.trim().length > 0 && !isStreaming && !sendTurn.isPending;

  // archive#189 supersedes the older "archive#582: sessions carry no join key"
  // note that stood here. Sessions CAN now be joined to a flow-agents task —
  // through `metadata.taskSlug` when Station started the session, and
  // otherwise through an exact match on the sidecar's
  // `run_correlation.identities.runtime_session` — and `builderRun` below is
  // that join. What has not changed is the archive#582 discipline it is built on: the
  // join is exact or it is nothing, and an unjoinable session renders
  // `unavailable` rather than a plausible-looking guess.
  //
  // "Project workflows" remains what it always was and is NOT the join: an
  // explicit project-level fallback listing the workspace's non-terminal
  // sidecar tasks, unlinked to this session. It stays because the two answer
  // different questions — "which run is this session's?" vs "what else is
  // in flight here?".
  const workflowProjectSlug =
    session.delegation?.projectSlug ?? session.projectSlug;
  // Direct/provider chats have no Station task binding, so neither a
  // station-delivery Flow run nor a Builder sidecar can be attached to them.
  // Avoid two expected 404 probes every time a normal resumed conversation
  // opens; a task-bound session still performs both provenance lookups.
  const hasTaskBinding = Boolean(session.delegation?.taskId);
  const { data: workflowTasks = [] } =
    useWorkflowTasksQuery(workflowProjectSlug);
  const { data: linkedFlowRun } = useSessionFlowRunQuery(threadId, apiBase, {
    enabled: hasTaskBinding,
  });
  // Its own query, rendered as its own row. The auto-attached
  // `station-delivery` run above and this Builder run are different runs with
  // different lifecycles; merging them into one progress figure is the exact
  // misreading archive#189 exists to remove.
  const { data: builderRun } = useSessionBuilderRunQuery(threadId, apiBase, {
    enabled: hasTaskBinding,
  });
  const activeWorkflowTasks = workflowTasks.filter(
    (task) => !TERMINAL_WORKFLOW_STATUSES.has(task.status),
  );
  const workflowEntries = activeWorkflowTasks
    .slice(0, MAX_PROJECT_WORKFLOW_ENTRIES)
    .map((task) => ({
      taskSlug: task.taskSlug,
      status: task.status,
      phase: task.phase,
      currentStep: task.flowRun?.current_step,
      openGateIds: task.flowRun?.open_gate_ids,
    }));
  const workflowMoreCount = Math.max(
    0,
    activeWorkflowTasks.length - MAX_PROJECT_WORKFLOW_ENTRIES,
  );

  return {
    threadId,
    input,
    setInput,
    isDelegated,
    sendTurn,
    respond,
    stopTask,
    pendingRequest,
    pendingRequestPresentation,
    isStreaming,
    isStopped,
    isFailed,
    sessionUnanswerable,
    sessionUnanswerableNotice,
    rows,
    viewportIsCompact,
    title,
    diagnosticsLog,
    attentionCheckFailed,
    attentionErrorMessage,
    attentionRefetch: attentionQuery.refetch,
    visibleAttentionItems,
    hideGenericCompose,
    failureText,
    copySessionId,
    canSend,
    linkedFlowRun,
    builderRun,
    workflowEntries,
    workflowMoreCount,
  };
}

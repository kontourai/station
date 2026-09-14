import type { NotificationAction } from './notification.js';
import type { RequestAnswerability } from './orchestration.js';
import type { RequestOpenedEvent } from './runtime-events.js';

/** The exact canonical open event behind one actionable approval/permission. */
export interface AttentionRequestReference {
  threadId: string;
  requestId: string;
  requestEventId: string;
}

export const ATTENTION_REQUEST_MAX_BYTES = 65_536;
export const ATTENTION_REQUEST_ID_MAX_CHARS = 1_024;

export type AttentionRequestInspection =
  | {
      state: 'open';
      reference: AttentionRequestReference;
      requestType: 'approval' | 'permission';
      provider: string;
      title: string;
      body?: string;
      openedAt: string;
      answerability: RequestAnswerability;
      canRespond: boolean;
    }
  | {
      state: 'changed' | 'resolved' | 'unavailable';
      reference: AttentionRequestReference;
      message: string;
    };

export interface AttentionItemBase {
  id: string;
  title: string;
  body?: string;
  createdAt: string;
  updatedAt: string;
  sessionId?: string;
  /**
   * Set when the user dismisses this current attention fact without deleting
   * any underlying activity. Presence means the user acknowledged THIS EXACT
   * `updatedAt` version, via
   * `AttentionProjectionService.acknowledge` (`conversation-acknowledgements.json`
   * store pattern, keyed by this item's own `id`). An acked item is dropped
   * from `AttentionProjection.pendingCount` but never removed from `items` —
   * acknowledgement is history, not deletion. A later re-derivation of the
   * same id with a NEWER `updatedAt` (a fresh failure) naturally reads as
   * unacknowledged again, because the stored version no longer matches.
   */
  acknowledgedAt?: string;
  /**
   * #2064 (D4): the project this item belongs to, when the projection could
   * derive one from the item's own source — a session's `projectSlug`, a
   * gate's run binding, a proposed change's `projectId`, a review session's
   * `projectSlug`. It is the ONLY input to the per-project counts
   * (`attentionProjectCounts`), so the sidebar's "1 needs you" and the
   * footer bell's total are two readings of one array rather than two
   * numbers that happen to agree.
   *
   * ABSENT means the projection could not derive a project, not that the
   * item is global: an `approval` notification created through the generic
   * `/notifications` API carries no project metadata at all, and a
   * project-less session has no project to name. Such an item counts toward
   * the bell and toward no project row. Nothing may fill this in on the
   * client — a consumer-side guess about which project an item belongs to is
   * exactly the label-nothing-derives shape this field exists to avoid.
   */
  projectSlug?: string;
}

/**
 * A `request.opened` event's `requestType` (station#1185) — the real signal
 * behind a `needs_input`/`review_pending` lifecycle flag, distinguishing "a
 * tool call is waiting" (`approval`/`permission`) from "the agent asked a
 * question" (`input`/`confirmation`). Re-exported here rather than
 * redeclared so the two vocabularies can never drift.
 */
export type AttentionRequestType = RequestOpenedEvent['requestType'];

/**
 * Unlike every other attention kind, an `approval` item is projected from a
 * plain `Notification` (see `AttentionProjectionService.projectApproval`),
 * which can be created through the generic `/notifications` API without any
 * session metadata attached. When the metadata does not resolve to a real
 * session/deep-link target, `openHref` is omitted rather than falling back
 * to a dead link — the UI renders no "Open session" action in that case.
 */
export interface ApprovalAttentionItem extends AttentionItemBase {
  kind: 'approval';
  requestReference?: AttentionRequestReference;
  source: { notificationId: string; notificationSource: string };
  actions: NotificationAction[];
  openHref?: string;
}

/**
 * `title`/`body` are projected from the thread's open `request.opened`
 * event when one is resolvable (station#1185) — `title` names the requestType
 * plus the request's own ask, `body` carries its description and a bounded,
 * secret-safe summary of the request's payload (never raw tool args).
 * `requestType` is OPTIONAL and omitted when a session has no resolvable open
 * request: a
 * session that is genuinely `needs_input`/`review_pending` with no
 * resolvable open request still gets an item (never regresses to nothing),
 * but with a truthful, minimal title/body that does not imply request
 * detail it doesn't have.
 *
 * station#3227 B1: this kind is the WAITING-ON-YOU kind, not a 1:1 echo of
 * `lifecycleState: 'needs_input'` — a `blocked` session projects it too
 * (title "Session blocked", body from the recorded `blockedReason` when the
 * session has no resolvable open request). The client fold
 * (`sessionAttentionDisposition`, `session-attention.ts`) files both states
 * under the same Needs-attention adjudication; a parallel session-blocked
 * kind would re-split what that shared fold deliberately joins, and the
 * existing `gate-blocked` kind is a Flow-gate verdict with a run/gate
 * source shape a session-level block does not have.
 */
export interface NeedsInputAttentionItem extends AttentionItemBase {
  kind: 'needs_input';
  /** Exact input question; never an approval/permission decision. */
  inputReference?: AttentionRequestReference;
  source: { threadId: string };
  openHref: string;
  requestType?: AttentionRequestType;
}

/** See `NeedsInputAttentionItem` — same request-evidence projection, review_pending kind. */
export interface ReviewPendingAttentionItem extends AttentionItemBase {
  kind: 'review_pending';
  requestReference?: AttentionRequestReference;
  source: { threadId: string };
  openHref: string;
  requestType?: AttentionRequestType;
}

/**
 * Common source for every Flow-gate-derived item: the session the gate's
 * run is bound to, the run itself, the gate, and the project workspace the
 * run lives in (the flow-console deep link needs all four).
 */
export interface GateAttentionSource {
  threadId: string;
  runId: string;
  gateId: string;
  projectSlug: string;
}

/**
 * A gate asked for rework at an earlier step (`@kontourai/flow`'s
 * `routeBackDecision` returned `status: 'route-back'`, including the
 * recovery-step-escalation case). Copy uses verdict vocabulary — "route
 * back" — never "approval": a gate evaluates evidence, it does not allow an
 * action (root CONTEXT.md ~624).
 */
export interface GateRouteBackAttentionItem extends AttentionItemBase {
  kind: 'gate-route-back';
  source: GateAttentionSource;
  openHref: string;
  routeBackTo?: string;
  attempt?: number;
  maxAttempts?: number;
}

/**
 * A gate is blocking the run (`status: 'block'`) with retry budget still
 * available — a routine in-progress block, not yet a pending human decision.
 */
export interface GateBlockedAttentionItem extends AttentionItemBase {
  kind: 'gate-blocked';
  source: GateAttentionSource;
  openHref: string;
}

/**
 * A gate's retry budget is exhausted (`status: 'block'` with
 * `limit_exceeded`, `on_exceeded: 'block'`) — a human exception decision is
 * genuinely pending. Distinct from `gate-blocked`: this is the point a
 * person, not another retry, has to move the run forward.
 */
export interface GateExceptionAttentionItem extends AttentionItemBase {
  kind: 'gate-exception';
  source: GateAttentionSource;
  openHref: string;
  limitExceeded: true;
}

/**
 * The session ended in `failed` — a runtime error, a crashed adapter, a
 * manual terminal transition. station#1548: this kind exists because
 * #1296's own test asserted, in a comment, that "the UI still shows
 * attention via `lifecycleState === 'failed'` itself", and **nothing
 * implemented it**. That unchecked premise is what made zeroing
 * `pendingReview` on a failed session read as safe, and the result was a
 * session that died mid-approval producing no attention item at all.
 *
 * It is projected from the lifecycle state alone, deliberately NOT from
 * `pendingReview`, so it stays true if the flag is ever zeroed upstream
 * again. A failed session that also carries an open request projects the
 * more specific `review_pending`/`needs_input` item instead — a concrete
 * request outranks the coarser lifecycle state, as everywhere else in this
 * projection.
 *
 * `body` carries the session's `blockedReason` (the last `runtime.error`
 * message) when one is recorded, and is simply absent otherwise rather than
 * implying a cause that was never captured.
 *
 * station#3203: `title` is the SESSION's own name, not a second copy of the
 * kind. It used to be the literal string `'Session failed'`, which the UI
 * already renders as the row's eyebrow via `attentionKindLabel`, so a failed
 * session announced itself with the same three words twice and three failures
 * from three different sessions were byte-identical rows. It is now the
 * session's `displayTitle`, falling back to `'Untitled session'` — never a
 * thread id (station#3139).
 */
export interface SessionFailedAttentionItem extends AttentionItemBase {
  kind: 'session-failed';
  source: { threadId: string };
  openHref: string;
  /**
   * station#3203 identity decoration, so three failed sessions are tellable
   * apart. Each field is present ONLY when the session summary recorded it;
   * absence is rendered as absence, never as a placeholder.
   *
   * `engine` is the raw `ProviderSession.provider` id, deliberately NOT a
   * display label: `engineDisplayLabel` (engine-capability-matrix.ts)
   * owns that table for every other surface, and re-deriving it server-side
   * is exactly the drift #3139 was. The UI labels it; a provider this build
   * does not know renders as its own id, which is what that helper's `null`
   * branch already asks callers to do.
   */
  engine?: string;
  /** Delegation target, else the assigned agent slug — whichever the session recorded. */
  agent?: string;
}

/**
 * A pending inbound device-pairing request (#765 D5) — another device asked
 * to pair with this Station and is waiting on an approve/deny decision, so it
 * belongs in the needs-attention bucket, not passive activity history.
 *
 * Projected straight from the pairing service's own pending-request list
 * (`DevicePairingService.listRequests`), never from the mirror notification:
 * the service is the source of truth for whether the request is still
 * decidable, so an approved/denied/expired request stops projecting on the
 * next read with no notification-poll lag.
 *
 * The item carries NO grant authority. Its Approve/Deny affordances call the
 * existing `/api/pairing/requests/:requestId/confirm` (POST) and
 * `/api/pairing/requests/:requestId` (DELETE) routes, where the HTTP
 * boundary's pairing-family authorization decides — operator credential,
 * an `access:approve`-promoted device, or the documented attested-local
 * floor for provably off-box requests (`DevicePairingService.confirmRequest`).
 */
export interface DevicePairingAttentionItem extends AttentionItemBase {
  kind: 'device-pairing';
  source: {
    /** The pairing request the approve/deny routes act on. */
    requestId: string;
    /**
     * The mirror `device-pairing` notification, when one is currently
     * active — lets inbox surfaces suppress the duplicate activity row
     * while this item is pending (same dedupe `approval` items get).
     */
    notificationId?: string;
  };
  /** The requesting device's display name, as recorded on the request. */
  deviceName: string;
  /**
   * Whether THE CALLER OF THIS READ could actually act on those approve/deny
   * routes — derived per response at the HTTP seam from the same two gates
   * the middleware applies to the request, in the same order: the pairing
   * family's authority boundary (`EnvironmentSecurityService.
   * credentialMayDecidePairingRequests`: operator credential or an
   * `access:approve`-promoted device) and then the scope table's tier for
   * the approval leaves (`requiredPairingScope`). The attested internal
   * principal bypasses both gates and is therefore also `true`.
   *
   * This field exists because the affordance and the authority live in
   * different tiers: a paired browser session can READ this item
   * (`orchestration:read`) while `access:approve` is operator-promotion-only
   * (in no preset, never in the default grant), so without a derivation the
   * UI renders Approve/Deny buttons that can only ever answer
   * `authentication_required` (#765 D5 live verification). `false` means the
   * surface must render the remedy — approve from a trusted Station session —
   * instead of dead buttons. Consumers that construct items outside the HTTP
   * seam must fail closed (`false`): no caller identity, no claim.
   */
  viewerCanDecide: boolean;
  openHref: string;
}

/**
 * Station's own Agent cannot run at all — the managed engine resolves no model
 * connection (#1536 D8).
 *
 * Notifications said "All caught up · Nothing needs you right now" on a fresh
 * home whose New Chat picker, one surface away, marked the Station row
 * "Needs: No enabled LLM provider connection is configured." Both were reading
 * real state; only one of them was reading THIS state, because nothing
 * projected it. `body` is that same sentence, from the same derivation
 * (`resolveManagedAvailabilityReason`) the picker's row renders — never a
 * second wording of the same requirement.
 *
 * It is a live PRECONDITION rather than an event: it stops projecting the
 * moment a connection resolves, so `createdAt`/`updatedAt` are the time the
 * projection observed it, and the surfaces do not offer to dismiss it —
 * acknowledging the only row that says why chat cannot start would leave the
 * inbox claiming nothing needs you while the same thing still does.
 */
export interface SetupIncompleteAttentionItem extends AttentionItemBase {
  kind: 'setup-incomplete';
  source: {
    /** What is missing. One member today; a discriminator, not a label. */
    requirement: 'model-connection';
    /** The Agent the requirement was evaluated for. */
    agentSlug: string;
  };
  openHref: string;
}

/**
 * #2064 (D4): an AI-proposed change is pending a human approve/reject
 * decision. It was reachable only from the global `/review-queue` page, which
 * neither the bell badge nor any project row could see; "what needs me" had
 * two disjoint answers.
 *
 * Projected from `ProposedChangeService.list({ status: ['pending'] })`, the
 * same read `/review-queue` performs, so a decision made anywhere stops
 * projecting on the very next read. The item carries NO decision authority:
 * its Approve/Reject affordances call the existing
 * `POST /api/proposed-changes/:id/approve|reject` routes — the same two the
 * Review page calls — and the change service's own transition rules decide.
 *
 * `path`, `contentKind` and `sourceRuntime` are the change's own recorded
 * fields, carried so a row can say WHICH file and WHERE it came from rather
 * than three identical "Change pending" lines.
 */
export interface ProposedChangeAttentionItem extends AttentionItemBase {
  kind: 'proposed-change';
  source: { proposedChangeId: string; projectSlug: string };
  /** The change's own `path`; the row's headline. */
  path: string;
  /** The change's recorded `contentKind` and `sourceRuntime`. */
  contentKind: string;
  sourceRuntime: string;
  openHref: string;
}

/**
 * #2064 (D4): a paused Survey/Flow gate review session with unresolved items
 * — a human has to read and decide before the run continues.
 *
 * Projected from the SAME `SurveyFlowReviewService` aggregate the Review page
 * reads, and ONLY when `summary.unresolved > 0`: a review session whose items
 * are all resolved is finished work, not an ask. That threshold is the whole
 * derivation — nothing in the store marks a session "needs attention", and a
 * stored flag would be a label the count could contradict.
 *
 * There is no decide-here affordance, deliberately. The Review page makes no
 * mutation for these sessions either (`ReviewQueueView` renders the session
 * and nothing more); the continuation endpoint
 * (`POST /api/projects/:slug/flow/runs/:runId/reviews/continue`) is driven
 * from the review workbench, not from an inbox row. The item's action is to
 * open the exact review.
 */
export interface GateReviewAttentionItem extends AttentionItemBase {
  kind: 'gate-review';
  source: {
    /** The exact review session the open action deep-links to. */
    reviewSessionRef: string;
    projectSlug: string;
    workflowSubjectRef: string;
  };
  /** Unresolved item count, read off the session's own summary. */
  unresolved: number;
  openHref: string;
}

export type AttentionItem =
  | ApprovalAttentionItem
  | SetupIncompleteAttentionItem
  | NeedsInputAttentionItem
  | ReviewPendingAttentionItem
  | SessionFailedAttentionItem
  | GateRouteBackAttentionItem
  | GateBlockedAttentionItem
  | GateExceptionAttentionItem
  | ProposedChangeAttentionItem
  | GateReviewAttentionItem
  | DevicePairingAttentionItem;

/**
 * Kinds that are STANDING notices rather than per-event facts (#1536 D8; delta
 * review DM3 moved this here from the server projection).
 *
 * A standing notice is continuously true until a configuration changes and has
 * no event of its own. Two consequences follow from that one property, on two
 * sides of the wire, and declaring it in the contract is what keeps them from
 * drifting:
 *
 *  - it sorts BELOW live per-event attention, because its observation time says
 *    only when the projection last looked. Ordering it by recency put "Station
 *    cannot run yet" above every live approval on every read — an artefact of
 *    the timestamp, not a priority anyone chose.
 *  - it cannot be acknowledged, because it is still true after the dismissal.
 *    The server refuses the acknowledgement and the surfaces offer no dismiss;
 *    without the refusal, "Dismiss all" acked it and the row only came back
 *    because the next read moved its `updatedAt`.
 */
export const STANDING_ATTENTION_KINDS: ReadonlySet<AttentionItem['kind']> =
  new Set<AttentionItem['kind']>(['setup-incomplete']);

/** See {@link STANDING_ATTENTION_KINDS}. */
export function isStandingAttentionKind(kind: AttentionItem['kind']): boolean {
  return STANDING_ATTENTION_KINDS.has(kind);
}

export interface AttentionProjection {
  items: AttentionItem[];
  pendingCount: number;
}

/**
 * The ONE predicate that decides what "pending" means, in the contract so the
 * server's `pendingCount`, the client's narrowed recount
 * (`pendingAttentionItems`) and the per-project counts below are three
 * readings of one declaration. An acknowledged item is history: still in
 * `items`, out of every count (see {@link AttentionItemBase.acknowledgedAt}).
 */
export function isPendingAttentionItem(item: AttentionItem): boolean {
  return !item.acknowledgedAt;
}

/**
 * #2064 (D4): how many pending items belong to one project.
 *
 * DERIVED, always, from the projection's own `items` — never a number a
 * producer wrote down. The bell's total and a project row's count are the
 * same array counted with the same predicate under two different scopes, so
 * they cannot disagree: a source item appearing or resolving moves both, and
 * a project whose items all resolve returns 0 because nothing is left to
 * count, not because anything cleared a field.
 *
 * Items with no `projectSlug` (a generic `/notifications` approval, a
 * project-less session) belong to no project and are counted by no row. They
 * still count toward the bell; the two numbers are deliberately not required
 * to sum, and {@link AttentionItemBase.projectSlug} says why.
 */
export function attentionCountForProject(
  items: readonly AttentionItem[],
  projectSlug: string,
): number {
  return items.filter(
    (item) => item.projectSlug === projectSlug && isPendingAttentionItem(item),
  ).length;
}

/** Every project with at least one pending item. See {@link attentionCountForProject}. */
export function attentionProjectCounts(
  items: readonly AttentionItem[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (!item.projectSlug || !isPendingAttentionItem(item)) continue;
    counts.set(item.projectSlug, (counts.get(item.projectSlug) ?? 0) + 1);
  }
  return counts;
}

export type AttentionInputReplyContext =
  | {
      state: 'open';
      reference: AttentionRequestReference;
      agentId: string;
      conversationId: string;
      provider: string;
      engineId: string;
      modelId?: string;
      capabilities: Array<'image-input' | 'file-input'>;
    }
  | { state: 'unavailable'; reference: AttentionRequestReference };

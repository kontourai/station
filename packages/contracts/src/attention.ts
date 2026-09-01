import type { NotificationAction } from './notification.js';
import type { RequestOpenedEvent } from './runtime-events.js';

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
  source: { threadId: string };
  openHref: string;
  requestType?: AttentionRequestType;
}

/** See `NeedsInputAttentionItem` — same request-evidence projection, review_pending kind. */
export interface ReviewPendingAttentionItem extends AttentionItemBase {
  kind: 'review_pending';
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

export type AttentionItem =
  | ApprovalAttentionItem
  | NeedsInputAttentionItem
  | ReviewPendingAttentionItem
  | SessionFailedAttentionItem
  | GateRouteBackAttentionItem
  | GateBlockedAttentionItem
  | GateExceptionAttentionItem
  | DevicePairingAttentionItem;

export interface AttentionProjection {
  items: AttentionItem[];
  pendingCount: number;
}

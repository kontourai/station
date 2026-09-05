import type { FlowConsoleGateProjection } from '@kontourai/flow';
import type {
  AttentionItem,
  AttentionProjection,
  DevicePairingAttentionItem,
  SessionFailedAttentionItem,
  SetupIncompleteAttentionItem,
} from '@kontourai/station-contracts/attention';
import type { DevicePairingRequest } from '@kontourai/station-contracts/environment-security';
import type { Notification } from '@kontourai/station-contracts/notification';
import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import type { RequestOpenedEvent } from '@kontourai/station-contracts/runtime-events';
import {
  type SessionAwaitingVia,
  sessionAttentionDisposition,
} from '@kontourai/station-contracts/session-attention';
import {
  foldedSessionLifecycleState,
  isSessionLifecycleStateStopped,
} from '@kontourai/station-contracts/session-lifecycle';
import { activityDeepLink } from '@kontourai/station-contracts/surface-deep-link';
import {
  isHostedSessionReadAuthority,
  type SessionReadAuthority,
  sessionReadAuthorityFromRequest,
} from '@kontourai/station-contracts/tenancy';
import {
  attentionGateScanDuration,
  attentionProjectionLoads,
  attentionProjectionResults,
  attentionRequestEvidenceScanDuration,
} from '../../telemetry/metrics.js';
import type { ApprovalRegistry } from '../approvals/approval-registry.js';
import type {
  FlowRunService,
  FlowRunStatus,
} from '../flow/flow-run-service.js';
import { resolveNotificationOpenHref } from '../notifications/notification-deep-link.js';
import type { NotificationService } from '../notifications/notification-service.js';
import type { ConversationAcknowledgementStore } from '../orchestration/conversation-acknowledgement-store.js';
import { collectOpenRequests } from '../orchestration/open-requests.js';
import type { OrchestrationService } from '../orchestration/orchestration-service.js';
import { DEVICE_PAIRING_NOTIFICATION_SOURCE } from '../ssh/device-pairing-notifications.js';

const ACTIVE_NOTIFICATION_STATUSES = ['delivered', 'pending'];

/** Bound the cost of readSessionFlowRun (it replays session events) across reads. */
const FLOW_RUN_CACHE_TTL_MS = 5_000;

type FlowRunBinding = {
  runId: string;
  definitionId: string;
  cwd: string;
  run: FlowRunStatus;
} | null;

/**
 * Read-only projection over the existing notification, orchestration, and
 * Flow run/console stores. A concrete request takes precedence over its
 * coarser lifecycle state; mutation remains with the source service —
 * gate items resolve through Flow's own `/api/projects/:slug/flow/runs`
 * evaluate/exception routes, never through this projection.
 */
export class AttentionProjectionService {
  private readonly flowRunCache = new Map<
    string,
    { binding: FlowRunBinding; expiresAt: number }
  >();

  /**
   * Bound the cost of resolving the thread's currently-open `request.opened`
   * events (archive#1185) — `readSession` replays session events, same
   * rationale as `flowRunCache` above. Caches every still-open request on
   * the thread (keyed by `requestId`), not just the latest one, because both
   * `projectLifecycle` (wants the latest) and `projectApproval` (wants one
   * specific request, matched by id — archive#1185 fix round, Ask #4
   * convergence) read from the same underlying event replay.
   */
  private readonly openRequestsCache = new Map<
    string,
    { requests: Map<string, RequestOpenedEvent>; expiresAt: number }
  >();

  constructor(
    private readonly notificationService: Pick<NotificationService, 'list'>,
    private readonly orchestrationService: Pick<
      OrchestrationService,
      'listSessionReadModel' | 'readSessionFlowRun' | 'readSession'
    >,
    private readonly flowRunService: Pick<FlowRunService, 'getRunConsole'>,
    /**
     * Registry-backed approval liveness oracle. Optional so every existing
     * caller/test that predates orphan expiry keeps compiling; when absent,
     * registry-kind approvals are treated as live (unchanged behavior).
     */
    private readonly approvalRegistry?: Pick<
      ApprovalRegistry,
      'has' | 'canRead'
    >,
    /**
     * archive#1914: durable per-item acknowledgement for a `kind` that is
     * derived on every read and therefore has no stored record a
     * `DELETE /notifications/:id` could ever reach — see
     * `SessionFailedAttentionItem`'s doc for why `session-failed` needs this
     * and `provider_absent`-style terminality suppression cannot fully
     * replace it (a live, unhopeless failure the user has already SEEN still
     * needs a way to stop counting). Reuses
     * `FileConversationAcknowledgementStore` (`conversation-acknowledgements.json`)
     * rather than a new store — the shape (user id -> item id -> the
     * version acknowledged) is exactly what that store already persists for
     * the conversation inventory. Optional so every existing caller/test
     * that predates this field keeps compiling with acknowledgement simply
     * unavailable (every item counts, same as today).
     */
    private readonly acknowledgementStore?: Pick<
      ConversationAcknowledgementStore,
      'get' | 'acknowledge'
    >,
    /**
     * Identity the acknowledgement store scopes by. Defaults to a single
     * fixed id: Station is currently a single-operator local app with no
     * per-request caller identity reaching this service (unlike the HTTP
     * route layer, which resolves `getCachedUser().alias` for the
     * conversation-acknowledgement route this reuses). A caller that does
     * have a real per-user identity may inject one.
     */
    private readonly getUserId: () => string = () => 'default',
    /**
     * #765 D5: pending inbound device-pairing requests, resolved per read
     * for the same reason `DevicePairingNotificationProvider` resolves its
     * source per poll — the pairing service is created when the environment
     * initialises, and its accessor throws before then. Optional so every
     * existing caller/test keeps compiling with pairing attention simply
     * unavailable.
     */
    private readonly resolvePairingRequests?: () => {
      listRequests(): DevicePairingRequest[];
    } | null,
    /**
     * #1536 D8: whether Station's own Agent can run right now, and why not.
     *
     * Deliberately injected rather than derived here: the answer is
     * `resolveManagedAvailabilityReason` over the LIVE app config and provider
     * connections — the same call the New Chat picker's Station row and the
     * chat route's 409 already make — and a projection that re-derived it from
     * its own read of the connections would be a second rule with a delay on
     * it. The caller hands back `null` when the Agent resolves, or the
     * requirement's own sentence when it does not. Optional so every existing
     * caller/test keeps compiling with setup attention simply unavailable.
     */
    private readonly readStationSetupRequirement?: () => Promise<{
      agentSlug: string;
      /** The Agent's own display name, so the row is not a slug (#3139). */
      agentName: string;
      reason: string;
    } | null>,
  ) {}

  /**
   * Compatibility only for internal/non-HTTP consumers. Public routes pass
   * request authority explicitly; a hosted orchestration service rejects this
   * personal fallback, rather than treating an omitted request context as a
   * tenant grant.
   */
  private defaultReadAuthority(): SessionReadAuthority {
    return sessionReadAuthorityFromRequest(
      this.getUserId(),
      undefined,
      undefined,
    );
  }

  async list(
    authority?: SessionReadAuthority,
    viewer?: {
      /**
       * #765 D5: whether the caller this read is answering could act on the
       * pairing approve/deny routes — computed at the HTTP seam (the only
       * layer that can see the request principal) from the boundary's own
       * predicate, `EnvironmentSecurityService.credentialMayDecidePairingRequests`.
       * Absent means unknown caller, which fails closed: a projection built
       * with no caller identity must not claim decidability for whoever
       * eventually reads it.
       */
      mayDecidePairingRequests?: boolean;
    },
  ): Promise<AttentionProjection> {
    const readAuthority = authority ?? this.defaultReadAuthority();
    attentionProjectionLoads.add(1);
    // Fetched once up front (archive#1284) so the past-resuming filter below
    // can check an orchestration-kind approval notification's backing
    // session without a second listSessionReadModel() round-trip.
    const sessions =
      await this.orchestrationService.listSessionReadModel(readAuthority);
    const sessionsById = new Map(
      sessions.map((session) => [session.threadId, session]),
    );

    const activeNotifications = (
      await this.notificationService.list({
        status: ACTIVE_NOTIFICATION_STATUSES,
      })
    ).filter((notification) =>
      ACTIVE_NOTIFICATION_STATUSES.includes(notification.status),
    );
    const approvalNotifications = activeNotifications
      .filter(isApprovalNotification)
      // A notification with a session reference is session-derived content,
      // not a tenant-neutral inbox item. In hosted mode a missing row after
      // the central read predicate is deliberately treated as unavailable;
      // otherwise a bravo notification would survive simply because its
      // session was filtered before this projection built its lookup map.
      .filter((notification) => {
        if (readAuthority.mode !== 'hosted') return true;
        const metadata = notification.metadata ?? {};
        const sessionId =
          stringValue(metadata.sessionId) ??
          stringValue(metadata.conversationId) ??
          stringValue(metadata.threadId);
        // Approval and notification rows without a session are never generic
        // inbox data in hosted mode. Registry approvals additionally require
        // their private registry binding to authorize this exact request.
        if (!sessionId || !sessionsById.has(sessionId)) return false;
        if (stringValue(metadata.requestKind) !== 'registry') return true;
        const approvalId = stringValue(metadata.approvalId);
        return (
          !!approvalId &&
          this.approvalRegistry?.canRead(approvalId, readAuthority) === true
        );
      })
      .filter((notification) => this.isApprovalLive(notification))
      .filter(
        (notification) =>
          !this.isNotificationSessionUnanswerable(notification, sessionsById),
      );
    const approvals = await Promise.all(
      approvalNotifications.map((notification) =>
        this.projectApproval(notification, readAuthority),
      ),
    );
    const approvalSessions = new Set(
      approvals.flatMap((item) => (item.sessionId ? [item.sessionId] : [])),
    );

    const gateItems = await this.projectGateItems(sessions, readAuthority);
    // A pending exception decision is a stronger, more specific signal than
    // the coarser review_pending/needs_input lifecycle shadow the same
    // session can also carry (a gated session pending an exception often
    // reads as review_pending at the lifecycle layer) — suppress the
    // lifecycle duplicate the same way an open approval already does.
    // gate-route-back and gate-blocked never shadow anything else; they
    // always surface independently.
    const exceptionSessions = new Set(
      gateItems
        .filter((item) => item.kind === 'gate-exception')
        .flatMap((item) => (item.sessionId ? [item.sessionId] : [])),
    );
    const suppressedSessions = new Set([
      ...approvalSessions,
      ...exceptionSessions,
    ]);

    const lifecycleCandidates = sessions.filter(
      (session) => !suppressedSessions.has(session.threadId),
    );
    const lifecycle = (
      await Promise.all(
        lifecycleCandidates.map((session) =>
          this.projectLifecycle(session, readAuthority),
        ),
      )
    ).filter((item): item is AttentionItem => item !== null);

    const pairingItems = this.projectDevicePairingItems(
      readAuthority,
      activeNotifications,
      viewer?.mayDecidePairingRequests ?? false,
    );

    const setupItems = await this.projectSetupRequirement(readAuthority);

    const undecorated = [
      ...approvals,
      ...lifecycle,
      ...gateItems,
      ...pairingItems,
      ...setupItems,
    ];
    const decorated = this.acknowledgementStore
      ? undecorated.map((item) =>
          this.decorateAcknowledgement(item, readAuthority.userId),
        )
      : undecorated;
    const items = decorated.sort(compareAttentionItems);
    // Acked items stay IN `items` (history, never deleted) but drop out of
    // the actionable count — the whole point of archive#1914's
    // acknowledge-not-dismiss design for a kind with nothing to delete.
    const pendingCount = items.filter((item) => !item.acknowledgedAt).length;
    attentionProjectionResults.record(items.length);
    return { items, pendingCount };
  }

  /**
   * An acknowledgement is an inbox-local dismissal: it removes one current
   * attention fact from the pending queue without deleting ordinary activity
   * or pretending to resolve the underlying approval, session, or gate.
   *
   * The stored ack is a VERSION (the `updatedAt` that was acknowledged), the
   * same durable-read-state design `conversation-acknowledgement-store.ts`
   * already uses: a later re-derivation of the same id with a NEWER
   * `updatedAt` — a fresh failure on the same thread — no longer matches the
   * stored version and reads as unacknowledged again, exactly as intended
   * ("a fresh failure is a real fact worth surfacing").
   */
  private decorateAcknowledgement(
    item: AttentionItem,
    userId: string,
  ): AttentionItem {
    const ackedVersion = this.acknowledgementStore?.get(userId, item.id);
    if (!ackedVersion || ackedVersion < item.updatedAt) return item;
    return { ...item, acknowledgedAt: ackedVersion };
  }

  /**
   * Persist an acknowledgement of the CURRENT version of attention item
   * `itemId` (archive#1914) — re-derives `list()` to find the item's own
   * `updatedAt` rather than trusting a client-supplied timestamp, so an ack
   * can never be minted for a version that was never actually projected.
   * Returns `false` when acknowledgement is unavailable (no store injected)
   * or the item does not currently exist (nothing to acknowledge — already
   * resolved, or never was `session-failed` in the first place).
   */
  async acknowledge(
    itemId: string,
    authority?: SessionReadAuthority,
  ): Promise<boolean> {
    if (!this.acknowledgementStore) return false;
    const readAuthority = authority ?? this.defaultReadAuthority();
    const { items } = await this.list(readAuthority);
    const item = items.find((candidate) => candidate.id === itemId);
    if (!item) return false;
    this.acknowledgementStore.acknowledge({
      userId: readAuthority.userId,
      conversationId: item.id,
      updatedAt: item.updatedAt,
    });
    return true;
  }

  /**
   * Flow gate outcomes, scanned only for Flow-bound sessions that have not
   * stopped (readSessionFlowRun replays session events, so the scan is
   * bounded and its bindings are cached for FLOW_RUN_CACHE_TTL_MS across
   * reads). "Stopped" is the contract-derived
   * `isSessionLifecycleStateStopped` — completed/failed/canceled, the states
   * whose only way out is a restart. archive#1548: this used to be a third
   * hand-written `TERMINAL_LIFECYCLE_STATES` copy in this file, with the
   * same membership but no relationship to the contract that defines it.
   */
  private async projectGateItems(
    sessions: OrchestrationSessionSummary[],
    authority: SessionReadAuthority,
  ): Promise<AttentionItem[]> {
    const scanStart = Date.now();
    try {
      const scannable = sessions.filter(
        (session) =>
          !isSessionLifecycleStateStopped(
            foldedSessionLifecycleState(session.lifecycleState),
          ),
      );
      const items: AttentionItem[] = [];
      for (const session of scannable) {
        const binding = await this.getCachedFlowRun(
          session.threadId,
          authority,
        );
        if (!binding || binding.run.openGates.length === 0) continue;
        const projectSlug =
          session.projectSlug ?? session.delegation?.projectSlug;
        // Flow only binds inside a project workspace; without a project
        // route there is nowhere for the flow-console deep link to land.
        if (!projectSlug) continue;

        let gates: FlowConsoleGateProjection[];
        try {
          gates = (
            await this.flowRunService.getRunConsole(binding.cwd, binding.runId)
          ).gates;
        } catch {
          continue;
        }

        const openGateIds = new Set(
          binding.run.openGates.map((gate) => gate.id),
        );
        for (const gate of gates) {
          if (!openGateIds.has(gate.id)) continue;
          if (gate.accepted_exception_id) continue;
          const item = projectGateOutcome(
            gate,
            session,
            binding.runId,
            projectSlug,
          );
          if (item) items.push(item);
        }
      }
      return items;
    } finally {
      attentionGateScanDuration.record(Date.now() - scanStart);
    }
  }

  private async getCachedFlowRun(
    threadId: string,
    authority: SessionReadAuthority,
  ): Promise<FlowRunBinding> {
    const cached = this.flowRunCache.get(threadId);
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.binding;
    const binding = await this.orchestrationService.readSessionFlowRun(
      threadId,
      authority,
    );
    this.flowRunCache.set(threadId, {
      binding,
      expiresAt: now + FLOW_RUN_CACHE_TTL_MS,
    });
    return binding;
  }

  /**
   * Every still-open `request.opened` event on the thread (no matching
   * `request.resolved`), keyed by `requestId`. Isolates the `readSession`
   * I/O behind a try/catch so one session's failure degrades to "no
   * resolvable open request" (the same honest-fallback shape a genuine
   * request-less session already gets) instead of rejecting the whole
   * batched `Promise.all` in `list()` and blanking every other item —
   * approvals and gate items included, not just this session's own item
   * (archive#1185 fix round, review finding).
   */
  private async getCachedOpenRequests(
    threadId: string,
    authority: SessionReadAuthority,
  ): Promise<Map<string, RequestOpenedEvent>> {
    const cached = this.openRequestsCache.get(threadId);
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.requests;
    const requests = await this.readOpenRequests(threadId, authority);
    this.openRequestsCache.set(threadId, {
      requests,
      expiresAt: now + FLOW_RUN_CACHE_TTL_MS,
    });
    return requests;
  }

  private async readOpenRequests(
    threadId: string,
    authority: SessionReadAuthority,
  ): Promise<Map<string, RequestOpenedEvent>> {
    try {
      const detail = await this.orchestrationService.readSession(
        threadId,
        authority,
      );
      // Every open request regardless of `requestType`: this projection
      // presents both `needs_input` and `review_pending` items, so it wants
      // the unfiltered set. The shared derivation buries no filter — see
      // `open-requests.ts`.
      return detail ? collectOpenRequests(detail.events) : new Map();
    } catch {
      return new Map();
    }
  }

  /**
   * The thread's latest still-open `request.opened` event, if any — the
   * evidence a needs_input/review_pending item should be projected from
   * instead of the coarser lifecycle flag (archive#1185). `null` when the
   * session has no resolvable open request (a genuine `needs_input`/
   * `review_pending` state can arise from other transitions, e.g.
   * `session.state-changed`, with no backing request at all — see
   * `fallbackLifecyclePresentation`).
   */
  private async getCachedOpenRequest(
    threadId: string,
    authority: SessionReadAuthority,
  ): Promise<RequestOpenedEvent | null> {
    const requests = await this.getCachedOpenRequests(threadId, authority);
    return latestOpenRequestFromMap(requests);
  }

  /**
   * A `needs_input`/`review_pending` lifecycle item, projected from the
   * session's open `request.opened` event when one is resolvable
   * (archive#1185) rather than the bare lifecycle flag — see module doc.
   * archive#3227 B1: a `blocked` session projects the same waiting-on-you
   * `needs_input` kind (with its `blockedReason` as the fallback body), and
   * a session the board closed (`status: 'closed'`) projects nothing —
   * both adjudications now come from the shared
   * `sessionAttentionDisposition` fold the client's canonical label uses.
   *
   * archive#1548: a `failed` session with no more specific request behind it
   * now projects a `session-failed` item. archive#1296's own test asserted in a
   * comment that this surfacing already existed ("the UI still shows
   * attention via `lifecycleState === 'failed'` itself"); it did not, and
   * that unchecked premise is what made zeroing `pendingReview` on a failed
   * session look safe. It is derived from the lifecycle state alone, never
   * from `pendingReview`, so it stays true if the flag is zeroed again.
   */
  private async projectLifecycle(
    session: OrchestrationSessionSummary,
    authority: SessionReadAuthority,
  ): Promise<AttentionItem | null> {
    // archive#1284 originally added a second terminal guard here, and after
    // the archive#1548 merge it was deliberately not re-applied: a HAND-WRITTEN
    // consumer-side terminality copy is the drift archive#1548's AC2 exists to
    // prevent (its copy had counted `failed` as terminal and zeroed a
    // genuinely outstanding approval). The `finished` short-circuit below is
    // NOT that copy's return (archive#3227 B1): it is the SHARED
    // `sessionAttentionDisposition` fold — the same derivation the client's
    // canonical fold already applied — whose ordering puts `failed` FIRST,
    // so the exact state archive#1548's hand copy got wrong cannot reach the
    // finished arm. What it adds over the producer-side zeroing is the
    // `status: 'closed'` case the producer cannot express: `status` is
    // transport state, independent of the event-fold, so a closed session
    // with a stale `needs_input`/`pendingReview` shadow used to keep
    // projecting an item here while every client surface filed it under
    // Recently finished.
    //
    // archive#1745/#1779, THE `provider_absent` ARM, and it is not a second
    // terminality decision: `needs_input` and `review_pending` are the two
    // kinds derived FROM AN OPEN REQUEST, and this READS the decoration the
    // summary already carries rather than asking a private service channel
    // for it. That is the whole point of ADR 0012 — the same fact reaches
    // every consumer on the wire, so this surface cannot be the only one
    // that knows. `session-failed` is deliberately NOT suppressed on account
    // of answerability — a failed session's failure is a recorded fact about
    // the SESSION, not a claim about an outstanding request, and the old
    // pass preserved it too (the resting-state guard existed for that case).
    //
    // archive#1914 ADDS ONE MORE GATE, in the SAME shape as the
    // `provider_absent` arm above (a condition inside this method's kind
    // selection, not a second terminality pass): a session whose engine BINDING is
    // `dead` (archive#1827/#1904 — the SDK/adapter gave a structured,
    // terminal answer about this exact `--resume`d binding) has nothing left
    // to act on either, for the same reason `provider_absent` sessions do
    // not project `needs_input`/`review_pending` — no retry, no config
    // change, no answer reaches it, only a fresh session. This is NOT the
    // same fact `answerable` already carries: `answerable` is about whether
    // an OPEN REQUEST can still be answered, and `session-failed` sessions
    // by definition carry no open request for this method to have reached
    // this arm at all. `status: 'dead'` is a distinct, session-level fact —
    // see `ProviderSession.status`'s doc for why it must stay distinct from
    // `status: 'error'` (a `dead` binding must never be conflated with a
    // recoverable one). A dead-binding failure is still visible everywhere
    // else the session itself is rendered; only the actionable attention
    // item stops being projected for it.
    //
    // A session-failed item that is NOT hopeless (binding still `error`, or
    // simply `idle`/`closed` short of dead) but that the user has already
    // SEEN and cannot usefully act on further is the other half of the
    // archive#1914 fix, and it is deliberately NOT a suppression: see
    // `decorateAcknowledgement` below, which drops an ACKNOWLEDGED item out
    // of `pendingCount` without ever un-projecting it here.
    //
    // NOT EXACTLY THE OLD PASS'S POPULATION, and the difference is stated
    // rather than glossed (delta review, M2). The boot pass short-circuited
    // on `openRequests.size === 0`, so a session with NO open request was
    // never touched. This suppresses a `needs_input`/`review_pending` item on
    // any unanswerable session, including one whose state came from a bare
    // `session.state-changed` with no backing request at all — the case
    // `getCachedOpenRequest`'s doc above names explicitly.
    //
    // The broader population is the right answer, not an accident: the item
    // this method builds offers "go answer this", and on a session past
    // resuming (or whose provider is absent) there is nothing to answer
    // whether the prompt came from a request event or a state change. It is
    // pinned by its own test rather than left to inference.
    //
    // THE ORIGINAL DELIBERATE `answerable`-KEYED SUPPRESSION IN THE SYSTEM,
    // now joined by the archive#1914 `status !== 'dead'` gate below — both
    // on the same principle: every other
    // consumer annotates; the bell badge is a count of ACTIONABLE items, and
    // it subtracts INTO the notification popover (which renders
    // notifications minus attention-projected), where the row is annotated
    // rather than lost. Making that popover render the reason is
    // archive#1780.
    //
    // archive#3227 B1: WHETHER this session needs the user is no longer
    // decided by a ternary private to this method. The ordered
    // failed → finished → awaiting → active adjudication is
    // `sessionAttentionDisposition` (`@kontourai/station-contracts/
    // session-attention`), the SAME fold the client's canonical
    // `orchestrationLifecycleLabel` renders lanes and badges from — before
    // the extraction the two had drifted three probe-confirmed ways (no
    // `blocked` arm here, so "Needs you" showed a session the bell did not
    // count; no `closed` short-circuit here, so the bell counted sessions
    // every client surface filed under Recently finished). What stays local
    // is exactly what the two consumers deliberately do differently — the
    // `answerable` suppression above, the `dead` gate, and the
    // request-outranks-failure exception below — each pinned by its own
    // test.
    const disposition = sessionAttentionDisposition(session);
    if (disposition.state === 'finished' || disposition.state === 'active') {
      return null;
    }
    const answerable = session.answerability.answerable;

    let via: SessionAwaitingVia;
    if (disposition.state === 'failed') {
      // archive#1548's request-outranks-failure exception, preserved: a
      // retryable failure with a still-open approval projects the more
      // specific `review_pending` item — the request is still genuinely
      // outstanding, and the item says what to DO where the client's label
      // says what HAPPENED (its fold reads the same shape 'Failed'; both are
      // documented in the shared fold's docblock).
      if (!(answerable && session.pendingReview)) {
        return session.status !== 'dead'
          ? buildSessionFailedItem(session)
          : null;
      }
      via = 'review_pending';
    } else {
      if (!answerable) return null;
      via = disposition.via;
    }

    // A `blocked` session projects the waiting-on-you kind (archive#3227
    // B1). `needs_input` rather than a new parallel kind: the vocabulary's
    // waiting kinds are derived from what the user must DO (answer a
    // request, decide a review), and a blocked session asks for exactly the
    // dock-composer intervention `needs_input` already routes to — while
    // `gate-blocked` is a Flow-gate verdict with a run/gate source shape
    // that does not exist here. See `NeedsInputAttentionItem`'s doc.
    const kind: 'needs_input' | 'review_pending' =
      via === 'blocked' ? 'needs_input' : via;

    const scanStart = Date.now();
    let openRequest: RequestOpenedEvent | null;
    try {
      openRequest = await this.getCachedOpenRequest(
        session.threadId,
        authority,
      );
    } finally {
      attentionRequestEvidenceScanDuration.record(Date.now() - scanStart);
    }
    const presentation = openRequest
      ? presentOpenRequest(openRequest)
      : fallbackLifecyclePresentation(via, session.blockedReason);

    return {
      id: `${kind}:${session.threadId}`,
      kind,
      title: presentation.title,
      ...(presentation.body ? { body: presentation.body } : {}),
      ...(openRequest ? { requestType: openRequest.requestType } : {}),
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      sessionId: session.threadId,
      openHref: sessionOpenHref(session),
      source: { threadId: session.threadId },
    };
  }

  /**
   * The live approval-request notification's own backing `request.opened`
   * event, when resolvable — converges the live-approval card's
   * presentation onto the same evidenced `presentOpenRequest` logic the
   * needs_input/review_pending lifecycle path uses, per issue archive#1185 Ask #4
   * ("the two paths should converge on one presentation") — archive#1185
   * fix round.
   *
   * Only `requestKind: 'orchestration'` notifications (built in
   * `approval-inbox.ts` from a live `request.opened` runtime event) have a
   * session/event stream behind them to resolve this from; registry-kind
   * approvals (`ApprovalRegistry`-backed, no orchestration session) have no
   * `request.opened` event to converge onto and keep the notification's own
   * title/body untouched.
   */
  private async resolveApprovalOpenRequest(
    notification: Notification,
    authority: SessionReadAuthority,
  ): Promise<RequestOpenedEvent | null> {
    const metadata = notification.metadata ?? {};
    if (stringValue(metadata.requestKind) !== 'orchestration') return null;
    const threadId = stringValue(metadata.threadId);
    const requestId = stringValue(metadata.requestId);
    if (!threadId || !requestId) return null;
    const requests = await this.getCachedOpenRequests(threadId, authority);
    return requests.get(requestId) ?? null;
  }

  /**
   * An `approval` item, projected from a plain `Notification` — the only
   * kind that predates a backing `request.opened` event and can still be
   * created through the generic `/notifications` API with no session
   * metadata attached at all. When a live orchestration request is
   * resolvable behind it, its title/body converge onto the same detailed,
   * evidence-based `presentOpenRequest` copy the lifecycle path uses
   * (archive#1185 fix round); otherwise this falls back to the
   * notification's own title/body exactly as before.
   */
  private async projectApproval(
    notification: Notification,
    authority: SessionReadAuthority,
  ): Promise<AttentionItem> {
    const metadata = notification.metadata ?? {};
    const sessionId =
      stringValue(metadata.sessionId) ?? stringValue(metadata.conversationId);
    const sessionKind = stringValue(metadata.sessionKind);
    const openHref = resolveNotificationOpenHref(
      metadata,
      sessionId,
      sessionKind,
    );

    const openRequest = await this.resolveApprovalOpenRequest(
      notification,
      authority,
    );
    const presentation = openRequest
      ? presentOpenRequest(openRequest)
      : {
          title: notification.title,
          ...(notification.body ? { body: notification.body } : {}),
        };

    return {
      id: `approval:${notification.id}`,
      kind: 'approval',
      title: presentation.title,
      ...(presentation.body ? { body: presentation.body } : {}),
      createdAt: notification.createdAt,
      updatedAt: notification.updatedAt,
      ...(sessionId ? { sessionId } : {}),
      ...(openHref ? { openHref } : {}),
      source: {
        notificationId: notification.id,
        notificationSource: notification.source,
      },
      actions: notification.actions ?? [],
    };
  }

  /**
   * #765 D5: a pending inbound pairing request "needs you" until it is
   * approved, denied, or expired — before this it surfaced only as a passive
   * activity notification with a Dismiss button while "Needs attention" read
   * "Nothing needs you right now".
   *
   * Derived from the pairing service's own request list, never the mirror
   * notification, so a resolution (CLI approve/deny included) is visible on
   * the very next read instead of waiting out the notification provider's
   * status-sync poll. The active notification, when present, is joined in as
   * `source.notificationId` so inbox surfaces can suppress the duplicate
   * activity row — the same dedupe `approval` items get via their
   * notification-backed source.
   *
   * Hosted mode projects nothing: device pairing is host-local surface, and
   * a tenant-scoped read has no standing to see (or decide) who may pair
   * with the host — the same posture the session-less-notification filter in
   * `list()` takes for hosted reads.
   */
  /**
   * #1536 D8: Station's own Agent cannot run — no model connection resolves
   * for it, so every chat that would use the managed engine refuses. The
   * inbox used to read "Nothing needs you right now" in exactly that state.
   *
   * The fact is the injected resolver's, not this projection's; all that
   * happens here is turning it into an item. Hosted reads project nothing,
   * the same posture device pairing takes: host model configuration is not a
   * tenant-scoped fact, and a tenant read has no standing to be told to go
   * fix it.
   */
  private async projectSetupRequirement(
    authority: SessionReadAuthority,
  ): Promise<SetupIncompleteAttentionItem[]> {
    if (!this.readStationSetupRequirement) return [];
    if (isHostedSessionReadAuthority(authority)) return [];
    const requirement = await this.readStationSetupRequirement();
    if (!requirement) return [];
    // The observation time, because the requirement is continuously observed
    // and carries no event of its own; it stops projecting when it resolves.
    const observedAt = new Date().toISOString();
    return [
      {
        id: `setup-incomplete:model-connection:${requirement.agentSlug}`,
        kind: 'setup-incomplete',
        title: `${requirement.agentName} cannot run yet`,
        body: requirement.reason,
        createdAt: observedAt,
        updatedAt: observedAt,
        source: {
          requirement: 'model-connection',
          agentSlug: requirement.agentSlug,
        },
        openHref: '/connections/models',
      },
    ];
  }

  private projectDevicePairingItems(
    authority: SessionReadAuthority,
    activeNotifications: Notification[],
    viewerCanDecide: boolean,
  ): DevicePairingAttentionItem[] {
    if (isHostedSessionReadAuthority(authority)) return [];
    const pairing = this.resolvePairingRequests?.();
    if (!pairing) return [];
    const now = Date.now();
    return (
      pairing
        .listRequests()
        // A `confirmed` request is already decided (waiting on the device's
        // exchange), and an expired one cannot be approved — neither needs
        // the user. Same filters `DevicePairingNotificationProvider.poll`
        // applies before announcing a request.
        .filter((request) => request.status === 'pending')
        .filter((request) => request.expiresAt > now)
        .map((request) => {
          const timestamp = new Date(request.createdAt).toISOString();
          const notificationId = activeNotifications.find(
            (notification) =>
              notification.source === DEVICE_PAIRING_NOTIFICATION_SOURCE &&
              notification.metadata?.requestId === request.requestId,
          )?.id;
          return {
            id: `device-pairing:${request.requestId}`,
            kind: 'device-pairing' as const,
            title: 'A device is asking to pair',
            body: `${request.deviceName} is waiting for approval on this Station.`,
            createdAt: timestamp,
            updatedAt: timestamp,
            deviceName: request.deviceName,
            // Derived at the HTTP seam from the boundary's own predicate —
            // see `list()`'s `viewer` option. The card renders Approve/Deny
            // only when true; a session tier that cannot pass the pairing
            // family's authorization gets the remedy instead of dead buttons.
            viewerCanDecide,
            // The Connections hub is where pairing/device management lives;
            // the decision itself happens through this item's own
            // Approve/Deny, which call the gated `/api/pairing` routes.
            openHref: '/connections',
            source: {
              requestId: request.requestId,
              ...(notificationId ? { notificationId } : {}),
            },
          };
        })
    );
  }

  /**
   * Liveness oracle for registry-backed approval-request notifications.
   * `ApprovalRegistry` is intentionally in-memory only (never persisted,
   * unlike `NotificationService`'s JsonFileStore) — a process restart while
   * a registry-backed approval notification is still `delivered`/`pending`
   * leaves that notification behind with no backing `ApprovalRegistry`
   * entry, so accept/decline resolve against an `approvalId` the registry no
   * longer has and the item would otherwise sit in "Needs attention"
   * forever. Orchestration-kind (session/request-backed) approvals are
   * deliberately left unfiltered here: session presence in
   * `listSessionReadModel` is not a reliable proxy for one specific
   * request's liveness (a live session can still complete unrelated
   * in-flight requests), and no adapter currently exposes a shared
   * per-request liveness lookup to check against instead.
   */
  private isApprovalLive(notification: Notification): boolean {
    if (!this.approvalRegistry) return true;
    const metadata = notification.metadata ?? {};
    if (stringValue(metadata.requestKind) !== 'registry') return true;
    const approvalId = stringValue(metadata.approvalId);
    if (!approvalId) return true;
    return this.approvalRegistry.has(approvalId);
  }

  /**
   * archive#1284 (AC3) / archive#1745: an orchestration-kind approval
   * notification whose backing session has nothing left that could answer
   * the request. `isApprovalLive` above covers the registry-kind case only —
   * it says so explicitly, because "session presence" is not per-request
   * liveness — which leaves exactly this shape uncovered: a session that
   * ended without a drained `request.resolved` leaves its notification
   * behind with nothing in the normal event path to ever clear it.
   *
   * archive#1745 moved the whole cancellation here. This used to cover only
   * the `past_resume` half; the `provider_absent` half was covered by a
   * boot-time pass that WROTE a synthetic `request.resolved`, with a
   * `providerRegistrationSettled` barrier in front of it because that write
   * was irreversible. The summary's `answerability` decoration answers both
   * arms as a derivation, so the card disappears while nothing can answer it
   * and comes back by itself if a late-registering plugin makes the session
   * answerable again. Nothing is persisted and nothing needs repairing.
   *
   * READ OFF THE SUMMARY, not recomputed: these are the same summaries
   * `listSessionReadModel` already returned, decorated at emission by
   * `projectRequestAnswerability` (`open-requests.ts`), where the predicate's
   * own choice of lifecycle test and why the attachment check comes first are
   * documented. One derivation, so this surface and the inbox cannot drift.
   *
   * Registry-kind notifications have no orchestration session to check and
   * are left alone here, the same scope boundary `isApprovalLive` draws; a
   * notification whose session hasn't loaded into `sessionsById` at all is
   * left unfiltered too (absence here is "unknown", never "ended").
   */
  private isNotificationSessionUnanswerable(
    notification: Notification,
    sessionsById: Map<string, OrchestrationSessionSummary>,
  ): boolean {
    const metadata = notification.metadata ?? {};
    if (stringValue(metadata.requestKind) !== 'orchestration') return false;
    const threadId = stringValue(metadata.threadId);
    if (!threadId) return false;
    const session = sessionsById.get(threadId);
    if (!session) return false;
    return !session.answerability.answerable;
  }
}

function isApprovalNotification(notification: Notification): boolean {
  return notification.category === 'approval-request';
}

/** The latest still-open request in a `collectOpenRequests` map, if any. */
function latestOpenRequestFromMap(
  requests: Map<string, RequestOpenedEvent>,
): RequestOpenedEvent | null {
  const values = Array.from(requests.values());
  return values.length ? values[values.length - 1] : null;
}

/**
 * Honest, minimal copy for the genuine fallback case: a session is
 * `needs_input`/`review_pending`/`blocked` (e.g. via a
 * `session.state-changed` transition) but has no resolvable open
 * `request.opened` event behind it. Keeps an item — never regresses to
 * nothing — but the body says plainly that no request detail is available
 * rather than implying it exists.
 *
 * Keyed by the awaiting `via`, not the projected item kind — a blocked
 * session projects kind `needs_input` (archive#3227 B1) but must say it is
 * blocked, with the recorded `blockedReason` as the cause when one exists
 * (the same field `buildSessionFailedItem` reads; absence stays absence,
 * never an invented cause).
 */
function fallbackLifecyclePresentation(
  via: SessionAwaitingVia,
  blockedReason?: string,
): { title: string; body?: string } {
  switch (via) {
    case 'needs_input':
      return {
        title: 'Input needed',
        body: 'Waiting on this session — no request details are available.',
      };
    case 'review_pending':
      return {
        title: 'Review pending',
        body: 'This session is pending review — no request details are available.',
      };
    case 'blocked':
      return {
        title: 'Session blocked',
        body: blockedReason
          ? truncate(blockedReason, MAX_DESCRIPTION_LENGTH)
          : 'This session is blocked — no request details are available.',
      };
  }
}

/**
 * The evidenced title/body for a `needs_input`/`review_pending` item (and,
 * since the archive#1185 fix round, a live `approval` item — see
 * `AttentionProjectionService.resolveApprovalOpenRequest`), built from the
 * request's own `requestType` — the signal that actually distinguishes "a
 * tool call is waiting" from "the agent asked a question" — rather than the
 * coarser lifecycle flag or the notification's own (pre-scrubbed) copy.
 */
function presentOpenRequest(request: RequestOpenedEvent): {
  title: string;
  body?: string;
} {
  const rawTitle = request.title?.trim() || undefined;

  switch (request.requestType) {
    case 'approval':
    case 'permission':
      return presentToolRequest(
        rawTitle,
        request.description,
        summarizeToolPayload(request.payload),
      );
    case 'confirmation':
      return presentAskRequest(
        'Confirmation needed',
        rawTitle,
        request.description,
      );
    default:
      // Contract vocabulary is exactly 'approval' | 'permission' |
      // 'confirmation' | 'input'; treat anything else the same as 'input'
      // rather than silently dropping detail for a future requestType.
      return presentAskRequest(
        'The agent asked a question',
        rawTitle,
        request.description,
      );
  }
}

/**
 * "Tool call awaiting approval: <tool>" — approval/permission requests.
 *
 * `rawTitle` is adapter-supplied display text, not a scrubbed value — for
 * producers whose payload doesn't match `TOOL_NAME_PAYLOAD_FIELDS`/
 * `TOOL_ARGS_PAYLOAD_FIELDS` (e.g. Codex's `item/commandExecution/
 * requestApproval`, whose `title` is the literal shell command),
 * `summarizeToolPayload` returns no toolName/argsSummary and `rawTitle`
 * becomes the only detail available — it can embed secrets (a `curl -H
 * 'Authorization: Bearer ...'` command) or simply be long, so it is bounded
 * the same way `description`/args are, never passed through verbatim.
 */
function presentToolRequest(
  rawTitle: string | undefined,
  description: string | undefined,
  toolSummary: { toolName?: string; argsSummary?: string } | null,
): { title: string; body?: string } {
  const boundedRawTitle = rawTitle
    ? truncate(rawTitle, MAX_RAW_TITLE_LENGTH)
    : undefined;
  const toolName = toolSummary?.toolName ?? boundedRawTitle;
  const title = toolName
    ? `Tool call awaiting approval: ${toolName}`
    : 'Tool call awaiting approval';

  const bodyParts: string[] = [];
  if (description)
    bodyParts.push(truncate(description, MAX_DESCRIPTION_LENGTH));
  if (boundedRawTitle && boundedRawTitle !== toolName)
    bodyParts.push(boundedRawTitle);
  if (toolSummary?.argsSummary) bodyParts.push(toolSummary.argsSummary);

  return {
    title,
    ...(bodyParts.length ? { body: bodyParts.join(' — ') } : {}),
  };
}

/** "<label>: <the request's own ask>" — confirmation/input requests, whose `title` IS the actual ask per the contract. */
function presentAskRequest(
  label: string,
  rawTitle: string | undefined,
  description: string | undefined,
): { title: string; body?: string } {
  const title = rawTitle ? `${label}: ${rawTitle}` : label;
  return {
    title,
    ...(description
      ? { body: truncate(description, MAX_DESCRIPTION_LENGTH) }
      : {}),
  };
}

const MAX_DESCRIPTION_LENGTH = 400;
/**
 * Bound on a session's own `displayTitle` when it becomes an attention row's
 * headline (archive#3203). `displayTitle` is already server-normalized and
 * bounded upstream; this is a display bound for a one-line row, not a
 * sanitation claim about the field.
 */
const MAX_SESSION_TITLE_LENGTH = 120;
/**
 * Bound on `request.title` when it is reused as display text (a title or a
 * body fragment) — adapter-supplied, not necessarily scrubbed (see
 * `presentToolRequest`'s doc comment).
 */
const MAX_RAW_TITLE_LENGTH = 200;
const MAX_ARG_KEYS = 5;
const MAX_ARGS_SUMMARY_LENGTH = 160;
/** Bound on each individual arg key name before joining — a key name is attacker/caller-controlled and can itself carry a secret-length string (e.g. `{[secret]: value}`); the joined-and-truncated overall bound alone is not enough, since a single oversized key can still survive inside the first MAX_ARGS_SUMMARY_LENGTH characters. */
const MAX_ARG_KEY_LENGTH = 24;
const TOOL_NAME_PAYLOAD_FIELDS = ['toolName', 'tool'] as const;
const TOOL_ARGS_PAYLOAD_FIELDS = [
  'toolInput',
  'toolArgs',
  'rawInput',
  'arguments',
  'args',
] as const;

/**
 * A bounded, secret-safe summary of a `request.opened` payload's tool
 * name/args (archive#1185, deliver #3) — never the raw arg values, which
 * may be large or carry secrets. Argument values are reduced to a shape
 * summary (field names only, each individually bounded — see
 * `MAX_ARG_KEY_LENGTH` — then hard-truncated as a whole); string/number/
 * boolean args are reduced to just their type. Err small: when in doubt,
 * say less.
 */
function summarizeToolPayload(
  payload: Record<string, unknown> | undefined,
): { toolName?: string; argsSummary?: string } | null {
  if (!payload) return null;
  const toolName = firstStringField(payload, TOOL_NAME_PAYLOAD_FIELDS);
  let argsValue: unknown;
  for (const key of TOOL_ARGS_PAYLOAD_FIELDS) {
    if (payload[key] !== undefined) {
      argsValue = payload[key];
      break;
    }
  }
  const argsSummary =
    argsValue !== undefined ? summarizeArgsShape(argsValue) : undefined;
  if (!toolName && !argsSummary) return null;
  return {
    ...(toolName ? { toolName } : {}),
    ...(argsSummary ? { argsSummary } : {}),
  };
}

function firstStringField(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/** Field names only — never values — each individually bounded, then hard-truncated as a whole. */
function summarizeArgsShape(value: unknown): string {
  if (Array.isArray(value)) return `args: array(${value.length})`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    const shown = keys
      .slice(0, MAX_ARG_KEYS)
      .map((key) => truncate(key, MAX_ARG_KEY_LENGTH));
    const more = keys.length - shown.length;
    const list = shown.join(', ') + (more > 0 ? `, +${more} more` : '');
    return truncate(`args: {${list}}`, MAX_ARGS_SUMMARY_LENGTH);
  }
  if (typeof value === 'string') return 'args: string';
  if (typeof value === 'number' || typeof value === 'boolean') {
    return `args: ${typeof value}`;
  }
  return 'args: present';
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * A Flow gate's console-projected outcome, translated into the inbox's
 * verdict vocabulary (never "approval" — a gate evaluates evidence, root
 * CONTEXT.md ~624). `route-back` asks for rework at an earlier step
 * (including the recovery-step-escalation case), a `block` without an
 * exhausted retry budget is a routine in-progress block (nothing for a
 * human to decide yet), and a `block` with `limit_exceeded` is the point a
 * human exception decision is genuinely pending — verified against
 * @kontourai/flow's `routeBackDecision` (flow-definition.ts ~425-456).
 */
function projectGateOutcome(
  gate: FlowConsoleGateProjection,
  session: OrchestrationSessionSummary,
  runId: string,
  projectSlug: string,
): AttentionItem | null {
  const openHref = `/projects/${encodeURIComponent(projectSlug)}/flow-console?run=${encodeURIComponent(runId)}`;
  const base = {
    createdAt: session.updatedAt,
    updatedAt: session.updatedAt,
    sessionId: session.threadId,
    openHref,
    source: {
      threadId: session.threadId,
      runId,
      gateId: gate.id,
      projectSlug,
    },
  };

  if (gate.status === 'route-back') {
    return {
      ...base,
      id: `gate-route-back:${runId}:${gate.id}`,
      kind: 'gate-route-back',
      title: `Route back: ${gate.step_id}`,
      ...(gate.route_back_to ? { routeBackTo: gate.route_back_to } : {}),
      ...(typeof gate.attempt === 'number' ? { attempt: gate.attempt } : {}),
      ...(typeof gate.max_attempts === 'number'
        ? { maxAttempts: gate.max_attempts }
        : {}),
    };
  }

  if (gate.status === 'block') {
    if (gate.limit_exceeded) {
      return {
        ...base,
        id: `gate-exception:${runId}:${gate.id}`,
        kind: 'gate-exception',
        title: `Exception pending: ${gate.step_id}`,
        limitExceeded: true,
      };
    }
    return {
      ...base,
      id: `gate-blocked:${runId}:${gate.id}`,
      kind: 'gate-blocked',
      title: `Blocked: ${gate.step_id}`,
    };
  }

  return null;
}

/**
 * archive#3203: everything a `session-failed` row needs to say WHAT failed,
 * WHY, and WHICH session it was. Pure and exported so the payload has direct
 * coverage without standing up the whole projection — every field is read off
 * the summary this projection already holds, and a field the summary did not
 * record is OMITTED rather than filled with a placeholder.
 *
 * `title` is the session's own `displayTitle`. It used to be the literal
 * `'Session failed'`, which `attentionKindLabel` already renders as the row's
 * eyebrow — so the reported tray showed those three words twice per row and
 * three failures from three sessions were indistinguishable. It falls back to
 * `'Untitled session'`, never a thread id (archive#3139).
 *
 * The fallback deliberately does NOT re-derive `sessionTitle`'s engine-named
 * branch ("Claude Code session") from src-ui/src/utils/sessionDisplay.ts: that
 * precedence, and the provider→label table under it, live UI-side, and a
 * server-side copy is the drift archive#3139 was. The engine reaches the row as the
 * raw `engine` id instead and the UI labels it with its own table, so there is
 * one table, not two.
 *
 * `body` stays the recorded `blockedReason` — `session-lifecycle-service`
 * mirrors the last `runtime.error` message into it, the same basis
 * `useMutableSessionDetailState`'s `failureText` falls back to — and is absent
 * when nothing was recorded. Nothing here invents a cause; the UI renders that
 * absence as "no failure detail was recorded".
 */
export function buildSessionFailedItem(
  session: OrchestrationSessionSummary,
): SessionFailedAttentionItem {
  const displayTitle = session.displayTitle?.trim();
  const agent = session.delegation?.targetId ?? session.assignedAgentSlug;
  return {
    id: `session-failed:${session.threadId}`,
    kind: 'session-failed',
    title: displayTitle
      ? truncate(displayTitle, MAX_SESSION_TITLE_LENGTH)
      : 'Untitled session',
    ...(session.blockedReason
      ? { body: truncate(session.blockedReason, MAX_DESCRIPTION_LENGTH) }
      : {}),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    sessionId: session.threadId,
    openHref: failedSessionOpenHref(session),
    source: { threadId: session.threadId },
    engine: session.provider,
    ...(agent ? { agent } : {}),
  };
}

/**
 * archive#3203: a failed session's "Open session" must land on the one
 * sub-view that renders the failure. `sessionOpenHref`'s project branch opens
 * the CHAT DOCK (`?chat=…&dock=open`), and the dock has no failure surface at
 * all — `failureText` is derived in `useMutableSessionDetailState` and
 * rendered only by `SessionDetailErrors` inside the session detail pane. That
 * mismatch is the reported "it brings me somewhere.. but I don't see an error
 * message".
 *
 * Only this kind is redirected. The dock is the right target for
 * `needs_input`/`review_pending`, which ask the user to answer — that is what
 * the dock's composer is for. A failed session has nothing to answer, so it
 * goes to the same Activity surface deep link project-less sessions already
 * use, where the reason renders in an `role="alert"` banner on arrival.
 */
function failedSessionOpenHref(session: OrchestrationSessionSummary): string {
  return activityDeepLink({ sessionId: session.threadId });
}

function sessionOpenHref(session: OrchestrationSessionSummary): string {
  const projectSlug = session.delegation?.projectSlug ?? session.projectSlug;
  if (projectSlug) {
    // archive#1284 (AC4): `dock=open` so the deep link actually opens the
    // chat dock instead of landing on the project layout with the dock
    // still closed (navigation-store.ts's `isDockOpen` reads this param).
    // The Activity surface deep link below is not a dock target and carries
    // no `dock=open`.
    return `/projects/${encodeURIComponent(projectSlug)}?chat=${encodeURIComponent(session.threadId)}&dock=open`;
  }
  return activityDeepLink({ sessionId: session.threadId });
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function compareAttentionItems(
  left: AttentionItem,
  right: AttentionItem,
): number {
  return (
    Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
    left.id.localeCompare(right.id)
  );
}

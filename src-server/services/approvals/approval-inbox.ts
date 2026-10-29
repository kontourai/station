import type { ClientOrigin } from '@kontourai/station-contracts/client-origin';
import {
  BLOCKING_NOTIFICATION_CATEGORIES,
  type Notification,
} from '@kontourai/station-contracts/notification';
import {
  requestBoundCallIds,
  runtimeEventContentDisplayText,
} from '@kontourai/station-contracts/runtime-event-content';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { INTERNAL_SESSION_READ_SCOPE } from '@kontourai/station-contracts/tenancy';
import { inputRequestFromRequestEvent } from '@kontourai/station-shared/input-request';
import {
  STATION_BROWSER_SERVER_GRANT_LABEL,
  toolRequestFromPayload,
  toolRequestGrantLabel,
  toolRequestIsPlanReview,
  toolRequestServerGrantFromPayload,
  toolRequestSessionGrantFromPayload,
} from '@kontourai/station-shared/tool-request-preview';
import type { INotificationProvider } from '../../providers/provider-interfaces.js';
import { approvalInboxOps } from '../../telemetry/metrics.js';
import { errorMessage } from '../../utils/error-message.js';
import { ON_ACTIVITY_CARD_METADATA_KEY } from '../notifications/delivery/card-alerted-categories.js';
import type { NotificationService } from '../notifications/notification-service.js';
import type { EventBus } from '../orchestration/event-bus.js';
import type { RequestReplayOutcome } from '../orchestration/open-requests.js';
import type { OrchestrationService } from '../orchestration/orchestration-service.js';
import { RequestEventGuardError } from '../orchestration/request-inspection.js';

type RequestOpenedEvent = Extract<
  CanonicalRuntimeEvent,
  { method: 'request.opened' }
>;

type InboxTarget =
  | {
      approvalId: string;
      kind: 'registry';
      requestKey: string;
    }
  | {
      kind: 'orchestration';
      requestEventId?: string;
      requestId: string;
      requestKey: string;
      threadId: string;
    };

interface ApprovalInboxLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

interface ApprovalInboxDependencies {
  approvalRegistry: {
    has(approvalId: string): boolean;
    resolve(
      approvalId: string,
      approved: boolean,
      clientOrigin?: ClientOrigin,
    ): boolean;
  };
  orchestrationService: Pick<
    OrchestrationService,
    | 'dispatch'
    | 'isEphemeralSession'
    | 'isReadOnlyAttachedSession'
    | 'readRequestOutcome'
    | 'resolveSessionProjectSlug'
    | 'readApprovalContentBinding'
  >;
}

const APPROVAL_INBOX_SOURCE = 'approval-inbox';
const APPROVAL_NOTIFICATION_CATEGORY =
  BLOCKING_NOTIFICATION_CATEGORIES.approvalRequest;
const REGISTRY_SESSION_KIND = 'managed';
const ORCHESTRATION_SESSION_KIND = 'runtime';

export type ApprovalInboxObservation = {
  state: 'open' | 'resolved' | 'expired' | 'stale' | 'unavailable';
};

export class ApprovalInboxNotificationProvider
  implements INotificationProvider
{
  readonly id = APPROVAL_INBOX_SOURCE;
  readonly displayName = 'Approval Inbox';
  readonly categories = [APPROVAL_NOTIFICATION_CATEGORY];

  private readonly targetsByNotificationId = new Map<string, InboxTarget>();
  private readonly notificationIdByRequestKey = new Map<string, string>();
  private contentNeedsLoadHandler?: (
    threadId: string,
    requestId: string,
  ) => Promise<void>;

  constructor(private readonly deps: ApprovalInboxDependencies) {}

  /**
   * docs/design/event-content-spill.md: called when the server refuses an
   * allow from a card because the request needs its content loaded (a bound
   * call stored out of line arrived after the card was built), so the
   * wiring can rewrite that card's actions.
   */
  onContentNeedsLoad(
    handler: (threadId: string, requestId: string) => Promise<void>,
  ): void {
    this.contentNeedsLoadHandler = handler;
  }

  hydrate(notifications: Notification[]): void {
    for (const notification of notifications) {
      const target = parseInboxTarget(notification);
      if (!target) {
        continue;
      }
      this.targetsByNotificationId.set(notification.id, target);
      this.notificationIdByRequestKey.set(target.requestKey, notification.id);
    }
  }

  remember(notification: Notification): void {
    const target = parseInboxTarget(notification);
    if (!target) {
      return;
    }
    this.targetsByNotificationId.set(notification.id, target);
    this.notificationIdByRequestKey.set(target.requestKey, notification.id);
  }

  /**
   * Observe one persisted approval notification without exposing its private
   * registry/request target. Parsing the notification itself keeps terminal
   * rows observable after the live lookup maps have correctly forgotten them.
   */
  observe(notification: Notification): ApprovalInboxObservation {
    if (
      notification.source !== APPROVAL_INBOX_SOURCE ||
      notification.category !== APPROVAL_NOTIFICATION_CATEGORY
    )
      return { state: 'stale' };
    const target = parseInboxTarget(notification);
    if (!target) return { state: 'stale' };
    try {
      if (target.kind === 'registry') {
        if (this.deps.approvalRegistry.has(target.approvalId))
          return { state: 'open' };
        if (notification.status === 'actioned') return { state: 'resolved' };
        if (notification.status === 'expired') return { state: 'expired' };
        return { state: 'stale' };
      }
      const outcome = this.readRequestOutcome(
        target.threadId,
        target.requestId,
      );
      if (outcome.state === 'open') return { state: 'open' };
      if (outcome.state === 'resolved')
        return {
          state: outcome.status === 'expired' ? 'expired' : 'resolved',
        };
      return {
        state: outcome.state === 'unrecorded' ? 'stale' : 'unavailable',
      };
    } catch {
      return { state: 'unavailable' };
    }
  }

  /**
   * #3276: whether actioning or dismissing this row would settle an approval
   * that is still waiting. The one answer every caller asks: an `unavailable`
   * outcome counts, because a request whose state cannot be read may still
   * be open. Rows from any other source are never live approvals.
   */
  isLiveApproval(notification: Notification): boolean {
    const { state } = this.observe(notification);
    return state === 'open' || state === 'unavailable';
  }

  completeRequest(requestKey: string): string | null {
    const notificationId = this.notificationIdByRequestKey.get(requestKey);
    if (!notificationId) {
      return null;
    }
    this.forget(notificationId);
    return notificationId;
  }

  async handleAction(
    notificationId: string,
    actionId: string,
    clientOrigin?: ClientOrigin,
  ): Promise<void> {
    const target = this.targetsByNotificationId.get(notificationId);
    if (!target) {
      return;
    }

    approvalInboxOps.add(1, {
      action: actionId,
      target: target.kind,
    });

    if (target.kind === 'orchestration') {
      const decision = mapOrchestrationDecision(actionId);
      const command = {
        type: 'respondToRequest' as const,
        threadId: target.threadId,
        requestId: target.requestId,
        ...(target.requestEventId
          ? { expectedRequestEventId: target.requestEventId }
          : {}),
        decision,
        // The typed choice, never the label.
        ...(actionId === ACCEPT_SERVER_FOR_SESSION_ACTION
          ? { sessionGrantScope: 'server' as const }
          : {}),
      };
      await (clientOrigin
        ? this.deps.orchestrationService.dispatch(command, { clientOrigin })
        : this.deps.orchestrationService.dispatch(command));
    } else {
      const approved = mapRegistryApprovalDecision(actionId);
      if (
        !this.deps.approvalRegistry.resolve(
          target.approvalId,
          approved,
          clientOrigin,
        )
      ) {
        // NotificationService marks a card actioned only after this returns.
        // Keep the target so a stale internal settlement cannot turn a still
        // open card into a false success (or make a retry impossible).
        throw new Error('Approval request is no longer pending');
      }
    }

    this.forget(notificationId);
  }

  /**
   * docs/design/event-content-spill.md: the server refused an allow from
   * this card because the request needs its content loaded (a bound call
   * stored out of line arrived after the card was built). The card is
   * rewritten to offer only Deny once its action lease is released.
   */
  async handleActionFailed(
    notificationId: string,
    _actionId: string,
    error: unknown,
  ): Promise<void> {
    const target = this.targetsByNotificationId.get(notificationId);
    if (
      target?.kind !== 'orchestration' ||
      !(error instanceof RequestEventGuardError) ||
      error.code !== 'request_content_not_loaded'
    )
      return;
    await this.contentNeedsLoadHandler?.(target.threadId, target.requestId);
  }

  async handleDismiss(
    notificationId: string,
    clientOrigin?: ClientOrigin,
  ): Promise<void> {
    const target = this.targetsByNotificationId.get(notificationId);
    if (!target) {
      return;
    }

    approvalInboxOps.add(1, {
      action: 'dismiss',
      target: target.kind,
    });

    if (target.kind === 'orchestration') {
      const command = {
        type: 'respondToRequest' as const,
        threadId: target.threadId,
        requestId: target.requestId,
        decision: 'decline' as const,
      };
      await (clientOrigin
        ? this.deps.orchestrationService.dispatch(command, { clientOrigin })
        : this.deps.orchestrationService.dispatch(command));
    } else {
      if (
        !this.deps.approvalRegistry.resolve(
          target.approvalId,
          false,
          clientOrigin,
        )
      ) {
        throw new Error('Approval request is no longer pending');
      }
    }

    this.forget(notificationId);
  }

  private forget(notificationId: string): void {
    const target = this.targetsByNotificationId.get(notificationId);
    if (!target) {
      return;
    }
    this.targetsByNotificationId.delete(notificationId);
    this.notificationIdByRequestKey.delete(target.requestKey);
  }

  /**
   * docs/design/event-content-spill.md: whether an allow of this request
   * needs its content loaded first, by the server's own binding (the request
   * or a tool call it gates was spilled). Fails closed: a binding that is
   * missing (the stored request cannot be read) or unreadable counts as
   * needing a load, so the card offers only Deny.
   */
  requiresContentLoad(event: RequestOpenedEvent): boolean {
    if (event.spilledContent) return true;
    try {
      const binding = this.deps.orchestrationService.readApprovalContentBinding(
        event.threadId,
        event.requestId,
        INTERNAL_SESSION_READ_SCOPE,
      );
      return binding === null || binding.required;
    } catch {
      return true;
    }
  }

  /**
   * The open orchestration requests in this thread that gate one of these
   * tool calls and whose cards must now offer only Deny: their binding needs
   * a content load. Each is returned as its stored request event, which the
   * wiring schedules again.
   */
  openRequestsNeedingLoad(
    threadId: string,
    callIds: readonly string[],
  ): RequestOpenedEvent[] {
    const requests: RequestOpenedEvent[] = [];
    for (const target of this.targetsByNotificationId.values()) {
      if (target.kind !== 'orchestration' || target.threadId !== threadId)
        continue;
      const request = this.storedRequestNeedingLoad(
        target.threadId,
        target.requestId,
      );
      if (
        request &&
        requestBoundCallIds(request).some((id) => callIds.includes(id))
      )
        requests.push(request);
    }
    return requests;
  }

  /** The stored request event when it is still open here and needs a load. */
  storedRequestNeedingLoad(
    threadId: string,
    requestId: string,
  ): RequestOpenedEvent | undefined {
    if (
      !this.notificationIdByRequestKey.has(
        buildOrchestrationRequestKey({ threadId, requestId }),
      )
    )
      return undefined;
    try {
      const binding = this.deps.orchestrationService.readApprovalContentBinding(
        threadId,
        requestId,
        INTERNAL_SESSION_READ_SCOPE,
      );
      return binding?.required && binding.request.method === 'request.opened'
        ? binding.request
        : undefined;
    } catch {
      return undefined;
    }
  }

  isReadOnlyAttachedSession(threadId: string): boolean {
    return this.deps.orchestrationService.isReadOnlyAttachedSession(threadId);
  }

  /**
   * archive#1284 (AC4): the session's project binding, when it has one —
   * same lookup `AttentionProjectionService.sessionOpenHref` uses, exposed
   * here so `wireApprovalInboxNotifications`'s `request.opened` handler can
   * stamp `metadata.projectSlug` onto a fresh orchestration approval
   * notification without reaching into `deps` directly.
   *
   * FAIL-SOFT (archive#1284 HIGH 3, call-site half). This is deep-link
   * DECORATION and must never gate creating the notification: it runs
   * inside the `EventBus` emit path, where an escaping throw used to delete
   * the whole approval-inbox listener (see `event-bus.ts`), and even now it
   * would abort a `request.opened` handler mid-flight and lose the
   * notification entirely. An approval card without a `projectSlug` deep
   * link is strictly better than no approval card. Matches the fail-open
   * posture already documented for `assembleTurnProvenanceFor`.
   */
  resolveProjectSlug(threadId: string): string | undefined {
    try {
      return this.deps.orchestrationService.resolveSessionProjectSlug(threadId);
    } catch {
      return undefined;
    }
  }

  /**
   * #2589: whether `threadId` is in the session read model the
   * agent-activity card is built from (`listSessionReadModel`, which leaves
   * out ephemeral webhook sessions). Only then is an approval in it on the
   * card. Fail-soft to `false`: an unmarked notification still alerts, and a
   * duplicate beats a silenced alert.
   */
  isListedSession(threadId: string): boolean {
    try {
      return !this.deps.orchestrationService.isEphemeralSession(threadId);
    } catch {
      return false;
    }
  }

  /**
   * archive#1284 (HIGH 2): what the persisted log says about this
   * notification's request — see `OrchestrationService.readRequestOutcome`.
   * Exposed on the provider for the same reason `resolveProjectSlug` is:
   * `wireApprovalInboxNotifications`'s sweep reads it without reaching into
   * `deps` directly.
   */
  readRequestOutcome(
    threadId: string,
    requestId: string,
  ): RequestReplayOutcome {
    return this.deps.orchestrationService.readRequestOutcome(
      threadId,
      requestId,
    );
  }
}

/**
 * archive#1284 (HIGH 2): converge on read.
 *
 * The bug this closes is a boot-ordering one. When this was written,
 * `OrchestrationService.initialize()` ran an orphan-reconciliation pass at
 * `runtime-initialize.ts`, several awaits BEFORE this function is called
 * from `runtime-route-support.ts`. `EventBus` is a bare `Set` with no
 * replay, so every synthetic `request.resolved` that pass emitted was
 * delivered to nobody, and the stale approval notification it was supposed
 * to clear stayed `delivered` forever.
 *
 * archive#1779 deleted that pass (the answer is projected at read time now
 * and nothing synthetic is written), which removes the ORIGINAL trigger but
 * not the class: any resolution that lands before this subscribe — an
 * adapter's own `request.resolved` during recovery, or one from a previous
 * boot — has the same shape. Converge-on-read is what makes the wiring
 * order stop mattering, so it stays.
 *
 * The fix is NOT to reorder the wiring (a happens-before that exists only
 * as line order, with nothing that fails when someone moves a line) and NOT
 * to add bus replay (it would change observable semantics for the SSE
 * fan-out, the console bridge and web push, and still could not heal
 * divergence that happened in a PREVIOUS boot). Instead this function
 * SUBSCRIBES FIRST and then SWEEPS the persisted event log for every
 * hydrated orchestration approval:
 *
 *   - anything resolved before the subscribe is in the store, and the sweep
 *     sees it;
 *   - anything resolved after the subscribe is delivered live;
 *   - the overlap (both fire) is safe, because `completeRequest` returns
 *     null the second time and `markStatus` is idempotent.
 *
 * So the design is COMMUTATIVE with the reconciliation pass: wiring before,
 * after, or interleaved with it all converge, and wiring order stops being
 * a correctness input rather than being one nobody enforces. It also heals
 * the whole class, not this instance — a missed emission for any reason
 * (crash between the event-store write and the notification-store write, a
 * listener lost to a throw) clears on the next wiring.
 */
export function wireApprovalInboxNotifications(
  eventBus: EventBus,
  provider: ApprovalInboxNotificationProvider,
  notificationService: NotificationService,
  logger: ApprovalInboxLogger,
): () => void {
  // One card per orchestration request, written again (same dedupe tag)
  // when its actions must change.
  const scheduleOrchestrationApproval = async (
    event: RequestOpenedEvent,
    needsLoad: boolean,
  ) => {
    const projectSlug = provider.resolveProjectSlug(event.threadId);
    // #1545: the standing grant has to say what it grants. "Allow for
    // Session" reads as a grant for the one call in front of you, and it is
    // a grant for every later call to the same tool in this session. This
    // label is PERSISTED on the notification and rendered verbatim by
    // `AttentionCard`'s `ApprovalActions`, so naming the tool here is the
    // only way the durable card says it — fixing the live toast alone left
    // the inbox row still reading "Allow for Session".
    //
    // `toolRequestGrantLabel` is the label the toast and inline card use:
    // it collapses an `mcp__<server>__<tool>` wire name, stays generic
    // rather than reaching for `event.title` (adapter display text; for
    // Codex the literal shell command), names a folder grant as one
    // (#2915), and is undefined for a plan exit, which offers none (#2916).
    //
    // #2915: an edit-mode answer lasts until the user changes mode only
    // because the answering caller records an Auto posture, which only
    // the orchestration command route (the `setApprovalMode` authority)
    // may do. An answer from this card is sent as a one-call accept, so
    // the card does not offer "Auto-accept file edits for this session".
    const grant = toolRequestSessionGrantFromPayload(event.payload);
    const grantLabel =
      grant === 'edit-mode'
        ? undefined
        : toolRequestGrantLabel(
            toolRequestFromPayload(event.payload).toolName,
            grant,
          );
    const notification = await notificationService.schedule(
      APPROVAL_INBOX_SOURCE,
      {
        category: APPROVAL_NOTIFICATION_CATEGORY,
        title: event.title || 'Provider approval needed',
        body:
          runtimeEventContentDisplayText(event.description) ||
          formatOrchestrationBody(event),
        priority: 'high',
        // #3390: a form is answered with content on its own card, against
        // the exact event the person saw; this card's decisions carry
        // neither and would be refused, so it offers only the way there.
        //
        // docs/design/event-content-spill.md: a request whose content
        // (or a tool call it gates) was stored out of line, or whose
        // binding cannot be read, must be loaded whole before it can be
        // allowed, so its card offers only Deny; opening the card is
        // the way to review and allow it. A bound call that arrives
        // later, or a refused allow, rewrites the card (below).
        actions: inputRequestFromRequestEvent(event)
          ? []
          : needsLoad
            ? [{ id: 'decline', label: 'Deny', variant: 'danger' }]
            : [
                { id: 'accept', label: 'Allow Once', variant: 'primary' },
                ...(grantLabel
                  ? [
                      {
                        id: 'acceptForSession',
                        label: grantLabel,
                        variant: 'secondary' as const,
                      },
                    ]
                  : []),
                ...(toolRequestServerGrantFromPayload(event.payload) ===
                'server'
                  ? [
                      {
                        id: ACCEPT_SERVER_FOR_SESSION_ACTION,
                        label: STATION_BROWSER_SERVER_GRANT_LABEL,
                        variant: 'secondary' as const,
                      },
                    ]
                  : []),
                { id: 'decline', label: 'Deny', variant: 'danger' },
              ],
        dedupeTag: buildOrchestrationRequestKey(event),
        metadata: {
          detail: runtimeEventContentDisplayText(event.description),
          provider: event.provider,
          ...(projectSlug ? { projectSlug } : {}),
          requestId: event.requestId,
          requestEventId: event.eventId,
          requestKey: buildOrchestrationRequestKey(event),
          requestKind: 'orchestration',
          requestType: event.requestType,
          // #2589: the card carries this request unless its session is
          // left out of the read model the card is built from.
          ...(provider.isListedSession(event.threadId)
            ? { [ON_ACTIVITY_CARD_METADATA_KEY]: true }
            : {}),
          sessionId: event.threadId,
          sessionKind: ORCHESTRATION_SESSION_KIND,
          threadId: event.threadId,
          // Raw, not the display form: this is provenance for consumers,
          // and `grantLabel` above is the display form for the button.
          toolName: toolRequestFromPayload(event.payload).toolName,
        },
      },
    );
    // A rewrite can race the request's resolution: the card is settled
    // (actioned, expired) between the binding read and this write. A settled
    // card is not answerable here, so it must not be remembered again.
    if (
      needsLoad &&
      notification.status !== 'delivered' &&
      notification.status !== 'pending'
    )
      return;
    provider.remember(notification);
  };
  // docs/design/event-content-spill.md: a card built before the server saw a
  // spilled bound call (or refused an allow for one) offers only Deny now.
  const rescheduleNeedingLoad = async (requests: RequestOpenedEvent[]) => {
    for (const request of requests)
      await scheduleOrchestrationApproval(request, true);
  };
  provider.onContentNeedsLoad(async (threadId, requestId) => {
    const request = provider.storedRequestNeedingLoad(threadId, requestId);
    if (request) await rescheduleNeedingLoad([request]);
  });
  const unsubscribe = eventBus.subscribe((message) => {
    notificationService.dispatch('approval-inbox-event', async () => {
      if (message.event === SERVER_EVENTS.APPROVAL_OPENED) {
        // #2589: a Station-agent relay's approval, which the adapter also
        // opens as the thread's orchestration request: on the card only when
        // it is the relayed conversation's own and that thread is listed.
        const relayThread = message.data?.orchestrationThreadId;
        const onActivityCard =
          typeof relayThread === 'string' &&
          relayThread === message.data?.conversationId &&
          provider.isListedSession(relayThread);
        const notification = await notificationService.schedule(
          APPROVAL_INBOX_SOURCE,
          {
            category: APPROVAL_NOTIFICATION_CATEGORY,
            title: 'Approval needed',
            body: formatRegistryApprovalBody(message.data),
            priority: 'high',
            actions: [
              { id: 'accept', label: 'Allow Once', variant: 'primary' },
              { id: 'decline', label: 'Deny', variant: 'danger' },
            ],
            dedupeTag: `approval:${message.data?.approvalId ?? 'unknown'}`,
            metadata: {
              agentName: message.data?.agentName,
              agentSlug: message.data?.agentSlug,
              approvalId: message.data?.approvalId,
              conversationId: message.data?.conversationId,
              conversationTitle: message.data?.conversationTitle,
              orchestrationThreadId: relayThread,
              ...(onActivityCard
                ? { [ON_ACTIVITY_CARD_METADATA_KEY]: true }
                : {}),
              sessionId: message.data?.conversationId,
              sessionKind: REGISTRY_SESSION_KIND,
              detail: message.data?.description,
              requestKind: 'registry',
              requestKey: `approval:${message.data?.approvalId ?? 'unknown'}`,
              source: message.data?.source,
              toolName: message.data?.toolName,
            },
          },
        );
        provider.remember(notification);
        approvalInboxOps.add(1, { action: 'opened', target: 'registry' });
        return;
      }

      if (message.event === SERVER_EVENTS.APPROVAL_RESOLVED) {
        const requestKey = `approval:${message.data?.approvalId ?? 'unknown'}`;
        const notificationId = provider.completeRequest(requestKey);
        if (!notificationId) {
          return;
        }
        if (message.data?.status === 'expired') {
          await notificationService.markStatus(notificationId, 'expired');
        } else {
          await notificationService.markStatus(notificationId, 'actioned');
        }
        approvalInboxOps.add(1, { action: 'resolved', target: 'registry' });
        return;
      }

      if (
        message.event !== SERVER_EVENTS.ORCHESTRATION_EVENT ||
        !message.data?.event
      ) {
        return;
      }

      const event = message.data.event as CanonicalRuntimeEvent;
      if (event.method === 'request.opened') {
        if (provider.isReadOnlyAttachedSession(event.threadId)) return;
        await scheduleOrchestrationApproval(
          event,
          !inputRequestFromRequestEvent(event) &&
            provider.requiresContentLoad(event),
        );
        approvalInboxOps.add(1, { action: 'opened', target: 'orchestration' });
        return;
      }

      if (event.method === 'tool.started' && event.spilledContent) {
        await rescheduleNeedingLoad(
          provider.openRequestsNeedingLoad(event.threadId, [
            event.toolCallId,
            ...(event.itemId ? [event.itemId] : []),
          ]),
        );
        return;
      }

      if (event.method === 'request.resolved') {
        const notificationId = provider.completeRequest(
          buildOrchestrationRequestKey(event),
        );
        if (!notificationId) {
          return;
        }
        if (event.status === 'expired') {
          await notificationService.markStatus(notificationId, 'expired');
        } else {
          await notificationService.markStatus(notificationId, 'actioned');
        }
        approvalInboxOps.add(1, {
          action: 'resolved',
          target: 'orchestration',
        });
        return;
      }

      logger.debug('Ignoring non-approval orchestration event for inbox', {
        method: event.method,
      });
    });
  });

  // Strictly after `subscribe` — that ordering is the whole commutativity
  // argument above, not a stylistic choice.
  notificationService.dispatch('approval-inbox-hydration', async () => {
    provider.hydrate(
      await notificationService.list({
        category: [APPROVAL_NOTIFICATION_CATEGORY],
        status: ['delivered', 'pending'],
      }),
    );
    await convergeHydratedOrchestrationApprovals(
      provider,
      notificationService,
      logger,
    );
  });

  return unsubscribe;
}

/**
 * Reconcile every hydrated orchestration approval notification against the
 * persisted event log — a derivation, never a stored flag
 * (`status-function.md`: "no stored status field overrides computation").
 *
 * Bounded by the number of still-open approval notifications, which is
 * small, and each check is one synchronous per-thread replay.
 */
async function convergeHydratedOrchestrationApprovals(
  provider: ApprovalInboxNotificationProvider,
  notificationService: NotificationService,
  logger: ApprovalInboxLogger,
): Promise<void> {
  const hydrated = await notificationService.list({
    category: [APPROVAL_NOTIFICATION_CATEGORY],
    status: ['delivered', 'pending'],
  });

  for (const notification of hydrated) {
    const target = parseInboxTarget(notification);
    // Registry-kind approvals have no orchestration session to replay —
    // the same scope boundary `AttentionProjectionService` draws.
    if (target?.kind !== 'orchestration') continue;

    let outcome: RequestReplayOutcome;
    try {
      outcome = provider.readRequestOutcome(target.threadId, target.requestId);
    } catch (error) {
      // A read failure is not evidence the request ended. Leave the
      // notification exactly as it is; the live path still works.
      logger.warn('Could not replay an approval request during convergence', {
        threadId: target.threadId,
        requestId: target.requestId,
        error: errorMessage(error),
      });
      continue;
    }

    // `open` — still genuinely outstanding. `undetermined` — nothing could
    // compute an answer (no event store); acting on a non-answer is the
    // defect this whole change exists to remove.
    if (outcome.state === 'open' || outcome.state === 'undetermined') continue;

    // `unrecorded`: the log is readable and has never heard of this
    // request, so nobody can ever resolve it and its Allow/Deny would
    // dispatch into nothing. `expired` (nobody acted) is the honest status;
    // `actioned` would claim a decision that was never made.
    // `resolved`: mirror the live path's mapping exactly.
    const status =
      outcome.state === 'unrecorded' || outcome.status === 'expired'
        ? 'expired'
        : 'actioned';

    const notificationId = provider.completeRequest(target.requestKey);
    if (!notificationId) continue;
    await notificationService.markStatus(notificationId, status);
    approvalInboxOps.add(1, { action: 'converged', target: 'orchestration' });
  }
}

function parseInboxTarget(notification: Notification): InboxTarget | null {
  const requestKind = notification.metadata?.requestKind;
  const requestKey = notification.metadata?.requestKey;
  if (typeof requestKind !== 'string' || typeof requestKey !== 'string') {
    return null;
  }

  if (requestKind === 'orchestration') {
    const threadId = notification.metadata?.threadId;
    const requestId = notification.metadata?.requestId;
    if (typeof threadId !== 'string' || typeof requestId !== 'string') {
      return null;
    }
    return {
      kind: 'orchestration',
      ...(typeof notification.metadata?.requestEventId === 'string'
        ? { requestEventId: notification.metadata.requestEventId }
        : {}),
      requestId,
      requestKey,
      threadId,
    };
  }

  if (requestKind === 'registry') {
    const approvalId = notification.metadata?.approvalId;
    if (typeof approvalId !== 'string') {
      return null;
    }
    return {
      approvalId,
      kind: 'registry',
      requestKey,
    };
  }

  return null;
}

/** The inbox action of the server-wide Station browser session grant. */
const ACCEPT_SERVER_FOR_SESSION_ACTION = 'acceptForSessionServer';

function mapOrchestrationDecision(
  actionId: string,
): 'accept' | 'acceptForSession' | 'decline' {
  if (
    actionId === 'acceptForSession' ||
    actionId === ACCEPT_SERVER_FOR_SESSION_ACTION
  ) {
    return 'acceptForSession';
  }
  if (actionId === 'accept') {
    return 'accept';
  }
  if (actionId === 'decline') {
    return 'decline';
  }
  throw new Error(`Unsupported orchestration approval action: ${actionId}`);
}

function mapRegistryApprovalDecision(actionId: string): boolean {
  if (actionId === 'accept') {
    return true;
  }
  if (actionId === 'decline') {
    return false;
  }
  throw new Error(`Unsupported registry approval action: ${actionId}`);
}

function buildOrchestrationRequestKey(
  event: Pick<RequestOpenedEvent, 'threadId' | 'requestId'>,
): string {
  return `orchestration:${event.threadId}:${event.requestId}`;
}

function formatOrchestrationBody(
  event: Extract<CanonicalRuntimeEvent, { method: 'request.opened' }>,
): string {
  const toolName =
    typeof event.payload?.toolName === 'string' ? event.payload.toolName : null;
  // A form names its requester; its tool name, if any, is a protocol method.
  const form = inputRequestFromRequestEvent(event);
  if (form)
    return toolRequestIsPlanReview(toolName)
      ? `${form.requester} wants you to review a plan.`
      : `${form.requester} asked a question.`;
  if (toolName) {
    return `${event.provider} wants approval to use ${toolName}.`;
  }
  return `${event.provider} requested ${event.requestType}.`;
}

function formatRegistryApprovalBody(payload?: Record<string, unknown>): string {
  const agentName =
    typeof payload?.agentName === 'string' ? payload.agentName : 'An agent';
  const toolName =
    typeof payload?.toolName === 'string'
      ? payload.toolName
      : typeof payload?.title === 'string'
        ? payload.title
        : 'a tool';
  return `${agentName} wants to use ${toolName}.`;
}

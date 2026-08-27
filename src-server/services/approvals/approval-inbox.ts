import type { ClientOrigin } from '@kontourai/station-contracts/client-origin';
import {
  BLOCKING_NOTIFICATION_CATEGORIES,
  type Notification,
} from '@kontourai/station-contracts/notification';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import type { INotificationProvider } from '../../providers/provider-interfaces.js';
import { approvalInboxOps } from '../../telemetry/metrics.js';
import type { NotificationService } from '../notifications/notification-service.js';
import type { EventBus } from '../orchestration/event-bus.js';
import type { RequestReplayOutcome } from '../orchestration/open-requests.js';
import type { OrchestrationService } from '../orchestration/orchestration-service.js';

type InboxTarget =
  | {
      approvalId: string;
      kind: 'registry';
      requestKey: string;
    }
  | {
      kind: 'orchestration';
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
    'dispatch' | 'readRequestOutcome' | 'resolveSessionProjectSlug'
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

  constructor(private readonly deps: ApprovalInboxDependencies) {}

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
        decision,
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
   * station#1284 (AC4): the session's project binding, when it has one —
   * same lookup `AttentionProjectionService.sessionOpenHref` uses, exposed
   * here so `wireApprovalInboxNotifications`'s `request.opened` handler can
   * stamp `metadata.projectSlug` onto a fresh orchestration approval
   * notification without reaching into `deps` directly.
   *
   * FAIL-SOFT (station#1284 HIGH 3, call-site half). This is deep-link
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
   * station#1284 (HIGH 2): what the persisted log says about this
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
 * station#1284 (HIGH 2): converge on read.
 *
 * The bug this closes is a boot-ordering one. When this was written,
 * `OrchestrationService.initialize()` ran an orphan-reconciliation pass at
 * `runtime-initialize.ts`, several awaits BEFORE this function is called
 * from `runtime-route-support.ts`. `EventBus` is a bare `Set` with no
 * replay, so every synthetic `request.resolved` that pass emitted was
 * delivered to nobody, and the stale approval notification it was supposed
 * to clear stayed `delivered` forever.
 *
 * station#1779 deleted that pass (the answer is projected at read time now
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
  const unsubscribe = eventBus.subscribe((message) => {
    notificationService.dispatch('approval-inbox-event', async () => {
      if (message.event === SERVER_EVENTS.APPROVAL_OPENED) {
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
        // station#1284 (AC4): resolved synchronously (no adapter I/O — see
        // OrchestrationService.resolveSessionProjectSlug's doc comment) so the
        // approval card can deep-link into the project chat dock like a
        // lifecycle card already does, instead of always falling back to
        // /sessions.
        const projectSlug = provider.resolveProjectSlug(event.threadId);
        const notification = await notificationService.schedule(
          APPROVAL_INBOX_SOURCE,
          {
            category: APPROVAL_NOTIFICATION_CATEGORY,
            title: event.title || 'Provider approval needed',
            body: event.description || formatOrchestrationBody(event),
            priority: 'high',
            actions: [
              { id: 'accept', label: 'Allow Once', variant: 'primary' },
              {
                id: 'acceptForSession',
                label: 'Allow for Session',
                variant: 'secondary',
              },
              { id: 'decline', label: 'Deny', variant: 'danger' },
            ],
            dedupeTag: buildOrchestrationRequestKey(event),
            metadata: {
              detail: event.description,
              provider: event.provider,
              ...(projectSlug ? { projectSlug } : {}),
              requestId: event.requestId,
              requestKey: buildOrchestrationRequestKey(event),
              requestKind: 'orchestration',
              requestType: event.requestType,
              sessionId: event.threadId,
              sessionKind: ORCHESTRATION_SESSION_KIND,
              threadId: event.threadId,
              toolName:
                typeof event.payload?.toolName === 'string'
                  ? event.payload.toolName
                  : undefined,
            },
          },
        );
        provider.remember(notification);
        approvalInboxOps.add(1, { action: 'opened', target: 'orchestration' });
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
        error: error instanceof Error ? error.message : String(error),
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

function mapOrchestrationDecision(
  actionId: string,
): 'accept' | 'acceptForSession' | 'decline' {
  if (actionId === 'acceptForSession') {
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
  event: Pick<CanonicalRuntimeEvent, 'method' | 'threadId' | 'requestId'>,
): string {
  return `orchestration:${event.threadId}:${event.requestId}`;
}

function formatOrchestrationBody(
  event: Extract<CanonicalRuntimeEvent, { method: 'request.opened' }>,
): string {
  const toolName =
    typeof event.payload?.toolName === 'string' ? event.payload.toolName : null;
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

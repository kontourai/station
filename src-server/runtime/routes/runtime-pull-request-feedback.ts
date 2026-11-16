/**
 * How the runtime composes pull request agent feedback: the store in the
 * Station home, the ownership rule over the conversation's linked and kept
 * pull requests, delivery onto the conversation inbox, detection on the
 * scheduler's tick, the turn-end refresh on the event bus, and the routes.
 * Kept out of `runtime-routes.ts`, which binds it in a few lines.
 *
 * Not composed on a hosted Station (no host forge login to read with, and
 * no conversation inbox), so every route there answers 404.
 */
import type { ConversationPullRequestLink } from '@kontourai/station-contracts/conversation-pull-request-links';
import { pullRequestFeedbackKey } from '@kontourai/station-contracts/pull-request-feedback';
import type { IPullRequestProvider } from '@kontourai/station-contracts/pull-request-provider';
import type { ProjectPullRequestWatchSettings } from '@kontourai/station-contracts/pull-request-watch';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { isSessionLifecycleStateStopped } from '@kontourai/station-contracts/session-lifecycle';
import type {
  TaskKeptDeclaredPullRequest,
  TaskPullRequestWatchHold,
  TaskRecord,
} from '@kontourai/station-contracts/task-graph';
import { parseGitHubWorkItemRef } from '@kontourai/station-contracts/work-item-provider';
import type {
  createPullRequestFeedbackRoutes,
  PullRequestFeedbackRouteAccess,
} from '../../routes/pull-requests/pull-request-feedback.js';
import { isOperatorInPersonNotAgent } from '../../security/coding-authority.js';
import { getRuntimeAuthenticatedRequestPrincipal } from '../../security/runtime-request-security.js';
import type { FeaturePreviewRegistry } from '../../services/feature-previews/feature-preview-registry.js';
import type { EventStore } from '../../services/orchestration/event-store.js';
import { projectSessionLifecycle } from '../../services/orchestration/session-lifecycle-service.js';
import type { ThreadInboxDelivery } from '../../services/orchestration/thread-inbox.js';
import { declaredPullRequestsForConversation } from '../../services/pull-requests/conversation-declared-pull-requests.js';
import type { ConversationPullRequestLinkStore } from '../../services/pull-requests/conversation-pull-request-link-store.js';
import {
  type FeedbackSessionState,
  PullRequestFeedbackDelivery,
} from '../../services/pull-requests/pull-request-feedback-delivery.js';
import {
  PullRequestFeedbackOwnership,
  pullRequestFeedbackSendsKind,
} from '../../services/pull-requests/pull-request-feedback-ownership.js';
import { PullRequestFeedbackPoller } from '../../services/pull-requests/pull-request-feedback-poller.js';
import {
  PullRequestFeedbackStoreHolder,
  pullRequestFeedbackStorePath,
} from '../../services/pull-requests/pull-request-feedback-store.js';
import { PullRequestWatch } from '../../services/pull-requests/pull-request-watch.js';
import type { PullRequestWatchPolicy } from '../agents/pre-tool-policy.js';

/**
 * A person, not Station acting for an agent (its internal principal) and
 * not another Station's delegation credential: an agent must never turn its
 * own feedback on.
 */
function requestIsPerson(request: Request): boolean {
  const principal = getRuntimeAuthenticatedRequestPrincipal(request);
  return (
    principal?.kind !== 'internal' &&
    principal?.deviceKind !== 'delegation' &&
    isOperatorInPersonNotAgent(request)
  );
}

/** The events whose fold decides a Session's lifecycle state. */
const LIFECYCLE_METHODS = [
  'session.started',
  'session.state-changed',
  'session.exited',
  'turn.started',
  'turn.completed',
  'turn.aborted',
  'runtime.error',
  'request.opened',
  'request.resolved',
] as const;
const TURN_METHODS = [
  'turn.started',
  'turn.completed',
  'turn.aborted',
] as const;
/** Events after which held feedback may go (or a queued one settled). */
const REDELIVER_METHODS = new Set([
  'turn.started',
  'turn.aborted',
  'session.state-changed',
  'request.resolved',
]);

export interface PullRequestFeedbackRuntimeDeps {
  homeDir: string;
  hosted: boolean;
  featurePreviews: FeaturePreviewRegistry;
  eventStore: EventStore | undefined;
  inbox: ThreadInboxDelivery | undefined;
  orchestration: {
    currentConversationSessionId(conversationId: string): string;
    sessionRecordedOwnerId(threadId: string): string | undefined;
  };
  eventBus: {
    subscribe(
      listener: (frame: { event: string; data?: unknown }) => void,
    ): () => void;
  };
  providers(): IPullRequestProvider[];
  links: ConversationPullRequestLinkStore;
  keptForSessions(
    sessionIds: readonly string[],
  ): readonly TaskKeptDeclaredPullRequest[];
  /** #5066: the Tasks that watch the pull requests they keep. */
  tasks?: {
    listTasks(): readonly TaskRecord[];
    listKeptDeclaredPullRequests(
      taskId: string,
    ): readonly TaskKeptDeclaredPullRequest[];
    holdTaskForPullRequestWatch(input: {
      taskId: string;
      hold: TaskPullRequestWatchHold;
    }): Promise<boolean>;
    project(
      projectId: string,
    ): { pullRequestWatch?: ProjectPullRequestWatchSettings } | undefined;
  };
  access: Omit<PullRequestFeedbackRouteAccess, 'enabled' | 'isPerson'>;
  logger: {
    warn(message: string, meta?: Record<string, unknown>): void;
    info?(message: string, meta?: Record<string, unknown>): void;
  };
}

export interface PullRequestFeedbackRuntime {
  /**
   * `createPullRequestFeedbackRoutes`'s arguments: runtime-routes mounts the
   * call itself, so the pairing-scope leaf scan can follow it to the routes.
   */
  routeArgs: Parameters<typeof createPullRequestFeedbackRoutes>;
  placementRefusal(input: {
    conversationId: string;
    clientTurnId: string;
  }): { reasonCode: string; reason: string } | undefined;
  /** The scheduler tick: started, never awaited. */
  tick(input: { now: number; signal: AbortSignal }): void;
  /** #4508: whether this feature sends this kind of follow-up for the item. */
  owns(itemRef: string, kind: string): boolean;
  /** #5066: a Task's pull request watch, when Tasks are composed. */
  watch?: PullRequestWatch;
  /** #5066: the pre-tool refusals for a watching Task's agent. */
  pullRequestWatchPolicy?: PullRequestWatchPolicy;
  close(): Promise<void>;
}

/**
 * The owning conversation's agent, read without waiting (the inbox's
 * placement re-check is synchronous): its current Session's folded
 * lifecycle, the inbox's own busy rule, its recorded owner, and its turns.
 */
export function createFeedbackSessionReaders(deps: {
  eventStore: Pick<
    EventStore,
    | 'conversationForSession'
    | 'conversationSessions'
    | 'readSessionByThread'
    | 'listEventPayloads'
    | 'listEventsByMethods'
  >;
  orchestration: PullRequestFeedbackRuntimeDeps['orchestration'];
  inbox: Pick<ThreadInboxDelivery, 'mustQueue'>;
}) {
  const { eventStore, orchestration, inbox } = deps;
  const conversationOf = (threadId: string) =>
    eventStore.conversationForSession(threadId)?.conversationId ?? threadId;
  const lineage = (conversationId: string) => [
    ...new Set([
      conversationId,
      ...eventStore
        .conversationSessions(conversationId)
        .map((linked) => linked.sessionId),
    ]),
  ];
  const session = (conversationId: string): FeedbackSessionState => {
    const sessionId =
      orchestration.currentConversationSessionId(conversationId);
    const persisted = eventStore.readSessionByThread(sessionId);
    if (!persisted) return { state: 'stopped' };
    const { lifecycleState } = projectSessionLifecycle({
      session: persisted,
      events: eventStore.listEventPayloads(
        sessionId,
        LIFECYCLE_METHODS,
        false,
        true,
      ),
    });
    const ownerUserId = orchestration.sessionRecordedOwnerId(sessionId);
    const owner = ownerUserId ? { ownerUserId } : {};
    if (isSessionLifecycleStateStopped(lifecycleState))
      return { state: 'stopped', ...owner };
    if (
      lifecycleState === 'needs_input' ||
      lifecycleState === 'review_pending' ||
      lifecycleState === 'blocked'
    )
      return { state: 'awaiting', ...owner };
    if (lifecycleState === 'running' || inbox.mustQueue(conversationId))
      return { state: 'busy', ...owner };
    return { state: 'idle', ...owner };
  };
  const turnEvents = (sessionId: string) =>
    eventStore
      .listEventsByMethods(sessionId, TURN_METHODS)
      .map((stored) => stored.payload);
  const turnWindows = (conversationId: string) => {
    const windows: Array<{ start: number; end?: number }> = [];
    for (const sessionId of lineage(conversationId)) {
      const open = new Map<string, number>();
      for (const event of turnEvents(sessionId)) {
        const at = Date.parse(event.createdAt);
        const turnId = (event as { turnId?: string }).turnId ?? '';
        if (event.method === 'turn.started') open.set(turnId, at);
        else if (open.has(turnId)) {
          windows.push({ start: open.get(turnId)!, end: at });
          open.delete(turnId);
        }
      }
      for (const start of open.values()) windows.push({ start });
    }
    return windows;
  };
  const lastTurnAt = (conversationId: string) => {
    const last = turnEvents(
      orchestration.currentConversationSessionId(conversationId),
    ).at(-1);
    return last ? Date.parse(last.createdAt) : undefined;
  };
  return { conversationOf, lineage, session, turnWindows, lastTurnAt };
}

/**
 * Re-decide on the owning agent's own events: a finished turn reads its
 * pull requests again first (a push may have moved the head); a started
 * turn, an abort, a state change or an answered request may let held
 * feedback go or settle a queued message. Returns the unsubscribe.
 */
export function subscribeFeedbackTriggers(deps: {
  eventBus: PullRequestFeedbackRuntimeDeps['eventBus'];
  enabled(): boolean;
  conversationOf(threadId: string): string;
  hasClaims(conversationId: string): boolean;
  refresh(conversationId: string): void;
  deliver(conversationId: string): void;
}): () => void {
  return deps.eventBus.subscribe((frame) => {
    if (frame.event !== 'orchestration:event' || !deps.enabled()) return;
    const event = (frame.data as { event?: CanonicalRuntimeEvent } | undefined)
      ?.event;
    if (!event || typeof event.threadId !== 'string') return;
    const refresh = event.method === 'turn.completed';
    if (!refresh && !REDELIVER_METHODS.has(event.method)) return;
    const conversationId = deps.conversationOf(event.threadId);
    if (!deps.hasClaims(conversationId)) return;
    if (refresh) deps.refresh(conversationId);
    else deps.deliver(conversationId);
  });
}

export function composePullRequestFeedbackRuntime(
  deps: PullRequestFeedbackRuntimeDeps,
): PullRequestFeedbackRuntime | undefined {
  const { eventStore, inbox } = deps;
  if (deps.hosted || !eventStore || !inbox) return undefined;
  const preview = deps.featurePreviews.bind({
    // A literal, as docs:feature-previews:check reads it.
    id: 'pull-request-agent-feedback',
    label: 'Pull request agent feedback',
    description:
      "Send a chat's agent its pull request's failing checks, review comments and merge conflicts. Uses the host gh login.",
  });
  const enabled = () =>
    preview.select({ enabled: () => true, disabled: () => false });
  const holder = new PullRequestFeedbackStoreHolder(() =>
    pullRequestFeedbackStorePath(deps.homeDir),
  );
  const { conversationOf, lineage, session, turnWindows, lastTurnAt } =
    createFeedbackSessionReaders({
      eventStore,
      orchestration: deps.orchestration,
      inbox,
    });
  /** What a person linked to the chat (any Session of it) or kept on its Task. */
  const linkedNow = (conversationId: string) => {
    const ids = lineage(conversationId);
    const explicit: ConversationPullRequestLink[] = ids.flatMap((id) =>
      deps.links.list(id),
    );
    return [
      ...explicit,
      ...declaredPullRequestsForConversation(
        { lineageSessionIds: () => ids, keptForSessions: deps.keptForSessions },
        conversationId,
      ),
    ];
  };
  const linkedIdentities = async (conversationId: string) =>
    linkedNow(conversationId);

  const tasks = deps.tasks;
  const live = (task: TaskRecord) =>
    task.status !== 'done' && task.status !== 'canceled';
  const ownerOf = (conversationId: string) =>
    deps.orchestration.sessionRecordedOwnerId(
      deps.orchestration.currentConversationSessionId(conversationId),
    );
  const watch = tasks
    ? new PullRequestWatch({
        enabled,
        store: () => holder.forWrite(),
        readStore: () => holder.forRead(),
        liveTasks: () => tasks.listTasks().filter(live),
        project: (projectId) => tasks.project(projectId),
        keeps: (taskId) => tasks.listKeptDeclaredPullRequests(taskId),
        linked: linkedNow,
        conversationOf,
        ownerOf,
        taskForConversation: (conversationId) =>
          tasks
            .listTasks()
            .find(
              (task) =>
                live(task) &&
                !!task.sessionId &&
                conversationOf(task.sessionId) === conversationId,
            ),
        holdTask: (input) => tasks.holdTaskForPullRequestWatch(input),
        logger: deps.logger,
      })
    : undefined;

  const delivery = new PullRequestFeedbackDelivery({
    onFixBudgetSpent: (input) => watch?.fixBudgetSpent(input),
    onReady: ({ claim, observation }) =>
      deps.logger.info?.('Watched pull request is ready for its person', {
        taskId: claim.watch?.taskId,
        headSha: observation.headSha,
      }),
    linked: linkedNow,
    store: () => holder.forRead(),
    enabled,
    session,
    mayContinue: (conversationId, userId) =>
      inbox.mayContinue(conversationId, userId),
    turnWindows,
    inbox: () => ({
      submit: (input) => inbox.submit(input),
      entry: (conversationId, key) => inbox.entry(conversationId, key),
    }),
    logger: deps.logger,
  });
  const poller = new PullRequestFeedbackPoller({
    linked: linkedNow,
    enabled,
    store: () => holder.forRead(),
    providers: deps.providers,
    session,
    lastTurnAt,
    delivery: () => delivery,
    logger: deps.logger,
  });
  const ownership = new PullRequestFeedbackOwnership({
    store: () => holder.forWrite(),
    readStore: () => holder.forRead(),
    linkedIdentities,
    session,
    mayContinue: (conversationId, userId) =>
      inbox.mayContinue(conversationId, userId),
    title: (conversationId) =>
      eventStore.conversationTitle(lineage(conversationId)),
  });
  const hasClaims = (conversationId: string) =>
    (holder.forRead()?.claimsForConversation(conversationId).length ?? 0) > 0;
  const unsubscribe = subscribeFeedbackTriggers({
    eventBus: deps.eventBus,
    enabled,
    conversationOf,
    hasClaims,
    refresh: (conversationId) => void poller.refresh(conversationId),
    deliver: (conversationId) => void delivery.deliver(conversationId),
  });
  return {
    routeArgs: [
      ownership,
      () => delivery,
      (conversationId) => void poller.refresh(conversationId),
      { ...deps.access, enabled, isPerson: requestIsPerson },
    ],
    placementRefusal: (input) => delivery.placementRefusal(input),
    tick: (input) => {
      // Claims first, so a pull request kept since the last tick is read
      // on this one.
      watch?.sync();
      poller.tick(input);
    },
    ...(watch
      ? {
          watch,
          pullRequestWatchPolicy: (input) => {
            const verdict = watch.guard(input);
            return verdict
              ? { decision: verdict.decision, predicate: verdict.predicate }
              : undefined;
          },
        }
      : {}),
    owns: (itemRef, kind) => {
      if (!enabled()) return false;
      const parsed = parseGitHubWorkItemRef(itemRef);
      if (!parsed) return false;
      const claim = holder.forRead()?.claim(
        pullRequestFeedbackKey({
          provider: 'github',
          host: 'github.com',
          repository: { owner: parsed.owner, name: parsed.repo },
          ref: String(parsed.number),
        }),
      );
      // Not while the pull request is no longer linked to the claim's chat:
      // that feedback will never be sent, so the Task's lead is woken.
      return (
        !!claim &&
        pullRequestFeedbackSendsKind(claim, kind) &&
        linkedNow(claim.conversationId).some(
          (link) => pullRequestFeedbackKey(link) === claim.prKey,
        )
      );
    },
    close: async () => {
      unsubscribe();
      await poller.close();
      holder.close();
    },
  };
}

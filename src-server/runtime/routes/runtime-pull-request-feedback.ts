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

import { resolve } from 'node:path';
import type { DelegationResultDelivery } from '../../services/orchestration/delegation-result-delivery.js';
import type {
  ConversationPullRequestLink,
  ConversationPullRequestLinkObservation,
  LinkedPullRequestSnapshot,
  PullRequestLinkIdentity,
} from '@kontourai/station-contracts/conversation-pull-request-links';
import {
  pullRequestFeedbackActive,
  pullRequestFeedbackKey,
  pullRequestFeedbackSends,
} from '@kontourai/station-contracts/pull-request-feedback';
import type { IPullRequestProvider } from '@kontourai/station-contracts/pull-request-provider';
import type { ProjectPullRequestWatchSettings } from '@kontourai/station-contracts/pull-request-watch';
import type { IndependentReviewRequest } from '@kontourai/station-contracts/review-evidence';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { isSessionLifecycleStateStopped } from '@kontourai/station-contracts/session-lifecycle';
import type {
  TaskKeptDeclaredPullRequest,
  TaskPullRequestWatchHold,
  TaskRecord,
} from '@kontourai/station-contracts/task-graph';
import type { TaskPullRequestFeedbackFact } from '@kontourai/station-contracts/task-lane';
import { parseGitHubWorkItemRef } from '@kontourai/station-contracts/work-item-provider';
import type { WorktreeSessionMetadata } from '@kontourai/station-contracts/workspace-isolation';
import {
  type createPullRequestFeedbackRoutes,
  type PullRequestFeedbackRouteAccess,
  pullRequestFeedbackWriterId,
} from '../../routes/pull-requests/pull-request-feedback.js';
import { isOperatorInPersonNotAgent } from '../../security/coding-authority.js';
import { getRuntimeAuthenticatedRequestPrincipal } from '../../security/runtime-request-security.js';
import { readReviewRepositoryIdentity } from '../../services/evidence/git-review-workspace-source.js';
import type { ReviewEvidenceModule } from '../../services/evidence/review-evidence-module.js';
import type { FeaturePreviewRegistry } from '../../services/feature-previews/feature-preview-registry.js';
import type { NotificationService } from '../../services/notifications/notification-service.js';
import type { EventStore } from '../../services/orchestration/event-store.js';
import { projectSessionLifecycle } from '../../services/orchestration/session-lifecycle-service.js';
import type { ThreadInboxDelivery } from '../../services/orchestration/thread-inbox.js';
import { declaredPullRequestsForConversation } from '../../services/pull-requests/conversation-declared-pull-requests.js';
import type { ConversationPullRequestLinkStore } from '../../services/pull-requests/conversation-pull-request-link-store.js';
import { LinkedPullRequestSnapshots } from '../../services/pull-requests/linked-pull-request-snapshots.js';
import {
  type PullRequestFeedbackAttentionSource,
  schedulePullRequestFeedbackNotice,
  settlePullRequestFeedbackNotices,
} from '../../services/pull-requests/pull-request-feedback-attention.js';
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
  type PullRequestFeedbackStore,
  PullRequestFeedbackStoreHolder,
  pullRequestFeedbackStorePath,
  type StoredClaimCondition,
} from '../../services/pull-requests/pull-request-feedback-store.js';
import {
  PullRequestFeedbackTaskBranches,
  type PullRequestFeedbackTaskBranchPorts,
  type TaskBranchProject as PullRequestFeedbackTaskBranchProject,
  type TaskBranchTask as PullRequestFeedbackTaskBranchTask,
} from '../../services/pull-requests/pull-request-feedback-task-branches.js';
import { pullRequestFeedbackTaskFact } from '../../services/pull-requests/pull-request-feedback-task-fact.js';
import { PullRequestHeadReviewer } from '../../services/pull-requests/pull-request-head-review.js';
import { PullRequestWatch } from '../../services/pull-requests/pull-request-watch.js';
import { expandTilde } from '../../utils/paths.js';
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

/**
 * A pause recorded before pauses kept `at`: stamped once, now, so its
 * attention version (and an acknowledgement of it) stays put afterwards.
 * `enabledAt` moved whenever a switch was saved, resurfacing it.
 */
function backfillPausedAt(
  store: PullRequestFeedbackStore,
  prKey: string,
  condition: Extract<StoredClaimCondition, { state: 'paused' }>,
): string {
  const at = new Date().toISOString();
  store.setCondition(prKey, { ...condition, at });
  return at;
}

/** The forge's pull request page, only over https on its own host. */
function pullRequestPageUrl(
  value: string | undefined,
  host: string,
): string | undefined {
  try {
    const url = new URL(value ?? '');
    return url.protocol === 'https:' &&
      url.host.toLowerCase() === host.toLowerCase()
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
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
  coordination?: Pick<
    DelegationResultDelivery,
    'watchPullRequest' | 'watchedPullRequests' | 'observePullRequest'
  >;
  featurePreviews: FeaturePreviewRegistry;
  eventStore: EventStore | undefined;
  inbox: ThreadInboxDelivery | undefined;
  orchestration: {
    currentConversationSessionId(conversationId: string): string;
    sessionRecordedOwnerId(threadId: string): string | undefined;
    firstStartedMetadataOfThread(
      threadId: string,
    ): Record<string, unknown> | undefined;
  };
  eventBus: {
    subscribe(
      listener: (frame: { event: string; data?: unknown }) => void,
    ): () => void;
  };
  providers(): IPullRequestProvider[];
  refreshWorkspaceFacts?(now: number, enabled: () => boolean): Promise<void>;
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
  access: Omit<
    PullRequestFeedbackRouteAccess,
    'enabled' | 'isPerson' | 'mayContinue'
  >;
  logger: {
    warn(message: string, meta?: Record<string, unknown>): void;
    info?(message: string, meta?: Record<string, unknown>): void;
  };
  /**
   * Project defaults and Task-branch discovery (C2c): the Projects, Tasks
   * and Task worktrees it reads. Absent: neither is offered.
   */
  taskBranches?: Pick<
    PullRequestFeedbackTaskBranchPorts,
    | 'tasks'
    | 'project'
    | 'taskWorktree'
    | 'taskOfSession'
    | 'repositoryIdentity'
  > & {
    canReadProject(request: Request, projectSlug: string): Promise<boolean>;
  };
}

type FeedbackNotifier = Pick<
  NotificationService,
  'scheduleEnveloped' | 'list' | 'markStatus'
>;

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
  /**
   * Pull requests found on the chat's Task's own branch, for the chat's
   * pull request list. Empty while the preview is off.
   */
  derivedLinks(conversationId: string): ConversationPullRequestLink[];
  snapshotFor(
    identity: PullRequestLinkIdentity,
  ): LinkedPullRequestSnapshot | undefined;
  subscribeStatus(
    sourceConversationId: string,
    projectId: string,
    ref: string,
    owner: Omit<
      Parameters<DelegationResultDelivery['watchPullRequest']>[0],
      'taskId' | 'childConversationId'
    >,
  ): { id: string; status: 'armed' | 'already-armed' | 'capacity' } | undefined;
  mayReadStatusWatch(sourceConversationId: string, prKey: string): boolean;
  linkedSnapshotsEnabled(): boolean;
  snapshotsForConversations(
    ids: readonly string[],
  ): ReadonlyMap<string, ConversationPullRequestLinkObservation[]>;
  /**
   * A kept pull request's feedback for the Task board, as this request may
   * see it: undefined while the preview is off or unless it may read the
   * chat that gets it.
   */
  factFor(
    identity: PullRequestLinkIdentity,
    request: Request,
    /** The Task's own run (`TaskRecord.sessionId`): only it can be fixing. */
    taskSessionId?: string,
  ): TaskPullRequestFeedbackFact | undefined;
  /** The scheduler tick: started, never awaited. */
  tick(input: { now: number; signal: AbortSignal }): void;
  /** #4508: whether this feature sends this kind of follow-up for the item. */
  owns(itemRef: string, kind: string): boolean;
  /**
   * Pull requests whose feedback needs a person now: paused, or waiting on
   * a stopped agent. Empty while the preview is off. Not filtered by
   * reader: the attention projection keeps only Sessions the reader reads.
   */
  attentionSources(): PullRequestFeedbackAttentionSource[];
  /**
   * The notification service, once composed (it is created after this
   * runtime). Until then a notice is dropped; the attention item still
   * shows.
   */
  bindNotifier(service: FeedbackNotifier): void;
  /** Whether this request could Send again or turn feedback off for the chat. */
  viewerMayChange(request: Request, conversationId: string): boolean;
  /**
   * Station's review of each new head, once the review module is composed
   * (after this runtime). Until then no head review starts.
   */
  bindHeadReview(deps: HeadReviewDeps): void;
  /** #5066: a Task's pull request watch, when Tasks are composed. */
  watch?: PullRequestWatch;
  /** #5066: the pre-tool refusals for a watching Task's agent. */
  pullRequestWatchPolicy?: PullRequestWatchPolicy;
  close(): Promise<void>;
}

/** What a head review needs from the rest of the runtime. */
export interface HeadReviewDeps {
  reviews: Pick<ReviewEvidenceModule, 'run' | 'status' | 'read'>;
  /** Repo Map selection for a request, as the review module would make it. */
  selection: {
    resolve(
      request: IndependentReviewRequest,
      context: Record<string, never>,
    ): Promise<{ kind: string }>;
  };
  /** The Project's folder, when it has one. */
  projectRoot(projectSlug: string): string | undefined;
  /**
   * The single `correctness` reviewer when Repo Map selection is
   * unavailable: the Task code review's rule (a read-only capable Agent of
   * the Project that is not the implementer).
   */
  fallbackReviewer(
    projectSlug: string,
    implementerAgentSlug: string,
  ): Promise<string | undefined>;
  /** A Task's recorded base commit. */
  taskBaseCommit(taskId: string): string | undefined;
}

/** The lens a head review falls back to without Repo Map selection. */
const CORRECTNESS_LENS = {
  id: 'correctness',
  instructions:
    'Review the exact committed change for correctness, security and data integrity. Report only actionable findings with a concrete failure scenario. Do not edit files.',
};

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
    | 'latestEventByMethods'
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
    if (!persisted) return { state: 'stopped', sessionId };
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
    const owner = ownerUserId ? { ownerUserId, sessionId } : { sessionId };
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
  /** Only the newest turn event of the conversation's current Session. */
  const lastTurnEvent = (conversationId: string) =>
    eventStore.latestEventByMethods(
      orchestration.currentConversationSessionId(conversationId),
      TURN_METHODS,
    )?.payload as CanonicalRuntimeEvent | undefined;
  const lastTurnAt = (conversationId: string) => {
    const last = lastTurnEvent(conversationId);
    return last ? Date.parse(last.createdAt) : undefined;
  };
  /** The send key of the current Session's turn, while it has not ended. */
  const openTurnKey = (conversationId: string) => {
    const last = lastTurnEvent(conversationId);
    return last?.method === 'turn.started' ? last.clientTurnId : undefined;
  };
  return {
    conversationOf,
    lineage,
    session,
    turnWindows,
    lastTurnAt,
    openTurnKey,
  };
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
  /** Any finished turn, claims or not: Task-branch discovery looks soon. */
  turnCompleted?(conversationId: string, sessionId: string): void;
}): () => void {
  return deps.eventBus.subscribe((frame) => {
    if (frame.event !== 'orchestration:event' || !deps.enabled()) return;
    const event = (frame.data as { event?: CanonicalRuntimeEvent } | undefined)
      ?.event;
    if (!event || typeof event.threadId !== 'string') return;
    const refresh = event.method === 'turn.completed';
    if (!refresh && !REDELIVER_METHODS.has(event.method)) return;
    const conversationId = deps.conversationOf(event.threadId);
    if (refresh) deps.turnCompleted?.(conversationId, event.threadId);
    if (!deps.hasClaims(conversationId)) return;
    if (refresh) deps.refresh(conversationId);
    else deps.deliver(conversationId);
  });
}

/**
 * `taskBranches` from Station's own services, so runtime-routes binds it in
 * one call: Tasks and their recorded worktrees from the Task graph, a
 * Project by id or slug, the Task a Session is bound to, and a checkout's
 * repository as review reads it (its normalized origin).
 */
export function pullRequestFeedbackTaskBranchPorts(services: {
  taskGraph: {
    listTasks(): readonly PullRequestFeedbackTaskBranchTask[];
    readTaskWorktree(taskId: string): WorktreeSessionMetadata | undefined;
  };
  projects: {
    listProjects(): readonly { id: string; slug: string }[];
    getProject(slug: string): PullRequestFeedbackTaskBranchProject;
  };
  eventStore:
    | Pick<EventStore, 'readProjectTaskRoomExecutionBinding'>
    | undefined;
  canReadProject(request: Request, projectSlug: string): Promise<boolean>;
}): NonNullable<PullRequestFeedbackRuntimeDeps['taskBranches']> {
  return {
    tasks: () => services.taskGraph.listTasks(),
    project: (idOrSlug) => {
      const listed = services.projects
        .listProjects()
        .find(
          (project) => project.id === idOrSlug || project.slug === idOrSlug,
        );
      try {
        if (!listed) return undefined;
        const project = services.projects.getProject(listed.slug);
        // A recorded `~/…` folder is the host user's, as the pull request
        // routes read it (station#3155).
        const workingDirectory =
          project.workingDirectory &&
          resolve(expandTilde(project.workingDirectory));
        return workingDirectory ? { ...project, workingDirectory } : project;
      } catch {
        return undefined;
      }
    },
    taskWorktree: (taskId) => services.taskGraph.readTaskWorktree(taskId),
    taskOfSession: (sessionId) =>
      services.eventStore?.readProjectTaskRoomExecutionBinding(sessionId)
        ?.taskId,
    repositoryIdentity: readReviewRepositoryIdentity,
    canReadProject: services.canReadProject,
  };
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
  const headReviewPreview = deps.featurePreviews.bind({
    // A literal, as docs:feature-previews:check reads it.
    id: 'pull-request-head-review',
    label: 'Pull request head review',
    description:
      "Run Station's independent review on each new head of a pull request a chat owns, and send its required findings to the agent. Needs Pull request agent feedback. Pull requests already set to review resume when you turn this on.",
  });
  const headReviewEnabled = () =>
    enabled() &&
    headReviewPreview.select({ enabled: () => true, disabled: () => false });
  const holder = new PullRequestFeedbackStoreHolder(() =>
    pullRequestFeedbackStorePath(deps.homeDir),
  );
  const {
    conversationOf,
    lineage,
    session,
    turnWindows,
    lastTurnAt,
    openTurnKey,
  } = createFeedbackSessionReaders({
    eventStore,
    orchestration: deps.orchestration,
    inbox,
  });
  // Assigned below when composed; linkedNow reads its derived links.
  let taskBranches: PullRequestFeedbackTaskBranches | undefined;
  /**
   * What a person linked to the chat (any Session of it) or kept on its
   * Task, and what Station found on its Task's own branch and nobody
   * removed. Delivery and the poller release a claim missing from it.
   */
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
      ...(taskBranches?.derivedLinks(conversationId) ?? []),
    ];
  };
  const linkedIdentities = async (conversationId: string) =>
    linkedNow(conversationId);
  const feedbackSnapshot = (identity: PullRequestLinkIdentity) => {
    const store = enabled() ? holder.forRead() : undefined;
    return store?.observation(pullRequestFeedbackKey(identity))?.observation
      .snapshot;
  };
  const snapshots = new LinkedPullRequestSnapshots(
    deps.providers,
    enabled,
    feedbackSnapshot,
  );
  const snapshotFor = (identity: PullRequestLinkIdentity) =>
    enabled() ? snapshots.get(identity) : undefined;
  const snapshotsForConversations: PullRequestFeedbackRuntime['snapshotsForConversations'] =
    (ids) => {
      const result = new Map<
        string,
        ConversationPullRequestLinkObservation[]
      >();
      if (!enabled() || !ids.length) return result;
      const sessionIds = new Map(ids.map((id) => [id, lineage(id)]));
      try {
        const distinctSessions = [...new Set([...sessionIds.values()].flat())];
        const explicit = deps.links.listMany(distinctSessions);
        const keepsBySession = new Map<string, TaskKeptDeclaredPullRequest[]>();
        for (const keep of deps.keptForSessions(distinctSessions)) {
          const sessionId = keep.provenance.sessionId;
          const group = keepsBySession.get(sessionId);
          if (group) group.push(keep);
          else keepsBySession.set(sessionId, [keep]);
        }
        for (const [id, sessions] of sessionIds) {
          const linked = [
            ...sessions.flatMap((sessionId) => explicit.get(sessionId) ?? []),
            ...declaredPullRequestsForConversation(
              {
                lineageSessionIds: () => sessions,
                keptForSessions: () =>
                  sessions.flatMap((id) => keepsBySession.get(id) ?? []),
              },
              id,
            ),
            ...(taskBranches?.derivedLinks(id) ?? []),
          ];
          const seen = new Set<string>();
          const observations =
            linked.flatMap<ConversationPullRequestLinkObservation>((link) => {
              const key = pullRequestFeedbackKey(link);
              if (seen.has(key)) return [];
              seen.add(key);
              const snapshot = snapshotFor(link);
              if (!snapshot?.observedAt)
                return [
                  {
                    ...link,
                    observedAt: new Date().toISOString(),
                    status: {
                      state: 'unavailable' as const,
                      reason: 'Status not observed',
                    },
                  },
                ];
              return [
                {
                  ...link,
                  observedAt: snapshot.observedAt,
                  status: { ...snapshot, state: 'current' as const },
                },
              ];
            });
          if (observations.length) result.set(id, observations);
        }
      } catch (error) {
        deps.logger.warn('Linked pull request snapshots unavailable', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return result;
    };
  let notifier: FeedbackNotifier | undefined;
  const access = {
    ...deps.access,
    enabled,
    isPerson: requestIsPerson,
    mayContinue: (conversationId: string, userId: string) =>
      inbox.mayContinue(conversationId, userId),
  };
  // Assigned below; delivery settles notices after each run through it.
  let attentionSources: () => PullRequestFeedbackAttentionSource[] = () => [];

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
        headReviewHold: (prKey) => headReview.watchHold(prKey),
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

  // Set before the store closes: a run finishing during shutdown would
  // read no sources and expire every live notice.
  let closing = false;
  const delivery = new PullRequestFeedbackDelivery({
    onFixBudgetSpent: (input) => watch?.fixBudgetSpent(input),
    onReady: ({ claim, observation }) =>
      deps.logger.info?.('Watched pull request is ready for its person', {
        taskId: claim.watch?.taskId,
        headSha: observation.headSha,
      }),
    settleNotices: () => {
      const service = notifier;
      if (!service || closing) return;
      settlePullRequestFeedbackNotices(service, attentionSources()).catch(
        (error) =>
          deps.logger.warn('Pull request feedback notices not settled', {
            error: error instanceof Error ? error.message : String(error),
          }),
      );
    },
    notify: (notice) => {
      const service = notifier;
      if (!service) return;
      schedulePullRequestFeedbackNotice(
        service,
        notice,
        deps.orchestration.currentConversationSessionId(notice.conversationId),
      ).catch((error) =>
        deps.logger.warn('Pull request feedback notification failed', {
          conversationId: notice.conversationId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    },
    linked: linkedNow,
    store: () => holder.forRead(),
    enabled,
    headReviewEnabled,
    headReviewHold: (prKey) => headReview.watchHold(prKey),
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
  const branchPorts = deps.taskBranches;
  if (branchPorts)
    taskBranches = new PullRequestFeedbackTaskBranches({
      enabled,
      store: () => holder.forWrite(),
      readStore: () => holder.forRead(),
      tasks: () => branchPorts.tasks(),
      project: (idOrSlug) => branchPorts.project(idOrSlug),
      taskWorktree: (taskId) => branchPorts.taskWorktree(taskId),
      ...(branchPorts.taskOfSession
        ? { taskOfSession: branchPorts.taskOfSession }
        : {}),
      repositoryIdentity: (path) => branchPorts.repositoryIdentity(path),
      providers: deps.providers,
      conversationOf,
      session,
      mayContinue: (conversationId, userId) =>
        inbox.mayContinue(conversationId, userId),
      headReviewEnabled,
      logger: deps.logger,
    });
  let headReviewDeps: HeadReviewDeps | undefined;
  const headReview = new PullRequestHeadReviewer({
    enabled: headReviewEnabled,
    store: () => holder.forRead(),
    session,
    lastTurnAt,
    mayContinue: (conversationId, userId) =>
      inbox.mayContinue(conversationId, userId),
    chat: (conversationId) => {
      const sessionId =
        deps.orchestration.currentConversationSessionId(conversationId);
      const metadata =
        deps.orchestration.firstStartedMetadataOfThread(sessionId) ?? {};
      const agent = metadata.agentSlug ?? metadata.executionAgentId;
      const projectSlug = lineage(conversationId)
        .map((id) => eventStore.readConversationProjectSlug(id))
        .find((slug) => slug !== undefined);
      const binding = eventStore.readProjectTaskRoomExecutionBinding(sessionId);
      const taskBaseCommit = binding
        ? headReviewDeps?.taskBaseCommit(binding.taskId)
        : undefined;
      const ownerUserId = deps.orchestration.sessionRecordedOwnerId(sessionId);
      return {
        ...(projectSlug ? { projectSlug } : {}),
        ...(typeof agent === 'string' && agent
          ? { implementerAgentSlug: agent }
          : {}),
        ...(ownerUserId ? { ownerUserId } : {}),
        // A chat an unverified agent started acts for no one: so does its
        // review.
        ...(metadata.ownerAttribution === 'unattributed-agent'
          ? { ownerAttribution: 'unattributed-agent' as const }
          : {}),
        ...(taskBaseCommit ? { taskBaseCommit } : {}),
      };
    },
    projectRoot: (projectSlug) => headReviewDeps?.projectRoot(projectSlug),
    reviewers: async (request) => {
      const bound = headReviewDeps;
      if (!bound) return undefined;
      let selected = false;
      try {
        selected =
          (await bound.selection.resolve(request, {})).kind === 'selected';
      } catch {
        selected = false;
      }
      if (selected) return { reviewers: [], selection: { kind: 'repo-map' } };
      const slug = await bound.fallbackReviewer(
        request.target.projectSlug,
        request.implementerAgentSlug,
      );
      return slug
        ? {
            reviewers: [
              {
                reviewerId: 'head-review',
                executorAgentSlug: slug,
                lens: CORRECTNESS_LENS,
              },
            ],
          }
        : undefined;
    },
    reviews: () => headReviewDeps?.reviews,
    delivery: () => delivery,
    logger: deps.logger,
  });
  const poller = new PullRequestFeedbackPoller({
    ...(taskBranches
      ? { discover: (input) => taskBranches!.discover(input) }
      : {}),
    linked: linkedNow,
    enabled,
    store: () => holder.forRead(),
    providers: deps.providers,
    statusWatches: () => deps.coordination?.watchedPullRequests() ?? [],
    observeStatus: (prKey, observation) =>
      deps.coordination?.observePullRequest(prKey, observation),
    session,
    lastTurnAt,
    delivery: () => delivery,
    headReview: () => headReview,
    headReviewEnabled,
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
    headReview: (prKey) => headReview.view(prKey),
    headReviewWaiting: (prKey) => headReview.waiting(prKey),
    headReviewEnabled,
  });
  attentionSources = () => {
    const store = enabled() ? holder.forRead() : undefined;
    if (!store) return [];
    const sources: PullRequestFeedbackAttentionSource[] = [];
    const linkedKeys = new Map<string, Set<string>>();
    const stillLinked = (conversationId: string, prKey: string) => {
      let keys = linkedKeys.get(conversationId);
      if (!keys) {
        keys = new Set(linkedNow(conversationId).map(pullRequestFeedbackKey));
        linkedKeys.set(conversationId, keys);
      }
      return keys.has(prKey);
    };
    for (const claim of store.allClaims()) {
      const condition = claim.condition;
      if (
        !pullRequestFeedbackActive(claim.settings, headReviewEnabled()) ||
        (condition && condition.state !== 'paused') ||
        // Unlinked: delivery releases it on its next run.
        !stillLinked(claim.conversationId, claim.prKey)
      )
        continue;
      const url = pullRequestPageUrl(
        store.observation(claim.prKey)?.observation.url,
        claim.identity.host,
      );
      const base = {
        conversationId: claim.conversationId,
        sessionId: deps.orchestration.currentConversationSessionId(
          claim.conversationId,
        ),
        prKey: claim.prKey,
        identity: claim.identity,
        ...(url ? { url } : {}),
      };
      if (condition?.state === 'paused') {
        sources.push({
          ...base,
          reason: condition.reason,
          headSha: condition.headSha,
          ...(condition.cap ? { cap: condition.cap } : {}),
          // Required checks first, as a person reads them.
          ...(condition.shown || condition.failing
            ? { failing: condition.shown ?? condition.failing }
            : {}),
          ...(condition.rounds ? { rounds: condition.rounds } : {}),
          ...(pullRequestFeedbackSends(claim.settings)
            ? {}
            : { reviewOnly: true as const }),
          at: condition.at ?? backfillPausedAt(store, claim.prKey, condition),
        });
        continue;
      }
      const waiting = store
        .pendingDeliveries(claim.conversationId)
        .filter((pending) => pending.prKey === claim.prKey);
      if (!waiting.length || session(claim.conversationId).state !== 'stopped')
        continue;
      sources.push({
        ...base,
        reason: 'agent-stopped',
        headSha: waiting.at(-1)!.headSha,
        waiting: waiting.map((pending) => ({
          category: pending.category,
          count: pending.summary.count,
        })),
        // Oldest first: new feedback while stopped keeps one version.
        at: waiting[0]!.createdAt,
      });
    }
    return sources;
  };
  const hasClaims = (conversationId: string) =>
    (holder.forRead()?.claimsForConversation(conversationId).length ?? 0) > 0;
  const unsubscribe = subscribeFeedbackTriggers({
    eventBus: deps.eventBus,
    enabled,
    conversationOf,
    hasClaims,
    refresh: (conversationId) => void poller.refresh(conversationId),
    // An agent that just became idle may let a head review start.
    deliver: (conversationId) =>
      void delivery
        .deliver(conversationId)
        .then(() => headReview.consider(conversationId)),
    turnCompleted: (conversationId, sessionId) =>
      taskBranches?.nudge(conversationId, sessionId),
  });
  return {
    mayReadStatusWatch: (sourceConversationId, prKey) =>
      enabled() &&
      linkedNow(sourceConversationId).some(
        (link) => pullRequestFeedbackKey(link) === prKey,
      ),
    subscribeStatus(sourceConversationId, projectId, ref, owner) {
      if (!enabled() || !deps.coordination) return undefined;
      const matching = new Map(
        linkedNow(sourceConversationId)
          .filter((link) => link.ref === ref)
          .map((link) => [pullRequestFeedbackKey(link), link] as const),
      );
      if (matching.size !== 1) return undefined;
      const entry = matching.entries().next().value;
      if (!entry) return undefined;
      const [prKey, { host, provider, repository }] = entry;
      holder.forWrite();
      const id = `pr-watch:${JSON.stringify([owner.parentConversationId, prKey])}`;
      const status = deps.coordination.watchPullRequest(
        {
          ...owner,
          childConversationId: id,
          taskId: prKey,
        },
        prKey,
        { host, provider, repository, ref },
        { sourceConversationId, projectId },
      );
      return { id, status };
    },
    routeArgs: [
      ownership,
      () => delivery,
      (conversationId) => void poller.refresh(conversationId),
      access,
      taskBranches && branchPorts
        ? {
            taskBranches,
            canReadProject: branchPorts.canReadProject,
            // Released on delivery's next run, unless still linked.
            dismissed: (conversationId: string) =>
              void delivery.deliver(conversationId),
          }
        : undefined,
      () => (headReviewEnabled() && headReviewDeps ? headReview : undefined),
    ],
    placementRefusal: (input) => delivery.placementRefusal(input),
    // Fail-soft: the chat's pull request list never depends on agent
    // feedback. A preview or store read that throws contributes nothing.
    derivedLinks: (conversationId) => {
      try {
        return enabled()
          ? (taskBranches?.derivedLinks(conversationId) ?? [])
          : [];
      } catch (error) {
        deps.logger.warn('Task-branch pull requests not read', {
          conversationId,
          error: error instanceof Error ? error.message : String(error),
        });
        return [];
      }
    },
    snapshotFor,
    snapshotsForConversations,
    linkedSnapshotsEnabled: enabled,
    factFor: (identity, request, taskSessionId) => {
      const store = enabled() ? holder.forRead() : undefined;
      if (!store || !deps.access.current(request)) return undefined;
      return pullRequestFeedbackTaskFact({
        view: ownership.byPullRequest(
          identity,
          {
            canRead: (conversationId) =>
              deps.access.canRead(request, conversationId),
          },
          { sentChecks: false, headReview: false },
        ),
        store,
        openTurnKey,
        reviewHold: headReview.watchHold(pullRequestFeedbackKey(identity)),
        headReviewEnabled: headReviewEnabled(),
        ...(taskSessionId
          ? { taskConversationId: conversationOf(taskSessionId) }
          : {}),
      });
    },
    tick: (input) => {
      // Claims first, so a pull request kept since the last tick is read
      // on this one.
      watch?.sync();
      poller.tick(input);
      snapshots.tick(input);
      void deps.refreshWorkspaceFacts?.(
        input.now,
        () => enabled() && !input.signal.aborted,
      );
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
    attentionSources: () => attentionSources(),
    bindNotifier: (service) => {
      notifier = service;
    },
    bindHeadReview: (bound) => {
      headReviewDeps = bound;
    },
    viewerMayChange: (request, conversationId) => {
      try {
        return !!pullRequestFeedbackWriterId(access, request, conversationId);
      } catch {
        // An unresolvable request authority offers nothing.
        return false;
      }
    },
    close: async () => {
      closing = true;
      unsubscribe();
      await poller.close();
      // A review still running settles into a store that is closing: its
      // row stays `running` and reads "unknown" after the restart.
      holder.close();
    },
  };
}

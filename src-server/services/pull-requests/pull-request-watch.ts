/**
 * Task-owned pull requests (#5066): a Task that keeps a pull request
 * watches it until it lands, and merging stays with the person.
 *
 * - Watching is a claim on the pull request agent feedback loop
 *   (`pull-request-feedback-*`) owned by the Task's conversation and marked
 *   with the Task (`ClaimWatch`). That loop already wakes the agent only on
 *   a failing check, a new review comment or a change request, at most once
 *   per distinct event, and rides the built-in scheduler's tick: there is no
 *   model polling loop.
 * - Who watches: a Task's own choice (`TaskRecord.pullRequestWatch`), else
 *   its Project's (`ProjectConfig.pullRequestWatch`). A claim is created
 *   only for a pull request no chat owns yet; a claim a person made in a chat
 *   is theirs, and one a person turned off stays off.
 * - Budget: each placed message that carried failing checks is one fix
 *   attempt. When a pull request has used them all, the delivery pauses it
 *   and calls `fixBudgetSpent`, which moves the Task to `blocked` (the
 *   board's Needs you) with the failing checks named.
 * - Refusals: `guard` is a pre-tool policy stage. A watching Task's agent
 *   may not merge, arm auto-merge or force-push (refused), and changes CI
 *   configuration only with a person's approval (asked). Each is recorded.
 */
import { randomUUID } from 'node:crypto';
import type { PullRequestLinkIdentity } from '@kontourai/station-contracts/conversation-pull-request-links';
import {
  pullRequestFeedbackKey,
  pullRequestFeedbackSends,
} from '@kontourai/station-contracts/pull-request-feedback';
import {
  type ProjectPullRequestWatchSettings,
  type PullRequestWatchRefusalKind,
  resolveTaskPullRequestWatch,
  type TaskPullRequestWatchPullRequest,
  type TaskPullRequestWatchReviewHold,
  type TaskPullRequestWatchState,
  type TaskPullRequestWatchView,
} from '@kontourai/station-contracts/pull-request-watch';
import type {
  TaskKeptDeclaredPullRequest,
  TaskPullRequestWatchHold,
  TaskRecord,
} from '@kontourai/station-contracts/task-graph';
import { errorMessage } from '../../utils/error-message.js';
import type {
  PullRequestFeedbackClaim,
  PullRequestFeedbackStore,
} from './pull-request-feedback-store.js';
import { matchPullRequestWatchRefusal } from './pull-request-watch-guard.js';

/** Live Tasks one sync looks at. */
const MAX_TASKS_PER_SYNC = 200;
/** Kept pull requests per Task a sync claims. */
const MAX_KEEPS_PER_TASK = 10;
const REFUSALS_SHOWN = 20;
const TOOL_NAME_CHARS = 120;

/** The switches a watching Task turns on. */
const WATCH_SETTINGS = Object.freeze({
  fixFailingChecks: true,
  addressReviewComments: true,
  reviewEachHead: false,
});

export interface PullRequestWatchPorts {
  /** The `pull-request-agent-feedback` preview's live choice. */
  enabled(): boolean;
  headReviewHold?(prKey: string): TaskPullRequestWatchReviewHold | undefined;
  /** Opened on first write. */
  store(): PullRequestFeedbackStore | undefined;
  /** Undefined until something was written. */
  readStore(): PullRequestFeedbackStore | undefined;
  /** Tasks that are neither done nor canceled. */
  liveTasks(): readonly TaskRecord[];
  project(
    projectId: string,
  ): { pullRequestWatch?: ProjectPullRequestWatchSettings } | undefined;
  keeps(taskId: string): readonly TaskKeptDeclaredPullRequest[];
  /**
   * The pull requests linked to or kept on a conversation, as the delivery
   * reads them. A claim on one outside it would be released on the next
   * delivery, so it is not made. Absent: every keep counts.
   */
  linked?(conversationId: string): readonly PullRequestLinkIdentity[];
  /** The conversation a Session belongs to (itself when it has none). */
  conversationOf(sessionId: string): string;
  /** The person a conversation's turns are sent as. */
  ownerOf(conversationId: string): string | undefined;
  /** The live Task whose Session is in this conversation, if any. */
  taskForConversation(conversationId: string): TaskRecord | undefined;
  holdTask(input: {
    taskId: string;
    hold: TaskPullRequestWatchHold;
  }): Promise<boolean>;
  now?(): number;
  readonly logger: {
    warn(message: string, meta?: Record<string, unknown>): void;
    info?(message: string, meta?: Record<string, unknown>): void;
  };
}

export type PullRequestWatchGuardVerdict = {
  kind: PullRequestWatchRefusalKind;
  decision: 'deny' | 'ask';
  predicate: string;
};

const identityOf = (
  keep: TaskKeptDeclaredPullRequest,
): PullRequestLinkIdentity => ({
  provider: keep.provider,
  host: keep.host.toLowerCase(),
  repository: { owner: keep.repository.owner, name: keep.repository.name },
  ref: keep.ref,
});

const label = (identity: PullRequestLinkIdentity) =>
  `${identity.repository.owner}/${identity.repository.name}#${identity.ref}`;

const PREDICATES: Record<PullRequestWatchRefusalKind, string> = {
  'arm-auto-merge':
    'was refused: this Task watches its pull request, and arming auto-merge is the person’s decision. Report that it is ready instead.',
  merge:
    'was refused: this Task watches its pull request, and merging is the person’s decision. Report that it is ready instead.',
  'force-push':
    'was refused: this Task watches its pull request, and a force-push rewrites history reviewers have seen. Push a new commit instead.',
  'ci-config':
    'changes CI configuration on a watched Task’s pull request, so a person must approve it.',
};

export class PullRequestWatch {
  constructor(private readonly ports: PullRequestWatchPorts) {}

  private now(): number {
    return this.ports.now?.() ?? Date.now();
  }

  /** One sync's Project reads, so a tick reads each Project once. */
  private projects:
    | Map<string, ReturnType<PullRequestWatchPorts['project']>>
    | undefined;

  private resolve(task: TaskRecord) {
    let project = this.projects?.get(task.projectId);
    if (!this.projects?.has(task.projectId)) {
      project = this.ports.project(task.projectId);
      this.projects?.set(task.projectId, project);
    }
    return resolveTaskPullRequestWatch(project, task);
  }

  /** Claim or release every live Task's kept pull requests. Never throws. */
  sync(): void {
    if (!this.ports.enabled()) return;
    let tasks: readonly TaskRecord[];
    try {
      tasks = this.ports.liveTasks();
    } catch (error) {
      this.ports.logger.warn('Pull request watch could not list Tasks', {
        error: errorMessage(error),
      });
      return;
    }
    this.projects = new Map();
    try {
      for (const task of tasks.slice(0, MAX_TASKS_PER_SYNC))
        this.syncTask(task);
    } finally {
      this.projects = undefined;
    }
    // A Task that ended (or went away) watches nothing: release its claims,
    // keeping the mark.
    try {
      const store = this.ports.readStore();
      if (!store) return;
      const live = new Set(tasks.map((task) => task.id));
      const nowIso = new Date(this.now()).toISOString();
      for (const claim of store.allClaims())
        if (
          claim.watch &&
          !live.has(claim.watch.taskId) &&
          pullRequestFeedbackSends(claim.settings)
        )
          store.releaseClaim(claim.prKey, nowIso);
    } catch (error) {
      this.ports.logger.warn('Pull request watch could not release claims', {
        error: errorMessage(error),
      });
    }
  }

  /** Claim or release one Task's kept pull requests now. Never throws. */
  syncTask(task: TaskRecord): void {
    try {
      this.syncTaskOrThrow(task);
    } catch (error) {
      this.ports.logger.warn('Pull request watch sync failed', {
        taskId: task.id,
        error: errorMessage(error),
      });
    }
  }

  private syncTaskOrThrow(task: TaskRecord): void {
    const keeps = this.ports.keeps(task.id).slice(0, MAX_KEEPS_PER_TASK);
    if (!keeps.length) return;
    const resolved = this.resolve(task);
    const nowIso = new Date(this.now()).toISOString();
    if (!resolved.watching || !this.ports.enabled()) {
      // Stop watching: release what this Task claimed, keeping its mark so
      // watching again turns it back on.
      const store = this.ports.readStore();
      if (!store) return;
      for (const keep of keeps) {
        const claim = store.claim(pullRequestFeedbackKey(identityOf(keep)));
        if (
          claim?.watch?.taskId === task.id &&
          pullRequestFeedbackSends(claim.settings)
        )
          store.releaseClaim(claim.prKey, nowIso);
      }
      return;
    }
    if (!task.sessionId) return;
    const conversationId = this.ports.conversationOf(task.sessionId);
    const owner = this.ports.ownerOf(conversationId);
    if (!owner) return;
    const store = this.ports.store();
    if (!store) return;
    const linked = this.ports.linked
      ? new Set(this.ports.linked(conversationId).map(pullRequestFeedbackKey))
      : undefined;
    for (const keep of keeps) {
      const identity = identityOf(keep);
      const prKey = pullRequestFeedbackKey(identity);
      if (linked && !linked.has(prKey)) continue;
      const claim = store.claim(prKey);
      const ours = claim?.watch?.taskId === task.id;
      if (claim && !ours) {
        // A person's claim (on, or turned off) is theirs to keep.
        continue;
      }
      if (
        !claim ||
        !pullRequestFeedbackSends(claim.settings) ||
        claim.conversationId !== conversationId
      ) {
        store.writeClaim({
          prKey,
          identity,
          conversationId,
          settings: { ...WATCH_SETTINGS },
          enabledBy: owner,
          now: nowIso,
          watch: {
            taskId: task.id,
            maxFixAttempts: resolved.maxFixAttempts,
            extra: claim?.watch?.extra ?? 0,
            since: claim?.watch?.since ?? nowIso,
          },
        });
        continue;
      }
      if (claim.watch && claim.watch.maxFixAttempts !== resolved.maxFixAttempts)
        store.setWatch(prKey, {
          ...claim.watch,
          maxFixAttempts: resolved.maxFixAttempts,
        });
    }
  }

  /**
   * The pre-tool policy stage: what a watching Task's agent may not do.
   * `conversationId` is what the engine names the call's conversation (a
   * Session id on an external engine). Cheap for every call that matches
   * nothing; a match reads the Task.
   */
  guard(input: {
    conversationId: string | undefined;
    toolName: string;
    operationName: string;
    toolArgs: unknown;
  }): PullRequestWatchGuardVerdict | undefined {
    if (!input.conversationId) return undefined;
    const match = matchPullRequestWatchRefusal(
      input.operationName,
      input.toolArgs,
    );
    if (!match || !this.ports.enabled()) return undefined;
    const conversationId = this.ports.conversationOf(input.conversationId);
    const task = this.ports.taskForConversation(conversationId);
    if (!task || !this.resolve(task).watching) return undefined;
    const decision = match.kind === 'ci-config' ? 'ask' : 'deny';
    try {
      this.ports.store()?.recordWatchRefusal({
        id: randomUUID(),
        taskId: task.id,
        conversationId,
        kind: match.kind,
        outcome: decision === 'deny' ? 'refused' : 'asked',
        toolName: input.toolName.slice(0, TOOL_NAME_CHARS),
        detail: match.detail,
        at: new Date(this.now()).toISOString(),
      });
    } catch (error) {
      // The refusal stands even when it cannot be recorded.
      this.ports.logger.warn('Pull request watch refusal not recorded', {
        taskId: task.id,
        error: errorMessage(error),
      });
    }
    this.ports.logger.info?.('Pull request watch refused an agent action', {
      taskId: task.id,
      kind: match.kind,
      decision,
    });
    return { kind: match.kind, decision, predicate: PREDICATES[match.kind] };
  }

  /** The delivery's `onFixBudgetSpent`: hold the Task for its person. */
  fixBudgetSpent(input: {
    claim: PullRequestFeedbackClaim;
    failing: readonly string[];
  }): void {
    const taskId = input.claim.watch?.taskId;
    if (!taskId) return;
    void this.ports
      .holdTask({
        taskId,
        hold: {
          checks: [...input.failing],
          pullRequest: label(input.claim.identity),
          at: new Date(this.now()).toISOString(),
        },
      })
      .catch((error) =>
        this.ports.logger.warn('Pull request watch could not hold the Task', {
          taskId,
          error: errorMessage(error),
        }),
      );
  }

  /** `GET /api/tasks/:taskId/pull-request-watch`. */
  view(task: TaskRecord): TaskPullRequestWatchView {
    const project = this.ports.project(task.projectId);
    const resolved = this.resolve(task);
    const store = this.ports.readStore();
    const pullRequests: TaskPullRequestWatchPullRequest[] = [];
    const seen = new Set<string>();
    for (const keep of this.ports.keeps(task.id)) {
      const identity = identityOf(keep);
      const prKey = pullRequestFeedbackKey(identity);
      if (seen.has(prKey)) continue;
      seen.add(prKey);
      const claim = store?.claim(prKey);
      const ours = claim?.watch?.taskId === task.id;
      const max = ours
        ? claim!.watch!.maxFixAttempts + claim!.watch!.extra
        : resolved.maxFixAttempts;
      pullRequests.push({
        identity,
        ...(keep.provider === 'github' && /^\d+$/.test(keep.ref)
          ? {
              url: `https://${identity.host}/${encodeURIComponent(identity.repository.owner)}/${encodeURIComponent(identity.repository.name)}/pull/${keep.ref}`,
            }
          : {}),
        watch: this.stateOf(store, claim, task, ours),
        fixAttempts:
          ours && store ? store.fixAttempts(prKey, claim!.watch!.since) : 0,
        maxFixAttempts: max,
      });
    }
    return {
      taskId: task.id,
      watching: resolved.watching,
      source: resolved.source,
      mode: task.pullRequestWatch ?? 'project',
      projectEnabled: project?.pullRequestWatch?.enabled === true,
      maxFixAttempts: resolved.maxFixAttempts,
      available: this.ports.enabled(),
      pullRequests,
      refusals: (store?.watchRefusals(task.id, REFUSALS_SHOWN) ?? []).map(
        ({ id, at, kind, outcome, toolName, detail }) => ({
          id,
          at,
          kind,
          outcome,
          toolName,
          detail,
        }),
      ),
    };
  }

  private stateOf(
    store: PullRequestFeedbackStore | undefined,
    claim: PullRequestFeedbackClaim | undefined,
    task: TaskRecord,
    ours: boolean,
  ): TaskPullRequestWatchState {
    if (!claim || !store) return { state: 'watching' };
    if (!ours) {
      return pullRequestFeedbackSends(claim.settings)
        ? { state: 'elsewhere' }
        : { state: 'watching' };
    }
    const condition = claim.condition;
    if (condition?.state === 'closed') return { state: 'closed' };
    if (condition?.state === 'unavailable') return { state: 'unavailable' };
    if (condition?.state === 'paused' && condition.reason === 'fix-budget')
      return {
        state: 'budget-spent',
        failing: condition.failing ?? task.pullRequestWatchHold?.checks ?? [],
        headSha: condition.headSha,
      };
    const observation = store.observation(claim.prKey)?.observation;
    const reviewHold = this.ports.headReviewHold?.(claim.prKey);
    if (reviewHold) return reviewHold;
    const report = store.latestWatchReport(claim.prKey);
    if (
      report?.kind === 'ready' &&
      observation?.state === 'OPEN' &&
      observation.headSha === report.headSha
    )
      return { state: 'ready', headSha: report.headSha, at: report.at };
    const waiting = store
      .pendingDeliveries(claim.conversationId)
      .some((delivery) => delivery.prKey === claim.prKey);
    const open = store.openBatch(claim.conversationId);
    if (
      waiting ||
      open?.summary.some((entry) => entry.prKey === claim.prKey) ||
      (report?.kind !== 'ready' &&
        store
          .deliveriesForPullRequest(claim.prKey, 1)
          .some(
            (delivery) =>
              delivery.state === 'sent' &&
              delivery.headSha === observation?.headSha,
          ))
    )
      return { state: 'fixing' };
    return { state: 'watching' };
  }
}

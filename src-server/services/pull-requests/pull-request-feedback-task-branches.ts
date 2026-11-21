/**
 * Project defaults for pull request agent feedback, and the pull requests a
 * Task's agent opens from that Task's own branch (`branch-derived`).
 *
 * A person turns the defaults on once for a Project. Station then looks,
 * boundedly, for an open pull request whose head is exactly a live Task's
 * own recorded worktree branch, in the Project's own repository, not from a
 * fork. One it finds is shown in the Task lead's chat ("from this Task's
 * branch") and, when nobody has set that pull request up (no claim row of
 * any kind: any row means a person engaged with it) and the person who set
 * the defaults may still continue the lead's chat, its feedback is turned
 * on with the defaults' switches, as that person. Later changes to the
 * defaults never touch a claim already made; a person removing the pull
 * request from the chat keeps it out for good.
 *
 * Bounds: at most `MAX_READS_PER_TICK` forge reads per scheduler tick,
 * riding the feedback poller's own tick, single flight and rate-limit
 * backoff; each Task at most once every 10 minutes after its lead's turn
 * ends, otherwise once every 30 minutes; never a Task that already has a
 * derived link.
 */

import { resolve } from 'node:path';
import type {
  ConversationPullRequestLink,
  PullRequestLinkIdentity,
} from '@kontourai/station-contracts/conversation-pull-request-links';
import {
  type ProjectPullRequestFeedbackDefaults,
  type PullRequestFeedbackSettings,
  pullRequestFeedbackActive,
  pullRequestFeedbackKey,
} from '@kontourai/station-contracts/pull-request-feedback';
import type { IPullRequestProvider } from '@kontourai/station-contracts/pull-request-provider';
import type { WorktreeSessionMetadata } from '@kontourai/station-contracts/workspace-isolation';
import { errorMessage } from '../../utils/error-message.js';
import { expandTilde } from '../../utils/paths.js';
import type { FeedbackSessionState } from './pull-request-feedback-delivery.js';
import type { PullRequestFeedbackStore } from './pull-request-feedback-store.js';

const MINUTE = 60_000;
const MAX_READS_PER_TICK = 3;
/** After the lead's turn ends. */
const NUDGED_INTERVAL_MS = 10 * MINUTE;
/** The sweep, for a Task whose lead has not finished a turn since. */
const SWEEP_INTERVAL_MS = 30 * MINUTE;

/** What discovery reads of a Task. */
export interface TaskBranchTask {
  id: string;
  createdAt: string;
  projectId: string;
  status: string;
  /** The Task's lead Session. */
  sessionId?: string;
}

/** What discovery and the defaults read of a Project. */
export interface TaskBranchProject {
  id: string;
  slug: string;
  createdAt: string;
  workingDirectory?: string;
}

export interface PullRequestFeedbackTaskBranchPorts {
  enabled(): boolean;
  /** Opened on first write. */
  store(): PullRequestFeedbackStore | undefined;
  /** Undefined until something was written. */
  readStore(): PullRequestFeedbackStore | undefined;
  tasks(): readonly TaskBranchTask[];
  /** A Project by its id or its slug (a Task records either). */
  project(idOrSlug: string): TaskBranchProject | undefined;
  /** The Task's own recorded worktree, for its current incarnation. */
  taskWorktree(taskId: string): WorktreeSessionMetadata | undefined;
  /** The Task a Session runs for, when Station bound one to it. */
  taskOfSession?(sessionId: string): string | undefined;
  /** `host/owner/name` from the checkout's origin, or `local:…`. */
  repositoryIdentity(path: string): Promise<string>;
  providers(): IPullRequestProvider[];
  conversationOf(sessionId: string): string;
  session(conversationId: string): FeedbackSessionState;
  mayContinue(conversationId: string, userId: string): boolean;
  /**
   * The head review preview: while off, a default's "Review each new head"
   * neither makes a claim nor is copied into one, and cannot be set.
   */
  headReviewEnabled?(): boolean;
  readonly logger: {
    warn(message: string, meta?: Record<string, unknown>): void;
  };
  now?(): number;
}

/**
 * The repository as the forge spells it in the pull request's own URL, when
 * that URL names this repository; otherwise the checkout origin's
 * (lowercased) spelling. Keeps one pull request one row beside a link a
 * person typed with the forge's capitals.
 */
function forgeSpelling(
  url: string,
  host: string,
  owner: string,
  name: string,
): { owner: string; name: string } {
  try {
    const parsed = new URL(url);
    const [urlOwner, urlName] = parsed.pathname.split('/').filter(Boolean);
    if (
      parsed.host.toLowerCase() === host &&
      urlOwner?.toLowerCase() === owner.toLowerCase() &&
      urlName?.toLowerCase() === name.toLowerCase()
    )
      return { owner: urlOwner, name: urlName };
  } catch {
    // An unreadable URL keeps the origin's spelling.
  }
  return { owner, name };
}

const LIVE = (status: string) => status !== 'done' && status !== 'canceled';
const taskKey = (task: Pick<TaskBranchTask, 'id' | 'createdAt'>) =>
  `${task.id}\u0000${task.createdAt}`;

export class PullRequestFeedbackTaskBranches {
  private readonly lastRead = new Map<string, number>();
  private readonly nudged = new Set<string>();

  constructor(private readonly ports: PullRequestFeedbackTaskBranchPorts) {}

  private now(): number {
    return this.ports.now?.() ?? Date.now();
  }

  private headReviewOn(): boolean {
    return this.ports.headReviewEnabled?.() ?? false;
  }

  /** The Task whose lead this conversation is, if any. */
  private leadTasks(conversationId: string, sessionId?: string) {
    const bound = sessionId ? this.ports.taskOfSession?.(sessionId) : undefined;
    return this.ports
      .tasks()
      .filter(
        (task) =>
          LIVE(task.status) &&
          !!task.sessionId &&
          (task.id === bound ||
            this.ports.conversationOf(task.sessionId) === conversationId),
      );
  }

  /** A turn ended: look at that conversation's Task soon (next tick). */
  nudge(conversationId: string, sessionId?: string): void {
    if (
      !this.ports.enabled() ||
      !this.ports.readStore()?.anyProjectDefaultsOn(this.headReviewOn())
    )
      return;
    for (const task of this.leadTasks(conversationId, sessionId))
      this.nudged.add(taskKey(task));
  }

  /**
   * One discovery pass on the poller's tick. `rate-limited` asks the poller
   * to back off. Never throws.
   */
  async discover(input: {
    now: number;
    signal: AbortSignal;
  }): Promise<'ok' | 'rate-limited'> {
    try {
      return await this.discoverOnce(input);
    } catch (error) {
      this.ports.logger.warn('Pull request feedback discovery failed', {
        error: errorMessage(error),
      });
      return 'ok';
    }
  }

  private async discoverOnce(input: {
    now: number;
    signal: AbortSignal;
  }): Promise<'ok' | 'rate-limited'> {
    if (!this.ports.enabled()) return 'ok';
    const store = this.ports.readStore();
    if (!store?.anyProjectDefaultsOn(this.headReviewOn())) return 'ok';
    const due = [];
    // One Project read per tick, however many of its Tasks there are.
    const projects = new Map<string, TaskBranchProject | undefined>();
    const projectOf = (idOrSlug: string) => {
      if (!projects.has(idOrSlug))
        projects.set(idOrSlug, this.ports.project(idOrSlug));
      return projects.get(idOrSlug);
    };
    for (const task of this.ports.tasks()) {
      if (!LIVE(task.status) || !task.sessionId) continue;
      const key = taskKey(task);
      const last = this.lastRead.get(key);
      const interval = this.nudged.has(key)
        ? NUDGED_INTERVAL_MS
        : SWEEP_INTERVAL_MS;
      if (last !== undefined && input.now - last < interval) continue;
      const project = projectOf(task.projectId);
      // A recorded `~/…` folder is the host user's (station#3155).
      const workingDirectory = project?.workingDirectory
        ? resolve(expandTilde(project.workingDirectory))
        : undefined;
      if (!project || !workingDirectory) continue;
      const defaults = store.projectDefaults(project.id, project.createdAt);
      if (
        !defaults ||
        !pullRequestFeedbackActive(defaults.settings, this.headReviewOn())
      )
        continue;
      if (store.hasDerivedLinks(task.id, task.createdAt)) continue;
      const worktree = this.ports.taskWorktree(task.id);
      // Only the Task's own worktree: its branch is the Task's alone.
      if (worktree?.owner?.kind !== 'task' || worktree.owner.taskId !== task.id)
        continue;
      const conversationId = this.ports.conversationOf(task.sessionId);
      if (this.ports.session(conversationId).state === 'stopped') continue;
      due.push({
        task,
        key,
        last: last ?? 0,
        project,
        worktree,
        conversationId,
      });
    }
    due.sort((a, b) => a.last - b.last);
    const identities = new Map<string, Promise<string>>();
    const identity = (path: string) => {
      let read = identities.get(path);
      if (!read) {
        read = this.ports.repositoryIdentity(path).catch(() => '');
        identities.set(path, read);
      }
      return read;
    };
    for (const entry of due.slice(0, MAX_READS_PER_TICK)) {
      if (input.signal.aborted) break;
      this.lastRead.set(entry.key, input.now);
      this.nudged.delete(entry.key);
      const outcome = await this.discoverTask(entry, identity, input);
      if (outcome === 'rate-limited') return 'rate-limited';
    }
    return 'ok';
  }

  private async discoverTask(
    entry: {
      task: TaskBranchTask;
      project: TaskBranchProject;
      worktree: WorktreeSessionMetadata;
      conversationId: string;
    },
    identity: (path: string) => Promise<string>,
    input: { now: number; signal: AbortSignal },
  ): Promise<'ok' | 'rate-limited'> {
    const { task, project, worktree, conversationId } = entry;
    const projectRepository = await identity(
      resolve(expandTilde(project.workingDirectory ?? '')),
    );
    // The worktree is the Project's own repository, and that repository
    // is on a forge (not a local-only checkout).
    if (
      !projectRepository ||
      projectRepository.startsWith('local:') ||
      (await identity(worktree.repoPath)) !== projectRepository
    )
      return 'ok';
    const parts = projectRepository.split('/');
    if (parts.length !== 3 || parts.some((part) => !part)) return 'ok';
    const [host, owner, name] = parts as [string, string, string];
    const provider = this.ports
      .providers()
      .find(
        (candidate) =>
          candidate.canServeHost(host) && candidate.findOpenPullRequestsByHead,
      );
    if (!provider?.findOpenPullRequestsByHead) return 'ok';
    const read = await provider.findOpenPullRequestsByHead(
      { host, repository: { owner, name } },
      worktree.branch,
      input.signal,
    );
    if (read.state === 'unavailable')
      return read.cause === 'rate-limited' ? 'rate-limited' : 'ok';
    const own = read.pullRequests.filter(
      (pr) =>
        pr.headRefName === worktree.branch &&
        !pr.crossRepository &&
        pr.headOwner.toLowerCase() === owner.toLowerCase(),
    );
    if (own.length === 0) return 'ok';
    const store = this.ports.store();
    if (!store) return 'ok';
    const nowIso = new Date(this.now()).toISOString();
    // Read again after the forge read: a person may have turned the
    // defaults off meanwhile.
    const defaults = store.projectDefaults(project.id, project.createdAt);
    for (const pr of own) {
      const prIdentity: PullRequestLinkIdentity = {
        provider: provider.id,
        host,
        repository: forgeSpelling(pr.url, host, owner, name),
        ref: pr.ref,
      };
      const prKey = pullRequestFeedbackKey(prIdentity);
      // Removed from this Task's chat once: never again, whichever
      // incarnation of the Task found it. Recorded removed for this
      // incarnation too, so discovery is done with it.
      const removed = store.dismissedForTask(task.id, prKey);
      store.recordDerivedLink({
        taskId: task.id,
        taskCreatedAt: task.createdAt,
        projectId: project.id,
        conversationId,
        prKey,
        identity: prIdentity,
        headRef: worktree.branch,
        derivedAt: nowIso,
        ...(removed ? { dismissedAt: nowIso } : {}),
      });
      if (removed) continue;
      if (
        defaults &&
        pullRequestFeedbackActive(defaults.settings, this.headReviewOn()) &&
        this.ports.mayContinue(conversationId, defaults.setBy)
      )
        store.autoClaim({
          prKey,
          identity: prIdentity,
          taskId: task.id,
          conversationId,
          // "Review each new head" is copied only while it is offered.
          settings: {
            ...defaults.settings,
            reviewEachHead:
              this.headReviewOn() && defaults.settings.reviewEachHead,
          },
          enabledBy: defaults.setBy,
          now: nowIso,
        });
    }
    return 'ok';
  }

  /** The chat's branch-derived pull requests, as link rows. */
  derivedLinks(conversationId: string): ConversationPullRequestLink[] {
    return (this.ports.readStore()?.derivedLinks(conversationId) ?? []).map(
      (link) => ({
        provider: link.identity.provider,
        host: link.identity.host,
        repository: {
          owner: link.identity.repository.owner,
          name: link.identity.repository.name,
        },
        ref: link.identity.ref,
        source: 'branch-derived',
        linkedAt: link.derivedAt,
      }),
    );
  }

  /** Remove a derived pull request from its chat, for good. */
  dismiss(conversationId: string, identity: PullRequestLinkIdentity): boolean {
    const store = this.ports.readStore();
    return !!store?.dismissDerivedLink(
      conversationId,
      pullRequestFeedbackKey(identity),
      new Date(this.now()).toISOString(),
    );
  }

  /** A Project's defaults as this reader sees them; undefined: no Project. */
  defaults(
    projectSlug: string,
    canChange: boolean,
    /** Only claims in chats this reader may read are counted. */
    canRead: (conversationId: string) => boolean = () => false,
  ): ProjectPullRequestFeedbackDefaults | undefined {
    const project = this.ports.project(projectSlug);
    if (!project || project.slug !== projectSlug) return undefined;
    const store = this.ports.readStore();
    const stored = store?.projectDefaults(project.id, project.createdAt);
    return {
      projectSlug,
      settings: stored
        ? { ...stored.settings }
        : {
            fixFailingChecks: false,
            addressReviewComments: false,
            reviewEachHead: false,
          },
      canChange,
      stillOn:
        store?.projectDefaultClaimsOn(
          project.id,
          canRead,
          this.headReviewOn(),
        ) ?? 0,
    };
  }

  /**
   * Set a Project's defaults as `userId`. A switch the request left out
   * keeps its stored value. Never touches a claim already made.
   */
  writeDefaults(
    projectSlug: string,
    settings: Partial<PullRequestFeedbackSettings>,
    userId: string,
    canRead: (conversationId: string) => boolean = () => false,
  ): ProjectPullRequestFeedbackDefaults | undefined {
    const project = this.ports.project(projectSlug);
    if (!project || project.slug !== projectSlug) return undefined;
    const store = this.ports.store();
    if (!store) return undefined;
    const prior = store.projectDefaults(project.id, project.createdAt)
      ?.settings ?? {
      fixFailingChecks: false,
      addressReviewComments: false,
      reviewEachHead: false,
    };
    store.writeProjectDefaults({
      projectId: project.id,
      projectCreatedAt: project.createdAt,
      settings: {
        fixFailingChecks: settings.fixFailingChecks ?? prior.fixFailingChecks,
        addressReviewComments:
          settings.addressReviewComments ?? prior.addressReviewComments,
        // Ignored while review of each head is not offered (its preview off).
        reviewEachHead:
          (this.headReviewOn() ? settings.reviewEachHead : undefined) ??
          prior.reviewEachHead,
      },
      setBy: userId,
      now: new Date(this.now()).toISOString(),
    });
    return this.defaults(projectSlug, true, canRead);
  }
}

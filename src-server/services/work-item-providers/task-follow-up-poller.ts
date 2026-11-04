/**
 * Bounded GitHub follow-up polling for tracker-backed Tasks (#4508 decision
 * 1). It has no timer of its own: the built-in scheduler calls `poll` on its
 * existing minute tick (`automationPoller` in `runtime-route-support.ts`),
 * and each Task is due again `TASK_FOLLOW_UP_INTERVAL_MS` after its last
 * recorded poll, so a restart neither polls early nor forgets a Task.
 *
 * Off unless the `task-tracker-follow-ups` Feature Preview is on; with it
 * off a poll reads nothing and starts no gh process.
 *
 * Which Tasks: a `workItemRef` that is a github.com issue or pull request
 * the Project's board offered (`workItemProvenance: 'project-board'`, the
 * same rule every other tracker read follows), and either live or ended
 * (`done` or `canceled`) at most `TASK_FOLLOW_UP_ENDED_WINDOW_MS` ago.
 * TaskRecord keeps no end time; an ended Task's `updatedAt` is its end or a
 * later edit, so an edit after the end can keep an ended Task followed past
 * 14 days of its end, never shorter. Nothing here writes the Task record.
 *
 * Which items: the primary work item, then each github.com pull request a
 * person kept on the Task (`listKeptDeclaredPullRequests`, the existing keep
 * rule). A Session declaring a pull request does not make it followed.
 *
 * Observe-and-record only: this slice wakes no Session (delivery is PR2).
 * Only items that happened at or after the Task's creation are recorded,
 * but every page is walked so the cursor reaches the present.
 */

import type {
  TaskKeptDeclaredPullRequest,
  TaskRecord,
} from '@kontourai/station-contracts/task-graph';
import {
  canonicalGitHubWorkItemRef,
  formatGitHubWorkItemRef,
  parseGitHubWorkItemRef,
} from '@kontourai/station-contracts/work-item-provider';
import { errorMessage } from '../../utils/error-message.js';
import type { Logger } from '../../utils/logger.js';
import type {
  FeaturePreviewRegistry,
  FeaturePreviewSelector,
} from '../feature-previews/feature-preview-registry.js';
import type {
  FollowUpItem,
  FollowUpStream,
  GitHubFollowUpReader,
} from './github-follow-up-reader.js';
import type {
  TaskFollowUpStore,
  TaskIncarnation,
} from './task-follow-up-store.js';

export const TASK_FOLLOW_UP_PREVIEW_ID = 'task-tracker-follow-ups';
const TASK_FOLLOW_UP_INTERVAL_MS = 5 * 60 * 1000;
const TASK_FOLLOW_UP_ENDED_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
/** Tasks polled per tick; the rest wait, oldest poll first. */
const MAX_TASKS_PER_POLL = 10;
/** Kept pull requests followed per Task, besides the primary item. */
const MAX_KEPT_PULL_REQUESTS = 10;
/** Pages read per item per poll; a longer history resumes next poll. */
const MAX_PAGES_PER_ITEM = 5;

export interface TaskFollowUpPollSummary {
  outcome: 'disabled' | 'polled' | 'stopped';
  tasks: { taskId: string; items: number; recorded: number; outcome: string }[];
}

export interface TaskFollowUpPollerOptions {
  preview: FeaturePreviewSelector;
  /** Opened lazily: nothing is created while the preview is off. */
  store: () => TaskFollowUpStore | undefined;
  tasks: {
    listTasks(): TaskRecord[];
    listKeptDeclaredPullRequests(taskId: string): TaskKeptDeclaredPullRequest[];
  };
  reader: GitHubFollowUpReader;
  logger?: Pick<Logger, 'warn'>;
}

const isEnded = (task: TaskRecord) =>
  task.status === 'done' || task.status === 'canceled';

/** Whether decision 1 lets this Task be followed at `now`. */
function isTaskFollowable(task: TaskRecord, now: number): boolean {
  if (task.workItemProvenance !== 'project-board') return false;
  if (
    !task.workItemRef ||
    canonicalGitHubWorkItemRef(task.workItemRef) === null
  )
    return false;
  if (!isEnded(task)) return true;
  const endedAt = Date.parse(task.updatedAt);
  return (
    !Number.isNaN(endedAt) && now - endedAt <= TASK_FOLLOW_UP_ENDED_WINDOW_MS
  );
}

function followedItems(
  task: TaskRecord,
  kept: readonly TaskKeptDeclaredPullRequest[],
): string[] {
  const refs = [canonicalGitHubWorkItemRef(task.workItemRef!)!];
  for (const keep of kept) {
    if (refs.length > MAX_KEPT_PULL_REQUESTS) break;
    if (keep.provider !== 'github' || keep.host.toLowerCase() !== 'github.com')
      continue;
    if (!/^[1-9]\d{0,9}$/.test(keep.ref)) continue;
    const ref = canonicalGitHubWorkItemRef(
      formatGitHubWorkItemRef({
        owner: keep.repository.owner,
        repo: keep.repository.name,
        number: Number(keep.ref),
      }),
    );
    if (ref && !refs.includes(ref)) refs.push(ref);
  }
  return refs;
}

export class TaskFollowUpPoller {
  constructor(private readonly options: TaskFollowUpPollerOptions) {}

  async poll(input: {
    now: number;
    signal: AbortSignal;
  }): Promise<TaskFollowUpPollSummary> {
    const enabled = this.options.preview.select({
      enabled: () => true,
      disabled: () => false,
    });
    if (!enabled) return { outcome: 'disabled', tasks: [] };
    const store = this.options.store();
    if (!store) return { outcome: 'stopped', tasks: [] };
    const due = this.options.tasks
      .listTasks()
      .filter((task) => isTaskFollowable(task, input.now))
      .map((task) => {
        const incarnation = { taskId: task.id, taskCreatedAt: task.createdAt };
        const last = store.lastPolledAt(incarnation);
        return { task, incarnation, last: last ? Date.parse(last) : 0 };
      })
      .filter(({ last }) => input.now - last >= TASK_FOLLOW_UP_INTERVAL_MS)
      .sort((a, b) => a.last - b.last)
      .slice(0, MAX_TASKS_PER_POLL);
    const summary: TaskFollowUpPollSummary = { outcome: 'polled', tasks: [] };
    for (const { task, incarnation } of due) {
      if (input.signal.aborted) return { ...summary, outcome: 'stopped' };
      const items = followedItems(
        task,
        this.options.tasks.listKeptDeclaredPullRequests(task.id),
      );
      let recorded = 0;
      const failures: string[] = [];
      for (const itemRef of items) {
        if (input.signal.aborted) break;
        try {
          const result = await this.pollItem(
            store,
            incarnation,
            itemRef,
            input,
          );
          recorded += result.recorded;
          if (result.failure) failures.push(`${itemRef}: ${result.failure}`);
        } catch (error) {
          failures.push(`${itemRef}: ${errorMessage(error)}`);
        }
      }
      if (input.signal.aborted) return { ...summary, outcome: 'stopped' };
      const outcome = failures.length ? 'partial' : 'ok';
      if (failures.length)
        this.options.logger?.warn(
          'Task follow-up poll could not read every item',
          {
            taskId: task.id,
            failures,
          },
        );
      store.markPolled(incarnation, new Date(input.now).toISOString(), outcome);
      summary.tasks.push({
        taskId: task.id,
        items: items.length,
        recorded,
        outcome,
      });
    }
    return summary;
  }

  private async pollItem(
    store: TaskFollowUpStore,
    task: TaskIncarnation,
    itemRef: string,
    input: { now: number; signal: AbortSignal },
  ): Promise<{ recorded: number; failure?: string }> {
    const identity = parseGitHubWorkItemRef(itemRef)!;
    const after: Partial<Record<FollowUpStream, string>> = {};
    for (const stream of ['comments', 'reviews'] as const) {
      const cursor = store.readCursor(task, itemRef, stream);
      if (cursor) after[stream] = cursor;
    }
    const since = Date.parse(task.taskCreatedAt);
    const recordedAt = new Date(input.now).toISOString();
    let recorded = 0;
    for (let page = 0; page < MAX_PAGES_PER_ITEM; page += 1) {
      if (input.signal.aborted) break;
      const result = await this.options.reader.readPage({
        owner: identity.owner,
        repo: identity.repo,
        number: identity.number,
        after: { ...after },
        withChecks: page === 0,
        signal: input.signal,
      });
      if (result.status !== 'read') return { recorded, failure: result.reason };
      const { comments, reviews, checks } = result.page;
      const items: FollowUpItem[] = [
        ...comments.items,
        ...(reviews?.items ?? []),
        ...(checks ?? []),
      ].filter((item) => Date.parse(item.occurredAt) >= since);
      const cursors: Partial<Record<FollowUpStream, string>> = {
        ...(comments.lastCursor ? { comments: comments.lastCursor } : {}),
        ...(reviews?.lastCursor ? { reviews: reviews.lastCursor } : {}),
      };
      recorded += store.recordPage(
        task,
        itemRef,
        { items, cursors },
        recordedAt,
      );
      Object.assign(after, cursors);
      if (!comments.hasNextPage && !reviews?.hasNextPage) break;
    }
    return { recorded };
  }
}

export function composeTaskFollowUpPoller(
  featurePreviews: FeaturePreviewRegistry,
  hosted: boolean,
  options: Omit<TaskFollowUpPollerOptions, 'preview'>,
): TaskFollowUpPoller | undefined {
  // Hosted tenants have no host gh login of their own to read with.
  if (hosted) return undefined;
  const preview = featurePreviews.bind({
    id: 'task-tracker-follow-ups',
    label: 'Task tracker follow-ups',
    description:
      'Every few minutes, read new comments, reviews and check results on the GitHub items of tracker-backed Tasks, and show them in the Task brief. Uses the host gh login and GitHub API requests.',
  });
  return new TaskFollowUpPoller({ ...options, preview });
}

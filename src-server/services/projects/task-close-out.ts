/**
 * #3161: close a Task out when every pull request kept on it has merged.
 *
 * The close is derived from provider state and from nothing an agent says:
 * a person opts a Task in (`TaskRecord.closeOnMerge`), a person keeps pull
 * requests onto it, and the Task moves to `done` only when the provider
 * reports every one of those kept pull requests `MERGED`. A pull request
 * that was closed without merging is not merged, so it keeps the Task open.
 *
 * It is a reconciliation, never a loop of its own. It runs when a read that
 * already refreshes provider state (the conversation pull request refresh)
 * observes a merge, reads each kept pull request at its exact identity (a
 * bounded handful, four at a time) and asks the Task graph to move the Task,
 * which re-decides under its own lock: the Task incarnation it read, the
 * opt-in, `canTransitionTaskStatus`, and that no pull request was kept in the
 * meantime.
 */
import type { TaskKeptDeclaredPullRequest } from '@kontourai/station-contracts';
import type { IPullRequestProvider } from '@kontourai/station-contracts/pull-request-provider';
import { readPullRequestByIdentity } from '../pull-requests/pull-request-identity-read.js';
import type { TaskGraphService } from './task-graph-service.js';

/** More kept pull requests than this are not reconciled: the Task stays open. */
const MAX_KEPT_PULL_REQUESTS = 20;
const READ_CONCURRENCY = 4;
/** Tasks one observation may reconcile. */
const MAX_TASKS_PER_OBSERVATION = 8;

type TaskCloseOutOutcome = 'closed' | 'pending' | 'not-applicable';

interface TaskCloseOut {
  /** Reconcile one Task now. */
  reconcile(taskId: string): Promise<TaskCloseOutOutcome>;
  /**
   * A refresh observed these pull requests merged. Reconciles, detached, the
   * Tasks that kept one of them from a session in `sessionIds`. Never throws
   * and never waits.
   */
  afterMergeObserved(
    sessionIds: readonly string[],
    merged: readonly {
      provider: string;
      host: string;
      repository: { owner: string; name: string };
      ref: string;
    }[],
  ): void;
}

const lower = (value: string) => value.toLowerCase();

/**
 * The exact pull request, component by component. The provider's own answer
 * must agree with the keep on provider, host, repository, number and native
 * id; `owner/repo-2` is not `owner/repo`, so nothing is matched as a string.
 */
function sameKeptPullRequest(
  keep: TaskKeptDeclaredPullRequest,
  observed: {
    provider: string;
    host: string;
    repository: { owner: string; name: string };
    ref: string;
    nativeId?: string;
  },
): boolean {
  return (
    keep.provider === observed.provider &&
    lower(keep.host) === lower(observed.host) &&
    lower(keep.repository.owner) === lower(observed.repository.owner) &&
    lower(keep.repository.name) === lower(observed.repository.name) &&
    keep.ref === observed.ref &&
    (observed.nativeId === undefined || keep.nativeId === observed.nativeId)
  );
}

export function createTaskCloseOut(deps: {
  taskGraph: Pick<
    TaskGraphService,
    | 'readCloseOutPlan'
    | 'completeTaskOnMerge'
    | 'listKeptDeclaredPullRequestsForSessions'
  >;
  providers: () => IPullRequestProvider[];
  onError?: (error: unknown) => void;
}): TaskCloseOut {
  const inFlight = new Set<string>();

  const reconcile = async (taskId: string): Promise<TaskCloseOutOutcome> => {
    const plan = deps.taskGraph.readCloseOutPlan(taskId);
    if (!plan) return 'not-applicable';
    if (plan.keeps.length > MAX_KEPT_PULL_REQUESTS) return 'pending';
    const merged: TaskKeptDeclaredPullRequest[] = [];
    for (let at = 0; at < plan.keeps.length; at += READ_CONCURRENCY) {
      const batch = plan.keeps.slice(at, at + READ_CONCURRENCY);
      const reads = await Promise.all(
        batch.map((keep) => readPullRequestByIdentity(deps.providers, keep)),
      );
      batch.forEach((keep, index) => {
        const read = reads[index];
        if (
          read?.kind === 'current' &&
          // The provider's own word, and exactly MERGED: a pull request that
          // is CLOSED, OPEN, LOCKED or in any state we have not named is not
          // merged.
          read.pullRequest.state === 'MERGED' &&
          sameKeptPullRequest(keep, read.pullRequest)
        )
          merged.push(keep);
      });
      // A pull request not merged settles the question; stop reading.
      if (merged.length < Math.min(at + READ_CONCURRENCY, plan.keeps.length))
        return 'pending';
    }
    const moved = await deps.taskGraph.completeTaskOnMerge({
      taskId,
      taskCreatedAt: plan.taskCreatedAt,
      mergedKeeps: merged.map((keep) => ({
        declarationId: keep.provenance.declarationId,
        provider: keep.provider,
        host: keep.host,
        repository: keep.repository,
        ref: keep.ref,
        nativeId: keep.nativeId,
      })),
    });
    return moved ? 'closed' : 'pending';
  };

  return {
    reconcile,
    afterMergeObserved(sessionIds, merged) {
      let taskIds: string[];
      try {
        taskIds = [
          ...new Set(
            deps.taskGraph
              .listKeptDeclaredPullRequestsForSessions(sessionIds)
              .filter((keep) =>
                merged.some((observed) => sameKeptPullRequest(keep, observed)),
              )
              .map((keep) => keep.taskId),
          ),
        ].slice(0, MAX_TASKS_PER_OBSERVATION);
      } catch (error) {
        deps.onError?.(error);
        return;
      }
      for (const taskId of taskIds) {
        // One reconcile per Task at a time: a page that refreshes often must
        // not stack provider reads behind each other.
        if (inFlight.has(taskId)) continue;
        inFlight.add(taskId);
        void reconcile(taskId)
          .catch((error) => deps.onError?.(error))
          .finally(() => inFlight.delete(taskId));
      }
    },
  };
}

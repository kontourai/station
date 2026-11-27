import { resolve } from 'node:path';
import type { ProjectConfig } from '@kontourai/station-contracts/project';
import type { IndependentReviewRequestStatus } from '@kontourai/station-contracts/review-evidence';
import {
  type TaskRecord,
  taskWorkingDirectory,
} from '@kontourai/station-contracts/task-graph';
import type {
  TaskCodeReviewEntry,
  TaskCodeReviewRequest,
  TaskCodeReviewView,
  TaskCodeReviewWorkspace,
} from '@kontourai/station-contracts/task-review';
import { execGit } from '../../utils/git-exec.js';
import { expandTilde } from '../../utils/paths.js';
import type { SessionOwnerStamp } from '../orchestration/session-owner-attribution.js';
import { readProjectRepository } from '../projects/git-read-repository.js';
import { listVerifiedWorktrees } from '../projects/verified-worktrees.js';
import { readReviewRepositoryIdentity } from './git-review-workspace-source.js';
import type {
  ReviewEvidenceModule,
  ReviewTaskBinding,
} from './review-evidence-module.js';
import type { FileReviewReceiptStore } from './review-receipt-store.js';

export interface TaskCodeReviewScope {
  task: TaskRecord;
  project: ProjectConfig;
  owner: SessionOwnerStamp;
  assertCurrent(): void;
  assertMayExecute(): void;
}

export class TaskCodeReviewError extends Error {
  constructor(
    readonly code:
      | 'forbidden'
      | 'invalid-request'
      | 'project-changed'
      | 'unavailable'
      | 'feature_preview_disabled',
    message: string,
  ) {
    super(message);
  }
}

/** Projects Task associations from the review submission owner; never creates a verdict. */
export class TaskCodeReviewModule {
  constructor(
    private readonly deps: {
      reviews: Pick<ReviewEvidenceModule, 'run' | 'status'>;
      submissions: Pick<
        FileReviewReceiptStore,
        'taskRequestIds' | 'hasTaskRequest'
      >;
      reviewers(
        project: ProjectConfig,
        implementer?: string,
      ): Promise<{ slug: string; name: string }[]>;
      baseCommit(taskId: string): string | undefined;
      reportError(error: unknown): void;
    },
  ) {}

  private binding(scope: TaskCodeReviewScope): ReviewTaskBinding {
    return {
      projectId: scope.project.id,
      projectCreatedAt: scope.project.createdAt,
      taskId: scope.task.id,
      taskCreatedAt: scope.task.createdAt,
    };
  }

  async read(scope: TaskCodeReviewScope): Promise<TaskCodeReviewView> {
    scope.assertCurrent();
    const workspace = await this.workspace(scope);
    const reviewers = await this.deps.reviewers(
      scope.project,
      scope.task.agentId,
    );
    let requestsUnavailable = false;
    let omittedRequests = 0;
    const requests: TaskCodeReviewEntry[] = [];
    try {
      const ids = await this.deps.submissions.taskRequestIds(
        scope.project.slug,
        this.binding(scope),
      );
      omittedRequests = ids.omitted;
      for (const id of ids.requestIds) {
        scope.assertCurrent();
        const status = await this.deps.reviews.status(id, scope.project.slug);
        if (!status) throw new Error('Task review submission is unavailable.');
        const receipt = status.result?.receipt;
        requests.push({
          requestId: id,
          state: status.state,
          startedAt: status.startedAt,
          updatedAt: status.updatedAt,
          ...(status.failureReason
            ? { failureReason: status.failureReason }
            : {}),
          ...(receipt
            ? {
                receiptId: receipt.receiptId,
                baseSha: receipt.target.baseSha,
                headSha: receipt.target.headSha,
              }
            : {}),
          freshness:
            !receipt || !workspace.repositoryId || !workspace.headSha
              ? 'unavailable'
              : receipt.target.repositoryId === workspace.repositoryId &&
                  receipt.target.headSha === workspace.headSha
                ? 'same-revision'
                : 'different-revision',
          findings: receipt?.findings.slice(0, 8) ?? [],
          omittedFindings: Math.max(0, (receipt?.findings.length ?? 0) - 8),
          reviewers:
            receipt?.executions.map((entry) => ({
              name: entry.actor.displayName ?? entry.executorAgentSlug,
              status: entry.status,
            })) ?? [],
        });
      }
    } catch (error) {
      this.deps.reportError(error);
      requestsUnavailable = true;
    }
    scope.assertCurrent();
    const { repositoryId: _repositoryId, ...publicWorkspace } = workspace;
    let canRequest = true;
    try {
      scope.assertMayExecute();
    } catch {
      canRequest = false;
    }
    return {
      version: 'station.task-code-review/v1',
      projectId: scope.project.id,
      projectCreatedAt: scope.project.createdAt,
      taskCreatedAt: scope.task.createdAt,
      projectSlug: scope.project.slug,
      workspace: publicWorkspace,
      canRequest,
      ...(!canRequest
        ? {
            requestUnavailableReason:
              scope.task.status === 'done' || scope.task.status === 'canceled'
                ? ('task-ended' as const)
                : ('execution-not-authorized' as const),
          }
        : {}),
      ...(scope.task.agentId
        ? { implementerAgentSlug: scope.task.agentId }
        : {}),
      reviewers,
      requests,
      omittedRequests,
      requestsUnavailable,
    };
  }

  async run(
    scope: TaskCodeReviewScope,
    input: TaskCodeReviewRequest,
  ): Promise<IndependentReviewRequestStatus> {
    scope.assertCurrent();
    if (
      input.projectId !== scope.project.id ||
      input.projectCreatedAt !== scope.project.createdAt
    )
      throw new TaskCodeReviewError(
        'project-changed',
        'The Project changed. Reopen this Task before requesting review.',
      );
    scope.assertMayExecute();
    if (
      input.taskCreatedAt !== scope.task.createdAt ||
      !scope.task.agentId ||
      scope.task.status === 'done' ||
      scope.task.status === 'canceled'
    )
      throw new TaskCodeReviewError(
        'invalid-request',
        'This Task cannot request a new review.',
      );
    const reviewers = await this.deps.reviewers(
      scope.project,
      scope.task.agentId,
    );
    if (!reviewers.some((entry) => entry.slug === input.reviewerAgentSlug))
      throw new TaskCodeReviewError(
        'invalid-request',
        'Choose an available independent reviewer.',
      );
    const existing = await this.deps.submissions.hasTaskRequest(
      scope.project.slug,
      input.requestId,
      this.binding(scope),
    );
    if (!existing) {
      const workspace = await this.workspace(scope);
      scope.assertCurrent();
      scope.assertMayExecute();
      if (
        workspace.state !== 'available' ||
        workspace.headSha !== input.headSha
      )
        throw new TaskCodeReviewError(
          'invalid-request',
          'The Task checkout changed or is unavailable. Refresh before requesting review.',
        );
    }
    // The submitted SHAs remain frozen across retries, even if the branch advances.
    const status = await this.deps.reviews.run(
      {
        requestId: input.requestId,
        mode: 'initial',
        target: {
          kind: 'git-range',
          projectSlug: scope.project.slug,
          baseRevision: input.baseSha,
          headRevision: input.headSha,
        },
        implementerAgentSlug: scope.task.agentId,
        reviewers: [
          {
            reviewerId: 'task-code-review',
            executorAgentSlug: input.reviewerAgentSlug,
            lens: {
              id: 'correctness',
              instructions:
                'Review the exact committed change for correctness, security and data integrity. Report only actionable findings with a concrete failure scenario. Do not edit files. Uncommitted changes are outside this review.',
            },
          },
        ],
      },
      {
        requestedBy: { actorId: scope.owner.ownerUserId },
        userId: scope.owner.ownerUserId,
        ...(scope.owner.ownerAttribution
          ? { ownerAttribution: scope.owner.ownerAttribution }
          : {}),
        taskBinding: this.binding(scope),
        assertCurrent: () => {
          scope.assertCurrent();
          scope.assertMayExecute();
        },
      },
    );
    scope.assertCurrent();
    return status;
  }

  private async workspace(
    scope: TaskCodeReviewScope,
  ): Promise<TaskCodeReviewWorkspace & { repositoryId?: string }> {
    const directory = taskWorkingDirectory(scope.task);
    const projectRoot = scope.project.workingDirectory
      ? resolve(expandTilde(scope.project.workingDirectory))
      : undefined;
    const kind: TaskCodeReviewWorkspace['kind'] = scope.task.taskWorktreeUnknown
      ? 'unknown'
      : scope.task.taskWorktree
        ? 'task-worktree'
        : 'project-checkout';
    if (
      !directory ||
      !projectRoot ||
      scope.task.workspaceBinding?.availability !== 'available'
    )
      return { state: 'unavailable', kind };
    const cwd = resolve(expandTilde(directory));
    try {
      const observed = await readProjectRepository(
        projectRoot,
        cwd,
        {
          registeredWorktrees: () => listVerifiedWorktrees(projectRoot, 5000),
          timeoutMs: 5000,
        },
        async (repository) => {
          const git = async (args: string[]) => {
            scope.assertCurrent();
            return (
              await execGit([...repository.repoArgs, ...args], {
                cwd,
                timeout: 5000,
                maxBuffer: 1024 * 1024,
                assertCurrent: scope.assertCurrent,
              })
            ).stdout.trim();
          };
          const headSha = await git(['rev-parse', '--verify', 'HEAD^{commit}']);
          const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
          const dirty =
            (
              await git([
                'status',
                '--porcelain=v1',
                '--untracked-files=normal',
              ])
            ).length > 0;
          let baseSha = this.deps.baseCommit(scope.task.id);
          if (!baseSha) {
            try {
              baseSha = await git(['merge-base', headSha, 'origin/main']);
            } catch {
              try {
                baseSha = await git(['rev-parse', '--verify', 'HEAD^']);
              } catch {
                /* An initial commit has no earlier review base. */
              }
            }
          }
          return {
            state: 'available' as const,
            kind,
            path: cwd,
            branch,
            headSha,
            dirty,
            ...(baseSha ? { baseSha } : {}),
          };
        },
      );
      if (!observed.ok) return { state: 'unavailable', kind };
      const repositoryId = await readReviewRepositoryIdentity(projectRoot);
      scope.assertCurrent();
      return { ...observed.value, repositoryId };
    } catch (error) {
      this.deps.reportError(error);
      return { state: 'unavailable', kind };
    }
  }
}

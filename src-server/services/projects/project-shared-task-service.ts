import type { ProjectMembershipScope } from '@kontourai/station-contracts/project-membership';
import {
  PROJECT_SHARED_TASK_VERSION,
  type ProjectSharedTaskPublicationExpectation,
  type ProjectSharedTaskSummary,
} from '@kontourai/station-contracts/project-shared-task';
import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import {
  type ProjectSharedTaskAdmission,
  ProjectSharedTaskRefusal,
  type ProjectSharedTaskStore,
} from './project-shared-task-store.js';

export interface ProjectSharedTaskAuthority {
  current(): Promise<{ principalId: string }>;
  operator(): Promise<void>;
  requireProjectRead(scope: ProjectMembershipScope): Promise<void>;
}
export class ProjectSharedTaskService {
  constructor(
    private readonly deps: {
      store: ProjectSharedTaskStore;
      readTask(taskId: string): TaskRecord | null;
      projectCandidates(
        identity: string,
      ): readonly { id: string; slug: string }[];
    },
  ) {}
  async share(
    scope: ProjectMembershipScope,
    taskId: string,
    authority: ProjectSharedTaskAuthority,
    expected?: ProjectSharedTaskPublicationExpectation,
  ) {
    if (
      expected &&
      (!sameScope(expected.project, scope) || expected.task.id !== taskId)
    )
      throw new ProjectSharedTaskRefusal('conflict');
    const initial = await authority.current();
    await authority.operator();
    await authority.requireProjectRead(scope);
    const task = this.task(scope, taskId);
    if (expected && expected.task.createdAt !== task.createdAt)
      throw new ProjectSharedTaskRefusal('conflict');
    await authority.operator();
    const current = await authority.current();
    if (current.principalId !== initial.principalId)
      throw new ProjectSharedTaskRefusal('conflict');
    await authority.requireProjectRead(scope);
    const final = this.task(scope, taskId);
    if (final.createdAt !== task.createdAt)
      throw new ProjectSharedTaskRefusal('conflict');
    return this.deps.store.share({
      scope,
      taskId: task.id,
      taskCreatedAt: task.createdAt,
      sharedBy: current.principalId,
    });
  }
  async unshare(
    scope: ProjectMembershipScope,
    taskId: string,
    shareId: string,
    authority: ProjectSharedTaskAuthority,
    expected?: ProjectSharedTaskPublicationExpectation,
  ) {
    if (
      expected &&
      (!sameScope(expected.project, scope) || expected.task.id !== taskId)
    )
      throw new ProjectSharedTaskRefusal('conflict');
    const initial = await authority.current();
    await authority.operator();
    await authority.requireProjectRead(scope);
    const admission = this.admission(scope, taskId);
    if (
      admission.shareId !== shareId ||
      (expected && admission.taskCreatedAt !== expected.task.createdAt)
    )
      throw new ProjectSharedTaskRefusal('conflict');
    await authority.operator();
    const current = await authority.current();
    if (current.principalId !== initial.principalId)
      throw new ProjectSharedTaskRefusal('conflict');
    await authority.requireProjectRead(scope);
    const stored = this.admission(scope, taskId);
    if (stored.shareId !== shareId)
      throw new ProjectSharedTaskRefusal('conflict');
    this.deps.store.unshare(taskId, shareId);
    return { unshared: true as const };
  }
  async list(
    scope: ProjectMembershipScope,
    authority: ProjectSharedTaskAuthority,
  ): Promise<ProjectSharedTaskSummary[]> {
    await authority.requireProjectRead(scope);
    const admitted = this.deps.store.list(scope);
    const visible: {
      admission: ProjectSharedTaskAdmission;
      summary: ProjectSharedTaskSummary;
    }[] = [];
    for (const admission of admitted) {
      try {
        visible.push({ admission, summary: this.summary(admission) });
      } catch (error) {
        if (
          error instanceof ProjectSharedTaskRefusal &&
          error.code === 'not-found'
        )
          continue;
        throw error;
      }
    }
    await authority.requireProjectRead(scope);
    return visible
      .filter(({ admission }) => this.current(admission))
      .map(({ summary }) => summary);
  }
  async publication(
    scope: ProjectMembershipScope,
    taskId: string,
    authority: ProjectSharedTaskAuthority,
  ) {
    const initial = await authority.current();
    await authority.operator();
    await authority.requireProjectRead(scope);
    const task = this.task(scope, taskId);
    const admission = this.deps.store.admission(taskId);
    if (admission && !sameScope(admission.scope, scope))
      throw new ProjectSharedTaskRefusal('not-found');
    await authority.operator();
    const current = await authority.current();
    if (current.principalId !== initial.principalId)
      throw new ProjectSharedTaskRefusal('conflict');
    await authority.requireProjectRead(scope);
    const final = this.task(scope, taskId);
    if (final.createdAt !== task.createdAt)
      throw new ProjectSharedTaskRefusal('conflict');
    if (!admission)
      return {
        kind: 'unshared' as const,
        project: structuredClone(scope),
        task: { id: task.id, createdAt: task.createdAt },
      };
    const stored = this.deps.store.admission(taskId);
    if (
      !stored ||
      stored.shareId !== admission.shareId ||
      stored.taskCreatedAt !== task.createdAt ||
      !sameScope(stored.scope, scope)
    )
      throw new ProjectSharedTaskRefusal('conflict');
    return { kind: 'shared' as const, publication: this.summary(stored) };
  }
  async admitRead(
    scope: ProjectMembershipScope,
    taskId: string,
    authority: ProjectSharedTaskAuthority,
  ) {
    await authority.requireProjectRead(scope);
    const admission = this.admission(scope, taskId);
    this.assertCurrent(admission);
    await authority.requireProjectRead(scope);
    this.assertCurrent(admission);
    return structuredClone(admission);
  }
  async revalidate(
    admission: ProjectSharedTaskAdmission,
    authority: ProjectSharedTaskAuthority,
  ) {
    await authority.requireProjectRead(admission.scope);
    const current = this.deps.store.admission(admission.taskId);
    if (
      !current ||
      current.shareId !== admission.shareId ||
      !sameScope(current.scope, admission.scope)
    )
      throw new ProjectSharedTaskRefusal('not-found');
    this.assertCurrent(current);
  }
  async revalidateSummary(
    summary: ProjectSharedTaskSummary,
    authority: ProjectSharedTaskAuthority,
  ) {
    await authority.requireProjectRead(summary.project);
    const current = this.deps.store.admission(summary.task.id);
    if (
      !current ||
      current.shareId !== summary.shareId ||
      !sameScope(current.scope, summary.project) ||
      current.taskCreatedAt !== summary.task.createdAt
    )
      throw new ProjectSharedTaskRefusal('not-found');
    this.assertCurrent(current);
  }
  private admission(scope: ProjectMembershipScope, taskId: string) {
    const admission = this.deps.store.admission(taskId);
    if (!admission || !sameScope(admission.scope, scope))
      throw new ProjectSharedTaskRefusal('not-found');
    return admission;
  }
  private summary(
    admission: ProjectSharedTaskAdmission,
  ): ProjectSharedTaskSummary {
    const task = this.assertCurrent(admission);
    return {
      version: PROJECT_SHARED_TASK_VERSION,
      project: structuredClone(admission.scope),
      task: {
        id: task.id,
        title: task.title,
        status: task.status,
        createdAt: task.createdAt,
      },
      shareId: admission.shareId,
      sharedAt: admission.sharedAt,
    };
  }
  private current(admission: ProjectSharedTaskAdmission) {
    try {
      const stored = this.deps.store.admission(admission.taskId);
      if (
        !stored ||
        stored.shareId !== admission.shareId ||
        !sameScope(stored.scope, admission.scope)
      )
        return false;
      this.assertCurrent(admission);
      return true;
    } catch (error) {
      if (
        error instanceof ProjectSharedTaskRefusal &&
        error.code === 'not-found'
      )
        return false;
      throw error;
    }
  }
  private assertCurrent(admission: ProjectSharedTaskAdmission) {
    const task = this.task(admission.scope, admission.taskId);
    if (task.createdAt !== admission.taskCreatedAt)
      throw new ProjectSharedTaskRefusal('not-found');
    return task;
  }
  private task(scope: ProjectMembershipScope, taskId: string) {
    const task = this.deps.readTask(taskId);
    if (!task) throw new ProjectSharedTaskRefusal('not-found');
    const candidates = this.deps.projectCandidates(task.projectId);
    if (
      candidates.length !== 1 ||
      candidates[0]!.id !== scope.localProjectId ||
      candidates[0]!.slug !== scope.localProjectSlug
    )
      throw new ProjectSharedTaskRefusal('not-found');
    return task;
  }
}
function sameScope(
  left: ProjectMembershipScope,
  right: ProjectMembershipScope,
) {
  return (
    left.stationId === right.stationId &&
    left.localProjectId === right.localProjectId &&
    left.localProjectSlug === right.localProjectSlug &&
    left.portableProjectId === right.portableProjectId
  );
}

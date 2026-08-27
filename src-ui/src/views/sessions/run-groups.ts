import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';

export interface DelegatedRunGroup {
  id: string;
  parent: OrchestrationSessionSummary;
  members: readonly OrchestrationSessionSummary[];
}

export type ActivitySessionPresentation =
  | { kind: 'session'; session: OrchestrationSessionSummary }
  | { kind: 'run'; run: DelegatedRunGroup };

/**
 * Presentation-only delegated-run folding.
 *
 * `station-control-delegation` stamps a new child with its OWN task id and
 * its launcher's task id in `parentTaskId`. The parent can be a direct session
 * (so the launcher uses its `threadId`) or a delegated session (so it uses
 * that session's `delegation.taskId`). Resolve those exact two shapes, then
 * walk upward to the lineage root. A task-id join additionally requires a
 * POSITIVELY corroborated scope agreement (project/environment/connection) —
 * shared characteristics alone never join unrelated work, and absent scope
 * is not corroboration.
 */
export function groupDelegatedSessionRuns(
  sessions: readonly OrchestrationSessionSummary[],
): ActivitySessionPresentation[] {
  const byThreadId = new Map(
    sessions.map((session) => [session.threadId, session]),
  );
  const taskIdOwners = new Map<string, OrchestrationSessionSummary[]>();
  for (const session of sessions) {
    const taskId = session.delegation?.taskId;
    if (!taskId) continue;
    const owners = taskIdOwners.get(taskId) ?? [];
    owners.push(session);
    taskIdOwners.set(taskId, owners);
  }

  const hasSameTaskScope = (
    child: OrchestrationSessionSummary,
    candidate: OrchestrationSessionSummary,
  ) => {
    const childProject = child.delegation?.projectSlug ?? child.projectSlug;
    const candidateProject =
      candidate.delegation?.projectSlug ?? candidate.projectSlug;
    // Delta-review D1: absence is NOT corroboration — undefined === undefined
    // must never join two scope-less legacy summaries. At least one scope
    // dimension has to be POSITIVELY present (and equal) on both sides.
    const corroborated =
      (childProject !== undefined && candidateProject !== undefined) ||
      (child.delegation?.environmentId !== undefined &&
        candidate.delegation?.environmentId !== undefined) ||
      (child.delegation?.connectionId !== undefined &&
        candidate.delegation?.connectionId !== undefined);
    return (
      corroborated &&
      childProject === candidateProject &&
      child.delegation?.environmentId === candidate.delegation?.environmentId &&
      child.delegation?.connectionId === candidate.delegation?.connectionId
    );
  };

  const parentOf = (session: OrchestrationSessionSummary) => {
    const parentTaskId = session.delegation?.parentTaskId;
    if (!parentTaskId) return undefined;
    // station-control-delegation passes a direct parent's thread id verbatim.
    // That concrete session identity wins over any unrelated task-id owner.
    const directParent = byThreadId.get(parentTaskId);
    if (directParent) return directParent;
    const taskIdOwnersForParent = taskIdOwners.get(parentTaskId);
    // A task id lacks the uniqueness guarantee of a thread id. Claim lineage
    // only for one scoped match; a collision or missing scope agreement stays
    // flat rather than attaching work to the wrong run.
    if (
      taskIdOwnersForParent?.length === 1 &&
      hasSameTaskScope(session, taskIdOwnersForParent[0])
    ) {
      return taskIdOwnersForParent[0];
    }
    return undefined;
  };

  const rootFor = (session: OrchestrationSessionSummary) => {
    let current = session;
    const seen = new Set<string>();
    while (!seen.has(current.threadId)) {
      seen.add(current.threadId);
      if (!current.delegation?.parentTaskId) return current;
      const parent = parentOf(current);
      // A delegated session whose parent is not in this filtered projection
      // cannot honestly become a run parent. Its descendants are flat too.
      if (!parent) return undefined;
      current = parent;
    }
    // A malformed cycle has no honest root.
    return undefined;
  };

  const membersByRoot = new Map<string, OrchestrationSessionSummary[]>();
  for (const session of sessions) {
    const root = rootFor(session);
    if (!root) continue;
    const members = membersByRoot.get(root.threadId) ?? [];
    members.push(session);
    membersByRoot.set(root.threadId, members);
  }

  const presentation: ActivitySessionPresentation[] = [];
  for (const session of sessions) {
    const root = rootFor(session);
    if (!root) {
      presentation.push({ kind: 'session', session });
      continue;
    }
    const members = membersByRoot.get(root.threadId) ?? [session];
    if (members.length === 1) {
      presentation.push({ kind: 'session', session });
      continue;
    }
    // Keep the parent at the run's visual position even if a higher-priority
    // child lane happened to appear first in the input. The group itself is
    // the presentation unit now; a child must not pull its parent below it.
    if (session !== root) continue;
    presentation.push({
      kind: 'run',
      run: {
        id: `run:${root.threadId}`,
        parent: root,
        members: [root, ...members.filter((member) => member !== root)],
      },
    });
  }
  return presentation;
}

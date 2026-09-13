import type { PullRequest } from '@kontourai/station-contracts/pull-request-provider';

export interface PullRequestStackLayer {
  pullRequest: PullRequest;
  position: number;
}
export interface PullRequestDependencyStack {
  id: string;
  observedAt: string;
  state: 'ordered' | 'ambiguous' | 'cyclic';
  reason?: string;
  layers: PullRequestStackLayer[];
}

const id = (pullRequest: PullRequest) =>
  JSON.stringify([
    pullRequest.provider,
    pullRequest.host,
    pullRequest.repository.owner,
    pullRequest.repository.name,
    pullRequest.ref,
  ]);
const parentId = (
  parents: Map<string, PullRequest>,
  pullRequest: PullRequest,
) => {
  const value = parents.get(id(pullRequest));
  return value ? id(value) : undefined;
};

/** Branch edges are provider-reported; titles and display URLs never participate. */
export function derivePullRequestDependencyStacks(
  pullRequests: PullRequest[],
  observedAt: string,
): PullRequestDependencyStack[] {
  const bySource = new Map<string, PullRequest[]>();
  for (const pullRequest of pullRequests) {
    const current = bySource.get(pullRequest.sourceBranch) ?? [];
    current.push(pullRequest);
    bySource.set(pullRequest.sourceBranch, current);
  }
  const parent = new Map<string, PullRequest>();
  const ambiguous = new Set<string>();
  for (const pullRequest of pullRequests) {
    const candidates = bySource
      .get(pullRequest.targetBranch)
      ?.filter(
        (candidate) =>
          candidate.provider === pullRequest.provider &&
          candidate.host === pullRequest.host &&
          candidate.repository.owner === pullRequest.repository.owner &&
          candidate.repository.name === pullRequest.repository.name,
      );
    if (candidates?.length === 1) parent.set(id(pullRequest), candidates[0]);
    else if ((candidates?.length ?? 0) > 1) ambiguous.add(id(pullRequest));
  }
  const visited = new Set<string>();
  const stacks: PullRequestDependencyStack[] = [];
  for (const start of pullRequests) {
    if (visited.has(id(start))) continue;
    const component = new Map<string, PullRequest>();
    const queue = [start];
    while (queue.length) {
      const current = queue.shift()!;
      if (component.has(id(current))) continue;
      component.set(id(current), current);
      const directParent = parent.get(id(current));
      if (directParent) queue.push(directParent);
      for (const candidate of pullRequests)
        if (parentId(parent, candidate) === id(current)) queue.push(candidate);
    }
    for (const key of component.keys()) visited.add(key);
    const roots = [...component.values()].filter((candidate) => {
      const candidateParent = parentId(parent, candidate);
      return !candidateParent || !component.has(candidateParent);
    });
    let state: PullRequestDependencyStack['state'] = 'ordered';
    let reason: string | undefined;
    if ([...component.keys()].some((key) => ambiguous.has(key))) {
      state = 'ambiguous';
      reason = 'More than one pull request reports the same source branch.';
    }
    if (roots.length === 0 && component.size > 0) {
      state = 'cyclic';
      reason = 'Provider-reported branch relationships form a cycle.';
    }
    const ordered: PullRequest[] = [];
    const remaining = new Set(component.keys());
    const frontier = roots.sort((a, b) => a.ref.localeCompare(b.ref));
    while (frontier.length) {
      const current = frontier.shift()!;
      if (!remaining.delete(id(current))) continue;
      ordered.push(current);
      frontier.push(
        ...[...component.values()]
          .filter((candidate) => parentId(parent, candidate) === id(current))
          .sort((a, b) => a.ref.localeCompare(b.ref)),
      );
    }
    ordered.push(
      ...[...component.values()]
        .filter((candidate) => remaining.has(id(candidate)))
        .sort((a, b) => a.ref.localeCompare(b.ref)),
    );
    stacks.push({
      id: id(ordered[0]),
      observedAt,
      state,
      ...(reason ? { reason } : {}),
      layers: ordered.map((pullRequest, position) => ({
        pullRequest,
        position,
      })),
    });
  }
  return stacks;
}

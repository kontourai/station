import type { PullRequest } from '@kontourai/station-contracts/pull-request-provider';
import { Button } from '../Button';
import { derivePullRequestDependencyStacks } from './pull-request-dependency-stacks';
import './PullRequestDependencyStacks.css';

export function PullRequestDependencyStacks({
  pullRequests,
  observedAt,
  refreshing,
  onRefresh,
  onOpen,
}: {
  pullRequests: PullRequest[];
  observedAt: string;
  refreshing: boolean;
  onRefresh: () => void;
  onOpen: (pullRequest: PullRequest) => void;
}) {
  const stacks = derivePullRequestDependencyStacks(pullRequests, observedAt);
  const stale = Date.now() - Date.parse(observedAt) > 5 * 60_000;
  return (
    <section className="pull-request-stacks" aria-label="Pull request stacks">
      <header>
        <div>
          <h3>Dependency stacks</h3>
          <p>
            Provider branch graph · observed{' '}
            {new Date(observedAt).toLocaleString()}
            {stale ? ' · stale' : ''}
          </p>
        </div>
        <Button
          pending={refreshing}
          pendingLabel="Refreshing"
          onClick={onRefresh}
        >
          Refresh stacks
        </Button>
      </header>
      {stacks.map((stack) => (
        <ol key={stack.id} data-stack-state={stack.state}>
          {stack.state !== 'ordered' && <li role="alert">{stack.reason}</li>}
          {stack.layers.map(({ pullRequest, position }) => (
            <li key={pullRequest.ref}>
              <span>{position + 1}</span>
              <Button variant="link" onClick={() => onOpen(pullRequest)}>
                #{pullRequest.ref} {pullRequest.title}
              </Button>
              <span>
                {pullRequest.sourceBranch} → {pullRequest.targetBranch} ·{' '}
                {pullRequest.state} ·{' '}
                {pullRequest.headSha ?? 'head unavailable'}
              </span>
            </li>
          ))}
        </ol>
      ))}
    </section>
  );
}

import type { PullRequest } from '@kontourai/station-contracts/pull-request-provider';
import { Button } from '../Button';
import { derivePullRequestDependencyStacks } from './pull-request-dependency-stacks';
import './PullRequestDependencyStacks.css';

/**
 * Pull requests that target each other's branches, in merge order. Only a
 * stack of two or more is a stack worth a line; the ordinary case (every
 * pull request on main) renders nothing. The information stays; the header,
 * the refresh and the timestamp it used to carry are gone — the list's own
 * refresh covers it.
 */
export function PullRequestDependencyStacks({
  pullRequests,
  observedAt,
  onOpen,
}: {
  pullRequests: PullRequest[];
  observedAt: string;
  onOpen: (pullRequest: PullRequest) => void;
}) {
  const stacks = derivePullRequestDependencyStacks(
    pullRequests,
    observedAt,
  ).filter((stack) => stack.layers.length > 1 || stack.state !== 'ordered');
  if (stacks.length === 0) return null;
  return (
    <section className="pull-request-stacks" aria-label="Pull request stacks">
      <h3 className="pull-request-stacks__label">Stacked</h3>
      {stacks.map((stack) => (
        <ol key={stack.id} data-stack-state={stack.state}>
          {stack.state !== 'ordered' && <li role="alert">{stack.reason}</li>}
          {stack.layers.map(({ pullRequest, position }) => (
            <li key={pullRequest.ref}>
              <span className="pull-request-stacks__position">
                {position + 1}
              </span>
              <Button variant="link" onClick={() => onOpen(pullRequest)}>
                #{pullRequest.ref} {pullRequest.title}
              </Button>
              <span className="pull-request-stacks__branches">
                <code>{pullRequest.sourceBranch}</code> →{' '}
                <code>{pullRequest.targetBranch}</code>
              </span>
            </li>
          ))}
        </ol>
      ))}
    </section>
  );
}

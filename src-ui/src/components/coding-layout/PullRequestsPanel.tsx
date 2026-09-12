import type { PullRequestLinkIdentity } from '@kontourai/station-contracts/conversation-pull-request-links';
import type {
  PullRequest,
  PullRequestMergeMethod,
  PullRequestMergeResult,
  PullRequestResult,
} from '@kontourai/station-contracts/pull-request-provider';
import {
  useMergePullRequestMutation,
  usePullRequestContextQuery,
  usePullRequestsQuery,
} from '@kontourai/station-sdk';
import { useEffect, useRef, useState } from 'react';
import { useNavigation } from '../../contexts/NavigationContext';
import { Button } from '../Button';
import { LazyBoundary } from '../LazyBoundary';
import { ConfirmModal } from '../modals/ConfirmModal';
import { ConversationPullRequestLinks } from '../pull-requests/ConversationPullRequestLinks';
import { Empty, ErrorState, SkeletonBlock, SkeletonList } from '../state';
import { PullRequestDependencyStacks } from './PullRequestDependencyStacks';
import './PullRequestsPanel.css';

const loadReview = () =>
  import('./PullRequestReviewPanel').then((module) => ({
    default: module.PullRequestReviewPanel,
  }));

type StateFilter = 'ALL' | 'OPEN' | 'CLOSED' | 'MERGED';

function normalizedState(state: string) {
  return state.trim().toUpperCase();
}

export function PullRequestsPanel({
  projectSlug,
  activeRepoRoot,
}: {
  projectSlug: string;
  activeRepoRoot?: string | null;
}) {
  const activeChat = useNavigation((state) => state.activeChat);
  const [selected, setSelected] = useState<PullRequestLinkIdentity | null>(
    null,
  );
  const [filter, setFilter] = useState<StateFilter>('OPEN');
  const resolvingContext = {
    project: projectSlug,
    workingDirectory: activeRepoRoot ?? undefined,
  };
  const context = usePullRequestContextQuery(resolvingContext);
  const identity = context.data?.available ? context.data : undefined;
  const pullRequests = usePullRequestsQuery(
    identity?.provider ?? '',
    identity?.host ?? '',
    identity?.repository.owner ?? '',
    identity?.repository.name ?? '',
    resolvingContext,
    { state: filter },
    { enabled: !!identity },
  );

  if (context.isLoading) return <SkeletonList count={4} />;
  if (context.error) {
    return (
      <ErrorState
        variant="compact"
        title="Pull requests unavailable"
        description={context.error.message}
      />
    );
  }
  if (!context.data?.available) {
    // #1536 G5: a checkout with no remote is the ordinary local repository —
    // nothing is broken and nothing the operator asked for is missing. It read
    // as a warning-triangle "Pull requests unavailable" card, the same
    // presentation as a forge that refused. The cause comes from the server
    // (`PullRequestUnavailableCause`), never from matching on the sentence.
    if (context.data?.cause === 'no-remote') {
      return (
        <Empty
          variant="compact"
          label="Pull requests need a remote"
          description="This checkout has no remote configured, so there is nothing to list. Add one on a supported forge to see pull requests here."
        />
      );
    }
    return (
      <ErrorState
        variant="compact"
        title="Pull requests unavailable"
        description={
          context.data?.reason ?? 'Repository context is unavailable'
        }
      />
    );
  }
  if (
    selected &&
    identity &&
    selected.provider === identity.provider &&
    selected.host === identity.host &&
    selected.repository.owner === identity.repository.owner &&
    selected.repository.name === identity.repository.name
  ) {
    return (
      <LazyBoundary
        load={loadReview}
        componentProps={{
          target: {
            provider: selected.provider,
            host: selected.host,
            owner: selected.repository.owner,
            repository: selected.repository.name,
            ref: selected.ref,
            project: projectSlug,
            repositoryRootHint: activeRepoRoot ?? undefined,
          },
          onBack: () => setSelected(null),
        }}
        pending={<SkeletonBlock label="Opening pull request review" />}
      />
    );
  }
  if (pullRequests.isLoading) return <SkeletonList count={4} />;
  if (pullRequests.error) {
    return (
      <ErrorState
        variant="compact"
        title="Pull requests unavailable"
        description={pullRequests.error.message}
      />
    );
  }

  const result = pullRequests.data as
    | PullRequestResult<PullRequest[]>
    | undefined;
  if (!result?.available) {
    return (
      <ErrorState
        variant="compact"
        title="Pull requests unavailable"
        description={result?.reason ?? 'The forge did not report availability'}
      />
    );
  }
  const visible = (result.data ?? []).filter(
    (pullRequest) =>
      filter === 'ALL' || normalizedState(pullRequest.state) === filter,
  );
  const observedAt = new Date(
    pullRequests.dataUpdatedAt || Date.now(),
  ).toISOString();

  return (
    <section className="pull-requests-panel" aria-label="Pull requests">
      {activeChat && identity && (
        <ConversationPullRequestLinks
          conversationId={activeChat}
          suggested={{
            provider: identity.provider,
            host: identity.host,
            repository: identity.repository,
          }}
          derived={(result.data ?? [])
            .filter(
              (pullRequest) => pullRequest.sourceBranch === identity.branch,
            )
            .map((pullRequest) => ({
              provider: pullRequest.provider,
              host: pullRequest.host,
              repository: pullRequest.repository,
              ref: pullRequest.ref,
              source: 'branch-derived' as const,
              observedAt,
              status: {
                state: 'current' as const,
                title: pullRequest.title,
                pullRequestState: pullRequest.state,
                ...(pullRequest.headSha ? { head: pullRequest.headSha } : {}),
              },
            }))}
          onOpen={(link) => setSelected(link)}
        />
      )}
      <PullRequestDependencyStacks
        pullRequests={result.data ?? []}
        observedAt={observedAt}
        refreshing={pullRequests.isFetching}
        onRefresh={() => void pullRequests.refetch()}
        onOpen={setSelected}
      />
      <header className="pull-requests-panel__header">
        <div>
          <h2>Pull requests</h2>
          <p>
            {context.data.repository.owner}/{context.data.repository.name}
          </p>
        </div>
        <label>
          <span>State</span>
          <select
            aria-label="Pull request state"
            value={filter}
            onChange={(event) => setFilter(event.target.value as StateFilter)}
          >
            <option value="ALL">All</option>
            <option value="OPEN">Open</option>
            <option value="CLOSED">Closed</option>
            <option value="MERGED">Merged</option>
          </select>
        </label>
      </header>
      {visible.length === 0 ? (
        <Empty
          variant="compact"
          label={
            filter === 'ALL'
              ? 'No pull requests'
              : `No ${filter.toLowerCase()} pull requests`
          }
        />
      ) : (
        <ul className="pull-requests-panel__list">
          {visible.map((pullRequest) => (
            <PullRequestRow
              key={pullRequest.ref}
              pullRequest={pullRequest}
              result={result}
              projectSlug={projectSlug}
              activeRepoRoot={activeRepoRoot}
              onMerged={() => void pullRequests.refetch()}
              onOpen={() => setSelected(pullRequest)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function PullRequestRow({
  pullRequest,
  result,
  projectSlug,
  activeRepoRoot,
  onMerged,
  onOpen,
}: {
  pullRequest: PullRequest;
  result: PullRequestResult<PullRequest[]>;
  projectSlug: string;
  activeRepoRoot?: string | null;
  onMerged: () => void;
  onOpen: () => void;
}) {
  const [method, setMethod] = useState<PullRequestMergeMethod>(
    result.effectiveMergeMethods[0] ?? 'merge',
  );
  const [intent, setIntent] = useState<'merge' | 'auto-merge' | null>(null);
  const [outcome, setOutcome] = useState<PullRequestMergeResult | null>(null);
  const dispatchingRef = useRef(false);
  const [isDispatching, setIsDispatching] = useState(false);
  useEffect(() => {
    if (!result.effectiveMergeMethods.includes(method)) {
      setMethod(result.effectiveMergeMethods[0] ?? 'merge');
    }
  }, [method, result.effectiveMergeMethods]);
  const mutation = useMergePullRequestMutation(
    pullRequest.provider,
    pullRequest.host,
    pullRequest.repository.owner,
    pullRequest.repository.name,
    pullRequest.ref,
    {
      project: projectSlug,
      workingDirectory: activeRepoRoot ?? undefined,
    },
  );
  const canMerge =
    result.effectiveCapabilities.merge &&
    pullRequest.mergeability !== 'conflicting' &&
    result.effectiveMergeMethods.length > 0;
  const canAutoMerge =
    result.effectiveCapabilities.autoMerge &&
    result.effectiveMergeMethods.length > 0;

  const dispatch = async () => {
    if (dispatchingRef.current) return;
    const requestedIntent = intent;
    if (!requestedIntent) return;
    dispatchingRef.current = true;
    setIsDispatching(true);
    try {
      const response = await mutation.mutateAsync({
        method,
        autoMerge: requestedIntent === 'auto-merge',
      });
      if (!response.available) {
        setOutcome({
          status: 'refused',
          reason: response.reason ?? 'Pull request operation unavailable',
        });
        return;
      }
      const next = response.data ?? {
        status: 'indeterminate' as const,
        reason: 'The forge returned no operation result',
        observed: response,
      };
      setOutcome(next);
      if (next.status === 'merged') onMerged();
    } catch (error) {
      setOutcome({
        status: 'refused',
        reason: error instanceof Error ? error.message : String(error),
      });
    } finally {
      dispatchingRef.current = false;
      setIsDispatching(false);
      setIntent(null);
    }
  };

  return (
    <li className="pull-request-card">
      <div className="pull-request-card__title-row">
        <Button variant="link" onClick={onOpen}>
          {pullRequest.title}
        </Button>
        <span className="pull-request-card__chip">
          {normalizedState(pullRequest.state)}
        </span>
      </div>
      <p>
        {pullRequest.sourceBranch} → {pullRequest.targetBranch} ·{' '}
        {pullRequest.author.login}
      </p>
      {(canMerge || canAutoMerge) && (
        <div className="pull-request-card__actions">
          <label>
            <span>Merge method</span>
            <select
              aria-label={`Merge method for ${pullRequest.title}`}
              value={method}
              onChange={(event) =>
                setMethod(event.target.value as PullRequestMergeMethod)
              }
            >
              {result.effectiveMergeMethods.map((mergeMethod) => (
                <option key={mergeMethod} value={mergeMethod}>
                  {mergeMethod}
                </option>
              ))}
            </select>
          </label>
          {canMerge && (
            <button type="button" onClick={() => setIntent('merge')}>
              Merge
            </button>
          )}
          {canAutoMerge && (
            <button type="button" onClick={() => setIntent('auto-merge')}>
              Enable auto-merge
            </button>
          )}
        </div>
      )}
      {result.mergeMethodsSource === 'provider-default' &&
        (canMerge || canAutoMerge) && (
          <p className="pull-request-card__note">
            Merge methods are provider defaults; repository settings could not
            be read.
          </p>
        )}
      {pullRequest.mergeability === 'conflicting' &&
        result.effectiveCapabilities.merge && (
          <p className="pull-request-card__note">
            Merge is unavailable because this pull request has conflicts.
          </p>
        )}
      {outcome?.status === 'queued-auto-merge' && (
        <p role="status">Auto-merge armed.</p>
      )}
      {outcome?.status === 'merged' && (
        <p role="status">Pull request merged.</p>
      )}
      {outcome?.status === 'refused' && <p role="alert">{outcome.reason}</p>}
      {outcome?.status === 'indeterminate' && (
        <details>
          <summary>{outcome.reason}</summary>
          <pre>{JSON.stringify(outcome.observed, null, 2)}</pre>
        </details>
      )}
      {mutation.error && !outcome && (
        <p role="alert">{mutation.error.message}</p>
      )}
      <ConfirmModal
        isOpen={intent !== null}
        title={
          intent === 'auto-merge' ? 'Enable auto-merge?' : 'Merge pull request?'
        }
        message={`${intent === 'auto-merge' ? 'Arm auto-merge for' : 'Merge'} “${pullRequest.title}” using ${method}?`}
        confirmLabel={intent === 'auto-merge' ? 'Enable auto-merge' : 'Merge'}
        onCancel={() => setIntent(null)}
        onConfirm={() => void dispatch()}
        pending={isDispatching}
      />
    </li>
  );
}

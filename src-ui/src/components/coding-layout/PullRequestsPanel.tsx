import type {
  ConversationPullRequestLinkObservation,
  PullRequestLinkIdentity,
} from '@kontourai/station-contracts/conversation-pull-request-links';
import type {
  PullRequest,
  PullRequestResult,
} from '@kontourai/station-contracts/pull-request-provider';
import {
  usePullRequestContextQuery,
  usePullRequestsQuery,
} from '@kontourai/station-sdk';
import { useState } from 'react';
import { useNavigation } from '../../contexts/NavigationContext';
import { openExternalLink } from '../../platform/openExternalLink';
// The Browser pane's round icon control, until the shared `IconButton` (a
// sibling change) lands; this import moves there with it.
import { BrowserIconButton } from '../../workspace-panes/browser-pane/BrowserIconButton';
import type { OverflowAction } from '../ActionOverflowMenu';
import { ArrowRightGlyph, PlusGlyph, RefreshGlyph } from '../icons/Glyph';
import { LazyBoundary } from '../LazyBoundary';
import { LinkPullRequestField } from '../pull-requests/LinkPullRequestField';
import { PullRequestRow } from '../pull-requests/PullRequestRow';
import {
  PullRequestChip,
  type PullRequestChipValue,
  pullRequestStateChip,
  reviewDecisionChip,
} from '../pull-requests/pull-request-chips';
import { pullRequestExternalLabel } from '../pull-requests/pull-request-external';
import {
  linkKey,
  useConversationPullRequestLinks,
} from '../pull-requests/useConversationPullRequestLinks';
import { SkeletonBlock, SkeletonList } from '../state';
import { PullRequestDependencyStacks } from './PullRequestDependencyStacks';
import './PullRequestsPanel.css';

const loadReview = () =>
  import('./PullRequestReviewPanel').then((module) => ({
    default: module.PullRequestReviewPanel,
  }));

type StateFilter = 'OPEN' | 'MERGED' | 'CLOSED' | 'ALL';
const FILTERS: readonly { value: StateFilter; label: string }[] = [
  { value: 'OPEN', label: 'Open' },
  { value: 'MERGED', label: 'Merged' },
  { value: 'CLOSED', label: 'Closed' },
  { value: 'ALL', label: 'All' },
];

function normalizedState(state: string) {
  return state.trim().toUpperCase();
}

const sameRepository = (
  a: { host: string; repository: { owner: string; name: string } },
  b: { host: string; repository: { owner: string; name: string } },
) =>
  a.host === b.host &&
  a.repository.owner === b.repository.owner &&
  a.repository.name === b.repository.name;

/** Row chips for a pull request: its state, then the review decision. */
function rowChips(pullRequest: {
  state: string;
  reviewStatus?: string;
  mergeability?: PullRequest['mergeability'];
}): PullRequestChipValue[] {
  const chips = [pullRequestStateChip(pullRequest.state)];
  const decision = pullRequest.reviewStatus
    ? reviewDecisionChip(pullRequest.reviewStatus)
    : null;
  if (decision) chips.push(decision);
  if (pullRequest.mergeability === 'conflicting')
    chips.push({ label: 'Has conflicts', tone: 'failure' });
  return chips;
}

/**
 * The pull requests view of the Diff pane: this checkout's pull requests as
 * quiet rows, the chat's own links, and the review of whichever is opened —
 * which takes the whole pane, with Back returning here.
 */
export function PullRequestsPanel({
  projectSlug,
  activeRepoRoot,
  onOpenLinkedAsPane,
  initialSelected = null,
}: {
  projectSlug: string;
  activeRepoRoot?: string | null;
  /**
   * Where a LINKED pull request opens when this panel is a dock pane's rather
   * than a coding layout's (#2049): as its own dock tab, beside the
   * conversation that linked it, instead of replacing this panel's list with
   * a review that has a "Back to pull requests" button. Absent in a layout,
   * where the list IS the place to go back to — which is why the caller
   * decides and this panel does not read its own placement.
   *
   * Returns whether the pane actually opened. A region may refuse (the pane's
   * Project is not resolved, a device fold leaves no region for it), and a
   * refusal must not be a click that does nothing where the pre-#2049
   * behaviour always opened the inline review — so a `false` falls back to
   * that review, the same shape `ChatMarkdownAnchor` uses for its own refusal.
   */
  onOpenLinkedAsPane?: (
    link: ConversationPullRequestLinkObservation,
  ) => boolean;
  /** Open on this review rather than the list (the Diff view's branch line). */
  initialSelected?: PullRequestLinkIdentity | null;
}) {
  const activeChat = useNavigation((state) => state.activeChat);
  const [selected, setSelected] = useState<PullRequestLinkIdentity | null>(
    initialSelected,
  );
  const [filter, setFilter] = useState<StateFilter>('OPEN');
  const [linking, setLinking] = useState(false);
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
  const chatLinks = useConversationPullRequestLinks(activeChat ?? '');

  if (context.isLoading) return <SkeletonList count={3} />;
  if (context.error) {
    return (
      <Note
        tone="error"
        text={context.error.message}
        onRetry={() => void context.refetch()}
      />
    );
  }
  if (!context.data?.available) {
    // #1536 G5: a checkout with no remote is the ordinary local repository —
    // nothing is broken and nothing the operator asked for is missing. The
    // cause comes from the server (`PullRequestUnavailableCause`), never
    // from matching on the sentence.
    if (context.data?.cause === 'no-remote') {
      return (
        <Note text="No remote. Add a GitHub or GitLab remote to see pull requests." />
      );
    }
    return (
      <Note
        tone="error"
        text={context.data?.reason ?? 'Repository context is unavailable'}
        onRetry={() => void context.refetch()}
      />
    );
  }
  if (selected) {
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
            ...(identity && sameRepository(selected, identity)
              ? { repositoryRootHint: activeRepoRoot ?? undefined }
              : {}),
          },
          onBack: () => setSelected(null),
        }}
        pending={<SkeletonBlock label="Opening pull request review" />}
      />
    );
  }
  if (pullRequests.isLoading) return <SkeletonList count={3} />;
  if (pullRequests.error) {
    return (
      <Note
        tone="error"
        text={pullRequests.error.message}
        onRetry={() => void pullRequests.refetch()}
      />
    );
  }

  const result = pullRequests.data as
    | PullRequestResult<PullRequest[]>
    | undefined;
  if (!result?.available) {
    return (
      <Note
        tone="error"
        text={result?.reason ?? 'Pull requests could not be read'}
        onRetry={() => void pullRequests.refetch()}
      />
    );
  }
  const listed = result.data ?? [];
  const visible = listed.filter(
    (pullRequest) =>
      filter === 'ALL' || normalizedState(pullRequest.state) === filter,
  );
  const observedAt = new Date(
    pullRequests.dataUpdatedAt || Date.now(),
  ).toISOString();
  // The chat's own links that the list does not already show: explicit links
  // and Task-declared ones, in any repository. A link to a listed pull
  // request is the listed row (its `⋯` carries Unlink).
  const links = activeChat ? (chatLinks.links.data?.links ?? []) : [];
  const listedKeys = new Set(
    listed.map((pullRequest) =>
      linkKey({
        provider: pullRequest.provider,
        host: pullRequest.host,
        repository: pullRequest.repository,
        ref: pullRequest.ref,
      }),
    ),
  );
  const elsewhere = links.filter((link) => !listedKeys.has(linkKey(link)));
  const explicitByKey = new Map(
    links
      .filter((link) => link.source === 'explicit')
      .map((link) => [linkKey(link), link] as const),
  );
  const open = (link: PullRequestLinkIdentity) => setSelected(link);
  const openLinked = (link: ConversationPullRequestLinkObservation) => {
    if (onOpenLinkedAsPane?.(link) === true) return;
    setSelected(link);
  };
  const unlinkAction = (
    link: ConversationPullRequestLinkObservation | undefined,
  ): OverflowAction[] =>
    link
      ? [
          {
            key: 'unlink',
            label: 'Unlink from chat',
            disabled: chatLinks.pending !== null,
            onSelect: () => void chatLinks.mutate('unlink', link),
          },
        ]
      : [];

  return (
    <section className="pull-requests-panel" aria-label="Pull requests">
      <div className="pull-requests-panel__bar">
        <fieldset className="pull-requests-panel__filter">
          <legend className="sr-only">Pull request state</legend>
          {FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              className="pull-requests-panel__filter-option"
              aria-pressed={filter === option.value}
              onClick={() => setFilter(option.value)}
            >
              {option.label}
            </button>
          ))}
        </fieldset>
        <div className="pull-requests-panel__tools">
          {activeChat && chatLinks.canWrite && (
            <BrowserIconButton
              className="pull-requests-panel__icon"
              aria-label="Link a pull request"
              title="Link a pull request to this chat"
              aria-expanded={linking}
              active={linking}
              onClick={() => setLinking((value) => !value)}
            >
              <PlusGlyph />
            </BrowserIconButton>
          )}
          <BrowserIconButton
            className="pull-requests-panel__icon"
            aria-label="Refresh"
            title="Refresh"
            disabled={pullRequests.isFetching}
            onClick={() => {
              void pullRequests.refetch();
              if (activeChat) void chatLinks.links.refetch();
            }}
          >
            <RefreshGlyph />
          </BrowserIconButton>
        </div>
      </div>
      {linking && activeChat && (
        <LinkPullRequestField
          scope={identity ?? {}}
          pending={chatLinks.pending?.startsWith('link:') ?? false}
          autoFocus
          onLink={(link) => {
            void chatLinks.mutate('link', link).then((ok) => {
              if (ok) setLinking(false);
            });
          }}
        />
      )}
      {chatLinks.mutationError && (
        <p className="pull-requests-panel__note" role="alert">
          {chatLinks.mutationError}
        </p>
      )}
      {elsewhere.length > 0 && (
        <>
          <h3 className="pull-requests-panel__label">Linked to this chat</h3>
          <ul className="pull-requests-panel__list">
            {elsewhere.map((link) => {
              const status = link.status;
              const reference = `${link.repository.owner}/${link.repository.name} #${link.ref}`;
              return (
                <PullRequestRow
                  key={`${link.source}:${linkKey(link)}`}
                  title={status.state === 'current' ? status.title : reference}
                  reference={reference}
                  chips={
                    status.state === 'current'
                      ? rowChips({ state: status.pullRequestState })
                      : []
                  }
                  meta={[
                    link.source === 'task-declared'
                      ? 'from a Task'
                      : link.source === 'branch-derived'
                        ? 'from branch'
                        : 'linked',
                  ]}
                  note={status.state === 'current' ? undefined : status.reason}
                  onOpen={
                    status.state === 'current'
                      ? () => openLinked(link)
                      : undefined
                  }
                  overflow={unlinkAction(
                    link.source === 'explicit' ? link : undefined,
                  )}
                  overflowLabel={`More actions for #${link.ref}`}
                />
              );
            })}
          </ul>
        </>
      )}
      <h3 className="pull-requests-panel__label">
        {context.data.repository.owner}/{context.data.repository.name}
      </h3>
      {visible.length === 0 ? (
        <Note
          text={
            filter === 'ALL'
              ? 'No pull requests'
              : `No ${filter.toLowerCase()} pull requests`
          }
        />
      ) : (
        <ul className="pull-requests-panel__list">
          {visible.map((pullRequest) => {
            const key = linkKey({
              provider: pullRequest.provider,
              host: pullRequest.host,
              repository: pullRequest.repository,
              ref: pullRequest.ref,
            });
            return (
              <PullRequestRow
                key={pullRequest.ref}
                title={pullRequest.title}
                reference={`#${pullRequest.ref}`}
                chips={rowChips(pullRequest)}
                meta={[pullRequest.author.login]}
                current={pullRequest.sourceBranch === identity?.branch}
                onOpen={() => open(pullRequest)}
                overflow={[
                  {
                    key: 'external',
                    label: pullRequestExternalLabel(pullRequest.url),
                    onSelect: () => void openExternalLink(pullRequest.url),
                  },
                  ...unlinkAction(explicitByKey.get(key)),
                ]}
                overflowLabel={`More actions for #${pullRequest.ref}`}
              />
            );
          })}
        </ul>
      )}
      <PullRequestDependencyStacks
        pullRequests={listed}
        observedAt={observedAt}
        onOpen={open}
      />
    </section>
  );
}

/** One line, and one action when there is one. No box. */
function Note({
  text,
  tone,
  onRetry,
}: {
  text: string;
  tone?: 'error';
  onRetry?: () => void;
}) {
  return (
    <p
      className={`pull-requests-panel__note${tone === 'error' ? ' pull-requests-panel__note--error' : ''}`}
      {...(tone === 'error' ? { role: 'alert' } : {})}
    >
      {text}
      {onRetry && (
        <>
          {' '}
          <button
            type="button"
            className="button button--link"
            onClick={onRetry}
          >
            Retry
          </button>
        </>
      )}
    </p>
  );
}

/**
 * The Diff view's one line about pull requests: the checked-out branch's
 * open pull request, when there is one, as a quiet row that opens its
 * review. Nothing when the branch has none, when the checkout has no
 * remote, or while the read is in flight — a line that says "reading" would
 * be chrome for a fact that is usually absent.
 */
export function CurrentBranchPullRequestLine({
  projectSlug,
  activeRepoRoot,
  onOpen,
}: {
  projectSlug: string;
  activeRepoRoot?: string | null;
  onOpen: (pullRequest: PullRequestLinkIdentity) => void;
}) {
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
    { state: 'OPEN' },
    { enabled: !!identity },
  );
  const result = pullRequests.data as
    | PullRequestResult<PullRequest[]>
    | undefined;
  const pullRequest = result?.available
    ? (result.data ?? []).find(
        (candidate) =>
          candidate.sourceBranch === identity?.branch &&
          normalizedState(candidate.state) === 'OPEN',
      )
    : undefined;
  if (!pullRequest) return null;
  return (
    <button
      type="button"
      className="pull-requests-panel__branch-line"
      aria-label={`Open pull request #${pullRequest.ref}: ${pullRequest.title}`}
      onClick={() => onOpen(pullRequest)}
    >
      <span className="pull-requests-panel__branch-line-reference">
        PR #{pullRequest.ref}
      </span>
      <span className="pull-requests-panel__branch-line-title">
        {pullRequest.title}
      </span>
      {rowChips(pullRequest)
        .slice(1)
        .map((chip) => (
          <PullRequestChip key={chip.label} {...chip} />
        ))}
      <ArrowRightGlyph className="pull-requests-panel__branch-line-arrow" />
    </button>
  );
}

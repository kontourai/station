import type {
  ConversationPullRequestLinkObservation,
  PullRequestLinkIdentity,
} from '@kontourai/station-contracts/conversation-pull-request-links';
import type { PullRequest } from '@kontourai/station-contracts/pull-request-provider';
import {
  useCheckoutPullRequestPages,
  usePullRequestContextQuery,
  usePullRequestsQuery,
} from '@kontourai/station-sdk';
import { Input, Select } from '@kontourai/ui/react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useNavigation } from '../../contexts/NavigationContext';
import { useCoarseNow } from '../../hooks/useCoarseNow';
import { useSurfaceVisibilityFlags } from '../../hooks/useSurfaceVisibilityFlags';
import { openExternalLink } from '../../platform/openExternalLink';
import { plural } from '../../utils/plural';
import { describeStationFailure } from '../../utils/stationFailure';
import type { OverflowAction } from '../ActionOverflowMenu';
import { Button } from '../Button';
import { IconButton } from '../IconButton';
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
import { RelativeTime } from '../pull-requests/RelativeTime';
import {
  linkKey,
  useConversationPullRequestLinks,
} from '../pull-requests/useConversationPullRequestLinks';
import { Empty, FilteredEmpty, SkeletonBlock, SkeletonList } from '../state';
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
  const key = state.trim().toUpperCase();
  return key === 'OPENED' ? 'OPEN' : key;
}

const sameRepository = (
  a: { host: string; repository: { owner: string; name: string } },
  b: { host: string; repository: { owner: string; name: string } },
) =>
  a.host === b.host &&
  a.repository.owner === b.repository.owner &&
  a.repository.name === b.repository.name;

function displayedState(pullRequest: { state: string; draft?: boolean }) {
  return normalizedState(pullRequest.state) === 'OPEN' && pullRequest.draft
    ? 'DRAFT'
    : pullRequest.state;
}

function rowChips(
  pullRequest: {
    state: string;
    reviewStatus?: string;
    reviewDecision?: PullRequest['reviewDecision'];
    mergeability?: PullRequest['mergeability'];
    snapshot?: PullRequest['snapshot'];
    draft?: boolean;
  },
  compact = false,
): PullRequestChipValue[] {
  const chips = [
    pullRequestStateChip(
      compact ? displayedState(pullRequest) : pullRequest.state,
    ),
  ];
  const decision = reviewDecisionChip(
    pullRequest.reviewDecision ?? pullRequest.reviewStatus ?? '',
  );
  if (decision) chips.push(decision);
  if (pullRequest.mergeability === 'conflicting')
    chips.push({ label: 'Has conflicts', tone: 'failure' });
  const checks = compact ? pullRequest.snapshot?.checks : undefined;
  if (checks) {
    const checkChip: Record<typeof checks, PullRequestChipValue> = {
      passing: { label: 'Checks passed', tone: 'success' },
      failing: { label: 'Checks failed', tone: 'failure' },
      pending: { label: 'Checks pending', tone: 'pending' },
      'awaiting-approval': { label: 'Checks need approval', tone: 'pending' },
    };
    chips.push(checkChip[checks]);
  }
  return chips;
}

const LIST_GROUPS = [
  'This chat',
  'This Task',
  'This branch',
  'Repository',
] as const;
type ListGroup = (typeof LIST_GROUPS)[number];

function rowGroup(
  source: ConversationPullRequestLinkObservation['source'] | undefined,
  isBranch = false,
): ListGroup {
  if (source === 'explicit') return 'This chat';
  if (source === 'task-declared') return 'This Task';
  if (isBranch || source === 'branch-derived') return 'This branch';
  return 'Repository';
}

function ListSkeleton({ compact }: { compact: boolean }) {
  return (
    <div
      className={
        compact ? 'pull-requests-panel pull-requests-panel--preview' : undefined
      }
    >
      <SkeletonList count={3} label="Loading pull requests" />
    </div>
  );
}

function useCheckoutPullRequests(
  project: string,
  workingDirectory: string | undefined,
  state: StateFilter,
) {
  const scope = { project, workingDirectory };
  const context = usePullRequestContextQuery(scope, {
    list: state,
    staleTime: 20_000,
    refetchOnMount: true,
  });
  const identity = context.data?.available ? context.data : undefined;
  const bundled = identity?.pullRequests;
  const fallback = usePullRequestsQuery(
    identity?.provider ?? '',
    identity?.host ?? '',
    identity?.repository.owner ?? '',
    identity?.repository.name ?? '',
    scope,
    { state },
    { enabled: !!identity && bundled === undefined },
  );
  const query = bundled ? context : fallback;
  return {
    context,
    identity,
    query,
    result: bundled ?? fallback.data,
    lastKnown: !!bundled?.available && context.isLastKnown,
  };
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
  const compact = useSurfaceVisibilityFlags().has('pull-request-workspace');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<PullRequestLinkIdentity | null>(
    initialSelected,
  );
  // Focus bookkeeping: the row a review was opened from gets focus back on
  // Back (else the first row), rather than focus falling to <body> when the
  // review unmounts. A review this panel mounted on (the Changes view's
  // branch line) puts focus on its own heading instead.
  const rowButtons = useRef(new Map<string, HTMLButtonElement>());
  const [returnFocusTo, setReturnFocusTo] = useState<string | null>(null);
  const [focusReviewTitle, setFocusReviewTitle] = useState(!!initialSelected);
  useEffect(() => {
    if (selected !== null || returnFocusTo === null) return;
    const target =
      rowButtons.current.get(returnFocusTo) ??
      rowButtons.current.values().next().value;
    target?.focus();
    setReturnFocusTo(null);
  }, [selected, returnFocusTo]);
  const [filter, setFilter] = useState<StateFilter>('OPEN');
  const now = useCoarseNow();
  const [linking, setLinking] = useState(false);
  const {
    context,
    identity,
    query: pullRequests,
    result,
    lastKnown,
  } = useCheckoutPullRequests(projectSlug, activeRepoRoot ?? undefined, filter);
  const paginationKey = JSON.stringify([
    projectSlug,
    activeRepoRoot,
    filter,
    identity?.provider,
    identity?.host,
    identity?.repository.owner,
    identity?.repository.name,
  ]);
  const [pagination, setPagination] = useState<{
    key: string;
    cursors: string[];
  }>({
    key: '',
    cursors: [],
  });
  const cursors =
    !lastKnown && pagination.key === paginationKey ? pagination.cursors : [];
  const pages = useCheckoutPullRequestPages(
    { project: projectSlug, workingDirectory: activeRepoRoot ?? undefined },
    filter,
    cursors,
    paginationKey,
  );
  const pageResults = pages.map(({ data }) =>
    identity &&
    data?.available &&
    data.provider === identity.provider &&
    sameRepository(identity, data)
      ? data.pullRequests
      : undefined,
  );
  const mismatchedPage = pages.some(
    ({ data }) =>
      data?.available &&
      identity &&
      (data.provider !== identity.provider || !sameRepository(identity, data)),
  );
  useEffect(() => {
    if (!mismatchedPage) return;
    setPagination({ key: '', cursors: [] });
    void context.refetch();
  }, [mismatchedPage, context.refetch]);
  const lastPage = pages.at(-1);
  const nextCursor = lastPage
    ? pageResults.at(-1)?.nextCursor
    : identity?.pullRequests?.nextCursor;
  const failedPage =
    lastPage &&
    !mismatchedPage &&
    !lastPage.isFetching &&
    !pageResults.at(-1)?.available;
  const chatLinks = useConversationPullRequestLinks(activeChat ?? '');

  if (context.isLoading || (context.isPending && !context.data))
    return <ListSkeleton compact={compact} />;
  if (context.error && !context.data) {
    return (
      <Note
        tone="error"
        text={describeStationFailure(context.error).body}
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
          onBack: () => {
            setReturnFocusTo(linkKey(selected));
            setSelected(null);
          },
          focusTitleOnOpen: focusReviewTitle,
          linkedGroups: activeChat
            ? [
                ...new Set(
                  (chatLinks.links.data?.links ?? [])
                    .filter((link) => linkKey(link) === linkKey(selected))
                    .flatMap((link) =>
                      link.source === 'explicit' ||
                      link.source === 'task-declared'
                        ? [rowGroup(link.source)]
                        : [],
                    ),
                ),
              ]
            : undefined,
        }}
        pending={<SkeletonBlock label="Opening pull request review" />}
      />
    );
  }
  if (pullRequests.isLoading) return <ListSkeleton compact={compact} />;
  if (pullRequests.error && !lastKnown) {
    return (
      <Note
        tone="error"
        text={describeStationFailure(pullRequests.error).body}
        onRetry={() => void pullRequests.refetch()}
      />
    );
  }

  if (!result?.available) {
    return (
      <Note
        tone="error"
        text={result?.reason ?? 'Pull requests could not be read'}
        onRetry={() => void pullRequests.refetch()}
      />
    );
  }
  const listed = [
    ...new Map(
      [
        ...(result.data ?? []),
        ...pageResults.flatMap((page) =>
          page?.available ? (page.data ?? []) : [],
        ),
      ].map((pullRequest) => [pullRequest.ref, pullRequest] as const),
    ).values(),
  ];
  const query = compact ? search.trim().toLowerCase() : '';
  const visible = listed.filter(
    (pullRequest) =>
      (filter === 'ALL' || normalizedState(pullRequest.state) === filter) &&
      (!query ||
        [
          pullRequest.title,
          `#${pullRequest.ref}`,
          pullRequest.author.login,
          pullRequest.sourceBranch,
          pullRequest.targetBranch,
        ].some((value) => value.toLowerCase().includes(query))),
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
  const open = (link: PullRequestLinkIdentity) => {
    setFocusReviewTitle(false);
    setSelected(link);
  };
  const openLinked = (link: ConversationPullRequestLinkObservation) => {
    if (onOpenLinkedAsPane?.(link) === true) return;
    open(link);
  };
  const rowRef = (key: string) => (element: HTMLButtonElement | null) => {
    if (element) rowButtons.current.set(key, element);
    else rowButtons.current.delete(key);
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

  const linkedRows = elsewhere.flatMap((link) => {
    const status = link.status;
    // A link elsewhere names its host: two hosts may hold the
    // same owner/name/number, and they are two pull requests.
    const reference = `${link.host}/${link.repository.owner}/${link.repository.name} #${link.ref}`;
    const title = status.state === 'current' ? status.title : reference;
    if (
      query &&
      ![title, reference].some((value) => value.toLowerCase().includes(query))
    )
      return [];
    return [
      {
        group: rowGroup(link.source),
        row: (
          <PullRequestRow
            key={`${link.source}:${linkKey(link)}`}
            title={title}
            compactState={
              compact && status.state === 'current'
                ? status.pullRequestState
                : undefined
            }
            reference={reference}
            chips={
              status.state === 'current'
                ? rowChips({ state: status.pullRequestState }).slice(
                    compact ? 1 : 0,
                  )
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
            openRef={rowRef(linkKey(link))}
            onOpen={
              status.state === 'current' ? () => openLinked(link) : undefined
            }
            overflow={unlinkAction(
              link.source === 'explicit' ? link : undefined,
            )}
            overflowLabel={`More actions for #${link.ref}`}
          />
        ),
      },
    ];
  });
  const listedRows = visible.map((pullRequest) => {
    const key = linkKey({
      provider: pullRequest.provider,
      host: pullRequest.host,
      repository: pullRequest.repository,
      ref: pullRequest.ref,
    });
    const current = !lastKnown && pullRequest.sourceBranch === identity?.branch;
    const source = explicitByKey.has(key)
      ? 'explicit'
      : links.find((link) => linkKey(link) === key)?.source;
    const { additions, deletions, changedFiles, updatedAt } =
      pullRequest.snapshot ?? {};
    const stats =
      additions !== undefined &&
      deletions !== undefined &&
      changedFiles !== undefined
        ? { additions, deletions, files: changedFiles }
        : undefined;
    return {
      group: rowGroup(source, current),
      row: (
        <PullRequestRow
          key={pullRequest.ref}
          title={pullRequest.title}
          reference={`#${pullRequest.ref}`}
          compactState={compact ? displayedState(pullRequest) : undefined}
          chips={rowChips(pullRequest, compact).slice(compact ? 1 : 0)}
          meta={
            compact
              ? [
                  pullRequest.author.login,
                  `${pullRequest.sourceBranch} → ${pullRequest.targetBranch}`,
                ].filter(Boolean)
              : [pullRequest.author.login]
          }
          trailing={
            compact && updatedAt && <RelativeTime iso={updatedAt} now={now} />
          }
          stats={
            compact &&
            stats && (
              <span className="pull-request-row__stats">
                <span className="sr-only">
                  {plural(stats.additions, 'addition')},{' '}
                  {plural(stats.deletions, 'deletion')},{' '}
                  {plural(stats.files, 'file')}
                </span>
                <span aria-hidden="true">
                  +{stats.additions} −{stats.deletions} ·{' '}
                  {plural(stats.files, 'file')}
                </span>
              </span>
            )
          }
          current={!compact && current}
          openRef={rowRef(key)}
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
      ),
    };
  });
  return (
    <section
      className={`pull-requests-panel${compact ? ' pull-requests-panel--preview' : ''}`}
      aria-label="Pull requests"
    >
      <div className="pull-requests-panel__bar">
        {compact ? (
          <div className="filter-toolbar pull-requests-panel__search">
            <Input
              type="search"
              aria-label="Search loaded pull requests"
              placeholder="Search pull requests"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <Select
              aria-label="Pull request state"
              value={filter}
              onChange={(event) => {
                const next = FILTERS.find(
                  ({ value }) => value === event.target.value,
                );
                if (next) setFilter(next.value);
              }}
            >
              {FILTERS.map(({ value, label }) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </div>
        ) : (
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
        )}
        <div className="pull-requests-panel__tools">
          {activeChat && chatLinks.canWrite && (
            <IconButton
              className="pull-requests-panel__icon"
              aria-label="Link a pull request"
              title="Link a pull request to this chat"
              aria-expanded={linking}
              active={linking}
              onClick={() => setLinking((value) => !value)}
            >
              <PlusGlyph />
            </IconButton>
          )}
          <IconButton
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
          </IconButton>
        </div>
      </div>
      {lastKnown && identity && (
        <p className="pull-requests-panel__note" role="status">
          Last known for {identity.repository.owner}/{identity.repository.name}{' '}
          as of <RelativeTime iso={observedAt} now={now} />
        </p>
      )}
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
      {compact ? (
        <CompactList
          rows={[...linkedRows, ...listedRows]}
          search={search}
          onClear={() => setSearch('')}
        />
      ) : (
        <>
          {linkedRows.length > 0 && (
            <>
              <h3 className="pull-requests-panel__label">
                Linked to this chat
              </h3>
              <ul className="pull-requests-panel__list">
                {linkedRows.map(({ row }) => row)}
              </ul>
            </>
          )}
          {listedRows.length === 0 ? (
            <Note
              text={
                filter === 'ALL'
                  ? 'No pull requests'
                  : `No ${filter.toLowerCase()} pull requests`
              }
            />
          ) : (
            <ul className="pull-requests-panel__list">
              {listedRows.map(({ row }) => row)}
            </ul>
          )}
        </>
      )}
      {compact && !lastKnown && failedPage && (
        <Note
          tone="error"
          text={
            pageResults.at(-1)?.reason ?? 'More pull requests could not be read'
          }
          onRetry={() => void lastPage.refetch()}
        />
      )}
      {compact &&
        !lastKnown &&
        !failedPage &&
        (nextCursor || lastPage?.isFetching) && (
          <Button
            disabled={
              !nextCursor ||
              cursors.includes(nextCursor) ||
              lastPage?.isFetching
            }
            onClick={() => {
              if (nextCursor)
                setPagination({
                  key: paginationKey,
                  cursors: [...cursors, nextCursor],
                });
            }}
          >
            {lastPage?.isFetching ? 'Loading…' : 'Load more'}
          </Button>
        )}
      {!lastKnown && (
        <PullRequestDependencyStacks
          pullRequests={listed}
          observedAt={observedAt}
          onOpen={open}
        />
      )}
    </section>
  );
}

function CompactList({
  rows,
  search,
  onClear,
}: {
  rows: { group: ListGroup; row: ReactNode }[];
  search: string;
  onClear: () => void;
}) {
  if (rows.length === 0)
    return search.trim() ? (
      <FilteredEmpty
        query={search}
        noun="loaded pull requests"
        onClear={onClear}
      />
    ) : (
      <Empty variant="compact" label="Pull requests will appear here" />
    );
  return LIST_GROUPS.map((group) => {
    const members = rows.filter((item) => item.group === group);
    if (members.length === 0) return null;
    return (
      <div key={group}>
        <h3 className="pull-requests-panel__label">{group}</h3>
        <ul className="pull-requests-panel__list">
          {members.map(({ row }) => row)}
        </ul>
      </div>
    );
  });
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
  const { identity, result, lastKnown } = useCheckoutPullRequests(
    projectSlug,
    activeRepoRoot ?? undefined,
    'OPEN',
  );
  const pullRequest =
    !lastKnown && result?.available
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

import { buildSessionInventoryViewModel } from '@kontourai/station-basis-pane/session-inventory-view';
import type { GitReadLocation, GitStatusResult } from '@kontourai/station-sdk';
import { useGitStatusQuery } from '@kontourai/station-sdk';
import { getConversationPullRequestLinks } from '@kontourai/station-sdk/conversation-pull-request-links';
import { useSessionInventoryQuery } from '@kontourai/station-sdk/session-inventory';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { relativeTime } from '../../utils/relativeTime';
import type { HomeWorkItem } from '../../views/home/home-view-model';
import {
  hasLifecycleChip,
  LifecycleStatusChip,
} from '../home/LifecycleStatusChip';
import './ChatInboxHoverCard.css';

/** Hover-card geometry: fixed width, clamped into the viewport beside the row. */
const CARD_WIDTH = 340;
const CARD_GAP = 8;
const VIEWPORT_MARGIN = 8;
/** Bounded previews: a hover summary, not the full pane. */
const PR_PREVIEW_LIMIT = 8;
const BASIS_GROUP_LIMIT = 5;
const BASIS_ITEM_LIMIT = 4;

/**
 * Group order for the basis preview — workspace artifacts first, bookkeeping
 * last. Groups outside this list (attention, live-now, sources) are either
 * rendered through their own channel below or deliberately out of scope for
 * a hover summary.
 */
const BASIS_GROUP_ORDER = [
  'outputs',
  'kept',
  'decisions',
  'work-items',
  'verification-delivery',
  'resources',
  'execution',
  'inputs',
] as const;

function sourceLabel(source: 'explicit' | 'branch-derived' | 'task-declared') {
  return source === 'explicit'
    ? 'Explicit'
    : source === 'branch-derived'
      ? 'From branch'
      : 'Task-kept';
}

/**
 * The inbox row's hover card: the metadata T3 Code shows for a session —
 * project, machine, branch, engine, status, pull requests — plus Station's
 * own basis inventory for the row's session.
 *
 * Display-only by contract: `pointer-events: none` and `role="tooltip"`, so
 * the card never intercepts the pointer (moving across rows never fights an
 * overlay) and never adds a tab stop. Every section is fetched only while a
 * card is open (the row mounts this component lazily on hover/focus), and
 * each fetch's absence is honest: a section the card cannot derive is
 * absent, and a fetch that failed renders a named gap, never a zero.
 */
/**
 * Named, not default: the only caller is a dynamic `import()` whose thunk
 * re-wraps it as `{ default: … }` for `LazyBoundary`. A bare default export
 * at that seam has no statically visible caller, and the fallow audit
 * (correctly) refuses new exports nothing calls.
 */
export function ChatInboxHoverCard({
  item,
  now,
  gitLocation,
  anchor,
  onClose,
  id,
}: {
  item: HomeWorkItem;
  now: number;
  /**
   * The row's local session working directory and its Project (#2412: git
   * reads name the Project), resolved by the host from its own session
   * records — never carried on `HomeWorkItem` (that type is the
   * workspace-home projection surface, and widening it invalidates grants).
   * Absent means "no local workspace known": the git section renders only
   * when the host could resolve a directory, which also structurally keeps
   * remote rows (which never carry a local `orchestrationThreadId`) from
   * being answered by this machine's git.
   */
  gitLocation?: GitReadLocation;
  /** The row element the card anchors beside (measured once on mount). */
  anchor: HTMLElement;
  onClose: () => void;
  /**
   * The row-instance-scoped id the row button references through
   * `aria-describedby` while the card is open — a focus-opened tooltip a
   * screen reader cannot announce is a tooltip that does not exist.
   */
  id: string;
}) {
  const scope = useHostRequestAuthorityScope();
  const cardRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<React.CSSProperties>({
    visibility: 'hidden',
  });

  // Git facts resolve against the row's LOCAL working directory, supplied by
  // the host (see the prop docblock).
  const git = useGitStatusQuery(gitLocation ?? null);
  // The owner's rule for this surface: pull requests are listed for projects
  // that have Git. A checkout the endpoint positively reported as a non-repo
  // suppresses the section; "unknown yet" does not (explicit and Task-kept
  // links stay visible while git is still being read or has no local cwd).
  const gitIsNonRepo = git.data != null && git.data.isRepo === false;
  const links = useQuery({
    queryKey: [
      'conversation-pull-request-links',
      scope?.apiBase,
      scope?.authorityKey,
      item.conversationId,
    ],
    queryFn: ({ signal }) =>
      getConversationPullRequestLinks(scope!.apiBase, item.conversationId!, {
        signal,
        requestScope: scope!,
      }),
    enabled: !!scope?.isCurrent() && !!item.conversationId && !gitIsNonRepo,
    retry: false,
    staleTime: 15_000,
    refetchOnMount: false,
  });

  const basisSessionId = item.orchestrationThreadId;
  const basisScope = useMemo(
    () =>
      basisSessionId
        ? ({ kind: 'whole-session', sessionId: basisSessionId } as const)
        : null,
    [basisSessionId],
  );
  const inventory = useSessionInventoryQuery(
    basisScope ?? { kind: 'whole-session', sessionId: '' },
    {
      enabled: Boolean(basisScope && scope?.isCurrent()),
      requestScope: scope,
      refetchOnMount: false,
      staleTime: 30_000,
    },
  );
  const basisModel = useMemo(() => {
    if (!basisScope || !inventory.data) return null;
    return buildSessionInventoryViewModel(
      inventory.data,
      { scope: basisScope, groupId: 'inputs' },
      'compact',
    );
  }, [basisScope, inventory.data]);

  // Position once from the anchor's rect; flip to the left side when the row
  // sits against the viewport's right edge (the dock can dock either side).
  useLayoutEffect(() => {
    const rect = anchor.getBoundingClientRect();
    const height = cardRef.current?.offsetHeight ?? 0;
    const top = Math.min(
      Math.max(VIEWPORT_MARGIN, rect.top),
      Math.max(VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN),
    );
    const fitsRight =
      rect.right + CARD_GAP + CARD_WIDTH <= window.innerWidth - VIEWPORT_MARGIN;
    const left = fitsRight
      ? rect.right + CARD_GAP
      : Math.max(VIEWPORT_MARGIN, rect.left - CARD_GAP - CARD_WIDTH);
    setPosition({ top, left, visibility: 'visible' });
  }, [anchor]);

  // The card is fixed-positioned: any scroll (the inbox's own scroll included)
  // detaches it from its anchor, and a tooltip that has lost its anchor is a
  // lie about the row under it. Close instead of following.
  useEffect(() => {
    const onScroll = () => onClose();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [onClose]);

  // A section that has nothing to say renders NOTHING — not a heading over
  // silence. The heading appears only while a read is in flight (named gap),
  // after a failed read (named gap), or over real facts.
  const gitSectionVisible =
    !!gitLocation &&
    (git.isLoading || !!git.error || git.data?.isRepo === true);
  const gitSection = gitSectionVisible ? (
    <section
      className="chat-dock-inbox-hover-card__section"
      aria-label="Git status"
    >
      <h4>Git</h4>
      {git.isLoading ? (
        <p className="chat-dock-inbox-hover-card__gap">Reading git state…</p>
      ) : git.error ? (
        <p className="chat-dock-inbox-hover-card__gap">
          Git state unavailable.
        </p>
      ) : git.data?.isRepo ? (
        <GitFacts git={git.data} />
      ) : null}
    </section>
  ) : null;

  const prLinks = links.data?.links ?? [];
  const prSectionVisible =
    !!item.conversationId &&
    !gitIsNonRepo &&
    (links.isPending || !!links.error || prLinks.length > 0);
  const prSection = prSectionVisible ? (
    <section
      className="chat-dock-inbox-hover-card__section"
      aria-label="Pull requests"
    >
      <h4>Pull requests</h4>
      {links.isPending ? (
        <p className="chat-dock-inbox-hover-card__gap">
          Reading pull requests…
        </p>
      ) : links.error ? (
        <p className="chat-dock-inbox-hover-card__gap">
          Pull request links unavailable.
        </p>
      ) : prLinks.length > 0 ? (
        <>
          <ul className="chat-dock-inbox-hover-card__prs">
            {prLinks.slice(0, PR_PREVIEW_LIMIT).map((link) => (
              <li
                key={`${link.source}:${link.host}/${link.repository.owner}/${link.repository.name}#${link.ref}`}
              >
                <span className="chat-dock-inbox-hover-card__pr-ref">
                  #{link.ref}
                </span>
                <span className="chat-dock-inbox-hover-card__pr-title">
                  <bdi>
                    {link.status.state === 'current'
                      ? link.status.title
                      : link.status.reason}
                  </bdi>
                </span>
                <span className="chat-dock-inbox-hover-card__pr-meta">
                  {sourceLabel(link.source)}
                  {link.status.state === 'current'
                    ? ` · ${link.status.pullRequestState}`
                    : ` · ${link.status.state}`}
                </span>
              </li>
            ))}
          </ul>
          {prLinks.length > PR_PREVIEW_LIMIT && (
            <p className="chat-dock-inbox-hover-card__more">
              +{prLinks.length - PR_PREVIEW_LIMIT} more in Linked pull requests
            </p>
          )}
        </>
      ) : null}
    </section>
  ) : null;

  const basisGroups = basisModel
    ? BASIS_GROUP_ORDER.map((id) =>
        basisModel.groups.find((group) => group.id === id),
      )
        .filter(
          (group): group is NonNullable<typeof group> =>
            !!group && group.items.length > 0,
        )
        .slice(0, BASIS_GROUP_LIMIT)
    : [];
  const basisPreviews = basisGroups
    .flatMap((group) => group.items.slice(0, 2))
    .slice(0, BASIS_ITEM_LIMIT);
  const basisGap = basisModel?.groups
    .flatMap((group) => group.gaps)
    .find((gap) => gap.length > 0);
  const basisEnabled = Boolean(basisScope && scope?.isCurrent());
  const basisSection = basisScope ? (
    <section className="chat-dock-inbox-hover-card__section" aria-label="Basis">
      <h4>Basis</h4>
      {!basisEnabled || inventory.error || !basisModel ? (
        <p className="chat-dock-inbox-hover-card__gap">Basis unavailable.</p>
      ) : inventory.isLoading ? (
        <p className="chat-dock-inbox-hover-card__gap">
          Reading session basis…
        </p>
      ) : basisGroups.length === 0 ? (
        <p className="chat-dock-inbox-hover-card__gap">
          No basis recorded for this session.
        </p>
      ) : (
        <>
          <ul className="chat-dock-inbox-hover-card__groups">
            {basisGroups.map((group) => (
              <li key={group.key}>
                {group.label}
                <b>{group.count ?? String(group.items.length)}</b>
              </li>
            ))}
          </ul>
          <ul className="chat-dock-inbox-hover-card__basis-items">
            {basisPreviews.map((viewItem) => (
              <li key={viewItem.key}>
                <bdi>{viewItem.label}</bdi>
                {viewItem.classification === 'kept' && (
                  <span className="chat-dock-inbox-hover-card__kept">Kept</span>
                )}
              </li>
            ))}
          </ul>
          {basisGap && (
            <p className="chat-dock-inbox-hover-card__gap">{basisGap}</p>
          )}
        </>
      )}
    </section>
  ) : null;

  return createPortal(
    <div
      ref={cardRef}
      id={id}
      className="chat-dock-inbox-hover-card"
      style={position}
      role="tooltip"
      data-testid="inbox-row-hover-card"
    >
      <p className="chat-dock-inbox-hover-card__title">
        <bdi>{item.title}</bdi>
      </p>
      <dl className="chat-dock-inbox-hover-card__meta">
        <div>
          <dt>Project</dt>
          <dd>
            <bdi>{item.projectLabel}</bdi>
          </dd>
        </div>
        {item.environmentLabel && (
          <div>
            <dt>Machine</dt>
            <dd>
              <bdi>{item.environmentLabel}</bdi>
            </dd>
          </div>
        )}
        <div>
          <dt>Engine</dt>
          <dd>
            {item.controlMode === 'read-only-attached'
              ? `Started in ${item.agentLabel}`
              : `${item.agentLabel} · ${item.modelLabel}`}
          </dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd className="chat-dock-inbox-hover-card__status">
            {hasLifecycleChip(item.lifecycleLabel) ? (
              <LifecycleStatusChip lifecycle={item.lifecycleLabel} />
            ) : null}
            {item.updatedAt > 0 && (
              <span>{relativeTime(item.updatedAt, now)}</span>
            )}
          </dd>
        </div>
      </dl>
      {(item.failureNotice || item.unanswerableNotice) && (
        <p className="chat-dock-inbox-hover-card__notice">
          {item.failureNotice ?? item.unanswerableNotice}
        </p>
      )}
      {gitSection}
      {prSection}
      {basisSection}
    </div>,
    document.body,
  );
}

function GitFacts({
  git,
}: {
  git: Extract<GitStatusResult, { isRepo: true }>;
}) {
  const dirty = git.staged + git.unstaged + git.untracked;
  return (
    <>
      <p className="chat-dock-inbox-hover-card__branch">
        <span className="chat-dock-inbox-hover-card__branch-name">
          {git.branch}
        </span>
        {dirty > 0 && (
          <span className="chat-dock-inbox-hover-card__dirty">
            {dirty} change{dirty === 1 ? '' : 's'}
          </span>
        )}
        {git.ahead > 0 && <span>↑{git.ahead}</span>}
        {git.behind > 0 && <span>↓{git.behind}</span>}
      </p>
      {git.lastCommit && (
        <p className="chat-dock-inbox-hover-card__commit">
          <bdi>{git.lastCommit.message}</bdi>
          <span>
            {git.lastCommit.author} · {git.lastCommit.sha}
          </span>
        </p>
      )}
    </>
  );
}

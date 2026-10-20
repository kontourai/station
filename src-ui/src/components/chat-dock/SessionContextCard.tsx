import type { GitStatusResult } from '@kontourai/station-sdk';
import { memo, type ReactNode, useLayoutEffect } from 'react';
import type { WorkStatusTone } from '../../views/home/work-status';
import { BranchGlyph, FolderGlyph } from '../icons/Glyph';
import { useConversationPullRequestLinks } from '../pull-requests/useConversationPullRequestLinks';
import { SESSION_CONTEXT_CARD_WIDTH } from './sessionContextCardModel';
import './SessionContextCard.css';

/**
 * What the session context card shows. Every field is something the dock
 * already computes for its own chrome — the project and directory the
 * header's badge names, the git status behind its branch badge, the inbox
 * row's status line, the Background tasks count, the composer's pending
 * queue — and every action opens a surface that already exists. The card adds
 * no read of its own except the pull request links, which share the one
 * cache entry Chat details and the Coding pull requests panel read.
 */
export interface SessionContextCardProps {
  workspace: {
    projectName: string | null;
    directory: string | null;
    /** Open in Coding, or the project page where there is no coding layout. */
    action?: { label: string; onSelect: () => void };
  } | null;
  gitStatus: GitStatusResult | null | undefined;
  /** The Active work Changed files panel; absent without a project. */
  onOpenChanges?: () => void;
  /** The inbox row's status line for this chat (the ladder), or none yet. */
  status: { text: string; tone: WorkStatusTone } | null;
  backgroundTasksRunning: number;
  onOpenBackgroundTasks?: () => void;
  /** The composer queue's own count ("N pending messages"). */
  pendingMessages: number;
  conversationId: string | null;
  /** Chat details, where the linked pull requests are managed. */
  onOpenChatDetails?: () => void;
  /**
   * Chat inventory, offered only once its host has registered: a host that
   * never arrives (no authority yet, a chunk that failed) leaves no footer,
   * rather than a "loading" label that may never resolve.
   */
  inventory?: {
    onOpen: (trigger: HTMLElement) => void;
  };
}

const directoryName = (path: string) =>
  path
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() || path;

function Row({
  label,
  icon,
  children,
  onSelect,
  actionLabel,
}: {
  label: string;
  icon?: ReactNode;
  children: ReactNode;
  onSelect?: () => void;
  /** The row's accessible name when it is a button. */
  actionLabel?: string;
}) {
  const body = (
    <>
      <span className="session-context-card__label">
        {icon}
        {label}
      </span>
      <span className="session-context-card__value">{children}</span>
    </>
  );
  return (
    <li className="session-context-card__row">
      {onSelect ? (
        <button
          type="button"
          className="session-context-card__action"
          aria-label={actionLabel}
          onClick={onSelect}
        >
          {body}
        </button>
      ) : (
        <div className="session-context-card__static">{body}</div>
      )}
    </li>
  );
}

function PullRequestsRow({
  conversationId,
  onOpenChatDetails,
}: {
  conversationId: string;
  onOpenChatDetails?: () => void;
}) {
  const { links } = useConversationPullRequestLinks(conversationId);
  const observed = links.data?.links ?? [];
  // Nothing linked says nothing: a row appears over real links or a failed
  // read (a named gap), never over silence or a read in flight.
  if (!links.error && observed.length === 0) return null;
  return (
    <Row
      label="Pull requests"
      onSelect={onOpenChatDetails}
      actionLabel={
        links.error
          ? 'Pull requests unavailable — open chat details'
          : `${observed.length} linked pull request${observed.length === 1 ? '' : 's'} — open chat details`
      }
    >
      {links.error ? (
        <span className="session-context-card__gap">
          Pull requests unavailable
        </span>
      ) : (
        <ul className="session-context-card__prs">
          {observed.slice(0, 3).map((link) => (
            <li
              key={`${link.source}:${link.host}/${link.repository.owner}/${link.repository.name}#${link.ref}`}
            >
              <span className="session-context-card__pr-ref">#{link.ref}</span>
              <bdi className="session-context-card__pr-title">
                {link.status.state === 'current'
                  ? link.status.title
                  : link.status.reason}
              </bdi>
              {link.status.state === 'current' ? (
                <span className="session-context-card__pr-state">
                  {link.status.pullRequestState.toLowerCase()}
                </span>
              ) : null}
            </li>
          ))}
          {observed.length > 3 ? (
            <li className="session-context-card__more">
              +{observed.length - 3} more
            </li>
          ) : null}
        </ul>
      )}
    </Row>
  );
}

/**
 * The rows, shared by the inline card and the sheet. `wrap` runs before a
 * row's action: the sheet closes itself first, so the surface the row opens
 * is not under a scrim.
 */
export function SessionContextRows({
  workspace,
  gitStatus,
  onOpenChanges,
  status,
  backgroundTasksRunning,
  onOpenBackgroundTasks,
  pendingMessages,
  conversationId,
  onOpenChatDetails,
  inventory,
  wrap = (action) => action(),
  inventoryTrigger,
}: SessionContextCardProps & {
  wrap?: (action: () => void) => void;
  /**
   * The element the inventory returns focus to. The sheet's own button
   * unmounts as the sheet closes, so the sheet names its chip instead.
   */
  inventoryTrigger?: HTMLElement | null;
}) {
  const changed = gitStatus?.isRepo ? gitStatus.changes.length : 0;
  const run = (action?: () => void) =>
    action ? () => wrap(action) : undefined;
  return (
    <>
      <ul className="session-context-card__rows">
        {workspace && (workspace.projectName || workspace.directory) ? (
          <Row
            label="Workspace"
            icon={<FolderGlyph className="session-context-card__glyph" />}
            onSelect={run(workspace.action?.onSelect)}
            actionLabel={
              workspace.action
                ? `${workspace.action.label} — ${workspace.projectName ?? workspace.directory}`
                : undefined
            }
          >
            <span className="session-context-card__primary">
              {workspace.projectName ??
                directoryName(workspace.directory as string)}
            </span>
            {workspace.directory ? (
              <span
                className="session-context-card__secondary session-context-card__path"
                title={workspace.directory}
              >
                <bdi dir="ltr">{workspace.directory}</bdi>
              </span>
            ) : null}
            {workspace.action ? (
              <span className="session-context-card__hint" aria-hidden="true">
                {workspace.action.label}
              </span>
            ) : null}
          </Row>
        ) : null}
        {gitStatus?.isRepo ? (
          <Row
            label="Branch"
            icon={<BranchGlyph className="session-context-card__glyph" />}
            onSelect={run(onOpenChanges)}
            actionLabel={
              onOpenChanges
                ? `Changed files — ${changed} on ${gitStatus.branch}`
                : undefined
            }
          >
            <span className="session-context-card__primary">
              {gitStatus.branch}
            </span>
            <span className="session-context-card__secondary">
              {changed === 0
                ? 'Working tree is clean'
                : `${changed} changed file${changed === 1 ? '' : 's'}`}
              {gitStatus.ahead > 0 ? ` · ${gitStatus.ahead} ahead` : ''}
              {gitStatus.behind > 0 ? ` · ${gitStatus.behind} behind` : ''}
            </span>
          </Row>
        ) : null}
        {status || onOpenBackgroundTasks ? (
          <Row
            label="Activity"
            onSelect={run(onOpenBackgroundTasks)}
            actionLabel={
              onOpenBackgroundTasks
                ? [
                    status?.text,
                    backgroundTasksRunning > 0
                      ? `Background tasks — ${backgroundTasksRunning} running`
                      : 'Background tasks',
                  ]
                    .filter(Boolean)
                    .join(', ')
                : undefined
            }
          >
            {status ? (
              <span
                className="session-context-card__status"
                data-tone={status.tone}
              >
                {status.text}
              </span>
            ) : null}
            <span className="session-context-card__secondary">
              {backgroundTasksRunning > 0
                ? `Background tasks — ${backgroundTasksRunning} running`
                : 'No background tasks running'}
            </span>
            {pendingMessages > 0 ? (
              <span className="session-context-card__secondary">
                {pendingMessages} pending message
                {pendingMessages === 1 ? '' : 's'}
              </span>
            ) : null}
          </Row>
        ) : null}
        {conversationId ? (
          <PullRequestsRow
            conversationId={conversationId}
            onOpenChatDetails={run(onOpenChatDetails)}
          />
        ) : null}
      </ul>
      {inventory ? (
        <div className="session-context-card__footer">
          <button
            type="button"
            className="session-context-card__link"
            aria-haspopup="dialog"
            onClick={(event) => {
              const trigger = inventoryTrigger ?? event.currentTarget;
              wrap(() => inventory.onOpen(trigger));
            }}
          >
            Chat inventory
          </button>
        </div>
      ) : null}
    </>
  );
}

/**
 * The inline card: a column at the dock's right edge when the dock has room.
 * `onPresentChange` reports that it is actually on screen: the header keeps
 * the facts the card repeats until then, so a chunk still loading (or one
 * that failed to load) never leaves them shown nowhere.
 */
function SessionContextCardImpl({
  onPresentChange,
  ...props
}: SessionContextCardProps & {
  onPresentChange?: (present: boolean) => void;
}) {
  useLayoutEffect(() => {
    onPresentChange?.(true);
    return () => onPresentChange?.(false);
  }, [onPresentChange]);
  return (
    <aside
      className="session-context-card"
      aria-label="This chat"
      style={{ width: SESSION_CONTEXT_CARD_WIDTH }}
    >
      <h2 className="session-context-card__title">This chat</h2>
      <SessionContextRows {...props} />
    </aside>
  );
}

/** Memoised: the dock re-renders on every resize frame and stream event. */
export const SessionContextCard = memo(SessionContextCardImpl);

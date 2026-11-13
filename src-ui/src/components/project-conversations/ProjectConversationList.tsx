import { PROJECT_ROOM_DEFAULT_CHANNEL_NAME } from '@kontourai/station-contracts/project-room';
import type { ApiRequestScope } from '@kontourai/station-sdk/project-rooms';
import { type KeyboardEvent, useRef, useState } from 'react';
import { useIsMobile } from '../../hooks/useIsMobile';
import { Button } from '../Button';
import { PlusGlyph } from '../icons/Glyph';
import { Empty, ErrorState, SkeletonBlock } from '../state';
import {
  type ConversationEntry,
  type ConversationUnread,
  TASK_ROOMS_SHOWN,
} from './projectConversationIndex';
import { useProjectConversationIndex } from './useProjectConversationIndex';
import './ProjectConversationList.css';

/**
 * Which conversation the app is showing: a channel (`null` is the Project's
 * default channel) or a Task room. Absent when neither is on screen.
 */
export type CurrentConversation =
  | { kind: 'channel'; channelId: string | null }
  | { kind: 'task'; taskId: string };

export interface ProjectConversationListProps {
  project: { slug: string; id: string; name: string };
  requestScope: ApiRequestScope | undefined;
  /** Reads run only while the list is shown. */
  enabled?: boolean;
  /** `sidebar`: compact rows under a Project. `page`: the phone's list. */
  variant: 'sidebar' | 'page';
  current?: CurrentConversation;
  /** `undefined` opens the default channel. */
  onOpenChannel(channelId: string | undefined): void;
  onOpenTask(taskId: string): void;
  onMoreTasks(): void;
  onNewChannel(): void;
}

interface Row {
  key: string;
  label: string;
  name: string;
  kind: 'channel' | 'task';
  unread?: ConversationUnread;
  working?: boolean;
  current: boolean;
  open(): void;
}

/** What a screen reader hears after the row's visible name. */
function suffix(row: Row) {
  const unread = !row.unread?.unread
    ? ''
    : row.unread.count
      ? `, ${countText(row.unread.count)} unread`
      : ', unread';
  return `${row.kind === 'task' ? ', Task room' : ''}${row.working ? ', agent working' : ''}${unread}`;
}

/** The server caps room counts at 99, meaning "99 or more". */
function countText(count: number) {
  return count >= 99 ? '99+' : String(count);
}

/**
 * A Project's channels and Task rooms (#4794, #4795). The sidebar renders it
 * under the expanded Project; a phone renders it as the Project's page.
 * Rows share one tab stop; Up/Down, Home and End move within the list and
 * Enter or Space opens a row.
 */
export function ProjectConversationList({
  project,
  requestScope,
  enabled = true,
  variant,
  current,
  onOpenChannel,
  onOpenTask,
  onMoreTasks,
  onNewChannel,
}: ProjectConversationListProps) {
  const index = useProjectConversationIndex(project, requestScope, enabled);
  const touch = useIsMobile();
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const [focusKey, setFocusKey] = useState<string>();

  const channelRows: Row[] = index.channels.entries.map((entry) =>
    rowFor(entry, current, onOpenChannel, onOpenTask),
  );
  // Before a room is opened, or on a host without channels, the Project has
  // one channel: its default room, reached the same way.
  const placeholder =
    !index.channels.isPending &&
    !index.channels.isError &&
    !index.channels.projectMissing &&
    channelRows.length === 0;
  if (placeholder)
    channelRows.push({
      key: 'channel:default',
      label: PROJECT_ROOM_DEFAULT_CHANNEL_NAME,
      name: PROJECT_ROOM_DEFAULT_CHANNEL_NAME,
      kind: 'channel',
      current: current?.kind === 'channel' && current.channelId === null,
      open: () => onOpenChannel(undefined),
    });
  const taskRows = index.tasks.entries
    .slice(0, TASK_ROOMS_SHOWN)
    .map((entry) => rowFor(entry, current, onOpenChannel, onOpenTask));
  const moreTasks = index.tasks.entries.length > TASK_ROOMS_SHOWN;
  const rows = [...channelRows, ...taskRows];
  const moreKey = 'more-tasks';
  const order = [
    ...rows.map((row) => row.key),
    ...(moreTasks ? [moreKey] : []),
  ];
  const stop =
    (focusKey && order.includes(focusKey) && focusKey) ||
    rows.find((row) => row.current)?.key ||
    order[0];

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = order.indexOf(
      (event.target as HTMLElement).dataset.conversationRow ?? '',
    );
    if (at < 0) return;
    const next =
      event.key === 'ArrowDown'
        ? Math.min(at + 1, order.length - 1)
        : event.key === 'ArrowUp'
          ? Math.max(at - 1, 0)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? order.length - 1
              : -1;
    if (next < 0) return;
    event.preventDefault();
    const key = order[next]!;
    setFocusKey(key);
    buttons.current.get(key)?.focus();
  };

  const renderRow = (row: Row) => (
    <li key={row.key} className="conversation-list__item">
      <button
        type="button"
        ref={(node) => {
          if (node) buttons.current.set(row.key, node);
          else buttons.current.delete(row.key);
        }}
        data-conversation-row={row.key}
        tabIndex={row.key === stop ? 0 : -1}
        className={`conversation-list__row${row.unread?.unread ? ' conversation-list__row--unread' : ''}${row.current ? ' conversation-list__row--current' : ''}`}
        aria-current={row.current ? 'page' : undefined}
        // The name names the row; the mark, count and chevron are drawn by
        // CSS, so the visible text is exactly the name's start (label in
        // name, WCAG 2.5.3) and the name stays one exact phrase.
        aria-label={`${row.name}${suffix(row)}`}
        onFocus={() => setFocusKey(row.key)}
        onClick={row.open}
      >
        <span
          className={`conversation-list__mark ${row.kind === 'channel' ? 'conversation-list__hash' : `conversation-list__task-mark${row.working ? ' conversation-list__task-mark--working' : ''}`}`}
          aria-hidden="true"
        />
        <span className="conversation-list__label" title={row.label}>
          {row.label}
        </span>
        {row.unread?.unread && row.unread.count ? (
          <span
            className="conversation-list__count"
            data-count={countText(row.unread.count)}
            aria-hidden="true"
          />
        ) : null}
        {variant === 'page' && (
          <span className="conversation-list__chevron" aria-hidden="true" />
        )}
      </button>
    </li>
  );

  // A page section is a real heading; inside the sidebar's navigation the
  // labels name their groups without adding to the page outline.
  const Heading = variant === 'page' ? 'h2' : 'span';
  const headingId = (section: string) =>
    `conversation-list-${variant}-${project.slug}-${section}`;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: arrow keys move between the rows' own buttons; the container only routes them.
    <div
      className={`conversation-list conversation-list--${variant}${touch ? ' conversation-list--touch' : ''}`}
      onKeyDown={onKeyDown}
    >
      <div className="conversation-list__section">
        <div className="conversation-list__heading">
          <Heading id={headingId('channels')}>Channels</Heading>
          <button
            type="button"
            className="conversation-list__add"
            aria-label={`New channel in ${project.name}`}
            title="New channel"
            onClick={onNewChannel}
          >
            <PlusGlyph />
          </button>
        </div>
        {index.channels.isPending ? (
          <SkeletonBlock count={2} label="Loading channels" />
        ) : index.channels.projectMissing ? (
          <Empty
            variant="compact"
            label="This Project isn't on this Station."
          />
        ) : index.channels.isError ? (
          <ErrorState
            variant="compact"
            title="Channels could not be loaded."
            action={
              <Button size="sm" onClick={index.channels.retry}>
                Retry
              </Button>
            }
          />
        ) : (
          <>
            <ul
              className="conversation-list__rows"
              aria-labelledby={headingId('channels')}
            >
              {channelRows.map(renderRow)}
            </ul>
            {index.channels.unreadError && (
              <ErrorState
                variant="compact"
                title="Unread state could not be loaded."
                action={
                  <Button
                    size="sm"
                    aria-label="Retry unread state"
                    onClick={index.channels.retryUnread}
                  >
                    Retry
                  </Button>
                }
              />
            )}
          </>
        )}
      </div>
      {(index.tasks.isPending ||
        index.tasks.isError ||
        taskRows.length > 0 ||
        variant === 'page') && (
        <div className="conversation-list__section">
          <div className="conversation-list__heading">
            <Heading id={headingId('tasks')}>Tasks</Heading>
          </div>
          {index.tasks.isPending ? (
            <SkeletonBlock count={2} label="Loading Task rooms" />
          ) : index.tasks.isError ? (
            <ErrorState
              variant="compact"
              title="Task rooms could not be loaded."
              action={
                <Button size="sm" onClick={index.tasks.retry}>
                  Retry
                </Button>
              }
            />
          ) : taskRows.length === 0 ? (
            <Empty
              variant="compact"
              label="A Task's room shows here once it is open."
            />
          ) : (
            <ul
              className="conversation-list__rows"
              aria-labelledby={headingId('tasks')}
            >
              {taskRows.map(renderRow)}
              {moreTasks && (
                <li className="conversation-list__item">
                  <button
                    type="button"
                    ref={(node) => {
                      if (node) buttons.current.set(moreKey, node);
                      else buttons.current.delete(moreKey);
                    }}
                    data-conversation-row={moreKey}
                    tabIndex={moreKey === stop ? 0 : -1}
                    className="conversation-list__row conversation-list__more"
                    onFocus={() => setFocusKey(moreKey)}
                    onClick={onMoreTasks}
                  >
                    <span className="conversation-list__label">More Tasks</span>
                    {variant === 'page' && (
                      <span
                        className="conversation-list__chevron"
                        aria-hidden="true"
                      >
                        ›
                      </span>
                    )}
                  </button>
                </li>
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function rowFor(
  entry: ConversationEntry,
  current: CurrentConversation | undefined,
  onOpenChannel: (channelId: string | undefined) => void,
  onOpenTask: (taskId: string) => void,
): Row {
  if (entry.kind === 'channel') {
    const { channel } = entry;
    return {
      key: entry.key,
      label: channel.name,
      name: channel.name,
      kind: 'channel',
      unread: entry.unread,
      current:
        current?.kind === 'channel' &&
        (current.channelId === null
          ? channel.isDefault
          : current.channelId === channel.channelId),
      // The default channel is addressed without an id, as the room is.
      open: () =>
        onOpenChannel(channel.isDefault ? undefined : channel.channelId),
    };
  }
  return {
    key: entry.key,
    label: entry.task.title,
    name: entry.task.title,
    kind: 'task',
    unread: entry.unread,
    working: entry.working,
    current: current?.kind === 'task' && current.taskId === entry.task.id,
    open: () => onOpenTask(entry.task.id),
  };
}

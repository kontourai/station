import type { ProjectRoomChannel } from '@kontourai/station-contracts/project-room';
import {
  isReadMarkerUnavailable,
  type ReadMarkerState,
  type ReadMarkerSummary,
  type ReadMarkerTarget,
  readMarkerTargetKey,
} from '@kontourai/station-contracts/read-markers';
import type { TaskRecord } from '@kontourai/station-contracts/task-graph';

/**
 * A Project's places to talk, as the sidebar and the phone's channel list
 * show them (#4794, #4795): its channels, then its Task rooms.
 *
 * Every fact here comes from a server read. Unread is the read-marker
 * summary's own `unread` (#3075), never a client comparison. A Task is listed
 * only when the summary can read its room: a room that was never opened is
 * `unavailable`, and reading markers never opens one. "Mentions me" is not
 * modelled: nothing computes it until #4799.
 */

/** Recently updated Tasks whose rooms the summary is asked about. */
export const TASK_ROOM_CANDIDATES = 30;
/** Task rooms shown before "More Tasks". */
export const TASK_ROOMS_SHOWN = 5;

export interface ConversationUnread {
  unread: boolean;
  /** Records after the marker; capped by the server at 99. */
  count?: number;
}

export interface ChannelEntry {
  kind: 'channel';
  key: string;
  channel: ProjectRoomChannel;
  unread: ConversationUnread | undefined;
}

export interface TaskRoomEntry {
  kind: 'task';
  key: string;
  task: Pick<TaskRecord, 'id' | 'title' | 'updatedAt' | 'sessionId'>;
  unread: ConversationUnread | undefined;
  /** The Task's session is in the Project's Running lane. */
  working: boolean;
}

export type ConversationEntry = ChannelEntry | TaskRoomEntry;

export function channelTarget(
  projectSlug: string,
  channel: Pick<ProjectRoomChannel, 'channelId'>,
): ReadMarkerTarget {
  return { kind: 'project-room', projectSlug, roomId: channel.channelId };
}

export function taskRoomTarget(task: Pick<TaskRecord, 'id'>): ReadMarkerTarget {
  return { kind: 'task-room', taskId: task.id };
}

/** Listed channels: the server's order (default first, then by name), live only. */
export function listedChannels(
  channels: readonly ProjectRoomChannel[] | undefined,
): ProjectRoomChannel[] {
  return (channels ?? []).filter((channel) => !channel.archivedAt);
}

/** The Tasks most recently updated first, bounded for one summary request. */
export function taskRoomCandidates<
  T extends Pick<TaskRecord, 'id' | 'updatedAt'>,
>(tasks: readonly T[] | undefined): T[] {
  return [...(tasks ?? [])]
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, TASK_ROOM_CANDIDATES);
}

export function readStates(
  summary: ReadMarkerSummary | undefined,
): Map<string, ReadMarkerState | 'unavailable'> {
  const states = new Map<string, ReadMarkerState | 'unavailable'>();
  for (const item of summary?.items ?? [])
    states.set(
      readMarkerTargetKey(item.target),
      isReadMarkerUnavailable(item) ? 'unavailable' : item,
    );
  return states;
}

function unreadOf(
  state: ReadMarkerState | 'unavailable' | undefined,
): ConversationUnread | undefined {
  if (!state || state === 'unavailable') return undefined;
  return {
    unread: state.unread,
    ...(state.unreadCount !== undefined ? { count: state.unreadCount } : {}),
  };
}

export function channelEntries(
  projectSlug: string,
  channels: readonly ProjectRoomChannel[],
  states: Map<string, ReadMarkerState | 'unavailable'>,
): ChannelEntry[] {
  return channels.map((channel) => {
    const key = readMarkerTargetKey(channelTarget(projectSlug, channel));
    return {
      kind: 'channel',
      key,
      channel,
      unread: unreadOf(states.get(key)),
    };
  });
}

/**
 * Task rooms the summary could read, in the candidates' order. Candidates
 * the summary has not answered yet are left out rather than guessed.
 */
export function taskRoomEntries(
  candidates: readonly Pick<
    TaskRecord,
    'id' | 'title' | 'updatedAt' | 'sessionId'
  >[],
  states: Map<string, ReadMarkerState | 'unavailable'>,
  runningSessionIds: ReadonlySet<string>,
): TaskRoomEntry[] {
  const entries: TaskRoomEntry[] = [];
  for (const task of candidates) {
    const key = readMarkerTargetKey(taskRoomTarget(task));
    const state = states.get(key);
    if (!state || state === 'unavailable') continue;
    entries.push({
      kind: 'task',
      key,
      task,
      unread: unreadOf(state),
      working: !!task.sessionId && runningSessionIds.has(task.sessionId),
    });
  }
  return entries;
}

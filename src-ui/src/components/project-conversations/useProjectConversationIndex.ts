import {
  useOrchestrationSessionsQuery,
  useReadMarkerSummaryQuery,
  useTasksQuery,
} from '@kontourai/station-sdk';
import {
  type ApiRequestScope,
  useProjectRoomChannels,
} from '@kontourai/station-sdk/project-rooms';
import { useMemo } from 'react';
import { useAgents } from '../../contexts/AgentsContext';
import { projectLiveLanes } from '../../views/project-page/project-live-work-model';
import {
  type ChannelEntry,
  channelEntries,
  channelTarget,
  listedChannels,
  readStates,
  type TaskRoomEntry,
  taskRoomCandidates,
  taskRoomEntries,
  taskRoomTarget,
} from './projectConversationIndex';

/**
 * Unread state is re-read on this interval while a list is on screen: a
 * second device's read, or a message in a channel nobody here has open,
 * reaches this list within one interval. Opening a room here invalidates it
 * at once (`useMarkReadMutation`).
 */
export const CONVERSATION_SUMMARY_REFRESH_MS = 30_000;

export interface ProjectConversationIndex {
  channels: {
    entries: ChannelEntry[];
    isPending: boolean;
    isError: boolean;
    /** The host predates channels: only its default room exists. */
    unsupported: boolean;
    retry(): void;
  };
  tasks: {
    entries: TaskRoomEntry[];
    isPending: boolean;
    isError: boolean;
    retry(): void;
  };
}

/**
 * One Project's channels and Task rooms with server-kept unread state, for
 * the sidebar and the phone's channel list. One summary request covers both
 * (at most 50 channels + {@link TASK_ROOM_CANDIDATES} Tasks, under the
 * summary's 100-target bound).
 */
export function useProjectConversationIndex(
  project: { slug: string; id: string },
  requestScope: ApiRequestScope | undefined,
  enabled: boolean,
): ProjectConversationIndex {
  const active = enabled && !!requestScope;
  const channels = useProjectRoomChannels(
    requestScope ?? { apiBase: '', authorityKey: '' },
    project.slug,
    project.id,
    active,
  );
  const tasks = useTasksQuery(project.slug, { enabled: active });
  const agents = useAgents();
  const { data: sessions = [] } = useOrchestrationSessionsQuery();
  const listed = useMemo(
    () => listedChannels(channels.list.data),
    [channels.list.data],
  );
  const candidates = useMemo(
    () => taskRoomCandidates(tasks.data),
    [tasks.data],
  );
  const targets = useMemo(
    () => [
      ...listed.map((channel) => channelTarget(project.slug, channel)),
      ...candidates.map(taskRoomTarget),
    ],
    [listed, candidates, project.slug],
  );
  const summary = useReadMarkerSummaryQuery(targets, {
    enabled: active,
    refetchInterval: active ? CONVERSATION_SUMMARY_REFRESH_MS : false,
  });
  const states = useMemo(() => readStates(summary.data), [summary.data]);
  const running = useMemo(() => {
    const lanes = projectLiveLanes({
      sessions,
      agents,
      projectSlug: project.slug,
      now: Date.now(),
    });
    return new Set(
      lanes
        .filter((lane) => lane.id === 'running')
        .flatMap((lane) => lane.sessions.map((session) => session.threadId)),
    );
  }, [sessions, agents, project.slug]);
  const taskEntries = useMemo(
    () => taskRoomEntries(candidates, states, running),
    [candidates, states, running],
  );
  return {
    channels: {
      entries: channelEntries(project.slug, listed, states),
      isPending: channels.list.isPending && !channels.unsupported,
      isError: channels.list.isError && !channels.unsupported,
      unsupported: channels.unsupported,
      retry: () => void channels.list.refetch(),
    },
    tasks: {
      entries: taskEntries,
      // No Tasks means no Task rooms: there is nothing to ask the summary.
      isPending:
        tasks.isPending ||
        (candidates.length > 0 && summary.isPending && !summary.isError),
      isError: tasks.isError || (candidates.length > 0 && summary.isError),
      retry: () => {
        void tasks.refetch();
        void summary.refetch();
      },
    },
  };
}

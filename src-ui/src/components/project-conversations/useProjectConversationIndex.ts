import type { ProjectSharedTaskSummary } from '@kontourai/station-contracts/project-shared-task';
import {
  fetchReadMarkerSummary,
  readMarkerQueries,
  useOrchestrationSessionsQuery,
  useReadMarkerSummaryQuery,
  useTasksQuery,
} from '@kontourai/station-sdk';
import {
  type ApiRequestScope,
  useProjectRoomChannels,
  useProjectRoomLiveIndex,
  workingProjectRoomAgents,
} from '@kontourai/station-sdk/project-rooms';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef } from 'react';
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
/** A burst of live activity re-reads the summary once, this long after it. */
const LIVE_SUMMARY_SETTLE_MS = 750;

export interface ProjectConversationIndex {
  channels: {
    entries: ChannelEntry[];
    isPending: boolean;
    isError: boolean;
    /** The host predates channels: only its default room exists. */
    unsupported: boolean;
    /** The Project is not on this Station: nothing to list or retry. */
    projectMissing: boolean;
    retry(): void;
    /**
     * Channels are listed but their unread state could not be read: the rows
     * stay, at normal weight, beside a retry.
     */
    unreadError: boolean;
    retryUnread(): void;
  };
  tasks: {
    entries: TaskRoomEntry[];
    isPending: boolean;
    isError: boolean;
    retry(): void;
  };
}

export interface MemberConversationIndexSource {
  tasks: {
    data?: ProjectSharedTaskSummary[];
    isPending: boolean;
    isError: boolean;
    refetch(): unknown;
  };
  isCurrent(): boolean;
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
  member?: MemberConversationIndexSource,
): ProjectConversationIndex {
  const memberOnly = member !== undefined;
  const active = enabled && !!requestScope && (member?.isCurrent() ?? true);
  const channels = useProjectRoomChannels(
    requestScope ?? { apiBase: '', authorityKey: '' },
    project.slug,
    project.id,
    active,
  );
  const operatorTasks = useTasksQuery(project.slug, {
    enabled: active && !member,
  });
  const tasks = member?.tasks ?? operatorTasks;
  const agents = useAgents();
  const { data: sessions = [] } = useOrchestrationSessionsQuery(
    member ? { enabled: false } : undefined,
    member ? null : undefined,
  );
  const listed = useMemo(
    () =>
      listedChannels(
        memberOnly && (!active || channels.list.isError)
          ? undefined
          : channels.list.data,
      ),
    [active, channels.list.data, channels.list.isError, memberOnly],
  );
  const memberTasks = member?.tasks.data;
  const memberTaskError = member?.tasks.isError;
  const candidates = useMemo(
    () =>
      taskRoomCandidates(
        memberOnly
          ? memberTaskError || !active
            ? []
            : memberTasks?.map(({ task, sharedAt }) => ({
                ...task,
                updatedAt: sharedAt,
              }))
          : operatorTasks.data,
      ),
    [active, memberOnly, memberTaskError, memberTasks, operatorTasks.data],
  );
  const targets = useMemo(
    () => [
      ...listed.map((channel) => channelTarget(project.slug, channel)),
      ...candidates.map(taskRoomTarget),
    ],
    [listed, candidates, project.slug],
  );
  // Ask once both lists have answered, so a Project costs one summary
  // request rather than one per list as each arrives.
  const settled = !channels.list.isPending || channels.unsupported;
  const operatorSummary = useReadMarkerSummaryQuery(targets, {
    enabled: !member && active && settled && !tasks.isPending,
    refetchInterval: active ? CONVERSATION_SUMMARY_REFRESH_MS : false,
  });
  const summaryOptions = readMarkerQueries.summary(targets);
  const memberSummary = useQuery({
    queryKey: [
      ...summaryOptions.queryKey,
      requestScope?.apiBase,
      requestScope?.authorityKey,
    ],
    queryFn: async ({ signal }) => {
      if (!member?.isCurrent() || !requestScope)
        throw new Error('The Station connection changed.');
      const result = await fetchReadMarkerSummary(
        requestScope.apiBase,
        targets,
        {
          requestScope,
          signal,
        },
      );
      if (!member.isCurrent())
        throw new Error('The Station connection changed.');
      return result;
    },
    enabled:
      !!member && active && settled && !tasks.isPending && targets.length > 0,
    staleTime: summaryOptions.staleTime,
    refetchInterval: active ? CONVERSATION_SUMMARY_REFRESH_MS : false,
    retry: false,
  });
  const summary = member ? memberSummary : operatorSummary;
  const summaryData =
    member && (!active || summary.isError) ? undefined : summary.data;
  const states = useMemo(() => readStates(summaryData), [summaryData]);
  // One live connection for every listed channel (#4798): a new message or
  // change re-reads the summary (unread, mentions) soon after, coalesced.
  const refetchSummary = summary.refetch;
  const pending = useRef<ReturnType<typeof setTimeout>>(undefined);
  const onActivity = useCallback(() => {
    if (pending.current) return;
    pending.current = setTimeout(() => {
      pending.current = undefined;
      void refetchSummary();
    }, LIVE_SUMMARY_SETTLE_MS);
  }, [refetchSummary]);
  useEffect(() => () => clearTimeout(pending.current), []);
  const channelIds = useMemo(
    () => listed.map((channel) => channel.channelId),
    [listed],
  );
  const live = useProjectRoomLiveIndex(
    requestScope ?? { apiBase: '', authorityKey: '' },
    project.slug,
    channelIds,
    active,
    onActivity,
  );
  const workingChannels = useMemo(
    () =>
      new Set(
        [...live]
          .filter(([, room]) => workingProjectRoomAgents(room.agents).length)
          .map(([id]) => id),
      ),
    [live],
  );
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
      entries: channelEntries(project.slug, listed, states, workingChannels),
      isPending: channels.list.isPending && !channels.unsupported,
      isError:
        channels.list.isError &&
        !channels.unsupported &&
        !channels.projectMissing,
      unsupported: channels.unsupported,
      projectMissing: channels.projectMissing,
      retry: () => void channels.list.refetch(),
      unreadError: listed.length > 0 && summary.isError,
      retryUnread: () => void summary.refetch(),
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

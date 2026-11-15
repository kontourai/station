import {
  PROJECT_ROOM_PROJECT_NOT_FOUND_CODE,
  type ProjectRoomChannelCreateInput,
  type ProjectRoomChannelUpdateInput,
} from '@kontourai/station-contracts/project-room';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { StationHttpError } from '../client/api-error-message';
import type { ApiRequestScope } from '../client/http';
import {
  createProjectRoomChannel,
  discoverProjectRoom,
  fetchProjectRoomHistory,
  initializeProjectRoom,
  listProjectRoomChannels,
  type ProjectRoomBrowserView,
  type ProjectRoomChannelGuards,
  type ProjectRoomMessageIntent,
  type ProjectRoomNoteIntent,
  ProjectRoomProtocolError,
  saveProjectRoomNote,
  sendProjectRoomMessage,
  setProjectRoomPresence,
  subscribeProjectRoom,
  updateProjectRoomChannel,
} from '../client/project-rooms';

export type { ApiRequestScope } from '../client/http';
export * from '../client/project-rooms';
export function projectRoomKey(
  scope: ApiRequestScope,
  projectId: string,
  roomId?: string,
) {
  return [
    'project-room',
    scope.apiBase,
    scope.authorityKey,
    projectId,
    ...(roomId ? [roomId] : []),
  ] as const;
}
/**
 * A named channel's cache root. It deliberately shares no prefix with
 * {@link projectRoomKey}: each room hook removes its root when it unmounts,
 * and switching channels must not clear the other room's cache.
 */
export function projectRoomChannelKey(
  scope: ApiRequestScope,
  projectId: string,
  channelId: string,
) {
  return [
    'project-room-channel',
    scope.apiBase,
    scope.authorityKey,
    projectId,
    channelId,
  ] as const;
}
export function projectRoomChannelsKey(
  scope: ApiRequestScope,
  projectId: string,
) {
  return [
    'project-room-channels',
    scope.apiBase,
    scope.authorityKey,
    projectId,
  ] as const;
}
/**
 * Most 25-message history windows a room keeps loaded (500 messages). Paging
 * past it drops the newest window, so a caller looking for an older message
 * stops here rather than lose what is on screen.
 */
export const PROJECT_ROOM_HISTORY_MAX_PAGES = 20;
/**
 * The room route said the Project itself is not on this Station (#4855):
 * show "no such Project", never "unavailable" with a retry.
 */
export function isProjectRoomProjectMissing(error: unknown) {
  return (
    error instanceof StationHttpError &&
    error.status === 404 &&
    error.code === PROJECT_ROOM_PROJECT_NOT_FOUND_CODE
  );
}
export function isProjectRoomAccessError(error: unknown) {
  return (
    error instanceof StationHttpError &&
    (error.status === 401 || error.status === 403)
  );
}
/**
 * One room's discovery, history, sends, note and live stream. Without
 * `channelId` it is the Project's default room (`/room`); with it, that
 * channel (`/channels/:channelId`).
 */
export function useProjectRoom(
  incomingScope: ApiRequestScope,
  slug: string,
  projectId: string,
  channelId?: string,
) {
  const { apiBase, authorityKey } = incomingScope;
  const scope = useMemo(
    () => ({ apiBase, authorityKey }),
    [apiBase, authorityKey],
  );
  const client = useQueryClient();
  const root = useMemo(
    () =>
      channelId === undefined
        ? projectRoomKey(scope, projectId)
        : projectRoomChannelKey(scope, projectId, channelId),
    [scope, projectId, channelId],
  );
  const [stopped, setStopped] = useState(false);
  const [streamError, setStreamError] = useState(false);
  const discovery = useQuery({
    queryKey: [...root, 'discovery', slug],
    enabled: !stopped,
    retry: false,
    queryFn: ({ signal }) =>
      discoverProjectRoom(scope, slug, projectId, signal, channelId),
    staleTime: 0,
    gcTime: 0,
  });
  const room = discovery.data;
  const roomId = room?.roomId;
  const actorId = room?.actor.id;
  const contentKey = useMemo(
    () => [...root, roomId ?? 'unopened', 'history'],
    [root, roomId],
  );
  const tailAfter = Math.max(0, (room?.checkpoint.lastSeq ?? 0) - 25);
  const history = useInfiniteQuery({
    queryKey: [...contentKey, tailAfter],
    enabled: !!roomId && !stopped,
    retry: false,
    gcTime: 0,
    initialPageParam: { after: tailAfter, end: tailAfter + 25 },
    queryFn: async ({ pageParam, signal }) => {
      // The byte cap can split even a 25-message window. Finish its forward
      // continuations before moving backward, without overlapping newer windows.
      const { end } = pageParam;
      let after = pageParam.after;
      const messages: Awaited<
        ReturnType<typeof fetchProjectRoomHistory>
      >['messages'] = [];
      for (let requests = 0; requests < 25; requests++) {
        signal.throwIfAborted();
        const page = await fetchProjectRoomHistory(
          scope,
          slug,
          { projectId, roomId: roomId! },
          after,
          Math.max(1, end - after),
          signal,
          channelId,
        );
        signal.throwIfAborted();
        messages.push(...page.messages.filter((item) => item.seq <= end));
        const last = page.messages[page.messages.length - 1]?.seq ?? after;
        if (
          last >= end ||
          (page.nextAfter === null && last >= page.checkpoint.lastSeq)
        )
          return { ...page, messages };
        if (page.nextAfter === null || page.nextAfter <= after)
          throw new ProjectRoomProtocolError(
            'Project room history is incomplete.',
          );
        after = page.nextAfter;
      }
      throw new ProjectRoomProtocolError(
        'Project room history exceeded its window budget.',
      );
    },
    getNextPageParam: (_last, _pages, { after }) =>
      after > 0 ? { after: Math.max(0, after - 25), end: after } : undefined,
    maxPages: PROJECT_ROOM_HISTORY_MAX_PAGES,
  });
  const initialize = useMutation({
    retry: false,
    mutationFn: () => initializeProjectRoom(scope, slug, projectId),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: root }),
        // Opening the room creates its first channel.
        client.invalidateQueries({
          queryKey: projectRoomChannelsKey(scope, projectId),
        }),
      ]),
  });
  const unprovisioned =
    discovery.error instanceof StationHttpError &&
    discovery.error.status === 404 &&
    discovery.error.code === 'project_room_not_found';
  const projectMissing = isProjectRoomProjectMissing(discovery.error);
  const send = useMutation({
    retry: false,
    mutationFn: (input: ProjectRoomMessageIntent) =>
      sendProjectRoomMessage(scope, slug, input, channelId),
    onSuccess: () => client.invalidateQueries({ queryKey: root }),
  });
  const note = useMutation({
    retry: false,
    mutationFn: (input: ProjectRoomNoteIntent) =>
      saveProjectRoomNote(scope, slug, input, channelId),
    onSuccess: () => client.invalidateQueries({ queryKey: root }),
  });
  useEffect(() => {
    if (
      ![
        discovery.error,
        history.error,
        initialize.error,
        send.error,
        note.error,
      ].some(isProjectRoomAccessError)
    )
      return;
    setStopped(true);
    void client.cancelQueries({ queryKey: root });
    client.removeQueries({ queryKey: root });
  }, [
    client,
    root,
    discovery.error,
    history.error,
    initialize.error,
    send.error,
    note.error,
  ]);
  useEffect(() => {
    if (!roomId || !actorId || stopped) return;
    let active = true;
    const guards = {
      expectedRoomId: roomId,
      expectedProjectId: projectId,
      expectedActorId: actorId,
    };
    const clientId = randomCorrelationId();
    const revoke = () => {
      if (!active) return;
      active = false;
      connection.close();
      setStopped(true);
      void client.cancelQueries({ queryKey: root });
      client.removeQueries({ queryKey: root });
    };
    const connection = subscribeProjectRoom(
      scope,
      slug,
      roomId,
      {
        onEvent(event) {
          if (!active) return;
          setStreamError(false);
          if (event.kind === 'revoked') revoke();
          else if (event.kind === 'changed')
            void client.invalidateQueries({ queryKey: root });
          else
            client.setQueryData(
              [...root, 'discovery', slug],
              (current: ProjectRoomBrowserView | undefined) =>
                current
                  ? { ...current, presence: event.participants }
                  : current,
            );
        },
        onError: () => {
          if (active) setStreamError(true);
        },
        onTerminal: revoke,
      },
      channelId,
    );
    const presence = () => {
      if (!active) return;
      void setProjectRoomPresence(
        scope,
        slug,
        { ...guards, clientId, state: 'join' },
        channelId,
      ).catch((error) => {
        if (isProjectRoomAccessError(error)) revoke();
      });
    };
    presence();
    const timer = setInterval(presence, 20_000);
    return () => {
      const wasActive = active;
      active = false;
      clearInterval(timer);
      connection.close();
      if (wasActive)
        void setProjectRoomPresence(
          scope,
          slug,
          { ...guards, clientId, state: 'leave' },
          channelId,
        ).catch(() => {});
    };
  }, [
    client,
    root,
    roomId,
    actorId,
    stopped,
    scope,
    slug,
    projectId,
    channelId,
  ]);
  useEffect(
    () => () => {
      void client.cancelQueries({ queryKey: root });
      client.removeQueries({ queryKey: root });
    },
    [client, root],
  );
  return {
    discovery,
    initialize,
    unprovisioned,
    projectMissing,
    history,
    send,
    note,
    stopped,
    streamError,
    recover: () => {
      initialize.reset();
      send.reset();
      note.reset();
      setStopped(false);
      setStreamError(false);
      void client.resetQueries({ queryKey: root });
    },
  };
}
/**
 * A Project's channels plus create and update. `unsupported` means the host
 * predates channels (a bare 404 for the list); show only the default room.
 * `projectMissing` means the Project itself is not on this Station.
 * Mutations refresh the list; callers pass guards from the room they show.
 */
export function useProjectRoomChannels(
  incomingScope: ApiRequestScope,
  slug: string,
  projectId: string,
  enabled = true,
) {
  const { apiBase, authorityKey } = incomingScope;
  const scope = useMemo(
    () => ({ apiBase, authorityKey }),
    [apiBase, authorityKey],
  );
  const client = useQueryClient();
  const key = useMemo(
    () => projectRoomChannelsKey(scope, projectId),
    [scope, projectId],
  );
  const list = useQuery({
    queryKey: [...key, slug],
    enabled,
    retry: false,
    staleTime: 0,
    queryFn: ({ signal }) => listProjectRoomChannels(scope, slug, signal),
  });
  // A bare 404 is a host that predates channels; the Project's own 404 is
  // "no such Project", not an older host (#4855).
  const projectMissing = isProjectRoomProjectMissing(list.error);
  const unsupported =
    list.error instanceof StationHttpError &&
    list.error.status === 404 &&
    !projectMissing;
  const refresh = () => client.invalidateQueries({ queryKey: key });
  const create = useMutation({
    retry: false,
    mutationFn: (
      input: ProjectRoomChannelCreateInput & ProjectRoomChannelGuards,
    ) => createProjectRoomChannel(scope, slug, input),
    onSuccess: refresh,
  });
  const update = useMutation({
    retry: false,
    mutationFn: ({
      channelId,
      ...input
    }: ProjectRoomChannelUpdateInput &
      ProjectRoomChannelGuards & { channelId: string }) =>
      updateProjectRoomChannel(scope, slug, channelId, input),
    onSuccess: refresh,
  });
  return { list, unsupported, projectMissing, create, update };
}
export * from './projectRoomAgents';

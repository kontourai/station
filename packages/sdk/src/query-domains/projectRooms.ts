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
  discoverProjectRoom,
  fetchProjectRoomHistory,
  initializeProjectRoom,
  type ProjectRoomBrowserView,
  type ProjectRoomMessageIntent,
  type ProjectRoomNoteIntent,
  ProjectRoomProtocolError,
  saveProjectRoomNote,
  sendProjectRoomMessage,
  setProjectRoomPresence,
  subscribeProjectRoom,
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
export function isProjectRoomAccessError(error: unknown) {
  return (
    error instanceof StationHttpError &&
    (error.status === 401 || error.status === 403)
  );
}
export function useProjectRoom(
  incomingScope: ApiRequestScope,
  slug: string,
  projectId: string,
) {
  const { apiBase, authorityKey } = incomingScope;
  const scope = useMemo(
    () => ({ apiBase, authorityKey }),
    [apiBase, authorityKey],
  );
  const client = useQueryClient();
  const root = useMemo(
    () => projectRoomKey(scope, projectId),
    [scope, projectId],
  );
  const [stopped, setStopped] = useState(false);
  const [streamError, setStreamError] = useState(false);
  const discovery = useQuery({
    queryKey: [...root, 'discovery', slug],
    enabled: !stopped,
    retry: false,
    queryFn: ({ signal }) =>
      discoverProjectRoom(scope, slug, projectId, signal),
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
    maxPages: 20,
  });
  const initialize = useMutation({
    retry: false,
    mutationFn: () => initializeProjectRoom(scope, slug, projectId),
    onSuccess: () => client.invalidateQueries({ queryKey: root }),
  });
  const unprovisioned =
    discovery.error instanceof StationHttpError &&
    discovery.error.status === 404 &&
    discovery.error.code === 'project_room_not_found';
  const send = useMutation({
    retry: false,
    mutationFn: (input: ProjectRoomMessageIntent) =>
      sendProjectRoomMessage(scope, slug, input),
    onSuccess: () => client.invalidateQueries({ queryKey: root }),
  });
  const note = useMutation({
    retry: false,
    mutationFn: (input: ProjectRoomNoteIntent) =>
      saveProjectRoomNote(scope, slug, input),
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
    const clientId = crypto.randomUUID();
    const revoke = () => {
      if (!active) return;
      active = false;
      connection.close();
      setStopped(true);
      void client.cancelQueries({ queryKey: root });
      client.removeQueries({ queryKey: root });
    };
    const connection = subscribeProjectRoom(scope, slug, roomId, {
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
              current ? { ...current, presence: event.participants } : current,
          );
      },
      onError: () => {
        if (active) setStreamError(true);
      },
      onTerminal: revoke,
    });
    const presence = () => {
      if (!active) return;
      void setProjectRoomPresence(scope, slug, {
        ...guards,
        clientId,
        state: 'join',
      }).catch((error) => {
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
        void setProjectRoomPresence(scope, slug, {
          ...guards,
          clientId,
          state: 'leave',
        }).catch(() => {});
    };
  }, [client, root, roomId, actorId, stopped, scope, slug, projectId]);
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

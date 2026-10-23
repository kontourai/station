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
  type ProjectRoomBrowserView,
  type ProjectRoomMessageIntent,
  type ProjectRoomNoteIntent,
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
  // 25 worst-case 16KiB messages fit within the server's 512KiB page budget.
  const tailAfter = Math.max(0, (room?.checkpoint.lastSeq ?? 0) - 25);
  const history = useInfiniteQuery({
    queryKey: [...contentKey, tailAfter],
    enabled: !!roomId && !stopped,
    retry: false,
    gcTime: 0,
    initialPageParam: tailAfter,
    queryFn: ({ pageParam, signal }) =>
      fetchProjectRoomHistory(
        scope,
        slug,
        { projectId, roomId: roomId! },
        pageParam,
        25,
        signal,
      ),
    getNextPageParam: (_last, pages, after) =>
      after > 0 && pages.length < 20 ? Math.max(0, after - 25) : undefined,
    maxPages: 20,
  });
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
      ![discovery.error, history.error, send.error, note.error].some(
        isProjectRoomAccessError,
      )
    )
      return;
    setStopped(true);
    void client.cancelQueries({ queryKey: root });
    client.removeQueries({ queryKey: root });
  }, [client, root, discovery.error, history.error, send.error, note.error]);
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
    history,
    send,
    note,
    stopped,
    streamError,
    recover: () => {
      send.reset();
      note.reset();
      setStopped(false);
      setStreamError(false);
      void client.resetQueries({ queryKey: root });
    },
  };
}

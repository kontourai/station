import {
  PROJECT_ROOM_LIMITS,
  PROJECT_ROOM_PROJECT_NOT_FOUND_CODE,
  type ProjectRoomActor,
  type ProjectRoomChannelCreateInput,
  type ProjectRoomChannelUpdateInput,
  type ProjectRoomDeleteInput,
  type ProjectRoomEditInput,
  type ProjectRoomMessage,
  type ProjectRoomReactionInput,
} from '@kontourai/station-contracts/project-room';
import type { ProjectRoomAgentActivity } from '@kontourai/station-contracts/project-room-browser';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StationHttpError } from '../client/api-error-message';
import type { ApiRequestScope } from '../client/http';
import {
  fetchProjectRoomMembers,
  type ProjectRoomLiveEvent,
  projectRoomLiveHub,
  readProjectRoomLiveCapability,
  setProjectRoomTyping,
} from '../client/project-room-live';
import {
  createProjectRoomChannel,
  deleteProjectRoomMessage,
  discoverProjectRoom,
  editProjectRoomMessage,
  fetchProjectRoomHistory,
  initializeProjectRoom,
  listProjectRoomChannels,
  type ProjectRoomBrowserView,
  type ProjectRoomChannelGuards,
  type ProjectRoomMessageIntent,
  type ProjectRoomMessageTarget,
  type ProjectRoomNoteIntent,
  ProjectRoomProtocolError,
  reactToProjectRoomMessage,
  saveProjectRoomNote,
  sendProjectRoomMessage,
  setProjectRoomPresence,
  subscribeProjectRoom,
  updateProjectRoomChannel,
} from '../client/project-rooms';

export type { ApiRequestScope } from '../client/http';
export * from '../client/project-rooms';

/**
 * Whether this Station serves one live stream for a Project's rooms, typing
 * and person mentions (#4798, #4799). Read once per Station, and only once a
 * caller has rooms to stream: a room that is not open, or a list with no
 * channels, asks the public handshake nothing.
 */
function useProjectRoomLiveCapability(apiBase: string, enabled: boolean) {
  return useQuery({
    queryKey: ['project-room-live-capability', apiBase],
    enabled,
    queryFn: () => readProjectRoomLiveCapability(apiBase),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}
/**
 * The people a message in this room may mention, with current names
 * (#4799). Mentions render by id from this list, so a rename shows on old
 * messages too.
 */
export function useProjectRoomMembers(
  incomingScope: ApiRequestScope,
  slug: string,
  projectId: string,
  channelId: string | undefined,
  enabled: boolean,
) {
  const { apiBase, authorityKey } = incomingScope;
  return useQuery({
    queryKey: [
      'project-room-members',
      apiBase,
      authorityKey,
      projectId,
      channelId ?? 'general',
      slug,
    ],
    enabled,
    retry: false,
    staleTime: 60_000,
    queryFn: ({ signal }) =>
      fetchProjectRoomMembers(
        { apiBase, authorityKey },
        slug,
        channelId,
        signal,
      ),
  });
}
/** One room's live state as the Project's shared stream reports it. */
export interface ProjectRoomLiveRoom {
  /** The stream has announced this room since it last connected. */
  connected: boolean;
  typing: ProjectRoomActor[];
  agents: ProjectRoomAgentActivity[];
}
/**
 * Live state of many rooms over the Project's one stream (#4798, #4800), for
 * a sidebar: who is typing and which Agent requests are in flight, per
 * channel. `onActivity` hears each room's new messages and changes, so a
 * caller can refresh what it derives from them (unread counts).
 */
export function useProjectRoomLiveIndex(
  incomingScope: ApiRequestScope,
  slug: string,
  channelIds: readonly string[],
  enabled: boolean,
  onActivity?: (channelId: string) => void,
) {
  const { apiBase, authorityKey } = incomingScope;
  const capability = useProjectRoomLiveCapability(
    apiBase,
    enabled && channelIds.length > 0,
  );
  const [rooms, setRooms] = useState<ReadonlyMap<string, ProjectRoomLiveRoom>>(
    () => new Map(),
  );
  const activity = useRef(onActivity);
  activity.current = onActivity;
  const key = channelIds.join(',');
  useEffect(() => {
    if (!enabled || capability.data !== true || !key) return;
    const hub = projectRoomLiveHub({ apiBase, authorityKey }, slug);
    const ids = key.split(',');
    const update = (id: string, patch: Partial<ProjectRoomLiveRoom>) =>
      setRooms((current) => {
        const next = new Map(current);
        next.set(id, {
          connected: false,
          typing: [],
          agents: [],
          ...current.get(id),
          ...patch,
        });
        return next;
      });
    const offs = ids.map((id) =>
      hub.subscribe(id, (event) => {
        if (event.kind === 'subscribed') {
          update(id, { connected: true });
          // A (re)connection reports the room as it stands, including
          // messages committed while it connected: re-read what derives
          // from them, as for any change.
          activity.current?.(id);
        } else if (
          event.kind === 'disconnected' ||
          event.kind === 'revoked' ||
          event.kind === 'unavailable'
        )
          // Typing and working state are only as true as the connection.
          update(id, { connected: false, typing: [], agents: [] });
        else if (event.kind === 'typing') update(id, { typing: event.actors });
        else if (event.kind === 'agents')
          update(id, { agents: event.requests });
        else if (
          event.kind === 'append' ||
          event.kind === 'update' ||
          event.kind === 'resync'
        )
          activity.current?.(id);
      }),
    );
    return () => {
      for (const off of offs) off();
      setRooms(new Map());
    };
  }, [enabled, capability.data, key, apiBase, authorityKey, slug]);
  return rooms;
}
/** The Agent requests still working: reserved or started, with no failure. */
export function workingProjectRoomAgents(
  requests: readonly ProjectRoomAgentActivity[],
) {
  return requests.filter(
    (request) =>
      (request.state === 'reserved' || request.state === 'started') &&
      !request.failure,
  );
}
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
 * Most messages `useProjectRoomRetainedHistory` re-reads below the live
 * windows (the same 500 the windows hold). A caller must not show a kept row
 * older than this span: nothing would refresh it.
 */
export const PROJECT_ROOM_RETAINED_REREAD_MESSAGES =
  PROJECT_ROOM_HISTORY_MAX_PAGES * 25;
/**
 * Live-merged rows a room hook remembers for history reads in flight. A read
 * that outlives a forgotten row is read again rather than trusted.
 */
const LIVE_ROWS_KEPT = PROJECT_ROOM_RETAINED_REREAD_MESSAGES;
/** Times one history window is read again after it outlived a forgotten row. */
const HISTORY_REREADS = 3;
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
 * One history window, `after` < seq <= `end`. The byte cap can split even a
 * 25-message window; its forward continuations are finished before the caller
 * moves backward, without overlapping newer windows.
 */
async function readProjectRoomWindow(
  scope: ApiRequestScope,
  slug: string,
  identity: { projectId: string; roomId: string },
  { after: start, end }: { after: number; end: number },
  signal: AbortSignal,
  channelId: string | undefined,
) {
  let after = start;
  const messages: Awaited<
    ReturnType<typeof fetchProjectRoomHistory>
  >['messages'] = [];
  for (let requests = 0; requests < 25; requests++) {
    signal.throwIfAborted();
    const page = await fetchProjectRoomHistory(
      scope,
      slug,
      identity,
      after,
      // A tail window that live appends grew reads in bounded pages.
      Math.min(PROJECT_ROOM_LIMITS.maxPageSize, Math.max(1, end - after)),
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
      throw new ProjectRoomProtocolError('Project room history is incomplete.');
    after = page.nextAfter;
  }
  throw new ProjectRoomProtocolError(
    'Project room history exceeded its window budget.',
  );
}
/**
 * The rolling tail can cover more messages than one ordinary history page.
 * Read it as 25-message spans so a byte-limited response cannot consume the
 * whole per-window request budget while there are still rows in that span.
 */
async function readProjectRoomTail(
  scope: ApiRequestScope,
  slug: string,
  identity: { projectId: string; roomId: string },
  { after, end }: { after: number; end: number },
  signal: AbortSignal,
  channelId: string | undefined,
) {
  let through = Math.min(end, after + 25);
  let page = await readProjectRoomWindow(
    scope,
    slug,
    identity,
    { after, end: through },
    signal,
    channelId,
  );
  const messages = [...page.messages];
  while (through < end && through < page.checkpoint.lastSeq) {
    after = through;
    through = Math.min(end, after + 25);
    page = await readProjectRoomWindow(
      scope,
      slug,
      identity,
      { after, end: through },
      signal,
      channelId,
    );
    messages.push(...page.messages);
  }
  return { ...page, messages };
}
/**
 * One order for every Project-room history read, taken when the read starts:
 * the live windows, the retained re-read and the immediate span read all draw
 * from it (#4852 review). A caller keeps, per message, the number of the read
 * that last set it and never lets a read that started earlier replace it, so
 * a slow older response cannot bring back text a newer read already
 * replaced. A change both reads missed arrives with the next live event.
 */
let historyReads = 0;
function nextHistoryRead() {
  historyReads += 1;
  return historyReads;
}
/** One cached history window and its place in the SDK read order. */
type HistoryPage = Awaited<ReturnType<typeof readProjectRoomWindow>> & {
  readSeq: number;
  windowAfter: number;
  rolledByLiveAppend?: boolean;
};
/** Messages with `after` < seq <= `end`. */
export interface ProjectRoomHistorySpan {
  after: number;
  end: number;
}
/**
 * Re-reads the messages a room still shows from history windows it has moved
 * past (#4797). The history query is keyed by the room's latest sequence, so
 * when a new message moves the tail, rows read under the old key are kept on
 * screen but no query owns them; a reaction, edit or delete of one of them
 * would otherwise never reach the screen.
 *
 * This query lives under the room's key, so every live `changed` event and
 * every mutation that invalidates the room re-reads the span; it reads nothing
 * until then. `span` is asked at read time, for the rows shown at that moment.
 * At most {@link PROJECT_ROOM_RETAINED_REREAD_MESSAGES} messages are read,
 * newest first; the caller retires kept rows older than that.
 */
export function useProjectRoomRetainedHistory(
  incomingScope: ApiRequestScope,
  slug: string,
  projectId: string,
  channelId: string | undefined,
  roomId: string | undefined,
  span: () => ProjectRoomHistorySpan | undefined,
) {
  const { apiBase, authorityKey } = incomingScope;
  const scope = useMemo(
    () => ({ apiBase, authorityKey }),
    [apiBase, authorityKey],
  );
  const asked = useRef(span);
  asked.current = span;
  return useQuery({
    queryKey: [
      ...(channelId === undefined
        ? projectRoomKey(scope, projectId)
        : projectRoomChannelKey(scope, projectId, channelId)),
      roomId ?? 'unopened',
      'history',
      'retained',
    ],
    enabled: !!roomId,
    retry: false,
    gcTime: 0,
    staleTime: Number.POSITIVE_INFINITY,
    // Rows were current when shown: nothing is read until the room changes.
    // A room that is not open holds no data at all, even an empty list.
    initialData: roomId ? { messages: [], readSeq: 0 } : undefined,
    initialDataUpdatedAt: 0,
    queryFn: ({ signal }) =>
      readProjectRoomSpan(
        scope,
        slug,
        projectId,
        roomId,
        asked.current(),
        signal,
        channelId,
      ),
  });
}
/**
 * Re-reads one span right away: the rows that just left the live windows
 * (#4852 review). A history read cancelled as the tail moved left them as they
 * were before any change it would have shown; this reads them again without
 * waiting for the next live event. Each new span is one read, under the room's
 * key, so an invalidation re-reads it too.
 */
export function useProjectRoomHistorySpan(
  incomingScope: ApiRequestScope,
  slug: string,
  projectId: string,
  channelId: string | undefined,
  roomId: string | undefined,
  span: ProjectRoomHistorySpan | undefined,
) {
  const { apiBase, authorityKey } = incomingScope;
  const scope = useMemo(
    () => ({ apiBase, authorityKey }),
    [apiBase, authorityKey],
  );
  return useQuery({
    queryKey: [
      ...(channelId === undefined
        ? projectRoomKey(scope, projectId)
        : projectRoomChannelKey(scope, projectId, channelId)),
      roomId ?? 'unopened',
      'history',
      'span',
      span?.after,
      span?.end,
    ],
    enabled: !!roomId && !!span,
    retry: false,
    gcTime: 0,
    queryFn: ({ signal }) =>
      readProjectRoomSpan(
        scope,
        slug,
        projectId,
        roomId,
        span,
        signal,
        channelId,
      ),
  });
}
/** Messages in `span`, at most the re-read budget, newest windows first. */
async function readProjectRoomSpan(
  scope: ApiRequestScope,
  slug: string,
  projectId: string,
  roomId: string | undefined,
  wanted: ProjectRoomHistorySpan | undefined,
  signal: AbortSignal,
  channelId: string | undefined,
) {
  const readSeq = nextHistoryRead();
  const messages: Awaited<
    ReturnType<typeof readProjectRoomWindow>
  >['messages'] = [];
  if (!roomId || !wanted || wanted.end <= wanted.after)
    return { messages, readSeq };
  const floor = Math.max(
    wanted.after,
    wanted.end - PROJECT_ROOM_RETAINED_REREAD_MESSAGES,
  );
  for (let end = wanted.end; end > floor; end -= 25) {
    const window = await readProjectRoomWindow(
      scope,
      slug,
      { projectId, roomId },
      { after: Math.max(floor, end - 25), end },
      signal,
      channelId,
    );
    messages.unshift(...window.messages);
  }
  return { messages, readSeq };
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
  const [typing, setTyping] = useState<ProjectRoomActor[]>([]);
  const [agents, setAgents] = useState<ProjectRoomAgentActivity[]>([]);
  /**
   * Where the stream says the room is. `stale` until a history read made
   * after the stream announced it has succeeded: until then later frames are
   * never taken as proof that the cache holds what came before them.
   */
  const known = useRef<
    { lastSeq: number; activity: number; stale: boolean } | undefined
  >(undefined);
  /**
   * Rows the stream (or an acknowledged write) merged into the cache, with
   * their place in the read order, so a history read that started before a
   * merge keeps that newer row instead of undoing it. Bounded by
   * `LIVE_ROWS_KEPT`; forgetting a row that a pending read still needs marks
   * that read `outlived`, and it is read again instead of trusted.
   */
  const liveRows = useRef(
    new Map<string, { message: ProjectRoomMessage; readSeq: number }>(),
  );
  /** History window reads in flight, by their place in the read order. */
  const pendingReads = useRef(new Map<number, { outlived: boolean }>());
  const [liveSeq, setLiveSeq] = useState<number>();
  const connected = useRef(false);
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
  // Asked only for a discovered room that is not stopped (#4796 keeps the
  // handshake unread while a room is unavailable).
  const liveCapability = useProjectRoomLiveCapability(
    apiBase,
    !!roomId && !stopped,
  );
  const live = liveCapability.data === true;
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
    initialPageParam: { after: tailAfter, end: tailAfter + 25, newest: true },
    queryFn: async ({ pageParam, signal }) => {
      const { newest } = pageParam;
      let readSeq = 0;
      let after = pageParam.after;
      let page: Awaited<ReturnType<typeof readProjectRoomWindow>> | undefined;
      for (let attempt = 0; !page; attempt++) {
        readSeq = nextHistoryRead();
        const watch = { outlived: false };
        pendingReads.current.set(readSeq, watch);
        // TanStack's initial cursor stays fixed. Re-anchor each read to the
        // recent rows already in the cache, including a widened re-read.
        const cachedTail = client.getQueryData<InfiniteData<HistoryPage>>([
          ...contentKey,
          tailAfter,
        ])?.pages[0]?.messages;
        const reach = Math.max(
          pageParam.end,
          cachedTail?.[cachedTail.length - 1]?.seq ?? 0,
          ...(attempt
            ? [...liveRows.current.values()].map((row) => row.message.seq)
            : []),
        );
        if (newest)
          after = Math.max(
            pageParam.after,
            reach - PROJECT_ROOM_RETAINED_REREAD_MESSAGES,
          );
        let read: Awaited<ReturnType<typeof readProjectRoomWindow>>;
        try {
          const readWindow = newest
            ? readProjectRoomTail
            : readProjectRoomWindow;
          read = await readWindow(
            scope,
            slug,
            { projectId, roomId: roomId! },
            newest ? { after, end: reach } : pageParam,
            signal,
            channelId,
          );
        } finally {
          pendingReads.current.delete(readSeq);
        }
        // A row merged after this read began was forgotten: what it read may
        // be older than that row, so it is never trusted.
        if (!watch.outlived) page = read;
        else if (attempt + 1 >= HISTORY_REREADS)
          throw new ProjectRoomProtocolError(
            'Project room history changed faster than it could be read.',
          );
      }
      // Rows merged after this read began are newer than what it read. The
      // newest window can move beyond the range read by this request. An older
      // window only takes changes within its fixed range.
      const newer = [...liveRows.current.values()]
        .filter(
          (row) =>
            row.readSeq > readSeq &&
            row.message.seq > after &&
            (newest || row.message.seq <= pageParam.end),
        )
        .map((row) => row.message);
      if (!newer.length) return { ...page, readSeq, windowAfter: after };
      const byId = new Map(newer.map((m) => [m.messageId, m]));
      const read = new Set(page.messages.map((m) => m.messageId));
      const combined = [
        ...page.messages.map((m) => byId.get(m.messageId) ?? m),
        ...newer.filter((m) => !read.has(m.messageId)),
      ].sort((a, b) => a.seq - b.seq);
      const windowAfter = newest
        ? Math.max(
            after,
            (combined[combined.length - 1]?.seq ?? 0) -
              PROJECT_ROOM_RETAINED_REREAD_MESSAGES,
          )
        : after;
      const messages = combined.filter((message) => message.seq > windowAfter);
      return {
        ...page,
        messages,
        windowAfter,
        checkpoint: {
          ...page.checkpoint,
          lastSeq: Math.max(
            page.checkpoint.lastSeq,
            messages[messages.length - 1]?.seq ?? 0,
          ),
        },
        readSeq,
      };
    },
    getNextPageParam: ({ windowAfter }) =>
      windowAfter > 0
        ? {
            after: Math.max(0, windowAfter - 25),
            end: windowAfter,
            newest: false,
          }
        : undefined,
    maxPages: PROJECT_ROOM_HISTORY_MAX_PAGES,
  });
  const historyKey = useMemo(
    () => [...contentKey, tailAfter],
    [contentKey, tailAfter],
  );
  /**
   * Merges messages into the cached history (#4798) instead of re-reading
   * it: each one replaces its row wherever a window holds it, and `append`
   * adds new rows to the newest window. Every merge takes the next place in
   * the SDK read order, so no older read in flight can undo it. Rows kept
   * outside the windows are updated through the retained re-read's cache.
   * Answers false when there is no history to merge into yet.
   */
  const merge = useCallback(
    (messages: readonly ProjectRoomMessage[], append: boolean) => {
      let merged = false;
      client.setQueryData<InfiniteData<HistoryPage>>(historyKey, (data) => {
        if (!data?.pages.length) return data;
        merged = true;
        const readSeq = nextHistoryRead();
        const byId = new Map(messages.map((m) => [m.messageId, m]));
        for (const message of messages) {
          liveRows.current.delete(message.messageId);
          liveRows.current.set(message.messageId, { message, readSeq });
        }
        for (const [id, row] of liveRows.current) {
          if (liveRows.current.size <= LIVE_ROWS_KEPT) break;
          liveRows.current.delete(id);
          // Every read that began before this row merged needed it.
          for (const [started, watch] of pendingReads.current)
            if (started < row.readSeq) watch.outlived = true;
        }
        const pages = data.pages.map((page) =>
          page.messages.some((m) => byId.has(m.messageId))
            ? {
                ...page,
                messages: page.messages.map((m) => byId.get(m.messageId) ?? m),
                readSeq,
              }
            : page,
        );
        const tail = pages[0]!;
        const held = new Set(
          pages.flatMap((p) => p.messages.map((m) => m.messageId)),
        );
        const fresh = append
          ? messages.filter((m) => !held.has(m.messageId))
          : [];
        if (fresh.length) {
          const rows = [...tail.messages, ...fresh].sort(
            (a, b) => a.seq - b.seq,
          );
          const lastSeq = rows[rows.length - 1]!.seq;
          const windowAfter = Math.max(
            tail.windowAfter,
            lastSeq - PROJECT_ROOM_RETAINED_REREAD_MESSAGES,
          );
          const rolledByLiveAppend = windowAfter > tail.windowAfter;
          pages[0] = {
            ...tail,
            messages: rows.filter((message) => message.seq > windowAfter),
            checkpoint: {
              ...tail.checkpoint,
              lastSeq: Math.max(tail.checkpoint.lastSeq, lastSeq),
            },
            windowAfter,
            rolledByLiveAppend,
            readSeq,
          };
          // The previous older pages no longer join the tail. Move them to
          // the caller's retained history and page earlier from the new
          // boundary instead of leaving a gap between cached pages.
          if (rolledByLiveAppend)
            return {
              ...data,
              pages: pages.slice(0, 1),
              pageParams: data.pageParams.slice(0, 1),
            };
        }
        return { ...data, pages };
      });
      if (!append)
        client.setQueryData(
          [...contentKey, 'retained'],
          (
            current:
              | { messages: ProjectRoomMessage[]; readSeq: number }
              | undefined,
          ) =>
            current
              ? { messages: [...messages], readSeq: nextHistoryRead() }
              : current,
        );
      return merged;
    },
    [client, historyKey, contentKey],
  );
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
  // While the live stream is connected the acknowledged message is merged
  // where it belongs, and the stream's own frame for it changes nothing;
  // without the stream the room is re-read as before.
  const settled = (message: ProjectRoomMessage | undefined, append: boolean) =>
    message && connected.current && merge([message], append)
      ? undefined
      : client.invalidateQueries({ queryKey: root });
  const send = useMutation({
    retry: false,
    mutationFn: (input: ProjectRoomMessageIntent) =>
      sendProjectRoomMessage(scope, slug, input, channelId),
    onSuccess: (message) => settled(message, true),
  });
  const note = useMutation({
    retry: false,
    mutationFn: (input: ProjectRoomNoteIntent) =>
      saveProjectRoomNote(scope, slug, input, channelId),
    onSuccess: () => client.invalidateQueries({ queryKey: root }),
  });
  // Reactions, edits and deletes keep the room's sequence, so the history
  // window is re-read rather than advanced. A refusal re-reads it too: the
  // message may have changed under the caller.
  const react = useMutation({
    retry: false,
    mutationFn: ({
      target,
      ...input
    }: ProjectRoomReactionInput & { target: ProjectRoomMessageTarget }) =>
      reactToProjectRoomMessage(scope, slug, target, input, channelId),
    onSettled: (message) => settled(message, false),
  });
  const edit = useMutation({
    retry: false,
    mutationFn: ({
      target,
      ...input
    }: ProjectRoomEditInput & { target: ProjectRoomMessageTarget }) =>
      editProjectRoomMessage(scope, slug, target, input, channelId),
    onSettled: (message) => settled(message, false),
  });
  const remove = useMutation({
    retry: false,
    mutationFn: ({
      target,
      ...input
    }: ProjectRoomDeleteInput & { target: ProjectRoomMessageTarget }) =>
      deleteProjectRoomMessage(scope, slug, target, input, channelId),
    onSettled: (message) => settled(message, false),
  });
  useEffect(() => {
    if (
      ![
        discovery.error,
        history.error,
        initialize.error,
        send.error,
        note.error,
        react.error,
        edit.error,
        remove.error,
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
    react.error,
    edit.error,
    remove.error,
  ]);
  // Live frames apply strictly in order: a backfill finishes before the
  // frame after it is looked at.
  const queue = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    if (!roomId || !actorId || stopped || !live) return;
    let active = true;
    const hub = projectRoomLiveHub(scope, slug);
    const guards = {
      expectedRoomId: roomId,
      expectedProjectId: projectId,
      expectedActorId: actorId,
    };
    const revoke = () => {
      if (!active) return;
      active = false;
      off();
      setStopped(true);
      void client.cancelQueries({ queryKey: root });
      client.removeQueries({ queryKey: root });
    };
    const reconcile = () => client.invalidateQueries({ queryKey: root });
    /**
     * Re-reads the room and, only once that read has succeeded, takes
     * `target` as where the cache stands. A failed read leaves the room
     * stale, so the next frame re-reads it again rather than trusting it.
     */
    const settle = async (target: { lastSeq: number; activity: number }) => {
      try {
        await client.invalidateQueries(
          { queryKey: root },
          { throwOnError: true },
        );
      } catch {
        if (active) known.current = { ...target, stale: true };
        return;
      }
      if (!active) return;
      known.current = { ...target, stale: false };
      setLiveSeq(target.lastSeq);
    };
    /**
     * Applies one frame against what the cache reflects (#4798). A message
     * past the next sequence means frames were missed: the messages between
     * are read from history first, never skipped. An activity range that does
     * not start where the cache is re-reads the room's windows.
     */
    const apply = async (event: ProjectRoomLiveEvent) => {
      if (!active) return;
      const state = known.current;
      switch (event.kind) {
        case 'subscribed':
          connected.current = true;
          setStreamError(false);
          if (event.roomId !== roomId) {
            revoke();
            return;
          }
          // Every (re)connection reconciles with durable history once.
          await settle({ lastSeq: event.lastSeq, activity: event.activity });
          return;
        case 'append': {
          if (!state) return;
          const { message } = event;
          const target = {
            lastSeq: Math.max(state.lastSeq, message.seq),
            activity: state.activity,
          };
          // A history read is owed: it, not this frame, says what is held.
          if (state.stale) {
            await settle(target);
            return;
          }
          if (message.seq > state.lastSeq + 1) {
            const window = await readProjectRoomWindow(
              scope,
              slug,
              { projectId, roomId },
              { after: state.lastSeq, end: message.seq - 1 },
              new AbortController().signal,
              channelId,
            );
            if (!active) return;
            const filled = [...window.messages, message];
            if (
              filled.some(
                (item, index) => item.seq !== state.lastSeq + index + 1,
              ) ||
              !merge(filled, true)
            ) {
              await settle(target);
              return;
            }
          } else if (!merge([message], true)) {
            await settle(target);
            return;
          }
          state.lastSeq = target.lastSeq;
          setLiveSeq(state.lastSeq);
          return;
        }
        case 'update':
          if (!state) return;
          if (
            state.stale ||
            event.fromActivity !== state.activity ||
            !merge(event.messages, false)
          ) {
            await settle({ lastSeq: state.lastSeq, activity: event.activity });
            return;
          }
          state.activity = event.activity;
          return;
        case 'resync':
          await settle({ lastSeq: event.lastSeq, activity: event.activity });
          return;
        case 'typing':
          setTyping(event.actors.filter((person) => person.id !== actorId));
          return;
        case 'presence':
          client.setQueryData(
            [...root, 'discovery', slug],
            (current: ProjectRoomBrowserView | undefined) =>
              current ? { ...current, presence: event.participants } : current,
          );
          return;
        case 'agents':
          setAgents(event.requests);
          return;
        case 'revoked':
          revoke();
          return;
        case 'unavailable':
          // The room is gone or no longer readable: discovery says which.
          await reconcile();
          return;
        case 'disconnected':
          connected.current = false;
          setStreamError(true);
          setTyping([]);
          return;
      }
    };
    const off = hub.subscribe(roomId, (event) => {
      queue.current = queue.current
        .then(() => apply(event))
        .catch(() => {
          if (!active) return;
          // A failed backfill proves nothing about what the cache holds.
          if (known.current) known.current.stale = true;
          void reconcile();
        });
    });
    // Presence lasts as long as this client's stream; no renewals.
    void setProjectRoomPresence(
      scope,
      slug,
      { ...guards, clientId: hub.clientId, state: 'join' },
      channelId,
    ).catch((error) => {
      if (isProjectRoomAccessError(error)) revoke();
    });
    return () => {
      const wasActive = active;
      active = false;
      off();
      connected.current = false;
      known.current = undefined;
      setTyping([]);
      setAgents([]);
      if (wasActive)
        void setProjectRoomPresence(
          scope,
          slug,
          { ...guards, clientId: hub.clientId, state: 'leave' },
          channelId,
        ).catch(() => {});
    };
  }, [
    client,
    root,
    roomId,
    actorId,
    stopped,
    live,
    merge,
    scope,
    slug,
    projectId,
    channelId,
  ]);
  // A host without the shared stream: this room's own stream, as before.
  useEffect(() => {
    if (!roomId || !actorId || stopped || liveCapability.data !== false) return;
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
    liveCapability.data,
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
  // "Is typing" (#4798): sent at most every few seconds while typing, and
  // stopped on send, on a pause, and when the room closes. The server lets an
  // unrenewed signal lapse on its own.
  const typingState = useRef<{
    sentAt: number;
    timer?: ReturnType<typeof setTimeout>;
  }>({
    sentAt: 0,
  });
  const notifyTyping = useCallback(
    (active: boolean) => {
      if (!live || !roomId || !actorId || stopped) return;
      const state = typingState.current;
      const hub = projectRoomLiveHub(scope, slug);
      const signal = (typing: boolean) =>
        void setProjectRoomTyping(
          scope,
          slug,
          {
            expectedRoomId: roomId,
            expectedProjectId: projectId,
            expectedActorId: actorId,
            clientId: hub.clientId,
            typing,
          },
          channelId,
        ).catch(() => {});
      if (state.timer) clearTimeout(state.timer);
      state.timer = undefined;
      if (!active) {
        if (state.sentAt) signal(false);
        state.sentAt = 0;
        return;
      }
      const now = Date.now();
      if (now - state.sentAt > 3000) {
        state.sentAt = now;
        signal(true);
      }
      state.timer = setTimeout(() => {
        state.timer = undefined;
        if (state.sentAt) signal(false);
        state.sentAt = 0;
      }, 4000);
    },
    [live, roomId, actorId, stopped, scope, slug, projectId, channelId],
  );
  useEffect(() => () => notifyTyping(false), [notifyTyping]);
  return {
    discovery,
    initialize,
    unprovisioned,
    projectMissing,
    history,
    /** The room's newest sequence: the stream's when it is live. */
    lastSeq: Math.max(liveSeq ?? 0, room?.checkpoint.lastSeq ?? 0),
    /** Other people typing here now (#4798). */
    typing,
    /** This room's Agent requests, newest first, from their records (#4800). */
    agents,
    notifyTyping,
    /** One stream carries this room with the Project's others. */
    live,
    send,
    note,
    react,
    edit,
    remove,
    stopped,
    streamError,
    recover: () => {
      initialize.reset();
      send.reset();
      note.reset();
      react.reset();
      edit.reset();
      remove.reset();
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

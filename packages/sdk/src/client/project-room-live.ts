import {
  isProjectRoomUuid,
  PROJECT_ROOM_LIMITS as LIMITS,
  type ProjectRoomActor,
} from '@kontourai/station-contracts/project-room';
import {
  PROJECT_ROOM_LIVE_MAX_ROOMS,
  PROJECT_ROOM_LIVE_SUFFIX,
  type ProjectRoomLiveFrame,
  parseProjectRoomLiveFrame,
} from '@kontourai/station-contracts/project-room-browser';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import { envelopeError } from './api-error-message';
import { hasCapability } from './capability.js';
import {
  type ApiRequestScope,
  type FetchSseConnection,
  fetchSSE,
  getJson,
  mutateJson,
} from './http';
import {
  type ProjectRoomGuards,
  ProjectRoomProtocolError,
} from './project-rooms';
import { fetchPublicStationCapabilities } from './publicStationCapabilities.js';

/**
 * Whether the host serves one live stream for a Project's rooms, typing and
 * the member directory (`projectRoomLive`, #4798). Without it a client keeps
 * the per-room stream and offers no typing or person mentions.
 */
export async function readProjectRoomLiveCapability(
  apiBase: string,
): Promise<boolean> {
  const handshake = await fetchPublicStationCapabilities(apiBase);
  return handshake ? hasCapability(handshake, 'projectRoomLive') : false;
}

function roomPath(slug: string, suffix: string, channelId?: string) {
  if (!slug || slug.length > 512)
    throw new ProjectRoomProtocolError('Project identity is invalid.');
  const project = `/api/projects/${encodeURIComponent(slug)}`;
  if (channelId === undefined) return `${project}/room${suffix}`;
  if (!isProjectRoomUuid(channelId))
    throw new ProjectRoomProtocolError('Project room identity is invalid.');
  return `${project}/channels/${channelId}${suffix}`;
}
async function data(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > LIMITS.pageBytes)
    throw new ProjectRoomProtocolError('Project room response is too large.');
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  if (!response.ok)
    throw envelopeError(response, body, 'Project room request failed.');
  const value = body as { success?: unknown; data?: unknown } | undefined;
  if (value?.success !== true)
    throw new ProjectRoomProtocolError(
      'Project room response is incompatible.',
    );
  return value.data;
}

/** Starts or stops the caller's "is typing" signal in one room (#4798). */
export async function setProjectRoomTyping(
  requestScope: ApiRequestScope,
  slug: string,
  input: ProjectRoomGuards & { clientId: string; typing: boolean },
  channelId?: string,
) {
  if (!isProjectRoomUuid(input.clientId))
    throw new ProjectRoomProtocolError('Project room client is invalid.');
  await data(
    await mutateJson(
      `${requestScope.apiBase}${roomPath(slug, '/typing', channelId)}`,
      'POST',
      { requestScope },
      input,
    ),
  );
}

/** The people a message here may mention, with their current names (#4799). */
export async function fetchProjectRoomMembers(
  requestScope: ApiRequestScope,
  slug: string,
  channelId: string | undefined,
  signal?: AbortSignal,
): Promise<ProjectRoomActor[]> {
  const value = await data(
    await getJson(
      `${requestScope.apiBase}${roomPath(slug, '/members', channelId)}`,
      { requestScope, signal },
    ),
  );
  const members = (value as { members?: unknown })?.members;
  if (!Array.isArray(members) || members.length > 10_000)
    throw new ProjectRoomProtocolError('Project room members are invalid.');
  return members.map((member) => {
    const m = member as Record<string, unknown>;
    if (
      typeof m.id !== 'string' ||
      !m.id ||
      typeof m.displayName !== 'string' ||
      !m.displayName.trim() ||
      m.kind !== 'person'
    )
      throw new ProjectRoomProtocolError('Project room members are invalid.');
    return { id: m.id, displayName: m.displayName, kind: 'person' as const };
  });
}

/** Frames also report the connection itself to each room. */
export type ProjectRoomLiveEvent =
  | ProjectRoomLiveFrame
  | { kind: 'disconnected'; key: string };

/**
 * One live connection for a Project's rooms (#4798). Every hook that watches
 * a room of this Project on this Station joins the same hub; the hub keeps
 * one stream carrying the union of their rooms and reconnects (once, after a
 * short settle) when that set changes. Each reconnect re-announces every
 * room with `subscribed`, which its listeners treat as a reconciliation.
 */
class ProjectRoomLiveHub {
  readonly clientId = randomCorrelationId();
  private listeners = new Map<
    string,
    Set<(event: ProjectRoomLiveEvent) => void>
  >();
  private connection: FetchSseConnection | undefined;
  private connected = new Set<string>();
  /**
   * Where each announced room stands on the open connection, and its latest
   * typing, presence and Agent frames, for a listener that joins after the
   * room was announced (the sidebar opens the connection; the room hook joins
   * once it has discovered its room).
   */
  private latest = new Map<
    string,
    {
      subscribed: Extract<ProjectRoomLiveFrame, { kind: 'subscribed' }>;
      typing?: ProjectRoomLiveFrame;
      presence?: ProjectRoomLiveFrame;
      agents?: ProjectRoomLiveFrame;
    }
  >();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private current = '';
  constructor(
    private readonly scope: ApiRequestScope,
    private readonly slug: string,
    private readonly release: () => void,
  ) {}
  subscribe(key: string, listener: (event: ProjectRoomLiveEvent) => void) {
    if (!isProjectRoomUuid(key))
      throw new ProjectRoomProtocolError('Project room identity is invalid.');
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(listener);
    this.schedule();
    let active = true;
    // Joining a room already announced on the open connection: replay where
    // it stands, so the listener can detect a gap in what comes next.
    if (this.connected.has(key))
      queueMicrotask(() => {
        const state = this.latest.get(key);
        if (!active || !state || !this.connected.has(key)) return;
        listener({ ...state.subscribed });
        for (const frame of [state.typing, state.presence, state.agents])
          if (frame) listener(frame);
      });
    return () => {
      if (!active) return;
      active = false;
      set.delete(listener);
      if (!set.size) this.listeners.delete(key);
      this.schedule();
    };
  }
  /** Whether `key` has been announced on the open connection. */
  isLive(key: string) {
    return this.connected.has(key);
  }
  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    // Rooms mount together (a sidebar's rows, then the open room): one
    // connection for all of them rather than one reconnect per row.
    this.timer = setTimeout(() => this.reconnect(), 30);
  }
  private emit(key: string, event: ProjectRoomLiveEvent) {
    for (const listener of [...(this.listeners.get(key) ?? [])])
      listener(event);
  }
  private reconnect() {
    this.timer = undefined;
    const keys = [...this.listeners.keys()]
      .sort()
      .slice(0, PROJECT_ROOM_LIVE_MAX_ROOMS);
    const next = keys.join(',');
    if (next === this.current && this.connection) return;
    this.close();
    this.current = next;
    if (!keys.length) {
      this.release();
      return;
    }
    const query = new URLSearchParams(keys.map((key) => ['channel', key]));
    query.set('client', this.clientId);
    const url = `${this.scope.apiBase}/api/projects/${encodeURIComponent(this.slug)}${PROJECT_ROOM_LIVE_SUFFIX}?${query}`;
    const drop = () => {
      for (const key of this.connected)
        this.emit(key, { kind: 'disconnected', key });
      this.connected.clear();
      this.latest.clear();
    };
    this.connection = fetchSSE(url, {
      requestScope: this.scope,
      onError: drop,
      onTerminal: drop,
      onMessage: (message) => {
        if (message.data.length > LIMITS.pageBytes + 65536) return false;
        let frame: ProjectRoomLiveFrame;
        try {
          frame = parseProjectRoomLiveFrame(
            message.event ?? '',
            JSON.parse(message.data),
          );
        } catch {
          return false;
        }
        if (!this.listeners.has(frame.key)) return true;
        if (frame.kind === 'subscribed') this.connected.add(frame.key);
        if (frame.kind === 'revoked' || frame.kind === 'unavailable')
          this.connected.delete(frame.key);
        this.remember(frame);
        this.emit(frame.key, frame);
        return true;
      },
    });
  }
  /** Keeps each room's position and latest state for late listeners. */
  private remember(frame: ProjectRoomLiveFrame) {
    if (frame.kind === 'revoked' || frame.kind === 'unavailable') {
      this.latest.delete(frame.key);
      return;
    }
    if (frame.kind === 'subscribed') {
      this.latest.set(frame.key, { subscribed: frame });
      return;
    }
    const state = this.latest.get(frame.key);
    if (!state) return;
    const at = state.subscribed;
    if (frame.kind === 'append')
      state.subscribed = {
        ...at,
        lastSeq: Math.max(at.lastSeq, frame.message.seq),
      };
    else if (frame.kind === 'update')
      state.subscribed = { ...at, activity: frame.activity };
    else if (frame.kind === 'resync')
      state.subscribed = {
        ...at,
        lastSeq: frame.lastSeq,
        activity: frame.activity,
      };
    else if (frame.kind === 'typing') state.typing = frame;
    else if (frame.kind === 'presence') state.presence = frame;
    else if (frame.kind === 'agents') state.agents = frame;
  }
  private close() {
    this.connection?.close();
    this.connection = undefined;
    for (const key of this.connected)
      this.emit(key, { kind: 'disconnected', key });
    this.connected.clear();
    this.latest.clear();
  }
}
const hubs = new Map<string, ProjectRoomLiveHub>();
/**
 * The live hub for this Project on this Station and authority: shared by
 * every caller, created on first use and dropped when nothing listens.
 */
export function projectRoomLiveHub(scope: ApiRequestScope, slug: string) {
  const key = JSON.stringify([scope.apiBase, scope.authorityKey, slug]);
  let hub = hubs.get(key);
  if (!hub) {
    hub = new ProjectRoomLiveHub(
      { apiBase: scope.apiBase, authorityKey: scope.authorityKey },
      slug,
      () => {
        if (hubs.get(key) === hub) hubs.delete(key);
      },
    );
    hubs.set(key, hub);
  }
  return hub;
}

import {
  PROJECT_ROOM_LIVE_AGENT_REQUESTS,
  PROJECT_ROOM_LIVE_MAX_ROOMS,
  PROJECT_ROOM_LIVE_UPDATE_MESSAGES,
  PROJECT_ROOM_LIVE_WORKING_REQUESTS,
  type ProjectRoomAgentActivity,
  type ProjectRoomLiveFrame,
} from '@kontourai/station-contracts/project-room-browser';
import type { Context } from 'hono';
import { z } from 'zod/v3';
import { guardProjectResponse } from '../../services/projects/project-response-guard.js';
import type {
  ProjectRoomAdmission,
  ProjectRoomService,
} from '../../services/projects/project-room-service.js';
import { ProjectRoomRefusal } from '../../services/projects/project-room-store.js';
import { streamSSE } from '../sse-response.js';

/** Unsettled failure codes by request id, from the Agent request owner. */
type ProjectRoomAgentFailures = (
  requestIds: readonly string[],
) => ReadonlyMap<string, NonNullable<ProjectRoomAgentActivity['failure']>>;

const query = z
  .object({
    channel: z
      .array(z.string().uuid())
      .min(1)
      .max(PROJECT_ROOM_LIVE_MAX_ROOMS)
      .refine((ids) => new Set(ids).size === ids.length),
    client: z.string().uuid(),
  })
  .strict();

interface Subscription {
  key: string;
  roomId: string;
  admission: ProjectRoomAdmission;
  sentSeq: number;
  sentActivity: number;
  /** Messages changed since the last frame; `undefined` once one is unknown. */
  changed: Set<string> | undefined;
  dirty: boolean;
  last: { presence: string; typing: string; agents: string };
  unwatch(): void;
}

/**
 * One SSE stream for many of a Project's rooms (#4798). Each channel is
 * admitted exactly as a history read of that channel (`view`), and that
 * admission is checked again before every frame about it: a channel the
 * caller loses ends with `revoked` while the others keep streaming. A
 * channel the caller cannot read answers `unavailable`, the same as one that
 * does not exist. Durable history stays the source of truth: frames carry
 * the sequence and activity range they cover, and anything the stream cannot
 * describe exactly is a `resync`.
 */
export async function projectRoomLiveResponse(
  c: Context,
  service: ProjectRoomService,
  failures: ProjectRoomAgentFailures | undefined,
): Promise<Response> {
  const url = new URL(c.req.url);
  const keys = [...url.searchParams.keys()];
  if (keys.some((key) => key !== 'channel' && key !== 'client'))
    throw new z.ZodError([]);
  const { channel: channels, client } = query.parse({
    channel: url.searchParams.getAll('channel'),
    client: url.searchParams.get('client') ?? undefined,
  });
  const slug = c.req.param('slug')!;
  const request = c.req.raw;
  // Reads never create a room. A Project the caller cannot read refuses the
  // whole request; a channel it cannot read is only that channel's answer.
  const admitted: {
    key: string;
    roomId?: string;
    admission?: ProjectRoomAdmission;
  }[] = [];
  for (const key of channels) {
    try {
      const { data, admission } = await service.history(
        request,
        slug,
        0,
        1,
        key,
      );
      admitted.push({ key, roomId: data.roomId, admission });
    } catch (error) {
      if (!(error instanceof ProjectRoomRefusal)) throw error;
      admitted.push({ key });
    }
  }
  const first = admitted.find((item) => item.admission)?.admission;
  if (!first || !(await service.current(request, first)))
    return c.json({ error: { code: 'project_room_access_changed' } }, 403);
  const response = streamSSE(c, async (stream) => {
    let stopped = false;
    let wake: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectWrite: ((error: Error) => void) | undefined;
    let writeTimer: ReturnType<typeof setTimeout> | undefined;
    const subscriptions = new Map<string, Subscription>();
    const closeClient = service.openClient(first.actorId, client);
    const end = () => {
      for (const sub of subscriptions.values()) sub.unwatch();
      subscriptions.clear();
      closeClient();
    };
    const stop = () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      wake?.();
      if (writeTimer) clearTimeout(writeTimer);
      rejectWrite?.(new Error('Room stream closed'));
      end();
    };
    const off = service.onClose(() => {
      stop();
      stream.abort();
    });
    stream.onAbort(stop);
    const write = async (frame: ProjectRoomLiveFrame | 'heartbeat') => {
      if (stopped) throw new Error('Room stream closed');
      try {
        await Promise.race([
          frame === 'heartbeat'
            ? stream.write(': ping\n\n')
            : (() => {
                const { kind, ...value } = frame;
                return stream.writeSSE({
                  event: kind,
                  data: JSON.stringify(value),
                });
              })(),
          new Promise<never>((_, reject) => {
            rejectWrite = reject;
            writeTimer = setTimeout(() => {
              stop();
              stream.abort();
              reject(new Error('Room stream stalled'));
            }, 2000);
          }),
        ]);
      } finally {
        if (writeTimer) clearTimeout(writeTimer);
        rejectWrite = undefined;
        writeTimer = undefined;
      }
    };
    const revoke = async (sub: Subscription) => {
      sub.unwatch();
      subscriptions.delete(sub.key);
      await write({ kind: 'revoked', key: sub.key });
    };
    const agents = (roomId: string) => {
      // This frame's failure answers: each id is asked about at most once,
      // in batches, so a frame costs a fixed number of journal reads.
      const failed = new Map<
        string,
        NonNullable<ProjectRoomAgentActivity['failure']> | undefined
      >();
      const lookup = (ids: readonly string[]) => {
        const missing = ids.filter((id) => !failed.has(id));
        const found = missing.length ? failures?.(missing) : undefined;
        for (const id of missing) failed.set(id, found?.get(id));
        return { has: (id: string) => failed.get(id) !== undefined };
      };
      // A request with a recorded failure is not working, so it never
      // takes a place kept for one that is.
      const requests = service.recentRequests(
        roomId,
        PROJECT_ROOM_LIVE_AGENT_REQUESTS,
        PROJECT_ROOM_LIVE_WORKING_REQUESTS,
        lookup,
      );
      lookup(requests.map((r) => r.requestId));
      return requests.map((request): ProjectRoomAgentActivity => {
        const failure = failed?.get(request.requestId);
        return {
          requestId: request.requestId,
          agentId: request.agentId,
          actor: { ...request.actor },
          state: request.state,
          ...(request.replyTo ? { replyTo: request.replyTo } : {}),
          ...(request.publishedMessageId
            ? { publishedMessageId: request.publishedMessageId }
            : {}),
          createdAt: request.createdAt,
          updatedAt: request.updatedAt,
          ...(failure &&
          request.state !== 'published' &&
          request.state !== 'cancelled'
            ? { failure }
            : {}),
        };
      });
    };
    /** Everything this room's frames still owe, after its admission holds. */
    const flush = async (sub: Subscription) => {
      sub.dirty = false;
      const checkpoint = service.checkpoint(sub.roomId);
      const changed = sub.changed;
      sub.changed = new Set();
      if (checkpoint.lastSeq > sub.sentSeq) {
        const missing = checkpoint.lastSeq - sub.sentSeq;
        if (missing > PROJECT_ROOM_LIVE_UPDATE_MESSAGES) {
          await resync(sub, checkpoint);
          return;
        }
        const { data } = await service.history(
          request,
          slug,
          sub.sentSeq,
          missing,
          sub.key,
        );
        if (!(await service.current(request, sub.admission))) {
          await revoke(sub);
          return;
        }
        for (const message of data.messages) {
          if (message.seq !== sub.sentSeq + 1) {
            await resync(sub, checkpoint);
            return;
          }
          await write({ kind: 'append', key: sub.key, message });
          sub.sentSeq = message.seq;
        }
      }
      if (checkpoint.activity > sub.sentActivity) {
        if (
          !changed?.size ||
          changed.size > PROJECT_ROOM_LIVE_UPDATE_MESSAGES
        ) {
          await resync(sub, checkpoint);
          return;
        }
        const messages = service.projectedMessages(sub.roomId, [...changed]);
        if (!messages.length) {
          await resync(sub, checkpoint);
          return;
        }
        await write({
          kind: 'update',
          key: sub.key,
          messages,
          fromActivity: sub.sentActivity,
          activity: checkpoint.activity,
        });
        sub.sentActivity = checkpoint.activity;
      }
      const presence = { participants: service.presence(sub.roomId) };
      const typing = { actors: service.typing(sub.roomId) };
      const requests = { requests: agents(sub.roomId) };
      for (const [name, value] of [
        ['presence', presence],
        ['typing', typing],
        ['agents', requests],
      ] as const) {
        const json = JSON.stringify(value);
        if (json === sub.last[name]) continue;
        await write({
          kind: name,
          key: sub.key,
          ...value,
        } as ProjectRoomLiveFrame);
        sub.last[name] = json;
      }
    };
    const resync = async (
      sub: Subscription,
      checkpoint: { lastSeq: number; activity: number },
    ) => {
      await write({
        kind: 'resync',
        key: sub.key,
        lastSeq: checkpoint.lastSeq,
        activity: checkpoint.activity,
      });
      sub.sentSeq = checkpoint.lastSeq;
      sub.sentActivity = checkpoint.activity;
    };
    try {
      for (const item of admitted) {
        if (!item.admission || !item.roomId) {
          await write({ kind: 'unavailable', key: item.key });
          continue;
        }
        const roomId = item.roomId;
        const sub: Subscription = {
          key: item.key,
          roomId,
          admission: item.admission,
          sentSeq: 0,
          sentActivity: 0,
          changed: new Set(),
          dirty: true,
          last: { presence: '', typing: '', agents: '' },
          unwatch: () => {},
        };
        // Watch before the first checkpoint, so no commit falls between them.
        sub.unwatch = service.watch(roomId, (changed) => {
          if (!changed) sub.changed = undefined;
          else if (sub.changed)
            for (const id of changed)
              if (sub.changed.size <= PROJECT_ROOM_LIVE_UPDATE_MESSAGES)
                sub.changed.add(id);
              else {
                sub.changed = undefined;
                break;
              }
          sub.dirty = true;
          wake?.();
        });
        subscriptions.set(sub.key, sub);
        const checkpoint = service.checkpoint(roomId);
        sub.sentSeq = checkpoint.lastSeq;
        sub.sentActivity = checkpoint.activity;
        sub.changed = new Set();
        await write({
          kind: 'subscribed',
          key: sub.key,
          roomId,
          lastSeq: checkpoint.lastSeq,
          activity: checkpoint.activity,
        });
      }
      let heartbeatAt = Date.now() + 20000;
      while (!stopped && subscriptions.size) {
        for (const sub of [...subscriptions.values()]) {
          if (stopped) break;
          // Typing and presence expire on their own, without a commit to
          // wake the room: each pass looks, and only a change is sent.
          if (
            !sub.dirty &&
            JSON.stringify({ participants: service.presence(sub.roomId) }) ===
              sub.last.presence &&
            JSON.stringify({ actors: service.typing(sub.roomId) }) ===
              sub.last.typing
          )
            continue;
          if (!(await service.current(request, sub.admission))) {
            await revoke(sub);
            continue;
          }
          try {
            await flush(sub);
          } catch (error) {
            // An archived or removed channel ends only its own subscription.
            if (!(error instanceof ProjectRoomRefusal)) throw error;
            sub.unwatch();
            subscriptions.delete(sub.key);
            await write({ kind: 'unavailable', key: sub.key });
          }
        }
        if (stopped || !subscriptions.size) break;
        if (Date.now() >= heartbeatAt) {
          await write('heartbeat');
          heartbeatAt = Date.now() + 20000;
        }
        await new Promise<void>((resolve) => {
          wake = () => {
            if (timer) clearTimeout(timer);
            resolve();
          };
          if (stopped || [...subscriptions.values()].some((s) => s.dirty))
            resolve();
          else timer = setTimeout(resolve, 1000);
        });
      }
    } catch {
      /* The transport closed or a read failed: the client reconnects. */
    } finally {
      off();
      end();
      if (timer) clearTimeout(timer);
    }
  });
  const guarded = await guardProjectResponse(response, () =>
    service.current(request, first),
  );
  if (guarded.status !== 200 || !guarded.body) return guarded;
  // A guard refusal ends protected delivery: queued room content is
  // discarded, and only fixed `revoked` frames for the rooms this stream
  // admitted are released, so the client can tell lost access from a drop.
  const terminal = admitted
    .filter((item) => item.admission)
    .map(
      (item) =>
        `event: revoked\ndata: ${JSON.stringify({ key: item.key })}\n\n`,
    )
    .join('');
  const reader = guarded.body.getReader();
  return new Response(
    new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) controller.close();
            else controller.enqueue(next.value);
          } catch {
            controller.enqueue(new TextEncoder().encode(terminal));
            controller.close();
            void reader.cancel().catch(() => {});
          }
        },
        cancel(reason) {
          return reader.cancel(reason);
        },
      },
      { highWaterMark: 0 },
    ),
    { headers: guarded.headers },
  );
}

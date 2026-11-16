import { CHAT_ATTACHMENT_MAX_COMMAND_JSON_BYTES } from '@kontourai/station-contracts/chat-attachment';
import {
  PROJECT_ROOM_PROJECT_NOT_FOUND_CODE,
  parseProjectRoomAgentRequestInput,
  parseProjectRoomAppendInput,
  parseProjectRoomChannelCreateInput,
  parseProjectRoomChannelUpdateInput,
  parseProjectRoomDeleteInput,
  parseProjectRoomEditInput,
  parseProjectRoomNoteInput,
  parseProjectRoomReactionInput,
} from '@kontourai/station-contracts/project-room';
import { type Context, Hono } from 'hono';
import { z } from 'zod/v3';
import { ProjectNotFoundError } from '../../domain/project-file-transactions.js';
import { ProjectMembershipRefusal } from '../../services/projects/project-membership-store.js';
import { guardProjectResponse } from '../../services/projects/project-response-guard.js';
import type {
  ProjectRoomAgentAuthority,
  ProjectRoomAgentHandle,
  ProjectRoomAgentModule,
} from '../../services/projects/project-room-agent-module.js';
import type { ProjectRoomMutationGuard } from '../../services/projects/project-room-service.js';
import { ProjectRoomService } from '../../services/projects/project-room-service.js';
import { ProjectRoomRefusal } from '../../services/projects/project-room-store.js';
import { createLogger } from '../../utils/logger.js';
import { roomAttachmentUploadItemsSchema } from '../orchestration/task-room-attachment-http.js';
import { streamSSE } from '../sse-response.js';

const logger = createLogger({ name: 'project-room-routes' });
const guards = z.object({
  expectedRoomId: z.string().uuid(),
  expectedProjectId: z.string().min(1).max(512),
  expectedActorId: z.string().min(1).max(2048),
});
const channelGuards = guards.omit({ expectedRoomId: true });
class InvalidRoomInput extends Error {}
async function body(c: Context, maxBytes = 32768) {
  const length = Number(c.req.header('content-length'));
  if (Number.isFinite(length) && length > maxBytes)
    throw new InvalidRoomInput();
  const text = await c.req.text();
  if (Buffer.byteLength(text) > maxBytes) throw new InvalidRoomInput();
  return JSON.parse(text) as unknown;
}
function parse<T>(parser: (v: unknown) => T, value: unknown): T {
  try {
    return parser(value);
  } catch {
    throw new InvalidRoomInput();
  }
}
export interface ProjectRoomAgentRoutes {
  module: ProjectRoomAgentModule;
  /** Register a bounded, fresh execute-authorized completion watch. */
  observe?(
    authority: ProjectRoomAgentAuthority,
    handle: ProjectRoomAgentHandle,
  ): void;
  withAuthority<T>(
    request: Request,
    slug: string,
    action: 'view' | 'execute',
    guard: ProjectRoomMutationGuard | undefined,
    operation: (authority: ProjectRoomAgentAuthority) => T,
    /** The addressed channel; absent means the Project's default room. */
    channelId?: string,
  ): Promise<T>;
}
/**
 * Room routes are registered twice, with literal paths the pairing-scope leaf
 * scan can read: under `/:slug/room` for the Project's default channel
 * (`#general`) and under `/:slug/channels/:channelId` for any channel.
 */
function channelOf(
  prefix: '/:slug/room' | '/:slug/channels/:channelId',
  c: Context,
): string | undefined {
  return prefix === '/:slug/room'
    ? undefined
    : z.string().uuid().parse(c.req.param('channelId'));
}
export function createProjectRoomRoutes(
  service: ProjectRoomService,
  agents?: ProjectRoomAgentRoutes,
) {
  const app = new Hono();
  async function perform(c: Context, run: () => Promise<Response>) {
    c.header('Cache-Control', 'no-store');
    try {
      return await run();
    } catch (error) {
      if (
        error instanceof InvalidRoomInput ||
        error instanceof SyntaxError ||
        error instanceof z.ZodError
      )
        return c.json({ error: { code: 'project_room_invalid' } }, 400);
      if (error instanceof ProjectRoomRefusal)
        return c.json(
          { error: { code: `project_room_${error.code}` } },
          error.code === 'invalid'
            ? 400
            : error.code === 'not_found'
              ? 404
              : error.code === 'capacity'
                ? 429
                : error.code === 'files_unavailable'
                  ? 503
                  : // `forbidden` too: a 403 here means access changed, and
                    // clients stop the whole room on it.
                    409,
        );
      if (error instanceof ProjectMembershipRefusal)
        return c.json({ error: { code: 'project_room_access_changed' } }, 403);
      // No such Project on this Station: not an outage (#4855).
      if (error instanceof ProjectNotFoundError)
        return c.json(
          { error: { code: PROJECT_ROOM_PROJECT_NOT_FOUND_CODE } },
          404,
        );
      logger.error('Project Room operation unavailable', { error });
      return c.json({ error: { code: 'project_room_unavailable' } }, 503);
    }
  }
  async function deliver<T>(
    c: Context,
    result: {
      data: T;
      admission: Parameters<ProjectRoomService['current']>[1];
    },
  ) {
    return guardProjectResponse(
      c.json({ success: true, data: result.data }),
      () => service.current(c.req.raw, result.admission),
    );
  }
  app.post('/:slug/room/init', (c) =>
    perform(c, async () => {
      const { expectedProjectId } = z
        .object({ expectedProjectId: z.string().min(1).max(512) })
        .strict()
        .parse(await body(c));
      return deliver(
        c,
        await service.open(c.req.raw, c.req.param('slug'), expectedProjectId),
      );
    }),
  );
  if (agents) {
    const observe = (
      authority: ProjectRoomAgentAuthority,
      handle: ProjectRoomAgentHandle,
    ) => {
      try {
        agents.observe?.(authority, handle);
      } catch {
        logger.warn(
          'Room answer observation unavailable; explicit recovery available',
        );
      }
    };
    const runAgent = async (
      c: Context,
      action: 'view' | 'execute',
      guard: ProjectRoomMutationGuard | undefined,
      operation: (authority: ProjectRoomAgentAuthority) => unknown,
      channelId: string | undefined,
    ) => {
      const result = await agents.withAuthority(
        c.req.raw,
        c.req.param('slug')!,
        action,
        guard,
        async (authority) => {
          const data = await operation(authority);
          authority.assertCurrent();
          return {
            data,
            admission: {
              scope: authority.scope,
              actorId: authority.requester.id,
            },
          };
        },
        channelId,
      );
      return deliver(c, result);
    };
    for (const prefix of [
      '/:slug/room',
      '/:slug/channels/:channelId',
    ] as const) {
      const channel = (c: Context) => channelOf(prefix, c);
      app.post(`${prefix}/agents`, (c) =>
        perform(c, async () => {
          const {
            expectedRoomId,
            expectedProjectId,
            expectedActorId,
            ...input
          } = guards
            .extend({
              intentId: z.unknown(),
              agentId: z.unknown(),
              text: z.unknown(),
              replyTo: z.unknown().optional(),
            })
            .strict()
            .parse(await body(c));
          return runAgent(
            c,
            'execute',
            { expectedRoomId, expectedProjectId, expectedActorId },
            async (authority) => {
              const handle = await agents.module.request(
                authority,
                parse(parseProjectRoomAgentRequestInput, input),
              );
              observe(authority, handle);
              return handle;
            },
            channel(c),
          );
        }),
      );
      app.get(`${prefix}/agents/:requestId`, (c) =>
        perform(c, () =>
          runAgent(
            c,
            'view',
            undefined,
            (authority) =>
              agents.module.inspect(authority, c.req.param('requestId')!),
            channel(c),
          ),
        ),
      );
      for (const operation of ['cancel', 'reconcile'] as const) {
        app.post(`${prefix}/agents/:requestId/${operation}`, (c) =>
          perform(c, async () => {
            const guard = guards.strict().parse(await body(c));
            return runAgent(
              c,
              'execute',
              guard,
              async (authority) => {
                const handle = await agents.module[operation](
                  authority,
                  c.req.param('requestId')!,
                );
                if (operation === 'reconcile') observe(authority, handle);
                return handle;
              },
              channel(c),
            );
          }),
        );
      }
    }
  }
  app.get('/:slug/channels', (c) =>
    perform(c, async () =>
      deliver(c, await service.channels(c.req.raw, c.req.param('slug'))),
    ),
  );
  app.post('/:slug/channels', (c) =>
    perform(c, async () => {
      const { expectedProjectId, expectedActorId, ...input } = channelGuards
        .extend({ name: z.unknown(), topic: z.unknown().optional() })
        .strict()
        .parse(await body(c));
      return deliver(
        c,
        await service.createChannel(
          c.req.raw,
          c.req.param('slug'),
          { expectedProjectId, expectedActorId },
          parse(parseProjectRoomChannelCreateInput, input),
        ),
      );
    }),
  );
  app.patch('/:slug/channels/:channelId', (c) =>
    perform(c, async () => {
      const channelId = z.string().uuid().parse(c.req.param('channelId'));
      const { expectedProjectId, expectedActorId, ...input } = channelGuards
        .extend({
          name: z.unknown().optional(),
          topic: z.unknown().optional(),
          archived: z.unknown().optional(),
        })
        .strict()
        .parse(await body(c));
      return deliver(
        c,
        await service.updateChannel(
          c.req.raw,
          c.req.param('slug'),
          channelId,
          { expectedProjectId, expectedActorId },
          parse(parseProjectRoomChannelUpdateInput, input),
        ),
      );
    }),
  );
  for (const prefix of ['/:slug/room', '/:slug/channels/:channelId'] as const) {
    const channel = (c: Context) => channelOf(prefix, c);
    // A template literal, not the bare variable: the leaf scan reads only literals.
    app.get(`${prefix}`, (c) =>
      perform(c, async () =>
        deliver(
          c,
          await service.discover(c.req.raw, c.req.param('slug')!, channel(c)),
        ),
      ),
    );
    app.get(`${prefix}/messages`, (c) =>
      perform(c, async () => {
        const query = z
          .object({
            after: z.coerce.number().int().min(0).default(0),
            limit: z.coerce.number().int().min(1).max(100).default(50),
          })
          .strict()
          .parse(c.req.query());
        return deliver(
          c,
          await service.history(
            c.req.raw,
            c.req.param('slug')!,
            query.after,
            query.limit,
            channel(c),
          ),
        );
      }),
    );
    app.post(`${prefix}/messages`, (c) =>
      perform(c, async () => {
        const { expectedRoomId, expectedProjectId, expectedActorId, ...input } =
          guards
            .extend({
              intentId: z.unknown(),
              text: z.unknown(),
              replyTo: z.unknown().optional(),
              attachments: z.unknown().optional(),
            })
            .strict()
            .parse(await body(c));
        return deliver(
          c,
          await service.append(
            c.req.raw,
            c.req.param('slug')!,
            { expectedRoomId, expectedProjectId, expectedActorId },
            parse(parseProjectRoomAppendInput, input),
            channel(c),
          ),
        );
      }),
    );
    const messageId = (c: Context) =>
      z.string().uuid().parse(c.req.param('messageId'));
    app.post(`${prefix}/messages/:messageId/reactions`, (c) =>
      perform(c, async () => {
        const { expectedRoomId, expectedProjectId, expectedActorId, ...input } =
          guards
            .extend({ emoji: z.unknown(), reacted: z.unknown() })
            .strict()
            .parse(await body(c));
        return deliver(
          c,
          await service.react(
            c.req.raw,
            c.req.param('slug')!,
            { expectedRoomId, expectedProjectId, expectedActorId },
            messageId(c),
            parse(parseProjectRoomReactionInput, input),
            channel(c),
          ),
        );
      }),
    );
    app.post(`${prefix}/messages/:messageId/edit`, (c) =>
      perform(c, async () => {
        const { expectedRoomId, expectedProjectId, expectedActorId, ...input } =
          guards
            .extend({ intentId: z.unknown(), text: z.unknown() })
            .strict()
            .parse(await body(c));
        return deliver(
          c,
          await service.edit(
            c.req.raw,
            c.req.param('slug')!,
            { expectedRoomId, expectedProjectId, expectedActorId },
            messageId(c),
            parse(parseProjectRoomEditInput, input),
            channel(c),
          ),
        );
      }),
    );
    app.post(`${prefix}/messages/:messageId/delete`, (c) =>
      perform(c, async () => {
        const { expectedRoomId, expectedProjectId, expectedActorId, ...input } =
          guards
            .extend({ intentId: z.unknown() })
            .strict()
            .parse(await body(c));
        return deliver(
          c,
          await service.deleteMessage(
            c.req.raw,
            c.req.param('slug')!,
            { expectedRoomId, expectedProjectId, expectedActorId },
            messageId(c),
            parse(parseProjectRoomDeleteInput, input),
            channel(c),
          ),
        );
      }),
    );
    app.post(`${prefix}/attachments`, (c) =>
      perform(c, async () => {
        const { attachments, ...guard } = guards
          .extend({ attachments: roomAttachmentUploadItemsSchema })
          .strict()
          .parse(await body(c, CHAT_ATTACHMENT_MAX_COMMAND_JSON_BYTES));
        return deliver(
          c,
          await service.storeAttachments(
            c.req.raw,
            c.req.param('slug')!,
            guard,
            attachments,
            channel(c),
          ),
        );
      }),
    );
    // Bytes, never rendered by the browser as a page of this origin.
    app.get(`${prefix}/attachments/:attachmentId`, (c) =>
      perform(c, async () => {
        const result = await service.readAttachment(
          c.req.raw,
          c.req.param('slug')!,
          z.string().uuid().parse(c.req.param('attachmentId')),
          channel(c),
        );
        return guardProjectResponse(
          c.body(Uint8Array.from(result.data.bytes), 200, {
            'Cache-Control': 'private, no-cache',
            'X-Content-Type-Options': 'nosniff',
            'Content-Type': 'application/octet-stream',
            'Content-Security-Policy': 'sandbox',
          }),
          () => service.current(c.req.raw, result.admission),
        );
      }),
    );
    app.put(`${prefix}/note`, (c) =>
      perform(c, async () => {
        const { expectedRoomId, expectedProjectId, expectedActorId, ...input } =
          guards
            .extend({
              expectedRevision: z.unknown(),
              markdown: z.unknown(),
              sourceMessageIds: z.unknown(),
            })
            .strict()
            .parse(await body(c));
        return deliver(
          c,
          await service.note(
            c.req.raw,
            c.req.param('slug')!,
            { expectedRoomId, expectedProjectId, expectedActorId },
            parse(parseProjectRoomNoteInput, input),
            channel(c),
          ),
        );
      }),
    );
    app.post(`${prefix}/presence`, (c) =>
      perform(c, async () => {
        const { clientId, state, ...guard } = guards
          .extend({
            clientId: z.string().uuid(),
            state: z.enum(['join', 'leave']),
          })
          .strict()
          .parse(await body(c));
        return deliver(
          c,
          await service.updatePresence(
            c.req.raw,
            c.req.param('slug')!,
            guard,
            clientId,
            state,
            channel(c),
          ),
        );
      }),
    );
    app.get(`${prefix}/events`, (c) =>
      perform(c, async () => {
        // Reads never create a Room; initialization is an explicit discuss action.
        const initial = await service.history(
          c.req.raw,
          c.req.param('slug')!,
          0,
          1,
          channel(c),
        );
        if (!(await service.current(c.req.raw, initial.admission)))
          return c.json(
            { error: { code: 'project_room_access_changed' } },
            403,
          );
        const response = streamSSE(c, async (stream) => {
          let stopped = false;
          let dirty = true;
          const roomId = initial.data.roomId;
          let lastContent = '';
          let lastPresence = '';
          let heartbeatAt = Date.now() + 20000;
          let wake: (() => void) | undefined;
          let timer: ReturnType<typeof setTimeout> | undefined;
          let rejectWrite: ((error: Error) => void) | undefined;
          let writeTimer: ReturnType<typeof setTimeout> | undefined;
          let unwatch = () => {};
          const stop = () => {
            unwatch();
            stopped = true;
            if (timer) clearTimeout(timer);
            wake?.();
            if (writeTimer) clearTimeout(writeTimer);
            rejectWrite?.(new Error('Room stream closed'));
            stream.abort();
          };
          const off = service.onClose(stop);
          // Subscribe before taking the first checkpoint; a commit during admission
          // cannot fall into a read/subscribe gap. Dirty is bounded to one bit.
          unwatch = service.watch(roomId, () => {
            dirty = true;
            wake?.();
          });
          stream.onAbort(() => {
            unwatch();
            stopped = true;
            if (timer) clearTimeout(timer);
            wake?.();
            if (writeTimer) clearTimeout(writeTimer);
            rejectWrite?.(new Error('Room stream closed'));
          });
          const write = async (event: string, data: unknown) => {
            if (stopped) throw new Error('Room stream closed');
            try {
              await Promise.race([
                event === 'heartbeat'
                  ? stream.write(': ping\n\n')
                  : stream.writeSSE({ event, data: JSON.stringify(data) }),
                new Promise<never>((_, reject) => {
                  rejectWrite = reject;
                  writeTimer = setTimeout(() => {
                    stop();
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
          try {
            while (!stopped) {
              if (!(await service.current(c.req.raw, initial.admission))) {
                service.removePresence(initial.admission);
                await write('revoked', { reason: 'access_changed' });
                break;
              }
              if (stopped) break;
              dirty = false;
              const checkpoint = service.checkpoint(roomId);
              const content = JSON.stringify(checkpoint);
              if (content !== lastContent) {
                if (!(await service.current(c.req.raw, initial.admission)))
                  continue;
                await write('changed', { roomId, lastSeq: checkpoint.lastSeq });
                lastContent = content;
              }
              const participants = service.presence(roomId);
              const presence = JSON.stringify(participants);
              if (presence !== lastPresence) {
                if (!(await service.current(c.req.raw, initial.admission)))
                  continue;
                await write('presence', { participants });
                lastPresence = presence;
              }
              if (Date.now() >= heartbeatAt) {
                if (!(await service.current(c.req.raw, initial.admission)))
                  continue;
                await write('heartbeat', {});
                heartbeatAt = Date.now() + 20000;
              }
              await new Promise<void>((resolve) => {
                wake = () => {
                  if (timer) clearTimeout(timer);
                  resolve();
                };
                if (stopped || dirty) resolve();
                else timer = setTimeout(resolve, 2000);
              });
            }
          } catch {
            service.removePresence(initial.admission);
            if (!stopped) {
              try {
                await write('revoked', { reason: 'access_changed' });
              } catch {
                /* Transport already closed. */
              }
            }
          } finally {
            off();
            unwatch();
            service.removePresence(initial.admission);
            if (timer) clearTimeout(timer);
          }
        });
        const guarded = await guardProjectResponse(response, async () => {
          const current = await service.current(c.req.raw, initial.admission);
          if (!current) service.removePresence(initial.admission);
          return current;
        });
        if (guarded.status !== 200 || !guarded.body) return guarded;
        const reader = guarded.body.getReader();
        // A guard refusal ends protected delivery. Only this fixed terminal frame
        // may be released afterwards; queued Room content is discarded.
        return new Response(
          new ReadableStream<Uint8Array>(
            {
              async pull(controller) {
                try {
                  const next = await reader.read();
                  if (next.done) controller.close();
                  else controller.enqueue(next.value);
                } catch {
                  controller.enqueue(
                    new TextEncoder().encode(
                      'event: revoked\ndata: {"reason":"access_changed"}\n\n',
                    ),
                  );
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
      }),
    );
  }
  return app;
}

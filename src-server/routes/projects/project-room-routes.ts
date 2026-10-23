import {
  parseProjectRoomAgentRequestInput,
  parseProjectRoomAppendInput,
  parseProjectRoomNoteInput,
} from '@kontourai/station-contracts/project-room';
import { type Context, Hono } from 'hono';
import { z } from 'zod/v3';
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
import { streamSSE } from '../sse-response.js';

const logger = createLogger({ name: 'project-room-routes' });
const guards = z.object({
  expectedRoomId: z.string().uuid(),
  expectedProjectId: z.string().min(1).max(512),
  expectedActorId: z.string().min(1).max(2048),
});
class InvalidRoomInput extends Error {}
async function body(c: Context) {
  const text = await c.req.text();
  if (Buffer.byteLength(text) > 32768) throw new InvalidRoomInput();
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
  ): Promise<T>;
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
                : 409,
        );
      if (error instanceof ProjectMembershipRefusal)
        return c.json({ error: { code: 'project_room_access_changed' } }, 403);
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
      );
      return deliver(c, result);
    };
    app.post('/:slug/room/agents', (c) =>
      perform(c, async () => {
        const { expectedRoomId, expectedProjectId, expectedActorId, ...input } =
          guards
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
        );
      }),
    );
    app.get('/:slug/room/agents/:requestId', (c) =>
      perform(c, () =>
        runAgent(c, 'view', undefined, (authority) =>
          agents.module.inspect(authority, c.req.param('requestId')),
        ),
      ),
    );
    for (const operation of ['cancel', 'reconcile'] as const) {
      app.post(`/:slug/room/agents/:requestId/${operation}`, (c) =>
        perform(c, async () => {
          const guard = guards.strict().parse(await body(c));
          return runAgent(c, 'execute', guard, async (authority) => {
            const handle = await agents.module[operation](
              authority,
              c.req.param('requestId')!,
            );
            if (operation === 'reconcile') observe(authority, handle);
            return handle;
          });
        }),
      );
    }
  }
  app.get('/:slug/room', (c) =>
    perform(c, async () =>
      deliver(c, await service.discover(c.req.raw, c.req.param('slug'))),
    ),
  );
  app.get('/:slug/room/messages', (c) =>
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
          c.req.param('slug'),
          query.after,
          query.limit,
        ),
      );
    }),
  );
  app.post('/:slug/room/messages', (c) =>
    perform(c, async () => {
      const { expectedRoomId, expectedProjectId, expectedActorId, ...input } =
        guards
          .extend({
            intentId: z.unknown(),
            text: z.unknown(),
            replyTo: z.unknown().optional(),
          })
          .strict()
          .parse(await body(c));
      return deliver(
        c,
        await service.append(
          c.req.raw,
          c.req.param('slug'),
          { expectedRoomId, expectedProjectId, expectedActorId },
          parse(parseProjectRoomAppendInput, input),
        ),
      );
    }),
  );
  app.put('/:slug/room/note', (c) =>
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
          c.req.param('slug'),
          { expectedRoomId, expectedProjectId, expectedActorId },
          parse(parseProjectRoomNoteInput, input),
        ),
      );
    }),
  );
  app.post('/:slug/room/presence', (c) =>
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
          c.req.param('slug'),
          guard,
          clientId,
          state,
        ),
      );
    }),
  );
  app.get('/:slug/room/events', (c) =>
    perform(c, async () => {
      // Reads never create a Room; initialization is an explicit discuss action.
      const initial = await service.history(
        c.req.raw,
        c.req.param('slug'),
        0,
        1,
      );
      if (!(await service.current(c.req.raw, initial.admission)))
        return c.json({ error: { code: 'project_room_access_changed' } }, 403);
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
  return app;
}

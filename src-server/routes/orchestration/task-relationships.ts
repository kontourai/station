import type { TaskIdentity } from '@kontourai/station-contracts/task-graph';
import { Hono } from 'hono';
import { z } from 'zod/v3';
import type { TaskGraphService } from '../../services/projects/task-graph-service.js';
import {
  type TaskRelationshipAuthority,
  TaskRelationshipError,
} from '../../services/projects/task-relationship-state.js';

const identity = z
  .object({
    taskId: z.string().min(1).max(4096),
    taskCreatedAt: z.string().datetime(),
  })
  .strict();
const operation = z.string().trim().min(1).max(160);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const parentInput = z
  .object({
    operationId: operation,
    child: identity,
    parent: identity.nullable(),
    expectedRevision: revision,
  })
  .strict();
const chatInput = z
  .object({
    operationId: operation,
    task: identity,
    conversationId: z.string().trim().min(1).max(4096),
    expectedRevision: revision,
  })
  .strict();
const childInput = z
  .object({
    operationId: operation,
    parent: identity,
    task: z
      .object({
        projectId: z.string().trim().min(1),
        title: z.string().trim().min(1).max(240),
        description: z.string().max(12000).optional(),
        priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
        skillName: z.string().optional(),
        agentId: z.string().optional(),
      })
      .strict(),
  })
  .strict();

/**
 * Runtime composition mounts this factory at /api/tasks with request-local
 * canonical Conversation preparation and live lock/delivery authority checks.
 */
export interface TaskRelationshipRouteAdapters {
  authorityForRequest(
    request: Request,
    conversationId?: string,
  ): Promise<TaskRelationshipAuthority | undefined>;
  /** Current principal, Task and per-target access at final response delivery. */
  isCurrent(request: Request): boolean;
}

export function createTaskRelationshipRoutes(
  graph: TaskGraphService,
  adapters: TaskRelationshipRouteAdapters,
) {
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof TaskRelationshipError)
      return c.json(
        {
          success: false,
          error: 'Task relationship unavailable',
          code: error.code,
        },
        error.code === 'conflict' ? 409 : error.code === 'invalid' ? 400 : 404,
      );
    return c.json(
      { success: false, error: 'Task relationship unavailable' },
      503,
    );
  });
  const authority = async (request: Request, conversationId?: string) => {
    const value = await adapters.authorityForRequest(request, conversationId);
    if (!value || !adapters.isCurrent(request))
      throw new TaskRelationshipError('unavailable');
    return value;
  };
  const delivery = (request: Request) => {
    if (!adapters.isCurrent(request))
      throw new TaskRelationshipError('unavailable');
  };
  const readIdentity = (
    taskId: string,
    taskCreatedAt: string | undefined,
  ): TaskIdentity => {
    const parsed = identity.safeParse({ taskId, taskCreatedAt });
    if (!parsed.success) throw new TaskRelationshipError('invalid');
    return parsed.data;
  };
  const readableTask = (
    task: TaskIdentity,
    access: TaskRelationshipAuthority,
    mutation = false,
  ) => {
    const current = graph.readTask(task.taskId);
    const project = current && access.canonicalProject(current.projectId);
    if (
      !current ||
      current.createdAt !== task.taskCreatedAt ||
      !project ||
      project.id !== access.expectedProject.id ||
      project.createdAt !== access.expectedProject.createdAt ||
      !(mutation ? access.canMutateTask(current) : access.canReadTask(current))
    )
      throw new TaskRelationshipError('unavailable');
  };
  app.get('/:taskId/children', async (c) => {
    const task = readIdentity(
      c.req.param('taskId'),
      c.req.query('taskCreatedAt'),
    );
    const access = await authority(c.req.raw);
    const children = graph.listTaskChildren(task, access);
    delivery(c.req.raw);
    // Re-read at delivery; no private child title or count survives revocation.
    const readable = new Set(
      graph.listTaskChildren(task, access).map((child) => child.id),
    );
    return c.json({
      success: true,
      data: {
        task,
        children: children.filter(
          (child) => readable.has(child.id) && access.canReadTask(child),
        ),
      },
    });
  });
  app.post('/:taskId/children', async (c) => {
    const input = childInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success || input.data.parent.taskId !== c.req.param('taskId'))
      throw new TaskRelationshipError('invalid');
    const access = await authority(c.req.raw);
    const result = await graph.createChildTask(input.data, access);
    delivery(c.req.raw);
    readableTask(input.data.parent, access, true);
    readableTask(
      { taskId: result.task.id, taskCreatedAt: result.task.createdAt },
      access,
    );
    if (!access.canReadTask(result.task))
      throw new TaskRelationshipError('unavailable');
    return c.json({ success: true, data: result });
  });
  app.put('/:taskId/parent', async (c) => {
    const input = parentInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success || input.data.child.taskId !== c.req.param('taskId'))
      throw new TaskRelationshipError('invalid');
    const access = await authority(c.req.raw);
    const result = await graph.setTaskParent(input.data, access);
    delivery(c.req.raw);
    for (const task of [result.child, result.parent, result.previousParent])
      if (task) readableTask(task, access, true);
    return c.json({ success: true, data: result });
  });
  app.get('/:taskId/work-chats', async (c) => {
    const task = readIdentity(
      c.req.param('taskId'),
      c.req.query('taskCreatedAt'),
    );
    const access = await authority(c.req.raw);
    const chats = graph.listTaskWorkChats(task, access);
    delivery(c.req.raw);
    const readable = new Set(
      graph.listTaskWorkChats(task, access).map((chat) => chat.conversationId),
    );
    return c.json({
      success: true,
      data: {
        task,
        chats: chats.filter((chat) => readable.has(chat.conversationId)),
      },
    });
  });
  app.get('/:taskId/work-chats/:conversationId', async (c) => {
    const task = readIdentity(
      c.req.param('taskId'),
      c.req.query('taskCreatedAt'),
    );
    const conversationId = c.req.param('conversationId');
    const access = await authority(c.req.raw, conversationId);
    delivery(c.req.raw);
    return c.json({
      success: true,
      data: graph.readTaskWorkChat(task, conversationId, access),
    });
  });
  for (const method of ['post', 'delete'] as const)
    app[method]('/:taskId/work-chats', async (c) => {
      const input = chatInput.safeParse(await c.req.json().catch(() => null));
      if (!input.success || input.data.task.taskId !== c.req.param('taskId'))
        throw new TaskRelationshipError('invalid');
      const access = await authority(c.req.raw, input.data.conversationId);
      const result = await graph.setTaskWorkChat(
        { ...input.data, linked: method === 'post' },
        access,
      );
      delivery(c.req.raw);
      // Repeat the current reader check after the awaited mutation, before delivery.
      const task = graph.readTask(result.task.taskId);
      const project = task && access.canonicalProject(task.projectId);
      if (
        !task ||
        task.createdAt !== result.task.taskCreatedAt ||
        !access.canMutateTask(task) ||
        !project ||
        project.id !== access.expectedProject.id ||
        project.createdAt !== access.expectedProject.createdAt ||
        !access.canReadConversation(result.conversationId, project)
      )
        throw new TaskRelationshipError('unavailable');
      return c.json({ success: true, data: result });
    });
  return app;
}

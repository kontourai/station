import { Hono } from 'hono';
import type { ProjectTaskRoomRuntime } from '../../services/orchestration/project-task-room-runtime.js';
import type { TaskWriteBackStore } from '../../services/orchestration/task-write-back-store.js';

export function createTaskWriteBackRoutes(deps: {
  readonly runtime: Pick<ProjectTaskRoomRuntime, 'personTaskReviewAccess'>;
  readonly store: TaskWriteBackStore;
  readonly logger: {
    warn(message: string, meta?: Record<string, unknown>): void;
  };
}) {
  const app = new Hono();
  app.get('/:taskId/write-back', async (c) => {
    c.header('Cache-Control', 'no-store');
    try {
      const access = await deps.runtime.personTaskReviewAccess({
        taskId: c.req.param('taskId'),
        request: c.req.raw,
      });
      if (access.kind !== 'granted' || !access.write.beforeCommit())
        return c.json({ success: false, error: 'Task not found.' }, 404);
      const entries = deps.store.list(access.write);
      if (!access.write.beforeCommit())
        return c.json({ success: false, error: 'Task not found.' }, 404);
      return c.json({ success: true, data: { entries } });
    } catch (error) {
      deps.logger.warn('Task write-back read failed', {
        taskId: c.req.param('taskId'),
        errorName: error instanceof Error ? error.name : typeof error,
      });
      return c.json(
        { success: false, error: 'Task write-back is unavailable.' },
        503,
      );
    }
  });
  return app;
}

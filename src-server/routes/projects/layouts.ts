/**
 * Layout Routes - layout and workflow management
 *
 * These handlers do not catch. Every failure reaches the runtime HTTP
 * boundary (`configureRuntimeHttp`'s `app.onError`), which answers a thrown
 * `RouteError` with that error's own status and message and everything else
 * with the generic `{ success: false, error: { code: 'internal_error',
 * correlationId } }` at 500. This file is the first one moved onto that
 * contract; the rest follow family by family.
 *
 * What that changed here, exactly. Every handler used to wrap its whole body
 * in a `try` and label the result with one hard-coded status: 500 for the
 * list, 404 for the read, 400 for all three mutations. None of those were
 * derived from the failure — a disk error on `createWorkflow` answered 400
 * ("bad request") and a missing agent directory on the list answered 500
 * with the underlying message. Now the status is whatever the thrown error
 * says, and an error that says nothing gets the correlated generic envelope.
 *
 * The cost, stated plainly: `LayoutService` and the config-loader beneath it
 * throw only bare `Error`s, including for conditions that really are the
 * caller's fault — an unsupported workflow extension, a workflow id with a
 * path separator in it, creating one that already exists, reading or
 * updating one that does not. Those answered 400/404 with their text and now
 * answer 500 with a correlation id. That is the boundary's existing
 * disclosure rule applied consistently (an untyped message is one nobody
 * reviewed for disclosure), not an improvement in itself: the finer statuses
 * come back when the layout service throws typed errors, at which point
 * their mapping belongs in this file as a `mapServiceError`. There is no
 * such mapper here yet because there is nothing typed to map, and matching
 * on message text to fake one is the defect this contract exists to remove.
 */

import { Hono } from 'hono';
import type { LayoutService } from '../../services/projects/layout-service.js';
import {
  getBody,
  param,
  validate,
  workflowCreateSchema,
  workflowUpdateSchema,
} from '../schemas/schemas.js';

export function createWorkflowRoutes(layoutService: LayoutService) {
  const app = new Hono();

  // List workflow files for agent
  app.get('/:slug/workflows/files', async (c) => {
    const slug = param(c, 'slug');
    const workflows = await layoutService.listAgentWorkflows(slug);
    return c.json({ success: true, data: workflows });
  });

  // Get workflow file content
  app.get('/:slug/workflows/:workflowId', async (c) => {
    const slug = param(c, 'slug');
    const workflowId = param(c, 'workflowId');
    const content = await layoutService.getWorkflow(slug, workflowId);
    return c.json({ success: true, data: { content } });
  });

  // Create workflow file
  app.post('/:slug/workflows', validate(workflowCreateSchema), async (c) => {
    const slug = param(c, 'slug');
    const { filename, content } = getBody(c);
    await layoutService.createWorkflow(slug, filename, content);
    return c.json({ success: true, data: { filename } }, 201);
  });

  // Update workflow file
  app.put(
    '/:slug/workflows/:workflowId',
    validate(workflowUpdateSchema),
    async (c) => {
      const slug = param(c, 'slug');
      const workflowId = param(c, 'workflowId');
      const { content } = getBody(c);
      await layoutService.updateWorkflow(slug, workflowId, content);
      return c.json({ success: true });
    },
  );

  // Delete workflow file
  app.delete('/:slug/workflows/:workflowId', async (c) => {
    const slug = param(c, 'slug');
    const workflowId = param(c, 'workflowId');
    await layoutService.deleteWorkflow(slug, workflowId);
    return c.json({ success: true }, 200);
  });

  return app;
}

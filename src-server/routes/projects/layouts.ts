/**
 * Layout Routes - layout and workflow management
 */

import { Hono } from 'hono';
import type { LayoutService } from '../../services/projects/layout-service.js';
import {
  errorMessage,
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
    try {
      const slug = param(c, 'slug');
      const workflows = await layoutService.listAgentWorkflows(slug);
      return c.json({ success: true, data: workflows });
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  // Get workflow file content
  app.get('/:slug/workflows/:workflowId', async (c) => {
    try {
      const slug = param(c, 'slug');
      const workflowId = param(c, 'workflowId');
      const content = await layoutService.getWorkflow(slug, workflowId);
      return c.json({ success: true, data: { content } });
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 404);
    }
  });

  // Create workflow file
  app.post('/:slug/workflows', validate(workflowCreateSchema), async (c) => {
    try {
      const slug = param(c, 'slug');
      const { filename, content } = getBody(c);
      await layoutService.createWorkflow(slug, filename, content);
      return c.json({ success: true, data: { filename } }, 201);
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 400);
    }
  });

  // Update workflow file
  app.put(
    '/:slug/workflows/:workflowId',
    validate(workflowUpdateSchema),
    async (c) => {
      try {
        const slug = param(c, 'slug');
        const workflowId = param(c, 'workflowId');
        const { content } = getBody(c);
        await layoutService.updateWorkflow(slug, workflowId, content);
        return c.json({ success: true });
      } catch (error: unknown) {
        return c.json({ success: false, error: errorMessage(error) }, 400);
      }
    },
  );

  // Delete workflow file
  app.delete('/:slug/workflows/:workflowId', async (c) => {
    try {
      const slug = param(c, 'slug');
      const workflowId = param(c, 'workflowId');
      await layoutService.deleteWorkflow(slug, workflowId);
      return c.json({ success: true }, 200);
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 400);
    }
  });

  return app;
}

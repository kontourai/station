/**
 * Layout Routes - layout and workflow management
 *
 * These handlers do not format errors. Every failure reaches the runtime HTTP
 * boundary (`configureRuntimeHttp`'s `app.onError`), which answers a thrown
 * `RouteError` with that error's own status and message and everything else
 * with the generic `{ success: false, error: { code: 'internal_error',
 * correlationId } }` at 500. This file is the first one moved onto that
 * contract; the rest follow family by family.
 *
 * The shape is "type at source, map in the route": the agent-workflow store
 * throws a domain class for each caller-caused refusal (it stays HTTP-free),
 * and {@link mapServiceError} — one mapper per route family — is the single
 * place that turns those classes into statuses. What is left over is, by
 * construction, a failure nobody classified as the caller's fault: a disk
 * error, a lock failure, a registry-integrity refusal. Those get the
 * correlated generic envelope rather than the 400 this file used to label
 * every one of them with.
 */

import { Hono } from 'hono';
import { ReservedAgentIdentityError } from '../../domain/agent-registry.js';
import {
  WorkflowExistsError,
  WorkflowInvalidError,
  WorkflowNotFoundError,
} from '../../domain/agent-workflow-errors.js';
import type { LayoutService } from '../../services/projects/layout-service.js';
import { RouteError } from '../../utils/route-error.js';
import {
  getBody,
  param,
  validate,
  workflowCreateSchema,
  workflowUpdateSchema,
} from '../schemas/schemas.js';

/**
 * The status each workflow-domain refusal deserves, and nothing else.
 *
 * Returns `undefined` for anything unrecognized so the caller rethrows it
 * unchanged: an error this mapper has not been taught about must reach the
 * boundary's generic envelope, never a guessed status. The message is the
 * domain's own — these classes exist precisely so the route does not have to
 * read it to decide — and `code` is the class's stable identity, so the same
 * refusal reads the same to every client.
 */
function mapServiceError(error: unknown): RouteError | undefined {
  if (error instanceof WorkflowNotFoundError) {
    return new RouteError(404, error.message, {
      code: error.code,
      cause: error,
    });
  }
  if (error instanceof WorkflowExistsError) {
    return new RouteError(409, error.message, {
      code: error.code,
      cause: error,
    });
  }
  if (error instanceof WorkflowInvalidError) {
    return new RouteError(400, error.message, {
      code: error.code,
      cause: error,
    });
  }
  // Not a workflow class, but reached through `mutateWorkflow`'s slug guard
  // and caller-caused in the same way: the request named a reserved agent
  // identity. 400 with its own message is what this file answered before.
  if (error instanceof ReservedAgentIdentityError) {
    return new RouteError(400, error.message, {
      code: error.code,
      cause: error,
    });
  }
  return undefined;
}

/** Rethrow as the mapped refusal, or unchanged for the boundary to contain. */
function rethrowMapped(error: unknown): never {
  throw mapServiceError(error) ?? error;
}

export function createWorkflowRoutes(layoutService: LayoutService) {
  const app = new Hono();

  // List workflow files for agent
  app.get('/:slug/workflows/files', async (c) => {
    const slug = param(c, 'slug');
    // No mapping: listing answers an empty array for a missing agent
    // directory, so every failure it can produce is a storage failure.
    const workflows = await layoutService.listAgentWorkflows(slug);
    return c.json({ success: true, data: workflows });
  });

  // Get workflow file content
  app.get('/:slug/workflows/:workflowId', async (c) => {
    const slug = param(c, 'slug');
    const workflowId = param(c, 'workflowId');
    try {
      const content = await layoutService.getWorkflow(slug, workflowId);
      return c.json({ success: true, data: { content } });
    } catch (error: unknown) {
      rethrowMapped(error);
    }
  });

  // Create workflow file
  app.post('/:slug/workflows', validate(workflowCreateSchema), async (c) => {
    const slug = param(c, 'slug');
    const { filename, content } = getBody(c);
    try {
      await layoutService.createWorkflow(slug, filename, content);
      return c.json({ success: true, data: { filename } }, 201);
    } catch (error: unknown) {
      rethrowMapped(error);
    }
  });

  // Update workflow file
  app.put(
    '/:slug/workflows/:workflowId',
    validate(workflowUpdateSchema),
    async (c) => {
      const slug = param(c, 'slug');
      const workflowId = param(c, 'workflowId');
      const { content } = getBody(c);
      try {
        await layoutService.updateWorkflow(slug, workflowId, content);
        return c.json({ success: true });
      } catch (error: unknown) {
        rethrowMapped(error);
      }
    },
  );

  // Delete workflow file
  app.delete('/:slug/workflows/:workflowId', async (c) => {
    const slug = param(c, 'slug');
    const workflowId = param(c, 'workflowId');
    try {
      await layoutService.deleteWorkflow(slug, workflowId);
      return c.json({ success: true }, 200);
    } catch (error: unknown) {
      rethrowMapped(error);
    }
  });

  return app;
}

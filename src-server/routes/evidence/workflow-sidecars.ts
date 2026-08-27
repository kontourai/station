/**
 * Workflow Sidecar Routes — project-scoped, read-only views of the durable
 * Flow Agents task sidecars (`.kontourai/flow-agents/<task-slug>/`, with
 * legacy `.flow-agents/<task-slug>/` reads) in a project workspace.
 * Mounted at /api/projects/:slug/workflow
 */

import {
  isHostedSessionReadAuthority,
  type SessionReadAuthority,
  sessionReadAuthorityFromRequest,
} from '@kontourai/station-contracts/tenancy';
import { Hono } from 'hono';
import {
  getTenantRequestContext,
  loadHostedTenantRegistryFromEnvironment,
} from '../../runtime/bootstrap/runtime-tenant-context.js';
import { workflowSidecarTaskReference } from '../../services/evidence/local-artifact-paths.js';
import {
  WorkflowSidecarInvalidError,
  WorkflowSidecarNotFoundError,
  type WorkflowSidecarService,
} from '../../services/evidence/workflow-sidecar-service.js';
import { errorMessage, param } from '../schemas/schemas.js';
import { getCachedUser } from '../system/auth.js';

export interface WorkflowSidecarRouteDeps {
  /** Resolve a project slug to its workspace path (workingDirectory). */
  getWorkspacePath: (slug: string) => string | undefined;
  /** Runtime-composed request authority; direct construction has a safe fallback. */
  getSessionReadAuthority?: (request: Request) => SessionReadAuthority;
}

function errorStatus(error: unknown): 400 | 404 | 500 {
  if (error instanceof WorkflowSidecarNotFoundError) return 404;
  if (error instanceof WorkflowSidecarInvalidError) return 400;
  return 500;
}

export function createWorkflowSidecarRoutes(
  sidecarService: WorkflowSidecarService,
  deps: WorkflowSidecarRouteDeps,
) {
  const app = new Hono<{ Variables: { cwd: string } }>();
  const hostedTenantRegistry = loadHostedTenantRegistryFromEnvironment();
  const readAuthorityFor =
    deps.getSessionReadAuthority ??
    ((request: Request) =>
      sessionReadAuthorityFromRequest(
        getCachedUser().alias,
        getTenantRequestContext(request),
        hostedTenantRegistry,
      ));
  const hostedRequest = (request: Request) =>
    isHostedSessionReadAuthority(readAuthorityFor(request));

  // Resolve the project workspace once per request.
  app.use('*', async (c, next) => {
    const slug = c.req.param('slug') ?? '';
    const cwd = deps.getWorkspacePath(slug);
    if (!cwd) {
      return c.json(
        { success: false, error: `Project workspace not found: ${slug}` },
        404,
      );
    }
    c.set('cwd', cwd);
    await next();
  });

  // List the workspace's task sidecars (GET /tasks)
  app.get('/tasks', (c) => {
    // Sidecars have no durable tenant binding. Never enumerate their local
    // task state in hosted mode before the sidecar service touches disk.
    if (hostedRequest(c.req.raw)) return c.json({ success: true, data: [] });
    try {
      const data = sidecarService.listTasks(c.get('cwd'));
      return c.json({ success: true, data });
    } catch (error: unknown) {
      return c.json(
        { success: false, error: errorMessage(error) },
        errorStatus(error),
      );
    }
  });

  // Read one task's durable state + handoff (GET /tasks/:taskSlug)
  app.get('/tasks/:taskSlug', (c) => {
    if (hostedRequest(c.req.raw)) {
      return c.json(
        { success: false, error: 'Workflow sidecar not found' },
        404,
      );
    }
    try {
      const taskSlug = param(c, 'taskSlug');
      const cwd = c.get('cwd');
      const state = sidecarService.readState(cwd, taskSlug);
      if (!state) {
        return c.json(
          {
            success: false,
            error: `No workflow sidecar for task: ${taskSlug}`,
          },
          404,
        );
      }
      const handoff = sidecarService.readHandoff(cwd, taskSlug);
      return c.json({
        success: true,
        data: {
          taskSlug,
          state,
          handoff,
          path: workflowSidecarTaskReference(taskSlug),
        },
      });
    } catch (error: unknown) {
      return c.json(
        { success: false, error: errorMessage(error) },
        errorStatus(error),
      );
    }
  });

  return app;
}

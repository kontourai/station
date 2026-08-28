/**
 * Work Item Provider Routes — project-scoped provider seam (roadmap archive#583,
 * part of epic archive#580, S3). Mounted at /api/projects/:slug/work-items.
 * Read-only this slice; aggregates every registered backend and never
 * fails the request for a backend's own absence (see
 * `WorkItemProviderService`).
 */
import { join } from 'node:path';
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
import type { AssignmentClaimService } from '../../services/evidence/assignment-claim-service.js';
import type { WorkItemProviderService } from '../../services/projects/work-item-provider-service.js';
import { errorMessage } from '../schemas/schemas.js';
import { getCachedUser } from '../system/auth.js';

export interface WorkItemRouteDeps {
  /** Resolve a project slug to its workspace path (workingDirectory). */
  getWorkspacePath: (slug: string) => string | undefined;
  /**
   * Runtime composition may supply the request-scoped authority it already
   * minted from trusted ingress. The fallback preserves the same fail-closed
   * hosted semantics for direct route construction.
   */
  getSessionReadAuthority?: (request: Request) => SessionReadAuthority;
  /**
   * AssignmentProvider claim status reader (roadmap archive#584, part of epic
   * archive#580, S4). Optional — when absent, `/claim` always reports
   * `'unavailable'` rather than 404ing, matching the never-throws
   * degradation the rest of this seam already follows.
   */
  assignmentClaimService?: Pick<AssignmentClaimService, 'status'>;
}

export function createWorkItemRoutes(
  workItemProviderService: WorkItemProviderService,
  deps: WorkItemRouteDeps,
) {
  const app = new Hono<{ Variables: { cwd: string; slug: string } }>();
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
    c.set('slug', slug);
    await next();
  });

  app.get('/', async (c) => {
    // Local TaskGraph work items and the claim sidecar are global stores. The
    // provider aggregate cannot soundly remove only those rows, so hosted
    // callers receive an empty route family before any provider is queried.
    if (hostedRequest(c.req.raw)) {
      return c.json({ success: true, data: { providers: [] } });
    }
    try {
      const data = await workItemProviderService.listWorkItems({
        projectId: c.get('slug'),
        workingDirectory: c.get('cwd'),
      });
      return c.json({ success: true, data });
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  /**
   * Generic AssignmentProvider claim read (roadmap archive#584, part of epic archive#580,
   * S4) — for a local task's `workItemRef` or a raw `ProviderWorkItem
   * .workItemRef` from any backend, since the claim is keyed by subject id,
   * not by which backend rendered the row. The caller derives "claimed by
   * me" by comparing `actor.sessionId` against a specific task's own
   * `sessionId`; this endpoint has no task context of its own.
   */
  app.get('/claim', async (c) => {
    if (hostedRequest(c.req.raw)) {
      return c.json({ success: false, error: 'Work item not found' }, 404);
    }
    const subjectId = c.req.query('subjectId');
    if (!subjectId) {
      return c.json({ success: false, error: 'subjectId is required' }, 400);
    }
    if (!deps.assignmentClaimService) {
      return c.json({
        success: true,
        data: {
          subjectId,
          state: 'unavailable',
          reason: 'assignment claim service not configured',
        },
      });
    }
    try {
      const artifactRoot = join(c.get('cwd'), '.kontourai', 'flow-agents');
      const result = await deps.assignmentClaimService.status({
        artifactRoot,
        subjectId,
      });
      if (result.outcome === 'unavailable') {
        return c.json({
          success: true,
          data: { subjectId, state: 'unavailable', reason: result.reason },
        });
      }
      if (result.outcome === 'free') {
        return c.json({ success: true, data: { subjectId, state: 'free' } });
      }
      return c.json({
        success: true,
        data: {
          subjectId,
          state: 'claimed',
          actor: {
            runtime: result.actor.runtime,
            sessionId: result.actor.session_id,
            host: result.actor.host,
            human: result.actor.human ?? null,
          },
        },
      });
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  return app;
}

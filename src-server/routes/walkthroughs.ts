import { WALKTHROUGH_LIMITS } from '@kontourai/station-contracts/walkthrough';
import { type Context, Hono } from 'hono';
import { stationControlRequestAuthority } from '../security/station-control-request-authority.js';
import type { BrowserProjectAuthorizer } from '../services/browser/browser-access.js';
import {
  FeaturePreviewDisabledError,
  requireFeaturePreview,
} from '../services/feature-previews/feature-preview-refusal.js';
import type { FeaturePreviewSelector } from '../services/feature-previews/feature-preview-registry.js';
import type { ActionOperationActor } from '../services/operations/action-operation-service.js';
import {
  WalkthroughImportError,
  type WalkthroughService,
} from '../services/walkthroughs/walkthrough-service.js';
import { errorMessage } from './schemas/schemas.js';

export interface WalkthroughRouteDependencies {
  service: WalkthroughService;
  preview: FeaturePreviewSelector;
  project(slug: string): { id: string } | undefined;
  authorize: BrowserProjectAuthorizer;
  actor(request: Request): ActionOperationActor;
  diagnostic(error: unknown): void;
}
/** Upload is the raw video body; filename and idempotency id are explicit metadata. */
export function createWalkthroughRoutes(deps: WalkthroughRouteDependencies) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  const authorized = async (c: Context, purpose: 'view' | 'drive') => {
    const slug = c.req.param('projectSlug')!;
    const project = deps.project(slug);
    const request = c.req.raw;
    const assertCurrent = async () => {
      if (!project || deps.project(slug)?.id !== project.id)
        throw new WalkthroughImportError('Project not found', 404);
      const control = stationControlRequestAuthority(request);
      if (
        control?.kind === 'caller-less' ||
        (control?.kind === 'caller' &&
          (!control.caller.principal?.elevationEligible ||
            (!control.boundOperator &&
              (control.caller.projectIdSource !== 'session-record' ||
                control.caller.localProjectId !== project.id))))
      )
        throw new WalkthroughImportError('Project access refused', 403);
      if (!(await deps.authorize(request, project.id, purpose)))
        throw new WalkthroughImportError('Project access refused', 403);
    };
    await assertCurrent();
    return { slug, assertCurrent };
  };
  const failure = (c: Context, error: unknown) => {
    if (error instanceof FeaturePreviewDisabledError)
      return c.json(error.refusal, 404);
    if (error instanceof WalkthroughImportError)
      return c.json(
        { success: false, error: errorMessage(error) },
        error.status,
      );
    deps.diagnostic(error);
    return c.json(
      { success: false, error: 'Walkthrough storage or import unavailable' },
      503,
    );
  };
  app.post('/import', async (c) => {
    try {
      requireFeaturePreview(deps.preview, 'walkthroughs', 'Walkthroughs');
      const { slug, assertCurrent } = await authorized(c, 'drive');
      const length = c.req.header('content-length');
      if (
        length !== undefined &&
        (!/^\d+$/.test(length) ||
          Number(length) > WALKTHROUGH_LIMITS.uploadBytes)
      )
        throw new WalkthroughImportError(
          'Video exceeds 512 MiB upload limit',
          413,
        );
      if (!c.req.raw.body)
        throw new WalkthroughImportError('Video body required', 400);
      const status = await deps.service.start({
        projectSlug: slug,
        requestId: c.req.header('x-walkthrough-request-id') ?? '',
        originalName: c.req.query('filename') ?? '',
        body: c.req.raw.body,
        signal: c.req.raw.signal,
        actor: deps.actor(c.req.raw),
        authorize: async () => {
          requireFeaturePreview(deps.preview, 'walkthroughs', 'Walkthroughs');
          await assertCurrent();
        },
      });
      return c.json({ success: true, data: status }, 202);
    } catch (error) {
      return failure(c, error);
    }
  });
  app.get('/imports/:requestId', async (c) => {
    try {
      requireFeaturePreview(deps.preview, 'walkthroughs', 'Walkthroughs');
      const { slug, assertCurrent } = await authorized(c, 'view');
      const status = await deps.service.status(
        slug,
        c.req.param('requestId'),
        deps.actor(c.req.raw),
      );
      await assertCurrent();
      return status
        ? c.json({ success: true, data: status })
        : c.json({ success: false, error: 'Import not found' }, 404);
    } catch (error) {
      return failure(c, error);
    }
  });
  app.get('/', async (c) => {
    try {
      requireFeaturePreview(deps.preview, 'walkthroughs', 'Walkthroughs');
      const { slug, assertCurrent } = await authorized(c, 'view');
      const data = await deps.service.list(
        slug,
        c.req.query('limit') === undefined ? 25 : Number(c.req.query('limit')),
        c.req.query('cursor'),
      );
      await assertCurrent();
      return c.json({ success: true, data });
    } catch (error) {
      return failure(c, error);
    }
  });
  app.get('/:id/frames/:frameId', async (c) => {
    try {
      requireFeaturePreview(deps.preview, 'walkthroughs', 'Walkthroughs');
      const { slug, assertCurrent } = await authorized(c, 'view');
      const bytes = await deps.service.frame(
        slug,
        c.req.param('id'),
        c.req.param('frameId'),
      );
      await assertCurrent();
      return bytes
        ? new Response(new Uint8Array(bytes), {
            headers: {
              'Content-Type': 'image/jpeg',
              'Cache-Control': 'no-store',
              'X-Content-Type-Options': 'nosniff',
            },
          })
        : c.json({ success: false, error: 'Frame not found' }, 404);
    } catch (error) {
      return failure(c, error);
    }
  });
  app.get('/:id', async (c) => {
    try {
      requireFeaturePreview(deps.preview, 'walkthroughs', 'Walkthroughs');
      const { slug, assertCurrent } = await authorized(c, 'view');
      const data = await deps.service.get(slug, c.req.param('id'));
      await assertCurrent();
      return data
        ? c.json({ success: true, data })
        : c.json({ success: false, error: 'Walkthrough not found' }, 404);
    } catch (error) {
      return failure(c, error);
    }
  });
  return app;
}

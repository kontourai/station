import { parseSessionGoalCommand } from '@kontourai/station-contracts/session-goal';
import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import { type Context, Hono } from 'hono';
import type { ProviderAdapterShape } from '../../providers/adapter-shape.js';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';
import type { FeaturePreviewSelector } from '../../services/feature-previews/feature-preview-registry.js';
import type { OrchestrationService } from '../../services/orchestration/orchestration-service.js';
import { SessionGoalModule } from '../../services/orchestration/session-goal-module.js';

export function createSessionGoalRoutes(deps: {
  orchestration: Pick<
    OrchestrationService,
    'canUserReadSession' | 'canUserMutateSession'
  > & {
    liveSessionGoalAdapter(
      id: string,
    ): Pick<ProviderAdapterShape, 'goals'> | undefined;
  };
  preview: FeaturePreviewSelector;
  authority(request: Request): SessionReadAuthority;
  current(request: Request): boolean;
  person(request: Request): boolean;
}) {
  const app = new Hono();
  const goals = new SessionGoalModule((id) =>
    deps.orchestration.liveSessionGoalAdapter(id),
  );
  const enabled = () =>
    deps.preview.select({ enabled: () => true, disabled: () => false });
  const disabled = (c: Context) =>
    c.json(
      {
        success: false,
        code: 'feature_preview_disabled',
        error: 'Enable Session goals in Feature previews.',
        previewId: 'session-goals',
        settingsPath:
          '/settings?view=feature-previews&highlight=feature-previews',
      },
      404,
    );
  const unavailable = (c: Context) =>
    c.json({ success: false, error: 'Session goals unavailable' }, 404);
  const access = (request: Request, id: string) => {
    const authority = deps.authority(request);
    return {
      current: () => deps.current(request) && enabled(),
      canRead: () => deps.orchestration.canUserReadSession(id, authority),
      canControl: () =>
        deps.person(request) &&
        deps.orchestration.canUserMutateSession(
          id,
          authority.userId,
          authority.tenantExecutionContext,
        ),
    };
  };

  app.get('/sessions/:threadId/goal', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    if (!enabled()) return disabled(c);
    if (!deps.current(c.req.raw)) return unavailable(c);
    const id = c.req.param('threadId');
    const data = await goals.read(id, access(c.req.raw, id));
    return data ? c.json({ success: true, data }) : unavailable(c);
  });

  app.post('/sessions/:threadId/goal', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    if (!enabled()) return disabled(c);
    if (!deps.current(c.req.raw) || !deps.person(c.req.raw))
      return unavailable(c);
    const read = await readBoundedRequestBody(c.req.raw, 32_768);
    if (read.status !== 'ok')
      return c.json({ success: false, error: 'Goal command too large' }, 413);
    let body: unknown;
    try {
      body = JSON.parse(read.body);
    } catch {
      return c.json({ success: false, error: 'Invalid goal command' }, 400);
    }
    const command = parseSessionGoalCommand(body);
    if (!command)
      return c.json({ success: false, error: 'Invalid goal command' }, 400);
    const id = c.req.param('threadId');
    const data = await goals.control(id, command, access(c.req.raw, id));
    return data ? c.json({ success: true, data }) : unavailable(c);
  });
  return app;
}

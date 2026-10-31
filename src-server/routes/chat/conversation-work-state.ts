import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod/v3';
import type { FeaturePreviewSelector } from '../../services/feature-previews/feature-preview-registry.js';
import {
  conversationAcknowledgementKey,
  type IsOwnerDevice,
} from '../../services/orchestration/conversation-acknowledgement-store.js';
import type { ConversationWorkStateStore } from '../../services/orchestration/conversation-work-state-store.js';

const change = z.object({ settled: z.boolean() }).strict();
/** Preview-only personal inbox resolution; every write rechecks conversation admission. */
export function createConversationWorkStateRoutes(deps: {
  store: Pick<ConversationWorkStateStore, 'read' | 'set'>;
  preview: FeaturePreviewSelector;
  authorityFor(request: Request): SessionReadAuthority;
  isOwnerDevice: IsOwnerDevice;
  canRead(
    conversationId: string,
    authority: SessionReadAuthority,
  ): Promise<boolean>;
  current(request: Request): boolean;
}) {
  const app = new Hono();
  const guard: MiddlewareHandler = async (c, next) => {
    const enabled = deps.preview.select({
      enabled: () => true,
      disabled: () => false,
    });
    if (!enabled)
      return c.json(
        {
          success: false,
          code: 'feature_preview_disabled',
          previewId: 'conversation-resolution',
          settingsPath:
            '/settings?view=feature-previews&highlight=feature-previews',
          error:
            'Enable Open and Settled inbox in Settings → Advanced → Feature previews.',
        },
        404,
      );
    if (!deps.current(c.req.raw))
      return c.json(
        { success: false, error: 'Request authority expired' },
        403,
      );
    return next();
  };
  app.use('/work-state', guard);
  app.use('/:conversationId/work-state', guard);
  const person = (request: Request) =>
    conversationAcknowledgementKey(
      deps.authorityFor(request),
      deps.isOwnerDevice,
    );
  app.get('/work-state', (c) => {
    const key = person(c.req.raw);
    if (!key)
      return c.json(
        { success: false, error: 'A person credential is required' },
        403,
      );
    c.header('Cache-Control', 'private, no-store');
    return c.json({ success: true, data: { settled: deps.store.read(key) } });
  });
  app.put('/:conversationId/work-state', async (c) => {
    const key = person(c.req.raw);
    if (!key)
      return c.json(
        { success: false, error: 'A person credential is required' },
        403,
      );
    const id = c.req.param('conversationId');
    if (!id || id.length > 512)
      return c.json(
        { success: false, error: 'Invalid conversation identity' },
        400,
      );
    const parsed = change.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { success: false, error: 'settled must be a boolean' },
        400,
      );
    if (!(await deps.canRead(id, deps.authorityFor(c.req.raw))))
      return c.json({ success: false, error: 'Conversation not found' }, 404);
    if (!deps.current(c.req.raw) || c.req.raw.signal.aborted)
      return c.json(
        { success: false, error: 'Request authority expired' },
        403,
      );
    deps.store.set(key, id, parsed.data.settled, new Date().toISOString());
    return c.json({ success: true });
  });
  return app;
}

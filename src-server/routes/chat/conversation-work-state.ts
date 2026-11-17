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
const hiding = z.object({ hidden: z.boolean() }).strict();
/**
 * Preview-only personal inbox resolution; every write rechecks conversation
 * admission. A third-party Session is not settled but hidden, by its thread
 * id, behind the same person key and Session read check.
 */
export function createConversationWorkStateRoutes(deps: {
  store: Pick<
    ConversationWorkStateStore,
    'read' | 'set' | 'readHidden' | 'setHidden'
  >;
  preview: FeaturePreviewSelector;
  authorityFor(request: Request): SessionReadAuthority;
  isOwnerDevice: IsOwnerDevice;
  canRead(
    conversationId: string,
    authority: SessionReadAuthority,
  ): Promise<boolean>;
  canReadSession(sessionId: string, authority: SessionReadAuthority): boolean;
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
  app.use('/:id/work-state', guard);
  app.use('/:id/inbox-hidden', guard);
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
    return c.json({
      success: true,
      data: {
        settled: deps.store.read(key),
        hidden: deps.store.readHidden(key),
      },
    });
  });
  app.put('/:id/work-state', async (c) => {
    const key = person(c.req.raw);
    if (!key)
      return c.json(
        { success: false, error: 'A person credential is required' },
        403,
      );
    const id = c.req.param('id');
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
  app.put('/:id/inbox-hidden', async (c) => {
    const key = person(c.req.raw);
    if (!key)
      return c.json(
        { success: false, error: 'A person credential is required' },
        403,
      );
    const id = c.req.param('id');
    if (!id || id.length > 512)
      return c.json({ success: false, error: 'Invalid session identity' }, 400);
    const parsed = hiding.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ success: false, error: 'hidden must be a boolean' }, 400);
    if (!deps.canReadSession(id, deps.authorityFor(c.req.raw)))
      return c.json({ success: false, error: 'Session not found' }, 404);
    if (!deps.current(c.req.raw) || c.req.raw.signal.aborted)
      return c.json(
        { success: false, error: 'Request authority expired' },
        403,
      );
    deps.store.setHidden(key, id, parsed.data.hidden, new Date().toISOString());
    return c.json({ success: true });
  });
  return app;
}

import type { HtmlReplyReference } from '@kontourai/station-contracts/html-reply';
import { HTML_REPLY_LIMITS } from '@kontourai/station-contracts/html-reply';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger({ name: 'html-replies' });

import { readBoundedRequestBody } from '../../security/bounded-request-body.js';
import { prepareHtmlReply } from '../../services/html-replies.js';
import { HtmlReplyRefusal } from '../../services/html-reply-errors.js';
import type { createHtmlReplyPages } from '../../services/orchestration/html-reply-pages.js';
import type { StationControlCaller } from '../../tools/station-control-shared.js';

const htmlReplyInput = z
  .object({
    html: z.string().max(HTML_REPLY_LIMITS.sourceBytes),
    height: z.number().int().min(100).max(2000).default(500),
    width: z.number().int().min(320).max(1920).default(1024),
    theme: z.enum(['light', 'dark']).default('dark'),
  })
  .strict();

export function createHtmlReplyRoutes(deps: {
  pages: ReturnType<typeof createHtmlReplyPages>;
  isInternalRequest(request: Request): boolean;
  resolveCaller(request: Request): StationControlCaller | null;
  sessionContext(
    sessionId: string,
  ): { conversationId: string; cwd: string } | undefined;
  frameOrigin?(): string | undefined;
  canReadSession(sessionId: string, request: Request): boolean;
  preview(
    page: { html: string; height: number },
    width: number,
    theme: 'light' | 'dark',
  ): Promise<unknown>;
}) {
  const app = new Hono();
  const run = (operation: 'render' | 'preview') => async (c: Context) => {
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    if (!deps.isInternalRequest(c.req.raw))
      return c.json({ success: false, error: 'Not found' }, 404);
    const caller = deps.resolveCaller(c.req.raw);
    const owner = caller && deps.sessionContext(caller.sessionId);
    if (!caller || !owner)
      return c.json(
        {
          success: false,
          error: 'A live conversation-bound caller is required',
        },
        403,
      );
    const body = await readBoundedRequestBody(
      c.req.raw,
      HTML_REPLY_LIMITS.sourceBytes * 6 + 4096,
    );
    if (body.status !== 'ok')
      return c.json(
        {
          success: false,
          error: 'HTML reply body exceeds its limit or is invalid',
        },
        413,
      );
    try {
      const input = htmlReplyInput.parse(JSON.parse(body.body));
      const page = await prepareHtmlReply(input, owner.cwd);
      if (
        !deps.resolveCaller(c.req.raw) ||
        !deps.sessionContext(caller.sessionId)
      )
        return c.json(
          { success: false, error: 'HTML reply caller is no longer current' },
          403,
        );
      if (operation === 'preview')
        return c.json({
          success: true,
          data: await deps.preview(page, input.width, input.theme),
        });
      return c.json({
        success: true,
        htmlReply: deps.pages.publish(
          caller.sessionId,
          owner.conversationId,
          page,
        ),
      });
    } catch (error) {
      logger.warn('HTML reply preparation or rendering failed', { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof HtmlReplyRefusal
              ? error.reason
              : error instanceof z.ZodError || error instanceof SyntaxError
                ? 'Invalid HTML reply input'
                : 'HTML reply could not be prepared or rendered. Check workspace images and Chromium availability.',
        },
        400,
      );
    }
  };
  app.post('/render', run('render'));
  app.post('/preview', run('preview'));
  app.get('/:sessionId/:pageId', (c) => {
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    const sessionId = c.req.param('sessionId');
    const pageId = c.req.param('pageId');
    if (
      !z.string().uuid().safeParse(pageId).success ||
      !deps.canReadSession(sessionId, c.req.raw)
    )
      return c.json({ success: false, error: 'Page not found' }, 404);
    const reference: HtmlReplyReference = { version: 1, sessionId, pageId };
    const page = deps.pages.read(reference);
    return page
      ? c.json({ success: true, data: page, frameOrigin: deps.frameOrigin?.() })
      : c.json({ success: false, error: 'Page not found' }, 404);
  });
  return app;
}

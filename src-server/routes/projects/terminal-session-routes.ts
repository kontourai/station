import { Hono } from 'hono';
import { z } from 'zod/v3';
import { TerminalOutputSanitizer } from '../../services/terminal/terminal-output-sanitizer.js';
import {
  TerminalSessionRefusal,
  type TerminalSessions,
} from '../../services/terminal/terminal-sessions.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger({ name: 'terminal-session-routes' });
const binding = z.string().min(1).max(512).default('project');
const dimensions = {
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000),
};
const openSchema = z
  .object({
    ...dimensions,
    bindingKey: binding,
    subdirectory: z.string().max(4096).optional(),
    legacyTerminalId: z.string().min(1).max(256).optional(),
  })
  .strict();

/** A bounded HTTP control seam; the SDK socket replaces polling in #3994(b). */
export function createTerminalSessionRoutes(
  sessions: TerminalSessions<Request>,
  projectId: (slug: string) => string,
  authorizeRequest: (request: Request) => boolean,
) {
  const app = new Hono();
  app.use('/:slug/terminal-sessions/*', async (c, next) => {
    if (!authorizeRequest(c.req.raw))
      return c.json({ success: false, error: 'Terminal access refused' }, 403);
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof z.ZodError)
      return c.json({ success: false, error: 'Invalid terminal request' }, 400);
    if (error instanceof TerminalSessionRefusal)
      return c.json({ success: false, error: 'Terminal access refused' }, 403);
    logger.error('Terminal session operation failed', { error });
    return c.json(
      { success: false, error: 'Terminal session unavailable' },
      503,
    );
  });
  const scope = (slug: string, bindingKey: string) => ({
    projectId: projectId(slug),
    bindingKey,
  });

  app.post('/:slug/terminal-sessions', async (c) => {
    const input = openSchema.parse(await c.req.json());
    const slug = c.req.param('slug');
    const result = await sessions.open(
      c.req.raw,
      scope(slug, input.bindingKey),
      {
        cols: input.cols,
        rows: input.rows,
        subdirectory: input.subdirectory,
        ...(input.legacyTerminalId && {
          legacy: { projectSlug: slug, terminalId: input.legacyTerminalId },
        }),
      },
    );
    return c.json({ success: true, data: result });
  });
  app.get('/:slug/terminal-sessions', async (c) => {
    const result = await sessions.list(
      c.req.raw,
      scope(c.req.param('slug'), binding.parse(c.req.query('bindingKey'))),
    );
    return c.json({ success: true, data: result });
  });
  app.get('/:slug/terminal-sessions/:terminalId', async (c) => {
    const fromSeq = z.coerce
      .number()
      .int()
      .nonnegative()
      .safe()
      .parse(c.req.query('fromSeq') ?? 0);
    const result = await sessions.read(
      c.req.raw,
      scope(c.req.param('slug'), binding.parse(c.req.query('bindingKey'))),
      z.string().uuid().parse(c.req.param('terminalId')),
      fromSeq,
      64 * 1024 + 2048,
    );
    const bytes = result.journal.records.reduce(
      (sum, record) => sum + Buffer.byteLength(record.data),
      0,
    );
    if (
      bytes > 64 * 1024 ||
      (result.journal.records.at(-1)?.seq ?? fromSeq) < result.journal.lastSeq
    )
      return c.json(
        {
          success: false,
          error:
            'Terminal replay exceeds HTTP read bound; use the terminal socket',
        },
        413,
      );
    const filter = new TerminalOutputSanitizer(['http:', 'https:']);
    return c.json({
      success: true,
      data: {
        ...result,
        journal: {
          ...result.journal,
          records: result.journal.records.map((record) => ({
            ...record,
            data: filter.append(record.data),
          })),
        },
      },
    });
  });
  app.post('/:slug/terminal-sessions/:terminalId/input', async (c) => {
    const input = z
      .object({ bindingKey: binding, data: z.string().max(64 * 1024) })
      .strict()
      .parse(await c.req.json());
    await sessions.write(
      c.req.raw,
      scope(c.req.param('slug'), input.bindingKey),
      z.string().uuid().parse(c.req.param('terminalId')),
      input.data,
    );
    return c.json({ success: true });
  });
  app.post('/:slug/terminal-sessions/:terminalId/resize', async (c) => {
    const input = z
      .object({ bindingKey: binding, ...dimensions })
      .strict()
      .parse(await c.req.json());
    await sessions.resize(
      c.req.raw,
      scope(c.req.param('slug'), input.bindingKey),
      z.string().uuid().parse(c.req.param('terminalId')),
      input.cols,
      input.rows,
    );
    return c.json({ success: true });
  });
  app.delete('/:slug/terminal-sessions/:terminalId', async (c) => {
    await sessions.close(
      c.req.raw,
      scope(c.req.param('slug'), binding.parse(c.req.query('bindingKey'))),
      z.string().uuid().parse(c.req.param('terminalId')),
    );
    return c.json({ success: true });
  });
  return app;
}

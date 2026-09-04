import type { WorkspacePaneHostActionPrepareRequest } from '@kontourai/station-contracts/workspace-pane-host-contribution';
import { type Context, Hono } from 'hono';
import { z } from 'zod/v3';
import type {
  createWorkspacePaneHostActions,
  WorkspacePaneHostActionActor,
} from '../../services/plugins/workspace-pane-host-actions.js';
import { getBody, param, validate } from '../schemas/schemas.js';

const cleanId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const prepareSchema = z
  .object({
    pluginId: cleanId,
    installationGeneration: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    actionKey: z.string().regex(/^plugin-host-action:[a-f0-9]{64}$/),
    selectedAgent: z
      .object({
        kind: z.enum(['own-plugin-agent', 'station-agent']),
        agentId: cleanId,
      })
      .strict()
      .optional(),
  })
  .strict();
const executeSchema = z
  .object({ ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
  .strict();

/** Same ingress principal and operate scope as foreground chat, never a plugin credential. */
export function createWorkspacePaneHostActionRoutes(input: {
  service: ReturnType<typeof createWorkspacePaneHostActions>;
  actorFor(context: Context): WorkspacePaneHostActionActor;
}) {
  const app = new Hono();
  app.get('/:projectSlug/catalog', async (c) => {
    try {
      input.actorFor(c);
      return c.json({
        success: true,
        data: await input.service.catalog(param(c, 'projectSlug')),
      });
    } catch {
      return c.json(
        { success: false, error: 'Workspace actions are unavailable.' },
        503,
      );
    }
  });
  app.post(
    '/:projectSlug/prepare',
    validate(prepareSchema, { maxBodyBytes: 2048 }),
    async (c) => {
      try {
        const data = await input.service.prepare(
          input.actorFor(c),
          param(c, 'projectSlug'),
          getBody(c) as WorkspacePaneHostActionPrepareRequest,
        );
        return c.json({ success: true, data });
      } catch {
        return c.json(
          {
            success: false,
            error: 'Workspace action preparation is unavailable.',
          },
          503,
        );
      }
    },
  );
  app.post(
    '/:projectSlug/execute',
    validate(executeSchema, { maxBodyBytes: 512 }),
    async (c) => {
      try {
        const data = await input.service.execute(
          input.actorFor(c),
          param(c, 'projectSlug'),
          getBody(c).ticket,
        );
        return c.json({ success: true, data });
      } catch {
        return c.json({ success: true, data: { state: 'indeterminate' } });
      }
    },
  );
  return app;
}

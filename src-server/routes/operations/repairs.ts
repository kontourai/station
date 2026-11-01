import { AUTOMATION_ACTION_KINDS } from '@kontourai/station-contracts/automation';
import { Hono } from 'hono';
import { z } from 'zod';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';
import type { IsolatedRepairController } from '../../services/automation/repair-controller.js';
import type { RepairOperator } from '../../services/automation/repair-store.js';

/** Personal operator API. No MCP tool, unattended caller, or hosted tenant can grant publication. */
export function createIsolatedRepairRoutes(options: {
  controller?: IsolatedRepairController;
  operator(request: Request): Promise<RepairOperator>;
}) {
  const app = new Hono();
  const id = z.string().uuid();
  const digest = z.string().regex(/^[a-f0-9]{64}$/);
  const review = z
    .object({
      bindingDigest: digest,
      resultDigest: digest,
      verdict: z.enum(['approve', 'reject']),
      rationale: z.string().trim().min(1).max(4096),
    })
    .strict();
  const grant = z
    .object({
      bindingDigest: digest,
      resultDigest: digest,
      reviewId: id,
      publisherId: id,
    })
    .strict();
  const publish = z.object({ grantId: id }).strict();
  const setupOperator = async (request: Request): Promise<RepairOperator> => {
    const operator = await options.operator(request);
    return {
      id: operator.id,
      assertCurrent: async () => {
        await operator.assertCurrent();
        if (!options.controller?.enabled())
          throw new Error('repair-authority-unavailable');
      },
    };
  };
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (!options.controller)
      return c.json(
        {
          success: false,
          error: 'Isolated repairs not supported on this host',
        },
        404,
      );
    try {
      await options.operator(c.req.raw);
    } catch {
      return c.json({ success: false, error: 'Operator access required' }, 403);
    }
    const maintenance =
      c.req.method === 'GET' ||
      /\/(revoke|cancel|followup|resolve|archive|enable)$/.test(c.req.path);
    if (!maintenance && !options.controller.enabled())
      return c.json(
        {
          success: false,
          error:
            'Enable Isolated GitHub repairs in Settings → Advanced → Feature previews.',
          code: 'feature_preview_disabled',
          previewId: 'isolated-github-repairs',
          settingsPath:
            '/settings?view=feature-previews&highlight=feature-previews',
        },
        404,
      );
    await next();
  });
  app.onError((error, c) =>
    c.json(
      {
        success: false,
        error:
          error instanceof z.ZodError
            ? 'Invalid isolated repair request'
            : 'Isolated repair operation refused or unavailable',
      },
      error instanceof z.ZodError ? 400 : 409,
    ),
  );
  const body = async (request: Request): Promise<unknown> => {
    const bounded = await readBoundedRequestBody(request, 16_384);
    if (bounded.status !== 'ok') throw new z.ZodError([]);
    try {
      return JSON.parse(bounded.body);
    } catch {
      throw new z.ZodError([]);
    }
  };
  app.get('/', async (c) => {
    const operator = await options.operator(c.req.raw);
    const data = options.controller!.list();
    await operator.assertCurrent();
    return c.json({ success: true, data });
  });
  app.get('/configuration', async (c) => {
    const operator = await options.operator(c.req.raw);
    const data = options.controller!.automationConfiguration();
    await operator.assertCurrent();
    return c.json({ success: true, data });
  });
  app.post('/sources', async (c) => {
    const input = z
      .object({
        kind: z.literal('github-poll'),
        name: z.string().min(1).max(128),
        repository: z.string().min(1).max(200),
        credentialSecretBinding: z.string().min(1).max(128).optional(),
        pollIntervalMs: z.number().int().positive().optional(),
        grants: z
          .array(
            z
              .object({
                projectId: z.string().min(1).max(128),
                agentId: z.string().min(1).max(128),
                actions: z.array(z.enum(AUTOMATION_ACTION_KINDS)),
              })
              .strict(),
          )
          .max(32)
          .optional(),
      })
      .strict()
      .parse(await body(c.req.raw));
    return c.json({
      success: true,
      data: await options.controller!.createSource(
        input,
        await options.operator(c.req.raw),
      ),
    });
  });
  app.post('/rules', async (c) => {
    const matcher = z
      .object({
        type: z.literal('github.workflow_run.completed'),
        where: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
      })
      .strict();
    const input = z
      .object({
        name: z.string().min(1).max(128),
        sourceId: id,
        match: matcher,
        episode: z
          .object({
            keyFields: z.array(z.string()),
            closeOn: matcher.optional(),
            maxAttempts: z.number().int().positive(),
          })
          .strict(),
        action: z
          .object({
            kind: z.literal('isolated-repair'),
            projectId: z.string().min(1).max(128),
            agentId: z.string().min(1).max(128),
            profileId: id,
            instructions: z.string().min(1).max(8192),
            budget: z
              .object({
                maxProviderRequests: z.number().int().min(1).max(128),
                maxWallRuntimeMs: z.number().int().min(1).max(3_600_000),
              })
              .strict(),
          })
          .strict(),
        rateLimit: z
          .object({ maxStartsPerHour: z.number().int().positive() })
          .strict(),
      })
      .strict()
      .parse(await body(c.req.raw));
    return c.json({
      success: true,
      data: await options.controller!.createRule(
        input,
        await options.operator(c.req.raw),
      ),
    });
  });
  app.post('/configuration/enable', async (c) => {
    const input = z
      .object({
        kind: z.enum(['source', 'rule']),
        id,
        expectedFingerprint: digest,
        enabled: z.boolean(),
      })
      .strict()
      .parse(await body(c.req.raw));
    await options.controller!.enableAutomation(
      input,
      await options.operator(c.req.raw),
    );
    return c.json({ success: true });
  });
  app.get('/profiles', async (c) => {
    const operator = await options.operator(c.req.raw);
    const data = options.controller!.store.profileProjections();
    await operator.assertCurrent();
    return c.json({ success: true, data });
  });
  app.post('/profiles', async (c) =>
    c.json({
      success: true,
      data: await options.controller!.store.configure(
        await body(c.req.raw),
        await setupOperator(c.req.raw),
      ),
    }),
  );
  app.post('/profiles/:id/enable', async (c) => {
    const input = z
      .object({
        expectedRevision: z.number().int().positive(),
        enabled: z.boolean(),
      })
      .strict()
      .parse(await body(c.req.raw));
    await options.controller!.store.setEnabled(
      id.parse(c.req.param('id')),
      input.expectedRevision,
      input.enabled,
      await (input.enabled
        ? setupOperator(c.req.raw)
        : options.operator(c.req.raw)),
    );
    return c.json({ success: true });
  });
  app.get('/:run/artifact', async (c) =>
    c.json({
      success: true,
      data: await options.controller!.artifact(
        id.parse(c.req.param('run')),
        await options.operator(c.req.raw),
      ),
    }),
  );
  app.post('/:run/review', async (c) =>
    c.json({
      success: true,
      data: await options.controller!.review(
        id.parse(c.req.param('run')),
        review.parse(await body(c.req.raw)),
        await options.operator(c.req.raw),
      ),
    }),
  );
  app.post('/:run/grant', async (c) =>
    c.json({
      success: true,
      data: await options.controller!.grant(
        id.parse(c.req.param('run')),
        grant.parse(await body(c.req.raw)),
        await options.operator(c.req.raw),
      ),
    }),
  );
  app.post('/:run/publish', async (c) =>
    c.json({
      success: true,
      data: await options.controller!.publish(
        id.parse(c.req.param('run')),
        publish.parse(await body(c.req.raw)).grantId,
        await options.operator(c.req.raw),
      ),
    }),
  );
  app.post('/:run/revoke', async (c) => {
    z.object({})
      .strict()
      .parse(await body(c.req.raw));
    await options.controller!.revoke(
      id.parse(c.req.param('run')),
      await options.operator(c.req.raw),
    );
    return c.json({ success: true });
  });
  app.post('/:run/followup', async (c) => {
    const input = z
      .object({ rationale: z.string().trim().min(1).max(4096) })
      .strict()
      .parse(await body(c.req.raw));
    return c.json({
      success: true,
      data: await options.controller!.followup(
        id.parse(c.req.param('run')),
        input.rationale,
        await options.operator(c.req.raw),
      ),
    });
  });
  app.post('/:run/resolve', async (c) => {
    const input = z
      .object({
        acknowledgeUnknownEffects: z.literal(true),
        rationale: z.string().trim().min(1).max(4096),
      })
      .strict()
      .parse(await body(c.req.raw));
    return c.json({
      success: true,
      data: await options.controller!.resolve(
        id.parse(c.req.param('run')),
        input.rationale,
        await options.operator(c.req.raw),
      ),
    });
  });
  app.post('/:run/archive', async (c) => {
    z.object({})
      .strict()
      .parse(await body(c.req.raw));
    await options.controller!.archive(
      id.parse(c.req.param('run')),
      await options.operator(c.req.raw),
    );
    return c.json({ success: true });
  });
  app.post('/:run/cancel', async (c) => {
    z.object({})
      .strict()
      .parse(await body(c.req.raw));
    await options.controller!.cancel(
      id.parse(c.req.param('run')),
      await options.operator(c.req.raw),
    );
    return c.json({ success: true });
  });
  return app;
}

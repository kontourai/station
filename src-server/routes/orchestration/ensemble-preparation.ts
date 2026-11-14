import { agentId } from '@kontourai/station-contracts/agent-identity';
import type { PrincipalRef } from '@kontourai/station-contracts/principal';
import { type Context, Hono } from 'hono';
import { z } from 'zod/v3';
import {
  EnsembleExecutionContext,
  EnsemblePreparationRefusal,
} from '../../services/orchestration/ensemble-execution-context.js';

const schema = z
  .object({
    path: z.string().min(1).max(4096),
    expectedPresetHash: z
      .string()
      .max(71)
      .regex(/^sha256:[0-9a-f]{64}$/),
    brief: z.string().max(100_000),
    bindings: z
      .record(
        z.string().min(1).max(64),
        z
          .object({
            agent: z.string().min(1).max(64),
            projectSlug: z.string().min(1).max(256),
          })
          .strict(),
      )
      .refine((entries) => Object.keys(entries).length <= 32),
  })
  .strict();

export function createEnsemblePreparationRoutes(
  service: EnsembleExecutionContext,
  resolvePrincipal: (context: Context) => PrincipalRef,
): Hono {
  const app = new Hono();
  app.post('/prepare', async (c) => {
    try {
      const principal = resolvePrincipal(c);
      const parsed = schema.safeParse(await c.req.json());
      if (!parsed.success)
        return c.json(
          { success: false, code: 'ensemble_preparation_invalid' },
          400,
        );
      const { bindings, ...input } = parsed.data;
      await service.prepare(
        {
          ...input,
          bindings: Object.fromEntries(
            Object.entries(bindings).map(([id, binding]) => [
              id,
              {
                environment: { kind: 'current' as const },
                agent: agentId(binding.agent),
                workspace: {
                  kind: 'project' as const,
                  projectSlug: binding.projectSlug,
                },
              },
            ]),
          ),
        },
        c.req.raw,
        principal,
      );
      return c.json(
        { success: false, code: 'ensemble_execution_guarantees_unavailable' },
        422,
      );
    } catch (error) {
      if (error instanceof EnsemblePreparationRefusal)
        return c.json(
          {
            success: false,
            code: error.code,
            ...(error.observation ? { observation: error.observation } : {}),
          },
          error.code === 'ensemble_preparation_authority_required' ? 403 : 422,
        );
      // CLI output, credential paths and malformed preset contents stay private.
      return c.json(
        { success: false, code: 'ensemble_preparation_refused' },
        422,
      );
    }
  });
  return app;
}

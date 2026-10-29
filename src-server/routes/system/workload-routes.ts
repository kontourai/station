/**
 * Workload memory budgets (`/api/system/workload`).
 *
 * - `GET /workload`: the operator view — enforcement state, effective
 *   budgets and where each came from, saved settings, host memory.
 * - `PUT /workload/settings`: save per-engine and total memory budgets.
 *   Behind the `workload-budget-settings` Feature Preview; refused before
 *   anything is written while it is off.
 * - `GET /workload/session`: the calling agent Session's own scope, for the
 *   `workload_status` station-control tool. The session comes only from the
 *   verified station-control credential the tool forwarded.
 *
 * None of these is mounted with a fabricated answer: absent dependencies
 * answer 404, which older clients already read as "not supported".
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { FeaturePreviewDisabledError } from '../../services/feature-previews/feature-preview-refusal.js';
import type { FeaturePreviewSelector } from '../../services/feature-previews/feature-preview-registry.js';
import {
  applyWorkloadBudgetSettings,
  inspectSessionWorkload,
  WorkloadSettingsRejectedError,
  workloadBudgetStatus,
} from '../../services/infra/workload-resources.js';
import { errorMessage } from '../schemas/schemas.js';

export const WORKLOAD_BUDGET_SETTINGS_PREVIEW = {
  id: 'workload-budget-settings',
  label: 'Workload budget settings',
  description:
    'Edit the per-engine and total memory budgets for engine workloads in Settings. On a Linux service a lower budget can stop engines that run out of memory sooner.',
} as const;

export interface WorkloadRouteDeps {
  /** Absent on deployments whose operators do not own the host (hosted). */
  operator?: {
    settingsPreview: FeaturePreviewSelector;
  };
  /** The verified station-control caller's session, or null. */
  resolveCallerSession(request: Request): string | null;
}

const settingsSchema = z
  .object({
    memoryMiB: z.number().int().positive().nullable().optional(),
    totalMemoryMiB: z.number().int().positive().nullable().optional(),
  })
  .strict();

export function createWorkloadRoutes(deps: WorkloadRouteDeps) {
  const app = new Hono();

  app.get('/workload/session', async (c) => {
    const sessionId = deps.resolveCallerSession(c.req.raw);
    if (!sessionId)
      return c.json(
        {
          success: false,
          code: 'station_control_caller_required',
          error:
            'This read needs a verified calling session. The station-control connection for this engine does not carry one.',
        },
        403,
      );
    return c.json({
      success: true,
      data: await inspectSessionWorkload(sessionId),
    });
  });

  const operator = deps.operator;
  if (!operator) return app;

  app.get('/workload', (c) =>
    c.json({ success: true, data: workloadBudgetStatus() }),
  );

  app.put('/workload/settings', async (c) => {
    try {
      operator.settingsPreview.select({
        enabled: () => {},
        disabled: () => {
          throw new FeaturePreviewDisabledError(
            WORKLOAD_BUDGET_SETTINGS_PREVIEW.id,
            WORKLOAD_BUDGET_SETTINGS_PREVIEW.label,
          );
        },
      });
    } catch (error) {
      if (error instanceof FeaturePreviewDisabledError)
        return c.json(error.refusal, 404);
      throw error;
    }
    const parsed = settingsSchema.safeParse(
      await c.req.json().catch(() => undefined),
    );
    if (!parsed.success)
      return c.json(
        {
          success: false,
          error:
            'Send memoryMiB and totalMemoryMiB as whole numbers of MiB, or null for the default.',
        },
        400,
      );
    const settings = {
      ...(parsed.data.memoryMiB != null
        ? { memoryMiB: parsed.data.memoryMiB }
        : {}),
      ...(parsed.data.totalMemoryMiB != null
        ? { totalMemoryMiB: parsed.data.totalMemoryMiB }
        : {}),
    };
    try {
      return c.json({
        success: true,
        data: await applyWorkloadBudgetSettings(settings),
      });
    } catch (error) {
      if (error instanceof WorkloadSettingsRejectedError)
        return c.json(
          { success: false, code: error.code, error: errorMessage(error) },
          400,
        );
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  return app;
}

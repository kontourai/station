/**
 * Scheduler Routes — scheduled job management
 */

import type { SchedulerManualRunReceipt } from '@kontourai/station-contracts/scheduler';
import {
  isHostedSessionReadAuthority,
  type SessionReadAuthority,
} from '@kontourai/station-contracts/tenancy';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { SSE_KEEPALIVE_INTERVAL_MS } from '../../constants.js';
import { SchedulerJobConflictError } from '../../services/scheduling/builtin-scheduler.js';
import { SchedulerStorageUnavailableError } from '../../services/scheduling/scheduler-ledger.js';
import type {
  SchedulerManualRunResult,
  SchedulerService,
} from '../../services/scheduling/scheduler-service.js';
import { schedulerJobRuns } from '../../telemetry/metrics.js';
import type { Logger } from '../../utils/logger.js';
import {
  addJobSchema,
  editJobSchema,
  errorMessage,
  getBody,
  param,
  validate,
} from '../schemas/schemas.js';

function publicManualRunMessage(
  outcome: SchedulerManualRunReceipt['outcome'],
  detail?: string,
) {
  return outcome === 'completed'
    ? 'Scheduler job completed.'
    : outcome === 'failed'
      ? 'Scheduler job failed. Inspect the associated run for details.'
      : outcome === 'refused'
        ? (detail ??
          'Scheduler job refused due to resource posture. Retry later.')
        : 'Scheduler job may have started. Inspect the associated run before acting again.';
}

function publicManualRunReceipt(
  result: SchedulerManualRunReceipt,
): SchedulerManualRunReceipt | undefined {
  // Do not publish a receipt that cannot identify an exact run. Legacy
  // callers still receive `output`; receipt-aware clients will surface the
  // observation limitation rather than guessing from a job name.
  if (typeof result.runId !== 'string' || result.runId.trim().length === 0)
    return undefined;
  const message = publicManualRunMessage(result.outcome);
  return { outcome: result.outcome, message, runId: result.runId };
}

function observeManualRunRequest() {
  try {
    schedulerJobRuns.add(1, { op: 'run_job' });
  } catch {
    // Metrics are observability only. Do not change an authenticated run's
    // provider outcome because an OTel exporter is unavailable.
  }
}

export function createSchedulerRoutes(
  schedulerService: SchedulerService,
  logger: Logger,
  options: {
    /** Runtime composition derives this only from trusted request ingress. */
    readAuthorityForRequest?: (request: Request) => SessionReadAuthority;
  } = {},
) {
  const app = new Hono();

  // Scheduler storage and scheduler-originated output have no durable tenant
  // binding.  Do not expose a partially filtered API: every read, SSE frame,
  // webhook, and mutation is unavailable in hosted mode until that storage is
  // explicitly tenant-bound. Runtime composition supplies the callback.
  app.use('*', async (c, next) => {
    const authority = options.readAuthorityForRequest?.(c.req.raw);
    if (authority && isHostedSessionReadAuthority(authority)) {
      return c.json({ success: false, error: 'Scheduler not found' }, 404);
    }
    await next();
  });

  // List registered scheduler providers (for UI dropdown)
  app.get('/providers', (c) => {
    return c.json({ success: true, data: schedulerService.listProviders() });
  });

  // SSE endpoint for real-time job events
  app.get('/events', (c) => {
    return streamSSE(c, async (stream) => {
      const unsub = schedulerService.subscribe((data) => {
        stream
          .writeSSE({ data })
          .catch((e) => logger.error('SSE write failed', { error: e }));
      });
      // Keep alive
      const keepAlive = setInterval(() => {
        stream
          .writeSSE({ event: 'ping', data: '' })
          .catch((e) => logger.error('SSE ping failed', { error: e }));
      }, SSE_KEEPALIVE_INTERVAL_MS);
      // Wait until client disconnects
      try {
        await new Promise((_, reject) => {
          stream.onAbort(() => reject(new Error('aborted')));
        });
      } catch (e) {
        logger.debug('SSE client disconnected', { error: e });
        /* client disconnected */
      }
      clearInterval(keepAlive);
      unsub();
    });
  });

  // Webhook receiver (from scheduler provider)
  app.post('/webhook', async (c) => {
    try {
      const event = await c.req.json();
      logger.info('Scheduler webhook event', { event });
      schedulerService.broadcast(event);
      return c.json({ success: true });
    } catch (error: unknown) {
      logger.error('Webhook parse error', { error });
      return c.json({ success: false, error: errorMessage(error) }, 400);
    }
  });

  app.get('/jobs', async (c) => {
    try {
      const data = await schedulerService.listJobs();
      return c.json({ success: true, data });
    } catch (error: unknown) {
      logger.error('Failed to list scheduler jobs', { error });
      return c.json(
        { success: false, error: errorMessage(error) },
        schedulerErrorStatus(error),
      );
    }
  });

  app.get('/stats', async (c) => {
    try {
      const data = await schedulerService.getStats();
      return c.json({ success: true, data });
    } catch (error: unknown) {
      logger.error('Failed to get scheduler stats', { error });
      return c.json(
        { success: false, error: errorMessage(error) },
        schedulerErrorStatus(error),
      );
    }
  });

  app.get('/status', async (c) => {
    try {
      const data = await schedulerService.getStatus();
      return c.json({ success: true, data });
    } catch (error: unknown) {
      logger.error('Failed to get scheduler status', { error });
      return c.json(
        { success: false, error: errorMessage(error) },
        schedulerErrorStatus(error),
      );
    }
  });

  app.get('/jobs/preview-schedule', async (c) => {
    try {
      const cron = c.req.query('cron');
      if (!cron)
        return c.json({ success: false, error: 'cron is required' }, 400);
      const count = parseInt(c.req.query('count') || '5', 10);
      const data = await schedulerService.previewSchedule(cron, count);
      return c.json({ success: true, data });
    } catch (error: unknown) {
      logger.error('Failed to preview schedule', { error });
      return c.json(
        { success: false, error: errorMessage(error) },
        schedulerErrorStatus(error),
      );
    }
  });

  app.get('/jobs/:target/logs', async (c) => {
    try {
      const count = parseInt(c.req.query('count') || '20', 10);
      const providerId = c.req.query('providerId');
      const data = providerId
        ? await schedulerService.getJobLogsForProvider(
            providerId,
            param(c, 'target'),
            count,
          )
        : await schedulerService.getJobLogs(param(c, 'target'), count);
      return c.json({ success: true, data });
    } catch (error: unknown) {
      logger.error('Failed to get job logs', { error });
      return c.json(
        { success: false, error: errorMessage(error) },
        schedulerErrorStatus(error),
      );
    }
  });

  app.post('/jobs', validate(addJobSchema), async (c) => {
    try {
      const body = getBody(c);
      schedulerJobRuns.add(1, { op: 'create_job' });
      const output = await schedulerService.addJob(body);
      return c.json({ success: true, data: { output } });
    } catch (error: unknown) {
      logger.error('Failed to add job', { error });
      return c.json(
        { success: false, error: errorMessage(error) },
        schedulerErrorStatus(error),
      );
    }
  });

  app.put('/jobs/:target', validate(editJobSchema), async (c) => {
    try {
      const opts = getBody(c);
      schedulerJobRuns.add(1, { op: 'edit_job' });
      const output = await schedulerService.editJob(param(c, 'target'), opts);
      return c.json({ success: true, data: { output } });
    } catch (error: unknown) {
      logger.error('Failed to edit job', { error });
      return c.json(
        { success: false, error: errorMessage(error) },
        schedulerErrorStatus(error),
      );
    }
  });

  app.post('/jobs/:target/run', async (c) => {
    const target = param(c, 'target');
    try {
      observeManualRunRequest();
      const result: SchedulerManualRunResult =
        await schedulerService.runJob(target);
      if ('output' in result) {
        // An internally composed legacy provider can confirm its own output,
        // but did not supply an exact run identity. Preserve the established
        // success payload without fabricating an observable receipt.
        return c.json({ success: true, data: { output: result.output } });
      }
      // Provider/storage diagnostics belong to the protected run record, not
      // this public envelope. Keep the old output field stable and add only a
      // projected, non-authorizing receipt.
      const receipt = publicManualRunReceipt(result);
      const output = publicManualRunMessage(result.outcome, result.message);
      const data = receipt ? { output, receipt } : { output };
      if (result.outcome === 'completed') {
        // Keep the established `{data:{output}}` success contract.  The
        // receipt is additive: older CLI/plugin clients can continue to read
        // `output`, while receipt-aware clients can observe the exact run.
        return c.json({
          success: true,
          data,
        });
      }
      return c.json(
        result.outcome === 'indeterminate'
          ? {
              success: false,
              data,
              error: output,
              code: 'scheduler_run_indeterminate',
              outcome: 'indeterminate',
            }
          : {
              success: false,
              data,
              error: output,
              ...(result.outcome === 'refused'
                ? { code: 'scheduler_run_refused', outcome: 'refused' }
                : {}),
            },
        result.outcome === 'indeterminate' ? 409 : 422,
      );
    } catch (error: unknown) {
      logger.error('Failed to run job', { error });
      return c.json(
        { success: false, error: errorMessage(error) },
        schedulerErrorStatus(error),
      );
    }
  });

  app.post('/jobs/:target/monitor/restart', async (c) => {
    try {
      const output = await schedulerService.restartMonitor(param(c, 'target'));
      return c.json({ success: true, data: { output } });
    } catch (error: unknown) {
      return c.json(
        { success: false, error: errorMessage(error) },
        schedulerErrorStatus(error),
      );
    }
  });

  app.post('/jobs/:target/monitor/resolve', async (c) => {
    try {
      const body = getBody(c) as Record<string, unknown>;
      if (typeof body.triggerId !== 'string' || body.action !== 'resolve')
        return c.json(
          { success: false, error: 'Invalid monitor resolution evidence' },
          400,
        );
      const output = await schedulerService.resolveIndeterminateMonitor(
        param(c, 'target'),
        {
          triggerId: body.triggerId,
          action: 'resolve',
        },
      );
      return c.json({ success: true, data: { output } });
    } catch (error: unknown) {
      return c.json(
        { success: false, error: errorMessage(error) },
        schedulerErrorStatus(error),
      );
    }
  });

  app.put('/jobs/:target/enable', async (c) => {
    try {
      schedulerJobRuns.add(1, { op: 'enable_job' });
      await schedulerService.enableJob(param(c, 'target'));
      return c.json({ success: true });
    } catch (error: unknown) {
      logger.error('Failed to enable job', { error });
      return c.json(
        { success: false, error: errorMessage(error) },
        schedulerErrorStatus(error),
      );
    }
  });

  app.put('/jobs/:target/disable', async (c) => {
    try {
      schedulerJobRuns.add(1, { op: 'disable_job' });
      await schedulerService.disableJob(param(c, 'target'));
      return c.json({ success: true });
    } catch (error: unknown) {
      logger.error('Failed to disable job', { error });
      return c.json(
        { success: false, error: errorMessage(error) },
        schedulerErrorStatus(error),
      );
    }
  });

  app.delete('/jobs/:target', async (c) => {
    try {
      schedulerJobRuns.add(1, { op: 'delete_job' });
      await schedulerService.removeJob(param(c, 'target'));
      return c.json({ success: true });
    } catch (error: unknown) {
      logger.error('Failed to remove job', { error });
      return c.json(
        { success: false, error: errorMessage(error) },
        schedulerErrorStatus(error),
      );
    }
  });

  return app;
}

function schedulerErrorStatus(error: unknown): 409 | 500 | 503 {
  if (error instanceof SchedulerJobConflictError) return 409;
  return error instanceof SchedulerStorageUnavailableError ? 503 : 500;
}

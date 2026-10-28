/**
 * Scheduler Routes — scheduled job management
 */

import type {
  SchedulerAutomationCreator,
  SchedulerAutomationTarget,
  SchedulerJob,
  SchedulerManualRunReceipt,
} from '@kontourai/station-contracts/scheduler';
import {
  isHostedSessionReadAuthority,
  type SessionReadAuthority,
} from '@kontourai/station-contracts/tenancy';
import { type Context, Hono } from 'hono';
import { SchedulerJobConflictError } from '../../services/scheduling/builtin-scheduler.js';
import { SchedulerStorageUnavailableError } from '../../services/scheduling/scheduler-ledger.js';
import type { SchedulerService } from '../../services/scheduling/scheduler-service.js';
import { SchedulerScheduleInvalidError } from '../../services/scheduling/scheduler-service.js';
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
import { sseKeepalive, streamSSE } from '../sse-response.js';

function publicManualRunMessage(
  outcome: SchedulerManualRunReceipt['outcome'],
  detail?: string,
) {
  return outcome === 'completed'
    ? 'Scheduler job completed.'
    : outcome === 'deferred'
      ? (detail ?? 'Scheduler job deferred behind the execution limit.')
      : outcome === 'failed'
        ? 'Scheduler job failed. Inspect the associated run for details.'
        : outcome === 'refused'
          ? (detail ?? 'Scheduler job refused. Inspect the run for its reason.')
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

/** See `createJobProposalApproval` (`routes/orchestration/agent-schedule.ts`). */
export interface JobProposalApproval {
  admit(
    c: Context,
    proposalId: string,
    body: Record<string, unknown>,
  ): /**
   * Admitted and claimed: `commit` after the job is created, `revert` if
   * creating it failed.
   */
    | { readonly ok: true; commit(): void; revert(): void }
    | {
        readonly ok: false;
        readonly status: 403 | 404 | 409;
        readonly code: string;
        readonly error: string;
      };
}

/**
 * Whether this request may point an automation at `target`, and who its
 * runs act as. A person must be able to continue the conversation; an
 * agent's request may only name its own conversation. Runtime composition
 * supplies it (`agent-schedule-composition.ts`).
 */
export type AutomationTargetAdmission = (
  c: Context,
  target: SchedulerAutomationTarget,
) =>
  | { readonly ok: true; readonly createdBy: SchedulerAutomationCreator }
  | {
      readonly ok: false;
      readonly status: 403 | 404;
      readonly code: string;
      readonly error: string;
    };

/** The admitted creator for a body's target, or the refusal response. */
function admitTarget(
  c: Context,
  admission: AutomationTargetAdmission | undefined,
  target: SchedulerAutomationTarget | null | undefined,
): { createdBy?: SchedulerAutomationCreator } | { refused: Response } {
  if (!target) return {};
  if (!admission)
    return {
      refused: c.json(
        {
          success: false,
          code: 'automation_target_unavailable',
          error: "This Station can't run an automation in a conversation.",
        },
        503,
      ),
    };
  const admitted = admission(c, target);
  if (!admitted.ok)
    return {
      refused: c.json(
        { success: false, code: admitted.code, error: admitted.error },
        admitted.status,
      ),
    };
  return { createdBy: admitted.createdBy };
}

/**
 * Whether this request may act on an existing automation that targets a
 * conversation (edit, run, enable, disable, delete): every run sends a turn
 * there as the stored creator, so whoever changes or triggers it must be able
 * to continue that conversation, and an agent may only touch automations
 * targeting its own. Decided on the STORED target, whatever the body says.
 */
export type AutomationJobAdmission = (
  c: Context,
  job: SchedulerJob,
) =>
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly status: 403 | 404;
      readonly code: string;
      readonly error: string;
    };

export function createSchedulerRoutes(
  schedulerService: SchedulerService,
  logger: Logger,
  options: {
    /** Runtime composition derives this only from trusted request ingress. */
    readAuthorityForRequest?: (request: Request) => SessionReadAuthority;
    /**
     * Approving an agent's job proposal: decides whether this request may
     * create the job a proposal names. Absent: a body naming a proposal is
     * refused.
     */
    jobProposals?: JobProposalApproval;
    /** Absent: a body with a `target` is refused (no conversation runs). */
    admitAutomationTarget?: AutomationTargetAdmission;
    /** Absent: every action on a job with a stored target is refused. */
    admitAutomationJob?: AutomationJobAdmission;
    mayReadAutomationJob?: (c: Context, job: SchedulerJob) => boolean;
    mayReadAutomationRun?: (
      c: Context,
      job: SchedulerJob,
      run: import('@kontourai/station-contracts/scheduler').SchedulerLogEntry,
    ) => boolean;
  } = {},
) {
  const app = new Hono();

  /**
   * The refusal for acting on `name`, or undefined when it may proceed.
   * Jobs without a target keep their existing (operator) authority.
   */
  const refuseStoredTarget = async (
    c: Context,
    name: string,
  ): Promise<Response | undefined> => {
    const job = (await schedulerService.listJobs()).find(
      (candidate) => candidate.name === name,
    );
    if (!job?.target) return undefined;
    if (!options.admitAutomationJob)
      return c.json(
        {
          success: false,
          code: 'automation_target_unavailable',
          error: "This Station can't run an automation in a conversation.",
        },
        503,
      );
    const admitted = options.admitAutomationJob(c, job);
    return admitted.ok
      ? undefined
      : c.json(
          { success: false, code: admitted.code, error: admitted.error },
          admitted.status,
        );
  };

  const canReadJob = (c: Context, job: SchedulerJob) =>
    options.mayReadAutomationJob
      ? options.mayReadAutomationJob(c, job)
      : !job.target;
  const canReadRunSummary = (
    c: Context,
    job: SchedulerJob,
    run: import('@kontourai/station-contracts/runs').RunSummary,
  ) =>
    options.mayReadAutomationRun
      ? options.mayReadAutomationRun(c, job, {
          id: '',
          job: job.name,
          startedAt: run.startedAt,
          success: run.status === 'completed',
          jobId:
            typeof run.metadata?.jobId === 'string'
              ? run.metadata.jobId
              : undefined,
          runTarget: run.metadata?.runTarget as
            | SchedulerJob['target']
            | null
            | undefined,
        })
      : canReadJob(c, job);
  const visibleJobs = async (
    c: Context,
    summaries?: import('@kontourai/station-contracts/runs').RunSummary[],
  ) => {
    const jobs = (await schedulerService.listJobs()).filter((job) =>
      canReadJob(c, job),
    );
    if (jobs.length === 0) return jobs;
    const runs = summaries ?? (await schedulerService.listRunSummaries());
    return jobs.map((job) => {
      const hidden = runs.some(
        (run) =>
          run.providerId === job.provider &&
          run.sourceId === job.name &&
          !canReadRunSummary(c, job, run),
      );
      if (!hidden) return job;
      const { lastRun, lastSuccessAt, consecutiveFailures, ...redacted } = job;
      return redacted;
    });
  };

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
        void (async () => {
          const event = JSON.parse(data) as {
            job?: unknown;
            provider?: unknown;
            id?: unknown;
          };
          if (
            typeof event.job !== 'string' ||
            typeof event.provider !== 'string'
          )
            return;
          const job = (await schedulerService.listJobs()).find(
            (candidate) =>
              candidate.name === event.job &&
              candidate.provider === event.provider,
          );
          if (!job) return;
          if (typeof event.id === 'string') {
            const logs = await schedulerService.getJobLogsForProvider(
              event.provider,
              event.job,
              50,
            );
            const run = logs.find((entry) => entry.id === event.id);
            if (!run || !options.mayReadAutomationRun?.(c, job, run)) return;
          } else if (!canReadJob(c, job)) return;
          await stream.writeSSE({ data });
        })().catch((e) => logger.error('SSE write failed', { error: e }));
      });
      const stopKeepAlive = sseKeepalive(stream, undefined, {
        onWriteError: (e) => logger.error('SSE ping failed', { error: e }),
      });
      // Wait until client disconnects
      try {
        await new Promise((_, reject) => {
          stream.onAbort(() => reject(new Error('aborted')));
        });
      } catch (e) {
        logger.debug('SSE client disconnected', { error: e });
        /* client disconnected */
      }
      stopKeepAlive();
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
      const data = await visibleJobs(c);
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
      const [data, runs] = await Promise.all([
        schedulerService.getStats(),
        schedulerService.listRunSummaries(),
      ]);
      const jobs = await visibleJobs(c, runs);
      for (const [provider, stats] of Object.entries(data.providers)) {
        stats.jobs = stats.jobs.flatMap((stat) => {
          const job = jobs.find(
            (candidate) =>
              candidate.provider === provider && candidate.name === stat.name,
          );
          if (!job) return [];
          const visible = runs.filter(
            (run) =>
              run.providerId === provider &&
              run.sourceId === job.name &&
              run.status !== 'running' &&
              canReadRunSummary(c, job, run),
          );
          const successes = visible.filter(
            (run) => run.status === 'completed',
          ).length;
          return [
            {
              name: stat.name,
              total: visible.length,
              successes,
              failures: visible.length - successes,
              success_rate: visible.length
                ? Math.round((successes / visible.length) * 100)
                : 0,
            },
          ];
        });
      }
      const entries = Object.values(data.providers).flatMap(
        (provider) => provider.jobs,
      );
      const totalRuns = entries.reduce(
        (total, entry) => total + entry.total,
        0,
      );
      data.summary = {
        totalJobs: entries.length,
        totalRuns,
        successRate: totalRuns
          ? Math.round(
              (entries.reduce((total, entry) => total + entry.successes, 0) /
                totalRuns) *
                100,
            )
          : 0,
      };
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
      const [data, jobs] = await Promise.all([
        schedulerService.getStatus(),
        visibleJobs(c),
      ]);
      for (const [provider, status] of Object.entries(data.providers)) {
        status.jobCount = jobs.filter(
          (job) => job.provider === provider,
        ).length;
      }
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
      // #1536 D1: the zone travels with the expression or the projection is
      // wrong for every zoned schedule.
      const timezone = c.req.query('timezone') || undefined;
      const data = await schedulerService.previewSchedule(
        cron,
        count,
        timezone,
      );
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
      const name = param(c, 'target');
      const providerId = c.req.query('providerId');
      const jobs = await schedulerService.listJobs();
      const job = jobs.find(
        (candidate) =>
          candidate.name === name &&
          (!providerId || candidate.provider === providerId),
      );
      if (!job) return c.json({ success: false, error: 'Job not found' }, 404);
      const count = parseInt(c.req.query('count') || '20', 10);
      const data = providerId
        ? await schedulerService.getJobLogsForProvider(
            providerId,
            param(c, 'target'),
            count,
          )
        : await schedulerService.getJobLogs(param(c, 'target'), count);
      const visible = data.filter((run) =>
        options.mayReadAutomationRun
          ? options.mayReadAutomationRun(c, job, run)
          : canReadJob(c, job),
      );
      if (!canReadJob(c, job) && visible.length === 0)
        return c.json({ success: false, error: 'Job not found' }, 404);
      return c.json({ success: true, data: visible });
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
      const { proposalId, ...body } = getBody(c) as {
        proposalId?: string;
      } & Parameters<SchedulerService['addJob']>[0];
      const approval =
        proposalId === undefined
          ? undefined
          : options.jobProposals
            ? options.jobProposals.admit(c, proposalId, body)
            : ({
                ok: false,
                status: 404,
                code: 'job_proposal_not_found',
                error: 'Job proposal not found',
              } as const);
      if (approval && !approval.ok)
        return c.json(
          { success: false, code: approval.code, error: approval.error },
          approval.status,
        );
      const admitted = admitTarget(
        c,
        options.admitAutomationTarget,
        body.target,
      );
      if ('refused' in admitted) {
        approval?.revert();
        return admitted.refused;
      }
      schedulerJobRuns.add(1, { op: 'create_job' });
      let output: Awaited<ReturnType<SchedulerService['addJob']>>;
      try {
        output = await schedulerService.addJob({ ...body, ...admitted });
      } catch (error) {
        approval?.revert();
        throw error;
      }
      approval?.commit();
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
      const opts = getBody(c) as Record<string, unknown>;
      const stored = await refuseStoredTarget(c, param(c, 'target'));
      if (stored) return stored;
      const admitted = admitTarget(
        c,
        options.admitAutomationTarget,
        opts.target as SchedulerAutomationTarget | null | undefined,
      );
      if ('refused' in admitted) return admitted.refused;
      schedulerJobRuns.add(1, { op: 'edit_job' });
      const output = await schedulerService.editJob(param(c, 'target'), {
        ...opts,
        ...admitted,
      });
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
      const stored = await refuseStoredTarget(c, target);
      if (stored) return stored;
      observeManualRunRequest();
      const result = await schedulerService.runJob(target);
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
          : result.outcome === 'deferred'
            ? {
                success: false,
                data,
                error: output,
                code: 'scheduler_run_deferred',
                outcome: 'deferred',
              }
            : {
                success: false,
                data,
                error: output,
                ...(result.outcome === 'refused'
                  ? { code: 'scheduler_run_refused', outcome: 'refused' }
                  : {}),
              },
        result.outcome === 'indeterminate' || result.outcome === 'deferred'
          ? 409
          : 422,
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
      const stored = await refuseStoredTarget(c, param(c, 'target'));
      if (stored) return stored;
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
      const stored = await refuseStoredTarget(c, param(c, 'target'));
      if (stored) return stored;
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
      const stored = await refuseStoredTarget(c, param(c, 'target'));
      if (stored) return stored;
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

function schedulerErrorStatus(error: unknown): 400 | 409 | 500 | 503 {
  // #1536 R3: a schedule the projector cannot evaluate is the CALLER's, so it
  // is a 400 carrying `validateSchedule`'s own message — not a 500 that reads
  // as a server fault for an operator's typo in a zone name.
  if (error instanceof SchedulerScheduleInvalidError) return 400;
  if (error instanceof SchedulerJobConflictError) return 409;
  return error instanceof SchedulerStorageUnavailableError ? 503 : 500;
}

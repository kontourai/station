/**
 * Scheduler Service — multi-provider router.
 * Aggregates jobs/stats from all registered providers.
 * Routes CRUD to the provider that owns each job.
 */

import { nextOccurrences, type Schedule } from '@kontourai/ephemeris';
import type {
  RunOutputRef,
  RunSummary,
} from '@kontourai/station-contracts/runs';
import type { SchedulerManualRunReceipt } from '@kontourai/station-contracts/scheduler';
import type {
  AddJobOpts,
  SchedulerJob,
  SchedulerLogEntry,
  SchedulerProviderStats,
  SchedulerProviderStatus,
} from '../../providers/provider-contracts.js';
import type { ISchedulerProvider } from '../../providers/provider-interfaces.js';
import {
  schedulerJobDuration,
  schedulerJobRuns,
} from '../../telemetry/metrics.js';
import type { Logger } from '../../utils/logger.js';
import { SSEBroadcaster } from '../infra/sse-broadcaster.js';
import {
  parseScheduleRunId,
  projectSchedulerLogToRun,
} from '../orchestration/run-projection.js';
import {
  BuiltinScheduler,
  type BuiltinSchedulerOptions,
  type PreparedStarterScheduledRun,
} from './builtin-scheduler.js';

export interface SchedulerServiceOptions {
  logger: Logger;
  builtin: Omit<BuiltinSchedulerOptions, 'logger'>;
}

/** Internal route result; legacy output never fabricates a receipt/run id. */
export type SchedulerManualRunResult =
  | SchedulerManualRunReceipt
  | Readonly<{ output: string }>;

export class SchedulerService {
  private providers = new Map<string, ISchedulerProvider>();
  private sse = new SSEBroadcaster();
  private builtin: BuiltinScheduler;

  /**
   * `logger` was accepted but discarded here before archive#1897 (logging
   * slice 3) — nothing in the scheduler job-execution path went through
   * Station's Logger seam at all, only ad hoc `broadcast()` SSE events and
   * a couple of pre-existing `console.debug` calls elsewhere in this class
   * (left untouched; console-call conversion is a separate, sibling-owned
   * slice). Threaded through to `BuiltinScheduler` so each job run can bind
   * a `logger.child()` with its own `jobName`/`jobRunId`.
   */
  constructor({ logger, builtin }: SchedulerServiceOptions) {
    this.builtin = new BuiltinScheduler({ logger, ...builtin });
    this.builtin.start();
    this.providers.set(this.builtin.id, this.builtin);
  }

  async stop(): Promise<void> {
    await this.builtin.stop();
  }

  /** Register an internally composed scheduler provider. This is not a plugin SDK seam. */
  addProvider(provider: ISchedulerProvider) {
    this.providers.set(provider.id, provider);
  }

  /** List registered providers (for UI dropdown) */
  listProviders(): Array<{
    id: string;
    displayName: string;
    capabilities: string[];
    formFields?: any[];
  }> {
    return [...this.providers.values()].map((p) => ({
      id: p.id,
      displayName: p.displayName,
      capabilities: [...p.capabilities],
      formFields: p.getFormFields?.() ?? [],
    }));
  }

  private getProvider(id: string): ISchedulerProvider {
    const p = this.providers.get(id);
    if (!p) throw new Error(`Scheduler provider '${id}' not found`);
    return p;
  }

  private async findJobProvider(name: string): Promise<ISchedulerProvider> {
    for (const p of this.providers.values()) {
      const jobs = await p.listJobs();
      if (jobs.some((j) => j.name === name)) return p;
    }
    throw new Error(`Job '${name}' not found in any provider`);
  }

  // ── Aggregated reads ──

  async listJobs(): Promise<SchedulerJob[]> {
    // A scheduler provider's durable state is authoritative.  In particular,
    // swallowing the built-in ledger's typed unavailable result here would
    // turn a transient storage fault into a false empty schedule.
    const all = await Promise.all(
      [...this.providers.values()].map((p) => p.listJobs()),
    );
    return all.flat();
  }

  async getStats(): Promise<{
    providers: Record<string, SchedulerProviderStats>;
    summary: { totalJobs: number; totalRuns: number; successRate: number };
  }> {
    const providers: Record<string, SchedulerProviderStats> = {};
    let totalJobs = 0,
      totalRuns = 0,
      totalSuccesses = 0;
    for (const p of this.providers.values()) {
      const s = await p.getStats();
      providers[p.id] = s;
      for (const j of s.jobs) {
        totalJobs++;
        totalRuns += j.total;
        totalSuccesses += j.successes;
      }
    }
    return {
      providers,
      summary: {
        totalJobs,
        totalRuns,
        successRate: totalRuns
          ? Math.round((totalSuccesses / totalRuns) * 100)
          : 0,
      },
    };
  }

  async getStatus(): Promise<{
    providers: Record<
      string,
      SchedulerProviderStatus & { id: string; displayName: string }
    >;
  }> {
    const providers: Record<
      string,
      SchedulerProviderStatus & { id: string; displayName: string }
    > = {};
    for (const p of this.providers.values()) {
      const s = await p.getStatus();
      providers[p.id] = { ...s, id: p.id, displayName: p.displayName };
    }
    return { providers };
  }

  // ── Routed writes ──

  async addJob(opts: AddJobOpts): Promise<string> {
    const providerId = opts.provider || this.builtin.id;
    return this.getProvider(providerId).addJob(opts);
  }

  async editJob(
    target: string,
    opts: Record<string, unknown>,
  ): Promise<string> {
    const p = await this.findJobProvider(target);
    return p.editJob(target, opts);
  }

  async removeJob(target: string): Promise<void> {
    const p = await this.findJobProvider(target);
    return p.removeJob(target);
  }

  async runJob(target: string): Promise<SchedulerManualRunResult> {
    const p = await this.findJobProvider(target);
    const start = Date.now();
    try {
      const providerResult = await p.runJob(target);
      const result =
        typeof providerResult === 'string'
          ? { output: providerResult }
          : providerResult;
      this.recordRunMetrics(
        target,
        !('outcome' in result) || result.outcome === 'completed'
          ? 'success'
          : 'error',
        start,
      );
      return result;
    } catch (e) {
      // Telemetry is not an execution authority. A provider error remains the
      // provider error even when the observer is unavailable.
      this.recordRunMetrics(target, 'error', start);
      throw e;
    }
  }

  prepareStarterManualIntent(operationId: string): PreparedStarterScheduledRun {
    return this.builtin.prepareStarterManualIntent(operationId);
  }

  private recordRunMetrics(
    target: string,
    status: 'success' | 'error',
    start: number,
  ) {
    try {
      schedulerJobRuns.add(1, { job: target, status });
      schedulerJobDuration.record(Date.now() - start, { job: target });
    } catch {
      // Best-effort observer only; the durable provider result above wins.
    }
  }

  async enableJob(target: string): Promise<void> {
    const p = await this.findJobProvider(target);
    return p.enableJob(target);
  }

  async disableJob(target: string): Promise<void> {
    const p = await this.findJobProvider(target);
    return p.disableJob(target);
  }

  async restartMonitor(target: string): Promise<string> {
    const provider = await this.findJobProvider(target);
    if (provider !== this.builtin)
      throw new Error(`Job '${target}' monitor cannot be restarted`);
    return this.builtin.restartMonitor(target);
  }

  async resolveIndeterminateMonitor(
    target: string,
    input: Parameters<BuiltinScheduler['resolveIndeterminateMonitor']>[1],
  ): Promise<string> {
    const provider = await this.findJobProvider(target);
    if (provider !== this.builtin)
      throw new Error(`Job '${target}' monitor cannot be resolved`);
    return this.builtin.resolveIndeterminateMonitor(target, input);
  }

  async getJobLogs(
    target: string,
    count?: number,
  ): Promise<SchedulerLogEntry[]> {
    const p = await this.findJobProvider(target);
    return p.getJobLogs(target, count);
  }

  async getJobLogsForProvider(
    providerId: string,
    target: string,
    count?: number,
  ): Promise<SchedulerLogEntry[]> {
    return this.getProvider(providerId).getJobLogs(target, count);
  }

  async listRunSummaries(filters?: {
    providerId?: string;
    sourceId?: string;
  }): Promise<RunSummary[]> {
    const providers = filters?.providerId
      ? [this.getProvider(filters.providerId)]
      : [...this.providers.values()];

    const runs = (
      await Promise.all(
        providers.map(async (provider) => {
          if (provider.listRunLogs) {
            const logs = await provider.listRunLogs();
            return logs
              .filter(
                (log) => !filters?.sourceId || log.job === filters.sourceId,
              )
              .map((log) => projectSchedulerLogToRun(provider.id, log));
          }
          // SchedulerLedger storage faults are part of the caller-visible
          // Interface.  Hiding them as an empty run list would turn an
          // unavailable durable receipt into a false "no runs" projection.
          const jobs = await provider.listJobs();
          const matchingJobs = filters?.sourceId
            ? jobs.filter((job) => job.name === filters.sourceId)
            : jobs;
          const jobRuns = await Promise.all(
            matchingJobs.map(async (job) => {
              const logs = await provider.getJobLogs(job.name);
              return logs.map((log) =>
                projectSchedulerLogToRun(provider.id, log),
              );
            }),
          );
          return jobRuns.flat();
        }),
      )
    ).flat();

    return runs.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  async readRunSummary(runId: string): Promise<RunSummary | null> {
    const parsed = parseScheduleRunId(runId);
    if (!parsed) return null;
    const provider = this.getProvider(parsed.providerId);
    const logs = provider.listRunLogs
      ? await provider.listRunLogs()
      : await provider.getJobLogs(parsed.jobName);
    const log = logs.find((entry) => entry.id === parsed.logId);
    return log ? projectSchedulerLogToRun(parsed.providerId, log) : null;
  }

  async readOutputRef(ref: RunOutputRef): Promise<string> {
    if (ref.source !== 'schedule') {
      throw new Error(`Unsupported run output source '${ref.source}'`);
    }
    const parsed = parseScheduleRunId(ref.runId);
    if (!parsed || parsed.providerId !== ref.providerId) {
      throw new Error('Invalid schedule run output reference');
    }
    const run = await this.readRunSummary(ref.runId);
    if (!run?.outputRef || run.outputRef.artifactId !== ref.artifactId) {
      throw new Error('Run output reference not found');
    }
    const parsedRun = parseScheduleRunId(ref.runId);
    if (!parsedRun) {
      throw new Error('Invalid schedule run output reference');
    }
    const logsProvider = this.getProvider(parsedRun.providerId);
    const logs = logsProvider.listRunLogs
      ? await logsProvider.listRunLogs()
      : await logsProvider.getJobLogs(parsedRun.jobName);
    const log = logs.find((entry) => entry.id === parsedRun.logId);
    if (!log?.output) {
      throw new Error('Run output not found');
    }
    const provider = this.getProvider(ref.providerId);
    if (!provider.readRunFile) {
      throw new Error(
        `Scheduler provider '${ref.providerId}' cannot read run output`,
      );
    }
    return provider.readRunFile(log.output);
  }

  /**
   * #1536 D1: `timezone` is the whole point of this signature. A cron
   * expression alone is evaluated as UTC by `nextOccurrences`, so previewing a
   * ZONED schedule without it returned the wrong instants — the Add Job form
   * showed "Tue 2:00 AM MDT" for a job that fires Mon 8:00 AM MDT. Absent
   * still means UTC, which is what an unzoned job actually does.
   */
  async previewSchedule(
    cron: string,
    count = 5,
    timezone?: string,
  ): Promise<string[]> {
    const schedule: Schedule = {
      kind: 'cron',
      expr: cron,
      ...(timezone ? { timezone } : {}),
    };
    return nextOccurrences(schedule, count, Date.now()).map((ms) =>
      new Date(ms).toISOString(),
    );
  }

  // ── SSE ──

  subscribe(send: (data: string) => void): () => void {
    const localUnsub = this.sse.subscribe(send);
    const unsubs = [...this.providers.values()]
      .map((p) => p.subscribe?.(send))
      .filter(Boolean) as (() => void)[];
    return () => {
      localUnsub();
      unsubs.forEach((u) => u());
    };
  }

  broadcast(event: Record<string, unknown>) {
    this.sse.broadcast(event);
  }
}

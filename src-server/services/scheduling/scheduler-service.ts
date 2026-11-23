/**
 * Scheduler Service — multi-provider router.
 * Aggregates jobs/stats from all registered providers.
 * Routes CRUD to the provider that owns each job.
 */

import {
  nextOccurrence,
  nextOccurrences,
  type Schedule,
  validateSchedule,
} from '@kontourai/ephemeris';
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
  SchedulerJobNotFoundError,
} from './builtin-scheduler.js';

export interface SchedulerServiceOptions {
  logger: Logger;
  builtin: Omit<BuiltinSchedulerOptions, 'logger'>;
}

/**
 * A caller-supplied schedule the projector cannot evaluate — a bad cron field
 * or an unknown IANA zone. Distinct from a storage or conflict failure because
 * the answer is 400: nothing on the server is wrong (#1536 R3).
 */
export class SchedulerScheduleInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchedulerScheduleInvalidError';
  }
}

type SchedulerMutationJob = Pick<
  SchedulerJob,
  'provider' | 'unattendedPrincipal'
>;

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
   * a `logger.child()` with its own opaque job and run identifiers.
   */
  constructor({ logger, builtin }: SchedulerServiceOptions) {
    this.builtin = new BuiltinScheduler({ logger, ...builtin });
    this.builtin.start();
    this.providers.set(this.builtin.id, this.builtin);
  }

  async stop(): Promise<void> {
    await this.builtin.stop();
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

  private async providerForMutation(
    target: string,
    job: SchedulerMutationJob | undefined,
  ): Promise<ISchedulerProvider> {
    if (!job) return this.findJobProvider(target);
    const provider = this.getProvider(job.provider);
    if (provider === this.builtin && !job.unattendedPrincipal?.jobId)
      throw new SchedulerJobNotFoundError(target);
    return provider;
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

  /** Forecast each displayed day independently, using the stored schedule to find instants. */
  projectWeek(
    jobs: SchedulerJob[],
    weekStart: string,
    displayZone = 'UTC',
  ): SchedulerJob[] {
    const monday = Date.parse(weekStart + 'T00:00:00.000Z');
    if (
      !Number.isFinite(monday) ||
      new Date(monday).toISOString().slice(0, 10) !== weekStart ||
      new Date(monday).getUTCDay() !== 1
    )
      throw new SchedulerScheduleInvalidError(
        'Schedule week must start on a Monday (YYYY-MM-DD).',
      );
    let dates: Intl.DateTimeFormat;
    try {
      dates = new Intl.DateTimeFormat('en', {
        timeZone: displayZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
    } catch {
      throw new SchedulerScheduleInvalidError('Display time zone is invalid.');
    }
    const dayMs = 86_400_000;
    const boundaries = Array.from({ length: 8 }, (_, index) => {
      const day = monday + index * dayMs;
      const key = new Date(day).toISOString().slice(0, 10);
      let lower = day - dayMs;
      let upper = day + dayMs;
      while (upper - lower > 1) {
        const midpoint = lower + Math.floor((upper - lower) / 2);
        const fields = dates.formatToParts(midpoint);
        const field = (type: string) =>
          fields.find((part) => part.type === type)?.value;
        const localDate = [field('year'), field('month'), field('day')].join(
          '-',
        );
        if (localDate < key) lower = midpoint;
        else upper = midpoint;
      }
      return upper;
    });
    return jobs.map((job) => {
      const schedule =
        job.schedule ??
        (job.cron ? { kind: 'cron' as const, expr: job.cron } : undefined);
      const times: string[] = [];
      let truncated = false;
      if (!job.enabled || !schedule || validateSchedule(schedule))
        return { ...job, weekOccurrences: { times, truncated } };
      for (let day = 0; day < 7; day += 1) {
        const start = boundaries[day]!;
        const end = boundaries[day + 1]!;
        let next: number | null;
        if (schedule.kind === 'every') {
          const anchor = Date.parse(job.nextRun ?? '');
          next = Number.isFinite(anchor)
            ? anchor +
              Math.max(0, Math.ceil((start - anchor) / schedule.everyMs)) *
                schedule.everyMs
            : null;
        } else {
          next = nextOccurrence(schedule, start - 1);
        }
        for (
          let count = 0;
          next !== null && next < end && count < 8;
          count += 1
        ) {
          times.push(new Date(next).toISOString());
          const subsequent = nextOccurrence(schedule, next);
          next = subsequent !== null && subsequent > next ? subsequent : null;
        }
        truncated ||= next !== null && next < end;
      }
      return { ...job, weekOccurrences: { times, truncated } };
    });
  }

  readBuiltinRowIssues() {
    return this.builtin.readRowIssues();
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

  /**
   * Create a job and answer the slug it was stored under: the built-in
   * scheduler may pick one from the display name. Another provider stores
   * the slug it was given.
   */
  async createJob(
    opts: AddJobOpts,
  ): Promise<{ readonly output: string; readonly name: string }> {
    const providerId = opts.provider || this.builtin.id;
    if (providerId === this.builtin.id) return this.builtin.createJob(opts);
    if (!opts.name) throw new Error('Job name is required');
    return {
      output: await this.getProvider(providerId).addJob(opts),
      name: opts.name,
    };
  }

  async editJob(
    target: string,
    opts: Record<string, unknown>,
    job?: SchedulerMutationJob,
  ): Promise<string> {
    const p = await this.providerForMutation(target, job);
    return p === this.builtin
      ? this.builtin.editJob(target, opts, job?.unattendedPrincipal?.jobId)
      : p.editJob(target, opts);
  }

  async removeJob(target: string, job?: SchedulerMutationJob): Promise<void> {
    const p = await this.providerForMutation(target, job);
    return p === this.builtin
      ? this.builtin.removeJob(target, job?.unattendedPrincipal?.jobId)
      : p.removeJob(target);
  }

  async runJob(
    target: string,
    job?: SchedulerMutationJob,
  ): Promise<SchedulerManualRunReceipt> {
    const p = await this.providerForMutation(target, job);
    return p === this.builtin
      ? this.builtin.runJob(target, job?.unattendedPrincipal?.jobId)
      : p.runJob(target);
  }

  prepareStarterManualIntent(operationId: string): PreparedStarterScheduledRun {
    return this.builtin.prepareStarterManualIntent(operationId);
  }

  async enableJob(target: string, job?: SchedulerMutationJob): Promise<void> {
    const p = await this.providerForMutation(target, job);
    return p === this.builtin
      ? this.builtin.enableJob(target, job?.unattendedPrincipal?.jobId)
      : p.enableJob(target);
  }

  async disableJob(target: string, job?: SchedulerMutationJob): Promise<void> {
    const p = await this.providerForMutation(target, job);
    return p === this.builtin
      ? this.builtin.disableJob(target, job?.unattendedPrincipal?.jobId)
      : p.disableJob(target);
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
    // #1536 R3: `nextOccurrences` throws a RangeError on an unknown IANA zone,
    // which reached the route as a 500 — an operator's typo reported as a
    // server fault. Validated HERE, once, so every caller is covered (the HTTP
    // route AND the MCP operator tool), with the same `validateSchedule` the
    // add path uses so the two cannot disagree about what a valid schedule is.
    const invalid = validateSchedule(schedule);
    if (invalid !== null) {
      throw new SchedulerScheduleInvalidError(`Invalid schedule: ${invalid}`);
    }
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

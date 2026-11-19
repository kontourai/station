import { MS_PER_DAY, MS_PER_MINUTE } from '@kontourai/station-contracts/time';
import type { FeaturePreviewSelector } from '../../services/feature-previews/feature-preview-registry.js';
import type { EventStore } from '../../services/orchestration/event-store.js';
import {
  toolProgressCompactionBytes,
  toolProgressCompactionDuration,
  toolProgressCompactionPasses,
  toolProgressCompactionRows,
} from '../../telemetry/metrics.js';
import { errorMessage } from '../../utils/error-message.js';

/**
 * Schedule for `tool.progress` compaction
 * (docs/decisions/tool-progress-compaction.md, #5078).
 *
 * Same shape as the store integrity verification beside it: a timer pushed
 * onto the runtime's `timers`, cleared by `shutdownRuntimeServices`, plus a
 * disposer that stops a pass in flight. Work happens off the request path,
 * in EventStore's small per-thread transactions.
 *
 * Two switches must both allow a pass, and both are read at every pass: the
 * `tool-progress-compaction` Feature Preview (off by default) and the
 * `STATION_TOOL_PROGRESS_COMPACTION=off` kill switch, which wins.
 */

const INTERVAL_MS = 30 * MS_PER_MINUTE;
/** Keep the first pass away from startup work. */
const FIRST_PASS_DELAY_MS = 10 * MS_PER_MINUTE;
const DEFAULT_MIN_AGE_DAYS = 30;
const MAX_MIN_AGE_DAYS = 3650;
/** Rows one pass may delete; a backlog drains over several passes. */
const MAX_ROWS_PER_PASS = 5_000;

type PassOutcome =
  | 'completed'
  | 'partial'
  | 'budget_exhausted'
  | 'disabled'
  | 'killed'
  | 'skipped_running'
  | 'failed';

interface Logger {
  info: (message: string, metadata?: Record<string, unknown>) => void;
  warn: (message: string, metadata?: Record<string, unknown>) => void;
}

/**
 * `STATION_TOOL_PROGRESS_COMPACTION_MIN_AGE_DAYS`: whole days from 1 to
 * 3650. Anything else keeps the 30-day default.
 */
function minAgeDays(env: NodeJS.ProcessEnv): number {
  const raw = env.STATION_TOOL_PROGRESS_COMPACTION_MIN_AGE_DAYS;
  if (raw === undefined || !/^\d+$/.test(raw.trim()))
    return DEFAULT_MIN_AGE_DAYS;
  const days = Number(raw.trim());
  return days >= 1 && days <= MAX_MIN_AGE_DAYS ? days : DEFAULT_MIN_AGE_DAYS;
}

function killed(env: NodeJS.ProcessEnv): boolean {
  const value = env.STATION_TOOL_PROGRESS_COMPACTION?.trim().toLowerCase();
  return value === 'off' || value === '0';
}

export function startToolProgressCompaction(context: {
  timers: NodeJS.Timeout[];
  eventStore: Pick<EventStore, 'compactSettledToolProgress'>;
  preview: FeaturePreviewSelector;
  logger: Logger;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  scheduleTimeout?: typeof setTimeout;
  scheduleInterval?: typeof setInterval;
}): { stop: () => void; runPass: () => Promise<PassOutcome> } {
  const env = context.env ?? process.env;
  const now = context.now ?? Date.now;
  const teardown = new AbortController();
  let running = false;

  const runPass = async (): Promise<PassOutcome> => {
    if (killed(env)) return record('killed');
    if (!context.preview.select({ enabled: () => true, disabled: () => false }))
      return record('disabled');
    if (running) return record('skipped_running');
    running = true;
    const startedAt = performance.now();
    try {
      const cutoff = new Date(now() - minAgeDays(env) * MS_PER_DAY);
      const pass = await context.eventStore.compactSettledToolProgress({
        cutoff: cutoff.toISOString(),
        maxRows: MAX_ROWS_PER_PASS,
        signal: teardown.signal,
      });
      toolProgressCompactionRows.add(pass.rowsDeleted, { table: 'events' });
      toolProgressCompactionRows.add(pass.contentRowsDeleted, {
        table: 'content',
      });
      toolProgressCompactionBytes.add(pass.payloadBytes, { table: 'events' });
      toolProgressCompactionBytes.add(pass.contentBytes, { table: 'content' });
      const outcome: PassOutcome = pass.budgetExhausted
        ? 'budget_exhausted'
        : pass.cycleCompleted
          ? 'completed'
          : 'partial';
      if (pass.rowsDeleted > 0)
        context.logger.info('Compacted superseded tool progress rows', {
          outcome,
          threads: pass.threads,
          rows: pass.rowsDeleted,
          payloadBytes: pass.payloadBytes,
          contentRows: pass.contentRowsDeleted,
          contentBytes: pass.contentBytes,
        });
      return record(outcome);
    } catch (error) {
      context.logger.warn('Tool progress compaction pass failed', {
        error: errorMessage(error),
      });
      return record('failed');
    } finally {
      toolProgressCompactionDuration.record(performance.now() - startedAt);
      running = false;
    }
  };

  const tick = () => {
    void runPass();
  };
  const scheduleTimeout = context.scheduleTimeout ?? setTimeout;
  const scheduleInterval = context.scheduleInterval ?? setInterval;
  context.timers.push(
    scheduleTimeout(() => {
      tick();
      context.timers.push(scheduleInterval(tick, INTERVAL_MS));
    }, FIRST_PASS_DELAY_MS),
  );
  return { stop: () => teardown.abort(), runPass };
}

function record(outcome: PassOutcome): PassOutcome {
  toolProgressCompactionPasses.add(1, { outcome });
  return outcome;
}

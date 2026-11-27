/**
 * Who reads the session read model, how often, and what each read costs
 * (#4992). Recorded through the Station meter and kept as a small
 * per-purpose running total, so the numbers can also be read without an
 * OpenTelemetry collector (the diagnostics bundle carries the snapshot).
 *
 * Bounded by construction: one entry per declared purpose, and the purpose
 * is projected onto its closed vocabulary before it is recorded anywhere.
 */
import {
  sessionReadModelDuration,
  sessionReadModelReads,
  sessionReadModelThreads,
} from '../../telemetry/metrics.js';
import type { SessionProjectionCacheOutcome } from './event-store.js';
import {
  SESSION_READ_MODEL_PURPOSES,
  type SessionReadModelPurpose,
} from './session-read-model-purpose.js';

export interface SessionReadModelReadSample {
  purpose: SessionReadModelPurpose;
  scope: 'all' | 'threads';
  totalMs: number;
  buildMs: number;
  threadsConsidered: number;
  projection?: SessionProjectionCacheOutcome;
  count?: SessionProjectionCacheOutcome;
}

export interface SessionReadModelPurposeTotals {
  reads: number;
  /** Reads narrowed with `threadIds`. */
  threadScopedReads: number;
  totalMs: number;
  maxTotalMs: number;
  buildMs: number;
  maxBuildMs: number;
  threadsConsidered: number;
  projectionRefolded: number;
  projectionReused: number;
  countRefreshed: number;
  countReused: number;
}

export interface SessionReadModelMeasurementSnapshot {
  /** When these totals started (this process's first read). */
  since: string;
  observedAt: string;
  /** Only purposes read at least once. */
  byPurpose: Partial<
    Record<SessionReadModelPurpose | 'invalid', SessionReadModelPurposeTotals>
  >;
}

const PURPOSES: ReadonlySet<string> = new Set(SESSION_READ_MODEL_PURPOSES);

function boundedPurpose(value: unknown): SessionReadModelPurpose | 'invalid' {
  return typeof value === 'string' && PURPOSES.has(value)
    ? (value as SessionReadModelPurpose)
    : 'invalid';
}

function emptyTotals(): SessionReadModelPurposeTotals {
  return {
    reads: 0,
    threadScopedReads: 0,
    totalMs: 0,
    maxTotalMs: 0,
    buildMs: 0,
    maxBuildMs: 0,
    threadsConsidered: 0,
    projectionRefolded: 0,
    projectionReused: 0,
    countRefreshed: 0,
    countReused: 0,
  };
}

export class SessionReadModelMeasurement {
  private readonly totals = new Map<
    SessionReadModelPurpose | 'invalid',
    SessionReadModelPurposeTotals
  >();
  private since: string | undefined;

  constructor(private readonly now: () => Date = () => new Date()) {}

  record(sample: SessionReadModelReadSample): void {
    const purpose = boundedPurpose(sample.purpose);
    const scope = sample.scope === 'threads' ? 'threads' : 'all';
    sessionReadModelReads.add(1, { purpose, scope });
    sessionReadModelDuration.record(sample.totalMs, {
      purpose,
      phase: 'total',
    });
    sessionReadModelDuration.record(sample.buildMs, {
      purpose,
      phase: 'build',
    });
    const threads = (outcome: string, value: number) =>
      sessionReadModelThreads.record(value, { purpose, outcome });
    threads('considered', sample.threadsConsidered);
    if (sample.projection) {
      threads('projection_refolded', sample.projection.refreshed);
      threads('projection_reused', sample.projection.reused);
    }
    if (sample.count) {
      threads('count_refreshed', sample.count.refreshed);
      threads('count_reused', sample.count.reused);
    }

    this.since ??= this.now().toISOString();
    let totals = this.totals.get(purpose);
    if (!totals) {
      totals = emptyTotals();
      this.totals.set(purpose, totals);
    }
    totals.reads += 1;
    if (scope === 'threads') totals.threadScopedReads += 1;
    totals.totalMs += sample.totalMs;
    totals.maxTotalMs = Math.max(totals.maxTotalMs, sample.totalMs);
    totals.buildMs += sample.buildMs;
    totals.maxBuildMs = Math.max(totals.maxBuildMs, sample.buildMs);
    totals.threadsConsidered += sample.threadsConsidered;
    totals.projectionRefolded += sample.projection?.refreshed ?? 0;
    totals.projectionReused += sample.projection?.reused ?? 0;
    totals.countRefreshed += sample.count?.refreshed ?? 0;
    totals.countReused += sample.count?.reused ?? 0;
  }

  snapshot(): SessionReadModelMeasurementSnapshot {
    const observedAt = this.now().toISOString();
    return {
      since: this.since ?? observedAt,
      observedAt,
      byPurpose: Object.fromEntries(
        [...this.totals].map(([purpose, totals]) => [
          purpose,
          {
            ...totals,
            totalMs: Math.round(totals.totalMs * 10) / 10,
            maxTotalMs: Math.round(totals.maxTotalMs * 10) / 10,
            buildMs: Math.round(totals.buildMs * 10) / 10,
            maxBuildMs: Math.round(totals.maxBuildMs * 10) / 10,
          },
        ]),
      ),
    };
  }
}

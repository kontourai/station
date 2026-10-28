import { monitorEventLoopDelay, PerformanceObserver } from 'node:perf_hooks';
import { MS_PER_MINUTE } from '@kontourai/station-contracts/time';
import { getCachedUser } from '../../routes/system/auth.js';
import { runtimeEventLoopLag } from '../../telemetry/metrics.js';

const EVENT_LOOP_LAG_SAMPLE_INTERVAL_MS = 10_000;
/** A stall this long makes a request miss the desktop transport's budgets
 * and read as a disconnect (#2327), so it belongs in the durable log. */
export const EVENT_LOOP_STALL_WARN_MS = 1_000;
/**
 * How long a stall report waits for the stall's own GC entries. Node queues a
 * `gc` performance entry for delivery after the loop resumes, so the tick
 * that ends a GC-bound stall runs before the entries for that GC arrive.
 */
export const EVENT_LOOP_STALL_REPORT_DELAY_MS = 250;
const NS_PER_MS = 1e6;
const US_PER_MS = 1e3;
const BYTES_PER_MB = 1024 * 1024;

/** The subset of Node's `IntervalHistogram` the stall reporter reads. */
export interface EventLoopDelayHistogram {
  enable(): void;
  reset(): void;
  readonly max: number;
  percentile(percentile: number): number;
}

/** Cumulative process counters plus current memory, read at each tick. */
export interface RuntimeResourceSample {
  cpuUserMicros: number;
  cpuSystemMicros: number;
  majorPageFaults: number;
  rssBytes: number;
  heapUsedBytes: number;
}

function sampleRuntimeResources(): RuntimeResourceSample {
  const usage = process.resourceUsage();
  const memory = process.memoryUsage();
  return {
    cpuUserMicros: usage.userCPUTime,
    cpuSystemMicros: usage.systemCPUTime,
    majorPageFaults: usage.majorPageFault,
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
  };
}

/**
 * Calls `onGc` with each GC's start (performance clock) and main-thread pause.
 * Like the delay histogram, the observer is never disconnected: runtime
 * teardown clears only timers, so it keeps the monitor's closure (logger and
 * fixed-size window totals) alive for the life of the process.
 */
function observeGarbageCollection(
  onGc: (startTime: number, durationMs: number) => void,
): void {
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      onGc(entry.startTime, entry.duration);
    }
  }).observe({ entryTypes: ['gc'] });
}

interface RuntimeHealthContext {
  activeAgents: Map<string, any>;
  agentSpecs: Map<string, any>;
  memoryAdapters: Map<string, unknown>;
  mcpConnectionStatus: Map<string, { connected: boolean; error?: string }>;
  integrationMetadata: Map<
    string,
    { type: string; transport?: string; toolCount?: number }
  >;
  monitoringEmitter: {
    emitHealth: (payload: {
      slug: string;
      userId: string;
      traceId: string;
      healthy: boolean;
      checks: Record<string, boolean>;
      integrations?: Array<{
        id: string;
        type: string;
        connected: boolean;
        metadata?: { transport?: string; toolCount?: number };
      }>;
    }) => void;
    flush?: () => Promise<void>;
  };
}

export async function runRuntimeHealthChecks(
  context: RuntimeHealthContext,
): Promise<void> {
  for (const [slug, agent] of context.activeAgents.entries()) {
    const checks: Record<string, boolean> = {
      loaded: true,
      hasModel: !!agent.model,
      hasMemory: context.memoryAdapters.has(slug),
    };

    const spec = context.agentSpecs.get(slug);
    const integrations: Array<{
      id: string;
      type: string;
      connected: boolean;
      metadata?: { transport?: string; toolCount?: number };
    }> = [];

    if (spec?.tools?.mcpServers && spec.tools.mcpServers.length > 0) {
      checks.integrationsConfigured = true;

      for (const id of spec.tools.mcpServers) {
        const status = context.mcpConnectionStatus.get(id);
        const metadata = context.integrationMetadata.get(id);

        integrations.push({
          id,
          type: metadata?.type || 'mcp',
          connected: status?.connected === true,
          metadata: metadata
            ? {
                transport: metadata.transport,
                toolCount: metadata.toolCount,
              }
            : undefined,
        });
      }

      checks.integrationsConnected = integrations.every(
        (integration) => integration.connected,
      );
    }

    const healthy = Object.values(checks).every(Boolean);
    const traceId = `health:${slug}:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`;

    context.monitoringEmitter.emitHealth({
      slug,
      userId: getCachedUser().alias,
      traceId,
      healthy,
      checks,
      integrations,
    });
  }

  await context.monitoringEmitter.flush?.();
}

export async function startRuntimeHealthChecks(context: {
  timers: NodeJS.Timeout[];
  logger: {
    debug: (message: string, metadata?: Record<string, unknown>) => void;
    warn: (message: string, metadata?: Record<string, unknown>) => void;
  };
  interval?: number;
  runHealthChecks: () => Promise<void>;
}): Promise<void> {
  startRuntimeEventLoopLagMonitoring({
    timers: context.timers,
    logger: context.logger,
  });
  const interval = context.interval ?? MS_PER_MINUTE;
  const runHealthChecks = async () => {
    await context.runHealthChecks();
  };

  await runHealthChecks();
  context.timers.push(setInterval(runHealthChecks, interval));
  context.logger.debug('Health checks started', { interval });
}

/**
 * Observe how far a periodic monotonic timer wakes after its expected time.
 * A stalled event loop cannot run the callback until it is unstalled, so the
 * delay is the direct signal needed to distinguish a loaded runtime from a
 * dead listener. The timer belongs to the runtime's existing teardown list.
 *
 * The sampled lag only sees a stall that overlaps a tick, and the metric is
 * exported only when an OTel endpoint is configured. A delay histogram covers
 * the whole window, and a stall of `EVENT_LOOP_STALL_WARN_MS` or more is
 * written to the durable log so it can be read, and lined up against the
 * request lines around it, on any install (#2327).
 *
 * The delay alone does not say what held the loop, so a stall line also
 * carries what this process did during that window: CPU time, major page
 * faults, and GC pauses, plus memory at the tick. These are leads, not a
 * verdict. CPU time is the whole process's, across worker and helper threads
 * as well as the event loop. GC totals are main-thread pause wall time, so a
 * GC total close to the stall points at collection. Many major page faults
 * mean the process waited on pages read from disk (swap, or evicted code and
 * mapped files). Little CPU time and few faults point at a call that blocked
 * without computing (a synchronous child process, file read, or lock wait), or
 * at a host that ran other work instead.
 */
export function startRuntimeEventLoopLagMonitoring(context: {
  timers: NodeJS.Timeout[];
  logger: {
    debug: (message: string, metadata?: Record<string, unknown>) => void;
    warn?: (message: string, metadata?: Record<string, unknown>) => void;
  };
  interval?: number;
  now?: () => number;
  scheduleInterval?: (callback: () => void, interval: number) => NodeJS.Timeout;
  recordLag?: (lagMs: number) => void;
  delayHistogram?: EventLoopDelayHistogram;
  sampleResources?: () => RuntimeResourceSample;
  /** Subscribes to GC pauses timed on the same clock as `now`. */
  observeGc?: (onGc: (startTime: number, durationMs: number) => void) => void;
  scheduleReport?: (report: () => void, delayMs: number) => void;
}): void {
  const interval = context.interval ?? EVENT_LOOP_LAG_SAMPLE_INTERVAL_MS;
  if (!Number.isSafeInteger(interval) || interval <= 0) {
    throw new Error(
      'Event-loop lag sample interval must be a positive integer',
    );
  }
  const now = context.now ?? (() => performance.now());
  const observedAtStart = now();
  if (!Number.isFinite(observedAtStart)) {
    throw new Error('Event-loop lag clock returned a non-finite value');
  }
  const recordLag =
    context.recordLag ?? ((lagMs) => runtimeEventLoopLag.record(lagMs));
  const scheduleInterval = context.scheduleInterval ?? setInterval;
  const delayHistogram =
    context.delayHistogram ?? monitorEventLoopDelay({ resolution: 20 });
  const sampleResources = context.sampleResources ?? sampleRuntimeResources;
  const observeGc = context.observeGc ?? observeGarbageCollection;
  const scheduleReport =
    context.scheduleReport ??
    ((report, delayMs) => setTimeout(report, delayMs).unref());
  delayHistogram.enable();
  let expectedAt = observedAtStart + interval;
  let resourcesAtWindowStart = sampleResources();
  // GC totals are kept per window, not as a list of entries, so they stay
  // constant-size even if ticks stop. An entry is credited to the window its
  // GC started in: a stalled window waiting for its report, else the open one.
  let openGc = emptyGcWindow(observedAtStart);
  let reportingGc: GcWindow | undefined;
  observeGc((startTime, durationMs) => {
    if (
      reportingGc &&
      startTime >= reportingGc.start &&
      startTime < reportingGc.end
    ) {
      addGc(reportingGc, durationMs);
    } else if (startTime >= openGc.start) {
      addGc(openGc, durationMs);
    }
  });
  const timer = scheduleInterval(() => {
    const observedAt = now();
    if (!Number.isFinite(observedAt)) {
      throw new Error('Event-loop lag clock returned a non-finite value');
    }
    // A timer can wake fractionally early; that is not negative lag. Resetting
    // from the observed time avoids converting one long stall into a false
    // series of delayed samples after the loop is responsive again.
    const lagMs = Math.max(0, observedAt - expectedAt);
    recordLag(lagMs);
    expectedAt = observedAt + interval;
    const resources = sampleResources();
    const windowStart = resourcesAtWindowStart;
    resourcesAtWindowStart = resources;
    const gc = openGc;
    gc.end = observedAt;
    openGc = emptyGcWindow(observedAt);
    const maxDelayMs = delayHistogram.max / NS_PER_MS;
    if (maxDelayMs >= EVENT_LOOP_STALL_WARN_MS) {
      const stall = {
        maxDelayMs: Math.round(maxDelayMs),
        p99DelayMs: Math.round(delayHistogram.percentile(99) / NS_PER_MS),
        windowMs: interval,
        // The span the counters below cover: a stall stretches it past
        // `windowMs`.
        elapsedMs: Math.round(observedAt - gc.start),
        cpuUserMs: Math.round(
          (resources.cpuUserMicros - windowStart.cpuUserMicros) / US_PER_MS,
        ),
        cpuSystemMs: Math.round(
          (resources.cpuSystemMicros - windowStart.cpuSystemMicros) / US_PER_MS,
        ),
        majorPageFaults:
          resources.majorPageFaults - windowStart.majorPageFaults,
        rssMb: Math.round(resources.rssBytes / BYTES_PER_MB),
        heapUsedMb: Math.round(resources.heapUsedBytes / BYTES_PER_MB),
      };
      reportingGc = gc;
      scheduleReport(() => {
        if (reportingGc === gc) reportingGc = undefined;
        context.logger.warn?.('Event loop stalled', {
          ...stall,
          gcCount: gc.count,
          gcTotalMs: Math.round(gc.totalMs),
          gcMaxMs: Math.round(gc.maxMs),
        });
      }, EVENT_LOOP_STALL_REPORT_DELAY_MS);
    }
    delayHistogram.reset();
  }, interval);
  context.timers.push(timer);
  context.logger.debug('Event-loop lag monitoring started', { interval });
}

interface GcWindow {
  start: number;
  end: number;
  count: number;
  totalMs: number;
  maxMs: number;
}

function emptyGcWindow(start: number): GcWindow {
  return {
    start,
    end: Number.POSITIVE_INFINITY,
    count: 0,
    totalMs: 0,
    maxMs: 0,
  };
}

function addGc(window: GcWindow, durationMs: number): void {
  window.count += 1;
  window.totalMs += durationMs;
  window.maxMs = Math.max(window.maxMs, durationMs);
}

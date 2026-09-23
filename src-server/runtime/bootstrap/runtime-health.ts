import { monitorEventLoopDelay } from 'node:perf_hooks';
import { MS_PER_MINUTE } from '@kontourai/station-contracts/time';
import { getCachedUser } from '../../routes/system/auth.js';
import { runtimeEventLoopLag } from '../../telemetry/metrics.js';

const EVENT_LOOP_LAG_SAMPLE_INTERVAL_MS = 10_000;
/** A stall this long makes a request miss the desktop transport's budgets
 * and read as a disconnect (#2327), so it belongs in the durable log. */
export const EVENT_LOOP_STALL_WARN_MS = 1_000;
const NS_PER_MS = 1e6;

/** The subset of Node's `IntervalHistogram` the stall reporter reads. */
export interface EventLoopDelayHistogram {
  enable(): void;
  reset(): void;
  readonly max: number;
  percentile(percentile: number): number;
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
  delayHistogram.enable();
  let expectedAt = observedAtStart + interval;
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
    const maxDelayMs = delayHistogram.max / NS_PER_MS;
    if (maxDelayMs >= EVENT_LOOP_STALL_WARN_MS) {
      context.logger.warn?.('Event loop stalled', {
        maxDelayMs: Math.round(maxDelayMs),
        p99DelayMs: Math.round(delayHistogram.percentile(99) / NS_PER_MS),
        windowMs: interval,
      });
    }
    delayHistogram.reset();
  }, interval);
  context.timers.push(timer);
  context.logger.debug('Event-loop lag monitoring started', { interval });
}

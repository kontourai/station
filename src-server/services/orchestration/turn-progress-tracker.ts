import type { AgentExecutionConfig } from '@kontourai/station-contracts/agent';
import type { TurnProgressObservation } from '@kontourai/station-contracts/orchestration';
import type { ProviderKind } from '@kontourai/station-contracts/provider';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { resolveTurnStallWindowMs } from '@kontourai/station-contracts/turn-stall-window';
import { orchestrationTurnStallDetections } from '../../telemetry/metrics.js';
import { TurnStallWatchdog } from './turn-stall-watchdog.js';

export interface TurnProgressTrackerDeps {
  /**
   * `sessionAdapters.get(threadId)?.provider` — undefined means the thread
   * has no live adapter in this process, and a stall on it is not reportable.
   * (`ProviderKind` is an open string type; an adapter registered with an
   * empty-string provider would read as adapter-absent here. None exists,
   * and the pre-extraction adapter-existence check had the same blind spot
   * one step later at the telemetry attribute.)
   */
  providerForThread: (threadId: string) => ProviderKind | undefined;
  loadAgentExecutionConfig?: (
    agentSlug: string,
  ) => Promise<AgentExecutionConfig | undefined>;
  /** Emits the session-projection-updated bus event for one thread. */
  publishProjectionChange: (threadId: string) => void;
  logger: {
    warn: (message: string, meta?: Record<string, unknown>) => void;
  };
}

/**
 * Turn progress and turn-stall observation, extracted from
 * `OrchestrationService` as epic #4024 slice 1 (#4116). The seam map
 * (`docs/design/orchestration-decomposition-map.md` §7) records why this
 * cluster went first: its three fields are the only shared state in the
 * service with a single-writer/many-reader split, and nothing outside the
 * service file reaches it.
 *
 * Behavioral contracts carried over verbatim — do not "improve" them here:
 *
 * - station#2959: `observe` is fed from the RAW event stream. Progress is a
 *   fact about the engine producing output, so delta batching for
 *   persistence (station#3350) must not make a healthy fast turn look
 *   silent. The caller keeps both call sites and the `isCoalescableDelta`
 *   guard (seam map T5).
 * - Stall handling is OBSERVE-ONLY by review decision (#2959): detection
 *   emits telemetry and a warn line, and terminates nothing. Independent
 *   review found the termination decision rested on an event vocabulary
 *   three real cases fall outside of — a turn awaiting human approval, long
 *   silent tool runs on adapters that emit nothing mid-tool, and heartbeat
 *   frames counting as progress. The per-provider counter measures the real
 *   false-positive rate BEFORE termination is enabled per-adapter
 *   (follow-up issue); the dormant `initiatedBy: 'stall'` plumbing stays in
 *   the service for that follow-up.
 * - station#4054: the progress observation is intentionally not an
 *   event-store field. It describes this live process's narrow progress
 *   vocabulary and disappears when the watch clears.
 */
export class TurnProgressTracker {
  private readonly watchdog = new TurnStallWatchdog();
  /** Per-thread resolved turn-stall window, set once at session start. */
  private readonly windowByThread = new Map<string, number>();
  private readonly progressByThread = new Map<
    string,
    TurnProgressObservation & { turnId: string }
  >();

  constructor(private readonly deps: TurnProgressTrackerDeps) {}

  /** Feed one raw runtime event into the stall watchdog. */
  observe(event: CanonicalRuntimeEvent): void {
    this.watchdog.observe(
      {
        method: event.method,
        threadId: event.threadId,
        turnId: event.turnId,
        provider: event.provider,
        createdAt: event.createdAt,
        // station#3451 finding 4/6: only a `runtime.error` carries this — the
        // watchdog needs it to tell a genuine terminal failure (clear the
        // watch) from a codex deferred-retriable one (keep timing; the retry
        // may still be silently stuck).
        retriable:
          event.method === 'runtime.error' ? event.retriable : undefined,
        isStateTransition: Boolean(
          event.previousState &&
            event.sessionState &&
            event.previousState !== event.sessionState,
        ),
      },
      this.windowByThread.get(event.threadId) ?? resolveTurnStallWindowMs(),
      {
        onStall: (threadId, turnId) => this.handleTurnStall(threadId, turnId),
        onProgress: ({ threadId, turnId, lastProgressEventAt }) => {
          this.recordProgress({ threadId, turnId, lastProgressEventAt });
        },
        onClear: ({ threadId, turnId }) => {
          this.clearObservation(threadId, turnId);
        },
      },
    );
  }

  read(
    threadId: string,
  ): (TurnProgressObservation & { turnId: string }) | undefined {
    return this.progressByThread.get(threadId);
  }

  /** Resolve and pin a thread's stall window from its agent's config. */
  async setWindow(threadId: string, agentSlug: unknown): Promise<void> {
    this.windowByThread.set(
      threadId,
      await this.resolveWindowMsForAgent(agentSlug),
    );
  }

  /** The full per-thread teardown: watch, window, and progress marker. */
  forgetThread(threadId: string): void {
    this.watchdog.clear(threadId);
    this.clearObservation(threadId);
    this.windowByThread.delete(threadId);
  }

  dispose(): void {
    this.watchdog.clearAll();
  }

  /**
   * Faithful to the pre-extraction shape: the stored observation carries
   * `threadId` as an excess property (assigned through this typed parameter,
   * so the literal excess-property check does not apply). Session summaries
   * serialize the observation as-is; dropping the field would change payloads.
   */
  private recordProgress(input: {
    threadId: string;
    turnId: string;
    lastProgressEventAt: string;
  }): void {
    this.progressByThread.set(input.threadId, input);
  }

  private async resolveWindowMsForAgent(agentSlug: unknown): Promise<number> {
    if (
      typeof agentSlug !== 'string' ||
      !agentSlug ||
      !this.deps.loadAgentExecutionConfig
    ) {
      return resolveTurnStallWindowMs();
    }
    try {
      const execution = await this.deps.loadAgentExecutionConfig(agentSlug);
      return resolveTurnStallWindowMs(execution);
    } catch {
      return resolveTurnStallWindowMs();
    }
  }

  /**
   * station#2959: fired by the watchdog when a thread's active turn produced
   * no observed progress within its agent's window. Observe-only — see the
   * class docblock; the emitted silence marker is the user-visible signal.
   */
  private handleTurnStall(threadId: string, turnId: string): void {
    const provider = this.deps.providerForThread(threadId);
    if (!provider) return;
    const progress = this.progressByThread.get(threadId);
    if (!progress || progress.turnId !== turnId) return;
    this.publishSilence({
      threadId,
      turnId,
      provider,
      windowMs: this.windowByThread.get(threadId) ?? resolveTurnStallWindowMs(),
      silentSinceEventAt: progress.lastProgressEventAt,
    });
    orchestrationTurnStallDetections.add(1, { provider });
    this.deps.logger.warn('Turn stall detected (observe-only)', {
      provider,
      threadId,
      turnId,
    });
  }

  /** The only producer of the user-visible silence marker (station#4054). */
  private publishSilence(input: {
    threadId: string;
    turnId: string;
    provider: ProviderKind;
    windowMs: number;
    silentSinceEventAt: string;
  }): void {
    const current = this.progressByThread.get(input.threadId);
    if (!current || current.turnId !== input.turnId) return;
    this.progressByThread.set(input.threadId, {
      ...current,
      progressSilence: {
        detectedAt: new Date().toISOString(),
        windowMs: input.windowMs,
        silentSinceEventAt: input.silentSinceEventAt,
        provider: input.provider,
      },
    });
    this.deps.publishProjectionChange(input.threadId);
  }

  /** The only marker-clear path: watchdog progress or watchdog turn clear. */
  private clearObservation(threadId: string, turnId?: string): void {
    const current = this.progressByThread.get(threadId);
    if (!current || (turnId !== undefined && current.turnId !== turnId)) return;
    this.progressByThread.delete(threadId);
    if (current.progressSilence) this.deps.publishProjectionChange(threadId);
  }
}

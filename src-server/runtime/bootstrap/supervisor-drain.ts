/**
 * What a supervised generation does once it starts draining: report its live
 * voice calls, wait for in-progress HTTP requests and (for a supervisor
 * drain) for those calls to end, then run the ordinary graceful shutdown.
 */
import type { LifecycleShutdownReason } from '@kontourai/station-shared/lifecycle-events';
import type { DrainRequest, SupervisorLink } from './supervisor-link.js';

export const VOICE_DRAIN_POLL_MS = 500;

export interface SupervisorDrainDeps {
  link: Pick<SupervisorLink, 'reportDrainProgress' | 'reportDrained'>;
  /** The runtime once constructed; its voice count is 0 until initialized. */
  runtime: () => { activeVoiceSessionCount(): number } | undefined;
  /** The graceful shutdown once boot has installed it. */
  shutdown: () =>
    | ((reason: LifecycleShutdownReason, exitCode?: number) => Promise<void>)
    | undefined;
  exit: (code: number) => void;
  pollMs?: number;
}

export async function runSupervisorDrain(
  request: DrainRequest,
  deps: SupervisorDrainDeps,
): Promise<void> {
  const liveVoiceSessions = () =>
    deps.runtime()?.activeVoiceSessionCount() ?? 0;
  let reported = liveVoiceSessions();
  deps.link.reportDrainProgress(reported);
  await request.connectionsSettled;
  // A live voice call keeps this generation until it ends or the
  // supervisor's cap kills it; the supervisor extends its deadline while the
  // reported count is above zero. After SIGTERM the supervisor is about to
  // kill this process, so it does not wait for calls.
  if (request.source === 'supervisor') {
    for (;;) {
      const live = liveVoiceSessions();
      if (live !== reported) {
        deps.link.reportDrainProgress(live);
        reported = live;
      }
      if (live === 0) break;
      await new Promise((resolve) =>
        setTimeout(resolve, deps.pollMs ?? VOICE_DRAIN_POLL_MS),
      );
    }
  }
  const shutdown = deps.shutdown();
  if (shutdown) {
    await shutdown(
      request.source === 'signal' ? 'SIGTERM' : 'supervisor_drain',
      0,
    );
    return;
  }
  // Drained before boot finished: nothing to shut down gracefully.
  await deps.link.reportDrained();
  deps.exit(0);
}

/**
 * The SIGTERM handler. A supervised generation drains first, like a
 * supervisor drain: it is serving the supervisor's sockets, and shutting down
 * at once would reset its keep-alive clients. A second SIGTERM, one during a
 * drain, or one to an unsupervised process shuts down at once.
 */
export function createSigtermHandler(deps: {
  link: Pick<SupervisorLink, 'draining' | 'beginDrain'> | null;
  shutdown: SupervisorDrainDeps['shutdown'];
  /**
   * How long to drain: the supervisor kills a generation this long after
   * SIGTERM. Callers pass HANDOFF_DEFAULTS.killGraceMs; a supervisor started
   * with another `--kill-grace-ms` does not tell its generations, and a
   * shorter one kills mid-drain, which is no worse than not draining.
   */
  killGraceMs: number;
}): () => void {
  return () => {
    if (deps.link && !deps.link.draining) {
      deps.link.beginDrain(deps.killGraceMs);
      return;
    }
    void deps.shutdown()?.('SIGTERM');
  };
}

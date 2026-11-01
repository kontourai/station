import {
  appendLifecycleEvent,
  type LifecycleIdentity,
  type LifecycleShutdownReason,
  type LifecycleSupervisor,
} from '@kontourai/station-shared/lifecycle-events';
import { SUPERVISOR_ENV } from '@kontourai/station-supervisor/protocol';

/**
 * The supervisor this process runs under, as a generation: the instance's
 * events name it, since the instance record does (see LifecycleSupervisor).
 */
function supervisorOf(env: NodeJS.ProcessEnv): LifecycleSupervisor | null {
  if (env[SUPERVISOR_ENV.ipc] !== '1') return null;
  const pid = Number(env[SUPERVISOR_ENV.pid]);
  const generation = Number(env[SUPERVISOR_ENV.generation]);
  return Number.isInteger(pid) &&
    pid > 0 &&
    Number.isInteger(generation) &&
    generation > 0
    ? { pid, generation }
    : null;
}

type RuntimeProcessLifecycle = {
  identity: LifecycleIdentity | null;
  /**
   * A supervised generation records that it started, so a later generation
   * that dies unobserved is not read as the earlier one's clean handoff
   * drain. The CLI records a direct start itself.
   */
  observeGenerationStart(): void;
  observeShutdown(reason: LifecycleShutdownReason): void;
  observeExit(exitCode: number | null, signal?: string | null): void;
  installExitObserver(target?: Pick<NodeJS.Process, 'once'>): void;
};

export function createRuntimeProcessLifecycle(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeProcessLifecycle {
  const journal = env.STATION_LIFECYCLE_JOURNAL;
  const instanceId = env.STATION_INSTANCE_ID;
  const sha = env.STATION_BUILD_SHA;
  const bootId = env.STATION_BOOT_ID;
  const supervisor = supervisorOf(env);
  const identity =
    journal && instanceId && sha && bootId
      ? {
          instanceId,
          sha,
          bootId,
          pid: process.pid,
          ...(supervisor ? { supervisor } : {}),
        }
      : null;
  const append = (event: Parameters<typeof appendLifecycleEvent>[1]) => {
    if (!journal || !identity) return;
    try {
      appendLifecycleEvent(journal, event);
    } catch (error) {
      console.error(
        '[Station lifecycle] could not persist lifecycle evidence:',
        error,
      );
    }
  };
  let exitWritten = false;
  let observerInstalled = false;
  return {
    identity,
    observeGenerationStart() {
      if (!identity || !supervisor) return;
      append({
        ...identity,
        type: 'started',
        sender: 'unknown',
        timestamp: new Date().toISOString(),
      });
    },
    observeShutdown(reason) {
      if (!identity) return;
      append({
        ...identity,
        type: 'shutdown_observed',
        reason,
        sender: 'unknown',
        timestamp: new Date().toISOString(),
      });
    },
    observeExit(exitCode, signal = null) {
      if (!identity || exitWritten) return;
      exitWritten = true;
      append({
        ...identity,
        type: 'process_exit',
        exitCode,
        signal,
        sender: 'unknown',
        timestamp: new Date().toISOString(),
      });
    },
    installExitObserver(target = process) {
      if (observerInstalled) return;
      observerInstalled = true;
      target.once('exit', (code) => {
        this.observeExit(code, null);
      });
    },
  };
}

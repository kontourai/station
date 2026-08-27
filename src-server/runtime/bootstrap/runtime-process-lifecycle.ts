import {
  appendLifecycleEvent,
  type LifecycleIdentity,
} from '@kontourai/station-shared/lifecycle-events';

export type RuntimeProcessLifecycle = {
  identity: LifecycleIdentity | null;
  observeShutdown(
    reason: 'SIGINT' | 'SIGTERM' | 'uncaughtException' | 'startup_failure',
  ): void;
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
  const identity =
    journal && instanceId && sha && bootId
      ? { instanceId, sha, bootId, pid: process.pid }
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

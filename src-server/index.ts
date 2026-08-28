import { assertSupportedNodeVersion } from '@kontourai/station-shared/node-runtime';
import { sweepStationTempRoot } from '@kontourai/station-shared/temp-dir';
import 'dotenv/config';
import './telemetry.js';

/**
 * Station — local-first AI agent system
 * Main entry point
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureStationHomeSchemaSync } from './domain/home-schema-gate.js';
import { writeBootRecord } from './routes/system/boot-history.js';
import { captureBuildProvenance } from './routes/system/build-provenance.js';
import { reportSelfUpdateRestartAtBoot } from './routes/system/self-update-boot-report.js';
import { allocateFreePortBlock } from './runtime/bootstrap/allocate-port-block.js';
import {
  installCrashHandlers,
  logFatalAndFlush,
} from './runtime/bootstrap/crash-handlers.js';
import {
  installStdoutEpipeGuard,
  writeReadinessHandshake,
} from './runtime/bootstrap/readiness-handshake.js';
import {
  AUTO_ALLOCATE_PORT,
  resolveRuntimePort,
} from './runtime/bootstrap/runtime-port.js';
import { createRuntimeProcessLifecycle } from './runtime/bootstrap/runtime-process-lifecycle.js';
import { StationRuntime } from './runtime/bootstrap/station-runtime.js';
import { armSupervisedParentWatchdog } from './runtime/bootstrap/supervised-parent-watchdog.js';
import { sweepOrphanedOwnedProcesses } from './services/infra/process-utils.js';
import {
  getInstalledServerLogSink,
  installServerLogSink,
} from './services/infra/server-log-store.js';
import { lifecycleService } from './telemetry/metrics.js';
import { createLogger, resolveLogLevel } from './utils/logger.js';
import { resolveHomeDir } from './utils/paths.js';

assertSupportedNodeVersion();

// Capture process identity before normal boot can mutate its environment or
// baked banner state. Crash records and diagnostics bundles share this value.
const buildProvenanceSnapshot = captureBuildProvenance();
process.env.STATION_PROCESS_STARTED_AT ??= String(Date.now());

/** Best-effort synchronous drain of the durable log sink — installed once
 * per process, so this reads whatever `installServerLogSink` most recently
 * installed rather than closing over a fixed reference. */
function flushLogSink(): void {
  try {
    getInstalledServerLogSink()?.flushSync();
  } catch {
    // best-effort; the crash path must never throw
  }
}

async function main() {
  if (process.env.STATION_SERVICE_MANAGED === '1') {
    lifecycleService.add(1, { action: 'boot', platform: process.platform });
  }
  const processLifecycle = createRuntimeProcessLifecycle();
  processLifecycle.installExitObserver();
  // A killed or crashed process never runs its own temp cleanup, so reclaim
  // anything older than a day before doing anything else. Best-effort: a
  // failure here must never block boot.
  void sweepStationTempRoot().catch(() => {});
  // archive#1863: an engine child spawned with `detached: true` outlives a
  // SIGKILLed/crashed Station, and none of that Station's in-process cleanup
  // ever runs. Reap orphaned engine processes a PREVIOUS Station on this host
  // recorded but never cleaned up. The sweep is provably scoped — it only
  // reaps children whose recorded owner pid is demonstrably gone — so it
  // cannot touch a live sibling Station's engines. Best-effort, like the temp
  // sweep: a failure here must never block boot.
  void sweepOrphanedOwnedProcesses({
    log: (message, data) => console.log(`[station] ${message}`, data ?? ''),
  }).catch(() => {});
  let port = resolveRuntimePort(
    process.env.PORT,
    process.env.STATION_PORT_MODE,
  );
  const projectHomeDir = resolveHomeDir();

  // The schema gate must own the first write to a Station home. In
  // particular, installing the durable log sink first creates logs/server in
  // an otherwise fresh home and makes that home look like incompatible
  // marker-less application data.
  ensureStationHomeSchemaSync(projectHomeDir);

  // Root logger + durable NDJSON sink, wired as early as possible — before
  // the runtime (and every module-scope logger it transitively imports)
  // does any real work, so boot itself is captured in the store.
  const serverLogSink = installServerLogSink({
    directory: join(projectHomeDir, 'logs', 'server'),
  });
  writeBootRecord(
    serverLogSink.writeLine.bind(serverLogSink),
    buildProvenanceSnapshot,
  );
  const logger = createLogger({
    name: 'station',
    level: resolveLogLevel(),
  });

  const configuredHost = process.env.STATION_HOST || undefined;
  const host = configuredHost || '0.0.0.0';
  const displayHost = host.includes(':') ? `[${host}]` : host;

  // PORT=0 / STATION_PORT_MODE=auto: reserve a contiguous free block for the
  // HTTP, terminal (port+1), voice (port+2), and consent (port+3) listeners
  // before the runtime binds them, then report the resolved base back to a
  // supervising parent.
  if (port === AUTO_ALLOCATE_PORT) {
    port = await allocateFreePortBlock(host);
  }

  const runtime = new StationRuntime({
    projectHomeDir,
    port,
    host: configuredHost,
    logger,
    buildProvenanceSnapshot,
  });

  let stdoutBrokenPipe = false;
  let gracefulShutdown:
    | ((signal: string, forcedExitCode?: number) => Promise<void>)
    | undefined;
  // Install before runtime initialization: boot logs are still stdout writes,
  // and Desktop can disappear while initialization is in flight.
  installStdoutEpipeGuard(process.stdout, () => {
    stdoutBrokenPipe = true;
    // No logging in this callback: EPIPE means stdout is gone, and a log
    // write here would recurse through the same error handler.
    void gracefulShutdown?.('stdout_epipe', 1);
  });
  try {
    await runtime.initialize();
    let shuttingDown = false;

    // Emit a single structured readiness line for a supervising parent process
    // (the desktop spawner) once every listener is bound. No-op unless the
    // supervisor opted in with STATION_STDOUT_HANDSHAKE=1.
    if (
      !writeReadinessHandshake(
        process.stdout,
        port,
        host,
        process.env.STATION_STDOUT_HANDSHAKE === '1',
      )
    ) {
      stdoutBrokenPipe = true;
    }

    // The read side of archive#1903: a self-update that never confirmed the
    // new server was healthy used to leave no trace at all past a log line
    // from a process that had already exited. A no-op for anything other
    // than a source-checkout install with a failed or stale-pending record.
    reportSelfUpdateRestartAtBoot(dirname(fileURLToPath(import.meta.url)));

    console.log('\\n═══════════════════════════════════════════════════');
    console.log('  STATION STARTED');
    console.log('═══════════════════════════════════════════════════');
    console.log(`  ✓ HTTP Server:  http://${displayHost}:${port}`);
    console.log(`  ✓ Swagger UI:   http://${displayHost}:${port}/ui`);
    console.log('');
    const loadedAgents = runtime.listAgents();
    console.log('  Loaded agents:', loadedAgents.join(', '));
    console.log('═══════════════════════════════════════════════════\\n');
    logger.info('Station started', { port, host, agents: loadedAgents });

    gracefulShutdown = async (signal: string, forcedExitCode?: number) => {
      if (shuttingDown) return;
      shuttingDown = true;
      processLifecycle.observeShutdown(
        signal as 'SIGINT' | 'SIGTERM' | 'uncaughtException',
      );
      console.log(`\n\nShutting down gracefully (${signal})...`);
      logger.info('Station shutting down', { signal });
      let exitCode = forcedExitCode ?? (signal === 'uncaughtException' ? 1 : 0);
      try {
        await runtime.shutdown();
        logger.info('Station shutdown complete', { signal, exitCode });
      } catch (error) {
        exitCode = 1;
        console.error('Shutdown completed with cleanup errors:', error);
        logger.error('Shutdown completed with cleanup errors', {
          signal,
          err: error,
        });
      }
      processLifecycle.observeExit(exitCode);
      process.exit(exitCode);
    };

    // A supervisor can disappear in the narrow interval before the shutdown
    // closure exists. The guard remembered it; now converge through the same
    // one-shot shutdown path rather than continuing as an orphan.
    if (stdoutBrokenPipe) void gracefulShutdown('stdout_epipe', 1);

    process.on('SIGINT', () => void gracefulShutdown?.('SIGINT'));
    process.on('SIGTERM', () => void gracefulShutdown?.('SIGTERM'));
    armSupervisedParentWatchdog({
      logger,
      onSupervisorGone: () => gracefulShutdown?.('SIGTERM', 1),
    });
    installCrashHandlers(logger, {
      flushSync: flushLogSink,
      buildProvenanceSnapshot,
      onUncaughtException: () => {
        void gracefulShutdown?.('uncaughtException');
      },
    });
  } catch (error) {
    processLifecycle.observeShutdown('startup_failure');
    processLifecycle.observeExit(1);
    console.error('Failed to start Station:', error);
    logFatalAndFlush(
      logger,
      'Failed to start Station',
      { err: error },
      flushLogSink,
      buildProvenanceSnapshot,
    );
    process.exit(1);
  }
}

main();
